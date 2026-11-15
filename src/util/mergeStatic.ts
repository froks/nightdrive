import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Merge the static meshes under `root` that share a material into one mesh each
 * (transforms baked in, relative to `root`), to cut draw calls: each draw has a
 * fixed CPU cost in three.js, and in Firefox every WebGL call also crosses
 * processes.
 *
 * Left alone: anything under `keep` (animated or clickable), transparent or
 * multi-material meshes, materials flagged `userData.dynamic`, objects with a
 * non-zero renderOrder, and invisible ones. Call once the subtree is built and
 * before it is first rendered.
 * Returns the number of meshes merged away.
 */
export function mergeStatic(root: THREE.Object3D, keep: Iterable<THREE.Object3D>): number {
  const kept = new Set(keep);
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const groups = new Map<string, { material: THREE.Material; meshes: THREE.Mesh[] }>();

  const visit = (o: THREE.Object3D) => {
    if (kept.has(o) || !o.visible) return; // whole subtree stays as it is
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m as unknown as THREE.InstancedMesh).isInstancedMesh && m.renderOrder === 0 && m.children.length === 0) {
      const mat = m.material;
      // (geometry groups don't matter with a single material: three draws the whole range)
      if (!Array.isArray(mat) && !mat.transparent && !mat.userData.dynamic) {
        const g = m.geometry;
        const key = `${mat.uuid}|${Object.keys(g.attributes).sort().join(',')}`;
        let e = groups.get(key);
        if (!e) groups.set(key, e = { material: mat, meshes: [] });
        e.meshes.push(m);
      }
    }
    for (const c of [...o.children]) visit(c);
  };
  for (const c of [...root.children]) visit(c);

  let merged = 0;
  const m4 = new THREE.Matrix4();
  for (const { material, meshes } of groups.values()) {
    if (meshes.length < 2) continue;
    const geos = meshes.map(mesh => {
      // non-indexed, so indexed (boxes) and non-indexed (extrusions) geometry merge together
      const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      g.clearGroups();
      return g.applyMatrix4(m4.multiplyMatrices(toRoot, mesh.matrixWorld));
    });
    const geo = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    if (!geo) continue; // incompatible attributes: leave the originals
    const out = new THREE.Mesh(geo, material);
    out.name = 'merged';
    root.add(out);
    // (the originals' geometries were never uploaded if this runs before the first render;
    // they may be shared with kept meshes, so they aren't disposed here)
    for (const mesh of meshes) mesh.removeFromParent();
    merged += meshes.length - 1;
  }
  return merged;
}

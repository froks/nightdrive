import * as THREE from 'three';
import type { ScenePreset } from '../scenes/types';
import { TAU } from '../util/math';

/** Distant silhouette ranges: rings around the camera, fixed in world orientation. */
export class Mountains {
  readonly group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];

  constructor(preset: ScenePreset) { this.setPreset(preset); }

  setPreset(p: ScenePreset) {
    for (const m of this.meshes) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); this.group.remove(m); }
    const fog = new THREE.Color(p.fog.color);
    const far = ring(3600, 720, a =>
      0.05 + 0.032 * Math.sin(a * 3 + 1) + 0.022 * Math.sin(a * 7 + 2) + 0.011 * Math.sin(a * 17 + 0.5) +
      0.005 * Math.sin(a * 41 + 1.3) + 0.0025 * Math.sin(a * 97) + 0.0012 * Math.sin(a * 211 + 2),
      new THREE.Color(p.mountains.farTop), new THREE.Color(p.mountains.far).lerp(fog, 0.5));
    const near = ring(2600, 900, a =>
      0.018 + 0.014 * Math.sin(a * 5 + 3) + 0.009 * Math.sin(a * 11 + 1) +
      0.004 * Math.abs(Math.sin(a * 73)) + 0.003 * Math.abs(Math.sin(a * 151 + 1)) + 0.0015 * Math.abs(Math.sin(a * 397)),
      new THREE.Color(p.mountains.near), new THREE.Color(p.mountains.near).lerp(fog, 0.4));
    far.renderOrder = -8; near.renderOrder = -7;
    this.meshes = [far, near];
    this.group.add(far, near);
  }

  update(camPos: THREE.Vector3, groundY: number) {
    this.group.position.set(camPos.x, groundY - 25, camPos.z);
  }
}

function ring(r: number, segs: number, h: (a: number) => number, top: THREE.Color, bottom: THREE.Color) {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * TAU;
    const x = Math.sin(a) * r, z = -Math.cos(a) * r;
    pos.push(x, h(a) * r, z, x, -300, z);
    col.push(top.r, top.g, top.b, bottom.r, bottom.g, bottom.b);
    if (i < segs) { const k = i * 2; idx.push(k, k + 1, k + 3, k, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, depthWrite: false }));
  m.frustumCulled = false;
  return m;
}

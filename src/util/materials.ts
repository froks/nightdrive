import * as THREE from 'three';
import { glowTexture } from './textures';

/**
 * Fog for additive/emissive things: instead of mixing towards the fog colour
 * (which would *add* haze colour for additive blending), fade them out.
 * `keep` = fraction of the fog effect applied (0 = no fog, 1 = full).
 */
function fadeFog(mat: THREE.Material, keep: number, mode: 'fade' | 'mix') {
  mat.onBeforeCompile = shader => {
    const repl = mode === 'fade'
      ? `gl_FragColor.rgb *= ( 1.0 - fogFactor * ${keep.toFixed(3)} );`
      : `gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor * ${keep.toFixed(3)} );`;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      THREE.ShaderChunk.fog_fragment.replace('gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );', repl),
    );
  };
  mat.customProgramCacheKey = () => `fog-${mode}-${keep}`;
}

/** Opaque HDR emissive (neon lines, lamp heads). Colours come from vertex colours. */
export function neonMaterial() {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  fadeFog(m, 0.6, 'mix');
  return m;
}

/** Additive glow geometry (light cones, wet reflections). */
export function additiveMaterial() {
  const m = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  fadeFog(m, 1.0, 'fade');
  return m;
}

export function glowSpriteMaterial(color: THREE.ColorRepresentation, intensity = 1) {
  const m = new THREE.SpriteMaterial({
    map: glowTexture(), color: new THREE.Color(color).multiplyScalar(intensity),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  fadeFog(m, 0.85, 'fade');
  return m;
}

/** Set a constant colour attribute on a geometry (for merging into vertex-coloured meshes). */
export function colorize(geo: THREE.BufferGeometry, rgb: [number, number, number], fn?: (x: number, y: number, z: number) => number) {
  const pos = geo.getAttribute('position');
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = fn ? fn(pos.getX(i), pos.getY(i), pos.getZ(i)) : 1;
    arr[i * 3] = rgb[0] * k; arr[i * 3 + 1] = rgb[1] * k; arr[i * 3 + 2] = rgb[2] * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Keep only position (+color) so heterogeneous geometries can be merged. */
export function stripAttrs(geo: THREE.BufferGeometry, keep = ['position', 'color']) {
  for (const name of Object.keys(geo.attributes)) if (!keep.includes(name)) geo.deleteAttribute(name);
  return geo;
}

/**
 * Distance-stable glow points (street lamps etc.).
 * Each point is `uSize` metres wide but never smaller than `uMinPx` pixels;
 * when clamped, intensity is scaled down by the area ratio so total light stays
 * constant -> no sub-pixel popping/flicker in the distance.
 * Call `setGlowViewport()` on resize.
 */
const glowPointMats = new Set<THREE.ShaderMaterial>();
let glowScale = 1000;
export function setGlowViewport(bufferHeight: number, fovDeg: number) {
  glowScale = bufferHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  for (const m of glowPointMats) m.uniforms.uScale.value = glowScale;
}
/** Pixels per metre at distance 1 (for size-attenuated point sprites). */
export const getGlowScale = () => glowScale;
export function glowPointsMaterial(color: THREE.ColorRepresentation, intensity: number, sizeMeters: number, minPx = 3.5) {
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        map: { value: glowTexture() },
        uColor: { value: new THREE.Color(color).multiplyScalar(intensity) },
        uSize: { value: sizeMeters },
        uScale: { value: glowScale },
        uMinPx: { value: minPx },
      },
    ]),
    fog: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      uniform float uSize, uScale, uMinPx;
      varying float vAtten;
      varying float vDepth;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float px = uSize * uScale / max(0.1, -mv.z);
        float s = max(px, uMinPx);
        vAtten = (px / s) * (px / s);
        vDepth = -mv.z;
        gl_PointSize = s;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform sampler2D map;
      uniform vec3 uColor;
      uniform vec3 fogColor;
      uniform float fogDensity;
      varying float vAtten;
      varying float vDepth;
      void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        float fog = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
        gl_FragColor = vec4(uColor * t.rgb * t.a * vAtten * (1.0 - 0.85 * fog), 1.0);
      }`,
  });
  glowPointMats.add(m);
  const dispose = m.dispose.bind(m);
  m.dispose = () => { glowPointMats.delete(m); dispose(); };
  return m;
}

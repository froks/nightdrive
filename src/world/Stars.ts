import * as THREE from 'three';
import { TAU, hash2 } from '../util/math';

/**
 * Star field as a pre-baked point cloud (replaces the per-pixel star search in
 * the sky dome shader, which ran 81 cell lookups on every pixel of the screen).
 *
 * Same model as that shader, statistically: each layer scatters stars at
 * `density` per unit cell in 3D around a sphere of radius `scale` (cells), and
 * a star's light is a gaussian in its 3D distance to the view ray, measured in
 * "pixel units" (0.85 px). That distance splits into the star's offset from the
 * sphere (baked here, sets its peak brightness, resolution-dependent like
 * before) and its on-screen distance (evaluated per fragment of a small point
 * sprite). Stars are at least ~1 px wide and positioned with sub-pixel
 * precision, so they glide across the pixel grid instead of popping.
 */
const LAYERS = [
  { scale: 150, density: 0.10, gain: 1.0 },
  { scale: 320, density: 0.03, gain: 0.8 },
  { scale: 640, density: 0.012, gain: 0.6 },
];
/** shader "pixel unit" in screen pixels */
const PX = 0.85;
/**
 * Off-sphere reach in pixel units: beyond it even the halo of the biggest
 * stars (r = 1.4) stays below ~1e-3 of full brightness.
 */
const REACH = 4.6;
/**
 * Coarsest pixel (radians) the candidate set is generated for (a ~600 px tall
 * drawing buffer). Candidates come from a counter-based hash, so a rebake for a
 * different resolution keeps the same stars, it only takes more or fewer of the
 * faint ones.
 */
const PIX_MAX = 0.0016;
/** stars whose peak brightness stays below this are skipped (vertex shader, and at bake time) */
const CULL = 2e-4;

export class Stars {
  readonly points: THREE.Points;
  private bakedPix = 0;

  constructor(radius: number, uniforms: {
    uTime: { value: number }; uDim: { value: number }; uStarBright: { value: number }; uPixAng: { value: number };
  }) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uRadius: { value: radius } },
      // stays in the opaque list (drawn before the mountain rings, which cover it) but adds up
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */`
        uniform float uTime, uDim, uStarBright, uPixAng;
        attribute vec4 aStar; // x: offset from the sphere / scale, y, z: random, w: layer gain
        varying vec3 vCore, vHalo;
        varying float vR, vSize;
        void main() {
          float big = pow(aStar.y, 8.0);
          float r = 0.8 + 0.6 * big;
          float o = aStar.x / (uPixAng * ${PX.toFixed(2)}) / r;
          float qd = o * o;
          float core = exp(-qd) * 0.6;
          float halo = exp(-qd * 0.35) * big * 0.08;
          float e = normalize((modelMatrix * vec4(position, 0.0)).xyz).y;
          // gentle, slow twinkle (off in DIM mode)
          float tw = 1.0 - (0.12 * (1.0 - uDim)) * (0.5 + 0.5 * sin(uTime * (0.3 + aStar.z * 1.1) + aStar.y * 40.0));
          float k = (0.25 + 0.75 * aStar.y) * aStar.w * tw * smoothstep(-0.01, 0.12, e) * uStarBright * (1.0 - 0.75 * uDim);
          if ((core + halo) * k < ${CULL.toExponential()}) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
          vec3 tint = mix(vec3(1.0, 0.82, 0.68), vec3(0.72, 0.82, 1.0), aStar.z);
          vCore = tint * core * k;
          vHalo = tint * halo * k;
          vR = r * ${PX.toFixed(2)};
          // sprite radius: where the core (or a visible halo) has faded to ~0.3%
          float rad = vR * (halo > 0.1 * core ? 4.2 : 2.5);
          vSize = 2.0 * rad + 1.0;
          gl_PointSize = vSize;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vCore, vHalo;
        varying float vR, vSize;
        void main() {
          vec2 d = (gl_PointCoord - 0.5) * vSize / vR;
          float q = dot(d, d);
          gl_FragColor = vec4(vCore * exp(-q) + vHalo * exp(-q * 0.35), 1.0);
        }`,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = -9.5; // after the dome, before the galaxy and mountains
  }

  /** Make sure the faint stars visible at this pixel size (radians) are in the buffer. */
  update(pixAng: number) {
    if (pixAng <= this.bakedPix || this.bakedPix >= PIX_MAX) return;
    // headroom, so small resizes don't rebake
    this.bake(Math.min(PIX_MAX, pixAng * 1.25));
  }

  private bake(pix: number) {
    this.bakedPix = pix;
    const t0 = performance.now();
    const R = (this.points.material as THREE.ShaderMaterial).uniforms.uRadius.value as number;
    const pos: number[] = [], star: number[] = [];
    LAYERS.forEach(({ scale, density, gain }, li) => {
      // offsets from the sphere in cells: candidates span the reach at PIX_MAX, kept within the reach at `pix`
      const tMax = REACH * scale * PIX_MAX * PX, t = REACH * scale * pix * PX;
      const n = Math.round(4 * Math.PI * scale * scale * density * 2 * tMax);
      const k = li * 8;
      const pxu = scale * pix * PX; // one pixel unit in cells
      for (let i = 0; i < n; i++) {
        const off = (2 * hash2(i, k) - 1) * tMax;
        if (Math.abs(off) > t) continue;
        // drop stars too far off the sphere to ever pass the vertex shader's cull (same formula)
        const hy = hash2(i, k + 3), big = hy ** 8, r = 0.8 + 0.6 * big;
        const qd = (off / pxu / r) ** 2;
        if ((Math.exp(-qd) * 0.6 + Math.exp(-qd * 0.35) * big * 0.08) * (0.25 + 0.75 * hy) * gain < CULL) continue;
        const z = 2 * hash2(i, k + 1) - 1, ph = TAU * hash2(i, k + 2), s = Math.sqrt(1 - z * z);
        pos.push(Math.cos(ph) * s * R, z * R, Math.sin(ph) * s * R);
        star.push(off / scale, hy, hash2(i, k + 4), gain);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aStar', new THREE.Float32BufferAttribute(star, 4));
    this.points.geometry.dispose();
    this.points.geometry = g;
    if (import.meta.env.DEV) console.debug(`stars: baked ${pos.length / 3} points for ${(pix * 1e3).toFixed(2)} mrad pixels in ${(performance.now() - t0).toFixed(1)} ms`);
  }
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DS, Track } from './Track';
import type { HDR, ScenePreset } from '../scenes/types';
import { additiveMaterial, colorize, getGlowScale, glowPointsMaterial, stripAttrs, trackGlowScale } from '../util/materials';
import { fbm, ridged, smoothstep } from '../util/math';

export const CHUNK_LEN = 60;
export const VIEW_DIST = 1100;

export const ROAD = {
  EDGE: 7,
  SHOULDER: 9.4,
  W: 10.4,
  POLE_L: 11.4,
  HEAD_L: 8.4,
  REFLECTOR_L: 10.3,
};

/* ------------------------------------------------------------------ */
/* Small indexed geometry builder                                      */
/* ------------------------------------------------------------------ */
class Builder {
  pos: number[] = [];
  col: number[] = [];
  ext: number[] = [];
  lod: number[] = [];
  idx: number[] = [];
  v(p: THREE.Vector3, c?: HDR, e?: [number, number], lod?: [number, number, number, number]) {
    this.pos.push(p.x, p.y, p.z);
    if (c) this.col.push(c[0], c[1], c[2]);
    if (e) this.ext.push(e[0], e[1]);
    if (lod) this.lod.push(lod[0], lod[1], lod[2], lod[3]);
    return this.pos.length / 3 - 1;
  }
  /** a,b,c,d counter-clockwise when seen from above (L increasing to the right, s forward). */
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, a, c, d);
  }
  geometry(extName?: string) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    if (this.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (extName && this.ext.length) g.setAttribute(extName, new THREE.Float32BufferAttribute(this.ext, 2));
    if (this.lod.length) g.setAttribute('aLod', new THREE.Float32BufferAttribute(this.lod, 4));
    g.setIndex(this.idx);
    return g;
  }
  get empty() { return this.idx.length === 0; }
}

/* ------------------------------------------------------------------ */
/* Road surface shader: dark wet asphalt with street-lamp light pools   */
/* ------------------------------------------------------------------ */
/**
 * Lamp heads: HDR vertex colours like the neon material, plus a brightness
 * level and a distance fade. Far away the 16 cm tall heads shrink to ~1 px and
 * shimmer between frames (bloom amplifies it), so they fade out from 60 to
 * 110 m and the size-stable glow points carry the light from there.
 */
function lampHeadMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uLevel: { value: 1 } }]),
    fog: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute vec3 color;
      varying vec3 vColor;
      varying float vDepth;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 fogColor;
      uniform float fogDensity, uLevel;
      varying vec3 vColor;
      varying float vDepth;
      void main() {
        vec3 c = vColor * uLevel * (1.0 - smoothstep(60.0, 110.0, vDepth));
        float fog = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
        gl_FragColor = vec4(mix(c, fogColor, fog * 0.6), 1.0);
      }`,
  });
}

/** `aLod.w` kinds for markingMaterial */
const LOD_LINE = 0, LOD_DASH = 1, LOD_DASH_AVG = 2, LOD_SMALL = 3;

/**
 * Road markings and reflector cubes (HDR vertex colours). Far away these thin
 * strips get narrower than a pixel and shimmer while driving (bloom amplifies
 * it), so per vertex (`aLod`: xyz = offset from the line's centre, w = kind):
 *  - lines are widened to at least ~1.5 px on screen and dimmed by the same
 *    factor (same total light, no popping); drawn additively so the wider,
 *    dimmer strip doesn't cover the road;
 *  - dashes and hatch rungs fade out once their 12 m period gets only a few
 *    pixels tall on screen, while a dim continuous line (brightness x duty
 *    cycle) fades in - what the dashes average out to;
 *  - small lights (reflector cubes) fade out from 60 to 110 m.
 */
function markingMaterial() {
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: getGlowScale() } }]),
    fog: true,
    side: THREE.DoubleSide,
    // additive (they're emissive): a widened, dimmed line must not paint over the road under it
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec3 color;
      attribute vec4 aLod;
      uniform float uScale; // pixels per metre at 1 m distance (= half viewport height / tan(fov/2))
      varying vec3 vColor;
      varying float vDepth, vFade;
      void main() {
        // on-screen half width in pixels (foreshortening included: far away, where the road
        // curves, a line runs across the view and its width is squashed to nothing)
        vec4 ce = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec4 cc = projectionMatrix * modelViewMatrix * vec4(position - aLod.xyz, 1.0);
        vec2 px = (ce.xy / max(ce.w, 0.01) - cc.xy / max(cc.w, 0.01)) * uScale / vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
        float k = dot(aLod.xyz, aLod.xyz) > 0.0 ? clamp(0.75 / max(length(px), 1e-4), 1.0, 24.0) : 1.0;
        vec3 p = position + aLod.xyz * (k - 1.0);
        float z = max(0.1, ce.w);
        // distance at which the 12 m dash period is ~3 px tall (eye ~1.2 m above the road)
        float zd = sqrt(uScale * 4.8);
        float far = smoothstep(0.8 * zd, 1.3 * zd, z);
        float kind = aLod.w;
        float fade = kind < 0.5 ? 1.0 : kind < 1.5 ? 1.0 - far : kind < 2.5 ? far : 1.0 - smoothstep(60.0, 110.0, z);
        vFade = fade;
        vColor = color * fade / k;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float fogDensity;
      varying vec3 vColor;
      varying float vDepth, vFade;
      void main() {
        if (vFade < 0.004) discard;
        float fog = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
        gl_FragColor = vec4(vColor * (1.0 - 0.75 * fog), 1.0);
      }`,
  });
  return trackGlowScale(m);
}

/**
 * Wet-road reflections of the street lamps (additive). Far away the streak is
 * only a pixel or two tall at this grazing angle and flickers, so it fades out
 * from 70 to 130 m (the lamp's light pool in the road shader stays).
 */
function reflectionMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uLevel: { value: 1 } }]),
    fog: true,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute vec3 color;
      varying vec3 vColor;
      varying float vDepth;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float fogDensity, uLevel;
      varying vec3 vColor;
      varying float vDepth;
      void main() {
        float fog = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
        gl_FragColor = vec4(vColor * uLevel * (1.0 - smoothstep(70.0, 130.0, vDepth)) * (1.0 - fog), 1.0);
      }`,
  });
}

/**
 * Terrain fades out with distance (650-900 m), so chunks built at the far end
 * of the view (~1100 m down the road, closer when it curves) don't pop up as
 * hard silhouettes against the sky; it fades in as you approach.
 * Drawn in the transparent pass (after the sky and mountain rings), still
 * writing depth, so near terrain behaves like opaque geometry.
 */
function terrainMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true });
  m.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying float vTerrainDist;\nvoid main() {')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vTerrainDist = length(mvPosition.xyz);');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'varying float vTerrainDist;\nvoid main() {')
      .replace('#include <fog_fragment>', '#include <fog_fragment>\n  gl_FragColor.a *= 1.0 - smoothstep(650.0, 900.0, vTerrainDist);');
  };
  m.customProgramCacheKey = () => 'terrain-fade';
  return m;
}

function roadMaterial(p: ScenePreset) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uAsphalt: { value: new THREE.Vector3(...p.road.asphalt) },
        uPool: { value: new THREE.Vector3(...p.road.pool) },
        uSpacing: { value: p.lamps.spacing },
        uHeadL: { value: ROAD.HEAD_L },
        uLamps: { value: p.lamps.enabled ? 1 : 0 },
      },
    ]),
    fog: true,
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
    vertexShader: /* glsl */`
      attribute vec2 aRoad;
      varying vec2 vRoad;
      #include <fog_pars_vertex>
      void main() {
        vRoad = aRoad;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uAsphalt, uPool;
      uniform float uSpacing, uHeadL, uLamps;
      varying vec2 vRoad;
      #include <fog_pars_fragment>
      float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        float L = vRoad.x, s = vRoad.y;
        // lamp light pools along the road (gaussian, sigma^2 = 55 m^2), pre-filtered over the
        // pixel footprint: far away one pixel spans more road than a pool, and point-sampling
        // made the distant road blink as pixels hit or missed the pools while driving.
        // Widen each gaussian by the footprint (same total light) and sum the neighbours.
        float ph = mod(s, uSpacing);
        float fs = min(fwidth(s), 2.0 * uSpacing);
        float v = 55.0 + fs * fs / 12.0;
        float along = 0.0;
        for (int i = -2; i <= 2; i++) {
          float d = ph - float(i) * uSpacing;
          along += exp(-d * d / (2.0 * v));
        }
        along *= sqrt(55.0 / v);
        float lat = exp(-pow(L - uHeadL, 2.0) / 28.0) + exp(-pow(L + uHeadL, 2.0) / 28.0);
        float pool = along * (0.3 + lat) * uLamps;
        vec2 gp = vec2(L * 14.0, s * 14.0);
        float grain = h21(floor(gp));
        // the grain / sparkle cells are ~7 cm: fade them out once a cell gets smaller than
        // a pixel, otherwise the distant road shimmers while driving (bloom amplifies it)
        vec2 fw = fwidth(gp);
        float detail = 1.0 - smoothstep(0.25, 0.7, max(fw.x, fw.y));
        vec3 col = uAsphalt * (0.8 + 0.4 * mix(0.5, grain, detail)) + uPool * pool;
        col += uPool * 2.0 * step(0.993, grain) * (0.3 + along) * detail;      // wet sparkle
        col *= mix(1.0, 0.65, smoothstep(7.2, 7.6, abs(L)));           // rougher shoulder
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });
}

const named = <T extends THREE.Object3D>(o: T, name: string) => { o.name = name; return o; };

/* ------------------------------------------------------------------ */
interface Chunk {
  index: number;
  anchor: THREE.Vector3;
  group: THREE.Group;
  terrain: THREE.Mesh;
}

export class ChunkManager {
  readonly root = new THREE.Group();
  /** debug: chunk parts to hide by name (road, markings, heads, lampglow, poles, cones, reflections, terrain) */
  readonly hidden = new Set<string>();
  private chunks = new Map<number, Chunk>();
  private mats!: {
    road: THREE.ShaderMaterial;
    terrain: THREE.MeshLambertMaterial;
    dark: THREE.MeshLambertMaterial;
    /** road markings + reflector cubes */
    marking: THREE.ShaderMaterial;
    /** lamp heads (own material so street lights can be dimmed without the road lines) */
    lampHead: THREE.ShaderMaterial;
    /** lamp light cones */
    add: THREE.MeshBasicMaterial;
    /** wet-road reflections of the lamps */
    refl: THREE.ShaderMaterial;
    glow: THREE.ShaderMaterial;
  };
  private p!: ScenePreset;
  private lampLevel = 1;
  private lampBase = new THREE.Color();

  constructor(private track: Track, preset: ScenePreset) {
    this.setPreset(preset);
  }

  setPreset(p: ScenePreset) {
    this.p = p;
    for (const c of this.chunks.values()) this.dispose(c);
    this.chunks.clear();
    if (this.mats) Object.values(this.mats).forEach(m => m.dispose());
    this.mats = {
      road: roadMaterial(p),
      terrain: terrainMaterial(),
      dark: new THREE.MeshLambertMaterial({ color: 0x07080d }),
      marking: markingMaterial(),
      lampHead: lampHeadMaterial(),
      add: additiveMaterial(),
      refl: reflectionMaterial(),
      glow: glowPointsMaterial(p.lamps.glow, 1.6, 5),
    };
    this.lampBase = this.mats.glow.uniforms.uColor.value.clone();
    this.setLampLevel(this.lampLevel);
  }

  /** Street light brightness multiplier (heads, glows, cones, reflections, pools on the road). */
  setLampLevel(k: number) {
    this.lampLevel = k;
    const m = this.mats;
    m.lampHead.uniforms.uLevel.value = k;
    m.add.color.setScalar(k);
    m.refl.uniforms.uLevel.value = k;
    m.glow.uniforms.uColor.value.copy(this.lampBase).multiplyScalar(k);
    m.road.uniforms.uLamps.value = (this.p.lamps.enabled ? 1 : 0) * k;
  }

  update(pos: number, origin: THREE.Vector3) {
    const first = Math.floor((pos - 40) / CHUNK_LEN);
    const last = Math.floor((pos + VIEW_DIST) / CHUNK_LEN);
    for (const [i, c] of this.chunks) {
      if (i < first || i > last) { this.dispose(c); this.chunks.delete(i); }
    }
    // build at most 2 new chunks per frame to avoid hitches
    let built = 0;
    for (let i = first; i <= last && built < 2; i++) {
      if (!this.chunks.has(i)) { this.chunks.set(i, this.build(i)); built++; }
    }
    for (const c of this.chunks.values()) c.group.position.subVectors(c.anchor, origin);
  }

  /** Distance to the first terrain hit along a render-space ray (Infinity if none). */
  terrainHit(raycaster: THREE.Raycaster): number {
    let best = Infinity;
    for (const c of this.chunks.values()) {
      c.terrain.updateWorldMatrix(true, false); // chunks built this frame haven't been rendered yet
      const hit = raycaster.intersectObject(c.terrain, false)[0];
      if (hit && hit.distance < best) best = hit.distance;
    }
    return best;
  }

  private dispose(c: Chunk) {
    c.group.traverse(o => { if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) (o as THREE.Mesh).geometry.dispose(); });
    this.root.remove(c.group);
  }

  private build(index: number): Chunk {
    const { track, p } = this;
    const s0 = index * CHUNK_LEN, s1 = s0 + CHUNK_LEN;
    const anchor = track.point(s0, 0, 0, new THREE.Vector3());
    const group = new THREE.Group();
    const tmp = new THREE.Vector3();
    const rel = (s: number, L: number, y: number) => track.point(s, L, y, tmp).sub(anchor);

    /* ---------- road surface ---------- */
    const road = new Builder();
    const sMod = (s: number) => s % (p.lamps.spacing * 200);
    for (let s = s0; s <= s1 + 1e-6; s += DS) {
      road.v(rel(s, -ROAD.W, 0), undefined, [-ROAD.W, sMod(s)]);
      road.v(rel(s, ROAD.W, 0), undefined, [ROAD.W, sMod(s)]);
    }
    for (let i = 0; i < CHUNK_LEN / DS; i++) road.quad(i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    // seam: s values of the last row must continue smoothly (mod) – fine since spacing divides the modulus
    group.add(named(new THREE.Mesh(road.geometry('aRoad'), this.mats.road), 'road'));

    /* ---------- neon markings ---------- */
    const neon = new Builder();
    const pa = new THREE.Vector3(), pb = new THREE.Vector3();
    const ribbon = (sa: number, sb: number, L: number, w: number, c: HDR, y = 0.02, kind = LOD_LINE) => {
      const step = Math.min(DS, sb - sa);
      let prevA = -1, prevB = -1;
      for (let s = sa; s <= sb + 1e-6; s += step) {
        pa.copy(rel(s, L - w / 2, y)); pb.copy(rel(s, L + w / 2, y));
        const hx = (pb.x - pa.x) / 2, hy = (pb.y - pa.y) / 2, hz = (pb.z - pa.z) / 2;
        const a = neon.v(pa, c, undefined, [-hx, -hy, -hz, kind]), b = neon.v(pb, c, undefined, [hx, hy, hz, kind]);
        if (prevA >= 0) neon.quad(prevA, prevB, b, a);
        prevA = a; prevB = b;
      }
    };
    const halo = (c: HDR, k: number): HDR => [c[0] * k, c[1] * k, c[2] * k];
    for (const side of [-1, 1]) {
      ribbon(s0, s1, side * ROAD.EDGE, 0.22, p.road.edge);
      ribbon(s0, s1, side * ROAD.EDGE, 0.6, halo(p.road.edge, 0.12), 0.015);
      ribbon(s0, s1, side * ROAD.SHOULDER, 0.13, p.road.shoulder);
    }
    // dashes
    const dashes: [number, number, number, number, HDR][] = [
      [0, 12, 4.5, 0.16, p.road.center],
      [3.5, 12, 3, 0.12, p.road.lane],
      [-3.5, 12, 3, 0.12, p.road.lane],
    ];
    for (const [L, per, len, w, c] of dashes) {
      for (let d = Math.ceil(s0 / per) * per; d < s1; d += per) ribbon(d, Math.min(d + len, s1), L, w, c, 0.02, LOD_DASH);
      // what the dashes average out to far away
      ribbon(s0, s1, L, w, [c[0] * len / per, c[1] * len / per, c[2] * len / per], 0.019, LOD_DASH_AVG);
    }
    // hatched shoulder rungs
    const RUNG = 11;
    for (let d = Math.ceil(s0 / RUNG) * RUNG; d < s1; d += RUNG) {
      for (const side of [-1, 1]) {
        const Lin = side * (ROAD.EDGE + 0.25), Lout = side * (ROAD.SHOULDER - 0.1), w = 0.12;
        const e = p.road.shoulder;
        const R: [number, number, number, number] = [0, 0, 0, LOD_DASH];
        const a = neon.v(rel(d - w, Lin, 0.02), e, undefined, R), b = neon.v(rel(d + w, Lin, 0.02), e, undefined, R);
        const c = neon.v(rel(d + 3.5 + w, Lout, 0.02), e, undefined, R), dd = neon.v(rel(d + 3.5 - w, Lout, 0.02), e, undefined, R);
        neon.quad(a, b, c, dd);
      }
    }

    /* ---------- props: lamps, reflector posts ---------- */
    const dark: THREE.BufferGeometry[] = [];
    const neonParts: THREE.BufferGeometry[] = [];
    const headParts: THREE.BufferGeometry[] = [];
    const addParts: THREE.BufferGeometry[] = [];
    const reflParts: THREE.BufferGeometry[] = [];
    const glowPts: THREE.Vector3[] = [];
    const m4 = new THREE.Matrix4();
    const frame = { x: 0, y: 0, z: 0, heading: 0, fx: 0, fz: 0, rx: 0, rz: 0, grade: 0 };
    const placeAt = (s: number) => {
      track.frame(s, frame);
      const o = rel(s, 0, 0);
      // local x = lateral (right), y = up, z = backwards along track
      return m4.set(
        frame.rx, 0, -frame.fx, o.x,
        0, 1, 0, o.y,
        frame.rz, 0, -frame.fz, o.z,
        0, 0, 0, 1,
      );
    };

    if (p.lamps.enabled) {
      const sp = p.lamps.spacing;
      for (let s = Math.ceil(s0 / sp) * sp; s < s1; s += sp) {
        const M = placeAt(s).clone();
        for (const side of [-1, 1]) {
          const pole = new THREE.CylinderGeometry(0.1, 0.15, 9.6, 6).translate(side * ROAD.POLE_L, 4.8, 0);
          const armLen = ROAD.POLE_L - ROAD.HEAD_L + 0.3;
          const arm = new THREE.BoxGeometry(armLen, 0.14, 0.16).translate(side * (ROAD.HEAD_L + armLen / 2 - 0.15), 9.5, 0);
          dark.push(pole.applyMatrix4(M), arm.applyMatrix4(M));
          headParts.push(stripAttrs(colorize(new THREE.BoxGeometry(1.3, 0.16, 0.5).translate(side * ROAD.HEAD_L, 9.36, 0), p.lamps.head)).applyMatrix4(M));

          // light cone (brighter at top)
          const cone = new THREE.ConeGeometry(3.4, 9.2, 18, 1, true).translate(side * ROAD.HEAD_L, 4.65, 0);
          const cc = new THREE.Color(p.lamps.glow);
          addParts.push(stripAttrs(colorize(cone, [cc.r * p.lamps.cone, cc.g * p.lamps.cone, cc.b * p.lamps.cone], (_x, y) => smoothstep(-1, 9.3, y) * 0.8 + 0.2)).applyMatrix4(M));

          // wet-road reflection streak stretching towards the viewer (+z local = backwards)
          const rb = new Builder();
          const r = p.lamps.reflection, L = side * ROAD.HEAD_L, hw = 0.45;
          const cHi: HDR = [cc.r * r, cc.g * r, cc.b * r], c0: HDR = [0, 0, 0];
          const V = (x: number, z: number, c: HDR) => rb.v(new THREE.Vector3(x, 0.03, z), c);
          const a0 = V(L - hw * 0.6, -3, c0), b0 = V(L + hw * 0.6, -3, c0);
          const a1 = V(L - hw, 0, cHi), b1 = V(L + hw, 0, cHi);
          const a2 = V(L - hw * 1.6, 28, c0), b2 = V(L + hw * 1.6, 28, c0);
          rb.quad(a0, b0, b1, a1); rb.quad(a1, b1, b2, a2);
          reflParts.push(rb.geometry().applyMatrix4(M));

          glowPts.push(new THREE.Vector3(side * ROAD.HEAD_L, 9.2, 0).applyMatrix4(M));
        }
      }
    }

    const REF = 23;
    for (let s = Math.ceil(s0 / REF) * REF; s < s1; s += REF) {
      const M = placeAt(s);
      for (const side of [-1, 1]) {
        dark.push(new THREE.BoxGeometry(0.12, 1.0, 0.12).translate(side * ROAD.REFLECTOR_L, 0.5, 0).applyMatrix4(M));
        const c: HDR = side < 0 ? [p.road.reflector[0], p.road.reflector[1] * 1.4, p.road.reflector[2]] : p.road.reflector;
        const cube = stripAttrs(colorize(new THREE.BoxGeometry(0.13, 0.13, 0.13).translate(side * ROAD.REFLECTOR_L, 0.9, 0), c)).applyMatrix4(M);
        const n = cube.getAttribute('position').count;
        const lod = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) lod[i * 4 + 3] = LOD_SMALL;
        cube.setAttribute('aLod', new THREE.BufferAttribute(lod, 4));
        neonParts.push(cube.index ? cube.toNonIndexed() : cube);
      }
    }

    if (glowPts.length) {
      const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints(glowPts), this.mats.glow);
      pts.renderOrder = 3;
      pts.frustumCulled = false;
      group.add(named(pts, 'lampglow'));
    }
    if (!neon.empty) neonParts.push(neon.geometry().toNonIndexed());
    if (neonParts.length) {
      const m = new THREE.Mesh(mergeGeometries(neonParts), this.mats.marking);
      m.renderOrder = 1;
      group.add(named(m, 'markings'));
    }
    if (headParts.length) group.add(named(new THREE.Mesh(mergeGeometries(headParts), this.mats.lampHead), 'heads'));
    if (dark.length) group.add(named(new THREE.Mesh(mergeGeometries(dark), this.mats.dark), 'poles'));
    if (addParts.length) {
      const m = new THREE.Mesh(mergeGeometries(addParts), this.mats.add);
      m.renderOrder = 2;
      group.add(named(m, 'cones'));
    }
    if (reflParts.length) {
      const m = new THREE.Mesh(mergeGeometries(reflParts), this.mats.refl);
      m.renderOrder = 2;
      group.add(named(m, 'reflections'));
    }

    /* ---------- terrain ---------- */
    const terrain = this.buildTerrain(s0, s1, anchor);
    group.add(named(terrain, 'terrain'));
    for (const o of group.children) o.visible = !this.hidden.has(o.name);

    this.root.add(group);
    return { index, anchor, group, terrain };
  }

  private buildTerrain(s0: number, s1: number, anchor: THREE.Vector3) {
    const { track, p } = this;
    const W = ROAD.W;
    const cols = [0, 1.5, 4, 8, 14, 22, 34, 50, 75, 110, 160, 230, 320, 440, 600];
    const near = new THREE.Color(p.terrain.near), far = new THREE.Color(p.terrain.far);
    const tmp = new THREE.Vector3();
    const hill = p.terrain.hilliness;
    const b = new Builder();
    const ROW = 4;
    const rows = Math.round((s1 - s0) / ROW) + 1;

    for (const side of [-1, 1]) {
      const Ls = cols.map(c => side * (W - 0.3 + c));
      if (side < 0) Ls.reverse(); // keep L increasing for consistent winding
      const start = b.pos.length / 3;
      for (let r = 0; r < rows; r++) {
        const s = s0 + r * ROW;
        const roadY = track.elevation(s);
        for (const L of Ls) {
          track.point(s, L, 0, tmp);
          const a = Math.abs(L);
          const ditch = -0.7 * smoothstep(W, W + 4, a);
          const t1 = smoothstep(W + 6, 150, a), t2 = smoothstep(90, 560, a);
          const h = fbm(tmp.x * 0.0035, tmp.z * 0.0035, 4);
          const rg = ridged(tmp.x * 0.0011 + 40, tmp.z * 0.0011 - 20, 4);
          tmp.y = roadY - 0.2 + ditch + hill * (t1 * (h - 0.3) * 70 + t2 * rg * 210);
          const k = smoothstep(0, 400, a) * 0.7 + 0.3 * smoothstep(0, 1, rg * t2 * 2);
          const c = near.clone().lerp(far, k);
          b.v(tmp.sub(anchor), [c.r, c.g, c.b]);
        }
      }
      const n = Ls.length;
      for (let r = 0; r < rows - 1; r++) {
        for (let i = 0; i < n - 1; i++) {
          const a = start + r * n + i;
          b.quad(a, a + 1, a + 1 + n, a + n);
        }
      }
    }
    const geo = b.geometry();
    return new THREE.Mesh(geo, this.mats.terrain);
  }
}

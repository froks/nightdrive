import * as THREE from 'three';
import { getGlowScale } from '../util/materials';
import { glowTexture } from '../util/textures';
import { clamp, mix, rand, smoothstep } from '../util/math';
import { UP, glowSprite, rr, type SkyCtx, type SkyEvent, type SkyEventKind, type SkyWorld } from './skyCommon';

/**
 * Super rare: a flying, time-travelling sports car.
 *
 *  - 'depart': overtakes overhead, drops down over the road ahead and speeds
 *    away. Electricity builds up around it, it vanishes in a flash and leaves
 *    two burning fire trails hanging in the air.
 *  - 'arrive': three flashes far ahead, it materialises, crackling, then comes
 *    towards the car in weaving, banking curves and swoops out of the screen.
 *
 * World-anchored along the road (positions come from the track), drawn in the
 * camera-centred sky-event group.
 */
export type TimeCarMode = 'depart' | 'arrive';

/* ------------------------------------------------------------------- model */

/** Low-poly wedge coupé, ~4.2 m long, facing -Z, wheels folded flat for flight. */
function carModel() {
  const g = new THREE.Group();
  const steel = new THREE.MeshLambertMaterial({ color: 0xa9afb8, emissive: 0x16181d });
  const black = new THREE.MeshLambertMaterial({ color: 0x0b0c0f });
  const glass = new THREE.MeshLambertMaterial({ color: 0x0a0f1a, emissive: 0x04060a });
  const tail = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.25, 0.3) });
  const head = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 5, 5.5) });
  const hover = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 2.4, 4.0) });
  const reactor = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3.3, 3.8) });
  const mats: THREE.Material[] = [steel, black, glass, tail, head, hover, reactor];

  /** side profile (x = along the car, front at +x) extruded across the width */
  const extrude = (pts: [number, number][], width: number, mat: THREE.Material) => {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false })
      .translate(0, 0, -width / 2).rotateY(Math.PI / 2); // +x (front) -> -z
    const m = new THREE.Mesh(geo, mat);
    g.add(m);
    return m;
  };
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };

  // wedge body: low pointed nose, long flat deck
  extrude([[2.15, 0.3], [2.15, 0.6], [0.6, 0.8], [-1.0, 0.85], [-2.05, 0.82], [-2.1, 0.6], [-2.1, 0.3]], 1.86, steel);
  // cabin: raked windshield, short roof, long sloping rear window
  extrude([[0.6, 0.8], [-0.1, 1.17], [-0.95, 1.17], [-1.9, 0.84], [-1.9, 0.8]], 1.6, glass);
  box(1.62, 0.05, 0.86, 0, 1.18, 0.52, steel);                 // roof skin
  for (let i = 0; i < 5; i++) box(1.5, 0.03, 0.06, 0, 1.12 - i * 0.065, 1.05 + i * 0.17, black); // rear louvres
  box(1.9, 0.2, 4.3, 0, 0.32, 0, black);                       // dark lower trim
  for (const sx of [-0.5, 0.5]) box(0.62, 0.12, 0.04, sx, 0.62, 2.11, tail);
  for (const sx of [-0.62, 0.62]) box(0.4, 0.1, 0.04, sx, 0.52, -2.16, head);
  // the gadget on the back
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.32, 16), reactor);
  core.position.set(0, 1.0, 1.72);
  g.add(core);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.05, 8, 20).rotateX(Math.PI / 2), black);
  ring.position.copy(core.position);
  g.add(ring);

  // wheels folded flat, glowing underneath
  const sprites: THREE.Sprite[] = [];
  const wheels: [number, number][] = [[-0.98, -1.3], [0.98, -1.3], [-0.98, 1.35], [0.98, 1.35]];
  for (const [x, z] of wheels) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.22, 20), black);
    w.position.set(x, 0.2, z);
    g.add(w);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.02, 20), hover);
    disc.position.set(x, 0.08, z);
    g.add(disc);
    const s = glowSprite(false);
    s.position.set(x, 0.0, z);
    s.scale.setScalar(1.6);
    s.material.color.setRGB(0.15, 0.35, 0.7);
    g.add(s);
    sprites.push(s);
  }
  for (const [sx, z, c, sc] of [[-0.62, -2.3, [2, 2, 2.2], 3.5], [0.62, -2.3, [2, 2, 2.2], 3.5], [-0.5, 2.2, [1.4, 0.08, 0.1], 1.3], [0.5, 2.2, [1.4, 0.08, 0.1], 1.3]] as const) {
    const s = glowSprite(false);
    s.position.set(sx, 0.57, z);
    s.scale.setScalar(sc);
    s.material.color.setRGB(c[0], c[1], c[2]);
    g.add(s);
    sprites.push(s);
  }
  const lampColors = sprites.slice(4).map(s => s.material.color.clone());
  return { g, mats, sprites, lampColors, rearWheels: [new THREE.Vector3(-0.98, 0.1, 1.35), new THREE.Vector3(0.98, 0.1, 1.35)] };
}

/* ------------------------------------------------------------- electricity */

const BOLTS = 9, BOLT_SEGS = 6;

/** Jagged blue lightning crawling over the car body (offsets in car space, re-rolled ~20×/s). */
class Arcs {
  readonly lines: THREE.LineSegments;
  private local: Float32Array; // car-space bolt vertices
  private pos: THREE.BufferAttribute;
  private next = 0;
  private v = new THREE.Vector3();

  constructor() {
    const n = BOLTS * BOLT_SEGS * 2;
    this.local = new Float32Array(n * 3);
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.pos);
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: new THREE.Color(2.5, 3.8, 9), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
  }

  private reroll(count: number) {
    const L = this.local;
    let k = 0;
    for (let b = 0; b < BOLTS; b++) {
      // start on the body surface, wander off along it
      let x = rr(-1, 1), y = rr(0.2, 1.2), z = rr(-2.2, 2.2);
      const reach = b < count ? rr(0.35, 0.8) : 0;
      for (let s = 0; s < BOLT_SEGS; s++) {
        L[k++] = x; L[k++] = y; L[k++] = z;
        x += rr(-1, 1) * reach; y += rr(-0.6, 0.9) * reach; z += rr(-1, 1) * reach;
        L[k++] = x; L[k++] = y; L[k++] = z;
      }
    }
  }

  /** @param level 0..1 intensity (more and longer bolts as it builds up) */
  update(dt: number, level: number, car: THREE.Object3D) {
    this.lines.visible = level > 0.01;
    if (!this.lines.visible) return;
    this.next -= dt;
    if (this.next <= 0) { this.next = rr(0.03, 0.07); this.reroll(Math.ceil(level * BOLTS)); }
    car.updateMatrix();
    const L = this.local, P = this.pos.array as Float32Array;
    for (let i = 0; i < L.length; i += 3) {
      this.v.set(L[i], L[i + 1], L[i + 2]).applyMatrix4(car.matrix);
      P[i] = this.v.x; P[i + 1] = this.v.y; P[i + 2] = this.v.z;
    }
    this.pos.needsUpdate = true;
    const flick = 0.5 + 0.5 * rand();
    (this.lines.material as THREE.LineBasicMaterial).color.setRGB(2.5, 3.8, 9).multiplyScalar(level * flick);
  }

  dispose() { this.lines.geometry.dispose(); (this.lines.material as THREE.Material).dispose(); }
}

/* ------------------------------------------------------------- fire trails */

const FIRE_MAX = 1400;
/** flame particles spawned per second per trail line (at full burn) */
const FIRE_RATE = 420;

/**
 * Two burning lines left by the rear wheels, world-anchored. Each line emits
 * flame particles that rise, swell and cool from yellow-white through orange
 * to dark red embers.
 */
class FireTrails {
  readonly mesh: THREE.Points;
  private pts: THREE.Vector3[][] = [[], []];
  private n = 0;
  private p = new Float32Array(FIRE_MAX * 3);   // absolute position
  private v = new Float32Array(FIRE_MAX * 3);   // velocity
  private age = new Float32Array(FIRE_MAX);
  private life = new Float32Array(FIRE_MAX);
  private size0 = new Float32Array(FIRE_MAX);
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private siz: THREE.BufferAttribute;
  private mat: THREE.ShaderMaterial;
  private debt = 0;

  constructor(private ctx: SkyCtx) {
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(FIRE_MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(FIRE_MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.siz = new THREE.BufferAttribute(new Float32Array(FIRE_MAX), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('aColor', this.col);
    g.setAttribute('aSize', this.siz);
    g.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: glowTexture() }, uScale: { value: 1000 } }]),
      fog: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute vec3 aColor;
        attribute float aSize;
        uniform float uScale;
        varying vec3 vColor;
        varying float vDepth;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float px = aSize * uScale / max(0.1, -mv.z);
          float s = max(px, 1.5);
          vColor = aColor * min(1.0, (px / s) * (px / s)); // keep energy when clamped to a min size
          vDepth = -mv.z;
          gl_PointSize = s;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D map;
        uniform float fogDensity;
        varying vec3 vColor;
        varying float vDepth;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          float fog = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
          gl_FragColor = vec4(max(vColor, 0.0) * t.a * (1.0 - 0.85 * fog), 1.0);
        }`,
    });
    this.mesh = new THREE.Points(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Lay a new point of trail line `line` (absolute position). */
  add(line: number, p: THREE.Vector3) {
    const arr = this.pts[line];
    const last = arr[arr.length - 1];
    if (!last || last.distanceToSquared(p) > 0.25) arr.push(p.clone());
  }

  private emit(fade: number) {
    if (this.n >= FIRE_MAX) return;
    const arr = this.pts[rand() < 0.5 ? 0 : 1];
    if (arr.length < 2) return;
    const f = rand() * (arr.length - 1), i = Math.floor(f), a = f - i;
    const A = arr[i], B = arr[i + 1], k = this.n++;
    this.p[k * 3] = mix(A.x, B.x, a) + rr(-0.12, 0.12);
    this.p[k * 3 + 1] = mix(A.y, B.y, a) + rr(-0.08, 0.08);
    this.p[k * 3 + 2] = mix(A.z, B.z, a) + rr(-0.12, 0.12);
    this.v[k * 3] = rr(-0.5, 0.5);
    this.v[k * 3 + 1] = rr(1.2, 3.2);
    this.v[k * 3 + 2] = rr(-0.5, 0.5);
    this.age[k] = 0;
    this.life[k] = rr(0.35, 0.9) * (0.6 + 0.4 * fade); // flames get shorter as it burns out
    this.size0[k] = rr(0.35, 0.75);
  }

  /** @param fade overall burn 0..1 */
  update(dt: number, fade: number) {
    this.mat.uniforms.uScale.value = getGlowScale();
    // spawn
    this.debt += FIRE_RATE * 2 * fade * dt;
    while (this.debt >= 1) { this.debt--; this.emit(fade); }
    // simulate (swap-remove dead ones)
    const P = this.p, V = this.v;
    for (let k = 0; k < this.n; k++) {
      this.age[k] += dt;
      if (this.age[k] >= this.life[k]) {
        const j = --this.n;
        P[k * 3] = P[j * 3]; P[k * 3 + 1] = P[j * 3 + 1]; P[k * 3 + 2] = P[j * 3 + 2];
        V[k * 3] = V[j * 3]; V[k * 3 + 1] = V[j * 3 + 1]; V[k * 3 + 2] = V[j * 3 + 2];
        this.age[k] = this.age[j]; this.life[k] = this.life[j]; this.size0[k] = this.size0[j];
        k--;
        continue;
      }
      V[k * 3 + 1] += 2.5 * dt; // buoyancy
      P[k * 3] += V[k * 3] * dt; P[k * 3 + 1] += V[k * 3 + 1] * dt; P[k * 3 + 2] += V[k * 3 + 2] * dt;
    }
    // write render buffers (camera-relative)
    const cam = this.ctx.camAbs;
    const R = this.pos.array as Float32Array, C = this.col.array as Float32Array, S = this.siz.array as Float32Array;
    for (let k = 0; k < this.n; k++) {
      R[k * 3] = P[k * 3] - cam.x; R[k * 3 + 1] = P[k * 3 + 1] - cam.y; R[k * 3 + 2] = P[k * 3 + 2] - cam.z;
      const u = this.age[k] / this.life[k];
      // yellow-white core -> orange -> dark red, fading out
      const hot = 1 - smoothstep(0, 0.35, u), cool = smoothstep(0.35, 1, u);
      const I = (1 - u) * (1 - u) * 0.95;
      C[k * 3] = mix(mix(2.6, 2.4, 1 - hot), 0.9, cool) * I;
      C[k * 3 + 1] = mix(mix(1.35, 0.6, 1 - hot), 0.1, cool) * I;
      C[k * 3 + 2] = mix(mix(0.35, 0.06, 1 - hot), 0.01, cool) * I;
      S[k] = this.size0[k] * (0.6 + 1.2 * Math.sin(Math.min(1, u * 1.4) * Math.PI * 0.5)) * (1 - 0.5 * u);
    }
    this.pos.needsUpdate = this.col.needsUpdate = this.siz.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, this.n);
  }

  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

/* --------------------------------------------------------------------- car */

export class TimeCar implements SkyEvent {
  kind: SkyEventKind = 'timecar';
  done = false;
  private t = 0;
  private car = carModel();
  private arcs = new Arcs();
  private trails: FireTrails;
  private flash = glowSprite(false);
  private aura = glowSprite(false);
  /** departure: moment of the jump; arrival: moment it appears */
  private tJump: number;
  private side = rand() < 0.5 ? -1 : 1;
  private glitched = false;
  private abs = new THREE.Vector3();
  private abs2 = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private m4 = new THREE.Matrix4();
  private flashAt = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private arrAhead = 170;
  private closing = 30;
  private toCam = new THREE.Vector3();

  constructor(private group: THREE.Group, private ctx: SkyCtx, private world: SkyWorld, readonly mode: TimeCarMode) {
    this.tJump = mode === 'depart' ? rr(3.6, 4.0) : 0.45;
    this.trails = new FireTrails(ctx);
    this.flash.scale.setScalar(16);
    this.aura.scale.setScalar(7);
    this.car.g.matrixAutoUpdate = true;
    group.add(this.car.g, this.arcs.lines, this.trails.mesh, this.flash, this.aura);
    this.update(0);
  }

  /** Path relative to the player: [distance ahead, lateral, height above road]. */
  private path(t: number): [number, number, number] {
    if (this.mode === 'depart') {
      const ahead = -28 + 17 * t + 1.6 * t * t; // overtakes, jumps ~55-65 m ahead
      const L = -1.75 * smoothstep(0.5, 3, t) + 0.5 * Math.sin(t * 1.4);
      const h = mix(13, 3.5, smoothstep(0, 2.6, t)) + 0.3 * Math.sin(t * 3.1);
      return [ahead, L, h];
    }
    const tau = Math.max(0, t - this.tJump);
    // flies towards us at its own 14 m/s on top of our speed (integrated in update)
    const ahead = this.arrAhead - this.closing * (t - this.t);
    const k = clamp((40 - ahead) / 55, 0, 1); // final swoop out of the screen
    const L = 6 * Math.sin(tau * 1.8) * (1 - k) + this.side * k * k * 30;
    const h = 7 + 2.5 * Math.sin(tau * 1.6 + 0.5) + k * k * 12;
    return [ahead, L, h];
  }

  private pointAt(t: number, carPos: number, out: THREE.Vector3) {
    const [a, L, h] = this.path(t);
    return this.world.roadPoint(carPos + a, L, h, out);
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t, w = this.world, cam = this.ctx.camAbs;
    const depart = this.mode === 'depart';
    const carPos = w.carPos();
    if (!depart) {
      this.closing = w.speed() + 14;
      if (t > this.tJump) this.arrAhead -= this.closing * dt;
    }

    // position + orientation from the path (velocity incl. the player's own motion)
    const h = 0.03;
    this.pointAt(t, carPos, this.abs);
    this.pointAt(t + h, carPos + w.speed() * h, this.abs2);
    this.vel.subVectors(this.abs2, this.abs);
    const g = this.car.g;
    g.position.subVectors(this.abs, cam);
    if (this.vel.lengthSq() > 1e-8) {
      this.m4.lookAt(this.abs, this.abs2, UP); // -Z (nose) along the velocity
      g.quaternion.setFromRotationMatrix(this.m4);
    }
    const lat = (tt: number) => this.path(tt)[1];
    const latAcc = (lat(t + h) - 2 * lat(t) + lat(Math.max(0, t - h))) / (h * h);
    g.rotateZ(clamp(latAcc * 0.05 * (depart ? -1 : 1), -0.8, 0.8)); // bank into the curves

    // head/tail glows only show from the side they face (sprites have no direction)
    const fwd = this.dir.set(0, 0, -1).applyQuaternion(g.quaternion);
    const facing = -fwd.dot(this.toCam.copy(g.position).normalize()); // +1: nose towards us
    this.car.sprites.slice(4).forEach((s, i) => {
      const k = i < 2 ? smoothstep(-0.1, 0.6, facing) : smoothstep(-0.1, 0.6, -facing);
      s.material.color.copy(this.car.lampColors[i]).multiplyScalar(0.15 + 0.85 * k);
    });

    const visible = depart ? t < this.tJump : t >= this.tJump;
    g.visible = visible;

    // electricity: builds up before the jump / crackles right after appearing
    const arc = depart
      ? smoothstep(this.tJump - 1.3, this.tJump - 0.1, t) * (t < this.tJump ? 1 : 0)
      : (t >= this.tJump ? 1 - smoothstep(this.tJump + 0.3, this.tJump + 1.4, t) : 0);
    this.arcs.update(dt, arc, g);
    this.aura.visible = arc > 0.01;
    this.aura.position.copy(g.position).y += 0.6;
    this.aura.material.color.setRGB(0.3, 0.45, 1.1).multiplyScalar(arc * (0.4 + 0.6 * rand()));

    // the flash(es)
    let f = 0;
    if (depart) {
      if (t < this.tJump) this.flashAt.copy(this.abs);
      f = t >= this.tJump ? Math.exp(-(t - this.tJump) * 7) : 0;
    } else {
      this.flashAt.copy(this.abs);
      for (const tf of [0, 0.22, this.tJump]) if (t >= tf) f = Math.max(f, Math.exp(-(t - tf) * 9));
    }
    this.flash.visible = f > 0.01;
    this.flash.position.subVectors(this.flashAt, cam).y += 0.6;
    this.flash.material.color.setRGB(1.6, 2.1, 3.6).multiplyScalar(f);
    if (!this.glitched && t >= this.tJump) { this.glitched = true; w.glitch?.(); }

    // fire trails: laid by the rear wheels during the run-up, then burn out where they hang
    if (depart) {
      if (t > this.tJump - 1.0 && t < this.tJump) {
        g.updateMatrix();
        this.car.rearWheels.forEach((wp, i) => this.trails.add(i, this.abs2.copy(wp).applyMatrix4(g.matrix).add(cam)));
      }
      this.trails.update(dt, (t < this.tJump ? 0.6 : 1) * (1 - smoothstep(this.tJump + 2.5, this.tJump + 5, t)));
    }

    const [ahead] = this.path(t);
    this.done = depart ? t > this.tJump + 5.2 : ahead < -30 || t > 12;
  }

  dispose() {
    this.group.remove(this.car.g, this.arcs.lines, this.trails.mesh, this.flash, this.aura);
    this.car.g.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
    for (const m of this.car.mats) m.dispose();
    for (const s of this.car.sprites) s.material.dispose();
    this.arcs.dispose();
    this.trails.dispose();
    this.flash.material.dispose();
    this.aura.material.dispose();
  }
}

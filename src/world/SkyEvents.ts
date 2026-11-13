import * as THREE from 'three';
import type { ScenePreset } from '../scenes/types';
import { TAU, mix, rand, smoothstep } from '../util/math';
import { UP, easeOut, glowSprite, rr, type SkyCtx, type SkyEvent, type SkyEventKind, type SkyWorld } from './skyCommon';
import { TimeCar, type TimeCarMode } from './TimeCar';

/**
 * Rare things crossing the sky: shooting stars, the odd meteor shower,
 * satellites, distant planes and — very occasionally — a UFO, which either
 * just has a look around or comes down for a cow grazing next to the road.
 * Super rarely, a time-travelling car (see TimeCar.ts).
 *
 * Everything lives in a group that follows the camera (like the sky dome), so
 * events are effectively "at infinity" and stay put in the view while driving.
 * Directions are anchored to the road heading at spawn time, so they show up in
 * front of the windshield.
 *
 * Rates come from `preset.skyEvents` (multipliers, 0 disables) and the global
 * `rate` multiplier (?eggs=N). Force one from the console:
 *   nightdrive.skyEvents.spawn('ufo')        // or 'abduction' / 'flyby'
 *   nightdrive.skyEvents.spawn('timecar')    // or 'departure' / 'arrival'
 */
export type { SkyEventKind, SkyWorld } from './skyCommon';
export const skyEventKinds: SkyEventKind[] = ['meteor', 'shower', 'satellite', 'plane', 'ufo', 'timecar'];

/** Mean seconds between events at rate multiplier 1. */
const MEAN_INTERVAL: Record<SkyEventKind, number> = {
  meteor: 75,
  shower: 1100,
  satellite: 160,
  plane: 220,
  ufo: 720,
  timecar: 2400,
};
/** Only one of these at a time. */
const SINGLETON = new Set<SkyEventKind>(['shower', 'plane', 'ufo', 'timecar']);

const SKY_D = 4000; // inside the dome (4500), behind the mountain rings (2600/3600)

/** Unit direction for azimuth (relative to `heading`, right +) and elevation. */
function skyDir(heading: number, az: number, el: number, out = new THREE.Vector3()) {
  const a = heading + az;
  return out.set(Math.sin(a) * Math.cos(el), Math.sin(el), -Math.cos(a) * Math.cos(el));
}
const expRand = (mean: number) => -Math.log(1 - rand()) * mean;

/* ------------------------------------------------------------------ meteor */

const TRAIL_SEGS = 12;

/** A single shooting star moving along a great circle: tapered ribbon + glowing head. */
class Meteor implements SkyEvent {
  kind: SkyEventKind = 'meteor';
  done = false;
  private t = 0;
  private mesh: THREE.Mesh;
  private head: THREE.Sprite;
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private flare: number;
  private v = new THREE.Vector3();
  private tan = new THREE.Vector3();
  private side = new THREE.Vector3();

  /**
   * @param a start direction (unit)
   * @param b direction of travel, unit and perpendicular to `a`
   */
  constructor(
    private group: THREE.Group,
    private a: THREE.Vector3,
    private b: THREE.Vector3,
    private speed = rr(0.3, 0.65),
    private life = rr(0.55, 1.3),
    private trail = rr(0.1, 0.22),
    private color = rand() < 0.15 ? new THREE.Color(0.6, 1.0, 0.75) : new THREE.Color(0.8, 0.88, 1.0),
    private bright = rr(3, 7),
  ) {
    // occasional fireball: brightens towards the end before burning out
    this.flare = rand() < 0.2 ? rr(1.5, 3) : 0;
    const n = (TRAIL_SEGS + 1) * 2;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos);
    g.setAttribute('color', this.col);
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_SEGS; i++) { const k = i * 2; idx.push(k, k + 1, k + 3, k, k + 3, k + 2); }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -9;
    this.head = glowSprite(true);
    group.add(this.mesh, this.head);
    this.update(0);
  }

  private at(th: number, out: THREE.Vector3) {
    return out.copy(this.a).multiplyScalar(Math.cos(th)).addScaledVector(this.b, Math.sin(th));
  }

  update(dt: number) {
    this.t += dt;
    const u = this.t / this.life;
    if (u >= 1) { this.done = true; return; }
    const env = smoothstep(0, 0.12, u) * (1 - smoothstep(0.6, 1, u));
    const I = this.bright * env * (1 + this.flare * Math.exp(-(((u - 0.72) / 0.1) ** 2)));
    const headTh = this.speed * this.t;
    const len = Math.min(headTh, this.trail * (0.4 + 0.6 * smoothstep(0, 0.5, u)));
    const w = SKY_D * 0.0016 * (0.6 + 0.4 * env);
    const p = this.pos.array as Float32Array, c = this.col.array as Float32Array;
    for (let i = 0; i <= TRAIL_SEGS; i++) {
      const f = i / TRAIL_SEGS; // 0 = head, 1 = tail end
      const th = headTh - len * f;
      this.at(th, this.v);
      this.tan.copy(this.b).multiplyScalar(Math.cos(th)).addScaledVector(this.a, -Math.sin(th));
      this.side.crossVectors(this.tan, this.v).normalize().multiplyScalar(w * (1 - f) * 0.5);
      this.v.multiplyScalar(SKY_D);
      const k = 1 - f, ci = I * k * k;
      for (const [j, sgn] of [[i * 2, 1], [i * 2 + 1, -1]] as const) {
        p[j * 3] = this.v.x + this.side.x * sgn;
        p[j * 3 + 1] = this.v.y + this.side.y * sgn;
        p[j * 3 + 2] = this.v.z + this.side.z * sgn;
        c[j * 3] = this.color.r * ci; c[j * 3 + 1] = this.color.g * ci; c[j * 3 + 2] = this.color.b * ci;
      }
    }
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.at(headTh, this.head.position).multiplyScalar(SKY_D);
    this.head.scale.setScalar(SKY_D * 0.012);
    this.head.material.color.copy(this.color).multiplyScalar(I * 0.5);
  }

  dispose() {
    this.group.remove(this.mesh, this.head);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.head.material.dispose();
  }
}

/** Random shooting star somewhere in front of the car, mostly falling. */
function randomMeteor(group: THREE.Group, heading: number) {
  const a = skyDir(heading, rr(-0.6, 0.6), rr(0.13, 0.4));
  const right = new THREE.Vector3().crossVectors(a, UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, a);
  // direction in the tangent plane: 0 = right, -π/2 = straight down
  const ang = -Math.PI / 2 + (rand() < 0.5 ? -1 : 1) * rr(0.25, 1.1);
  const b = right.multiplyScalar(Math.cos(ang)).addScaledVector(up, Math.sin(ang)).normalize();
  return new Meteor(group, a, b);
}

/* ------------------------------------------------------------------ shower */

/** A burst of shooting stars radiating from one point above the windshield. */
class Shower implements SkyEvent {
  kind: SkyEventKind = 'shower';
  done = false;
  private t = 0;
  private next = 0;
  private left = Math.round(rr(7, 14));
  private meteors: Meteor[] = [];
  private radiant: THREE.Vector3;

  constructor(private group: THREE.Group, heading: number) {
    this.radiant = skyDir(heading, rr(-0.4, 0.4), rr(0.5, 0.7));
  }

  update(dt: number) {
    this.t += dt;
    this.next -= dt;
    if (this.left > 0 && this.next <= 0) {
      this.left--;
      this.next = rr(0.15, 1.2);
      const m = this.spawnOne();
      if (m) this.meteors.push(m);
    }
    for (const m of this.meteors) m.update(dt);
    this.meteors = this.meteors.filter(m => (m.done ? (m.dispose(), false) : true));
    this.done = this.left === 0 && this.meteors.length === 0;
  }

  private spawnOne() {
    const r = this.radiant;
    const e1 = new THREE.Vector3().crossVectors(r, UP).normalize();
    const e2 = new THREE.Vector3().crossVectors(e1, r);
    for (let tries = 0; tries < 8; tries++) {
      // downward half around the radiant, so trails point into the view
      const ang = rr(Math.PI * 0.95, Math.PI * 2.05);
      const p = e1.clone().multiplyScalar(Math.cos(ang)).addScaledVector(e2, Math.sin(ang));
      const d = rr(0.12, 0.45);
      const a = r.clone().multiplyScalar(Math.cos(d)).addScaledVector(p, Math.sin(d));
      if (a.y < 0.12) continue;
      const b = p.multiplyScalar(Math.cos(d)).addScaledVector(r, -Math.sin(d)).normalize();
      return new Meteor(this.group, a, b, rr(0.4, 0.7), rr(0.4, 0.9), rr(0.08, 0.18), undefined, rr(2.5, 6));
    }
    return null;
  }

  dispose() { for (const m of this.meteors) m.dispose(); }
}

/* --------------------------------------------------------------- satellite */

/** A faint dot gliding steadily across the stars, sometimes with a brief flare. */
class Satellite implements SkyEvent {
  kind: SkyEventKind = 'satellite';
  done = false;
  private t = 0;
  private a: THREE.Vector3;
  private b: THREE.Vector3;
  private speed = rr(0.012, 0.022);
  private life = rr(22, 34);
  private flareAt = rand() < 0.35 ? rr(0.3, 0.7) : -1;
  private dot = glowSprite(true);

  constructor(private group: THREE.Group, heading: number) {
    this.a = skyDir(heading, rr(-0.5, 0.5), rr(0.18, 0.42));
    const right = new THREE.Vector3().crossVectors(this.a, UP).normalize();
    const up = new THREE.Vector3().crossVectors(right, this.a);
    const ang = rr(0, TAU);
    this.b = right.multiplyScalar(Math.cos(ang)).addScaledVector(up, Math.sin(ang)).normalize();
    this.a.addScaledVector(this.b, -this.speed * this.life * 0.5).normalize(); // centre the pass on the view
    this.b.addScaledVector(this.a, -this.b.dot(this.a)).normalize();
    this.dot.scale.setScalar(SKY_D * 0.006);
    group.add(this.dot);
  }

  update(dt: number) {
    this.t += dt;
    const u = this.t / this.life;
    if (u >= 1) { this.done = true; return; }
    const th = this.speed * this.t;
    this.dot.position.copy(this.a).multiplyScalar(Math.cos(th)).addScaledVector(this.b, Math.sin(th)).multiplyScalar(SKY_D);
    const env = smoothstep(0, 0.12, u) * (1 - smoothstep(0.85, 1, u));
    const flare = this.flareAt > 0 ? 9 * Math.exp(-(((u - this.flareAt) * this.life / 0.7) ** 2)) : 0;
    this.dot.material.color.setRGB(1, 0.97, 0.9).multiplyScalar(env * (0.9 + flare));
  }

  dispose() { this.group.remove(this.dot); this.dot.material.dispose(); }
}

/* ------------------------------------------------------------------- plane */

/** Distant airliner: red/green nav lights, white double strobe, red beacon. */
class Plane implements SkyEvent {
  kind: SkyEventKind = 'plane';
  done = false;
  private t = 0;
  private obj = new THREE.Group();
  private lights: { s: THREE.Sprite; c: THREE.Color; blink: (t: number) => number }[] = [];
  private az0: number;
  private dir: number;
  private el = rr(0.12, 0.2);
  private D = rr(2200, 3000);
  private speed = rr(0.022, 0.035);
  private life: number;
  private tmp = new THREE.Vector3();

  constructor(private group: THREE.Group, private heading: number) {
    this.dir = rand() < 0.5 ? -1 : 1;
    this.az0 = -this.dir * rr(0.6, 0.8);
    this.life = (Math.abs(this.az0) * 2 + 0.2) / this.speed;
    const add = (x: number, y: number, c: [number, number, number], size: number, blink: (t: number) => number) => {
      const s = glowSprite(false);
      s.position.set(x, y, 0);
      s.scale.setScalar(size);
      this.obj.add(s);
      this.lights.push({ s, c: new THREE.Color().setRGB(...c), blink });
    };
    const ph = rand() * 3;
    // steady nav lights are dim; the anti-collision strobe outshines everything, the beacon sits in between
    add(-9, 0, [1.0, 0.09, 0.07], 18, () => 1);             // port wing (red)
    add(9, 0, [0.09, 1.0, 0.25], 18, () => 1);              // starboard wing (green)
    add(0, -2, [2.4, 0.2, 0.15], 24, t => ((t + ph) % 1.1 < 0.1 ? 1 : 0)); // beacon
    add(0, 0.5, [16, 16, 19], 40, t => { const k = (t + ph) % 1.3; return k < 0.06 || (k > 0.16 && k < 0.22) ? 1 : 0; }); // strobe
    group.add(this.obj);
  }

  update(dt: number) {
    this.t += dt;
    const u = this.t / this.life;
    if (u >= 1) { this.done = true; return; }
    const az = this.az0 + this.dir * this.speed * this.t;
    skyDir(this.heading, az, this.el + 0.01 * u, this.tmp).multiplyScalar(this.D);
    this.obj.position.copy(this.tmp);
    this.obj.lookAt(0, 0, 0); // face the camera (group origin)
    // flying sideways: put the leading wingtip's light first
    this.obj.scale.x = this.dir;
    const env = smoothstep(0, 0.08, u) * (1 - smoothstep(0.92, 1, u));
    for (const l of this.lights) l.s.material.color.copy(l.c).multiplyScalar(env * l.blink(this.t));
  }

  dispose() {
    this.group.remove(this.obj);
    for (const l of this.lights) l.s.material.dispose();
  }
}

/* --------------------------------------------------------------------- UFO */

const ufoBodyGeo = (() => {
  const prof = [[0, -2.8], [5, -2.4], [11, -1.3], [17, -0.2], [18, 0.2], [13, 1.2], [7, 2.0], [0, 2.3]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(prof, 48);
})();
const ufoDomeGeo = new THREE.SphereGeometry(6.5, 32, 12, 0, TAU, 0, Math.PI / 2).translate(0, 1.6, 0);
/** unit-height beam cone hanging below the saucer (y 0 .. -1), scaled per UFO */
const ufoBeamGeo = new THREE.CylinderGeometry(3.5, 9, 1, 40, 1, true).translate(0, -0.5, 0);
const UFO_SCALE = 1.7;

interface UfoOpts {
  /** absolute world position to hover at (abduction); otherwise hovers "at infinity" over the hills */
  anchor?: THREE.Vector3;
  scale?: number;
  hover?: number;
  /** [on, off] in seconds since spawn */
  beam?: [number, number];
}

/**
 * Saucer swoops in, hovers (a couple of jerky hops when just sightseeing),
 * then shoots off into the sky. With `anchor` it hovers over a fixed world
 * spot instead, e.g. above a cow, and can switch on its tractor beam.
 */
class Ufo implements SkyEvent {
  kind: SkyEventKind = 'ufo';
  done = false;
  t = 0;
  readonly tEnter = 2.2;
  private obj = new THREE.Group();
  private body: THREE.Mesh;
  private dome: THREE.Mesh;
  private rim: THREE.Sprite[] = [];
  private under: THREE.Sprite;
  private beam: THREE.Mesh;
  private beamMat: THREE.ShaderMaterial;
  private D = rr(800, 1000);
  private az = rr(-0.3, 0.3);
  private el = rr(0.1, 0.16);
  private tHover: number;
  private tExit = 1.6;
  private hops: { t: number; daz: number; del: number }[] = [];
  private beamOn: [number, number] | null;
  private anchor: THREE.Vector3 | null;
  private start: THREE.Vector3;
  private exitDir: THREE.Vector3;
  private hover = new THREE.Vector3();
  /** extra elevation added at runtime when the terrain ahead rises into the saucer */
  private lift = 0;
  private liftTarget = 0;
  private nextCheck = 0;
  private curAz = 0;
  private curEl = 0;
  private c0 = new THREE.Vector3();
  private c1 = new THREE.Vector3();
  private c2 = new THREE.Vector3();
  private palette = [new THREE.Color(0.2, 2.5, 2.2), new THREE.Color(2.6, 0.3, 1.8), new THREE.Color(2.6, 2.0, 0.3)];

  /** @param clear true if the straight line from the camera to a (group-local) point misses the terrain */
  constructor(
    private group: THREE.Group, private heading: number, private clear: (p: THREE.Vector3) => boolean,
    private ctx: SkyCtx, opts: UfoOpts = {},
  ) {
    this.anchor = opts.anchor ?? null;
    this.tHover = opts.hover ?? rr(7, 12);
    this.beamOn = opts.beam ?? null;
    const scale = opts.scale ?? UFO_SCALE;
    let dir: THREE.Vector3;
    if (this.anchor) {
      dir = this.c0.subVectors(this.anchor, ctx.camAbs).normalize();
      this.az = Math.atan2(dir.x, -dir.z) - heading;
      this.el = Math.asin(dir.y);
    } else {
      for (let i = 0, n = Math.floor(rr(1, 3.99)); i < n; i++)
        this.hops.push({ t: this.tEnter + this.tHover * (i + rr(0.3, 0.8)) / n, daz: rr(-0.1, 0.1), del: rr(-0.025, 0.035) });
      this.settle();
    }
    const side = this.az < 0 ? -1 : 1;
    this.start = skyDir(heading, this.az + side * rr(0.5, 0.8), this.el + rr(0.1, 0.25)).multiplyScalar(3200);
    this.exitDir = skyDir(heading, this.az + rr(-0.6, 0.6), rr(0.6, 1.2));

    this.body = new THREE.Mesh(ufoBodyGeo, new THREE.MeshLambertMaterial({ color: 0x2a2f44, emissive: 0x0a0c18, fog: false }));
    this.dome = new THREE.Mesh(ufoDomeGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.9, 1.1), fog: false }));
    this.obj.add(this.body, this.dome);
    for (let i = 0; i < 10; i++) {
      const s = glowSprite(false);
      s.scale.setScalar(9);
      this.rim.push(s);
      this.obj.add(s);
    }
    this.under = glowSprite(false);
    this.under.position.set(0, -3.5, 0);
    this.under.scale.setScalar(55);
    this.obj.add(this.under);

    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uI: { value: 0 }, uTime: { value: 0 } },
      // back wall only: whatever is inside the beam (a cow...) stays a crisp silhouette in front of it
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide, fog: false,
      vertexShader: /* glsl */`
        varying float vH;
        varying float vEdge;
        void main() {
          vH = -position.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 n = normalize(normalMatrix * normal);
          vEdge = abs(dot(n, normalize(-mv.xyz)));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uI, uTime;
        varying float vH;
        varying float vEdge;
        void main() {
          // interpolated vEdge can dip just below 0 at the silhouette; pow(<0) is NaN on real GPUs,
          // and NaNs get smeared across the screen by the bloom pass -> clamp before any pow/sqrt
          float e = clamp(vEdge, 0.0, 1.0);
          float h = clamp(vH, 0.0, 1.0);
          float bands = 0.75 + 0.25 * sin(h * 40.0 - uTime * 7.0);
          float a = uI * (0.3 + 0.7 * e * sqrt(e)) * (1.0 - 0.6 * h) * bands;
          gl_FragColor = vec4(vec3(0.35, 1.0, 0.75) * max(a, 0.0) * 0.55, 1.0);
        }`,
    });
    this.beam = new THREE.Mesh(ufoBeamGeo, this.beamMat);
    this.beam.frustumCulled = false;
    this.beam.renderOrder = 1;
    this.beam.visible = false;
    // reach a bit below the anchor height (ground), the terrain depth-clips the rest
    const beamLen = this.anchor ? 1.25 * BEAM_HEIGHT / scale : 300;
    this.beam.scale.set(1, beamLen, 1);
    this.beam.position.y = -2;
    this.obj.add(this.beam);
    this.obj.scale.setScalar(scale);
    group.add(this.obj);
    this.update(0);
  }

  /** Is the whole saucer (rim tips + belly, with some margin) visible above the terrain? */
  private clearAt(az: number, el: number) {
    const S = UFO_SCALE;
    const c = skyDir(this.heading, az, el, this.c0).multiplyScalar(this.D);
    const r = this.c1.crossVectors(c, UP).normalize();
    for (const [x, y] of [[-20, -7], [20, -7], [0, -10]]) {
      if (!this.clear(this.c2.copy(c).addScaledVector(r, x * S).setY(c.y + y * S))) return false;
    }
    return true;
  }

  /** Raise the hover spot until every hop position clears the hills. */
  private settle() {
    const spots: [number, number][] = [[0, 0]];
    let a = 0, e = 0;
    for (const h of this.hops) { a += h.daz; e += h.del; spots.push([a, e]); }
    for (let i = 0; i < 20 && !spots.every(([da, de]) => this.clearAt(this.az + da, this.el + de)); i++) this.el += 0.02;
  }

  /** Hover position in group-local (camera-centred) coordinates. */
  hoverPos(t: number, out: THREE.Vector3) {
    if (this.anchor) {
      out.subVectors(this.anchor, this.ctx.camAbs);
      out.y += 1.2 * Math.sin(t * 1.9) + 0.6 * Math.sin(t * 3.7);
      return out;
    }
    let az = this.az, el = this.el + this.lift;
    for (const h of this.hops) {
      const k = smoothstep(h.t, h.t + 0.28, t);
      az += h.daz * k; el += h.del * k;
    }
    this.curAz = az; this.curEl = el;
    skyDir(this.heading, az, el, out).multiplyScalar(this.D);
    out.y += 2.5 * Math.sin(t * 1.9) + 1.2 * Math.sin(t * 3.7);
    return out;
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t, tA = this.tEnter, tB = tA + this.tHover, tC = tB + this.tExit;
    if (t >= tC) { this.done = true; return; }

    // the car keeps driving, so new hills can rise into view: drift upwards out of their way
    if (!this.anchor && t < tB) {
      this.nextCheck -= dt;
      if (this.nextCheck <= 0) {
        this.nextCheck = 0.15;
        if (!this.clearAt(this.curAz, this.curEl)) this.liftTarget = Math.min(0.4, this.liftTarget + 0.025);
      }
      this.lift += (this.liftTarget - this.lift) * Math.min(1, dt * 2.5);
    }

    let fade = 1;
    if (t < tA) {
      this.hoverPos(tA, this.hover);
      this.obj.position.lerpVectors(this.start, this.hover, easeOut(t / tA));
    } else if (t < tB) {
      this.hoverPos(t, this.obj.position);
    } else {
      const u = (t - tB) / this.tExit;
      this.hoverPos(tB, this.obj.position).addScaledVector(this.exitDir, 3000 * u * u * u);
      fade = 1 - smoothstep(0.5, 1, u);
    }

    // tilt into hops / entry, idle wobble otherwise
    const hopTilt = this.hops.reduce((s, h) => s + h.daz * Math.exp(-(((t - h.t - 0.14) / 0.2) ** 2)), 0);
    const p = this.obj.position;
    this.obj.rotation.set(0.06 * Math.sin(t * 1.3), Math.atan2(-p.x, -p.z), -hopTilt * 3 + 0.04 * Math.sin(t * 1.7), 'YXZ');

    const n = this.rim.length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + t * 1.6;
      this.rim[i].position.set(Math.cos(a) * 17.6, 0, Math.sin(a) * 17.6);
      const chase = 0.25 + 0.75 * Math.pow(0.5 + 0.5 * Math.sin(t * 9 - i * 1.9), 3);
      this.rim[i].material.color.copy(this.palette[i % 3]).multiplyScalar(chase * fade);
    }
    const beam = this.beamLevel();
    this.beamMat.uniforms.uI.value = beam * (0.85 + 0.15 * Math.sin(t * 37)) * fade;
    this.beamMat.uniforms.uTime.value = t;
    this.beam.visible = beam > 0;
    this.under.material.color.setRGB(0.3, 1.2, 0.9).multiplyScalar((0.5 + beam) * fade * (0.9 + 0.1 * Math.sin(t * 5)));
    (this.dome.material as THREE.MeshBasicMaterial).color.setRGB(0.25, 0.9, 1.1).multiplyScalar(mix(0.6, 1.3, 0.5 + 0.5 * Math.sin(t * 2.3)) * fade);
    this.body.visible = fade > 0.02;
    this.dome.visible = this.body.visible;
  }

  /** 0..1 tractor beam intensity right now */
  beamLevel() {
    const b = this.beamOn, t = this.t;
    return b ? smoothstep(b[0], b[0] + 0.4, t) * (1 - smoothstep(b[1] - 0.3, b[1], t)) : 0;
  }

  dispose() {
    this.group.remove(this.obj);
    (this.body.material as THREE.Material).dispose();
    (this.dome.material as THREE.Material).dispose();
    this.beamMat.dispose();
    for (const s of [...this.rim, this.under]) s.material.dispose();
  }
}

/* --------------------------------------------------------------- abduction */

/** UFO hover height above the cow (m). */
const BEAM_HEIGHT = 60;
/** Cows are drawn larger than life so they read from a few hundred metres away. */
const COW_SCALE = 4;

/** Blocky low-poly cow, ~2.3 m long (before COW_SCALE), facing +X, feet at y=0. */
function cowMesh() {
  const g = new THREE.Group();
  const white = new THREE.MeshLambertMaterial({ color: 0xe8e4dc, emissive: 0x000000 });
  const black = new THREE.MeshLambertMaterial({ color: 0x141414, emissive: 0x000000 });
  const pink = new THREE.MeshLambertMaterial({ color: 0xd99a9a, emissive: 0x000000 });
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    g.add(b);
    return b;
  };
  box(1.7, 0.85, 0.85, 0, 1.15, 0, white);              // body
  box(0.6, 0.87, 0.87, -0.25, 1.15, 0, black);          // patch
  box(0.35, 0.5, 0.88, 0.55, 1.3, 0, black);            // patch
  const head = new THREE.Group();
  head.position.set(0.95, 1.4, 0);
  g.add(head);
  const hb = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    b.position.set(x, y, z);
    head.add(b);
  };
  hb(0.55, 0.45, 0.5, 0.2, 0, 0, white);                // head
  hb(0.2, 0.3, 0.44, 0.52, -0.08, 0, pink);             // muzzle
  hb(0.08, 0.16, 0.08, 0.05, 0.3, 0.18, white);         // horns
  hb(0.08, 0.16, 0.08, 0.05, 0.3, -0.18, white);
  hb(0.1, 0.12, 0.22, 0.0, 0.12, 0.33, black);          // ears
  hb(0.1, 0.12, 0.22, 0.0, 0.12, -0.33, black);
  const legs: THREE.Mesh[] = [];
  for (const [x, z] of [[0.6, 0.28], [0.6, -0.28], [-0.6, 0.28], [-0.6, -0.28]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.75, 0.18).translate(0, -0.375, 0), white);
    leg.position.set(x, 0.75, z);
    g.add(leg);
    legs.push(leg);
  }
  box(0.08, 0.6, 0.08, -0.88, 1.15, 0, black).rotation.z = -0.3; // tail
  return { g, head, legs, mats: [white, black, pink] };
}

/**
 * A cow grazes in a field ahead of the car... until a saucer parks above it
 * and beams it up. Everything is anchored in the world, so the car drives
 * towards the scene while it happens.
 */
class Abduction implements SkyEvent {
  kind: SkyEventKind = 'ufo';
  done = false;
  private t = 0;
  private tGraze = rr(4, 6.5);
  private ufo: Ufo | null = null;
  private cow = cowMesh();
  private glow = glowSprite(false);
  private yaw = rr(0, TAU);
  /** beam on / lift start / lift end / beam off, in UFO time */
  private tl = { beam: 0.6, lift0: 1.6, lift1: 6.2, off: 6.7, hover: 7.4 };

  constructor(
    private group: THREE.Group, private heading: number, private clear: (p: THREE.Vector3) => boolean,
    private ctx: SkyCtx, private ground: THREE.Vector3,
  ) {
    this.cow.g.scale.setScalar(COW_SCALE);
    this.cow.g.rotation.y = this.yaw;
    this.glow.scale.setScalar(10 * COW_SCALE);
    this.glow.visible = false;
    group.add(this.cow.g, this.glow);
    this.update(0);
  }

  /** Total duration from spawn until the cow is gone (for choosing a spot far enough ahead). */
  static readonly COW_TIME = 6.5 + 2.2 + 6.2;

  update(dt: number) {
    this.t += dt;
    const c = this.cow;
    c.g.position.subVectors(this.ground, this.ctx.camAbs);

    if (!this.ufo && this.t >= this.tGraze) {
      this.ufo = new Ufo(this.group, this.heading, this.clear, this.ctx, {
        anchor: this.ground.clone().add(new THREE.Vector3(0, BEAM_HEIGHT, 0)),
        scale: 1,
        hover: this.tl.hover,
        beam: [2.2 + this.tl.beam, 2.2 + this.tl.off],
      });
    }
    const ut = this.ufo ? this.ufo.t - this.ufo.tEnter : -100; // time since the saucer arrived (finite: feeds sin())
    const beam = this.ufo ? this.ufo.beamLevel() : 0;

    // grazing: head down most of the time, looks up when the saucer arrives
    const look = smoothstep(-1.5, -0.5, ut);
    c.head.rotation.z = mix(-0.55 + 0.12 * Math.sin(this.t * 2.2) * Math.max(0, Math.sin(this.t * 0.7)), 0.35, look);

    // lift: slow start, accelerating into the saucer, spinning and kicking its legs
    const k = smoothstep(this.tl.lift0, this.tl.lift1, ut);
    const up = k * k * (BEAM_HEIGHT - 1.6 * COW_SCALE);
    c.g.position.y += up;
    c.g.rotation.set(0.5 * k * Math.sin(ut * 1.3), this.yaw + k * k * 9, 0.35 * k * Math.sin(ut * 1.7 + 1), 'YXZ');
    for (let i = 0; i < c.legs.length; i++) c.legs[i].rotation.z = k > 0 ? 0.5 * Math.sin(ut * 9 + i * 1.7) : 0;
    c.g.scale.setScalar(COW_SCALE * (1 - smoothstep(0.88, 1, k)));
    c.g.visible = k < 1;

    // beamed cows glow
    // (+ a little moonlight on the white parts so it reads at night)
    // (black patches stay black so the cow keeps its pattern against the beam)
    c.mats.forEach((m, i) => m.emissive.setRGB(0.2, 0.24, 0.22).multiplyScalar(i === 1 ? 0 : beam).addScalar(i === 0 ? 0.05 : 0));
    this.glow.visible = beam > 0 && k < 1;
    this.glow.position.copy(c.g.position).y += 1.2 * COW_SCALE;
    this.glow.material.color.setRGB(0.4, 1.4, 1.0).multiplyScalar(beam * 0.12);

    if (this.ufo) {
      this.ufo.update(dt);
      this.done = this.ufo.done;
    }
  }

  dispose() {
    this.ufo?.dispose();
    this.group.remove(this.cow.g, this.glow);
    this.cow.g.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
    for (const m of this.cow.mats) m.dispose();
    this.glow.material.dispose();
  }
}

/* ----------------------------------------------------------------- manager */

/** Share of UFO visits that come for a cow (if a visible spot is found). */
const ABDUCTION_CHANCE = 0.5;

export class SkyEvents {
  readonly group = new THREE.Group();
  private events: SkyEvent[] = [];
  private timers = {} as Record<SkyEventKind, number>;
  private p!: ScenePreset;
  private heading = 0;
  private ray = new THREE.Raycaster();
  private dir = new THREE.Vector3();
  private ctx: SkyCtx = { camAbs: new THREE.Vector3() };

  /**
   * @param rate global frequency multiplier (0 disables random spawns)
   * @param world terrain queries (UFOs avoid hills, cows stand on them); optional
   */
  constructor(preset: ScenePreset, private rate = 1, private world?: SkyWorld) {
    this.setPreset(preset);
  }

  /** Line of sight from the camera to a group-local point. */
  private lineOfSight = (p: THREE.Vector3) => {
    if (!this.world) return true;
    const d = p.length();
    this.ray.set(this.group.position, this.dir.copy(p).divideScalar(d));
    this.ray.far = d;
    return this.world.terrainHit(this.ray) >= d;
  };

  setPreset(p: ScenePreset) {
    this.p = p;
    this.clear();
    for (const k of skyEventKinds) this.timers[k] = this.interval(k);
  }

  private presetRate(k: SkyEventKind) {
    const e = this.p.skyEvents;
    return { meteor: e.meteors, shower: e.meteors, satellite: e.satellites, plane: e.planes, ufo: e.ufos, timecar: e.timecars }[k] * this.rate;
  }

  private interval(k: SkyEventKind) {
    const r = this.presetRate(k);
    return r > 0 ? Math.max(4, expRand(MEAN_INTERVAL[k] / r)) : Infinity;
  }

  clear() {
    for (const e of this.events) e.dispose();
    this.events = [];
  }

  /**
   * Find a field next to the road far enough ahead that the car won't pass it
   * before the cow is gone, where both the cow and the saucer above it are in view.
   */
  private cowSpot(): THREE.Vector3 | null {
    const w = this.world;
    if (!w) return null;
    const ahead = w.speed() * (Abduction.COW_TIME + 1) + 170;
    if (ahead > 900) return null; // terrain is only built ~1100 m ahead
    const local = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      const g = w.groundAhead(ahead + rr(-40, 60), (rand() < 0.5 ? -1 : 1) * rr(28, 70));
      if (!g) continue;
      local.subVectors(g, this.ctx.camAbs);
      const cowOk = this.lineOfSight(local.clone().setY(local.y + 2.5 * COW_SCALE));
      const ufoOk = this.lineOfSight(local.clone().setY(local.y + BEAM_HEIGHT - 4));
      if (cowOk && ufoOk) return g;
    }
    return null;
  }

  /**
   * Spawn an event right now (debug / console). 'ufo' picks a cow abduction or a
   * sightseeing visit; 'abduction' / 'flyby' force one of them.
   */
  spawn(kind: SkyEventKind | 'abduction' | 'flyby' | 'departure' | 'arrival') {
    const h = this.heading;
    const g = this.group;
    let e: SkyEvent;
    if (kind === 'meteor') e = randomMeteor(g, h);
    else if (kind === 'shower') e = new Shower(g, h);
    else if (kind === 'satellite') e = new Satellite(g, h);
    else if (kind === 'plane') e = new Plane(g, h);
    else if (kind === 'timecar' || kind === 'departure' || kind === 'arrival') {
      if (!this.world) return null;
      const mode: TimeCarMode = kind === 'departure' ? 'depart' : kind === 'arrival' ? 'arrive' : rand() < 0.5 ? 'depart' : 'arrive';
      e = new TimeCar(g, this.ctx, this.world, mode);
    } else {
      const spot = kind === 'flyby' || (kind === 'ufo' && rand() >= ABDUCTION_CHANCE) ? null : this.cowSpot();
      e = spot ? new Abduction(g, h, this.lineOfSight, this.ctx, spot) : new Ufo(g, h, this.lineOfSight, this.ctx);
      if (kind === 'abduction' && !spot) console.info('[sky] no visible field for a cow right now, sending a sightseeing UFO');
    }
    this.events.push(e);
    return e instanceof Abduction ? 'abduction' : e instanceof TimeCar ? `timecar (${e.mode})` : e.kind;
  }

  /**
   * @param camPos camera position (render space)
   * @param heading current road heading (events spawn in front of it)
   * @param origin floating origin (render space = absolute - origin)
   */
  update(dt: number, camPos: THREE.Vector3, heading: number, origin: THREE.Vector3) {
    this.group.position.copy(camPos);
    this.ctx.camAbs.addVectors(camPos, origin);
    this.heading = heading;
    if (dt <= 0) return;
    for (const k of skyEventKinds) {
      this.timers[k] -= dt;
      if (this.timers[k] > 0) continue;
      this.timers[k] = this.interval(k);
      if (SINGLETON.has(k) && this.events.some(e => e.kind === k)) continue;
      this.spawn(k);
    }
    for (const e of this.events) e.update(dt);
    if (this.events.some(e => e.done)) {
      this.events = this.events.filter(e => (e.done ? (e.dispose(), false) : true));
    }
  }
}

import * as THREE from 'three';
import type { HDR, ScenePreset } from '../scenes/types';
import { liveCanvas } from '../util/textures';
import { clamp } from '../util/math';
import { Radio } from './Radio';
import { DASH_H, DASH_TEX_SCALE, DASH_W, SPEED_H, SPEED_TEX_SCALE, SPEED_W, dashBars, dashBarsMaterial, dashKey, drawDigitalDash, drawSpeedReadout } from './digitalDash';
import { Windshield } from './Windshield';
import { mergeStatic } from '../util/mergeStatic';

export type PodSwitch = 'wipe' | 'wash' | 'info' | 'dim';
const WIPER_REST = -0.04;
/** how much DIM takes off the dashboard / head unit backlight */
const DASH_DIM = 0.55;

/**
 * Portrait layout (narrow screens): the cluster doesn't fit next to the radio, so it is
 * replaced by a compact speed readout, with the switch pod beside it, the radio centred
 * below and the wheel lowered so its rim only frames the bottom edge.
 * Position / rotation (camera space) and uniform scale per module.
 */
type Vec3 = [number, number, number];
const PORTRAIT: Record<'speed' | 'podR' | 'radio' | 'wheel' | 'spill', { p: Vec3; r: Vec3; s: number }> = {
  speed: { p: [-0.07, -0.375, -1.04], r: [-0.12, 0, 0], s: 1 },
  podR: { p: [0.19, -0.38, -1.03], r: [-0.15, -0.12, 0], s: 1.15 },
  radio: { p: [0, -0.59, -1.064], r: [-0.22, 0, 0], s: 0.9 },
  wheel: { p: [0, -0.64, -0.6], r: [-0.33, 0, 0], s: 1 },
  spill: { p: [0, -0.45, -0.95], r: [0, 0, 0], s: 1 },
};

export interface DriveState {
  t: number;
  speedKmh: number;
  rpm: number; // 0..1
  steer: number; // radians of wheel rotation
  odoKm: number;
}

/**
 * The car interior, parented to the camera (camera space: -Z forward, metres).
 * Layout tuned for vfov ≈ 52°: dash top ~75% down the screen, wheel left of centre.
 */
export class Cockpit {
  readonly group = new THREE.Group();
  readonly radio: Radio;
  private wheelSpin = new THREE.Group();
  private cluster = liveCanvas(Math.round(DASH_W * DASH_TEX_SCALE), Math.round(DASH_H * DASH_TEX_SCALE));
  private lastDraw = -1;
  private dashShown = '';
  /** lit tach / boost segments over the dash canvas (updated every frame) */
  private bars = dashBarsMaterial();
  private rimMat: THREE.MeshBasicMaterial;
  private rimDash!: THREE.Mesh;
  private rimWheel!: THREE.Mesh;
  private lights: THREE.PointLight[] = [];
  /** clickable pod switches (userData.pod = 'wipe' | 'info') with their flash level */
  private podSwitches = new Map<PodSwitch, { mesh: THREE.Mesh; flash: number; on: boolean }>();
  private pods: { side: number; pc: ReturnType<typeof liveCanvas> }[] = [];
  private podGlowKey = '';
  /** windshield wipers: pivots + sweep animation time (−1 = idle) */
  private wipers: THREE.Group[] = [];
  private wipeT = -1;
  private wipePause = 0;
  /** sweeps still to run after the rain was switched off (clears the last drops) */
  private finalSweeps = 0;
  private wiperAngle = WIPER_REST;
  readonly windshield = new Windshield();
  /** DIM switch: night mode (dim sky, softer street lights, dimmed dash, no sky events) */
  dimmed = false;
  /** self-lit dash materials with their undimmed colours (collected on first use) */
  private dimMats: { m: THREE.MeshBasicMaterial; base: THREE.Color }[] | null = null;
  private dimLevel = 0;
  private fillIntensity = 1;
  /** rain switched on (WIPE), and the smoothed 0..1 intensity */
  raining = false;
  rain = 0;

  /* layout modules that move between the wide and the portrait layout (see setLayout) */
  private clusterG = new THREE.Group();
  private podR = new THREE.Group();
  private wheelPivot = new THREE.Group();
  private speedG = new THREE.Group();
  private speedCanvas = liveCanvas(Math.round(SPEED_W * SPEED_TEX_SCALE), Math.round(SPEED_H * SPEED_TEX_SCALE));
  private speedShown = -1;
  private wideLayout = new Map<THREE.Object3D, { p: THREE.Vector3; r: THREE.Euler; s: THREE.Vector3 }>();
  /** portrait layout: no instrument cluster, just a speed readout above the radio + switches */
  portrait = false;

  /** Everything in the cockpit that reacts to clicks. */
  get interactive(): THREE.Object3D[] {
    return [...this.radio.interactive, ...[...this.podSwitches.values()].map(s => s.mesh)];
  }

  /** Short glow feedback when a pod switch is pressed. */
  flashSwitch(name: PodSwitch) { const s = this.podSwitches.get(name); if (s) s.flash = 1; }

  /** One full wiper sweep (up and back), ~1.5 s — used by WASH. */
  wipe() { if (this.wipeT < 0) this.wipeT = 0; }

  /** DIM switch: toggle night mode. */
  toggleDim() {
    this.dimmed = !this.dimmed;
    const sw = this.podSwitches.get('dim');
    if (sw) sw.on = this.dimmed;
    return this.dimmed;
  }

  /** WIPE switch: toggle rain (wipers run continuously while it rains). */
  toggleRain() {
    this.raining = !this.raining;
    const sw = this.podSwitches.get('wipe');
    if (sw) sw.on = this.raining;
    if (this.raining) this.wipe();
    else this.finalSweeps = this.wipeT >= 0 ? 2 : 1; // finish the current sweep + one more
  }

  constructor(preset: ScenePreset) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x14151c, roughness: 0.5, metalness: 0.25, fog: false });
    this.rimMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    const g = this.group;

    /* dashboard slab: front-view profile extruded towards the windshield */
    const topY = (x: number) => -0.3 - 0.012 * x - 0.01 * Math.cos(x * 1.6);
    const FZ = -1.1; // fascia plane
    const shape = new THREE.Shape();
    shape.moveTo(-2.4, -1.4);
    for (let x = -2.4; x <= 2.4 + 1e-6; x += 0.1) shape.lineTo(x, topY(x));
    shape.lineTo(2.4, -1.4);
    shape.closePath();
    const dash = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.3, bevelEnabled: false, curveSegments: 1 }), mat);
    dash.position.z = FZ - 0.3;
    g.add(dash);

    /* angular 80s instrument binnacle with overhanging visor lip */
    const CX = -0.25;                    // cluster centre x
    const hy = topY(CX) - 0.005;
    const hood = new THREE.Shape();
    hood.moveTo(-0.35, 0); hood.lineTo(-0.31, 0.07); hood.lineTo(0.31, 0.07); hood.lineTo(0.35, 0);
    hood.lineTo(-0.35, 0);
    const hoodMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(hood, { depth: 0.36, bevelEnabled: false }), mat);
    hoodMesh.position.set(CX, hy, FZ - 0.3);
    const cg = this.clusterG; // everything that belongs to the cluster (hidden in the portrait layout)
    g.add(cg);
    cg.add(hoodMesh);
    // dark inner face below the lip so the cluster sits in shadow
    const visor = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.075), new THREE.MeshBasicMaterial({ color: 0x010102, fog: false }));
    visor.position.set(CX, hy + 0.035, FZ + 0.0605);
    cg.add(visor);
    // neon accent line along the visor lip
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.0025, 0.003), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.85, 1.2), fog: false }));
    lip.position.set(CX, hy + 0.069, FZ + 0.062);
    cg.add(lip);
    // binnacle side cheeks connecting hood to fascia
    for (const side of [-1, 1]) {
      const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.2, 0.065), mat);
      cheek.position.set(CX + side * 0.34, hy - 0.06, FZ + 0.03);
      cg.add(cheek);
    }

    /* satellite switch pods either side of the cluster */
    for (const side of [-1, 1]) {
      const pod = side > 0 ? this.podR : new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.13, 0.09), mat);
      pod.add(body);
      const pc = liveCanvas(136, 240);
      drawPod(pc.ctx, side, {});
      pc.tex.needsUpdate = true;
      this.pods.push({ side, pc });
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.068, 0.12), new THREE.MeshBasicMaterial({ map: pc.tex, fog: false }));
      face.position.z = 0.0455;
      pod.add(face);
      {
        // clickable rockers (right pod): WIPE, WASH, INFO, DIM
        const rockers = side > 0 ? [['wipe', 0.042], ['wash', 0.014], ['info', -0.014], ['dim', -0.042]] as const : [] as const;
        for (const [name, y] of rockers) {
          const hit = new THREE.Mesh(
            new THREE.PlaneGeometry(0.054, 0.024),
            new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, fog: false }),
          );
          hit.position.set(0, y, 0.0465);
          hit.visible = false; // click target only: raycasting ignores visibility, rendering skips it
          hit.userData.pod = name;
          pod.add(hit);
          this.podSwitches.set(name, { mesh: hit, flash: 0, on: false });
        }
      }
      pod.position.set(CX + side * 0.39, hy - 0.08, FZ + 0.07);
      pod.rotation.set(-0.15, -side * 0.38, 0);
      (side > 0 ? g : cg).add(pod);
    }

    /* windshield wipers, parked just below the dash line */
    const wiperMat = new THREE.MeshLambertMaterial({ color: 0x030304, fog: false });
    for (const px of [-0.75, 0.15]) {
      const pivot = new THREE.Group();
      pivot.position.set(px, topY(px) - 0.025, FZ - 0.32);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.012, 0.01), wiperMat);
      arm.position.x = 0.39;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.02, 0.012), wiperMat);
      blade.position.set(0.42, 0.016, 0.004);
      pivot.add(arm, blade);
      pivot.rotation.z = WIPER_REST;
      g.add(pivot);
      this.wipers.push(pivot);
    }
    this.windshield.mesh.userData.noDim = true; // rain on the glass shows the outside, not the dash
    g.add(this.windshield.mesh);

    /* rim highlight along the far edge of the dash (reflected neon) */
    const pts: THREE.Vector3[] = [];
    for (let x = -2.4; x <= 2.4 + 1e-6; x += 0.1) pts.push(new THREE.Vector3(x, topY(x) + 0.002, FZ - 0.298));
    this.rimDash = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 96, 0.0022, 4), this.rimMat);
    g.add(this.rimDash);

    /* instrument cluster (live canvas) */
    const clusterMat = new THREE.MeshBasicMaterial({ map: this.cluster.tex, fog: false, color: new THREE.Color(1.0, 1.0, 1.0) });
    const cl = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6 * DASH_H / DASH_W), clusterMat);
    const bars = new THREE.Mesh(cl.geometry, this.bars);
    bars.position.z = 0.0004; // just in front of the canvas, behind the smoked glass
    cl.add(bars);
    cl.position.set(CX, hy - 0.006 - 0.1, FZ + 0.003);
    cg.add(cl);
    // smoked glass over the cluster; not mirror-smooth: at low roughness the cluster-spill
    // light (right in front of it) reflects as a one-pixel orange dot in the tach
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.22), new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.35, metalness: 1, transparent: true, opacity: 0.22, fog: false }));
    glass.position.set(CX, hy - 0.115, FZ + 0.014);
    glass.rotation.x = -0.12;
    cg.add(glass);

    /* portrait layout: compact speed readout in a small hooded housing (see setLayout) */
    {
      const sg = this.speedG;
      const SW = 0.3, SH = SW * SPEED_H / SPEED_W;
      const housing = new THREE.Mesh(new THREE.BoxGeometry(SW + 0.03, SH + 0.03, 0.06), mat);
      housing.position.z = -0.03;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), new THREE.MeshBasicMaterial({ map: this.speedCanvas.tex, fog: false }));
      face.position.z = 0.0005;
      const roof = new THREE.Mesh(new THREE.BoxGeometry(SW + 0.05, 0.012, 0.075), mat);
      roof.position.set(0, SH / 2 + 0.021, 0.0075);
      const neon = new THREE.Mesh(new THREE.BoxGeometry(SW + 0.05, 0.0025, 0.003), lip.material);
      neon.position.set(0, SH / 2 + 0.015, 0.0455);
      sg.add(housing, face, roof, neon);
      sg.visible = false;
      g.add(sg);
    }

    /* radio */
    // centre-console radio, tilted up towards the driver
    this.radio = new Radio();
    this.radio.group.position.set(0.47, -0.405, FZ + 0.036);
    this.radio.group.rotation.x = -0.22;
    this.radio.group.scale.setScalar(0.9);
    g.add(this.radio.group);

    /* vents */
    const vent = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.02), new THREE.MeshStandardMaterial({ color: 0x0a0b10, roughness: 0.8, fog: false }));
    for (const x of [0.8, 1.05]) { const v = vent.clone(); v.position.set(x, -0.36, FZ + 0.01); g.add(v); }

    /* steering wheel */
    const pivot = this.wheelPivot;
    pivot.position.set(-0.215, -0.3, -0.56);
    pivot.rotation.x = -0.33;
    pivot.add(this.wheelSpin);
    g.add(pivot);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0b0c10, roughness: 0.65, metalness: 0.1, fog: false });
    this.wheelSpin.add(new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.017, 16, 96), wheelMat));
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.05, 24).rotateX(Math.PI / 2), wheelMat);
    hub.position.z = -0.03;
    this.wheelSpin.add(hub);
    for (const a of [0, Math.PI, -Math.PI / 2]) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.035, 0.02), wheelMat);
      sp.position.set(Math.cos(a) * 0.12, Math.sin(a) * 0.12, -0.012);
      sp.rotation.z = a;
      this.wheelSpin.add(sp);
    }
    this.rimWheel = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.0035, 6, 64, Math.PI * 0.7), this.rimMat);
    this.rimWheel.rotation.z = Math.PI * 0.15;
    this.rimWheel.position.set(0, 0.012, 0.008);
    this.wheelSpin.add(this.rimWheel);

    /* A-pillar, roof */
    const pillar = (a: THREE.Vector3, b: THREE.Vector3, w: number) => {
      const len = a.distanceTo(b);
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.07), mat);
      m.position.copy(a).add(b).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      g.add(m);
    };
    pillar(new THREE.Vector3(-0.74, -0.3, -1.38), new THREE.Vector3(-0.84, 0.56, -1.0), 0.13);
    pillar(new THREE.Vector3(1.32, -0.33, -1.38), new THREE.Vector3(1.45, 0.56, -1.0), 0.13);
    // matte fabric headliner: no specular, so the interior lights don't paint a band on it
    const roof = new THREE.Mesh(new THREE.BoxGeometry(4, 0.05, 1.7), new THREE.MeshLambertMaterial({ color: 0x050508, fog: false }));
    roof.position.set(0, 0.53, -0.3);
    g.add(roof);

    /* interior lighting: only reaches a few metres -> doesn't light the world */
    const mk = (c: THREE.ColorRepresentation, i: number, d: number, p: [number, number, number]) => {
      const l = new THREE.PointLight(c, i, d, 1.5);
      l.position.set(...p);
      g.add(l);
      this.lights.push(l);
    };
    mk(0xff6a2a, 0.35, 2.6, [-0.6, 0.1, -1.9]);   // neon road edges, left
    mk(0x6a8cff, 0.25, 2.6, [0.5, 0.3, -1.9]);     // street lamps
    mk(0xff6a2a, 0.35, 2.6, [1.4, 0.0, -1.9]);     // neon road edges, right
    mk(0xffa040, 0.08, 0.6, [-0.24, -0.4, -0.95]); // cluster spill

    // one draw per material for everything that never moves (~100 meshes -> a few dozen draws);
    // the rim keeps its own geometry: setPreset rewrites its vertex colours
    // (the layout modules are merged within themselves, so they can still be moved as a whole)
    const modules = [this.clusterG, this.podR, this.radio.group, this.speedG];
    mergeStatic(g, [this.wheelPivot, ...this.wipers, ...modules, this.rimDash]);
    for (const m of modules) mergeStatic(m, [...this.interactive, ...this.radio.animated]);
    // ... and within the parts that move as a whole (wheel rim highlight: vertex colours, see above)
    mergeStatic(this.wheelSpin, [this.rimWheel]);
    for (const o of [this.speedG, this.podR, this.radio.group, this.wheelPivot, this.lights[3]]) {
      this.wideLayout.set(o, { p: o.position.clone(), r: o.rotation.clone(), s: o.scale.clone() });
    }
    for (const w of this.wipers) mergeStatic(w, []);

    this.setPreset(preset);
  }

  /** Switch between the wide layout (cluster left, radio right) and the portrait one (see PORTRAIT). */
  setLayout(portrait: boolean) {
    if (portrait === this.portrait) return;
    this.portrait = portrait;
    this.clusterG.visible = !portrait;
    this.speedG.visible = portrait;
    this.speedShown = -1;
    const mods: [THREE.Object3D, (typeof PORTRAIT)['speed']][] = [
      [this.speedG, PORTRAIT.speed], [this.podR, PORTRAIT.podR], [this.radio.group, PORTRAIT.radio],
      [this.wheelPivot, PORTRAIT.wheel], [this.lights[3], PORTRAIT.spill],
    ];
    for (const [o, l] of mods) {
      if (portrait) {
        o.position.set(...l.p);
        o.rotation.set(...l.r);
        o.scale.setScalar(l.s);
      } else {
        const w = this.wideLayout.get(o)!;
        o.position.copy(w.p);
        o.rotation.copy(w.r);
        o.scale.copy(w.s);
      }
    }
  }

  /** Rain, droplets and wipers (wall-clock time, also runs while paused). */
  updateWeather(dt: number, speed: number) {
    // rain builds up slowly, but stops quickly when switched off
    this.rain += ((this.raining ? 1 : 0) - this.rain) * Math.min(1, dt * (this.raining ? 0.6 : 2.5));
    // wipers: continuous cycle while raining (short pause at rest); after switching off
    // they keep going for a final sweep or two to clear the remaining drops
    if (this.wipeT < 0 && (this.raining || this.finalSweeps > 0)) {
      this.wipePause -= dt;
      if (this.wipePause <= 0) this.wipeT = 0;
    }
    let ang = WIPER_REST;
    if (this.wipeT >= 0) {
      this.wipeT += dt;
      const D = 1.5, k = Math.min(1, this.wipeT / D);
      const a = Math.sin(k * Math.PI); // up and back
      ang = WIPER_REST + 1.7 * (a * a * (3 - 2 * a));
      if (k >= 1) {
        this.wipeT = -1; this.wipePause = 0.6; ang = WIPER_REST;
        if (!this.raining && this.finalSweeps > 0) { this.finalSweeps--; this.wipePause = 0.3; }
      }
    }
    for (const w of this.wipers) {
      w.rotation.z = ang;
      this.windshield.sweep(w.position.x, w.position.y, this.wiperAngle, ang, 0.08, 0.82);
    }
    this.wiperAngle = ang;
    // no new drops once the rain is switched off
    this.windshield.update(dt, this.raining ? this.rain : 0, speed);
  }

  setPreset(p: ScenePreset) {
    const grad = (geo: THREE.BufferGeometry, a: HDR, b: HDR, axis: 'x' | 'angle') => {
      const pos = geo.getAttribute('position');
      const arr = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        let k: number;
        if (axis === 'x') k = clamp(Math.abs(pos.getX(i)) / 1.6, 0, 1);
        else k = 1 - Math.abs(Math.sin(Math.atan2(pos.getY(i), pos.getX(i)) - Math.PI * 0.35));
        k = Math.pow(k, 1.5);
        for (let c = 0; c < 3; c++) arr[i * 3 + c] = b[c] + (a[c] - b[c]) * k;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    };
    grad(this.rimDash.geometry, p.cockpit.rimA, p.cockpit.rimB, 'x');
    grad(this.rimWheel.geometry, p.cockpit.rimB, p.cockpit.rimA, 'angle');
    this.lights[0].color.set(p.cockpit.fill);
    this.lights[2].color.set(p.cockpit.fill);
    this.fillIntensity = p.cockpit.fillIntensity;
    this.applyLights();
  }

  /** Interior light levels; the street-lamp spill and the cluster spill follow the DIM switch. */
  private applyLights() {
    const d = this.dimLevel, f = this.fillIntensity;
    this.lights[0].intensity = 0.35 * f;
    this.lights[1].intensity = 0.25 * f * (1 - 0.35 * d);
    this.lights[2].intensity = 0.35 * f;
    this.lights[3].intensity = 0.08 * (1 - DASH_DIM * d);
  }

  /** DIM switch, eased 0..1: dims the instrument cluster, switch pods and head unit. */
  setDim(d: number) {
    if (!this.dimMats) {
      const mats = new Map<THREE.MeshBasicMaterial, THREE.Color>();
      this.group.traverse(o => {
        if (o.userData.noDim) return;
        const m = (o as THREE.Mesh).material;
        for (const mm of Array.isArray(m) ? m : m ? [m] : []) {
          // self-lit surfaces only; radio LEDs are rewritten every frame (Radio.brightness)
          if (mm instanceof THREE.MeshBasicMaterial && mm.colorWrite && !mm.userData.dynamic && !mats.has(mm)) mats.set(mm, mm.color.clone());
        }
      });
      this.dimMats = [...mats].map(([m, base]) => ({ m, base }));
    }
    this.dimLevel = d;
    const k = 1 - DASH_DIM * d;
    for (const { m, base } of this.dimMats) m.color.copy(base).multiplyScalar(k);
    this.radio.brightness = k;
    this.bars.uniforms.uBright.value = k;
    this.applyLights();
  }

  update(s: DriveState) {
    this.wheelSpin.rotation.z = s.steer;
    // pressed / active switches: label glows red (momentary flash or latched while on)
    const glow: Record<string, number> = {};
    for (const [name, sw] of this.podSwitches) {
      sw.flash = Math.max(0, sw.flash - 0.03);
      glow[name.toUpperCase()] = Math.max(sw.on ? 1 : 0, Math.min(1, sw.flash * 1.5));
    }
    const key = Object.values(glow).map(v => v.toFixed(2)).join();
    if (key !== this.podGlowKey) {
      this.podGlowKey = key;
      for (const { side, pc } of this.pods) {
        drawPod(pc.ctx, side, glow);
        pc.tex.needsUpdate = true;
      }
    }
    if (this.portrait) {
      // the compact readout only shows the speed
      const v = Math.round(s.speedKmh);
      if (v !== this.speedShown && s.t - this.lastDraw >= 1 / 20) {
        this.speedShown = v;
        this.lastDraw = s.t;
        drawSpeedReadout(this.speedCanvas.ctx, v);
        this.speedCanvas.tex.needsUpdate = true;
      }
      return;
    }
    const b = dashBars(s);
    this.bars.uniforms.uTach.value = b.tach;
    this.bars.uniforms.uBoost.value = b.boost;
    // a real digital dash updates slower than this; redraw + upload only when something visible changed
    if (s.t - this.lastDraw >= 1 / 20) {
      const key = dashKey(s);
      if (key !== this.dashShown) {
        this.dashShown = key;
        this.lastDraw = s.t;
        drawDigitalDash(this.cluster.ctx, s);
        this.cluster.tex.needsUpdate = true;
      }
    }
  }
}

/**
 * Backlit rocker-switch panel for the satellite pods.
 * `glow` maps label -> 0..1: pressed/active labels glow red.
 */
function drawPod(x: CanvasRenderingContext2D, side: number, glow: Record<string, number>) {
  const c = x.canvas;
  x.fillStyle = '#0d0e13'; x.fillRect(0, 0, c.width, c.height);
  const labels = side < 0 ? ['HEAD', 'FOG', 'A/C', 'HAZ'] : ['WIPE', 'WASH', 'INFO', 'DIM'];
  labels.forEach((l, i) => {
    const y = 14 + i * 56;
    const gr = x.createLinearGradient(0, y, 0, y + 44);
    gr.addColorStop(0, '#2a2c35'); gr.addColorStop(1, '#121318');
    x.fillStyle = gr; x.fillRect(16, y, 104, 44);
    x.strokeStyle = 'rgba(120,180,255,0.35)'; x.lineWidth = 2; x.strokeRect(16, y, 104, 44);
    x.font = 'italic 700 20px "DejaVu Sans", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    const info = l === 'INFO';
    const g = glow[l] ?? 0;
    if (g > 0.01) {
      // red glowing legend
      x.shadowColor = `rgba(255,40,30,${0.95 * g})`;
      x.shadowBlur = 14 * g;
      x.fillStyle = `rgb(255,${Math.round(90 - 40 * g)},${Math.round(70 - 30 * g)})`;
      x.fillText(l, 68, y + 23);
      x.fillText(l, 68, y + 23); // second pass strengthens the glow
    } else {
      x.fillStyle = info ? 'rgb(110,255,180)' : (side > 0 && i < 2) || (side < 0 && i === 0) ? '#5fe8ff' : 'rgba(255,170,90,0.9)';
      if (info) { x.shadowColor = 'rgba(110,255,180,0.9)'; x.shadowBlur = 8; x.strokeStyle = 'rgba(110,255,180,0.6)'; x.strokeRect(16, y, 104, 44); }
      x.fillText(l, 68, y + 23);
    }
    x.shadowBlur = 0;
  });
}

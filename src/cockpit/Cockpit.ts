import * as THREE from 'three';
import type { HDR, ScenePreset } from '../scenes/types';
import { liveCanvas } from '../util/textures';
import { clamp } from '../util/math';
import { Radio } from './Radio';
import { DASH_H, DASH_W, drawDigitalDash } from './digitalDash';
import { Windshield } from './Windshield';

export type PodSwitch = 'wipe' | 'wash' | 'info';
const WIPER_REST = -0.04;

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
  private cluster = liveCanvas(DASH_W, DASH_H);
  private lastDraw = -1;
  private rimMat: THREE.MeshBasicMaterial;
  private rimDash!: THREE.Mesh;
  private rimWheel!: THREE.Mesh;
  private lights: THREE.PointLight[] = [];
  /** clickable pod switches (userData.pod = 'wipe' | 'info') with their flash level */
  private podSwitches = new Map<PodSwitch, { mesh: THREE.Mesh; flash: number; on: boolean }>();
  private rightPod!: ReturnType<typeof liveCanvas>;
  private podGlowKey = '';
  /** windshield wipers: pivots + sweep animation time (−1 = idle) */
  private wipers: THREE.Group[] = [];
  private wipeT = -1;
  private wipePause = 0;
  /** sweeps still to run after the rain was switched off (clears the last drops) */
  private finalSweeps = 0;
  private wiperAngle = WIPER_REST;
  readonly windshield = new Windshield();
  /** rain switched on (WIPE), and the smoothed 0..1 intensity */
  raining = false;
  rain = 0;

  /** Everything in the cockpit that reacts to clicks. */
  get interactive(): THREE.Object3D[] {
    return [...this.radio.interactive, ...[...this.podSwitches.values()].map(s => s.mesh)];
  }

  /** Short glow feedback when a pod switch is pressed. */
  flashSwitch(name: PodSwitch) { const s = this.podSwitches.get(name); if (s) s.flash = 1; }

  /** One full wiper sweep (up and back), ~1.5 s — used by WASH. */
  wipe() { if (this.wipeT < 0) this.wipeT = 0; }

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
    g.add(hoodMesh);
    // dark inner face below the lip so the cluster sits in shadow
    const visor = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.075), new THREE.MeshBasicMaterial({ color: 0x010102, fog: false }));
    visor.position.set(CX, hy + 0.035, FZ + 0.0605);
    g.add(visor);
    // neon accent line along the visor lip
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.0025, 0.003), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.85, 1.2), fog: false }));
    lip.position.set(CX, hy + 0.069, FZ + 0.062);
    g.add(lip);
    // binnacle side cheeks connecting hood to fascia
    for (const side of [-1, 1]) {
      const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.2, 0.065), mat);
      cheek.position.set(CX + side * 0.34, hy - 0.06, FZ + 0.03);
      g.add(cheek);
    }

    /* satellite switch pods either side of the cluster */
    for (const side of [-1, 1]) {
      const pod = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.13, 0.09), mat);
      pod.add(body);
      const pc = liveCanvas(136, 240);
      drawPod(pc.ctx, side, {});
      pc.tex.needsUpdate = true;
      if (side > 0) this.rightPod = pc;
      const face = new THREE.Mesh(new THREE.PlaneGeometry(0.068, 0.12), new THREE.MeshBasicMaterial({ map: pc.tex, fog: false }));
      face.position.z = 0.0455;
      pod.add(face);
      if (side > 0) {
        // clickable rockers: WIPE (1st) changes the scenery, INFO (3rd) opens the station website
        for (const [name, y] of [['wipe', 0.042], ['wash', 0.014], ['info', -0.014]] as const) {
          const hit = new THREE.Mesh(
            new THREE.PlaneGeometry(0.054, 0.024),
            new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, fog: false }),
          );
          hit.position.set(0, y, 0.0465);
          hit.userData.pod = name;
          pod.add(hit);
          this.podSwitches.set(name, { mesh: hit, flash: 0, on: false });
        }
      }
      pod.position.set(CX + side * 0.39, hy - 0.08, FZ + 0.07);
      pod.rotation.set(-0.15, -side * 0.38, 0);
      g.add(pod);
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
    g.add(this.windshield.mesh);

    /* rim highlight along the far edge of the dash (reflected neon) */
    const pts: THREE.Vector3[] = [];
    for (let x = -2.4; x <= 2.4 + 1e-6; x += 0.1) pts.push(new THREE.Vector3(x, topY(x) + 0.002, FZ - 0.298));
    this.rimDash = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 96, 0.0022, 4), this.rimMat);
    g.add(this.rimDash);

    /* instrument cluster (live canvas) */
    const clusterMat = new THREE.MeshBasicMaterial({ map: this.cluster.tex, fog: false, color: new THREE.Color(1.0, 1.0, 1.0) });
    const cl = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.6 * DASH_H / DASH_W), clusterMat);
    cl.position.set(CX, hy - 0.006 - 0.1, FZ + 0.003);
    g.add(cl);
    // smoked glass over the cluster
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.22), new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.05, metalness: 1, transparent: true, opacity: 0.22, fog: false }));
    glass.position.set(CX, hy - 0.115, FZ + 0.014);
    glass.rotation.x = -0.12;
    g.add(glass);

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
    const pivot = new THREE.Group();
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

    this.setPreset(preset);
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
    for (const l of this.lights.slice(0, 3)) l.intensity = (l === this.lights[1] ? 0.25 : 0.35) * p.cockpit.fillIntensity;
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
      drawPod(this.rightPod.ctx, 1, glow);
      this.rightPod.tex.needsUpdate = true;
    }
    if (s.t - this.lastDraw >= 1 / 30) {
      this.lastDraw = s.t;
      drawDigitalDash(this.cluster.ctx, s);
      this.cluster.tex.needsUpdate = true;
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
  const labels = side < 0 ? ['HEAD', 'FOG', 'DIM', 'HAZ'] : ['WIPE', 'WASH', 'INFO', 'A/C'];
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

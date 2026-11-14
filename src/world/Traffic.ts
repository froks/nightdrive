import * as THREE from 'three';
import type { HDR, ScenePreset } from '../scenes/types';
import { Track, makeFrame } from './Track';
import { additiveMaterial, colorize, glowSpriteMaterial, neonMaterial, stripAttrs } from '../util/materials';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rand } from '../util/math';

interface Car {
  obj: THREE.Group;
  s: number;
  L: number;
  v: number; // signed speed along track
  oncoming: boolean;
  /** the small lamp boxes: hidden at distance, where they'd be sub-pixel and flicker */
  lamps: THREE.Object3D;
}

/** beyond this distance only the (smooth) glow sprites are drawn, not the lamp boxes */
const LAMP_BOX_DIST = 55;

/** the car ahead: comes into view, follows a while, pulls away, stays gone a while */
type LeadState = 'away' | 'arriving' | 'following' | 'leaving';

const bodyMat = new THREE.MeshLambertMaterial({ color: 0x050508 });
const neonMat = neonMaterial();
const addMat = additiveMaterial();

/** Build a car facing -Z (local); lights at the front (head) or rear (tail). */
function carMesh(lights: HDR, front: boolean, glow: THREE.SpriteMaterial) {
  const g = new THREE.Group();
  const body = mergeGeometries([
    new THREE.BoxGeometry(1.8, 0.62, 4.3).translate(0, 0.55, 0),
    new THREE.BoxGeometry(1.55, 0.5, 2.2).translate(0, 1.1, 0.2),
  ]);
  g.add(new THREE.Mesh(body, bodyMat));
  const zl = front ? -2.16 : 2.16;
  const parts: THREE.BufferGeometry[] = [];
  const refl: THREE.BufferGeometry[] = [];
  for (const sx of [-0.62, 0.62]) {
    parts.push(stripAttrs(colorize(new THREE.BoxGeometry(front ? 0.32 : 0.45, front ? 0.14 : 0.12, 0.05).translate(sx, 0.68, zl), lights)));
    const spr = new THREE.Sprite(glow);
    spr.position.set(sx, 0.68, zl + (front ? -0.1 : 0.1));
    spr.scale.setScalar(front ? 4.5 : 2.2);
    g.add(spr);
    // reflection on the wet road, extending away from the lamp side
    const len = front ? 22 : 11, dir = front ? -1 : 1, w = 0.32, k = 0.05;
    const p = new THREE.PlaneGeometry(w, len).rotateX(-Math.PI / 2).translate(sx, 0.03, zl + dir * len / 2);
    refl.push(stripAttrs(colorize(p, [lights[0] * k, lights[1] * k, lights[2] * k], (_x, _y, z) => 1 - Math.min(1, Math.abs(z - zl) / len))));
  }
  const lamps = new THREE.Mesh(mergeGeometries(parts), neonMat);
  g.add(lamps);
  g.userData.lamps = lamps;
  const rm = new THREE.Mesh(mergeGeometries(refl), addMat);
  rm.renderOrder = 2;
  g.add(rm);
  return g;
}

export class Traffic {
  readonly group = new THREE.Group();
  private cars: Car[] = [];
  private lead!: Car;
  private leadState: LeadState = 'away';
  private leadTimer = 0;
  private leadGap = 160;
  private nextSpawn = 3;
  private frame = makeFrame();
  private tmp = new THREE.Vector3();
  private p!: ScenePreset;
  private headGlow = glowSpriteMaterial('#cfe0ff', 1.4);
  private tailGlow = glowSpriteMaterial('#ff2a3a', 1.2);

  constructor(private track: Track, preset: ScenePreset, pos: number) {
    this.setPreset(preset, pos);
  }

  setPreset(p: ScenePreset, pos: number) {
    this.p = p;
    for (const c of this.cars) this.group.remove(c.obj);
    this.cars = [];
    if (this.lead) this.group.remove(this.lead.obj);
    this.lead = this.makeCar(carMesh(p.traffic.taillight, false, this.tailGlow), pos + 160, 1.75, 30, false);
    this.group.add(this.lead.obj);
    // start with a car ahead about half the time
    if (rand() < 0.5) this.follow(pos, true);
    else this.goAway();
  }

  update(dt: number, pos: number, speed: number, t: number, origin: THREE.Vector3) {
    this.nextSpawn -= dt;
    if (this.nextSpawn <= 0) {
      this.nextSpawn = (4 + rand() * 14) / Math.max(0.1, this.p.traffic.density);
      const c = this.makeCar(carMesh(this.p.traffic.headlight, true, this.headGlow),
        pos + 1100, rand() < 0.7 ? -1.75 : -5.25, -(24 + rand() * 10), true);
      this.cars.push(c);
      this.group.add(c.obj);
    }
    for (const c of this.cars) c.s += c.v * dt;
    this.cars = this.cars.filter(c => {
      if (c.s - pos > -10) return true;
      this.group.remove(c.obj);
      return false;
    });

    const lead = this.lead;
    this.updateLead(lead, dt, pos, speed, t);
    for (const c of this.cars) this.place(c, pos, origin);
    if (lead.obj.visible) this.place(lead, pos, origin);
  }

  private makeCar(obj: THREE.Group, s: number, L: number, v: number, oncoming: boolean): Car {
    return { obj, s, L, v, oncoming, lamps: obj.userData.lamps };
  }

  private follow(pos: number, now = false) {
    this.leadState = 'following';
    this.leadGap = 110 + rand() * 200;
    this.leadTimer = 40 + rand() * 110;
    if (now) this.lead.s = pos + this.leadGap;
  }

  private goAway() {
    this.leadState = 'away';
    this.lead.obj.visible = false;
    this.leadTimer = (25 + rand() * 90) / Math.max(0.1, this.p.traffic.density);
  }

  private updateLead(lead: Car, dt: number, pos: number, speed: number, t: number) {
    this.leadTimer -= dt;
    const gap = lead.s - pos;
    switch (this.leadState) {
      case 'away':
        if (this.leadTimer > 0) return;
        // reappears far ahead in the haze, a bit slower than us, and we catch up
        this.leadState = 'arriving';
        this.leadGap = 110 + rand() * 200;
        lead.s = pos + 750;
        lead.obj.visible = true;
        break;
      case 'arriving':
        lead.v = speed - Math.min(12, 3 + (gap - this.leadGap) * 0.06);
        if (gap <= this.leadGap) this.follow(pos);
        break;
      case 'following':
        lead.v = speed + 3 * Math.sin(t * 0.08) + (this.leadGap - gap) * 0.05;
        if (this.leadTimer <= 0) this.leadState = 'leaving';
        break;
      case 'leaving':
        // pulls away and vanishes into the distance
        lead.v = speed + Math.min(12, 2 + (gap - this.leadGap) * 0.06);
        if (gap > 800) this.goAway();
        break;
    }
    if (speed < 1) lead.v = Math.max(lead.v, 0); // waiting at the start: don't roll backwards
    lead.s += lead.v * dt;
    lead.s = Math.max(lead.s, pos + 60);
  }

  private place(c: Car, pos: number, origin: THREE.Vector3) {
    c.lamps.visible = Math.abs(c.s - pos) < LAMP_BOX_DIST;
    const f = this.track.frame(c.s, this.frame);
    this.track.point(c.s, c.L, 0, this.tmp).sub(origin);
    c.obj.position.copy(this.tmp);
    c.obj.rotation.set(Math.atan(f.grade) * (c.oncoming ? -1 : 1), -f.heading + (c.oncoming ? Math.PI : 0), 0, 'YXZ');
  }
}

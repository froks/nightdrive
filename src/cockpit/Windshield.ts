import * as THREE from 'three';
import { liveCanvas } from '../util/textures';

/** Windshield area in camera space (metres) at depth Z. */
const X0 = -1.6, X1 = 1.6, Y0 = -0.34, Y1 = 0.75;
const Z = -1.425;
const CW = 2048, CH = Math.round(CW * (Y1 - Y0) / (X1 - X0));

interface Drop { x: number; y: number; r: number; a: number; }

/**
 * Rain droplets on the windshield: they accumulate while it rains, get cleared
 * where a wiper blade sweeps, and slowly evaporate when the rain stops.
 */
export class Windshield {
  readonly mesh: THREE.Mesh;
  private c = liveCanvas(CW, CH);
  private drops: Drop[] = [];
  private spawn = 0;
  private dirty = true;
  private sinceDraw = 0;

  constructor() {
    this.c.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(X1 - X0, Y1 - Y0),
      new THREE.MeshBasicMaterial({ map: this.c.tex, transparent: true, depthWrite: false, fog: false }),
    );
    this.mesh.position.set((X0 + X1) / 2, (Y0 + Y1) / 2, Z);
    this.mesh.renderOrder = 20;
  }

  /**
   * @param rain 0..1 rain intensity
   * @param speed vehicle speed (m/s) – more drops hit at speed
   */
  update(dt: number, rain: number, speed: number) {
    // spawn
    this.spawn += dt * rain * (60 + speed * 4);
    while (this.spawn >= 1 && this.drops.length < 900) {
      this.spawn -= 1;
      const big = Math.random() < 0.15;
      this.drops.push({
        x: X0 + Math.random() * (X1 - X0),
        y: Y0 + Math.random() * (Y1 - Y0),
        r: big ? 0.009 + Math.random() * 0.008 : 0.003 + Math.random() * 0.005,
        a: 0.6 + Math.random() * 0.4,
      });
      this.dirty = true;
    }
    // evaporate when dry
    if (rain < 0.05 && this.drops.length) {
      for (const d of this.drops) d.a -= dt * 0.15; // slow: the wipers do most of the work
      this.drops = this.drops.filter(d => d.a > 0);
      this.dirty = true;
    }
    this.sinceDraw += dt;
    if (this.dirty && this.sinceDraw > 1 / 30) this.draw();
  }

  /** Remove drops swept by a wiper rotating around (px,py) from angle a0 to a1 (radians). */
  sweep(px: number, py: number, a0: number, a1: number, rMin: number, rMax: number) {
    const lo = Math.min(a0, a1) - 0.03, hi = Math.max(a0, a1) + 0.03;
    const before = this.drops.length;
    this.drops = this.drops.filter(d => {
      const dx = d.x - px, dy = d.y - py;
      const r = Math.hypot(dx, dy);
      if (r < rMin || r > rMax) return true;
      const th = Math.atan2(dy, dx);
      return th < lo || th > hi;
    });
    if (this.drops.length !== before) this.dirty = true;
  }

  private draw() {
    this.sinceDraw = 0;
    this.dirty = false;
    const { ctx: x, tex } = this.c;
    x.clearRect(0, 0, CW, CH);
    const sx = CW / (X1 - X0), sy = CH / (Y1 - Y0);
    for (const d of this.drops) {
      const cx = (d.x - X0) * sx, cy = (Y1 - d.y) * sy, r = Math.max(1.2, d.r * sx);
      // body: faint cool tint; rim catches the street lights; tiny specular dot
      x.globalAlpha = d.a;
      x.fillStyle = 'rgba(150,170,220,0.22)';
      x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
      x.strokeStyle = 'rgba(220,232,255,0.55)';
      x.lineWidth = Math.max(0.8, r * 0.25);
      x.beginPath(); x.arc(cx, cy, r * 0.85, Math.PI * 0.9, Math.PI * 1.9); x.stroke();
      x.fillStyle = 'rgba(255,255,255,0.7)';
      x.fillRect(cx - r * 0.35, cy - r * 0.45, Math.max(1, r * 0.3), Math.max(1, r * 0.3));
    }
    x.globalAlpha = 1;
    tex.needsUpdate = true;
  }
}

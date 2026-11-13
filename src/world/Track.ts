import { Vector3 } from 'three';

/** Sample spacing along the track (metres). */
export const DS = 2;

export interface Frame {
  x: number; y: number; z: number;
  heading: number;
  /** forward (horizontal) */
  fx: number; fz: number;
  /** right (horizontal) */
  rx: number; rz: number;
  grade: number;
}

/**
 * Endless procedural road centreline.
 * Convention: heading θ=0 points to -Z; forward = (sinθ, 0, -cosθ), right = (cosθ, 0, sinθ).
 * Positive curvature turns right. Coordinates are absolute doubles (see floating origin in main).
 */
export class Track {
  private xs: number[] = [0];
  private zs: number[] = [0];
  private hs: number[] = [0];
  private base = 0; // sample index of xs[0]

  curvature(s: number): number {
    const gate = Math.sin(s / 1310 + 0.7);
    return 0.00052 * Math.sin(s / 430) * gate * gate * 1.4 + 0.00011 * Math.sin(s / 233 + 2.1);
  }

  elevation(s: number): number {
    return 9 * Math.sin(s / 870) + 4 * Math.sin(s / 340 + 1.3) + 1.5 * Math.sin(s / 150 + 0.4);
  }

  grade(s: number): number {
    return 9 / 870 * Math.cos(s / 870) + 4 / 340 * Math.cos(s / 340 + 1.3) + 1.5 / 150 * Math.cos(s / 150 + 0.4);
  }

  /** Make sure samples exist up to distance s. */
  ensure(s: number) {
    const need = Math.ceil(s / DS) + 2;
    while (this.base + this.xs.length <= need) {
      const i = this.base + this.xs.length - 1;
      const k = this.xs.length - 1;
      const h = this.hs[k];
      const sMid = (i + 0.5) * DS;
      const hm = h + this.curvature(sMid) * DS * 0.5;
      this.xs.push(this.xs[k] + Math.sin(hm) * DS);
      this.zs.push(this.zs[k] - Math.cos(hm) * DS);
      this.hs.push(h + this.curvature(sMid) * DS);
    }
  }

  /** Drop samples well behind s. */
  trim(s: number) {
    const drop = Math.floor(s / DS) - this.base - 200;
    if (drop > 500) {
      this.xs.splice(0, drop); this.zs.splice(0, drop); this.hs.splice(0, drop);
      this.base += drop;
    }
  }

  frame(s: number, out: Frame): Frame {
    this.ensure(s);
    const fi = Math.max(0, s / DS - this.base);
    const i = Math.floor(fi), a = fi - i;
    const j = Math.min(i + 1, this.xs.length - 1);
    out.x = this.xs[i] + (this.xs[j] - this.xs[i]) * a;
    out.z = this.zs[i] + (this.zs[j] - this.zs[i]) * a;
    out.heading = this.hs[i] + (this.hs[j] - this.hs[i]) * a;
    out.y = this.elevation(s);
    out.fx = Math.sin(out.heading); out.fz = -Math.cos(out.heading);
    out.rx = Math.cos(out.heading); out.rz = Math.sin(out.heading);
    out.grade = this.grade(s);
    return out;
  }

  /** Absolute world point at distance s, lateral offset L (right +), height y above road. */
  point(s: number, L: number, y: number, out: Vector3): Vector3 {
    const f = this.frame(s, tmpFrame);
    return out.set(f.x + f.rx * L, f.y + y, f.z + f.rz * L);
  }
}

export const makeFrame = (): Frame => ({ x: 0, y: 0, z: 0, heading: 0, fx: 0, fz: -1, rx: 1, rz: 0, grade: 0 });
const tmpFrame = makeFrame();

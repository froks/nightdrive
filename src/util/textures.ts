import * as THREE from 'three';
import { TAU, gauss, mix, noise2, rand, smoothstep } from './math';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

let glowTex: THREE.Texture | null = null;
/** Soft radial glow for sprites (white, tint via material colour). */
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const S = 128, c = canvas(S, S), x = c.getContext('2d')!;
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.08, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.05)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/**
 * Procedural spiral galaxy (Andromeda-ish), transparent background.
 * Built in layers: blurred diffuse light (disk, bulge, arms) -> soft dust lanes
 * cut out of it -> sharp stars, star-forming knots and blue clusters on top ->
 * bright core and two small companion galaxies. Major axis is horizontal.
 */
export function galaxyTexture(S = 1024): THREE.Texture {
  const R = S * 0.45, INC = 0.27, k = S / 1000;
  const cx = S / 2, cy = S / 2;
  const r0 = R * 0.12, PITCH = 2.3; // log-spiral: θ = arm·π + ln(r/r0)·PITCH
  const spiralAngle = (arm: number, r: number) => arm * Math.PI + Math.log(Math.max(r, r0) / r0) * PITCH;
  const P = (r: number, th: number): [number, number] => [cx + Math.cos(th) * r, cy + Math.sin(th) * r * INC];
  const layer = () => { const c = canvas(S, S); return { c, x: c.getContext('2d')! }; };
  const blurred = (src: HTMLCanvasElement, px: number) => {
    const l = layer();
    l.x.filter = `blur(${px * k}px)`;
    l.x.drawImage(src, 0, 0);
    l.x.filter = 'none';
    return l.c;
  };
  const ellipseGlow = (x: CanvasRenderingContext2D, r: number, inc: number, stops: [number, string][], ox = cx, oy = cy) => {
    x.save(); x.translate(ox, oy); x.scale(1, inc);
    const g = x.createRadialGradient(0, 0, 0, 0, 0, r);
    for (const [o, c] of stops) g.addColorStop(o, c);
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, r, 0, TAU); x.fill();
    x.restore();
  };
  const mixRGB = (t: number, a: number[], b: number[]) => a.map((v, i) => Math.round(mix(v, b[i], t)));

  /* ---- 1. diffuse light: exponential disk + arm glow + bulge ---- */
  const light = layer();
  light.x.globalCompositeOperation = 'lighter';
  ellipseGlow(light.x, R * 1.08, INC, [
    [0, 'rgba(255,226,205,0.5)'], [0.12, 'rgba(250,205,190,0.32)'], [0.3, 'rgba(225,180,200,0.16)'],
    [0.55, 'rgba(170,165,225,0.09)'], [0.8, 'rgba(120,140,230,0.035)'], [1, 'rgba(100,120,220,0)'],
  ]);
  for (let i = 0; i < 3200 * k; i++) {
    const arm = rand() < 0.5 ? 0 : 1;
    const t = Math.pow(rand(), 1.25);
    const r = (r0 + (R - r0) * t) * (1 + gauss() * 0.03);
    const edge = 1 - 0.7 * smoothstep(0.65, 1.0, r / R); // fade the outer arm, no hard hoop
    const th = spiralAngle(arm, r) + gauss() * 0.13;
    const [x, y] = P(r, th);
    const [cr, cg, cb] = mixRGB(Math.min(1, r / R * 1.2), [255, 214, 190], [140, 175, 255]);
    const br = (6 + rand() * 12) * k * (0.5 + r / R);
    light.x.fillStyle = `rgba(${cr},${cg},${cb},${(0.014 + rand() * 0.012) * edge})`;
    light.x.beginPath(); light.x.ellipse(x, y, br, br * (0.45 + INC), 0, 0, TAU); light.x.fill();
  }
  ellipseGlow(light.x, R * 0.32, INC * 1.55, [
    [0, 'rgba(255,240,220,0.95)'], [0.25, 'rgba(255,220,190,0.55)'], [0.6, 'rgba(240,190,170,0.18)'], [1, 'rgba(230,180,170,0)'],
  ]);
  const lightSoft = blurred(light.c, 9);

  /* ---- 2. dust lanes (soft, broken, on the inner edge of the arms + faint rings) ---- */
  const dust = layer();
  for (let i = 0; i < 2600 * k; i++) {
    const arm = rand() < 0.5 ? 0 : 1;
    const r = R * (0.24 + Math.pow(rand(), 0.9) * 0.72);
    // break lanes into filaments using a smooth noise along the spiral
    const th0 = spiralAngle(arm, r);
    if (noise2(th0 * 1.7, arm * 10) < 0.35) continue;
    const th = th0 - 0.42 + gauss() * 0.05;
    const [x, y] = P(r, th);
    const w = r * (0.012 + rand() * 0.02);
    dust.x.fillStyle = `rgba(0,0,0,${0.12 + rand() * 0.2})`;
    dust.x.beginPath(); dust.x.ellipse(x, y, w * 1.8, w * 1.8 * INC * 1.6, 0, 0, TAU); dust.x.fill();
  }
  for (const [rr, a] of [[0.5, 0.18]] as const) {
    dust.x.save(); dust.x.translate(cx, cy); dust.x.scale(1, INC);
    for (let s = 0; s < 260; s++) {
      const th = (s / 260) * TAU;
      if (noise2(s * 0.08, rr * 20) < 0.4) continue;
      // near side (lower half on screen) shows the dust more strongly
      const near = Math.sin(th) > 0 ? 1 : 0.45;
      dust.x.fillStyle = `rgba(0,0,0,${a * near})`;
      dust.x.beginPath(); dust.x.arc(Math.cos(th) * rr * R, Math.sin(th) * rr * R, R * 0.012, 0, TAU); dust.x.fill();
    }
    dust.x.restore();
  }
  const dustSoft = blurred(dust.c, 3.5);

  /* ---- 3. stars, HII knots, blue clusters ---- */
  const stars = layer();
  for (let i = 0; i < 16000 * k * k; i++) {
    const inArm = rand() < 0.55;
    let r: number, th: number;
    if (inArm) {
      const arm = rand() < 0.5 ? 0 : 1;
      r = r0 + (R - r0) * Math.pow(rand(), 1.2);
      th = spiralAngle(arm, r) + gauss() * (0.12 + 0.06 * r / R);
    } else {
      r = R * Math.min(1.05, -Math.log(1 - rand() * 0.97) * 0.28);
      th = rand() * TAU;
    }
    const [x, y] = P(r, th);
    const [cr, cg, cb] = mixRGB(Math.min(1, r / R), [255, 225, 200], [170, 195, 255]);
    stars.x.fillStyle = `rgba(${cr},${cg},${cb},${(0.1 + rand() * 0.35) * (1 - 0.6 * smoothstep(0.7, 1.05, r / R))})`;
    const sz = (0.6 + Math.pow(rand(), 4) * 1.4) * k;
    stars.x.fillRect(x, y, sz, sz);
  }
  for (let i = 0; i < 420 * k; i++) {
    const arm = rand() < 0.5 ? 0 : 1;
    const r = R * (0.3 + rand() * 0.65);
    const th = spiralAngle(arm, r) + 0.08 + gauss() * 0.07;
    const [x, y] = P(r, th);
    const pink = rand() < 0.55;
    stars.x.fillStyle = pink ? 'rgba(255,120,175,0.55)' : 'rgba(150,185,255,0.55)';
    const s = (0.8 + rand() * 1.4) * k;
    stars.x.beginPath(); stars.x.arc(x, y, s, 0, TAU); stars.x.fill();
  }
  const starGlow = blurred(stars.c, 2.5);

  /* ---- 4. composite ---- */
  const out = layer();
  const o = out.x;
  o.drawImage(lightSoft, 0, 0);
  o.globalCompositeOperation = 'lighter';
  o.globalAlpha = 0.2; o.drawImage(light.c, 0, 0); o.globalAlpha = 1;
  o.globalCompositeOperation = 'destination-out';
  o.globalAlpha = 0.9; o.drawImage(dustSoft, 0, 0); o.globalAlpha = 1;
  o.globalCompositeOperation = 'lighter';
  o.drawImage(starGlow, 0, 0);
  o.drawImage(stars.c, 0, 0);
  // bright nucleus
  ellipseGlow(o, R * 0.1, INC * 1.7, [[0, 'rgba(255,255,250,1)'], [0.35, 'rgba(255,245,230,0.6)'], [1, 'rgba(255,225,205,0)']]);
  ellipseGlow(o, R * 0.025, 1, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
  // companions: compact (M32-like) and diffuse elliptical (M110-like)
  ellipseGlow(o, R * 0.05, 0.8, [[0, 'rgba(255,240,225,0.9)'], [0.4, 'rgba(255,225,205,0.35)'], [1, 'rgba(255,220,200,0)']], cx + R * 0.16, cy + R * 0.2);
  o.save(); o.translate(cx - R * 0.42, cy - R * 0.38); o.rotate(0.5);
  ellipseGlow(o, R * 0.12, 0.55, [[0, 'rgba(255,230,215,0.35)'], [0.5, 'rgba(240,215,205,0.12)'], [1, 'rgba(230,210,200,0)']], 0, 0);
  o.restore();

  const t = new THREE.CanvasTexture(out.c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Helper to create a live-updating canvas texture. */
export function liveCanvas(w: number, h: number) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d')!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { canvas: c, ctx, tex };
}

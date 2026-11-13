import type { DriveState } from './Cockpit';

/**
 * 80s "digital dash" instrument cluster (Z31-era inspiration):
 * rising wedge bar-graph tachometer, slanted 7-segment speedometer,
 * vertical bar graphs, 7-seg odometer/trip, warning-lamp strip.
 * Drawn on a 1536×512 canvas.
 */
export const DASH_W = 1536, DASH_H = 512;

const CYAN = '#38ffd8';
const TEAL_DIM = 'rgba(56,255,216,0.08)';
const YELLOW = '#ffe14a';
const RED = '#ff3d2e';
const ORANGE = '#ff8a2a';
const LINE = 'rgba(70,170,255,0.75)';
const LABEL = 'rgba(150,200,255,0.85)';

const SKEW = 0.12; // italic slant of the digital graphics

export function drawDigitalDash(x: CanvasRenderingContext2D, s: DriveState) {
  const W = DASH_W, H = DASH_H;
  x.setTransform(1, 0, 0, 1, 0, 0);
  // smoked-glass background with a faint perspective grid
  const bg = x.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#02040a'); bg.addColorStop(1, '#010205');
  x.fillStyle = bg; x.fillRect(0, 0, W, H);
  x.strokeStyle = 'rgba(70,120,255,0.07)'; x.lineWidth = 1.5;
  for (let i = -12; i <= 12; i++) { x.beginPath(); x.moveTo(W / 2 + i * 30, 300); x.lineTo(W / 2 + i * 140, H); x.stroke(); }
  for (let k = 0; k < 6; k++) { const y = 300 + Math.pow(k / 5, 1.8) * (H - 300); x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); x.stroke(); }

  const font = (sz: number, wt = '700') => `italic ${wt} ${sz}px "Eurostile", "Microgramma", "DejaVu Sans", "Arial Narrow", sans-serif`;

  /* ---------------- frame lines ---------------- */
  x.strokeStyle = LINE; x.lineWidth = 3;
  x.beginPath();
  x.moveTo(150, 250); x.lineTo(180, 228); x.lineTo(1356, 228); x.lineTo(1386, 250);
  x.stroke();
  x.beginPath();
  x.moveTo(140, 22); x.lineTo(160, 10); x.lineTo(1376, 10); x.lineTo(1396, 22);
  x.stroke();

  /* ---------------- tachometer: rising wedge bar graph ---------------- */
  const SEG = 48, X0 = 176, X1 = 1360, BASE = 216;
  const segW = (X1 - X0) / SEG;
  const lit = Math.max(0, Math.min(1, s.rpm)) * SEG;
  for (let i = 0; i < SEG; i++) {
    const h = 34 + 150 * Math.pow(i / (SEG - 1), 1.25);
    const xx = X0 + i * segW;
    const on = i < lit;
    const col = i >= 40 ? RED : i >= 32 ? YELLOW : CYAN;
    x.fillStyle = on ? col : TEAL_DIM;
    if (on && i + 1 > lit) x.globalAlpha = 0.4 + 0.6 * (lit - i);
    // slanted parallelogram segment
    x.beginPath();
    x.moveTo(xx, BASE); x.lineTo(xx + segW - 7, BASE);
    x.lineTo(xx + segW - 7 + h * SKEW, BASE - h); x.lineTo(xx + h * SKEW, BASE - h);
    x.closePath(); x.fill();
    x.globalAlpha = 1;
  }
  // redline marker + scale
  x.fillStyle = RED; x.fillRect(X0 + 40 * segW, BASE + 6, 8 * segW - 7, 4);
  x.font = font(26); x.fillStyle = LABEL; x.textAlign = 'center';
  for (let k = 0; k <= 8; k++) x.fillText(String(k), X0 + k * 6 * segW, BASE + 36);
  x.textAlign = 'left';
  x.font = font(18, '600');
  x.fillText('x1000 r/min', X0 - 6, 40);

  /* ---------------- speed: big 7-segment digits ---------------- */
  const spd = String(Math.round(s.speedKmh)).padStart(3, ' ');
  for (let i = 0; i < 3; i++) seg7(x, 580 + i * 124, 276, 100, 164, spd[i], CYAN);
  x.font = font(34); x.fillStyle = LABEL;
  x.fillText('km/h', 964, 436);

  /* ---------------- left: FUEL / TEMP vertical bar graphs ---------------- */
  const fuel = 0.62 - (s.odoKm % 400) / 900;
  const temp = 0.55 + 0.03 * Math.sin(s.t * 0.1);
  vbar(x, 40, 70, 34, 330, 12, fuel, i => (i < 2 ? ORANGE : CYAN), 'F', 'E', 'FUEL');
  vbar(x, 100, 70, 34, 330, 12, temp, i => (i > 9 ? RED : CYAN), 'H', 'C', 'TEMP');

  /* ---------------- right: OIL / VOLT ---------------- */
  const oil = 0.45 + s.rpm * 0.35;
  const volt = 0.7 + 0.02 * Math.sin(s.t * 1.7);
  vbar(x, 1402, 70, 34, 330, 12, oil, () => CYAN, 'H', 'L', 'OIL');
  vbar(x, 1462, 70, 34, 330, 12, volt, () => CYAN, '16', '8', 'VOLT');

  /* ---------------- odometer / trip / gear ---------------- */
  x.font = font(18, '600'); x.fillStyle = LABEL;
  x.fillText('ODO', 196, 300);
  x.fillText('TRIP', 196, 380);
  const odo = String(Math.floor(42817 + s.odoKm)).padStart(6, '0');
  for (let i = 0; i < 6; i++) seg7(x, 250 + i * 40, 280, 32, 52, odo[i], CYAN, 0.75);
  const trip = (s.odoKm % 1000).toFixed(1).padStart(5, ' ');
  let cx = 250;
  for (const ch of trip) {
    if (ch === '.') { x.fillStyle = CYAN; x.fillRect(cx - 6, 404, 7, 7); continue; }
    seg7(x, cx, 360, 32, 52, ch, CYAN, 0.75); cx += 40;
  }
  // gear
  x.strokeStyle = LINE; x.lineWidth = 2.5;
  x.strokeRect(470, 296, 58, 74);
  x.font = font(56, '800'); x.fillStyle = YELLOW;
  x.fillText('D', 480, 356);

  /* ---------------- right of speed: boost / economy bar ---------------- */
  x.font = font(18, '600'); x.fillStyle = LABEL;
  x.fillText('BOOST', 1096, 300);
  const boost = Math.max(0, Math.min(1, (s.rpm - 0.45) * 1.6 + 0.1 * Math.sin(s.t * 3)));
  for (let i = 0; i < 12; i++) {
    const on = i < boost * 12;
    x.fillStyle = on ? (i > 8 ? ORANGE : CYAN) : TEAL_DIM;
    x.beginPath();
    const bx = 1096 + i * 21, by = 312, bh = 30;
    x.moveTo(bx, by + bh); x.lineTo(bx + 15, by + bh); x.lineTo(bx + 15 + bh * SKEW, by); x.lineTo(bx + bh * SKEW, by);
    x.fill();
  }
  // outside temp + clock style readout
  x.fillText('OUT', 1096, 384);
  seg7(x, 1160, 362, 30, 50, '1', CYAN, 0.75);
  seg7(x, 1198, 362, 30, 50, '8', CYAN, 0.75);
  x.font = font(26); x.fillStyle = LABEL;
  x.fillText('°C', 1240, 408);

  /* ---------------- warning lamp strip ---------------- */
  const lamps: [string, string, boolean][] = [
    ['◀', '#3bff7a', false], ['BRAKE', RED, false], ['OIL', RED, false], ['CHARGE', RED, false],
    ['BELT', RED, false], ['HI BEAM', '#4aa8ff', true], ['CHECK', ORANGE, false], ['▶', '#3bff7a', false],
  ];
  x.font = font(17, '700'); x.textAlign = 'center';
  lamps.forEach(([label, col, on], i) => {
    const lx = 330 + i * 125, ly = 486;
    x.globalAlpha = on ? 1 : 0.13;
    x.strokeStyle = col; x.lineWidth = 2;
    x.strokeRect(lx - 50, ly - 18, 100, 30);
    x.fillStyle = col;
    x.fillText(label, lx, ly + 4);
  });
  x.globalAlpha = 1;
  x.textAlign = 'left';
}

/* 7-segment digit with ghost segments. (x,y) = top-left, w×h cell. */
const SEGMENTS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc',
  '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', ' ': '', '-': 'g',
};
function seg7(x: CanvasRenderingContext2D, X: number, Y: number, w: number, h: number, ch: string, col: string, ghost = 1) {
  const t = Math.max(4, w * 0.16);       // segment thickness
  const g = t * 0.25;                    // gap
  const hh = h / 2;
  const on = SEGMENTS[ch] ?? '';
  // segment polygons in an upright cell, then skewed
  const hseg = (sx: number, sy: number, len: number) => [[sx + g, sy], [sx + t / 2 + g, sy - t / 2], [sx + len - t / 2 - g, sy - t / 2], [sx + len - g, sy], [sx + len - t / 2 - g, sy + t / 2], [sx + t / 2 + g, sy + t / 2]];
  const vseg = (sx: number, sy: number, len: number) => [[sx, sy + g], [sx + t / 2, sy + t / 2 + g], [sx + t / 2, sy + len - t / 2 - g], [sx, sy + len - g], [sx - t / 2, sy + len - t / 2 - g], [sx - t / 2, sy + t / 2 + g]];
  const S: Record<string, number[][]> = {
    a: hseg(0, t / 2, w), g: hseg(0, hh, w), d: hseg(0, h - t / 2, w),
    f: vseg(t / 2, t / 2, hh - t / 2), b: vseg(w - t / 2, t / 2, hh - t / 2),
    e: vseg(t / 2, hh, hh - t / 2), c: vseg(w - t / 2, hh, hh - t / 2),
  };
  for (const k of 'abcdefg') {
    const lit = on.includes(k);
    x.fillStyle = lit ? col : `rgba(56,255,216,${0.06 * ghost})`;
    x.beginPath();
    S[k].forEach(([px, py], i) => {
      const sx = X + px + (h - py) * SKEW, sy = Y + py;
      if (i) x.lineTo(sx, sy); else x.moveTo(sx, sy);
    });
    x.closePath(); x.fill();
  }
}

/* vertical segmented bar graph with end labels */
function vbar(x: CanvasRenderingContext2D, X: number, Y: number, w: number, h: number, n: number, v: number,
  color: (i: number) => string, top: string, bottom: string, label: string) {
  const sh = h / n;
  for (let i = 0; i < n; i++) {
    const on = i < Math.round(Math.max(0, Math.min(1, v)) * n);
    x.fillStyle = on ? color(i) : TEAL_DIM;
    const yy = Y + h - (i + 1) * sh;
    x.beginPath();
    x.moveTo(X + (h - (yy + sh - 5 - Y)) * SKEW * 0.3, yy + sh - 5);
    x.lineTo(X + w + (h - (yy + sh - 5 - Y)) * SKEW * 0.3, yy + sh - 5);
    x.lineTo(X + w + (h - (yy - Y)) * SKEW * 0.3, yy);
    x.lineTo(X + (h - (yy - Y)) * SKEW * 0.3, yy);
    x.fill();
  }
  x.font = 'italic 700 18px "DejaVu Sans", sans-serif';
  x.fillStyle = LABEL; x.textAlign = 'center';
  x.fillText(top, X + w / 2 + 6, Y - 10);
  x.fillText(bottom, X + w / 2, Y + h + 22);
  x.font = 'italic 600 15px "DejaVu Sans", sans-serif';
  x.fillText(label, X + w / 2, Y + h + 44);
  x.textAlign = 'left';
}

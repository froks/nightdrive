import * as THREE from 'three';
import { liveCanvas } from '../util/textures';
import { CELL, glyph, normalizeLed } from './ledFont';
import type { RadioAction, RadioPlayer } from '../audio/RadioPlayer';
import { TAU } from '../util/math';

/* Faceplate dimensions (metres, local space; +Z faces the driver). */
const W = 0.64, H = 0.2, D = 0.06;
const FRONT = D / 2;

/* LED matrix geometry */
const COLS = 98, ROWS = 26, DOT = 10;
const TEXT_COLS = 16;
const LED_RGB = [110, 255, 180];

/* Layout (centres) */
const DOOR = { x: -0.185, y: 0.045, w: 0.24, h: 0.088 };
const DISP = { x: 0.13, y: 0.045, w: 0.33, h: 0.33 * (ROWS * DOT) / (COLS * DOT) };
const ROW_Y = -0.054;

interface ButtonDef { action: RadioAction; label: string; x: number; w: number; }
const BUTTONS: ButtonDef[] = [
  { action: 'eject', label: '▲ TAPE', x: -0.2, w: 0.06 },
  { action: 'prev', label: '◀◀', x: -0.13, w: 0.045 },
  { action: 'toggle', label: '▶ ■', x: -0.08, w: 0.045 },
  { action: 'next', label: '▶▶', x: -0.03, w: 0.045 },
  ...[1, 2, 3, 4, 5].map(i => ({ action: `preset${i}` as RadioAction, label: String(i), x: 0.03 + (i - 1) * 0.053, w: 0.046 })),
];

/** Pixel mapping for the faceplate canvas. */
const FP_SCALE = 2000;
const fx = (x: number) => (x + W / 2) * FP_SCALE;
const fy = (y: number) => (H / 2 - y) * FP_SCALE;

/**
 * Classic 80s cassette car radio: smoked cassette door, green dot-matrix LED
 * display, backlit mechanical buttons and a volume knob. Purely a view —
 * all state lives in RadioPlayer.
 */
export class Radio {
  readonly group = new THREE.Group();
  /** meshes that can be clicked (userData.action) */
  readonly interactive: THREE.Object3D[] = [];
  private player: RadioPlayer | null = null;

  private led = liveCanvas(COLS * DOT, ROWS * DOT);
  private ledBg: HTMLCanvasElement;
  private grid = new Uint8Array(COLS * ROWS);
  private door = liveCanvas(960, 352);
  private buttons = new Map<RadioAction, { mesh: THREE.Mesh; baseZ: number; until: number }>();
  private presetLeds: THREE.MeshBasicMaterial[] = [];
  private tapeLed!: THREE.MeshBasicMaterial;
  private knob: THREE.Group;

  private lastLed = -1;
  private lastDoor = -1;
  private reel = 0;
  private bands = new Float32Array(24);
  private peaks = new Float32Array(24);
  private scrollText = '';
  private scrollStart = 0;

  constructor() {
    const g = this.group;

    /* chassis + faceplate */
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, H + 0.02, D), new THREE.MeshStandardMaterial({ color: 0x08090c, roughness: 0.6, metalness: 0.3, fog: false }));
    g.add(chassis);
    const fp = liveCanvas(W * FP_SCALE, H * FP_SCALE);
    drawFaceplate(fp.ctx, fp.canvas);
    fp.tex.needsUpdate = true;
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.MeshStandardMaterial({
        map: fp.tex, emissiveMap: fp.tex, emissive: new THREE.Color(0.55, 0.55, 0.55),
        roughness: 0.42, metalness: 0.55, fog: false,
      }),
    );
    face.position.z = FRONT + 0.0005;
    g.add(face);
    // chrome trim
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x9aa0b0, roughness: 0.25, metalness: 1, fog: false });
    for (const [w, h, x, y] of [[W + 0.02, 0.004, 0, H / 2 + 0.008], [W + 0.02, 0.004, 0, -H / 2 - 0.008], [0.004, H + 0.02, -W / 2 - 0.008, 0], [0.004, H + 0.02, W / 2 + 0.008, 0]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.006), trimMat);
      m.position.set(x, y, FRONT);
      g.add(m);
    }

    /* cassette door (live canvas) */
    const door = new THREE.Mesh(new THREE.PlaneGeometry(DOOR.w, DOOR.h), new THREE.MeshBasicMaterial({ map: this.door.tex, fog: false, color: new THREE.Color(0.95, 0.95, 0.95) }));
    door.position.set(DOOR.x, DOOR.y, FRONT + 0.001);
    g.add(door);

    /* LED matrix display: sharp texture, mipmapped */
    this.ledBg = makeLedBackground();
    this.led.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.led.tex.generateMipmaps = true;
    this.led.tex.anisotropy = 8;
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(DISP.w, DISP.h), new THREE.MeshBasicMaterial({ map: this.led.tex, fog: false, color: new THREE.Color(1.15, 1.15, 1.15) }));
    disp.position.set(DISP.x, DISP.y, FRONT + 0.001);
    g.add(disp);
    // glass over display/door: subtle reflective layer
    const glass = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.08, metalness: 1, transparent: true, opacity: 0.18, fog: false });
    for (const r of [DOOR, DISP]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), glass);
      m.position.set(r.x, r.y, FRONT + 0.0025);
      g.add(m);
    }

    /* buttons */
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x15161c, roughness: 0.5, metalness: 0.3, fog: false });
    for (const b of BUTTONS) {
      const label = buttonLabel(b.label, b.w);
      const mats = [sideMat, sideMat, sideMat, sideMat, new THREE.MeshBasicMaterial({ map: label, fog: false }), sideMat];
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, 0.028, 0.014), mats);
      const baseZ = FRONT + 0.006;
      mesh.position.set(b.x, ROW_Y, baseZ);
      mesh.userData.action = b.action;
      g.add(mesh);
      this.interactive.push(mesh);
      this.buttons.set(b.action, { mesh, baseZ, until: 0 });
      if (b.action.startsWith('preset') || b.action === 'eject') {
        const ledMat = new THREE.MeshBasicMaterial({ color: 0x050805, fog: false });
        const led = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.0035, 0.002), ledMat);
        led.position.set(b.x, ROW_Y + 0.022, FRONT + 0.001);
        g.add(led);
        if (b.action === 'eject') this.tapeLed = ledMat; else this.presetLeds.push(ledMat);
      }
    }

    /* volume knob */
    this.knob = new THREE.Group();
    const knobMat = new THREE.MeshStandardMaterial({ color: 0x1b1c22, roughness: 0.35, metalness: 0.7, fog: false });
    const knobMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.021, 0.022, 32).rotateX(Math.PI / 2), knobMat);
    knobMesh.userData.action = 'mute';
    this.knob.add(knobMesh);
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.011, 0.002), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.8, 0.3), fog: false }));
    tick.position.set(0, 0.011, 0.012);
    this.knob.add(tick);
    this.knob.position.set(-0.275, ROW_Y, FRONT + 0.011);
    g.add(this.knob);
    this.interactive.push(knobMesh);
  }

  attach(player: RadioPlayer) { this.player = player; }

  /** Two-line message that overrides the info rows (e.g. the start prompt). */
  private prompt: [string, string] | null = null;
  setPrompt(lines: [string, string] | null) { this.prompt = lines; }

  /** Visual press feedback. */
  press(action: RadioAction) {
    const b = this.buttons.get(action);
    if (b) b.until = performance.now() + 140;
  }

  update(t: number, dt: number) {
    const p = this.player;
    const now = performance.now();
    for (const b of this.buttons.values()) {
      const target = now < b.until ? b.baseZ - 0.005 : b.baseZ;
      b.mesh.position.z += (target - b.mesh.position.z) * Math.min(1, dt * 30);
    }
    if (!p) return;

    // LEDs & knob
    for (let i = 0; i < 5; i++) {
      const on = p.mode === 'radio' && p.stationIndex === i;
      this.presetLeds[i].color.setRGB(on ? 0.4 : 0.03, on ? 3 : 0.05, on ? 1.2 : 0.03);
    }
    const tapeOn = p.mode === 'tape';
    this.tapeLed.color.setRGB(tapeOn ? 3 : 0.05, tapeOn ? 1.2 : 0.03, tapeOn ? 0.2 : 0.02);
    this.knob.rotation.z = -(p.volume - 0.5) * 4.4;

    if (p.status === 'playing' && p.mode === 'tape') this.reel += dt * 2.2;
    if (t - this.lastLed >= 1 / 30) { this.lastLed = t; this.drawLed(t); }
    if (t - this.lastDoor >= 1 / 20) { this.lastDoor = t; this.drawDoor(); }
  }

  /* ---------------- LED matrix ---------------- */

  private drawLed(t: number) {
    const p = this.player!;
    this.grid.fill(0);
    const clock = () => {
      const d = new Date();
      return String(d.getHours()).padStart(2, '0') + (d.getMilliseconds() < 500 ? ':' : ' ') + String(d.getMinutes()).padStart(2, '0');
    };
    const blink = Math.floor(t * 2.5) % 2 === 0;

    if (this.prompt) {
      const [a, b] = this.prompt;
      const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((TEXT_COLS - s.length) / 2))) + s;
      this.text(center(a), 1, 1);
      this.text(center(b), 1, 10);
      this.drawSpectrumRow(t, false);
      this.paint();
      return;
    }

    // ---- row 1: source + state icon
    const stateIcon = p.status === 'playing' ? '▶' : p.status === 'loading' ? (blink ? '·' : ' ') : p.status === 'error' ? '!' : '■';
    let row1: string;
    if (p.mode === 'radio') {
      const n = p.stationIndex < 5 ? String(p.stationIndex + 1) : ' ';
      row1 = (n + ' ' + p.station.name).slice(0, 14).padEnd(15) + stateIcon;
    } else {
      const n = String(p.trackIndex + 1).padStart(2, '0') + '/' + String(p.tracks.length).padStart(2, '0');
      row1 = ('TAPE A ' + n).padEnd(15) + stateIcon;
    }
    this.text(row1, 1, 1);

    // ---- row 2: info line
    let row2: string | null = null, scroll: string | null = null;
    const volAge = performance.now() / 1000 - p.volumeChangedAt;
    if (volAge >= 0 && volAge < 2) {
      row2 = p.muted ? 'VOL       MUTE' : 'VOL ' + '█'.repeat(Math.round(p.volume * 10)).padEnd(10) + String(Math.round(p.volume * 10)).padStart(2);
    } else if (p.status === 'loading') {
      row2 = blink ? (p.mode === 'radio' ? `TUNING FM ${p.station.freq}` : 'LOADING...') : '';
    } else if (p.status === 'error') {
      row2 = p.mode === 'radio' ? 'NO SIGNAL  RETRY' : 'TAPE ERROR';
    } else if (p.status === 'stopped') {
      row2 = (p.mode === 'radio' ? `FM ${p.station.freq}` : 'STOP').padEnd(11) + clock();
    } else if (p.mode === 'radio') {
      const np = p.nowPlaying();
      scroll = np ? (np.artist ? `${np.artist} - ${np.title}` : np.title) : p.station.genre;
    } else {
      scroll = p.track?.name ?? '';
    }
    if (scroll !== null) {
      const s = normalizeLed(scroll);
      if (s !== this.scrollText) { this.scrollText = s; this.scrollStart = t; }
      if (s.length <= TEXT_COLS) this.text(s, 1, 10);
      else {
        const loop = s + '   ·   ';
        const pixels = loop.length * CELL;
        // hold 1.5 s at the start, then scroll ~14 dots/s
        const el = Math.max(0, t - this.scrollStart - 1.5);
        const off = Math.floor(el * 14) % pixels;
        this.text(loop + loop, 1 - off, 10);
      }
    } else if (row2 !== null) {
      this.text(row2, 1, 10);
    }

    this.drawSpectrumRow(t, p.status === 'playing');
    this.paint();
  }

  /** Row 3: spectrum analyser, or FM tuning scale when idle. */
  private drawSpectrumRow(_t: number, playing: boolean) {
    const p = this.player!;
    const bands = p.spectrum(this.bands);
    for (let b = 0; b < 24; b++) {
      const v = playing ? Math.min(1, bands[b] * 1.15) : 0;
      this.peaks[b] = Math.max(v, this.peaks[b] - 0.012);
      const h = Math.round(v * 6), pk = Math.round(this.peaks[b] * 6);
      for (let k = 0; k < 6; k++) {
        if (k < h || (playing && pk > 0 && k === pk - 1)) for (let c = 0; c < 3; c++) this.set(1 + b * 4 + c, 24 - k);
      }
    }
    if (!playing) {
      for (let c = 1; c < COLS - 1; c += 4) this.set(c, 24);
      for (let c = 1; c < COLS - 1; c += 16) this.set(c, 23);
      if (p.mode === 'radio') {
        const f = parseFloat(p.station.freq);
        const c = 1 + Math.round(((f - 88) / 20) * (COLS - 3));
        for (let r = 19; r <= 24; r++) this.set(c, r);
      }
    }

  }

  private paint() {
    const { ctx: x, tex } = this.led;
    x.drawImage(this.ledBg, 0, 0);
    const [r, g, b] = LED_RGB;
    x.fillStyle = `rgb(${r},${g},${b})`;
    x.beginPath();
    for (let i = 0; i < this.grid.length; i++) {
      if (!this.grid[i]) continue;
      const cx = (i % COLS) * DOT + DOT / 2, cy = Math.floor(i / COLS) * DOT + DOT / 2;
      x.moveTo(cx + 4, cy);
      x.arc(cx, cy, 4, 0, TAU);
    }
    x.fill();
    // LED hot-spots
    x.fillStyle = 'rgba(235,255,240,0.55)';
    x.beginPath();
    for (let i = 0; i < this.grid.length; i++) {
      if (!this.grid[i]) continue;
      const cx = (i % COLS) * DOT + DOT / 2, cy = Math.floor(i / COLS) * DOT + DOT / 2;
      x.rect(cx - 1.5, cy - 1.5, 3, 3);
    }
    x.fill();
    tex.needsUpdate = true;
  }

  private set(col: number, row: number) {
    if (col >= 1 && col < COLS - 1 && row >= 0 && row < ROWS) this.grid[row * COLS + col] = 1;
  }

  /** Draw text into the dot grid at dot column `col0`, row `row0` (clipped to the text area). */
  private text(s: string, col0: number, row0: number) {
    s = normalizeLed(s);
    for (let i = 0; i < s.length; i++) {
      const c0 = col0 + i * CELL;
      if (c0 > COLS) break;
      if (c0 + 5 < 1) continue;
      const gl = glyph(s[i]);
      for (let y = 0; y < 7; y++) for (let xx = 0; xx < 5; xx++) if (gl[y * 5 + xx]) this.set(c0 + xx, row0 + y);
    }
  }

  /* ---------------- cassette door ---------------- */

  private drawDoor() {
    const p = this.player!;
    const { ctx: x, canvas: c, tex } = this.door;
    const w = c.width, h = c.height;
    let gr = x.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, '#0c0d12'); gr.addColorStop(1, '#050508');
    x.fillStyle = gr; x.fillRect(0, 0, w, h);

    if (p.mode === 'tape') {
      // cassette shell
      const cx = w / 2, cy = h / 2 + 10, cw = w * 0.86, ch = h * 0.78;
      x.globalAlpha = 0.85;
      x.fillStyle = '#1d1e24';
      roundRect(x, cx - cw / 2, cy - ch / 2, cw, ch, 18); x.fill();
      // label with retro stripes
      x.fillStyle = '#e9e1d0';
      roundRect(x, cx - cw / 2 + 24, cy - ch / 2 + 16, cw - 48, ch * 0.62, 10); x.fill();
      ['#ff3d7f', '#ff7a2f', '#ffc23d'].forEach((col, i) => { x.fillStyle = col; x.fillRect(cx - cw / 2 + 24, cy - ch / 2 + 70 + i * 14, cw - 48, 10); });
      x.fillStyle = '#2a2230';
      x.font = 'bold 30px "Arial Black", sans-serif';
      x.fillText('SIDE A', cx - cw / 2 + 40, cy - ch / 2 + 54);
      x.font = 'bold 24px ui-monospace, monospace';
      x.fillText((p.track?.name ?? '').slice(0, 32).toUpperCase(), cx - cw / 2 + 200, cy - ch / 2 + 52);
      // window + reels (tape moves from left to right reel as the track plays)
      const winW = cw * 0.5, winH = ch * 0.32, wx = cx - winW / 2, wy = cy + 4;
      x.fillStyle = '#0b0b0e';
      roundRect(x, wx, wy, winW, winH, winH / 2); x.fill();
      const prog = Math.min(1, p.position / 300);
      for (const [k, amount] of [[-1, 1 - prog], [1, prog]] as const) {
        const rx = cx + k * winW * 0.3, ry = wy + winH / 2;
        x.fillStyle = '#3a2a22';
        x.beginPath(); x.arc(rx, ry, 17 + amount * 24, 0, TAU); x.fill();
        x.fillStyle = '#d9d4ca';
        x.beginPath(); x.arc(rx, ry, 15, 0, TAU); x.fill();
        x.strokeStyle = '#1d1e24'; x.lineWidth = 4;
        for (let s = 0; s < 6; s++) {
          const a = this.reel + s * TAU / 6;
          x.beginPath(); x.moveTo(rx + Math.cos(a) * 6, ry + Math.sin(a) * 6); x.lineTo(rx + Math.cos(a) * 14, ry + Math.sin(a) * 14); x.stroke();
        }
      }
      x.globalAlpha = 1;
    } else {
      // empty slot
      x.fillStyle = '#020203';
      x.fillRect(w * 0.08, h * 0.38, w * 0.84, h * 0.12);
      x.fillStyle = 'rgba(200,200,215,0.3)';
      x.font = '600 26px "DejaVu Sans", sans-serif';
      x.textAlign = 'center';
      x.fillText(p.tracks.length ? `TAPE READY · ${p.tracks.length} TRACKS · PRESS ▲` : 'DROP AUDIO FILES HERE OR PRESS ▲', w / 2, h * 0.76);
      x.textAlign = 'left';
    }
    // glass highlight
    gr = x.createLinearGradient(0, 0, w, h);
    gr.addColorStop(0, 'rgba(255,255,255,0.07)'); gr.addColorStop(0.35, 'rgba(255,255,255,0)');
    gr.addColorStop(0.6, 'rgba(255,255,255,0.03)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, w, h);
    tex.needsUpdate = true;
  }
}

/* ---------------- static textures ---------------- */

function makeLedBackground() {
  const c = document.createElement('canvas');
  c.width = COLS * DOT; c.height = ROWS * DOT;
  const x = c.getContext('2d')!;
  x.fillStyle = '#010503';
  x.fillRect(0, 0, c.width, c.height);
  const [r, g, b] = LED_RGB;
  x.fillStyle = `rgba(${r},${g},${b},0.075)`;
  x.beginPath();
  for (let row = 0; row < ROWS; row++) for (let col = 1; col < COLS - 1; col++) {
    if (row === 0 || row === ROWS - 1 || row === 8 || row === 17 || row === 18) continue;
    const cx = col * DOT + DOT / 2, cy = row * DOT + DOT / 2;
    x.moveTo(cx + 4, cy); x.arc(cx, cy, 4, 0, TAU);
  }
  x.fill();
  return c;
}

function buttonLabel(text: string, w: number) {
  const { ctx: x, canvas: c, tex } = liveCanvas(Math.round(w * 4000), 112);
  const gr = x.createLinearGradient(0, 0, 0, c.height);
  gr.addColorStop(0, '#2a2b33'); gr.addColorStop(0.5, '#1a1b21'); gr.addColorStop(1, '#101116');
  x.fillStyle = gr; x.fillRect(0, 0, c.width, c.height);
  x.strokeStyle = 'rgba(255,255,255,0.12)'; x.lineWidth = 3;
  x.strokeRect(2, 2, c.width - 4, c.height - 4);
  x.fillStyle = '#ffb867';
  x.shadowColor = 'rgba(255,140,40,0.8)'; x.shadowBlur = 6;
  x.font = `bold ${text.length > 3 ? 40 : 52}px "DejaVu Sans", Arial, sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, c.width / 2, c.height / 2 + 2);
  tex.needsUpdate = true;
  return tex;
}

function drawFaceplate(x: CanvasRenderingContext2D, c: HTMLCanvasElement) {
  const w = c.width, h = c.height;
  // brushed dark metal
  const gr = x.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#2a2c34'); gr.addColorStop(0.5, '#191a20'); gr.addColorStop(1, '#101115');
  x.fillStyle = gr; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) {
    x.fillStyle = `rgba(255,255,255,${Math.random() * 0.035})`;
    x.fillRect(0, Math.random() * h, w, 1);
  }
  // recesses for door and display
  for (const r of [DOOR, DISP]) {
    const X = fx(r.x - r.w / 2) - 8, Y = fy(r.y + r.h / 2) - 8, RW = r.w * FP_SCALE + 16, RH = r.h * FP_SCALE + 16;
    x.fillStyle = '#050507'; roundRect(x, X, Y, RW, RH, 10); x.fill();
    x.strokeStyle = 'rgba(255,255,255,0.10)'; x.lineWidth = 2; roundRect(x, X, Y, RW, RH, 10); x.stroke();
  }
  // button wells + knob well
  x.fillStyle = '#07070a';
  for (const b of BUTTONS) {
    roundRect(x, fx(b.x - b.w / 2) - 5, fy(ROW_Y + 0.014) - 5, b.w * FP_SCALE + 10, 0.028 * FP_SCALE + 10, 6); x.fill();
  }
  x.beginPath(); x.arc(fx(-0.275), fy(ROW_Y), 0.025 * FP_SCALE, 0, TAU); x.fill();

  // silkscreen
  x.textBaseline = 'middle';
  x.fillStyle = 'rgba(215,215,230,0.75)';
  x.font = 'italic 900 34px "Arial Black", "DejaVu Sans", sans-serif';
  x.fillText('NIGHTDRIVE', fx(-0.305), fy(-0.016));
  x.font = '600 20px "DejaVu Sans", sans-serif';
  x.fillStyle = 'rgba(255,120,60,0.85)';
  x.fillText('CR-84', fx(-0.305) + 238, fy(-0.016));
  x.fillStyle = 'rgba(200,200,215,0.55)';
  x.font = '600 17px "DejaVu Sans", sans-serif';
  x.textAlign = 'right';
  x.fillText('AUTO REVERSE  ·  DOLBY B NR  ·  STEREO CASSETTE RECEIVER', fx(0.295), fy(-0.016));
  x.textAlign = 'center';
  x.font = '600 15px "DejaVu Sans", sans-serif';
  x.fillText('VOL', fx(-0.275), fy(ROW_Y - 0.032));
  x.fillText('EJECT', fx(-0.2), fy(ROW_Y - 0.032));
  x.fillText('SEEK  ·  PLAY/STOP  ·  SEEK', fx(-0.08), fy(ROW_Y - 0.032));
  ['NIGHTRIDE', 'CHILL', 'DATA', 'SPACE', 'DARK'].forEach((nm, i) => x.fillText(nm, fx(0.03 + i * 0.053), fy(ROW_Y - 0.032)));
  x.textAlign = 'left';
}

function roundRect(x: CanvasRenderingContext2D, X: number, Y: number, w: number, h: number, r: number) {
  x.beginPath();
  x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r);
  x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath();
}

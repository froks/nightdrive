/**
 * Debug overlay (?fps): frame rate, frame-time average / worst, the main thread's
 * time per frame (JS + WebGL command submission), drawing-buffer size, and a
 * graph of the last frame times. Frame times come from the rAF timestamps, so
 * a busy GPU shows up as long frames with low main-thread time.
 */
const N = 180;
const W = 180, H = 40;

export class FpsMeter {
  private el = document.createElement('div');
  private text = document.createElement('div');
  private graph = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private frames = new Float32Array(N);
  private cpu = new Float32Array(N);
  private i = 0;
  private count = 0;
  private lastTs = -1;
  private lastText = 0;
  private start = 0;

  constructor(private bufferSize: () => [number, number]) {
    this.el.style.cssText = `position:fixed;left:10px;top:10px;z-index:3;padding:6px 8px;pointer-events:none;
      background:rgba(0,0,0,.6);color:#9fe;font:11px/1.35 ui-monospace,"DejaVu Sans Mono",monospace;white-space:pre`;
    this.graph.width = W * devicePixelRatio; this.graph.height = H * devicePixelRatio;
    this.graph.style.cssText = `display:block;width:${W}px;height:${H}px;margin-top:4px`;
    this.ctx = this.graph.getContext('2d')!;
    this.ctx.scale(devicePixelRatio, devicePixelRatio);
    this.el.append(this.text, this.graph);
    document.body.append(this.el);
  }

  /** Call at the start of the rAF callback with its timestamp. */
  begin(ts: number) {
    this.start = performance.now();
    if (this.lastTs >= 0) {
      this.frames[this.i] = ts - this.lastTs;
      this.i = (this.i + 1) % N;
      this.count = Math.min(N, this.count + 1);
    }
    this.lastTs = ts;
  }

  /** Call after the frame was rendered. */
  end() {
    this.cpu[(this.i + N - 1) % N] = performance.now() - this.start;
    const now = performance.now();
    if (now - this.lastText > 500 && this.count > 0) {
      this.lastText = now;
      this.updateText();
    }
    this.drawGraph();
  }

  private updateText() {
    // stats over the last ~second
    const n = Math.min(this.count, 60);
    let sum = 0, max = 0, cpu = 0, cpuMax = 0;
    for (let k = 1; k <= n; k++) {
      const j = (this.i - k + N) % N;
      sum += this.frames[j]; max = Math.max(max, this.frames[j]);
      cpu += this.cpu[j]; cpuMax = Math.max(cpuMax, this.cpu[j]);
    }
    const avg = sum / n;
    const [bw, bh] = this.bufferSize();
    this.text.textContent =
      `${(1000 / avg).toFixed(0).padStart(3)} fps\n` +
      `frame ${avg.toFixed(1)} ms  max ${max.toFixed(1)}\n` +
      `main  ${(cpu / n).toFixed(1)} ms  max ${cpuMax.toFixed(1)}\n` +
      `${bw}×${bh}`;
  }

  private drawGraph() {
    const x = this.ctx;
    x.clearRect(0, 0, W, H);
    // 16.7 / 33.3 ms guides; full height = 50 ms
    const y = (ms: number) => H - Math.min(H, (ms / 50) * H);
    x.fillStyle = 'rgba(255,255,255,.18)';
    x.fillRect(0, y(1000 / 60), W, 1);
    x.fillRect(0, y(1000 / 30), W, 1);
    const bw = W / N;
    for (let k = 0; k < this.count; k++) {
      const j = (this.i - this.count + k + N) % N;
      const ms = this.frames[j];
      const px = (N - this.count + k) * bw;
      x.fillStyle = ms > 25 ? '#f55' : ms > 18 ? '#fc4' : '#4e9';
      x.fillRect(px, y(ms), Math.max(1, bw), H - y(ms));
      x.fillStyle = 'rgba(120,170,255,.9)';
      x.fillRect(px, y(this.cpu[j]), Math.max(1, bw), 1);
    }
  }
}

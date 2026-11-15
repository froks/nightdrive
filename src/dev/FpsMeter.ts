/**
 * Debug overlay (?fps): frame rate, interval between rendered frames (avg / worst),
 * the frame's main-thread time (JS + WebGL command submission), its GPU time when
 * the browser offers timer queries, drawing-buffer size, and a graph.
 *
 * With a frame cap the interval just shows the cap; `main` and `gpu` are the
 * actual cost of a frame. `?fps=sync` waits for the GPU after each frame
 * (gl.finish), so `main` becomes the full CPU + GPU time in any browser; that
 * stops CPU and GPU from overlapping, so use it for measuring only.
 */
const N = 180;
const W = 180, H = 40;

/** GPU timer queries, whichever flavour the browser offers. */
interface GpuTimer {
  create(): WebGLQuery;
  begin(q: WebGLQuery): void;
  end(): void;
  /** elapsed ms, or null while not available yet */
  result(q: WebGLQuery): number | null;
  /** true if a disjoint event invalidated the queries in flight */
  disjoint(): boolean;
}

function gpuTimer(gl: WebGL2RenderingContext): GpuTimer | null {
  // Chrome: the WebGL2 extension, used through the core query API
  const e2 = gl.getExtension('EXT_disjoint_timer_query_webgl2') as any;
  if (e2) return {
    create: () => gl.createQuery()!,
    begin: q => gl.beginQuery(e2.TIME_ELAPSED_EXT, q),
    end: () => gl.endQuery(e2.TIME_ELAPSED_EXT),
    result: q => gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) ? gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 : null,
    disjoint: () => !!gl.getParameter(e2.GPU_DISJOINT_EXT),
  };
  // Firefox (webgl.enable-privileged-extensions): the WebGL1 extension, also on WebGL2 contexts
  const e1 = gl.getExtension('EXT_disjoint_timer_query' as any) as any;
  if (e1?.createQueryEXT) return {
    create: () => e1.createQueryEXT(),
    begin: q => e1.beginQueryEXT(e1.TIME_ELAPSED_EXT, q),
    end: () => e1.endQueryEXT(e1.TIME_ELAPSED_EXT),
    result: q => e1.getQueryObjectEXT(q, e1.QUERY_RESULT_AVAILABLE_EXT) ? e1.getQueryObjectEXT(q, e1.QUERY_RESULT_EXT) / 1e6 : null,
    disjoint: () => !!gl.getParameter(e1.GPU_DISJOINT_EXT),
  };
  return null;
}

export class FpsMeter {
  private el = document.createElement('div');
  private text = document.createElement('div');
  private graph = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  /** interval to the previous rendered frame, main-thread time, GPU time (NaN = unknown), per frame */
  private frames = new Float32Array(N);
  private cpu = new Float32Array(N);
  private gpu = new Float32Array(N).fill(NaN);
  private i = 0;
  private count = 0;
  private lastTs = -1;
  private lastText = 0;
  private start = 0;
  /** GPU timer queries: one per frame, read back a few frames later */
  private timer: GpuTimer | null;
  private pending: { q: WebGLQuery; slot: number }[] = [];
  private free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  constructor(
    private bufferSize: () => [number, number],
    private gl: WebGL2RenderingContext,
    private opts: { cap: number; sync: boolean },
  ) {
    this.timer = gpuTimer(gl);
    this.el.style.cssText = `position:fixed;left:10px;top:10px;z-index:3;padding:6px 8px;pointer-events:none;
      background:rgba(0,0,0,.6);color:#9fe;font:11px/1.35 ui-monospace,"DejaVu Sans Mono",monospace;white-space:pre`;
    this.graph.width = W * devicePixelRatio; this.graph.height = H * devicePixelRatio;
    this.graph.style.cssText = `display:block;width:${W}px;height:${H}px;margin-top:4px`;
    this.ctx = this.graph.getContext('2d')!;
    this.ctx.scale(devicePixelRatio, devicePixelRatio);
    this.el.append(this.text, this.graph);
    document.body.append(this.el);
  }

  /** Call at the start of a rendered frame with its rAF timestamp. */
  begin(ts: number) {
    this.start = performance.now();
    if (this.lastTs >= 0) {
      this.frames[this.i] = ts - this.lastTs;
      this.gpu[this.i] = NaN;
      this.i = (this.i + 1) % N;
      this.count = Math.min(N, this.count + 1);
    }
    this.lastTs = ts;
    if (this.timer) {
      this.active = this.free.pop() ?? this.timer.create();
      this.timer.begin(this.active);
    }
  }

  /** Call after the frame was rendered. */
  end() {
    const slot = (this.i + N - 1) % N;
    if (this.timer && this.active) {
      this.timer.end();
      this.pending.push({ q: this.active, slot });
      this.active = null;
    }
    if (this.opts.sync) this.gl.finish();
    this.cpu[slot] = performance.now() - this.start;
    this.readTimers();
    const now = performance.now();
    if (now - this.lastText > 500 && this.count > 0) {
      this.lastText = now;
      this.updateText();
    }
    this.drawGraph();
  }

  private readTimers() {
    const t = this.timer;
    if (!t) return;
    // a disjoint event (e.g. GPU frequency change) invalidates the queries in flight
    const disjoint = t.disjoint();
    while (this.pending.length) {
      const { q, slot } = this.pending[0];
      const ms = disjoint ? null : t.result(q);
      if (!disjoint && ms === null) break;
      if (ms !== null) this.gpu[slot] = ms;
      this.pending.shift();
      this.free.push(q);
    }
  }

  private updateText() {
    // stats over the last ~second of rendered frames
    const n = Math.min(this.count, this.opts.cap > 0 ? Math.max(1, Math.round(this.opts.cap)) : 60);
    let sum = 0, max = 0, cpu = 0, cpuMax = 0, gpu = 0, gpuMax = 0, gpuN = 0;
    for (let k = 1; k <= n; k++) {
      const j = (this.i - k + N) % N;
      sum += this.frames[j]; max = Math.max(max, this.frames[j]);
      cpu += this.cpu[j]; cpuMax = Math.max(cpuMax, this.cpu[j]);
      if (!Number.isNaN(this.gpu[j])) { gpu += this.gpu[j]; gpuMax = Math.max(gpuMax, this.gpu[j]); gpuN++; }
    }
    const avg = sum / n;
    const [bw, bh] = this.bufferSize();
    const row = (label: string, a: number, m: number) => `${label.padEnd(9)}${a.toFixed(1).padStart(5)} ms  max ${m.toFixed(1).padStart(5)}`;
    const gpuLine = !this.timer ? `${'gpu'.padEnd(9)}  n/a (no timer query)`
      : gpuN ? row('gpu', gpu / gpuN, gpuMax) : `${'gpu'.padEnd(9)}    …`;
    this.text.textContent =
      `${(1000 / avg).toFixed(0).padStart(3)} fps${this.opts.cap > 0 ? `  (cap ${this.opts.cap})` : ''}\n` +
      `${row('interval', avg, max)}\n` +
      `${row(this.opts.sync ? 'cpu+gpu' : 'main', cpu / n, cpuMax)}\n` +
      `${gpuLine}\n` +
      `${bw}×${bh}${this.opts.sync ? '  (sync)' : ''}`;
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
    // colour by how late a frame is vs the expected interval (the cap, else 60 Hz)
    const expect = this.opts.cap > 0 ? 1000 / this.opts.cap : 1000 / 60;
    for (let k = 0; k < this.count; k++) {
      const j = (this.i - this.count + k + N) % N;
      const ms = this.frames[j];
      const px = (N - this.count + k) * bw;
      // bars: interval (stutter); lines: main thread (blue) and GPU (orange) time of the frame
      x.fillStyle = ms > expect * 1.5 ? '#f55' : ms > expect * 1.1 ? '#fc4' : '#4e9';
      x.fillRect(px, y(ms), Math.max(1, bw), H - y(ms));
      x.fillStyle = 'rgba(120,170,255,.9)';
      x.fillRect(px, y(this.cpu[j]), Math.max(1, bw), 1);
      if (!Number.isNaN(this.gpu[j])) {
        x.fillStyle = 'rgba(255,160,60,.95)';
        x.fillRect(px, y(this.gpu[j]), Math.max(1, bw), 1);
      }
    }
  }
}

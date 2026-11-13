import { STATIONS, type Station } from './stations';

export type Mode = 'radio' | 'tape';
export type Status = 'stopped' | 'loading' | 'playing' | 'error';
export type RadioAction = 'toggle' | 'next' | 'prev' | 'eject' | 'preset1' | 'preset2' | 'preset3' | 'preset4' | 'preset5' | 'volup' | 'voldown' | 'mute';

export interface Track { name: string; url: string; }
export interface NowPlaying { artist: string; title: string; }

const STORE_KEY = 'nightdrive.radio';
const META_URL = 'https://nightride.fm/meta';

/**
 * Audio side of the car radio: internet radio (Nightride FM) or a "tape"
 * (playlist of local files). Emits 'change' whenever display-relevant state changes.
 */
export class RadioPlayer extends EventTarget {
  readonly stations: Station[] = STATIONS;
  mode: Mode = 'radio';
  status: Status = 'stopped';
  stationIndex = 0;
  tracks: Track[] = [];
  trackIndex = 0;
  volume = 0.8;
  muted = false;
  /** seconds-timestamp of the last volume change (for the display overlay) */
  volumeChangedAt = -10;
  /** set when the user asks for a tape but none is loaded */
  onNeedTape: (() => void) | null = null;

  private audio = new Audio();
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private freq: Uint8Array<ArrayBuffer> | null = null;
  private meta = new Map<string, NowPlaying>();
  private events: EventSource | null = null;
  private wantPlay = false;
  private retryTimer = 0;

  constructor() {
    super();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload = 'none';
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
      if (Number.isInteger(s.station) && s.station >= 0 && s.station < this.stations.length) this.stationIndex = s.station;
      if (typeof s.volume === 'number') this.volume = Math.min(1, Math.max(0, s.volume));
    } catch { /* storage unavailable */ }

    const a = this.audio;
    a.addEventListener('playing', () => this.setStatus('playing'));
    // robust fallback: time advancing while we want playback == playing
    a.addEventListener('timeupdate', () => { if (this.wantPlay && !a.paused && a.currentTime > 0) this.setStatus('playing'); });
    a.addEventListener('waiting', () => { if (this.wantPlay) this.setStatus('loading'); });
    a.addEventListener('error', () => this.onError());
    a.addEventListener('ended', () => {
      if (this.mode === 'tape') this.step(1);
      else this.onError();
    });
  }

  /* ---------------- public API ---------------- */

  get station() { return this.stations[this.stationIndex]; }
  get track(): Track | undefined { return this.tracks[this.trackIndex]; }
  get playing() { return this.wantPlay; }

  nowPlaying(): NowPlaying | undefined {
    return this.station.nightride ? this.meta.get(this.station.nightride) : undefined;
  }

  handle(action: RadioAction) {
    switch (action) {
      case 'toggle': this.wantPlay ? this.stop() : this.play(); break;
      case 'next': this.step(1); break;
      case 'prev': this.step(-1); break;
      case 'eject': this.eject(); break;
      case 'volup': this.setVolume(this.volume + 0.1); break;
      case 'voldown': this.setVolume(this.volume - 0.1); break;
      case 'mute': this.muted = !this.muted; this.applyVolume(); this.volumeChangedAt = performance.now() / 1000; this.emit(); break;
      default: {
        const n = parseInt(action.slice(6), 10) - 1;
        this.mode = 'radio';
        this.stationIndex = n;
        this.save();
        this.play();
      }
    }
  }

  play() {
    this.wantPlay = true;
    clearTimeout(this.retryTimer);
    this.ensureGraph();
    if (this.mode === 'radio') this.ensureMeta();
    const url = this.mode === 'radio' ? this.station.url : this.track?.url;
    if (!url) { this.wantPlay = false; this.setStatus('stopped'); return; }
    if (this.audio.src !== url || this.mode === 'radio') {
      // for live streams always reconnect so we're at the live edge
      this.audio.src = url;
    }
    this.setStatus('loading');
    this.audio.play().catch(err => {
      // NotAllowedError = autoplay policy; AbortError = superseded by a newer src
      if (err?.name === 'AbortError') return;
      this.wantPlay = false;
      this.setStatus(err?.name === 'NotAllowedError' ? 'stopped' : 'error');
    });
  }

  stop() {
    this.wantPlay = false;
    clearTimeout(this.retryTimer);
    this.audio.pause();
    if (this.mode === 'radio') {
      // drop the stream connection instead of buffering in the background
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.setStatus('stopped');
  }

  step(dir: 1 | -1) {
    if (this.mode === 'tape') {
      if (!this.tracks.length) return;
      this.trackIndex = (this.trackIndex + dir + this.tracks.length) % this.tracks.length;
      this.audio.src = this.track!.url;
    } else {
      this.stationIndex = (this.stationIndex + dir + this.stations.length) % this.stations.length;
      this.save();
    }
    if (this.wantPlay) this.play();
    else this.emit();
  }

  eject() {
    if (this.mode === 'tape') {
      // eject the tape -> back to radio (tape stays in memory; insert again with EJECT)
      this.audio.pause();
      this.mode = 'radio';
      if (this.wantPlay) this.play(); else this.stop();
    } else if (this.tracks.length) {
      this.stop();
      this.mode = 'tape';
      this.play();
    } else {
      this.onNeedTape?.();
    }
  }

  /** Insert a "tape": a list of audio files (e.g. from drag & drop or a file picker). */
  loadTape(files: File[]) {
    const audio = files.filter(f => f.type.startsWith('audio/') || /\.(mp3|ogg|oga|opus|m4a|aac|flac|wav|webm)$/i.test(f.name));
    if (!audio.length) return;
    for (const t of this.tracks) URL.revokeObjectURL(t.url);
    audio.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    this.tracks = audio.map(f => ({
      name: f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/^\d+[\s.\-_]+/, ''),
      url: URL.createObjectURL(f),
    }));
    this.trackIndex = 0;
    if (this.mode === 'radio') this.stop();
    this.mode = 'tape';
    this.audio.src = this.tracks[0].url;
    this.play();
  }

  setVolume(v: number) {
    this.volume = Math.round(Math.min(1, Math.max(0, v)) * 10) / 10;
    this.muted = false;
    this.applyVolume();
    this.volumeChangedAt = performance.now() / 1000;
    this.save();
    this.emit();
  }

  /** Fill `out` with log-spaced band levels 0..1 (zeros when silent). */
  spectrum(out: Float32Array) {
    if (!this.analyser || !this.freq || this.status !== 'playing') { out.fill(0); return out; }
    this.analyser.getByteFrequencyData(this.freq);
    const n = this.freq.length, bands = out.length;
    const lo = 2, hi = n * 0.7;
    for (let b = 0; b < bands; b++) {
      const a = Math.floor(lo * Math.pow(hi / lo, b / bands));
      const z = Math.max(a + 1, Math.floor(lo * Math.pow(hi / lo, (b + 1) / bands)));
      let m = 0;
      for (let i = a; i < z; i++) m = Math.max(m, this.freq[i]);
      // tilt towards the highs so the whole analyser moves with bass-heavy music
      out[b] = Math.min(1, Math.pow(m / 255, 1.6) * (0.9 + 0.9 * b / bands));
    }
    return out;
  }

  /** Playback position for tapes (seconds), 0 for radio. */
  get position() { return this.mode === 'tape' ? this.audio.currentTime : 0; }

  /* ---------------- internals ---------------- */

  private ensureGraph() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaElementSource(this.audio);
      this.gain = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.72;
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      src.connect(this.gain).connect(this.analyser).connect(ctx.destination);
      this.ctx = ctx;
      this.applyVolume();
    } catch {
      // no WebAudio: fall back to element volume, no spectrum
      this.applyVolume();
    }
  }

  private applyVolume() {
    const v = this.muted ? 0 : this.volume * this.volume; // perceptual-ish curve
    if (this.gain) this.gain.gain.value = v;
    else this.audio.volume = v;
  }

  private ensureMeta() {
    if (this.events || typeof EventSource === 'undefined') return;
    this.events = new EventSource(META_URL);
    this.events.onmessage = e => {
      try {
        const list = JSON.parse(e.data) as { station: string; artist?: string; title?: string }[];
        let changed = false;
        for (const m of list) {
          if (!m.station || !m.title) continue;
          this.meta.set(m.station, { artist: m.artist ?? '', title: m.title });
          if (m.station === this.station.nightride) changed = true;
        }
        if (changed) this.emit();
      } catch { /* keep-alive or malformed */ }
    };
  }

  private onError() {
    if (!this.wantPlay) return;
    this.setStatus('error');
    if (this.mode === 'radio') {
      clearTimeout(this.retryTimer);
      this.retryTimer = window.setTimeout(() => { if (this.wantPlay) this.play(); }, 4000);
    }
  }

  private setStatus(s: Status) {
    if (this.status === s) return;
    this.status = s;
    this.emit();
  }

  private emit() { this.dispatchEvent(new Event('change')); }

  private save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ station: this.stationIndex, volume: this.volume })); } catch { /* ignore */ }
  }
}

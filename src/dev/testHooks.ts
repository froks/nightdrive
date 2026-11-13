import type { RadioPlayer } from '../audio/RadioPlayer';

/**
 * Dev-only helpers (only imported when import.meta.env.DEV).
 *   #test-tape   insert a generated two-track tape and show a player-state overlay
 */
export function runDevHooks(player: RadioPlayer) {
  if (location.hash !== '#test-tape') return;
  const tone = (sec: number, freq: number) => {
    const sr = 22050, n = sr * sec, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / sr * freq * Math.PI * 2) * 9000 * (0.6 + 0.4 * Math.sin(i / sr * 9)), true);
    return buf;
  };
  player.loadTape([
    new File([tone(20, 220)], '01 - Midnight Run_Sunset Cruiser.wav', { type: 'audio/wav' }),
    new File([tone(20, 330)], '02 Neon Skyline.wav', { type: 'audio/wav' }),
  ]);
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;top:0;left:0;z-index:99;background:#fff;color:#000;font:14px monospace;padding:2px 6px';
  document.body.appendChild(o);
  const a = (player as unknown as { audio: HTMLAudioElement }).audio;
  setInterval(() => {
    o.textContent = JSON.stringify({ status: player.status, mode: player.mode, track: player.trackIndex, t: a.currentTime.toFixed(2), paused: a.paused, ready: a.readyState, err: a.error?.code ?? null });
  }, 200);
}

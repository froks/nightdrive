/**
 * URL parameters:
 *   ?q=0.75        render scale (performance; device pixel ratio is capped at 1.5, so ?q=1.34 = full 2x retina);
 *                  without it the render scale drops automatically while the frame rate is too low
 *   ?scene=dusk    start scene id (see scenes/presets.ts)
 *   ?fx=0          disable VHS post-processing
 *   ?glitch=0      disable random glitch bursts
 *   ?seek=120      start N seconds into the drive
 *   ?rain          start with rain + wipers
 *   ?autoplay      start the radio immediately (needs a browser autoplay permission)
 *   ?screensaver   exit (window.close) on user input, hide UI
 *   ?stars=shader  old per-pixel star field in the sky shader (reference; slow)
 *   ?eggs=5        sky easter-egg frequency multiplier (0 = off)
 *   ?msaa=2        scene MSAA samples: 0, 2, 4 (default) or 8
 *   ?fpscap=30     render at most N frames per second (saves CPU/battery; 30 by default with ?screensaver)
 *   ?fps           debug: frame rate / frame time overlay (?fps=sync: wait for the GPU each frame,
 *                  so the overlay shows full CPU + GPU frame time in any browser)
 *   ?hide=a,b      debug: hide parts - bloom, traffic, sky, mountains, cockpit, and road
 *                  chunk parts: road, markings, heads, lampglow, poles, cones, reflections, terrain
 */
const P = new URLSearchParams(location.search);
const num = (v: string | null, d: number) => (v !== null && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : d);

export const config = {
  quality: Math.min(2, Math.max(0.25, num(P.get('q'), 1))),
  /** lower the render scale automatically when the device can't keep up (off with an explicit ?q) */
  autoQuality: !P.has('q'),
  scene: P.get('scene') ?? 'night',
  fx: P.get('fx') !== '0',
  /** random VHS glitch bursts */
  glitch: P.get('glitch') !== '0',
  seek: Math.max(0, num(P.get('seek'), 0)),
  autoplay: P.has('autoplay'),
  rain: P.has('rain'),
  screensaver: P.has('screensaver'),
  /** star field: baked point cloud, or the old per-pixel search in the sky shader */
  stars: P.get('stars') === 'shader' ? 'shader' : 'points',
  /** frequency multiplier for shooting stars, UFOs & co. */
  eggs: Math.max(0, num(P.get('eggs'), 1)),
  /** MSAA samples of the scene render target */
  msaa: [0, 2, 4, 8].includes(num(P.get('msaa'), 4)) ? num(P.get('msaa'), 4) : 4,
  /** frame rate cap, 0 = off (display refresh rate) */
  fpsCap: Math.max(0, num(P.get('fpscap'), P.has('screensaver') ? 30 : 0)),
  /** debug: frame rate overlay */
  fps: P.has('fps'),
  /** debug: gl.finish() after each frame so the overlay's time includes the GPU */
  fpsSync: P.get('fps') === 'sync',
  /** debug: parts to hide */
  hide: new Set((P.get('hide') ?? '').split(',').map(s => s.trim()).filter(Boolean)),
};

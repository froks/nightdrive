/**
 * URL parameters:
 *   ?q=0.75        render scale (performance)
 *   ?scene=dusk    start scene id (see scenes/presets.ts)
 *   ?fx=0          disable VHS post-processing
 *   ?glitch=0      disable random glitch bursts
 *   ?seek=120      start N seconds into the drive
 *   ?rain          start with rain + wipers
 *   ?autoplay      start the radio immediately (needs a browser autoplay permission)
 *   ?screensaver   exit (window.close) on user input, hide UI
 *   ?eggs=5        sky easter-egg frequency multiplier (0 = off)
 *   ?hide=a,b      debug: hide parts - bloom, traffic, sky, mountains, cockpit, and road
 *                  chunk parts: road, markings, heads, lampglow, poles, cones, reflections, terrain
 */
const P = new URLSearchParams(location.search);
const num = (v: string | null, d: number) => (v !== null && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : d);

export const config = {
  quality: Math.min(2, Math.max(0.25, num(P.get('q'), 1))),
  scene: P.get('scene') ?? 'night',
  fx: P.get('fx') !== '0',
  /** random VHS glitch bursts */
  glitch: P.get('glitch') !== '0',
  seek: Math.max(0, num(P.get('seek'), 0)),
  autoplay: P.has('autoplay'),
  rain: P.has('rain'),
  screensaver: P.has('screensaver'),
  /** frequency multiplier for shooting stars, UFOs & co. */
  eggs: Math.max(0, num(P.get('eggs'), 1)),
  /** debug: parts to hide */
  hide: new Set((P.get('hide') ?? '').split(',').map(s => s.trim()).filter(Boolean)),
};

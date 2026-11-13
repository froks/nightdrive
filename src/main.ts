import './style.css';
import * as THREE from 'three';
import { config } from './config';
import { presets, presetById } from './scenes/presets';
import type { ScenePreset } from './scenes/types';
import { Track, makeFrame } from './world/Track';
import { ChunkManager } from './world/Chunks';
import { Sky } from './world/Sky';
import { Mountains } from './world/Mountains';
import { Traffic } from './world/Traffic';
import { SkyEvents } from './world/SkyEvents';
import { Cockpit } from './cockpit/Cockpit';
import { Rain } from './world/Rain';
import { Post } from './fx/Post';
import { rand, smoothstep } from './util/math';
import { setGlowViewport } from './util/materials';
import { RadioPlayer, type RadioAction } from './audio/RadioPlayer';
import { initRadioInput } from './input/radioInput';

/* ---------- renderer / scene ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 6000);
scene.add(camera);

let preset: ScenePreset = presetById(config.scene);

const track = new Track();
const sky = new Sky(preset);
const mountains = new Mountains(preset);
const chunks = new ChunkManager(track, preset);
const traffic = new Traffic(track, preset, config.seek * 33);
const groundRay = new THREE.Raycaster(), DOWN = new THREE.Vector3(0, -1, 0);
const skyEvents = new SkyEvents(preset, config.eggs, {
  terrainHit: ray => chunks.terrainHit(ray),
  groundAhead: (ahead, lateral) => {
    // drop a ray onto the terrain at that spot
    const p = track.point(sim.pos + ahead, lateral, 0, new THREE.Vector3());
    groundRay.set(new THREE.Vector3(p.x - origin.x, p.y - origin.y + 600, p.z - origin.z), DOWN);
    groundRay.far = 1500;
    const d = chunks.terrainHit(groundRay);
    return Number.isFinite(d) ? p.setY(p.y + 600 - d) : null;
  },
  roadPoint: (s, lateral, height, out) => track.point(s, lateral, height, out),
  carPos: () => sim.pos,
  speed: () => sim.speed,
  glitch: () => { if (config.glitch) sim.glitch = Math.max(sim.glitch, 0.8); },
});
const cockpit = new Cockpit(preset);
camera.add(cockpit.group);
const rain = new Rain();
if (config.rain) { cockpit.toggleRain(); cockpit.rain = 1; }
camera.add(rain.mesh);

// "curtain" just outside the windshield: fades the world (not the cockpit) for scene changes
const curtain = new THREE.Mesh(
  new THREE.SphereGeometry(2.4, 32, 16),
  new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthWrite: false, fog: false }),
);
curtain.renderOrder = 15; // after world glows/rain, before windshield drops
curtain.visible = false;
camera.add(curtain);
scene.add(sky.group, skyEvents.group, mountains.group, chunks.root, traffic.group);

const hemi = new THREE.HemisphereLight();
const moon = new THREE.DirectionalLight();
moon.position.set(-0.3, 0.8, -1);
scene.add(hemi, moon);

const post = new Post(renderer, scene, camera);

const player = new RadioPlayer();
cockpit.radio.attach(player);

function applyPreset(p: ScenePreset) {
  preset = p;
  scene.fog = new THREE.FogExp2(p.fog.color, p.fog.density);
  hemi.color.set(p.light.hemiSky);
  hemi.groundColor.set(p.light.hemiGround);
  hemi.intensity = p.light.hemi;
  moon.color.set(p.light.moon);
  moon.intensity = p.light.moonIntensity;
  sky.setPreset(p);
  skyEvents.setPreset(p);
  mountains.setPreset(p);
  chunks.setPreset(p);
  traffic.setPreset(p, sim.pos);
  cockpit.setPreset(p);
  post.setPreset(p);
}

/* ---------- simulation state ---------- */
const sim = {
  t: config.seek,
  pos: config.seek * 33,
  speed: 33,
  heading: 0,
  headingAvg: 0,
  steer: 0,
  glitch: 0,
  nextGlitch: 6 + rand() * 10,
  paused: false,
  /** the car waits at the start until the first user interaction */
  started: false,
  /** 0..1 acceleration ramp after starting */
  throttle: 0,
};
// skip the start gate for the screensaver, deep links and explicit autoplay
if (config.screensaver || config.seek > 0 || config.autoplay) {
  sim.started = true;
  sim.throttle = config.autoplay && !config.screensaver && config.seek === 0 ? 0 : 1;
}
const origin = new THREE.Vector3();
const frame = makeFrame();
const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
applyPreset(preset);

function update(dt: number) {
  sim.t += dt;
  const t = sim.t;
  if (sim.started) sim.throttle = Math.min(1, sim.throttle + dt / 9);
  const go = smoothstep(0, 1, sim.throttle);
  const cruise = 33 + 4 * Math.sin(t * 0.05) + 1.5 * Math.sin(t * 0.17);
  sim.speed = cruise * go;
  sim.pos += sim.speed * dt;
  track.ensure(sim.pos + 1300);
  track.trim(sim.pos - 200);

  const k = track.curvature(sim.pos);
  track.frame(sim.pos, frame);
  sim.heading = frame.heading;
  sim.headingAvg += (sim.heading - sim.headingAvg) * Math.min(1, dt * 0.03);
  sim.steer += ((-k * 900) - sim.steer) * Math.min(1, dt * 2.5);

  // camera: driver's eye in the right lane, looking a bit ahead along the road
  const lateral = 1.75 + (0.18 * Math.sin(t * 0.21) + k * 150) * go;
  const idle = Math.sin(t * 31) * 0.0012 * (1 - go); // engine idle shake while waiting
  const bob = idle + (Math.sin(t * 9.1) * 0.004 + Math.sin(t * 2.3 + Math.sin(sim.pos * 0.05)) * 0.008) * go;
  track.point(sim.pos, lateral, 1.2 + bob, v0);
  if (v0.distanceTo(origin) > 3000) origin.copy(v0).round();
  camera.position.subVectors(v0, origin);
  track.point(sim.pos + 22, lateral + k * 40, 1.05, v1).sub(origin);
  camera.up.set(0, 1, 0);
  camera.lookAt(v1);
  camera.rotateX(0.075);
  camera.rotateZ(-k * 12);

  // world
  chunks.update(sim.pos, origin);
  traffic.update(dt, sim.pos, sim.speed, t, origin);
  track.point(sim.pos + 900, 0, 0, v2).sub(origin).sub(camera.position);
  sky.update(camera.position, sim.headingAvg, v2, t, dt);
  mountains.update(camera.position, v0.y - origin.y - 1.2);
  skyEvents.update(dt, camera.position, sim.heading, origin);

  cockpit.update({
    t,
    speedKmh: sim.speed * 3.6,
    // idle ~1000 rpm, then climbing with the acceleration ramp
    rpm: 0.12 + 0.01 * Math.sin(t * 23) + (0.3 + (sim.speed - 29) / 25 + 0.02 * Math.sin(t * 7)) * Math.min(1, sim.throttle * 1.6),
    steer: sim.steer,
    odoKm: sim.pos / 1000,
  });

  sim.nextGlitch -= dt;
  if (sim.nextGlitch <= 0) { if (config.glitch) sim.glitch = 1; sim.nextGlitch = 8 + rand() * 18; }
  sim.glitch = Math.max(0, sim.glitch - dt * 3.5);
}

/* ---------- scene change: washer sweep + fade the world through black ---------- */
let transition: { t: number; next: ScenePreset; swapped: boolean } | null = null;
const FADE_OUT = 0.7, FADE_IN = 1.0;
function changeScene(next = presets[(presets.indexOf(preset) + 1) % presets.length]) {
  if (transition) return;
  transition = { t: 0, next, swapped: false };
  cockpit.wipe();
}
function updateTransition(dt: number) {
  if (!transition) return;
  const tr = transition;
  tr.t += dt;
  if (!tr.swapped && tr.t >= FADE_OUT) {
    tr.swapped = true;
    applyPreset(tr.next);
    for (let i = 0; i < 12; i++) chunks.update(sim.pos, origin); // rebuild the road while it's dark
  }
  const f = tr.t < FADE_OUT ? tr.t / FADE_OUT : 1 - (tr.t - FADE_OUT) / FADE_IN;
  const a = Math.max(0, Math.min(1, f));
  (curtain.material as THREE.MeshBasicMaterial).opacity = a * a * (3 - 2 * a);
  curtain.visible = a > 0;
  if (tr.t >= FADE_OUT + FADE_IN) { transition = null; curtain.visible = false; }
}

/* ---------- sizing ---------- */
function resize() {
  const w = innerWidth, h = innerHeight;
  let pr = Math.min(devicePixelRatio || 1, 2) * config.quality;
  const maxW = 2560 * config.quality;
  if (w * pr > maxW) pr = maxW / w;
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h);
  post.setSize(w, h, pr);
  camera.aspect = w / h;
  // keep a sensible horizontal field on portrait screens
  camera.fov = w / h < 1 ? 70 : 52;
  camera.updateProjectionMatrix();
  setGlowViewport(h * pr, camera.fov);
}
addEventListener('resize', resize);
resize();

/* ---------- loop ---------- */
let last = performance.now();
function loop() {
  // rAF timestamps can lag performance.now() (first frame, virtual time) -> clamp both ways
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  update(sim.paused ? 0 : dt);
  cockpit.radio.update(now / 1000, dt); // radio runs on wall-clock time, also while paused
  cockpit.updateWeather(dt, sim.speed);
  rain.update(dt, cockpit.rain, sim.speed, scene.fog as THREE.FogExp2 | null);
  if (scene.fog) (scene.fog as THREE.FogExp2).density = preset.fog.density * (1 + 0.7 * cockpit.rain);
  updateTransition(dt);
  post.render(sim.t, sim.glitch, fx);
  requestAnimationFrame(loop);
}

/* ---------- UI / input ---------- */
let fx = config.fx;
const hint = document.getElementById('hint')!;

if (config.screensaver) {
  hint.remove();
  document.body.classList.add('idle');
  let armed = false, start: [number, number] | null = null;
  setTimeout(() => (armed = true), 1500);
  const quit = () => { if (armed) window.close(); };
  addEventListener('keydown', quit);
  addEventListener('mousedown', quit);
  addEventListener('touchstart', quit);
  addEventListener('mousemove', e => {
    if (!start) { start = [e.clientX, e.clientY]; return; }
    if (Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 20) quit();
  });
} else {
  // hint stays up until the drive starts
  let idle = 0;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idle);
    idle = window.setTimeout(() => document.body.classList.add('idle'), 2000);
  };
  addEventListener('mousemove', wake);
  wake();
  const toggleFs = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
  };
  const radioUi = initRadioInput({ player, cockpit, camera, fxEnabled: () => fx, onWash: () => changeScene() });
  addEventListener('dblclick', e => { if (!radioUi.isOverRadio(e)) toggleFs(); });
  addEventListener('keydown', e => {
    switch (e.key.toLowerCase()) {
      case 'f': toggleFs(); break;
      case 'm': fx = !fx; break;
      case 'g': sim.glitch = 1; break;
      case 'n': changeScene(); break;
      case 'r': cockpit.toggleRain(); break;
      case ' ': sim.paused = !sim.paused; e.preventDefault(); break;
      default: {
        const a = radioKey(e.key);
        if (a) { radioUi.trigger(a); e.preventDefault(); }
      }
    }
  });
}

function radioKey(key: string): RadioAction | null {
  if (/^[1-5]$/.test(key)) return `preset${key}` as RadioAction;
  switch (key) {
    case 'p': case 'P': case 'Enter': return 'toggle';
    case 'ArrowRight': case '.': return 'next';
    case 'ArrowLeft': case ',': return 'prev';
    case 'e': case 'E': return 'eject';
    case '+': case '=': case 'ArrowUp': return 'volup';
    case '-': case 'ArrowDown': return 'voldown';
    case '0': return 'mute';
  }
  return null;
}
if (config.autoplay) player.play();

/* ---------- start gate: first click / key starts the music and the car ---------- */
function startDriving() {
  if (sim.started) return;
  sim.started = true;
  // the starting key press must not leave the car paused (Space is both "any key" and pause,
  // and the keydown handler toggling pause runs before this one)
  sim.paused = false;
  cockpit.radio.setPrompt(null);
  setTimeout(() => hint.classList.add('hide'), 5000);
  // let a radio button that was clicked first take precedence, then start the music
  // (still inside the user-activation window, so the browser allows audio)
  setTimeout(() => { if (player.status === 'stopped' && player.mode === 'radio') player.play(); }, 0);
}
if (sim.started) setTimeout(() => hint.classList.add('hide'), 4500);
else {
  cockpit.radio.setPrompt(['PRESS ANY KEY', 'TO START DRIVING']);
  addEventListener('pointerdown', e => { if (e.button === 0) startDriving(); });
  addEventListener('keydown', startDriving);
}
if (import.meta.env.DEV) void import('./dev/testHooks').then(m => m.runDevHooks(player));

// pre-build the visible road before the first frame
update(0);
sim.headingAvg = sim.heading;
for (let i = 0; i < 12; i++) chunks.update(sim.pos, origin);
requestAnimationFrame(loop);

// expose for debugging in the console
Object.assign(window, { nightdrive: { sim, scene, camera, post, renderer, player, applyPreset, presets, skyEvents } });

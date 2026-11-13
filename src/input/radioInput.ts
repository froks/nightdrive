import * as THREE from 'three';
import type { RadioAction, RadioPlayer } from '../audio/RadioPlayer';
import type { Cockpit } from '../cockpit/Cockpit';

interface Opts {
  player: RadioPlayer;
  cockpit: Cockpit;
  camera: THREE.Camera;
  /** whether the VHS barrel distortion is active (affects picking) */
  fxEnabled: () => boolean;
  /** WASH switch pressed (change scenery) */
  onWash: () => void;
  /** DIM switch pressed */
  onDim: () => void;
}

/**
 * Mouse / drag & drop / media-key handling for the car radio.
 */
export function initRadioInput({ player, cockpit, camera, fxEnabled, onWash, onDim }: Opts) {
  const radio = cockpit.radio;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function pick(e: MouseEvent): THREE.Object3D | null {
    let x = (e.clientX / innerWidth) * 2 - 1, y = -(e.clientY / innerHeight) * 2 + 1;
    if (fxEnabled()) {
      // undo the VHS pass barrel distortion (u = p * (1 + 0.025 r²))
      const k = 1 + 0.025 * (x * x + y * y);
      x *= k; y *= k;
    }
    ndc.set(x, y);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(cockpit.interactive, false)[0]?.object ?? null;
  }

  function trigger(a: RadioAction) {
    radio.press(a);
    click();
    player.handle(a);
  }

  addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const o = pick(e);
    if (!o) return;
    e.preventDefault();
    if (o.userData.knob) {
      // volume knob: drag up/right to turn it up, a plain click mutes
      knobDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, acc: 0, moved: false, base: player.volume };
      (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
      return;
    }
    if (o.userData.pod === 'info') {
      cockpit.flashSwitch('info');
      click();
      window.open(player.station.website, '_blank', 'noopener');
    } else if (o.userData.pod === 'wipe') {
      cockpit.flashSwitch('wipe');
      click();
      cockpit.toggleRain();
    } else if (o.userData.pod === 'dim') {
      cockpit.flashSwitch('dim');
      click();
      onDim();
    } else if (o.userData.pod === 'wash') {
      cockpit.flashSwitch('wash');
      click();
      onWash();
    } else {
      trigger(o.userData.action as RadioAction);
    }
  });
  let knobDrag: { id: number; x: number; y: number; acc: number; moved: boolean; base: number } | null = null;
  const KNOB_PX = 14; // pixels of drag per volume step
  addEventListener('pointermove', e => {
    if (knobDrag && e.pointerId === knobDrag.id) {
      const d = (e.clientX - knobDrag.x) - (e.clientY - knobDrag.y);
      if (!knobDrag.moved && Math.abs(d) < 4) return;
      knobDrag.moved = true;
      const v = Math.round((knobDrag.base + d / KNOB_PX / 10) * 10) / 10;
      if (v !== player.volume && v >= 0 && v <= 1) { player.setVolume(v); detent(); }
      document.body.style.cursor = 'grabbing';
      return;
    }
    const o = pick(e);
    document.body.style.cursor = o ? (o.userData.knob ? 'grab' : 'pointer') : '';
  });
  const endDrag = (e: PointerEvent) => {
    if (!knobDrag || e.pointerId !== knobDrag.id) return;
    if (!knobDrag.moved && e.type === 'pointerup') trigger('mute');
    knobDrag = null;
    document.body.style.cursor = '';
  };
  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);
  addEventListener('wheel', e => {
    const o = pick(e);
    if (!o || o.userData.pod) return;
    const v = player.volume;
    player.setVolume(v + (e.deltaY < 0 ? 0.1 : -0.1));
    if (player.volume !== v) detent();
    e.preventDefault();
  }, { passive: false });

  /* tape: file picker + drag & drop */
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'audio/*';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    if (input.files?.length) player.loadTape([...input.files]);
    input.value = '';
  });
  player.onNeedTape = () => input.click();
  addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  addEventListener('drop', e => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) player.loadTape(files);
  });

  /* media keys / desktop media controls (MPRIS on Linux) */
  const ms = navigator.mediaSession;
  if (ms) {
    ms.setActionHandler('play', () => player.play());
    ms.setActionHandler('pause', () => player.stop());
    ms.setActionHandler('stop', () => player.stop());
    ms.setActionHandler('nexttrack', () => trigger('next'));
    ms.setActionHandler('previoustrack', () => trigger('prev'));
    const sync = () => {
      const np = player.mode === 'radio' ? player.nowPlaying() : undefined;
      ms.metadata = new MediaMetadata({
        title: player.mode === 'tape' ? player.track?.name ?? 'Tape' : np?.title ?? player.station.name,
        artist: player.mode === 'tape' ? 'Tape' : np?.artist ?? player.station.genre,
        album: player.mode === 'tape' ? 'Nightdrive tape' : `${player.station.name} · nightride.fm`,
      });
      ms.playbackState = player.playing ? 'playing' : 'paused';
    };
    player.addEventListener('change', sync);
  }

  return {
    trigger,
    isOverRadio: (e: MouseEvent) => pick(e) !== null,
  };
}

/* soft detent tick of the volume knob */
function detent() { click(0.08, 3800); }

/* mechanical button click, synthesised */
let clickCtx: AudioContext | null = null;
function click(level = 0.25, freq = 2200) {
  try {
    clickCtx ??= new AudioContext();
    const ctx = clickCtx;
    const len = Math.floor(ctx.sampleRate * 0.025);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start();
  } catch { /* audio unavailable */ }
}

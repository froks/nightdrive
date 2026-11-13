import * as THREE from 'three';
import { glowTexture } from '../util/textures';
import { rand } from '../util/math';

/** Shared bits for the sky easter eggs (SkyEvents.ts, TimeCar.ts). */

export type SkyEventKind = 'meteor' | 'shower' | 'satellite' | 'plane' | 'ufo' | 'timecar';

export interface SkyEvent {
  kind: SkyEventKind;
  done: boolean;
  update(dt: number): void;
  dispose(): void;
}

/** Shared state the events can read: absolute camera position (for world-anchored things). */
export interface SkyCtx {
  camAbs: THREE.Vector3;
}

/** What the sky events need to know about the world below. */
export interface SkyWorld {
  /** distance to the first terrain hit along a render-space ray, Infinity if none */
  terrainHit(ray: THREE.Raycaster): number;
  /** absolute ground position `ahead` metres down the road at lateral offset `lateral`, or null */
  groundAhead(ahead: number, lateral: number): THREE.Vector3 | null;
  /** absolute point at track distance `s`, lateral offset (right +) and height above the road */
  roadPoint(s: number, lateral: number, height: number, out: THREE.Vector3): THREE.Vector3;
  /** the player's current track distance */
  carPos(): number;
  /** current car speed (m/s) */
  speed(): number;
  /** short VHS glitch burst (if enabled) */
  glitch?(): void;
}

export const UP = new THREE.Vector3(0, 1, 0);
export const rr = (a: number, b: number) => a + (b - a) * rand();
export const easeOut = (x: number) => 1 - (1 - x) ** 3;

/**
 * Additive sprite. `behindMountains` puts it in the opaque render list (with
 * additive blending) at a render order before the mountain rings, so they
 * occlude it - transparent objects would always be drawn on top of them.
 */
export function glowSprite(behindMountains: boolean) {
  const m = new THREE.SpriteMaterial({
    map: glowTexture(), transparent: !behindMountains, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false,
  });
  const s = new THREE.Sprite(m);
  s.frustumCulled = false;
  if (behindMountains) s.renderOrder = -9;
  return s;
}

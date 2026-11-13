import type { ScenePreset } from './types';

export const night: ScenePreset = {
  id: 'night',
  name: 'Galactic Night',
  exposure: 1.0,
  sky: {
    zenith: '#02030a',
    mid: '#0a0f2c',
    horizon: '#2b1f50',
    glow: '#ff4fa8',
    glowStrength: 0.55,
    starBrightness: 1.0,
    galaxy: true,
    starDrift: 0.0,
  },
  fog: { color: '#22193f', density: 0.0016 },
  terrain: { near: '#06070d', far: '#16163a', hilliness: 1 },
  mountains: { far: '#1a2046', farTop: '#2a3466', near: '#0a0d1c' },
  road: {
    asphalt: [0.006, 0.007, 0.013],
    pool: [0.035, 0.05, 0.1],
    edge: [7.0, 2.0, 0.28],
    shoulder: [3.2, 0.85, 0.12],
    center: [0.35, 2.0, 5.0],
    lane: [0.8, 0.9, 2.2],
    reflector: [5, 1.4, 0.2],
  },
  lamps: { enabled: true, spacing: 46, head: [1.5, 1.8, 2.3], glow: '#9cc4ff', cone: 0.018, reflection: 0.5 },
  light: { hemiSky: '#2a3260', hemiGround: '#05040a', hemi: 0.7, moon: '#8fa0ff', moonIntensity: 0.25 },
  cockpit: { rimA: [1.6, 0.5, 0.12], rimB: [0.35, 0.5, 1.4], fill: '#ff7a3a', fillIntensity: 1.0 },
  traffic: { headlight: [7, 8, 10], taillight: [8, 0.5, 0.6], density: 1 },
  bloom: { strength: 0.95, radius: 0.55, threshold: 0.85 },
};

export const dusk: ScenePreset = {
  id: 'dusk',
  name: 'Sunset Boulevard',
  exposure: 1.0,
  sky: {
    zenith: '#141844',
    mid: '#6a2f6e',
    horizon: '#ff8a5c',
    glow: '#ffb070',
    glowStrength: 1.0,
    starBrightness: 0.35,
    galaxy: false,
    starDrift: 0.0,
  },
  fog: { color: '#a04c66', density: 0.0012 },
  terrain: { near: '#100a16', far: '#4a2448', hilliness: 1.2 },
  mountains: { far: '#6a3060', farTop: '#8a4070', near: '#2a1430' },
  road: {
    asphalt: [0.02, 0.016, 0.03],
    pool: [0.02, 0.015, 0.02],
    edge: [6.0, 1.6, 0.4],
    shoulder: [3.0, 0.8, 0.2],
    center: [0.5, 2.0, 4.5],
    lane: [1.0, 1.0, 2.0],
    reflector: [5, 1.4, 0.2],
  },
  lamps: { enabled: true, spacing: 46, head: [1.9, 1.4, 0.8], glow: '#ffb070', cone: 0.02, reflection: 0.3 },
  light: { hemiSky: '#ff9a8a', hemiGround: '#201020', hemi: 1.3, moon: '#ffb080', moonIntensity: 0.9 },
  cockpit: { rimA: [1.8, 0.7, 0.25], rimB: [1.2, 0.4, 0.9], fill: '#ff9a5a', fillIntensity: 1.6 },
  traffic: { headlight: [6, 6, 6], taillight: [8, 0.5, 0.6], density: 0.8 },
  bloom: { strength: 0.8, radius: 0.6, threshold: 0.9 },
};

export const presets: ScenePreset[] = [night, dusk];
export const presetById = (id: string) => presets.find(p => p.id === id) ?? night;

/** HDR linear RGB triple (values may exceed 1 so bloom picks them up). */
export type HDR = [number, number, number];

/**
 * A scene preset describes the *look* of an environment. Geometry generators
 * (track, terrain, lamps, traffic) read from it, so new scenes are mostly data.
 */
export interface ScenePreset {
  id: string;
  name: string;
  exposure: number;
  sky: {
    zenith: string;
    mid: string;
    horizon: string;
    /** glow around the road's vanishing point + horizon band */
    glow: string;
    glowStrength: number;
    starBrightness: number;
    galaxy: boolean;
    /** slow rotation of the star sphere (rad/s) */
    starDrift: number;
  };
  /** frequency multipliers for rare sky events (see world/SkyEvents.ts); 0 disables */
  skyEvents: { meteors: number; satellites: number; planes: number; ufos: number; timecars: number };
  fog: { color: string; density: number };
  terrain: { near: string; far: string; hilliness: number };
  mountains: { far: string; farTop: string; near: string };
  road: {
    asphalt: HDR;
    pool: HDR;
    edge: HDR;
    shoulder: HDR;
    center: HDR;
    lane: HDR;
    reflector: HDR;
  };
  lamps: { enabled: boolean; spacing: number; head: HDR; glow: string; cone: number; reflection: number };
  light: { hemiSky: string; hemiGround: string; hemi: number; moon: string; moonIntensity: number };
  cockpit: { rimA: HDR; rimB: HDR; fill: string; fillIntensity: number };
  traffic: { headlight: HDR; taillight: HDR; density: number };
  bloom: { strength: number; radius: number; threshold: number };
}

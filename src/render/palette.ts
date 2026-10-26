/**
 * The neon palette, shared by the sky, the fog, the terrain, the aircraft and the HUD so they agree.
 * Linear-ish working values for shaders are made with `new THREE.Color(hex)` (three converts sRGB hex to linear).
 */
export const PALETTE = {
  /** Night sky at the zenith. */
  skyZenith: 0x05010d,
  /** Sky at the horizon, which is also the fog colour (distant terrain fades into it). */
  skyHorizon: 0x2a0b45,
  /** The low synthwave sun's glow at the horizon. */
  sunGlow: 0xff4fa3,
  /** Primary neon: grid lines, the aircraft's edges. */
  cyan: 0x22f3ff,
  /** Secondary neon: contour lines, warnings. */
  magenta: 0xff2bd6,
  /** Accent: engine exhaust, the sun. */
  amber: 0xffa230,
  /** Terrain body (very dark, so the lines carry the shape). */
  ground: 0x070512,
  /** Water body. */
  water: 0x020617,
} as const;

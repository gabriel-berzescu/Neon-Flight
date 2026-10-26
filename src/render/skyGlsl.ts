/**
 * What the sky and the terrain fog share, so the horizon is seamless: the same uniform objects (hence the same values) and the
 * same GLSL function for "the colour of the sky at the horizon in this direction". The terrain fades into exactly that colour.
 */
import * as THREE from 'three';
import { PALETTE } from './palette';

/** The sun's elevation above the horizon (degrees). It sits due north, right ahead of the player at the spawn. */
export const SUN_ELEVATION_DEG = 4.5;
/** The sun's angular radius (degrees). Big on purpose: this is the poster. */
export const SUN_RADIUS_DEG = 6.5;

const el = (SUN_ELEVATION_DEG * Math.PI) / 180;
/** Unit vector in world space pointing at the sun (north = -z). */
export const SUN_DIRECTION = new THREE.Vector3(0, Math.sin(el), -Math.cos(el));

/**
 * The sky colour at the horizon towards the horizontal world direction (dx, dz) (+x east, -z north): the terrain's fog colour that
 * way, and the colour of the sky at and just above the horizon line. The same function as skyHorizonColor() in GLSL below.
 * Use it to fog or tint anything else (the aircraft, particles) so that it melts into the horizon like the terrain does.
 */
export function horizonColor(dx: number, dz: number, out: THREE.Color = new THREE.Color()): THREE.Color {
  const l = Math.hypot(dx, dz);
  const sl = Math.hypot(SUN_DIRECTION.x, SUN_DIRECTION.z);
  const c = l > 1e-5 ? (dx / l) * (SUN_DIRECTION.x / sl) + (dz / l) * (SUN_DIRECTION.z / sl) : 0;
  const k = Math.max(c, 0);
  const k2 = k * k;
  const glow = k2 * k2 * 0.09 + k2 * 0.02;
  const h = SKY_UNIFORMS.uSkyHorizon.value;
  const g = SKY_UNIFORMS.uSunGlow.value;
  return out.setRGB(h.r + g.r * glow, h.g + g.g * glow, h.b + g.b * glow);
}

/** Shared uniform objects: the sky material and the terrain material both reference these very objects. */
export const SKY_UNIFORMS = {
  uSkyHorizon: { value: new THREE.Color(PALETTE.skyHorizon) },
  uSkyZenith: { value: new THREE.Color(PALETTE.skyZenith) },
  uSunGlow: { value: new THREE.Color(PALETTE.sunGlow) },
  uSunDir: { value: SUN_DIRECTION },
};

/** GLSL: the uniforms above and `skyHorizonColor(dir)`, the sky colour at the horizon towards the world-space unit vector dir. */
export const SKY_COMMON_GLSL = /* glsl */ `
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform vec3 uSunGlow;
uniform vec3 uSunDir;

vec3 skyHorizonColor(vec3 dir) {
  float l = length(dir.xz);
  vec2 sd = normalize(uSunDir.xz);
  float c = l > 1e-5 ? dot(dir.xz / l, sd) : 0.0;
  float k = max(c, 0.0);
  float k2 = k * k;
  float glow = k2 * k2 * 0.09 + k2 * 0.02;
  return uSkyHorizon + uSunGlow * glow;
}
`;

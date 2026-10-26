/**
 * World coordinates, one convention for the whole game.
 *
 * RENDER / WORLD space (three.js): metres, right-handed, Y UP.
 *   +x = east, +y = up, +z = SOUTH (so north is -z, which is where a three.js camera looks by default).
 *   y = height above sea level (JSBSim's geodetic altitude). Sea level is y = 0.
 *   The terrain functions take (x, z) in this space: `heightAt(x, z)`.
 *
 * PHYSICS space (JSBSim): a real planet (WGS84). The game's flat world is the patch around latitude 0, longitude 0, mapped
 * equirectangularly: north metres = latitude x M (meridian radius at the equator), east metres = longitude x a (equatorial radius).
 * Heights are geodetic altitudes in both. The mapping is exact at the origin; at 100 km out it is off by less than 0.02 %.
 *
 * AIRCRAFT BODY axes (JSBSim): x forward, y right wing, z down. Model axes (three.js meshes): nose along -z, right wing +x, up +y.
 */

/** WGS84 equatorial radius (m). */
export const WGS84_A = 6378137.0;
/** WGS84 first eccentricity squared. */
export const WGS84_E2 = 6.69437999014e-3;
/** Meridian radius of curvature at the equator (m): a(1 - e^2). */
export const MERIDIAN_RADIUS = WGS84_A * (1 - WGS84_E2);

export const FT = 0.3048;
export const KT = 0.514444;

/** Latitude, longitude (radians) -> world x (east), z (south). */
export function latLonToWorld(latRad: number, lonRad: number, out: { x: number; z: number }): { x: number; z: number } {
  out.x = lonRad * WGS84_A;
  out.z = -latRad * MERIDIAN_RADIUS;
  return out;
}

/** World x (east), z (south) -> latitude, longitude (radians). */
export function worldToLatLon(x: number, z: number, out: { lat: number; lon: number }): { lat: number; lon: number } {
  out.lat = -z / MERIDIAN_RADIUS;
  out.lon = x / WGS84_A;
  return out;
}

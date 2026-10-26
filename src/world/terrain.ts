/**
 * The terrain, CPU side: the single source of truth for collisions. World axes and units: see coords.ts (+x east, +y up, +z SOUTH,
 * metres, sea level y = 0).
 *
 * `baseHeightAt(x, z)` is a pure, deterministic function of two numbers (no Math.random, no state, no allocation) built from
 * integer-hashed gradient noise. `heightAt(x, z)` is that with the active canyon run carved in (setActiveCanyon: the one piece of
 * state, a precomputed field, src/world/canyon-field.ts); with none it is baseHeightAt exactly. The GPU renders the very same function (src/render/terrainGlsl.ts is its GLSL twin and takes its
 * tables and parameters from this file), so the mesh you see is the surface you hit.
 *
 * Shape of the world (all tunables are in TP below):
 *   - a gentle domain warp bends everything so nothing lines up on a grid;
 *   - a low-frequency "continent" field sets the base elevation: seas and lakes where it is below zero, plains and plateaus above;
 *   - region masks (tens of km across) pick rolling hills and ridged mountain ranges: long belts (up to ~2500 m) with passes;
 *   - valleys: wide U-shaped corridors pulled down towards the base elevation along the zero line of a noise field, cutting through
 *     hills and mountain ranges alike (passes to fly through, fjords where they reach the coast); canyons: narrow deep slots cut
 *     into the hills and plains. Both measure their width in metres with the noise gradient, so they keep their width;
 *   - rolling detail on top, never finer than ~16 m, so a 1-2 m triangle mesh follows it within a few cm.
 *
 * Precision: the noise lattice is addressed by integer hashes (Math.imul and shifts), identical in GLSL (uint arithmetic). Every noise "slot"
 * (octave) has its own rotation, wavelength and lattice offset. The GPU never sees absolute coordinates: it gets, per slot, the
 * lattice cell and fraction of the camera-snapped origin computed here in float64 (`terrainLattice`) and adds small local offsets.
 */

import type { CanyonField } from './canyon-field';

export const SEA_LEVEL = 0;

// ------------------------------------------------------------------------------------------------------------------------
// Tunables. The shader reads them from here, so the CPU and GPU cannot drift apart.
// ------------------------------------------------------------------------------------------------------------------------
export const TP = {
  /** Where the world is cut: world (0,0) is this far into the noise field, to put an interesting place under the spawn. */
  shiftX: 48000,
  shiftZ: 277000,

  /** Domain warp amplitude (m). */
  warp: 600,

  /** Continent field -> base elevation: eb = contScale * (c - contT), c = sum of contW[i] * noise_i. */
  contScale: 1800,
  contT: -0.1,
  contW: [0.55, 0.28, 0.14, 0.07],
  /** Coast detail: a few octaves (km scale) added to the base elevation, so shores have bays and capes. Height = coastAmp * sum. */
  coastAmp: 95,
  coastDecay: 0.45,
  /** Below this base elevation the point is open sea: nothing else is evaluated. */
  seaCut: -60,
  /** The land factor rises from 0 to 1 between these base elevations (hills and mountains only grow on land). */
  landLo: -30,
  landHi: 160,

  /**
   * Mountain ranges are belts along the zero line of a low-frequency noise: mm = (1 - smoothstep(0, beltW, |n0|)) *
   * smoothstep(segLo, segHi, n1), the second noise breaking the belts into segments with gaps (passes) between them.
   */
  beltW: 0.26,
  segLo: -0.2,
  segHi: 0.08,
  /** Hill mask: smoothstep(lo, hi, 0.65 n0 + 0.35 n1). */
  hillLo: -0.2,
  hillHi: 0.25,

  /** Ridged mountains: height = mm * (mtnBase + mtnAmp * ridge), ridge in [0, 1]. */
  mtnBase: 150,
  mtnAmp: 2000,
  ridgeGain: 1.9,
  ridgeDecay: 0.45,
  /** Crest rounding per octave: eps_i = ridgeEps * ridgeEpsGrow^i (rounder crests on the finer octaves keep the mesh sag small). */
  ridgeEps: 0.04,
  ridgeEpsGrow: 1.4,
  /** Hills: height = mh * hillAmp * (sum of decaying octaves). */
  hillAmp: 600,
  hillDecay: 0.5,
  /** Ridges on the hills (outside the mountains): a small ridged layer, height = mh * (1 - mm) * hillRidgeAmp * ridge. */
  hillRidgeAmp: 300,
  hillRidgeGain: 1.7,
  hillRidgeDecay: 0.5,
  hillRidgeEps: 0.05,
  hillRidgeEpsGrow: 1.5,
  /** Fine detail (m), not warped. */
  detailAmp: 5,
  detailDecay: 0.52,

  /**
   * Valleys: where they exist (smoothstep of a noise), floor half-width and wall reach (m), how far the terrain is pulled down to
   * the floor (0..1) and the floor's depth below the base elevation (m).
   */
  valleyLo: -0.02,
  valleyHi: 0.14,
  valleyW0: 260,
  valleyW1: 1300,
  valleyPull: 0.93,
  valleyFloor: 25,
  /** Canyons: where they exist (smoothstep of a noise), floor half-width, wall reach and depth (m). */
  canyonLo: -0.02,
  canyonHi: 0.2,
  canyonW0: 55,
  canyonW1: 230,
  canyonDepth: 170,
  /** Gradient floor for the valley and canyon distance estimates (1/m), applied as a smooth maximum. */
  canyonGradMin: 2e-5,
} as const;

// ------------------------------------------------------------------------------------------------------------------------
// Noise slots: one per octave. q = M * (x, z) + off, in lattice units.
// ------------------------------------------------------------------------------------------------------------------------
const SLOT_LAMBDA: number[] = [];
const SLOT_M: number[] = [];
const SLOT_OFF: number[] = [];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x6e656f6e);

function addSlot(lambda: number): number {
  const a = rand() * Math.PI * 2;
  const c = Math.cos(a) / lambda;
  const s = Math.sin(a) / lambda;
  const ox = rand() * 4096;
  const oz = rand() * 4096;
  // q = (c x - s z, s x + c z) + off; the world shift is folded into the offset.
  SLOT_M.push(c, -s, s, c);
  SLOT_OFF.push(ox + c * TP.shiftX - s * TP.shiftZ, oz + s * TP.shiftX + c * TP.shiftZ);
  SLOT_LAMBDA.push(lambda);
  return SLOT_LAMBDA.length - 1;
}

function addOctaves(count: number, lambda0: number, lacunarity: number): number {
  const first = SLOT_LAMBDA.length;
  for (let i = 0; i < count; i++) addSlot(lambda0 / Math.pow(lacunarity, i));
  return first;
}

/** First slot index of each layer (the GLSL twin uses the same indices) and the octave counts. */
export const SLOT = {
  warp: addOctaves(2, 9500, 1.27),
  cont: addOctaves(4, 70000, 2.05),
  maskM: addOctaves(2, 40000, 2.0),
  maskH: addOctaves(2, 24000, 2.1),
  ridge: addOctaves(6, 8000, 2.07),
  hillRidge: addOctaves(3, 2600, 2.1),
  hill: addOctaves(5, 2600, 2.0),
  detail: addOctaves(4, 150, 1.95),
  canyon: addOctaves(1, 3600, 1),
  canyonMask: addOctaves(1, 9000, 1),
  valley: addOctaves(1, 9000, 1),
  valleyMask: addOctaves(1, 26000, 1),
  coast: addOctaves(3, 3200, 2.3),
} as const;
export const OCTAVES = { cont: 4, ridge: 6, hillRidge: 3, hill: 5, detail: 4, coast: 3 } as const;

export const TERRAIN_SLOT_COUNT = SLOT_LAMBDA.length;
/** Per slot: m00, m01, m10, m11 (1/metre). */
export const TERRAIN_SLOT_M = Float64Array.from(SLOT_M);
/** Per slot: wavelength (m). */
export const TERRAIN_SLOT_LAMBDA = Float64Array.from(SLOT_LAMBDA);
const M = TERRAIN_SLOT_M;
const OFF = Float64Array.from(SLOT_OFF);

/** Octaves fade out with distance from the camera on the GPU: full strength inside FADE_START wavelengths, gone at FADE_END. */
export const TERRAIN_FADE_START = 6;
export const TERRAIN_FADE_END = 16;

/**
 * For the GPU: for the origin (ox, oz) (world metres, any magnitude) the lattice cell and fraction of every slot at that point,
 * computed in float64: out[4s..4s+3] = (cellX, cellZ, fracX, fracZ). The shader adds M * (local offset) to the fraction.
 */
export function terrainLattice(ox: number, oz: number, out: Float32Array): Float32Array {
  for (let s = 0; s < TERRAIN_SLOT_COUNT; s++) {
    const i = s * 4;
    const qx = M[i] * ox + M[i + 1] * oz + OFF[s * 2];
    const qz = M[i + 2] * ox + M[i + 3] * oz + OFF[s * 2 + 1];
    const fx = Math.floor(qx);
    const fz = Math.floor(qz);
    out[i] = fx;
    out[i + 1] = fz;
    out[i + 2] = qx - fx;
    out[i + 3] = qz - fz;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------
// Gradient noise on an integer lattice. The hash is the same in GLSL (uint arithmetic wraps mod 2^32 in both).
// ------------------------------------------------------------------------------------------------------------------------
const HASH_SEED = 0x9e3779b9 | 0;
/** gradient component = (16 bits) * GRAD_SCALE - 1, in [-1, 1] */
const GRAD_SCALE = 1 / 32767.5;

function ihash(cx: number, cz: number): number {
  let h = Math.imul(cx, 0x27d4eb2d) ^ Math.imul(cz, 0x165667b1) ^ HASH_SEED;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h;
}

/** Noise of slot s at (x, z): about [-0.9, 0.9], standard deviation about 0.3. */
function nz(s: number, x: number, z: number): number {
  const i4 = s << 2;
  const i2 = s << 1;
  const qx = M[i4] * x + M[i4 + 1] * z + OFF[i2];
  const qz = M[i4 + 2] * x + M[i4 + 3] * z + OFF[i2 + 1];
  const flx = Math.floor(qx);
  const flz = Math.floor(qz);
  const fx = qx - flx;
  const fz = qz - flz;
  const ix = flx | 0;
  const iz = flz | 0;
  const h00 = ihash(ix, iz);
  const h10 = ihash(ix + 1, iz);
  const h01 = ihash(ix, iz + 1);
  const h11 = ihash(ix + 1, iz + 1);
  const fx1 = fx - 1;
  const fz1 = fz - 1;
  const a = ((h00 & 0xffff) * GRAD_SCALE - 1) * fx + ((h00 >>> 16) * GRAD_SCALE - 1) * fz;
  const b = ((h10 & 0xffff) * GRAD_SCALE - 1) * fx1 + ((h10 >>> 16) * GRAD_SCALE - 1) * fz;
  const c = ((h01 & 0xffff) * GRAD_SCALE - 1) * fx + ((h01 >>> 16) * GRAD_SCALE - 1) * fz1;
  const d = ((h11 & 0xffff) * GRAD_SCALE - 1) * fx1 + ((h11 >>> 16) * GRAD_SCALE - 1) * fz1;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  return a + ux * (b - a) + uz * (c - a) + ux * uz * (a - b - c + d);
}

/** Gradient of the last nzg() call, d/dx and d/dz (per metre): G[0], G[1]. (A typed array, so storing into it never allocates.) */
const G = new Float64Array(2);

/** Same as nz() and also leaves its gradient in G. */
function nzg(s: number, x: number, z: number): number {
  const i4 = s << 2;
  const i2 = s << 1;
  const m00 = M[i4];
  const m01 = M[i4 + 1];
  const m10 = M[i4 + 2];
  const m11 = M[i4 + 3];
  const qx = m00 * x + m01 * z + OFF[i2];
  const qz = m10 * x + m11 * z + OFF[i2 + 1];
  const flx = Math.floor(qx);
  const flz = Math.floor(qz);
  const fx = qx - flx;
  const fz = qz - flz;
  const ix = flx | 0;
  const iz = flz | 0;
  const h00 = ihash(ix, iz);
  const h10 = ihash(ix + 1, iz);
  const h01 = ihash(ix, iz + 1);
  const h11 = ihash(ix + 1, iz + 1);
  const fx1 = fx - 1;
  const fz1 = fz - 1;
  const g00x = (h00 & 0xffff) * GRAD_SCALE - 1;
  const g00z = (h00 >>> 16) * GRAD_SCALE - 1;
  const g10x = (h10 & 0xffff) * GRAD_SCALE - 1;
  const g10z = (h10 >>> 16) * GRAD_SCALE - 1;
  const g01x = (h01 & 0xffff) * GRAD_SCALE - 1;
  const g01z = (h01 >>> 16) * GRAD_SCALE - 1;
  const g11x = (h11 & 0xffff) * GRAD_SCALE - 1;
  const g11z = (h11 >>> 16) * GRAD_SCALE - 1;
  const a = g00x * fx + g00z * fz;
  const b = g10x * fx1 + g10z * fz;
  const c = g01x * fx + g01z * fz1;
  const d = g11x * fx1 + g11z * fz1;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duz = 30 * fz * fz * (fz * (fz - 2) + 1);
  const k = a - b - c + d;
  const dqx = g00x + ux * (g10x - g00x) + uz * (g01x - g00x) + ux * uz * (g00x - g10x - g01x + g11x) + dux * (uz * k + b - a);
  const dqz = g00z + ux * (g10z - g00z) + uz * (g01z - g00z) + ux * uz * (g00z - g10z - g01z + g11z) + duz * (ux * k + c - a);
  G[0] = m00 * dqx + m10 * dqz;
  G[1] = m01 * dqx + m11 * dqz;
  return a + ux * (b - a) + uz * (c - a) + ux * uz * k;
}

function smooth(x: number, e0: number, e1: number): number {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// ------------------------------------------------------------------------------------------------------------------------
// The terrain.
// ------------------------------------------------------------------------------------------------------------------------
const {
  warp: WARP, coastAmp: COAST_AMP, coastDecay: COAST_DECAY, contScale: CONT_SCALE, contT: CONT_T, seaCut: SEA_CUT, landLo: LAND_LO, landHi: LAND_HI,
  beltW: BELT_W, segLo: SEG_LO, segHi: SEG_HI, hillLo: HILL_LO, hillHi: HILL_HI,
  mtnBase: MTN_BASE, mtnAmp: MTN_AMP, ridgeGain: RIDGE_GAIN, ridgeDecay: RIDGE_DECAY, ridgeEps: RIDGE_EPS, ridgeEpsGrow: RIDGE_EPS_GROW,
  hillAmp: HILL_AMP, hillDecay: HILL_DECAY, hillRidgeAmp: HR_AMP, hillRidgeGain: HR_GAIN, hillRidgeDecay: HR_DECAY, hillRidgeEps: HR_EPS,
  hillRidgeEpsGrow: HR_EPS_GROW, detailAmp: DETAIL_AMP, detailDecay: DETAIL_DECAY,
  canyonLo: CANYON_LO, canyonHi: CANYON_HI, canyonW0: CANYON_W0, canyonW1: CANYON_W1, canyonDepth: CANYON_DEPTH, canyonGradMin: CANYON_GMIN,
  valleyLo: VALLEY_LO, valleyHi: VALLEY_HI, valleyW0: VALLEY_W0, valleyW1: VALLEY_W1, valleyPull: VALLEY_PULL, valleyFloor: VALLEY_FLOOR,
} = TP;
/** The gradient floor for the distance estimates, squared: |grad| is replaced by sqrt(|grad|^2 + floor^2), a smooth maximum (a hard clamp leaves a crease). */
const CANYON_GMIN2 = CANYON_GMIN * CANYON_GMIN;
const CONT_W0 = TP.contW[0];
const CONT_W1 = TP.contW[1];
const CONT_W2 = TP.contW[2];
const CONT_W3 = TP.contW[3];
const S_WARP = SLOT.warp;
const S_CONT = SLOT.cont;
const S_MASKM = SLOT.maskM;
const S_MASKH = SLOT.maskH;
const S_RIDGE = SLOT.ridge;
const S_HRIDGE = SLOT.hillRidge;
const S_HILL = SLOT.hill;
const S_DETAIL = SLOT.detail;
const S_CANYON = SLOT.canyon;
const S_CMASK = SLOT.canyonMask;
const S_VALLEY = SLOT.valley;
const S_VMASK = SLOT.valleyMask;
const S_COAST = SLOT.coast;
const N_RIDGE = OCTAVES.ridge;
const N_HILL = OCTAVES.hill;
const N_HRIDGE = OCTAVES.hillRidge;
const N_DETAIL = OCTAVES.detail;

/** Sum of the octave amplitudes (so the shader can fade octaves without changing the normalisation). */
function octaveNorm(decay: number, count: number): number {
  let sum = 0;
  let a = 1;
  for (let i = 0; i < count; i++) {
    sum += a;
    a *= decay;
  }
  return sum;
}
export const RIDGE_NORM = octaveNorm(RIDGE_DECAY, N_RIDGE);
export const HRIDGE_NORM = octaveNorm(HR_DECAY, N_HRIDGE);

/**
 * Ridged multifractal at (px, pz), 0..1: sharp crests where the noise crosses zero, wide flat floors, and each octave weighted by the
 * previous one so detail gathers on the ridges. Crest rounding grows with the octave, which keeps the 1-2 m mesh within a few cm.
 */
function ridged(s0: number, count: number, gain: number, decay: number, eps0: number, epsGrow: number, norm: number, px: number, pz: number): number {
  let sum = 0;
  let w = 1;
  let amp = 1;
  let eps = eps0;
  for (let i = 0; i < count; i++) {
    const n = nz(s0 + i, px, pz) * gain;
    let r = 1 - (Math.sqrt(n * n + eps * eps) - eps);
    r = r < 0 ? 0 : r;
    r *= r;
    sum += r * amp * w;
    // the next octave's weight: 0 in the valleys, 1 on the ridges, with no crease in between (a clamp would leave a line of
    // slope discontinuity along every r = 0.5 contour, which a 2 m mesh cannot follow)
    const t = r * 2 > 1 ? 1 : r * 2;
    w = t * t * (3 - 2 * t);
    amp *= decay;
    eps *= epsGrow;
  }
  return sum / norm;
}

/**
 * The base terrain's height in metres (negative below sea level): the endless world WITHOUT any canyon carved in. The canyon
 * generator lays canyons out over this (src/world/canyon.ts); everything that flies or draws uses heightAt().
 */
export function baseHeightAt(x: number, z: number): number {
  // domain warp
  const px = x + WARP * nz(S_WARP, x, z);
  const pz = z + WARP * nz(S_WARP + 1, x, z);

  // continent -> base elevation
  const c =
    CONT_W0 * nz(S_CONT, px, pz) + CONT_W1 * nz(S_CONT + 1, px, pz) + CONT_W2 * nz(S_CONT + 2, px, pz) + CONT_W3 * nz(S_CONT + 3, px, pz);
  const eb =
    CONT_SCALE * (c - CONT_T) +
    COAST_AMP * (nz(S_COAST, px, pz) + COAST_DECAY * nz(S_COAST + 1, px, pz) + COAST_DECAY * COAST_DECAY * nz(S_COAST + 2, px, pz));
  if (eb < SEA_CUT) return eb;
  const land = smooth(eb, LAND_LO, LAND_HI);

  // region masks
  const nm0 = nz(S_MASKM, px, pz);
  const mm = (1 - smooth(nm0 < 0 ? -nm0 : nm0, 0, BELT_W)) * smooth(nz(S_MASKM + 1, px, pz), SEG_LO, SEG_HI);
  const mh = smooth(0.65 * nz(S_MASKH, px, pz) + 0.35 * nz(S_MASKH + 1, px, pz), HILL_LO, HILL_HI);

  let h = eb;

  // ridged mountains
  if (mm > 0) {
    h += land * mm * (MTN_BASE + MTN_AMP * ridged(S_RIDGE, N_RIDGE, RIDGE_GAIN, RIDGE_DECAY, RIDGE_EPS, RIDGE_EPS_GROW, RIDGE_NORM, px, pz));
  }

  // hills
  if (mh > 0) {
    let sum = 0;
    let amp = 1;
    for (let i = 0; i < N_HILL; i++) {
      sum += amp * nz(S_HILL + i, px, pz);
      amp *= HILL_DECAY;
    }
    h += land * mh * HILL_AMP * sum;
    if (mm < 1) {
      h += land * mh * (1 - mm) * HR_AMP * ridged(S_HRIDGE, N_HRIDGE, HR_GAIN, HR_DECAY, HR_EPS, HR_EPS_GROW, HRIDGE_NORM, px, pz);
    }
  }

  // valleys: pulled down towards the base elevation, within VALLEY_W0..W1 metres of the noise's zero line
  const vm = land * smooth(nz(S_VMASK, px, pz), VALLEY_LO, VALLEY_HI);
  if (vm > 0) {
    const nv = nzg(S_VALLEY, px, pz);
    const gv = Math.sqrt(G[0] * G[0] + G[1] * G[1] + CANYON_GMIN2);
    const dv = (nv < 0 ? -nv : nv) / gv;
    const pull = vm * (1 - smooth(dv, VALLEY_W0, VALLEY_W1)) * VALLEY_PULL;
    if (pull > 0) h -= pull * (h - (eb - VALLEY_FLOOR));
  }

  // canyons: only on land that is not mountains, and only where the canyon mask is on
  const cm = land * (1 - mm) * smooth(nz(S_CMASK, px, pz), CANYON_LO, CANYON_HI);
  if (cm > 0) {
    const nc = nzg(S_CANYON, px, pz);
    const gc = Math.sqrt(G[0] * G[0] + G[1] * G[1] + CANYON_GMIN2);
    const dc = (nc < 0 ? -nc : nc) / gc;
    h -= cm * (1 - smooth(dc, CANYON_W0, CANYON_W1)) * CANYON_DEPTH;
  }

  // fine detail (not warped)
  {
    let sum = 0;
    let amp = 1;
    for (let i = 0; i < N_DETAIL; i++) {
      sum += amp * nz(S_DETAIL + i, x, z);
      amp *= DETAIL_DECAY;
    }
    h += land * DETAIL_AMP * sum * (0.35 + 0.65 * (mm + mh - mm * mh));
  }
  return h;
}

// ------------------------------------------------------------------------------------------------------------------------
// The active canyon run: carved into the terrain by a precomputed field (src/world/canyon-field.ts). The GPU carves the same
// field (TerrainView.setCanyon), so the picture keeps matching the physics: set both together.
// ------------------------------------------------------------------------------------------------------------------------
let activeCanyon: CanyonField | null = null;

/** Carves `field`'s canyon into heightAt / groundAt (null: the plain terrain again, exactly). */
export function setActiveCanyon(field: CanyonField | null): void {
  activeCanyon = field;
}

/** The canyon carved into heightAt / groundAt now, if any. */
export function getActiveCanyon(): CanyonField | null {
  return activeCanyon;
}

/** Terrain height in metres (negative below sea level), with the active canyon (if any) carved in. */
export function heightAt(x: number, z: number): number {
  const h = baseHeightAt(x, z);
  // (apply() returns h untouched outside the canyon's bounds: one bounds check)
  return activeCanyon === null ? h : activeCanyon.apply(h, x, z);
}

/** The solid surface: terrain, or the sea surface where the terrain is below sea level (touching water counts as a crash). */
export function groundAt(x: number, z: number): number {
  const h = heightAt(x, z);
  return h > SEA_LEVEL ? h : SEA_LEVEL;
}

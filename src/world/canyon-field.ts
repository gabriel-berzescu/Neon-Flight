/**
 * The canyon carved into the terrain: a precomputed field over the canyon's bounds that turns the base terrain height h(x, z) into
 * the carved one, the SAME way on the CPU (heightAt / groundAt in src/world/terrain.ts: the physics) and on the GPU (the terrain
 * vertex shader, src/render/terrainGlsl.ts: the picture). The shape is the one src/world/canyon.ts describes: a mesa, a canyon
 * cut into it (through mountains too), closed at the mouth, ramping up to the rim at the exit.
 *
 * Representation. A world-aligned grid over the canyon's bounds (plus a margin), CELL m between texels (16 m; 32 m for a huge
 * canyon, so the texture stays under ~16 MB: 2-11 MB for the canyons the generator makes), four float32 channels per texel:
 *   .x dist  lateral distance from the centreline (m, unsigned; FAR beyond REACH), in the canyon's own swept-normal coordinates
 *   .y s     distance along the centreline (m; < 0 behind the mouth, > length past the exit: the centreline is extended straight)
 *   .z mask  the mesa's weight (1 within `band` of the centreline, easing to 0 over `fade`; blurred, so no creases)
 *   .w mesa  the mesa's height (the rim, smoothed; exactly the local rim near the canyon)
 * and a 1-D table along the centreline (one entry per CANYON_STEP): floor, rim, half-width of the floor, wall run.
 * dist and s are nearly linear functions of position (the centreline never bends tighter than a 900 m radius), so bilinear
 * interpolation of a 16 m grid reproduces them to millimetres, and the cross-section itself is evaluated exactly from them
 * (it is far too sharp to sample: a 200 m wall over 40 m). Both sides read the same float32 numbers and interpolate the same way
 * (texelFetch + manual bilinear in the shader), so they agree to about a millimetre.
 *
 * The carve (carveHeight below, and canyonCarve in the shader):
 *   mesa:    raised = h + mask * (smax(h, mesa) - h)                         (never lowers the land)
 *   section: r = distance from the centreline (round caps beyond the two ends: the mouth's wall behind the spawn, the exit's bowl)
 *            C(r) = floor                         for r <= half
 *                   floor + S * ramp(r - half)    a wall: rounded foot over FOOT * wall, then straight at slope S, reaching the
 *                                                 rim at r = half + wall, and going on up (through anything higher)
 *                   + STEEP_Q * u^2               u = metres beyond half + wall + STEEP_START: the cut stays local
 *   result:  smin(raised, C, k)   k = C'(r) * RIM_ROUND * wall: the rim (and the lip of a cut through higher land) is rounded
 *                                 over about +-RIM_ROUND * wall horizontally
 * Every piece is C1 (smooth min/max, rounded foot), so there is no crease for the mesh to miss; the corners are tight though
 * (walls of slope 4-10), so a 2 m mesh sags up to a few decimetres at the foot and the lip of the rim: see the report in
 * sandbox/terrain-check.ts.
 */
import { CANYON_STEP, type Canyon } from './canyon';

/** The field's tunables; the shader pastes them in from here. */
export const CF = {
  /** Grid spacing (m), the default; a canyon whose grid would exceed MAX_TEXELS gets twice that. A power of two (exact 1/cell). */
  cell: 16,
  maxTexels: 1 << 20,
  /** dist and s are exact out to this lateral distance (m); beyond, dist = FAR (the cut is far above any terrain there). */
  reach: 640,
  far: 1000,
  /** Beyond this interpolated dist (with no mesa) the carve is the identity: C there is over 9 km up. */
  skip: 900,
  /** Margin around the canyon's bounds (m): the blurred mesa reaches a little beyond band + fade. */
  pad: 512,
  /** Foot rounding run, as a fraction of the wall run. */
  foot: 0.3,
  /** Rim rounding: the smooth minimum's width is k = (the cut's local slope) * rimRound * wall (m), at least kMin: the lip is
   * rounded over about +-rimRound * wall horizontally, however steep the cut is there. */
  rimRound: 0.2,
  kMin: 6,
  /** Above the rim the cut steepens: + steepQ * u^2, u = metres beyond half + wall + steepStart. */
  steepStart: 60,
  steepQ: 0.02,
  /** Smooth maximum between the land and the mesa's height (m). */
  mesaK: 40,
  /** The mesa (mask and height) is computed on a coarser grid, then box-blurred (radius in coarse cells, passes). */
  mesaCell: 64,
  blurR: 2,
  blurPasses: 3,
  /** Near the canyon the mesa's height is exactly the local rim, blending to the smoothed one between these distances (m). */
  near0: 150,
  near1: 450,
  /** Finite-difference step for the shading gradient on the GPU (m). */
  gradStep: 0.1,
} as const;

export interface CanyonField {
  readonly canyon: Canyon;
  /** Grid: texel (i, j) is at (x0 + i * cell, z0 + j * cell), i < nx, j < nz. */
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  /** nx * nz * 4 floats: dist, s, mesa mask, mesa height (see the header). Upload as an RGBA32F texture. */
  readonly data: Float32Array;
  /** n * 4 floats: floor, rim, half, wall per centreline sample. Upload as an n x 1 RGBA32F texture. */
  readonly section: Float32Array;
  readonly n: number;
  /** Centreline length (m) = (n - 1) * CANYON_STEP. */
  readonly length: number;
  /** World extent of the grid (the carve is the identity outside). */
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  /** How long buildCanyonField took (ms). */
  readonly buildMs: number;
  /** The carved height at (x, z), given the base terrain height h there. */
  apply(h: number, x: number, z: number): number;
}

const smooth01 = (t: number): number => {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
};

/** Polynomial smooth minimum (C1): min(a, b) rounded over |a - b| < k. */
function smin(a: number, b: number, k: number): number {
  let hh = 0.5 + (0.5 * (b - a)) / k;
  hh = hh < 0 ? 0 : hh > 1 ? 1 : hh;
  return b + (a - b) * hh - k * hh * (1 - hh);
}

/**
 * The carve, given the base height h, the field values (dist, s, mask, mesa) and the section (floor, rim, half, wall) at s.
 * The GLSL twin is canyonCarve() in src/render/terrainGlsl.ts: keep them in step.
 */
export function carveHeight(
  h: number, dist: number, s: number, mask: number, mesa: number,
  floor: number, rim: number, half: number, wall: number, length: number,
): number {
  // the mesa: raise the land to at least the mesa's height, weighted by the mask (smax(h, mesa) = -smin(-h, -mesa))
  const raised = h + mask * (-smin(-h, -mesa, CF.mesaK) - h);
  // the cross-section
  const depth = rim > floor ? rim - floor : 0;
  const a = CF.foot * wall;
  const slope = depth / (wall - 0.5 * a);
  const sn = s < 0 ? -s : 0;
  const sp = s > length ? s - length : 0;
  const r = Math.sqrt(dist * dist + sn * sn + sp * sp);
  const t = r - half;
  const ramp = t <= 0 ? 0 : t < a ? (t * t) / (2 * a) : t - 0.5 * a;
  const u = t - wall - CF.steepStart > 0 ? t - wall - CF.steepStart : 0;
  const cut = floor + slope * ramp + CF.steepQ * u * u;
  const k = Math.max((slope + 2 * CF.steepQ * u) * CF.rimRound * wall, CF.kMin);
  return smin(raised, cut, k);
}

/** One texel's worth of exact swept-normal coordinates, kept while rasterizing. */
interface Raster {
  dist: Float64Array;
  s: Float64Array;
}

/**
 * Rasterizes the centreline's swept-normal coordinates (s, |lateral|) into the grid, out to `reach`. Segment j runs from sample j to
 * j + 1 with the normal interpolated between the two samples' normals, so the coordinates are continuous across samples (a plain
 * nearest-segment distance would jump in s on the inside of every bend). Two straight extensions continue the centreline past
 * the mouth and the exit.
 */
function rasterize(c: Canyon, g: number, x0: number, z0: number, nx: number, nz: number, reach: number): Raster {
  const dist = new Float64Array(nx * nz).fill(CF.far);
  const s = new Float64Array(nx * nz);
  const n = c.n;
  const L = (n - 1) * CANYON_STEP;
  const ext = reach + 2 * g;
  for (let j = -1; j < n; j++) {
    let ax: number, az: number, bx: number, bz: number, nax: number, naz: number, nbx: number, nbz: number, sA: number, sB: number;
    if (j === -1) {
      bx = c.x[0];
      bz = c.z[0];
      ax = bx - c.tx[0] * ext;
      az = bz - c.tz[0] * ext;
      nax = nbx = -c.tz[0];
      naz = nbz = c.tx[0];
      sA = -ext;
      sB = 0;
    } else if (j === n - 1) {
      ax = c.x[j];
      az = c.z[j];
      bx = ax + c.tx[j] * ext;
      bz = az + c.tz[j] * ext;
      nax = nbx = -c.tz[j];
      naz = nbz = c.tx[j];
      sA = L;
      sB = L + ext;
    } else {
      ax = c.x[j];
      az = c.z[j];
      bx = c.x[j + 1];
      bz = c.z[j + 1];
      nax = -c.tz[j];
      naz = c.tx[j];
      nbx = -c.tz[j + 1];
      nbz = c.tx[j + 1];
      sA = j * CANYON_STEP;
      sB = (j + 1) * CANYON_STEP;
    }
    const ex = bx - ax;
    const ez = bz - az;
    const dnx = nbx - nax;
    const dnz = nbz - naz;
    // p = a + t e + lat * n(t), n(t) = na + t dn: cross(w - t e, na + t dn) = 0 with w = p - a, a quadratic in t
    const A2 = -(ex * dnz - ez * dnx);
    const crossENa = ex * naz - ez * nax;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx) - reach - x0) / g));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + reach - x0) / g));
    const j0 = Math.max(0, Math.ceil((Math.min(az, bz) - reach - z0) / g));
    const j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz) + reach - z0) / g));
    for (let jj = j0; jj <= j1; jj++) {
      const pz = z0 + jj * g;
      const wz = pz - az;
      const wbz = pz - bz;
      for (let ii = i0; ii <= i1; ii++) {
        const px = x0 + ii * g;
        const wx = px - ax;
        // inside this segment's wedge: f(0) and f(1) of opposite signs
        const f0 = wx * naz - wz * nax;
        const f1 = (px - bx) * nbz - wbz * nbx;
        if ((f0 > 0 && f1 > 0) || (f0 < 0 && f1 < 0)) continue;
        const B = wx * dnz - wz * dnx - crossENa;
        let t = -f0 / B;
        for (let it = 0; it < 2; it++) {
          const f = f0 + t * B + t * t * A2;
          t -= f / (B + 2 * t * A2);
        }
        if (t < -1e-9 || t > 1 + 1e-9) continue;
        const qx = nax + t * dnx;
        const qz = naz + t * dnz;
        const lat = Math.abs(((wx - t * ex) * qx + (wz - t * ez) * qz) / Math.sqrt(qx * qx + qz * qz));
        if (lat > reach) continue;
        const k = jj * nx + ii;
        if (lat < dist[k]) {
          dist[k] = lat;
          s[k] = sA + t * (sB - sA);
        }
      }
    }
  }
  return { dist, s };
}

/** Separable box blur (radius r cells), in place, clamped at the edges. */
function boxBlur(v: Float64Array, nx: number, nz: number, r: number): void {
  const tmp = new Float64Array(Math.max(nx, nz));
  const w = 2 * r + 1;
  for (let j = 0; j < nz; j++) {
    const o = j * nx;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += v[o + Math.min(nx - 1, Math.max(0, k))];
    for (let i = 0; i < nx; i++) {
      tmp[i] = sum / w;
      sum += v[o + Math.min(nx - 1, i + r + 1)] - v[o + Math.max(0, i - r)];
    }
    for (let i = 0; i < nx; i++) v[o + i] = tmp[i];
  }
  for (let i = 0; i < nx; i++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += v[Math.min(nz - 1, Math.max(0, k)) * nx + i];
    for (let j = 0; j < nz; j++) {
      tmp[j] = sum / w;
      sum += v[Math.min(nz - 1, j + r + 1) * nx + i] - v[Math.max(0, j - r) * nx + i];
    }
    for (let j = 0; j < nz; j++) v[j * nx + i] = tmp[j];
  }
}

/** The mesa's mask and height on a coarse grid: from the distance to the centreline and the rim there, then blurred. */
function mesaGrid(c: Canyon, gc: number, x0: number, z0: number, nx: number, nz: number): { mask: Float64Array; height: Float64Array } {
  // (the blur reads up to blurR * blurPasses cells beyond any texel it changes)
  const reach = c.band + c.fade + CF.pad + gc * (CF.blurR * CF.blurPasses + 1);
  const best = new Float64Array(nx * nz).fill(Infinity);
  const height = new Float64Array(nx * nz);
  const SUB = 4; // every 4th sample: 40 m chords, 0.2 m from the curve at worst
  for (let j0 = 0; j0 < c.n - 1; j0 += SUB) {
    const j1 = Math.min(c.n - 1, j0 + SUB);
    const ax = c.x[j0];
    const az = c.z[j0];
    const ex = c.x[j1] - ax;
    const ez = c.z[j1] - az;
    const ee = ex * ex + ez * ez;
    const ra = c.rim[j0];
    const rb = c.rim[j1];
    const i0 = Math.max(0, Math.ceil((Math.min(ax, ax + ex) - reach - x0) / gc));
    const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, ax + ex) + reach - x0) / gc));
    const k0 = Math.max(0, Math.ceil((Math.min(az, az + ez) - reach - z0) / gc));
    const k1 = Math.min(nz - 1, Math.floor((Math.max(az, az + ez) + reach - z0) / gc));
    for (let kk = k0; kk <= k1; kk++) {
      const wz = z0 + kk * gc - az;
      for (let ii = i0; ii <= i1; ii++) {
        const wx = x0 + ii * gc - ax;
        let t = (wx * ex + wz * ez) / ee;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = wx - t * ex;
        const dz = wz - t * ez;
        const d2 = dx * dx + dz * dz;
        const k = kk * nx + ii;
        if (d2 < best[k]) {
          best[k] = d2;
          height[k] = ra + (rb - ra) * t;
        }
      }
    }
  }
  const mask = new Float64Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) {
    if (best[k] === Infinity) continue; // far beyond the fade: mask 0 (its height is never used)
    mask[k] = 1 - smooth01((Math.sqrt(best[k]) - c.band) / c.fade);
  }
  for (let p = 0; p < CF.blurPasses; p++) {
    boxBlur(mask, nx, nz, CF.blurR);
    boxBlur(height, nx, nz, CF.blurR);
  }
  return { mask, height };
}

/** Builds the carve field for a canyon (about 50-150 ms). */
export function buildCanyonField(c: Canyon): CanyonField {
  const t0 = performance.now();
  const minX0 = c.bounds.minX - CF.pad;
  const minZ0 = c.bounds.minZ - CF.pad;
  const maxX0 = c.bounds.maxX + CF.pad;
  const maxZ0 = c.bounds.maxZ + CF.pad;
  let g: number = CF.cell;
  while (((maxX0 - minX0) / g + 2) * ((maxZ0 - minZ0) / g + 2) > CF.maxTexels) g *= 2;
  const x0 = Math.floor(minX0 / g) * g;
  const z0 = Math.floor(minZ0 / g) * g;
  const nx = Math.ceil((maxX0 - x0) / g) + 1;
  const nz = Math.ceil((maxZ0 - z0) / g) + 1;

  // the section table (float32: the CPU and the GPU read the same numbers)
  const n = c.n;
  const L = (n - 1) * CANYON_STEP;
  const section = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    section[i * 4] = c.floor[i];
    section[i * 4 + 1] = c.rim[i];
    section[i * 4 + 2] = c.half[i];
    section[i * 4 + 3] = c.wall[i];
  }
  const rimAt = (s: number): number => {
    const u = (s < 0 ? 0 : s > L ? L : s) / CANYON_STEP;
    const i = Math.min(Math.floor(u), n - 2);
    const f = u - i;
    return section[i * 4 + 1] + (section[i * 4 + 5] - section[i * 4 + 1]) * f;
  };

  const ras = rasterize(c, g, x0, z0, nx, nz, CF.reach);

  // the mesa on the coarse grid (same origin), sampled bilinearly at every fine texel
  const gc = Math.max(CF.mesaCell, g);
  const ncx = Math.ceil(((nx - 1) * g) / gc) + 1;
  const ncz = Math.ceil(((nz - 1) * g) / gc) + 1;
  const mesa = mesaGrid(c, gc, x0, z0, ncx, ncz);

  const data = new Float32Array(nx * nz * 4);
  const ratio = g / gc;
  for (let j = 0; j < nz; j++) {
    const v = j * ratio;
    const cj = Math.min(Math.floor(v), ncz - 2);
    const fv = v - cj;
    for (let i = 0; i < nx; i++) {
      const u = i * ratio;
      const ci = Math.min(Math.floor(u), ncx - 2);
      const fu = u - ci;
      const o = cj * ncx + ci;
      const bil = (a: Float64Array): number => {
        const top = a[o] + (a[o + 1] - a[o]) * fu;
        const bot = a[o + ncx] + (a[o + ncx + 1] - a[o + ncx]) * fu;
        return top + (bot - top) * fv;
      };
      const k = j * nx + i;
      const dist = ras.dist[k];
      const s = ras.s[k];
      let m = bil(mesa.mask);
      let hm = bil(mesa.height);
      if (m < 1e-6) m = 0;
      if (dist < CF.near1) hm = rimAt(s) + (hm - rimAt(s)) * smooth01((dist - CF.near0) / (CF.near1 - CF.near0));
      data[k * 4] = dist;
      data[k * 4 + 1] = s;
      data[k * 4 + 2] = m;
      data[k * 4 + 3] = hm;
    }
  }

  const inv = 1 / g;
  const nx2 = nx - 2;
  const nz2 = nz - 2;
  const row = nx * 4;
  const maxX = x0 + (nx - 1) * g;
  const maxZ = z0 + (nz - 1) * g;
  const apply = (h: number, x: number, z: number): number => {
    const u = (x - x0) * inv;
    const v = (z - z0) * inv;
    if (!(u >= 0 && v >= 0 && u <= nx - 1 && v <= nz - 1)) return h;
    let i = Math.floor(u);
    let j = Math.floor(v);
    if (i > nx2) i = nx2;
    if (j > nz2) j = nz2;
    const fu = u - i;
    const fv = v - j;
    const o = (j * nx + i) * 4;
    const o1 = o + row;
    // bilinear, in the same order as the shader: mix(mix(t00, t10, fu), mix(t01, t11, fu), fv)
    const a0 = data[o] + (data[o + 4] - data[o]) * fu;
    const b0 = data[o1] + (data[o1 + 4] - data[o1]) * fu;
    const dist = a0 + (b0 - a0) * fv;
    const a2 = data[o + 2] + (data[o + 6] - data[o + 2]) * fu;
    const b2 = data[o1 + 2] + (data[o1 + 6] - data[o1 + 2]) * fu;
    const m = a2 + (b2 - a2) * fv;
    if (m <= 0 && dist >= CF.skip) return h;
    const a1 = data[o + 1] + (data[o + 5] - data[o + 1]) * fu;
    const b1 = data[o1 + 1] + (data[o1 + 5] - data[o1 + 1]) * fu;
    const s = a1 + (b1 - a1) * fv;
    const a3 = data[o + 3] + (data[o + 7] - data[o + 3]) * fu;
    const b3 = data[o1 + 3] + (data[o1 + 7] - data[o1 + 3]) * fu;
    const hm = a3 + (b3 - a3) * fv;
    // the section at s (linear between samples, clamped to the ends)
    const w = (s < 0 ? 0 : s > L ? L : s) / CANYON_STEP;
    let si = Math.floor(w);
    if (si > n - 2) si = n - 2;
    const sf = w - si;
    const q = si * 4;
    const fl = section[q] + (section[q + 4] - section[q]) * sf;
    const rm = section[q + 1] + (section[q + 5] - section[q + 1]) * sf;
    const hf = section[q + 2] + (section[q + 6] - section[q + 2]) * sf;
    const wl = section[q + 3] + (section[q + 7] - section[q + 3]) * sf;
    return carveHeight(h, dist, s, m, hm, fl, rm, hf, wl, L);
  };

  return {
    canyon: c, cell: g, x0, z0, nx, nz, data, section, n, length: L,
    minX: x0, minZ: z0, maxX, maxZ,
    buildMs: performance.now() - t0,
    apply,
  };
}

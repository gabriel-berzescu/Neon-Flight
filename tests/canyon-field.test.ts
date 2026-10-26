import { afterEach, describe, expect, it } from 'vitest';
import { CANYON_STEP, EXIT_RUN, generateCanyon, type Canyon } from '../src/world/canyon';
import { buildCanyonField, CF, type CanyonField } from '../src/world/canyon-field';
import { baseHeightAt, getActiveCanyon, groundAt, heightAt, setActiveCanyon } from '../src/world/terrain';

/** Small deterministic generator for sample points. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The point `lat` metres to the right of centreline sample i. */
function at(c: Canyon, i: number, lat: number): [number, number] {
  return [c.x[i] - c.tz[i] * lat, c.z[i] + c.tx[i] * lat];
}

/** The world distance from (x, z) to the nearest centreline sample. */
function distToCentreline(c: Canyon, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < c.n; i++) best = Math.min(best, Math.hypot(c.x[i] - x, c.z[i] - z));
  return best;
}

// three canyons: a deep one cut through a mountain, one over the sea, one in the hills
const SEEDS = [123, 7919, 31676];
const canyons = SEEDS.map((seed) => generateCanyon(seed, baseHeightAt));
const fields = canyons.map((c) => buildCanyonField(c));

afterEach(() => setActiveCanyon(null));

describe('canyon field: the canyon carved into the terrain', () => {
  it('builds fast, into a modest texture', () => {
    for (const c of canyons) {
      let best = Infinity;
      for (let k = 0; k < 3; k++) best = Math.min(best, buildCanyonField(c).buildMs);
      const f = buildCanyonField(c);
      console.log(`canyon ${c.seed}: built in ${best.toFixed(0)} ms, ${f.nx} x ${f.nz} texels of ${f.cell} m, ${(f.data.byteLength / 1048576).toFixed(1)} MB`);
      expect(best).toBeLessThan(300);
      expect(f.data.byteLength).toBeLessThan(16 * 1048576);
      expect(f.data.every(Number.isFinite)).toBe(true);
    }
  });

  it('is the floor along the centreline, from the mouth to the exit ramp', () => {
    canyons.forEach((c, k) => {
      setActiveCanyon(fields[k]);
      let worst = 0;
      for (let i = 0; i * CANYON_STEP <= c.length - EXIT_RUN; i++) {
        worst = Math.max(worst, Math.abs(groundAt(c.x[i], c.z[i]) - c.floor[i]));
        // and anywhere across the floor
        const [x, z] = at(c, i, (i % 2 ? -0.95 : 0.95) * c.half[i]);
        worst = Math.max(worst, Math.abs(groundAt(x, z) - c.floor[i]));
      }
      expect(worst).toBeLessThan(0.01);
      // up the exit ramp the floor still follows the data until it nears the rim, then opens onto the mesa
      for (let i = Math.round((c.length - EXIT_RUN) / CANYON_STEP); i < c.n; i++) {
        if (c.rim[i] - c.floor[i] > 40) expect(Math.abs(groundAt(c.x[i], c.z[i]) - c.floor[i])).toBeLessThan(0.01);
        else expect(Math.abs(groundAt(c.x[i], c.z[i]) - c.floor[i])).toBeLessThan(12);
      }
    });
  });

  it('has walls rising from the floor to the rim, and the mesa (at least the rim) beyond', () => {
    canyons.forEach((c, k) => {
      setActiveCanyon(fields[k]);
      for (let i = 30; i * CANYON_STEP < c.length - EXIT_RUN - 100; i += 37) {
        for (const side of [-1, 1]) {
          const h0 = c.half[i];
          const w = c.wall[i];
          const depth = c.rim[i] - c.floor[i];
          let prev = -Infinity;
          for (let d = 0; d <= h0 + w; d += 1) {
            const [x, z] = at(c, i, side * d);
            const g = groundAt(x, z);
            expect(g).toBeGreaterThanOrEqual(prev - 1e-4); // the wall only rises (the floor is flat to float32 rounding)
            prev = g;
          }
          // the foot of the wall is the floor, the wall is half way up halfway across, the lip is a little rounded
          expect(groundAt(...at(c, i, side * h0))).toBeCloseTo(c.floor[i], 2);
          const mid = groundAt(...at(c, i, side * (h0 + 0.55 * w)));
          expect(mid).toBeGreaterThan(c.floor[i] + 0.35 * depth);
          expect(mid).toBeLessThan(c.floor[i] + 0.75 * depth);
          const lip = groundAt(...at(c, i, side * (h0 + w)));
          expect(lip).toBeGreaterThan(c.rim[i] - 0.15 * depth);
          // beyond the lip: the mesa, at least the rim (where the land is higher, the wall goes on up through it, and further out
          // the land is untouched)
          // (the mesa's height is the local rim near the canyon, the rim smoothed over a few hundred metres further out)
          for (const d of [h0 + w + 25, 300, 700]) {
            const [x, z] = at(c, i, side * d);
            expect(groundAt(x, z)).toBeGreaterThan(c.rim[i] - (d < 150 ? 1 : 12));
          }
          const [fx, fz] = at(c, i, side * 700);
          expect(groundAt(fx, fz)).toBeGreaterThanOrEqual(baseHeightAt(fx, fz) - 1e-6);
        }
      }
    });
  });

  it('cuts through land higher than the rim (the walls go on up)', () => {
    // canyon 123 runs through a mountain: the floor stays the floor, the land beside it stays the land
    const c = canyons[0];
    setActiveCanyon(fields[0]);
    let cut = 0;
    for (let i = 0; i < c.n; i += 10) {
      if (baseHeightAt(c.x[i], c.z[i]) > c.rim[i] + 300) {
        cut++;
        expect(groundAt(c.x[i], c.z[i])).toBeCloseTo(c.floor[i], 2);
        const [x, z] = at(c, i, 500);
        expect(groundAt(x, z)).toBeGreaterThanOrEqual(baseHeightAt(x, z) - 1e-6);
      }
    }
    expect(cut).toBeGreaterThan(20);
  });

  it('raises low land to a mesa, easing back to the plain terrain, which it leaves exactly as it was further out', () => {
    // canyon 7919 starts over the sea: the mesa makes land of it
    const c = canyons[1];
    setActiveCanyon(fields[1]);
    expect(baseHeightAt(c.x[0], c.z[0])).toBeLessThan(0);
    // (the mesa's height is the rim smoothed over a few hundred metres: within metres of the local rim)
    for (const d of [200, 400, 800]) {
      const [mx, mz] = at(c, 0, d);
      expect(groundAt(mx, mz)).toBeGreaterThan(c.rim[0] - 12);
    }
    canyons.forEach((cc, k) => {
      setActiveCanyon(fields[k]);
      const r = rng(cc.seed);
      let far = 0;
      let lowered = 0;
      for (let t = 0; t < 4000; t++) {
        const x = cc.bounds.minX + r() * (cc.bounds.maxX - cc.bounds.minX);
        const z = cc.bounds.minZ + r() * (cc.bounds.maxZ - cc.bounds.minZ);
        const d = distToCentreline(cc, x, z);
        const b = baseHeightAt(x, z);
        const h = heightAt(x, z);
        if (d > cc.band + cc.fade + CF.pad) {
          expect(h).toBe(b); // beyond the mesa and its fade: untouched
          far++;
        } else if (d > 600) {
          if (h < b - 1e-6) lowered++; // away from the cut, the mesa never lowers the land
        }
      }
      expect(far).toBeGreaterThan(100);
      expect(lowered).toBe(0);
    });
  });

  it('closes the mouth with a wall behind the spawn', () => {
    canyons.forEach((c, k) => {
      setActiveCanyon(fields[k]);
      const back = (d: number): number => groundAt(c.x[0] - c.tx[0] * d, c.z[0] - c.tz[0] * d);
      expect(back(0)).toBeCloseTo(c.floor[0], 2);
      expect(back(c.half[0] + c.wall[0] + 30)).toBeGreaterThan(c.rim[0] - 2);
      // the spawn is in the canyon, above the floor, with walls either side
      const g = groundAt(c.start.x, c.start.z);
      expect(c.start.y - g).toBeGreaterThan(50);
    });
  });

  it('setActiveCanyon(null) restores the plain terrain exactly', () => {
    const c = canyons[0];
    setActiveCanyon(fields[0]);
    expect(getActiveCanyon()).toBe(fields[0]);
    expect(heightAt(c.x[300], c.z[300])).not.toBe(baseHeightAt(c.x[300], c.z[300]));
    setActiveCanyon(null);
    expect(getActiveCanyon()).toBe(null);
    const r = rng(4);
    for (let t = 0; t < 3000; t++) {
      const x = c.bounds.minX + r() * (c.bounds.maxX - c.bounds.minX);
      const z = c.bounds.minZ + r() * (c.bounds.maxZ - c.bounds.minZ);
      expect(heightAt(x, z)).toBe(baseHeightAt(x, z));
    }
  });

  it('is continuous: no jumps anywhere (across the walls, along the canyon, round the ends)', () => {
    // between two samples 0.5 m apart, bisect towards the larger change 10 times: a continuous function's change shrinks with the
    // step (a wall of slope 12 changes 6 mm over 0.5 mm), a jump does not
    const jumpAcross = (f: CanyonField, x0: number, z0: number, x1: number, z1: number): number => {
      let ax = x0, az = z0, bx = x1, bz = z1;
      let ha = f.apply(baseHeightAt(ax, az), ax, az);
      let hb = f.apply(baseHeightAt(bx, bz), bx, bz);
      for (let k = 0; k < 10; k++) {
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        const hm = f.apply(baseHeightAt(mx, mz), mx, mz);
        if (Math.abs(hm - ha) > Math.abs(hb - hm)) {
          bx = mx; bz = mz; hb = hm;
        } else {
          ax = mx; az = mz; ha = hm;
        }
      }
      return Math.abs(hb - ha);
    };
    canyons.forEach((c, k) => {
      const f = fields[k];
      let worst = 0;
      const lines: Array<[number, number, number, number]> = [];
      // across the canyon, out to the mesa
      for (let i = 0; i < c.n; i += 23) {
        const [x0, z0] = at(c, i, -420);
        const [x1, z1] = at(c, i, 420);
        lines.push([x0, z0, x1, z1]);
      }
      // along it, on the floor, the walls and the lip, past both ends
      for (const lat of [0, 40, -55, 75, -95, 130, 200]) {
        for (let i = 0; i < c.n - 1; i += 1) {
          const [x0, z0] = at(c, i, lat);
          const [x1, z1] = at(c, i + 1, lat);
          lines.push([x0, z0, x1, z1]);
        }
        const [ex, ez] = at(c, 0, lat);
        lines.push([ex - c.tx[0] * 300, ez - c.tz[0] * 300, ex, ez]);
        const [fx, fz] = at(c, c.n - 1, lat);
        lines.push([fx, fz, fx + c.tx[c.n - 1] * 300, fz + c.tz[c.n - 1] * 300]);
      }
      for (const [x0, z0, x1, z1] of lines) {
        const len = Math.hypot(x1 - x0, z1 - z0);
        const steps = Math.ceil(len / 0.5);
        let px = x0, pz = z0;
        let ph = f.apply(baseHeightAt(px, pz), px, pz);
        for (let s = 1; s <= steps; s++) {
          const x = x0 + ((x1 - x0) * s) / steps;
          const z = z0 + ((z1 - z0) * s) / steps;
          const h = f.apply(baseHeightAt(x, z), x, z);
          if (Math.abs(h - ph) > 0.5) worst = Math.max(worst, jumpAcross(f, px, pz, x, z));
          px = x; pz = z; ph = h;
        }
      }
      expect(worst).toBeLessThan(0.05);
    });
  });

  it('is smooth: only the walls bend tighter than a 2 m mesh follows within a few cm', () => {
    // the sag of the chord over 2 m (what a 2 m mesh misses) across the canyon: large only at the foot of the walls and their lip
    // (walls of slope 4-10 turn to the flat floor and the mesa within metres)
    canyons.forEach((c, k) => {
      setActiveCanyon(fields[k]);
      let wallSag = 0;
      let mesaSag = 0;
      for (let i = 5; i < c.n - 5; i += 13) {
        for (let d = -1200; d <= 1200; d += 0.75) {
          const [ax, az] = at(c, i, d - 1);
          const [bx, bz] = at(c, i, d);
          const [cx, cz] = at(c, i, d + 1);
          const a = heightAt(ax, az);
          if (a < 5) continue;
          const hb = heightAt(bx, bz);
          const sag = Math.abs(hb - 0.5 * (a + heightAt(cx, cz)));
          // the walls: the canyon, and its cut through any higher land (where the ground is below the land, give or take the lip)
          const cut = (dd: number): boolean => {
            const [x, z] = at(c, i, dd);
            return heightAt(x, z) < baseHeightAt(x, z) - 0.01;
          };
          if (Math.abs(d) < 220 || cut(d - 15) || cut(d) || cut(d + 15)) wallSag = Math.max(wallSag, sag);
          else mesaSag = Math.max(mesaSag, sag);
        }
      }
      console.log(`canyon ${c.seed}: largest 2 m chord sag ${wallSag.toFixed(3)} m on the walls, ${mesaSag.toFixed(4)} m on the mesa`);
      expect(wallSag).toBeLessThan(0.6);
      expect(mesaSag).toBeLessThan(0.06);
    });
  });

  it('keeps heightAt fast: unchanged without a canyon (< 3 us per call), and in one', () => {
    const r = rng(2);
    const N = 100000;
    const xs = new Float64Array(N);
    const zs = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      xs[i] = (r() * 2 - 1) * 200000;
      zs[i] = (r() * 2 - 1) * 200000;
    }
    const c = canyons[0];
    const cx = new Float64Array(N);
    const cz = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const [x, z] = at(c, Math.floor(r() * c.n), (r() * 2 - 1) * 1500);
      cx[i] = x;
      cz[i] = z;
    }
    const run = (px: Float64Array, pz: Float64Array): number => {
      let best = Infinity;
      let sink = 0;
      for (let rep = 0; rep < 7; rep++) {
        const t0 = performance.now();
        for (let i = 0; i < N; i++) sink += heightAt(px[i], pz[i]);
        best = Math.min(best, ((performance.now() - t0) * 1000) / N);
      }
      expect(Number.isFinite(sink)).toBe(true);
      return best;
    };
    setActiveCanyon(null);
    const plain = run(xs, zs);
    setActiveCanyon(fields[0]);
    const outside = run(xs, zs);
    const inside = run(cx, cz);
    console.log(`heightAt: ${plain.toFixed(3)} us/call without a canyon, ${outside.toFixed(3)} with one (mostly outside it), ${inside.toFixed(3)} in and around it`);
    expect(plain).toBeLessThan(3);
    expect(outside).toBeLessThan(3);
    expect(inside).toBeLessThan(3);
  });

  it('generates complete GLSL for the shader twin', async () => {
    const { CANYON_GLSL, TERRAIN_VERT, TERRAIN_FRAG } = await import('../src/render/terrainGlsl');
    for (const src of [CANYON_GLSL, TERRAIN_VERT, TERRAIN_FRAG]) expect(src).not.toMatch(/NaN|undefined|Infinity|object Object/);
    expect(TERRAIN_VERT).toContain('canyonCarve');
    expect(TERRAIN_FRAG).toContain('canyonApply');
  });
});

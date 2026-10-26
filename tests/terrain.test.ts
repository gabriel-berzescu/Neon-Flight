import { PerformanceObserver } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { SEA_LEVEL, groundAt, heightAt, terrainLattice, TERRAIN_SLOT_COUNT, TERRAIN_SLOT_M } from '../src/world/terrain';
import { CULL_HY, CULL_YMID } from '../src/render/terrainGlsl';

/** Small deterministic generator for sample points (the terrain itself uses none). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('terrain: the CPU surface the physics collides with', () => {
  it('is deterministic and pure', () => {
    const r = rng(1);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 2000; i++) pts.push([(r() * 2 - 1) * 300000, (r() * 2 - 1) * 300000]);
    const a = pts.map(([x, z]) => heightAt(x, z));
    // other calls in between (and the reverse order) change nothing
    heightAt(1, 2);
    groundAt(-5, 9);
    const b = pts.map(([x, z]) => heightAt(x, z));
    const c = pts.slice().reverse().map(([x, z]) => heightAt(x, z)).reverse();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('is the same world as ever (golden samples: update them when the terrain is retuned on purpose)', () => {
    const golden: Array<[number, number, number]> = [
      [0, 0, 135.2614854],
      [1234.5, -6789.25, 449.42538026],
      [-250000.75, 180000.5, 241.57843057],
      [14003.5, -17001.1, -67.12200668],
      [8000, -9000, 565.4999773],
    ];
    for (const [x, z, h] of golden) expect(heightAt(x, z)).toBeCloseTo(h, 5);
  });

  it('puts the spawn on land with hills around it', () => {
    const h0 = heightAt(0, 0);
    expect(h0).toBeGreaterThan(100);
    expect(h0).toBeLessThan(900);
    // no water within 1.5 km of the spawn (a lake further out is welcome), and some relief
    let lo = Infinity;
    let hi = -Infinity;
    for (let a = 0; a < 360; a += 10) {
      for (const d of [250, 500, 1000, 1500, 2500, 3000]) {
        const h = heightAt(d * Math.sin((a * Math.PI) / 180), -d * Math.cos((a * Math.PI) / 180));
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    expect(lo).toBeGreaterThan(-5);
    for (let a = 0; a < 360; a += 10) {
      for (const d of [250, 500, 1000, 1500]) expect(heightAt(d * Math.sin((a * Math.PI) / 180), -d * Math.cos((a * Math.PI) / 180))).toBeGreaterThan(20);
    }
    expect(hi - lo).toBeGreaterThan(150);
  });

  it('has plausible ranges: seas, plains, hills and tall mountains', () => {
    const r = rng(7);
    const n = 200000;
    let min = Infinity;
    let max = -Infinity;
    let sea = 0;
    let high = 0;
    let veryHigh = 0;
    for (let i = 0; i < n; i++) {
      const h = heightAt((r() * 2 - 1) * 400000, (r() * 2 - 1) * 400000);
      if (h < min) min = h;
      if (h > max) max = h;
      if (h < SEA_LEVEL) sea++;
      if (h > 1200) high++;
      if (h > 2000) veryHigh++;
    }
    expect(min).toBeGreaterThan(-800);
    expect(min).toBeLessThan(-100); // there is deep water
    expect(max).toBeLessThan(3200);
    expect(max).toBeGreaterThan(2000); // and real mountains
    expect(sea / n).toBeGreaterThan(0.1);
    expect(sea / n).toBeLessThan(0.4);
    expect(high / n).toBeGreaterThan(0.02);
    expect(veryHigh / n).toBeGreaterThan(0.0005);
  });

  it('stays inside the height band the GPU uses for frustum culling', () => {
    const r = rng(11);
    const lo = CULL_YMID - CULL_HY;
    const hi = CULL_YMID + CULL_HY;
    for (let i = 0; i < 100000; i++) {
      const h = heightAt((r() * 2 - 1) * 1e6, (r() * 2 - 1) * 1e6);
      expect(h).toBeGreaterThan(lo);
      expect(h).toBeLessThan(hi);
    }
  });

  it('is continuous: no jumps between neighbouring samples, slopes stay physical', () => {
    const r = rng(3);
    let worst = 0;
    let steepCount = 0;
    let total = 0;
    for (let line = 0; line < 600; line++) {
      let x = (r() * 2 - 1) * 250000;
      let z = (r() * 2 - 1) * 250000;
      const a = r() * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      let prev = heightAt(x, z);
      for (let i = 0; i < 400; i++) {
        x += dx;
        z += dz;
        const h = heightAt(x, z);
        const slope = Math.abs(h - prev); // metres per metre
        if (slope > worst) worst = slope;
        if (slope > 1.5) steepCount++;
        total++;
        prev = h;
      }
    }
    expect(worst).toBeLessThan(4.5); // never a cliff: no feature is sharper than ~77 degrees
    expect(steepCount / total).toBeLessThan(0.01);
  });

  it('is smooth enough for a mesh with 2 m cells to follow it within a few cm', () => {
    // the vertex spacing near the camera is 2 m: the linear interpolation between two vertices must stay near the true surface
    // everywhere (no crease: a clamp or a hard minimum anywhere in the function would show up as a line of large sag here)
    const r = rng(5);
    const sags: number[] = [];
    for (let i = 0; i < 400000; i++) {
      const x = (r() * 2 - 1) * 300000;
      const z = (r() * 2 - 1) * 300000;
      const a = heightAt(x, z);
      if (a < 5) continue; // water is flat, and the shore line is where the physics' ground is max(h, 0) anyway
      const b = heightAt(x + 1, z);
      const c = heightAt(x + 2, z);
      const d = heightAt(x, z + 1);
      const e = heightAt(x, z + 2);
      sags.push(Math.max(Math.abs(b - 0.5 * (a + c)), Math.abs(d - 0.5 * (a + e))));
    }
    sags.sort((p, q) => p - q);
    const at = (p: number): number => sags[Math.min(sags.length - 1, Math.floor(p * sags.length))];
    expect(sags.length).toBeGreaterThan(200000);
    expect(at(0.5)).toBeLessThan(0.004);
    expect(at(0.99)).toBeLessThan(0.02);
    expect(at(0.999)).toBeLessThan(0.04);
    expect(sags[sags.length - 1]).toBeLessThan(0.1);
  });

  it('groundAt is the solid surface: never below sea level, and equal to the terrain above it', () => {
    const r = rng(9);
    let water = 0;
    for (let i = 0; i < 50000; i++) {
      const x = (r() * 2 - 1) * 300000;
      const z = (r() * 2 - 1) * 300000;
      const h = heightAt(x, z);
      const g = groundAt(x, z);
      expect(g).toBeGreaterThanOrEqual(SEA_LEVEL);
      expect(g).toBe(Math.max(h, SEA_LEVEL));
      if (h < SEA_LEVEL) water++;
    }
    expect(water).toBeGreaterThan(0);
  });

  it('is finite and sane far from the origin and at awkward coordinates', () => {
    const odd = [0, -0, 1e-9, 0.5, -0.5, 1023.9999, 1024, -1024.0001, 65536, 123456.789, -299999.5, 1e6, -1e6, 5e6];
    for (const x of odd) {
      for (const z of odd) {
        const h = heightAt(x, z);
        expect(Number.isFinite(h)).toBe(true);
        expect(Math.abs(h)).toBeLessThan(5000);
      }
    }
  });

  it('is fast: a few thousand calls per second are nothing (target < 3 us per call)', () => {
    const r = rng(2);
    const N = 100000;
    const xs = new Float64Array(N);
    const zs = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      xs[i] = (r() * 2 - 1) * 200000;
      zs[i] = (r() * 2 - 1) * 200000;
    }
    // worst case: all of it in the mountains around (8000, -18400), where every layer is evaluated
    const mx = new Float64Array(N);
    const mz = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      mx[i] = 8000 + (r() * 2 - 1) * 4000;
      mz[i] = -18400 + (r() * 2 - 1) * 4000;
    }
    const run = (px: Float64Array, pz: Float64Array): number => {
      let best = Infinity;
      let sink = 0;
      for (let rep = 0; rep < 7; rep++) {
        const t0 = performance.now();
        for (let i = 0; i < N; i++) sink += heightAt(px[i], pz[i]);
        const us = ((performance.now() - t0) * 1000) / N;
        if (us < best) best = us;
      }
      expect(Number.isFinite(sink)).toBe(true);
      return best;
    };
    const mixed = run(xs, zs);
    const mountains = run(mx, mz);
    console.log(`heightAt: ${mixed.toFixed(3)} us/call over the world, ${mountains.toFixed(3)} us/call in the mountains`);
    expect(mixed).toBeLessThan(3);
    expect(mountains).toBeLessThan(3);
  });

  it('allocates nothing per call (no garbage collection while it runs)', () => {
    for (let i = 0; i < 300000; i++) heightAt(i * 3.7 - 5e5, i * -1.3 + 2e5); // warm up, so the optimising compiler has run
    const obs = new PerformanceObserver(() => {});
    obs.observe({ entryTypes: ['gc'] });
    let sink = 0;
    for (let i = 0; i < 3000000; i++) sink += heightAt(((i * 7919) % 400000) - 200000, ((i * 104729) % 400000) - 200000);
    const events = obs.takeRecords();
    obs.disconnect();
    expect(Number.isFinite(sink)).toBe(true);
    // 3 million calls: even 16 bytes of garbage per call would be 48 MB and several scavenges
    expect(events.length).toBeLessThanOrEqual(1);
  });

  it('gives the GPU a lattice per slot that reproduces the CPU noise coordinates, far from the origin', () => {
    // The shader computes q = fraction(origin) + M * local and cell = cell(origin) + floor(q). That must be the same lattice
    // point as the CPU's q = M * (origin + local) + offset, whatever the origin: compare through terrainLattice of both points.
    const r = rng(21);
    const o = new Float32Array(TERRAIN_SLOT_COUNT * 4);
    const p = new Float32Array(TERRAIN_SLOT_COUNT * 4);
    let worst = 0;
    for (let k = 0; k < 400; k++) {
      const ox = Math.floor((r() * 2 - 1) * 150000) * 2;
      const oz = Math.floor((r() * 2 - 1) * 150000) * 2;
      const lx = (r() * 2 - 1) * 3000;
      const lz = (r() * 2 - 1) * 3000;
      terrainLattice(ox, oz, o);
      terrainLattice(ox + lx, oz + lz, p);
      for (let s = 0; s < TERRAIN_SLOT_COUNT; s++) {
        expect(Number.isInteger(o[s * 4])).toBe(true);
        expect(o[s * 4 + 2]).toBeGreaterThanOrEqual(0);
        expect(o[s * 4 + 2]).toBeLessThan(1);
        expect(o[s * 4 + 3]).toBeGreaterThanOrEqual(0);
        expect(o[s * 4 + 3]).toBeLessThan(1);
        const m = TERRAIN_SLOT_M;
        // q(point) - q(origin) computed from the two decompositions, against M * local in double
        const dqx = p[s * 4] + p[s * 4 + 2] - (o[s * 4] + o[s * 4 + 2]);
        const dqz = p[s * 4 + 1] + p[s * 4 + 3] - (o[s * 4 + 1] + o[s * 4 + 3]);
        const ex = m[s * 4] * lx + m[s * 4 + 1] * lz;
        const ez = m[s * 4 + 2] * lx + m[s * 4 + 3] * lz;
        worst = Math.max(worst, Math.abs(dqx - ex), Math.abs(dqz - ez));
      }
    }
    // float32 fractions: 6e-8 of a lattice cell each (cells are >= 20 m, so a few micrometres)
    expect(worst).toBeLessThan(2e-6);
  });

  it('generates complete GLSL for the GPU twin (no NaN, undefined or Infinity pasted in)', async () => {
    const { TERRAIN_VERT, TERRAIN_FRAG, TERRAIN_HEIGHT_GLSL } = await import('../src/render/terrainGlsl');
    for (const src of [TERRAIN_HEIGHT_GLSL, TERRAIN_VERT, TERRAIN_FRAG]) {
      expect(src).not.toMatch(/NaN|undefined|Infinity|object Object/);
    }
    expect(TERRAIN_HEIGHT_GLSL).toContain(`#define NSLOT ${TERRAIN_SLOT_COUNT}`);
    // one matrix row per slot in the table
    const rows = TERRAIN_HEIGHT_GLSL.match(/vec4\((?:-?[0-9.e-]+, ){3}-?[0-9.e-]+\)/g) ?? [];
    expect(rows.length).toBe(TERRAIN_SLOT_COUNT);
  });
});

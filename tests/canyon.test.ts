import { describe, expect, it } from 'vitest';
import { CANYON_LENGTH, CANYON_STEP, generateCanyon } from '../src/world/canyon';
import { heightAt } from '../src/world/terrain';

describe('canyon layout', () => {
  const c = generateCanyon(12345, heightAt);

  it('is deterministic for a seed, different across seeds', () => {
    const again = generateCanyon(12345, heightAt);
    expect(again.x[500]).toBe(c.x[500]);
    expect(again.gates.length).toBe(c.gates.length);
    const other = generateCanyon(999, heightAt);
    expect(Math.hypot(other.x[0] - c.x[0], other.z[0] - c.z[0])).toBeGreaterThan(1000);
  });

  it('is a continuous centreline of unit tangents, never tighter than a 1500 m radius', () => {
    expect(c.n).toBe(CANYON_LENGTH / CANYON_STEP + 1);
    for (let i = 1; i < c.n; i++) {
      expect(Math.hypot(c.x[i] - c.x[i - 1], c.z[i] - c.z[i - 1])).toBeCloseTo(CANYON_STEP, 6);
      expect(Math.hypot(c.tx[i], c.tz[i])).toBeCloseTo(1, 9);
      const turn = Math.acos(Math.min(1, c.tx[i] * c.tx[i - 1] + c.tz[i] * c.tz[i - 1]));
      expect(turn / CANYON_STEP).toBeLessThan(1 / 1499);
    }
  });

  it('has a deep floor above the sea, walls above the land, and a gentle floor slope', () => {
    let maxSlope = 0;
    for (let i = 0; i < c.n; i++) {
      expect(c.floor[i]).toBeGreaterThan(30);
      expect(c.rim[i]).toBeGreaterThanOrEqual(c.floor[i]);
      if (i > 0 && i * CANYON_STEP < CANYON_LENGTH - 750) maxSlope = Math.max(maxSlope, Math.abs(c.floor[i] - c.floor[i - 1]) / CANYON_STEP);
      if (i * CANYON_STEP < CANYON_LENGTH - 800) expect(c.rim[i] - c.floor[i]).toBeGreaterThan(140);
    }
    expect(maxSlope).toBeLessThan(0.06); // (the exit ramp at the end is steeper on purpose)
  });

  it('places gates inside the canyon, below the rim, getting smaller', () => {
    expect(c.gates.length).toBeGreaterThanOrEqual(15);
    for (const g of c.gates) {
      const i = Math.round(g.s / CANYON_STEP);
      const lateral = (g.x - c.x[i]) * -c.tz[i] + (g.z - c.z[i]) * c.tx[i];
      expect(Math.abs(lateral) + g.width / 2).toBeLessThanOrEqual(c.half[i] + 1e-6);
      expect(g.y - g.height / 2).toBeGreaterThan(c.floor[i] + 15);
      expect(g.y + g.height / 2).toBeLessThan(c.rim[i]);
    }
    expect(c.gates[c.gates.length - 1].width).toBeLessThan(c.gates[0].width);
    expect(c.parTime).toBeGreaterThan(40);
  });
});

import { describe, expect, it } from 'vitest';
import { QualityGovernor } from '../src/render/quality';
import { QUALITY_HIGH, type Stage } from '../src/render/stage';

/** A Stage as the governor sees it: a GPU name and a quality level. */
function fakeStage(gpu: string): Stage {
  const gl = { getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 1 }), getParameter: () => gpu, RENDERER: 2 };
  return { renderer: { getContext: () => gl }, quality: QUALITY_HIGH } as unknown as Stage;
}

const run = (g: QualityGovernor, seconds: number, frameMs: number, active = true) => {
  for (let t = 0; t < seconds; t += frameMs / 1000) g.frame(frameMs / 1000, active);
};

describe('quality governor', () => {
  it('starts high on a discrete GPU, low on an integrated one', () => {
    const nvidia = fakeStage('ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 6GB Laptop GPU Direct3D11)');
    new QualityGovernor(nvidia, false);
    expect(nvidia.quality).toBe(QUALITY_HIGH);
    const intel = fakeStage('ANGLE (Intel, Intel(R) UHD Graphics (0x00004688) Direct3D11)');
    new QualityGovernor(intel, false);
    expect(intel.quality).toBe(1);
  });

  it('keeps the level while the frame rate holds', () => {
    const s = fakeStage('NVIDIA');
    const g = new QualityGovernor(s, false);
    run(g, 20, 1000 / 144);
    expect(s.quality).toBe(QUALITY_HIGH);
  });

  it('steps down a level per slow window until it holds', () => {
    const s = fakeStage('NVIDIA');
    const g = new QualityGovernor(s, false);
    const changes: string[] = [];
    g.onChange = (n) => changes.push(n);
    run(g, 4, 34); // ~29 fps
    expect(s.quality).toBe(QUALITY_HIGH - 1);
    run(g, 4, 22); // ~45 fps
    expect(s.quality).toBe(QUALITY_HIGH - 2);
    run(g, 20, 13); // ~77 fps: holds
    expect(s.quality).toBe(QUALITY_HIGH - 2);
    expect(changes).toEqual(['medium', 'low']);
  });

  it('steps down on hitches even when the average looks fine', () => {
    const s = fakeStage('NVIDIA');
    const g = new QualityGovernor(s, false);
    for (let i = 0; i < 1000; i++) g.frame(i % 10 === 0 ? 0.12 : 0.007, true); // a 120 ms frame in every ten
    expect(s.quality).toBeLessThan(QUALITY_HIGH);
  });

  it('ignores paused frames, and a fixed level never moves', () => {
    const a = fakeStage('NVIDIA');
    run(new QualityGovernor(a, false), 10, 50, false);
    expect(a.quality).toBe(QUALITY_HIGH);
    const b = fakeStage('NVIDIA');
    run(new QualityGovernor(b, true), 10, 50);
    expect(b.quality).toBe(QUALITY_HIGH);
  });
});

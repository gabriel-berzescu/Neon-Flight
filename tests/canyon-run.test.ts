import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BULLSEYE_POINTS, CanyonRun, GATE_POINTS, PERFECT_BONUS, TIME_BONUS_PER_S } from '../src/game/canyon-run';
import { CANYON_STEP, generateCanyon, type Canyon, type Gate } from '../src/world/canyon';
import { heightAt } from '../src/world/terrain';

const canyon = generateCanyon(4242, heightAt);

/** Flies a straight line through gate g, at (lateral, vertical) offsets from its centre, in two frames. */
function flyThrough(run: CanyonRun, g: Gate, lateral = 0, vertical = 0, dt = 0.5): ReturnType<CanyonRun['update']> {
  const rx = -g.tz, rz = g.tx;
  const at = (along: number) => new THREE.Vector3(g.x + g.tx * along + rx * lateral, g.y + vertical, g.z + g.tz * along + rz * lateral);
  run.update(at(-40), at(-5), dt);
  return run.update(at(-5), at(5), dt);
}

describe('canyon run', () => {
  it('passes a gate flown through, misses one flown beside, and counts the combo', () => {
    const run = new CanyonRun(canyon);
    const [g0, g1, g2, g3] = canyon.gates;
    let ev = flyThrough(run, g0);
    expect(ev).toHaveLength(1);
    expect(ev[0].result).toBe('passed');
    expect(ev[0].bullseye).toBe(true);
    expect(ev[0].points).toBe(GATE_POINTS + BULLSEYE_POINTS);

    ev = flyThrough(run, g1, g1.width * 0.4); // inside, off-centre: no bullseye, x1.25
    expect(ev[0].result).toBe('passed');
    expect(ev[0].bullseye).toBe(false);
    expect(ev[0].points).toBe(Math.round(GATE_POINTS * 1.25));

    ev = flyThrough(run, g2, 0, g2.height); // above the opening
    expect(ev[0].result).toBe('missed');
    expect(run.streak).toBe(0);

    ev = flyThrough(run, g3);
    expect(ev[0].multiplier).toBe(1);
    expect(run.passed).toBe(3);
    expect(run.missed).toBe(1);
    expect(run.next).toBe(4);
  });

  it('misses a gate flown past without crossing its plane (over the rim, around it)', () => {
    const run = new CanyonRun(canyon);
    const g0 = canyon.gates[0];
    // jump along the centreline to well past gate 0, high above, in small steps that never cross its plane near it
    const i = Math.round((g0.s + 200) / CANYON_STEP);
    const far = new THREE.Vector3(canyon.x[i], 2000, canyon.z[i]);
    const ev = run.update(far.clone(), far, 0.1);
    expect(ev.some((e) => e.gate.index === 0 && e.result === 'missed')).toBe(true);
  });

  it('finishes after the last gate with the time and perfect bonuses', () => {
    const run = new CanyonRun(canyon);
    for (const g of canyon.gates) flyThrough(run, g, 0, 0, 0.5);
    expect(run.status).toBe('finished');
    expect(run.missed).toBe(0);
    expect(run.perfectBonus).toBe(PERFECT_BONUS);
    expect(run.timeBonus).toBe(Math.round((canyon.parTime - run.elapsed) * TIME_BONUS_PER_S));
    expect(run.bestStreak).toBe(canyon.gates.length);
    // the multiplier caps at x3
    expect(run.multiplier).toBe(3);
    const after = run.score;
    run.update(new THREE.Vector3(), new THREE.Vector3(1, 1, 1), 1);
    expect(run.score).toBe(after);
  });

  it('a crash ends the run and freezes the score and the clock', () => {
    const run = new CanyonRun(canyon as Canyon);
    flyThrough(run, canyon.gates[0]);
    run.crash();
    const { score, elapsed } = run;
    expect(run.status).toBe('crashed');
    flyThrough(run, canyon.gates[1]);
    expect(run.score).toBe(score);
    expect(run.elapsed).toBe(elapsed);
  });
});

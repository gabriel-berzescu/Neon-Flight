/**
 * One canyon run: which gates were flown through, the score, the clock.
 *
 * Feed it the aircraft's position every frame (`update(prev, curr, dt)`); it watches the NEXT gate's plane (through the gate's
 * centre, facing along the canyon): crossing it inside the opening passes the gate, crossing it anywhere else misses it. A gate
 * flown past some other way (over the rim, around it) is missed once the aircraft is GATE_GIVE_UP metres beyond it along the canyon.
 *
 * Scoring:
 *   - a gate passed: 100, +50 for a bullseye (through the middle third of the opening), times the combo multiplier
 *   - combo: x1 for the first gate in a row, +0.25 for each one before it in an unbroken streak, up to x3; a miss resets it
 *   - finish (the last gate passed or missed): a time bonus of 25 a second under the par time, and 500 for a perfect run
 *   - a crash ends the run with the score so far
 */
import * as THREE from 'three';
import { CANYON_STEP, type Canyon, type Gate } from '../world/canyon';

export const GATE_POINTS = 100;
export const BULLSEYE_POINTS = 50;
export const COMBO_STEP = 0.25;
export const COMBO_MAX = 3;
export const TIME_BONUS_PER_S = 25;
export const PERFECT_BONUS = 500;
const GATE_GIVE_UP = 150;

export type GateResult = 'passed' | 'missed';

export interface GateEvent {
  gate: Gate;
  result: GateResult;
  /** Points scored (after the multiplier); 0 for a miss. */
  points: number;
  bullseye: boolean;
  multiplier: number;
  /** How far from the centre, 0 (dead centre) .. 1 (the frame); undefined for a miss that never crossed the plane. */
  offset?: number;
  /** Where the gate's plane was crossed, from its centre (m): right of it, above it. */
  lateral?: number;
  vertical?: number;
}

export type RunStatus = 'flying' | 'finished' | 'crashed';

export class CanyonRun {
  readonly results: (GateResult | undefined)[];
  status: RunStatus = 'flying';
  score = 0;
  streak = 0;
  bestStreak = 0;
  /** Seconds since the start (stops at the finish or a crash). */
  elapsed = 0;
  /** Index of the gate to fly through next (gates.length once done). */
  next = 0;
  timeBonus = 0;
  perfectBonus = 0;
  /** Distance along the canyon of the aircraft's nearest centreline point (m). */
  progress = 0;
  /** Every gate event so far, in order. */
  readonly log: GateEvent[] = [];
  private nearest = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(readonly canyon: Canyon) {
    this.results = canyon.gates.map(() => undefined);
  }

  get passed(): number {
    return this.results.filter((r) => r === 'passed').length;
  }

  get missed(): number {
    return this.results.filter((r) => r === 'missed').length;
  }

  get multiplier(): number {
    return Math.min(COMBO_MAX, 1 + COMBO_STEP * this.streak);
  }

  /** One frame: the aircraft moved from `prev` to `curr` (world, m) in `dt` seconds. Returns what happened at the gates. */
  update(prev: THREE.Vector3, curr: THREE.Vector3, dt: number): GateEvent[] {
    if (this.status !== 'flying') return [];
    this.elapsed += dt;
    this.track(curr);
    const events: GateEvent[] = [];
    const gates = this.canyon.gates;
    while (this.next < gates.length) {
      const g = gates[this.next];
      const d0 = (prev.x - g.x) * g.tx + (prev.z - g.z) * g.tz;
      const d1 = (curr.x - g.x) * g.tx + (curr.z - g.z) * g.tz;
      if (d0 < 0 && d1 >= 0) {
        // where the path met the gate's plane
        const q = this.tmp.copy(prev).lerp(curr, -d0 / (d1 - d0));
        const lateral = (q.x - g.x) * -g.tz + (q.z - g.z) * g.tx;
        const vertical = q.y - g.y;
        const offset = Math.max(Math.abs(lateral) / (g.width / 2), Math.abs(vertical) / (g.height / 2));
        const e = offset <= 1 ? this.pass(g, offset) : this.miss(g, offset);
        e.lateral = lateral;
        e.vertical = vertical;
        events.push(e);
        continue;
      }
      if (this.progress > g.s + GATE_GIVE_UP) {
        events.push(this.miss(g));
        continue;
      }
      break;
    }
    if (this.next >= gates.length) this.finish();
    this.log.push(...events);
    return events;
  }

  /** The aircraft crashed: the run ends with the score so far. */
  crash(): void {
    if (this.status === 'flying') this.status = 'crashed';
  }

  private pass(g: Gate, offset: number): GateEvent {
    const multiplier = this.multiplier;
    const bullseye = offset <= 1 / 3;
    const points = Math.round((GATE_POINTS + (bullseye ? BULLSEYE_POINTS : 0)) * multiplier);
    this.score += points;
    this.streak += 1;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    this.results[g.index] = 'passed';
    this.next = g.index + 1;
    return { gate: g, result: 'passed', points, bullseye, multiplier, offset };
  }

  private miss(g: Gate, offset?: number): GateEvent {
    this.streak = 0;
    this.results[g.index] = 'missed';
    this.next = g.index + 1;
    return { gate: g, result: 'missed', points: 0, bullseye: false, multiplier: 1, offset };
  }

  private finish(): void {
    this.status = 'finished';
    this.timeBonus = Math.max(0, Math.round((this.canyon.parTime - this.elapsed) * TIME_BONUS_PER_S));
    this.perfectBonus = this.missed === 0 ? PERFECT_BONUS : 0;
    this.score += this.timeBonus + this.perfectBonus;
  }

  /** The nearest centreline sample, searched around the last one (the aircraft moves at most a few samples a frame). */
  private track(p: THREE.Vector3): void {
    const c = this.canyon;
    let best = this.nearest;
    let bestD = Infinity;
    const lo = Math.max(0, this.nearest - 30);
    const hi = Math.min(c.n - 1, this.nearest + 60);
    for (let i = lo; i <= hi; i++) {
      const d = (c.x[i] - p.x) ** 2 + (c.z[i] - p.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // at the window's edge (a long frame, a jump): walk on while it keeps getting closer
    if (best === hi) {
      while (best < c.n - 1) {
        const d = (c.x[best + 1] - p.x) ** 2 + (c.z[best + 1] - p.z) ** 2;
        if (d >= bestD) break;
        bestD = d;
        best += 1;
      }
    }
    this.nearest = best;
    this.progress = best * CANYON_STEP;
  }
}

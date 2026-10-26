/**
 * A dev autopilot for QA (`?autopilot=1`): flies a canyon run's gates through the same four controls a pilot has, so a scripted
 * browser run can thread gates, take screenshots inside the canyon and check the run's scoring in real physics.
 *
 * It steers for a point on the next gate's approach line (inside its opening, a little before it, then the gate itself), banks
 * to turn (the fly-by-wire holds a level turn in a bank), climbs or descends on the flight path, and holds about 180 m/s.
 */
import type { FlightState } from '../flight/flight';
import type { Gate } from '../world/canyon';

export interface AutopilotOutput {
  stickLeft: number;
  stickRight: number;
  throttleLeft: number;
  throttleRight: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const D = Math.PI / 180;

export function autopilot(s: FlightState, gate: Gate | undefined): AutopilotOutput {
  const out: AutopilotOutput = { stickLeft: 0, stickRight: 0, throttleLeft: 0.7, throttleRight: 0.7 };
  if (!gate) return out;
  const p = s.position;
  // the aim: on the gate's axis, 120 m before it while still far, the gate's centre when close
  const toGate = (gate.x - p.x) * gate.tx + (gate.z - p.z) * gate.tz;
  const lead = clamp(toGate - 60, 0, 120);
  const ax = gate.x - gate.tx * lead;
  const az = gate.z - gate.tz * lead;
  const dx = ax - p.x;
  const dz = az - p.z;
  const dist = Math.hypot(dx, dz);
  // heading error (velocity vs the aim), positive = the aim is to the right
  const vx = s.velocity.x, vz = s.velocity.z;
  const err = Math.atan2(vx * dz - vz * dx, vx * dx + vz * dz);
  // the turn it wants, the bank that points the lift there, and the pull on top of the fly-by-wire's own level-turn g
  const omega = clamp(err * 0.9, -0.3, 0.3);
  const lateralG = (s.speed * omega) / 9.81;
  const bank = clamp(Math.atan(lateralG), -72 * D, 72 * D);
  const roll = clamp(((bank - s.rollDeg * D) / D) * 0.04, -1, 1);
  const nWant = Math.sqrt(1 + lateralG * lateralG);
  const nFbw = 1 / Math.cos(Math.min(Math.abs(s.rollDeg), 60) * D);
  const pull = clamp((nWant - nFbw) / 7, 0, 0.7);
  // flight path toward the gate's height
  const gamma = Math.atan2(s.velocity.y, Math.hypot(vx, vz));
  const gammaWant = clamp(Math.atan2(gate.y - p.y, Math.max(dist, 150)) * 1.4, -20 * D, 20 * D);
  const pitch = clamp(((gammaWant - gamma) / D) * 0.06 + pull, -1, 1);
  out.stickLeft = clamp(pitch - roll, -1, 1);
  out.stickRight = clamp(pitch + roll, -1, 1);
  const thr = clamp(0.62 + (180 - s.speed) * 0.03, 0.15, 1);
  out.throttleLeft = thr;
  out.throttleRight = thr;
  return out;
}

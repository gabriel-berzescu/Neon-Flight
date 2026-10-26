/**
 * A dev autopilot for QA (`?autopilot=1`): flies a canyon run's gates through the same four controls a pilot has, so a scripted
 * browser run can thread gates, take screenshots inside the canyon and check the run's scoring in real physics.
 *
 * Between gates it follows the canyon's centreline 300 m ahead, 70 m above the floor (it knows nothing of walls otherwise);
 * within 400 m of the next gate it steers for that gate's approach line, then the gate itself. It banks to turn and pulls for
 * the turn rate it needs, climbs or descends on the flight path, and holds about 180 m/s.
 */
import type { FlightState } from '../flight/flight';
import { CANYON_STEP, type Canyon, type Gate } from '../world/canyon';

export interface AutopilotOutput {
  stickLeft: number;
  stickRight: number;
  throttleLeft: number;
  throttleRight: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const D = Math.PI / 180;

export function autopilot(s: FlightState, gate: Gate | undefined, canyon?: Canyon, progress = 0): AutopilotOutput {
  const out: AutopilotOutput = { stickLeft: 0, stickRight: 0, throttleLeft: 0.7, throttleRight: 0.7 };
  if (!gate && !canyon) return out;
  const p = s.position;
  let ax: number, az: number, ay: number;
  const toGate = gate ? (gate.x - p.x) * gate.tx + (gate.z - p.z) * gate.tz : Infinity;
  if (gate && toGate < 400) {
    // on the gate's axis, 120 m before it while still far, the gate's centre when close
    const lead = clamp(toGate - 60, 0, 120);
    ax = gate.x - gate.tx * lead;
    az = gate.z - gate.tz * lead;
    ay = gate.y;
  } else if (canyon) {
    const i = Math.min(canyon.n - 1, Math.round((progress + 300) / CANYON_STEP));
    ax = canyon.x[i];
    az = canyon.z[i];
    ay = canyon.floor[i] + 70;
  } else return out;
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
  const gammaWant = clamp(Math.atan2(ay - p.y, Math.max(dist, 150)) * 1.4, -20 * D, 20 * D);
  const pitch = clamp(((gammaWant - gamma) / D) * 0.06 + pull, -1, 1);
  out.stickLeft = clamp(pitch - roll, -1, 1);
  out.stickRight = clamp(pitch + roll, -1, 1);
  const thr = clamp(0.62 + (180 - s.speed) * 0.03, 0.15, 1);
  out.throttleLeft = thr;
  out.throttleRight = thr;
  return out;
}

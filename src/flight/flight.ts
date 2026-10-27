/**
 * The aircraft in flight: JSBSim stepped at a fixed rate, with the game's terrain as its ground, read back into world space.
 *
 * - `update(dt, controls)` runs as many 1/120 s JSBSim steps as real time asks (at most 0.25 s per call, so a hitch never
 *   explodes into a burst of steps) and keeps the last two step states so `state` can be interpolated to the render time.
 * - Any of the wing's structure contacts (nose, belly, canopy, tail, wingtips, fins) touching the ground or the sea is a crash:
 *   the simulation freezes there and `state.crashed` is set. `spawn()` starts a fresh flight (JSBSim initial conditions).
 */
import * as THREE from 'three';
import type { JSBSimSim } from '../fdm/jsbsim';
import { FT, KT, latLonToWorld, worldToLatLon } from '../world/coords';
import { attitudeToQuaternion } from './attitude';

export const PHYSICS_HZ = 120;
const DT = 1 / PHYSICS_HZ;
const MAX_CATCH_UP = 0.25;
/** The wing's contact points (see neonwing.xml), all structure: touching anything is a crash. */
const CONTACTS = 8;

/** Terrain + sea surface height at world (x, z), metres. */
export type GroundFn = (x: number, z: number) => number;

/** What the aircraft is flown with: the two elevon sticks (-1 forward .. +1 back) and each engine's JSBSim throttle (0..1). */
export interface FlightInput {
  stickLeft: number;
  stickRight: number;
  throttleLeft: number;
  throttleRight: number;
}

export interface SpawnOptions {
  x: number;
  z: number;
  /** Height above the ground (m). */
  agl: number;
  /** Or an exact height above sea level (m), used instead of `agl` when given. */
  y?: number;
  /** Heading, degrees true (0 = north, 90 = east). */
  heading: number;
  /** True airspeed (m/s). */
  speed: number;
  /** Initial power for both engines (0..1, the thrust fraction), so they are already spooled. */
  engines?: number;
}

/** One sampled state (world space, SI units). */
export interface FlightSample {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
}

export interface FlightState extends FlightSample {
  /** True airspeed, m/s. */
  speed: number;
  /** Calibrated airspeed, m/s (what an airspeed indicator shows). */
  airspeed: number;
  mach: number;
  /** Height above sea level / above the ground, m. */
  altitude: number;
  agl: number;
  /** Vertical speed, m/s. */
  climb: number;
  /** Load factor (g, positive pulls you into the seat). */
  g: number;
  alphaDeg: number;
  betaDeg: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Engine spool (N2 %, 60 = idle) and thrust (N), [left, right]. */
  n2: [number, number];
  thrust: [number, number];
  /** Elevon positions, -1..1, trailing edge up = positive, [left, right]. */
  elevons: [number, number];
  /** True when the angle-of-attack limiter is working (the wing is at its maximum lift). */
  limiting: boolean;
  crashed: boolean;
  /** Seconds since the spawn. */
  time: number;
}

interface Handles {
  stickL: number; stickR: number; thrL: number; thrR: number;
  lat: number; lon: number; alt: number; phi: number; theta: number; psi: number;
  vn: number; ve: number; vd: number; vt: number; vc: number; mach: number; agl: number;
  nz: number; alpha: number; beta: number;
  n2L: number; n2R: number; tL: number; tR: number; elL: number; elR: number;
  fuel: number;
  contactAgl: number[];
}

function makeSample(): FlightSample {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3() };
}

export class Flight {
  readonly state: FlightState;
  /** Physics samples before and after the render time. */
  private prev = makeSample();
  private curr = makeSample();
  private acc = 0;
  private readonly h: Handles;
  private readonly ll = { lat: 0, lon: 0 };
  private readonly xz = { x: 0, z: 0 };
  private crashed = false;
  private spawnTime = 0;

  constructor(private readonly sim: JSBSimSim, private readonly ground: GroundFn) {
    sim.setDt(DT);
    sim.setTerrain((lat, lon) => {
      latLonToWorld(lat, lon, this.xz);
      return ground(this.xz.x, this.xz.z);
    });
    const H = (name: string) => {
      const id = sim.handle(name);
      if (id < 0) throw new Error(`JSBSim property ${name} unavailable: ${sim.lastError()}`);
      return id;
    };
    this.h = {
      stickL: H('fcs/stick-left-cmd'), stickR: H('fcs/stick-right-cmd'),
      thrL: H('fcs/throttle-cmd-norm[0]'), thrR: H('fcs/throttle-cmd-norm[1]'),
      lat: H('position/lat-geod-rad'), lon: H('position/long-gc-rad'), alt: H('position/geod-alt-ft'),
      phi: H('attitude/phi-rad'), theta: H('attitude/theta-rad'), psi: H('attitude/psi-rad'),
      vn: H('velocities/v-north-fps'), ve: H('velocities/v-east-fps'), vd: H('velocities/v-down-fps'),
      vt: H('velocities/vt-fps'), vc: H('velocities/vc-kts'), mach: H('velocities/mach'), agl: H('position/h-agl-ft'),
      nz: H('accelerations/Nz'), alpha: H('aero/alpha-deg'), beta: H('aero/beta-deg'),
      n2L: H('propulsion/engine[0]/n2'), n2R: H('propulsion/engine[1]/n2'),
      tL: H('propulsion/engine[0]/thrust-lbs'), tR: H('propulsion/engine[1]/thrust-lbs'),
      elL: H('fcs/elevon-left-pos-norm'), elR: H('fcs/elevon-right-pos-norm'),
      fuel: H('propulsion/tank[0]/contents-lbs'),
      contactAgl: Array.from({ length: CONTACTS }, (_, i) => H(`contact/unit[${i}]/AGL-ft`)),
    };
    this.state = {
      ...makeSample(),
      speed: 0, airspeed: 0, mach: 0, altitude: 0, agl: 0, climb: 0, g: 1, alphaDeg: 0, betaDeg: 0,
      headingDeg: 0, pitchDeg: 0, rollDeg: 0, n2: [0, 0], thrust: [0, 0], elevons: [0, 0], limiting: false, crashed: false, time: 0,
    };
  }

  spawn(o: SpawnOptions): void {
    const sim = this.sim;
    worldToLatLon(o.x, o.z, this.ll);
    const groundH = this.ground(o.x, o.z);
    sim.set('ic/lat-geod-rad', this.ll.lat);
    sim.set('ic/long-gc-rad', this.ll.lon);
    sim.set('ic/h-sl-ft', (o.y ?? groundH + o.agl) / FT);
    sim.set('ic/psi-true-deg', o.heading);
    sim.set('ic/vt-kts', o.speed / KT);
    sim.set('ic/gamma-deg', 0);
    sim.set('ic/phi-deg', 0);
    // (about the angle of attack of 1 g flight at that speed, so the first frames are not a lurch)
    sim.set('ic/alpha-deg', Math.min(12, (2550 * 9.81) / (0.5 * 1.2 * o.speed * o.speed * 22 * 3.75) * 57.3));
    sim.set('ic/beta-deg', 0);
    sim.set('ic/p-rad_sec', 0);
    sim.set('ic/q-rad_sec', 0);
    sim.set('ic/r-rad_sec', 0);
    const e = o.engines ?? 0.5;
    sim.setH(this.h.stickL, 0);
    sim.setH(this.h.stickR, 0);
    sim.setH(this.h.thrL, Math.sqrt(e));
    sim.setH(this.h.thrR, Math.sqrt(e));
    if (!sim.runIC()) throw new Error(`JSBSim initial conditions failed: ${sim.lastError()}`);
    sim.set('propulsion/set-running', -1);
    this.crashed = false;
    this.acc = 0;
    this.spawnTime = sim.simTime();
    this.sample(this.curr);
    this.copy(this.curr, this.prev);
    this.readState(1);
  }

  /** Advance by real time `dt` with these controls; returns the number of physics steps taken. */
  update(dt: number, c: FlightInput | null): number {
    if (this.crashed) {
      this.readState(1);
      return 0;
    }
    const { sim, h } = this;
    if (c) {
      sim.setH(h.stickL, c.stickLeft);
      sim.setH(h.stickR, c.stickRight);
      sim.setH(h.thrL, c.throttleLeft);
      sim.setH(h.thrR, c.throttleRight);
    }
    this.acc = Math.min(this.acc + dt, MAX_CATCH_UP);
    let n = 0;
    while (this.acc >= DT) {
      this.acc -= DT;
      this.copy(this.curr, this.prev);
      if (sim.run() === false) {
        this.crash();
        break;
      }
      n++;
      this.sample(this.curr);
      if (this.touching()) {
        this.crash();
        break;
      }
    }
    // free flight never runs dry
    if (sim.getH(h.fuel) < 800) sim.setH(h.fuel, 880);
    this.readState(this.crashed ? 1 : this.acc / DT);
    return n;
  }

  private touching(): boolean {
    for (const id of this.h.contactAgl) if (this.sim.getH(id) <= 0) return true;
    return !Number.isFinite(this.curr.position.y);
  }

  private crash(): void {
    this.crashed = true;
    this.acc = 0;
    this.copy(this.curr, this.prev);
  }

  private sample(s: FlightSample): void {
    const { sim, h } = this;
    latLonToWorld(sim.getH(h.lat), sim.getH(h.lon), this.xz);
    s.position.set(this.xz.x, sim.getH(h.alt) * FT, this.xz.z);
    attitudeToQuaternion(sim.getH(h.phi), sim.getH(h.theta), sim.getH(h.psi), s.quaternion);
    s.velocity.set(sim.getH(h.ve) * FT, -sim.getH(h.vd) * FT, -sim.getH(h.vn) * FT);
  }

  private copy(from: FlightSample, to: FlightSample): void {
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.velocity.copy(from.velocity);
  }

  private readState(alpha: number): void {
    const { sim, h, state: s } = this;
    s.position.lerpVectors(this.prev.position, this.curr.position, alpha);
    s.quaternion.slerpQuaternions(this.prev.quaternion, this.curr.quaternion, alpha);
    s.velocity.lerpVectors(this.prev.velocity, this.curr.velocity, alpha);
    s.speed = sim.getH(h.vt) * FT;
    s.airspeed = sim.getH(h.vc) * KT;
    s.mach = sim.getH(h.mach);
    s.altitude = s.position.y;
    s.agl = sim.getH(h.agl) * FT;
    s.climb = s.velocity.y;
    s.g = sim.getH(h.nz);
    s.alphaDeg = sim.getH(h.alpha);
    s.betaDeg = sim.getH(h.beta);
    s.headingDeg = (sim.getH(h.psi) * 180) / Math.PI;
    s.pitchDeg = (sim.getH(h.theta) * 180) / Math.PI;
    s.rollDeg = (sim.getH(h.phi) * 180) / Math.PI;
    s.n2[0] = sim.getH(h.n2L);
    s.n2[1] = sim.getH(h.n2R);
    s.thrust[0] = sim.getH(h.tL) * 4.44822;
    s.thrust[1] = sim.getH(h.tR) * 4.44822;
    s.elevons[0] = sim.getH(h.elL);
    s.elevons[1] = sim.getH(h.elR);
    s.limiting = s.alphaDeg > 14.3;
    s.crashed = this.crashed;
    s.time = sim.simTime() - this.spawnTime;
  }

  /** A JSBSim property by name (debugging, tests). */
  get(name: string): number {
    return this.sim.get(name);
  }

  set(name: string, v: number): void {
    this.sim.set(name, v);
  }
}

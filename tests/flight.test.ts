import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createSim } from '../src/fdm/jsbsim';
import { Flight, PHYSICS_HZ } from '../src/flight/flight';
import { attitudeToQuaternion } from '../src/flight/attitude';
import { latLonToWorld, worldToLatLon } from '../src/world/coords';

const D = Math.PI / 180;
const dir = (q: THREE.Quaternion, x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(q);
const NOSE = [0, 0, -1] as const;
const RIGHT = [1, 0, 0] as const;
const UP = [0, 1, 0] as const;

describe('attitude -> world quaternion', () => {
  const q = new THREE.Quaternion();
  it('level, heading north: the model is unrotated', () => {
    attitudeToQuaternion(0, 0, 0, q);
    expect(q.angleTo(new THREE.Quaternion())).toBeLessThan(1e-9);
  });
  it('heading east points the nose at +x', () => {
    attitudeToQuaternion(0, 0, 90 * D, q);
    const n = dir(q, ...NOSE);
    expect(n.x).toBeCloseTo(1, 9);
    expect(n.z).toBeCloseTo(0, 9);
  });
  it('heading south points the nose at +z', () => {
    attitudeToQuaternion(0, 0, 180 * D, q);
    expect(dir(q, ...NOSE).z).toBeCloseTo(1, 9);
  });
  it('pitch up raises the nose', () => {
    attitudeToQuaternion(0, 10 * D, 0, q);
    const n = dir(q, ...NOSE);
    expect(n.y).toBeCloseTo(Math.sin(10 * D), 9);
    expect(n.z).toBeCloseTo(-Math.cos(10 * D), 9);
  });
  it('positive roll drops the right wing', () => {
    attitudeToQuaternion(30 * D, 0, 0, q);
    const r = dir(q, ...RIGHT);
    expect(r.y).toBeCloseTo(-Math.sin(30 * D), 9);
    expect(dir(q, ...UP).x).toBeCloseTo(Math.sin(30 * D), 9);
  });
});

describe('coordinates', () => {
  it('lat/lon <-> world round trip', () => {
    const ll = { lat: 0, lon: 0 };
    const xz = { x: 0, z: 0 };
    worldToLatLon(123456.7, -98765.4, ll);
    latLonToWorld(ll.lat, ll.lon, xz);
    expect(xz.x).toBeCloseTo(123456.7, 6);
    expect(xz.z).toBeCloseTo(-98765.4, 6);
    expect(ll.lat).toBeGreaterThan(0); // north = -z
  });
});

async function flight(ground: (x: number, z: number) => number = () => 0) {
  return new Flight(await createSim(), ground);
}
const run = (f: Flight, seconds: number, c = { stickLeft: 0, stickRight: 0, throttleLeft: 0.7, throttleRight: 0.7 }) => {
  for (let i = 0; i < seconds * 60; i++) f.update(1 / 60, c);
};

describe('flight', () => {
  it('flies straight and level hands-off, north, in world space', async () => {
    const f = await flight();
    f.spawn({ x: 1000, z: 2000, agl: 500, heading: 0, speed: 150 });
    expect(f.state.position.x).toBeCloseTo(1000, 3);
    expect(f.state.position.z).toBeCloseTo(2000, 3);
    expect(f.state.position.y).toBeCloseTo(500, 3);
    run(f, 10);
    const s = f.state;
    expect(s.crashed).toBe(false);
    expect(s.position.z).toBeLessThan(2000 - 1200); // ~150 m/s north for 10 s
    expect(Math.abs(s.position.x - 1000)).toBeLessThan(20);
    expect(Math.abs(s.altitude - 500)).toBeLessThan(80);
    expect(Math.abs(s.rollDeg)).toBeLessThan(2);
    expect(s.velocity.z).toBeLessThan(-100);
    expect(s.g).toBeCloseTo(1, 1);
    expect(s.time).toBeCloseTo(10, 1);
  });

  it('flies east when spawned heading 090', async () => {
    const f = await flight();
    f.spawn({ x: 0, z: 0, agl: 800, heading: 90, speed: 150 });
    run(f, 4);
    expect(f.state.position.x).toBeGreaterThan(500);
    expect(Math.abs(f.state.position.z)).toBeLessThan(20);
  });

  it('sees the game terrain (JSBSim AGL uses the ground function)', async () => {
    const f = await flight(() => 300);
    f.spawn({ x: 0, z: 0, agl: 400, heading: 0, speed: 150 });
    run(f, 0.5);
    expect(f.state.altitude).toBeGreaterThan(650);
    expect(f.state.agl).toBeCloseTo(f.state.altitude - 300, 0);
  });

  it('crashes into the ground when pushed into it, and freezes there', async () => {
    const f = await flight(() => 120);
    f.spawn({ x: 0, z: 0, agl: 300, heading: 0, speed: 150 });
    run(f, 15, { stickLeft: -1, stickRight: -1, throttleLeft: 1, throttleRight: 1 });
    expect(f.state.crashed).toBe(true);
    expect(f.state.altitude).toBeLessThan(140);
    const at = f.state.position.clone();
    run(f, 1);
    expect(f.state.position.distanceTo(at)).toBe(0);
    // and a new spawn flies again
    f.spawn({ x: 0, z: 0, agl: 500, heading: 0, speed: 150 });
    run(f, 2);
    expect(f.state.crashed).toBe(false);
  });

  it('one engine alone yaws a little (toward the idle side), not a lot', async () => {
    const f = await flight();
    f.spawn({ x: 0, z: 0, agl: 1500, heading: 0, speed: 150, engines: 0 });
    run(f, 10, { stickLeft: 0, stickRight: 0, throttleLeft: 0, throttleRight: 1 });
    const h = ((f.state.headingDeg + 540) % 360) - 180;
    expect(h).toBeLessThan(-2); // turned left: right engine pushing
    expect(h).toBeGreaterThan(-25);
    expect(Math.abs(f.state.rollDeg)).toBeLessThan(10);
  });

  it('the sticks are the wings: left back + right forward rolls left', async () => {
    const f = await flight();
    f.spawn({ x: 0, z: 0, agl: 1500, heading: 0, speed: 150 });
    run(f, 0.4, { stickLeft: 1, stickRight: -1, throttleLeft: 0.7, throttleRight: 0.7 });
    expect(f.state.rollDeg).toBeLessThan(-20);
    expect(f.state.elevons[0]).toBeGreaterThan(0.5); // left trailing edge up
    expect(f.state.elevons[1]).toBeLessThan(-0.5);
  });

  it('both sticks back pull up, and the g stays within +9', async () => {
    const f = await flight();
    f.spawn({ x: 0, z: 0, agl: 1500, heading: 0, speed: 250 });
    let maxG = 0;
    for (let i = 0; i < 120; i++) {
      f.update(1 / 60, { stickLeft: 1, stickRight: 1, throttleLeft: 1, throttleRight: 1 });
      maxG = Math.max(maxG, f.state.g);
    }
    expect(f.state.pitchDeg).toBeGreaterThan(20);
    expect(maxG).toBeGreaterThan(8);
    expect(maxG).toBeLessThan(10);
  });

  it('steps at the physics rate and catches up at most a quarter second', async () => {
    const f = await flight();
    f.spawn({ x: 0, z: 0, agl: 1500, heading: 0, speed: 150 });
    expect(f.update(1, null)).toBe(Math.floor(0.25 * PHYSICS_HZ + 1e-9));
  });
});

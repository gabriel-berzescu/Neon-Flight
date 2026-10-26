/**
 * The chase camera: behind and a little above the wing, rolling with it, following its attitude through a soft spring so quick
 * moves read as motion. The field of view opens up with speed. It never goes below the ground.
 *
 * After a crash it stops following and slowly orbits the crash site.
 */
import * as THREE from 'three';
import type { FlightState } from '../flight/flight';

const OFFSET = new THREE.Vector3(0, 3.4, 15.5);
const LOOK_AHEAD = new THREE.Vector3(0, 0.6, -30);
/** Attitude follow rate (1/s): the camera sits on a softened copy of the wing's attitude (no positional lag, so it never
 * falls back at speed). */
const ATTITUDE_RATE = 7;
const FOV_SLOW = 62;
const FOV_FAST = 74;

export class ChaseCamera {
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private initialised = false;
  private orbit = 0;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly ground: (x: number, z: number) => number) {}

  reset(): void {
    this.initialised = false;
  }

  update(s: FlightState, dt: number): void {
    const cam = this.camera;
    if (s.crashed) {
      this.orbit += dt * 0.25;
      const r = 60;
      this.pos.set(s.position.x + Math.sin(this.orbit) * r, 0, s.position.z + Math.cos(this.orbit) * r);
      this.pos.y = Math.max(s.position.y + 25, this.ground(this.pos.x, this.pos.z) + 15);
      cam.position.lerp(this.pos, 1 - Math.exp(-2 * dt));
      cam.up.set(0, 1, 0);
      cam.lookAt(s.position);
      return;
    }
    this.orbit = Math.atan2(cam.position.x - s.position.x, cam.position.z - s.position.z);
    if (!this.initialised) {
      this.q.copy(s.quaternion);
      this.initialised = true;
    } else {
      this.q.slerp(s.quaternion, 1 - Math.exp(-ATTITUDE_RATE * dt));
    }
    this.place(s);
    const fov = FOV_SLOW + (FOV_FAST - FOV_SLOW) * Math.min(1, Math.max(0, (s.speed - 80) / 200));
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov += (fov - cam.fov) * (1 - Math.exp(-3 * dt));
      cam.updateProjectionMatrix();
    }
  }

  private place(s: FlightState): void {
    const cam = this.camera;
    cam.position.copy(OFFSET).applyQuaternion(this.q).add(s.position);
    const floor = this.ground(cam.position.x, cam.position.z) + 1.5;
    if (cam.position.y < floor) cam.position.y = floor;
    cam.up.set(0, 1, 0).applyQuaternion(this.q);
    this.look.copy(LOOK_AHEAD).applyQuaternion(this.q).add(s.position);
    cam.lookAt(this.look);
  }
}

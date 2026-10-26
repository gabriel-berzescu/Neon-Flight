/**
 * The title screen's camera: a slow flight over the land toward the sun, weaving gently, always well clear of the ground ahead.
 * No aircraft, no physics: just the view.
 */
import * as THREE from 'three';

const SPEED = 110;
const CLEARANCE = 240;

export class TitleCamera {
  private x = 0;
  private z = 0;
  private y = 0;
  private t = 0;
  private readonly look = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly ground: (x: number, z: number) => number) {}

  reset(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.t = 0;
    this.y = this.safeHeight(0);
  }

  /** The height to fly at: above the highest ground under the camera and up to 2 km ahead. */
  private safeHeight(heading: number): number {
    let hi = -Infinity;
    for (const d of [0, 400, 900, 1500, 2100]) hi = Math.max(hi, this.ground(this.x + Math.sin(heading) * d, this.z - Math.cos(heading) * d));
    return Math.max(hi, 0) + CLEARANCE;
  }

  update(dt: number): void {
    this.t += dt;
    // north toward the sun, weaving: heading swings +-20 degrees over a couple of minutes
    const heading = 0.35 * Math.sin(this.t * 0.045);
    const turn = 0.35 * 0.045 * Math.cos(this.t * 0.045);
    this.x += Math.sin(heading) * SPEED * dt;
    this.z -= Math.cos(heading) * SPEED * dt;
    this.y += (this.safeHeight(heading) - this.y) * (1 - Math.exp(-0.5 * dt));
    const cam = this.camera;
    cam.position.set(this.x, this.y, this.z);
    this.look.set(this.x + Math.sin(heading) * 900, this.y - 110, this.z - Math.cos(heading) * 900);
    // a little bank into the weave
    cam.up.set(Math.cos(heading) * turn * 6, 1, Math.sin(heading) * turn * 6).normalize();
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - 66) > 0.01) {
      cam.fov = 66;
      cam.updateProjectionMatrix();
    }
  }
}

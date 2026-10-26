/**
 * The crash: a flash and a burst of neon sparks that fly out, fall and fade (about 3 s).
 */
import * as THREE from 'three';
import { PALETTE } from './palette';

const N = 420;
const LIFE = 3.2;

export class Burst {
  readonly object: THREE.Points;
  private readonly pos = new Float32Array(N * 3);
  private readonly vel = new Float32Array(N * 3);
  private readonly col = new Float32Array(N * 3);
  private readonly base = new Float32Array(N * 3);
  private readonly mat: THREE.PointsMaterial;
  private age = LIFE;
  private readonly flash: THREE.PointLight;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.PointsMaterial({ size: 1.1, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.object = new THREE.Points(g, this.mat);
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.flash = new THREE.PointLight(PALETTE.amber, 0, 400, 1.5);
    this.object.add(this.flash);
    const palette = [PALETTE.cyan, PALETTE.magenta, PALETTE.amber, 0xffffff];
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      c.set(palette[i % palette.length]).multiplyScalar(3);
      this.base[i * 3] = c.r;
      this.base[i * 3 + 1] = c.g;
      this.base[i * 3 + 2] = c.b;
    }
  }

  /** Start a burst at `at` (world), carrying some of the wing's velocity. */
  fire(at: THREE.Vector3, velocity: THREE.Vector3): void {
    this.age = 0;
    this.object.position.copy(at);
    this.object.visible = true;
    let s = 987654321;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < N; i++) {
      // a hemisphere-ish spray, biased up and along the impact
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const speed = 15 + 55 * rnd() * rnd();
      this.vel[i * 3] = r * Math.cos(th) * speed + velocity.x * 0.15;
      this.vel[i * 3 + 1] = Math.abs(u) * speed * 0.9 + 6;
      this.vel[i * 3 + 2] = r * Math.sin(th) * speed + velocity.z * 0.15;
      this.pos[i * 3] = this.pos[i * 3 + 1] = this.pos[i * 3 + 2] = 0;
    }
  }

  update(dt: number, groundY: number): void {
    if (this.age >= LIFE) {
      this.object.visible = false;
      return;
    }
    this.age += dt;
    const k = Math.max(0, 1 - this.age / LIFE);
    const floor = groundY - this.object.position.y + 0.2;
    for (let i = 0; i < N; i++) {
      const o = i * 3;
      this.vel[o + 1] -= 9.81 * dt;
      const drag = Math.exp(-0.9 * dt);
      this.vel[o] *= drag;
      this.vel[o + 2] *= drag;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < floor) {
        this.pos[o + 1] = floor;
        this.vel[o + 1] *= -0.3;
      }
      const tw = 0.6 + 0.4 * Math.sin(i * 12.9898 + this.age * 20);
      this.col[o] = this.base[o] * k * tw;
      this.col[o + 1] = this.base[o + 1] * k * tw;
      this.col[o + 2] = this.base[o + 2] * k * tw;
    }
    const g = this.object.geometry;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.flash.intensity = 4000 * Math.exp(-this.age * 4);
  }
}

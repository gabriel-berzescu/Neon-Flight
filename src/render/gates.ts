/**
 * The gates of a canyon run: neon frames across the canyon, one instanced mesh (four bars a gate).
 *
 *   upcoming   dim cyan
 *   next       bright amber, pulsing, with a faint glow across the opening
 *   passed     a green flash, then dark
 *   missed     a red flash, then dim red
 *
 * The mesh sits at the canyon's mouth and the bars are placed relative to it (small numbers for the GPU, see coords.ts).
 */
import * as THREE from 'three';
import type { Canyon } from '../world/canyon';
import type { GateResult } from '../game/canyon-run';
import { PALETTE } from './palette';

const BAR = 1.2;
const FLASH_S = 0.8;

const C_UPCOMING = new THREE.Color(PALETTE.cyan).multiplyScalar(0.9);
const C_NEXT = new THREE.Color(PALETTE.amber).multiplyScalar(1.6);
const C_PASSED = new THREE.Color(0x4dff9a).multiplyScalar(2);
const C_MISSED = new THREE.Color(0xff3355).multiplyScalar(1.8);
const C_DARK = new THREE.Color(0x0a1830);
const C_MISSED_DIM = new THREE.Color(0xff3355).multiplyScalar(0.35);

export class GatesView {
  readonly object = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private readonly glow: THREE.Mesh;
  private canyon: Canyon | null = null;
  private flashes: { index: number; result: GateResult; age: number }[] = [];
  private readonly color = new THREE.Color();
  private time = 0;

  constructor() {
    this.glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.amber), transparent: true, opacity: 0.03, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.glow.visible = false;
    this.object.add(this.glow);
  }

  /** Show the gates of this canyon (null: none). */
  setCanyon(c: Canyon | null): void {
    if (this.mesh) {
      this.object.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    this.canyon = c;
    this.flashes = [];
    this.glow.visible = false;
    if (!c || c.gates.length === 0) return;
    const origin = new THREE.Vector3(c.x[0], c.floor[0], c.z[0]);
    this.object.position.copy(origin);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), c.gates.length * 4);
    mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    const basis = new THREE.Matrix4();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3();
    const along = new THREE.Vector3();
    const pos = new THREE.Vector3();
    for (const g of c.gates) {
      right.set(-g.tz, 0, g.tx);
      along.set(g.tx, 0, g.tz);
      basis.makeBasis(right, up, along);
      const centre = new THREE.Vector3(g.x, g.y, g.z).sub(origin);
      const bars: [number, number, number, number][] = [
        // offset right, offset up, size along right, size along up
        [0, g.height / 2 + BAR / 2, g.width + 2 * BAR, BAR],
        [0, -(g.height / 2 + BAR / 2), g.width + 2 * BAR, BAR],
        [-(g.width / 2 + BAR / 2), 0, BAR, g.height],
        [g.width / 2 + BAR / 2, 0, BAR, g.height],
      ];
      bars.forEach(([ox, oy, sx, sy], k) => {
        pos.copy(centre).addScaledVector(right, ox).addScaledVector(up, oy);
        m.copy(basis).scale(new THREE.Vector3(sx, sy, BAR)).setPosition(pos);
        mesh.setMatrixAt(g.index * 4 + k, m);
        mesh.setColorAt(g.index * 4 + k, C_UPCOMING);
      });
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.mesh = mesh;
    this.object.add(mesh);
  }

  /** A gate was just passed or missed: flash it. */
  flash(index: number, result: GateResult): void {
    this.flashes.push({ index, result, age: 0 });
  }

  /** Colour the gates from the run's results; `next` is the gate to fly through next. */
  update(results: readonly (GateResult | undefined)[], next: number, dt: number): void {
    const mesh = this.mesh;
    const c = this.canyon;
    if (!mesh || !c) return;
    this.time += dt;
    for (const f of this.flashes) f.age += dt;
    this.flashes = this.flashes.filter((f) => f.age < FLASH_S);
    const pulse = 0.75 + 0.25 * Math.sin(this.time * 6);
    for (const g of c.gates) {
      const r = results[g.index];
      const flash = this.flashes.find((f) => f.index === g.index);
      if (flash) {
        const k = 1 - flash.age / FLASH_S;
        this.color.copy(flash.result === 'passed' ? C_DARK : C_MISSED_DIM).lerp(flash.result === 'passed' ? C_PASSED : C_MISSED, k);
      } else if (r === 'passed') this.color.copy(C_DARK);
      else if (r === 'missed') this.color.copy(C_MISSED_DIM);
      else if (g.index === next) this.color.copy(C_NEXT).multiplyScalar(pulse);
      else this.color.copy(C_UPCOMING);
      for (let k = 0; k < 4; k++) mesh.setColorAt(g.index * 4 + k, this.color);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const g = c.gates[next];
    this.glow.visible = !!g;
    if (g) {
      this.glow.position.set(g.x - this.object.position.x, g.y - this.object.position.y, g.z - this.object.position.z);
      this.glow.scale.set(g.width, g.height, 1);
      this.glow.rotation.set(0, Math.atan2(g.tx, g.tz), 0);
      (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.012 + 0.012 * pulse;
    }
  }
}

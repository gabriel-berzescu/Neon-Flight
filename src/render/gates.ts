/**
 * The gates of a canyon run: neon frames across the canyon, one mesh a gate (its four bars merged).
 *
 *   upcoming   dim cyan
 *   next       bright amber, pulsing, with a faint glow across the opening
 *   passed     a green flash, then dark
 *   missed     a red flash, then dim red
 *
 * A gate changes state by swapping its material for one of a few shared ones; the pulse and the flashes animate those materials'
 * colours (a uniform each). Nothing is written to a vertex buffer per frame: rewriting an instanced colour buffer every frame
 * stalled the Intel GPU (ANGLE / D3D11) by ~7 ms a frame.
 *
 * The gates sit relative to the canyon's mouth (small numbers for the GPU, see coords.ts).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Canyon } from '../world/canyon';
import type { GateResult } from '../game/canyon-run';
import { PALETTE } from './palette';

const BAR = 1.2;
const FLASH_S = 0.8;

const C_NEXT = new THREE.Color(PALETTE.amber).multiplyScalar(1.6);
const C_PASSED = new THREE.Color(0x4dff9a).multiplyScalar(2);
const C_MISSED = new THREE.Color(0xff3355).multiplyScalar(1.8);
const C_DARK = new THREE.Color(0x0a1830);
const C_MISSED_DIM = new THREE.Color(0xff3355).multiplyScalar(0.35);

const basic = (c: THREE.Color) => new THREE.MeshBasicMaterial({ color: c.clone() });

export class GatesView {
  readonly object = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly glow: THREE.Mesh;
  private canyon: Canyon | null = null;
  private flashes: { index: number; result: GateResult; age: number }[] = [];
  private time = 0;
  private readonly mat = {
    upcoming: basic(new THREE.Color(PALETTE.cyan).multiplyScalar(0.9)),
    next: basic(C_NEXT),
    passed: basic(C_DARK),
    missed: basic(C_MISSED_DIM),
    flashPass: basic(C_PASSED),
    flashMiss: basic(C_MISSED),
  };

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
    for (const m of this.meshes) {
      this.object.remove(m);
      m.geometry.dispose();
    }
    this.meshes.length = 0;
    this.canyon = c;
    this.flashes = [];
    this.glow.visible = false;
    if (!c || c.gates.length === 0) return;
    const origin = new THREE.Vector3(c.x[0], c.floor[0], c.z[0]);
    this.object.position.copy(origin);
    const basis = new THREE.Matrix4();
    const m = new THREE.Matrix4();
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
      const parts = bars.map(([ox, oy, sx, sy]) => {
        pos.copy(centre).addScaledVector(right, ox).addScaledVector(up, oy);
        m.copy(basis).scale(new THREE.Vector3(sx, sy, BAR)).setPosition(pos);
        return new THREE.BoxGeometry(1, 1, 1).applyMatrix4(m);
      });
      const mesh = new THREE.Mesh(mergeGeometries(parts), this.mat.upcoming);
      for (const p of parts) p.dispose();
      this.meshes.push(mesh);
      this.object.add(mesh);
    }
  }

  /** A gate was just passed or missed: flash it. */
  flash(index: number, result: GateResult): void {
    this.flashes.push({ index, result, age: 0 });
  }

  /** Colour the gates from the run's results; `next` is the gate to fly through next. */
  update(results: readonly (GateResult | undefined)[], next: number, dt: number): void {
    const c = this.canyon;
    if (!c || this.meshes.length === 0) return;
    this.time += dt;
    for (const f of this.flashes) f.age += dt;
    this.flashes = this.flashes.filter((f) => f.age < FLASH_S);
    const pulse = 0.75 + 0.25 * Math.sin(this.time * 6);
    this.mat.next.color.copy(C_NEXT).multiplyScalar(pulse);
    // (one flash at a time is the usual case: gates are seconds apart; the newest of each kind sets its material)
    const newest = (r: GateResult) => this.flashes.filter((f) => f.result === r).at(-1);
    const fp = newest('passed');
    const fm = newest('missed');
    if (fp) this.mat.flashPass.color.copy(C_DARK).lerp(C_PASSED, 1 - fp.age / FLASH_S);
    if (fm) this.mat.flashMiss.color.copy(C_MISSED_DIM).lerp(C_MISSED, 1 - fm.age / FLASH_S);
    for (const g of c.gates) {
      const r = results[g.index];
      const flash = this.flashes.find((f) => f.index === g.index);
      this.meshes[g.index].material = flash
        ? flash.result === 'passed'
          ? this.mat.flashPass
          : this.mat.flashMiss
        : r === 'passed'
          ? this.mat.passed
          : r === 'missed'
            ? this.mat.missed
            : g.index === next
              ? this.mat.next
              : this.mat.upcoming;
    }
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

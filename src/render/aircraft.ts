/**
 * The Neon Wing's 3D model: a dark lofted flying wing with neon edges, two moving elevons and two jet exhausts.
 *
 * Built from the same geometry as src/fdm/aircraft/neonwing/neonwing.xml. JSBSim's structural frame is x aft from the nose,
 * y right, z up; the model's origin is the CG (x = 3.6) with the nose along -z, right wing +x, up +y. So
 * model = (y_s, z_s, x_s - 3.6).
 *
 * `update(state, dt)` poses it: elevon deflections (trailing edge up = positive), exhaust length and glow from each engine's
 * spool and thrust, and wingtip vapour trails that appear under g.
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { PALETTE } from './palette';
import type { FlightState } from '../flight/flight';

const CG_X = 3.6;
const HALF_SPAN = 4.5;
/** Elevon span (y) and chord (m). */
const ELEVON_Y0 = 2.4;
const ELEVON_Y1 = 4.4;
const ELEVON_CHORD = 0.6;
const ELEVON_MAX = 0.349;
const ENGINE_Y = 0.75;
const NOZZLE_X = 6.05;

/** Structural (x aft, y right, z up) -> model. */
const S = (x: number, y: number, z: number) => new THREE.Vector3(y, z, x - CG_X);

/** Leading edge x at span y (a rounded nose, then a 42 deg sweep to the tip). */
function leadingEdge(y: number): number {
  const a = Math.abs(y);
  if (a <= 0.8) return 1.6 * Math.sqrt(a / 0.8);
  return 1.6 + ((a - 0.8) / (HALF_SPAN - 0.8)) * (4.9 - 1.6);
}
/** Trailing edge x at span y (the W planform: centre tail, inboard notch at 2.2, tip). */
function trailingEdge(y: number): number {
  const a = Math.abs(y);
  if (a <= 2.2) return 6.4 - (a / 2.2) * 1.5;
  return 4.9 + ((a - 2.2) / (HALF_SPAN - 2.2)) * 1.0;
}
/** The fixed wing's aft edge: the trailing edge, or the elevon hinge line where there is an elevon. */
function bodyAft(y: number): number {
  const a = Math.abs(y);
  return a >= ELEVON_Y0 && a <= ELEVON_Y1 ? trailingEdge(a) - ELEVON_CHORD : trailingEdge(a);
}
/** Section thickness (m) at span y. */
function thickness(y: number): number {
  const a = Math.abs(y) / HALF_SPAN;
  return 0.06 + 0.44 * Math.pow(1 - a, 1.6);
}
/** Half-thickness distribution along the chord (0 = LE, 1 = TE), a NACA-like 4-digit shape, 1 at its maximum. */
function profile(t: number): number {
  const s = Math.max(0, Math.min(1, t));
  const v = 2.969 * Math.sqrt(s) - 1.26 * s - 3.516 * s * s + 2.843 * s * s * s - 1.015 * s * s * s * s;
  return Math.max(0, v) + 0.02 * (1 - s);
}

function loftWing(): THREE.BufferGeometry {
  const stations = [-4.5, -4.4, -3.8, -3.0, -2.4, -2.2, -1.5, -0.8, -0.35, 0, 0.35, 0.8, 1.5, 2.2, 2.4, 3.0, 3.8, 4.4, 4.5];
  const chordwise = 14;
  const positions: number[] = [];
  const index: number[] = [];
  const ring = (chordwise + 1) * 2;
  for (const y of stations) {
    const le = leadingEdge(y), te = bodyAft(y);
    const th = thickness(y);
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i <= chordwise; i++) {
        const t = 1 - Math.cos((i / chordwise) * Math.PI * 0.5); // denser near the nose
        const x = le + (te - le) * t;
        const z = (side === 0 ? 1 : -0.55) * th * 0.5 * profile(t);
        const p = S(x, y, z);
        positions.push(p.x, p.y, p.z);
      }
    }
  }
  for (let j = 0; j < stations.length - 1; j++) {
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < chordwise; i++) {
        const a = j * ring + side * (chordwise + 1) + i;
        const b = a + 1;
        const c = a + ring;
        const d = c + 1;
        if (side === 0) index.push(a, c, b, b, c, d);
        else index.push(a, b, c, b, d, c);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** The neon outline: leading edge, trailing edges, tips (one closed loop per side). */
function outlinePoints(): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const up = 0.02;
  const seg = (side: number) => {
    const s = side;
    const out: THREE.Vector3[] = [];
    for (let k = 0; k <= 16; k++) {
      const y = (k / 16) * HALF_SPAN;
      out.push(S(leadingEdge(y), s * y, up));
    }
    // tip, then the fixed trailing edge: around the elevon cut-out (along its hinge line) and in to the tail
    const te = (y: number) => S(trailingEdge(y), s * y, up);
    const hinge = (y: number) => S(trailingEdge(y) - ELEVON_CHORD, s * y, up);
    out.push(te(HALF_SPAN), te(ELEVON_Y1), hinge(ELEVON_Y1), hinge(ELEVON_Y0), te(ELEVON_Y0), te(2.2), te(0));
    return out;
  };
  for (const side of [seg(1), seg(-1)]) for (let i = 0; i < side.length - 1; i++) pts.push(side[i], side[i + 1]);
  return pts;
}

function neon(color: number, strength: number): THREE.Color {
  return new THREE.Color(color).multiplyScalar(strength);
}

/** Neon edges: screen-space thick lines (pairs of points), bright enough to bloom. */
function neonLines(points: THREE.Vector3[], material: LineMaterial): LineSegments2 {
  const g = new LineSegmentsGeometry();
  g.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
  const l = new LineSegments2(g, material);
  l.computeLineDistances();
  return l;
}

/** The body: dark metal under the scene's lights, plus a fresnel rim glow so the silhouette reads against the night sky. */
function bodyMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x15132e, roughness: 0.32, metalness: 0.55, side: THREE.DoubleSide });
  const rim = { value: new THREE.Color(0x7a3cff).multiplyScalar(0.9) };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uRim = rim;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float nfRim = 1.0 - abs(dot(normalize(vViewPosition), normal));
        totalEmissiveRadiance += uRim * pow(nfRim, 3.0);`,
      );
  };
  return m;
}

class Elevon {
  readonly pivot = new THREE.Object3D();
  private readonly axis = new THREE.Vector3();

  constructor(side: 1 | -1, body: THREE.Material, edge: LineMaterial) {
    const h0 = S(bodyAft(ELEVON_Y0), side * ELEVON_Y0, 0);
    const h1 = S(bodyAft(ELEVON_Y1), side * ELEVON_Y1, 0);
    const t0 = S(trailingEdge(ELEVON_Y0), side * ELEVON_Y0, 0);
    const t1 = S(trailingEdge(ELEVON_Y1), side * ELEVON_Y1, 0);
    this.pivot.position.copy(h0);
    this.axis.subVectors(h1, h0).normalize();
    const rel = (v: THREE.Vector3) => v.clone().sub(h0);
    const th0 = thickness(ELEVON_Y0) * 0.16, th1 = thickness(ELEVON_Y1) * 0.16;
    const v = [rel(h0), rel(h1), rel(t1), rel(t0)];
    const pos: number[] = [];
    // a thin wedge: top and bottom faces meeting at the trailing edge
    const top = [v[0].clone().setY(th0), v[1].clone().setY(th1), v[2], v[3]];
    const bot = [v[0].clone().setY(-th0 * 0.6), v[1].clone().setY(-th1 * 0.6), v[2], v[3]];
    const quad = (q: THREE.Vector3[], flip: boolean) => {
      const tri = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      for (const i of tri) pos.push(q[i].x, q[i].y, q[i].z);
    };
    const flip = side < 0;
    quad(top, flip);
    quad(bot, !flip);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    this.pivot.add(new THREE.Mesh(g, body));
    this.pivot.add(neonLines([v[3], v[2], v[2], v[1], v[0], v[3]].map((p) => p.clone().setY(p.y + 0.03)), edge));
  }

  /** Deflection, -1..1 (trailing edge up = positive). */
  set(norm: number): void {
    // Rotating about the hinge axis (inboard -> outboard): for the right wing that axis points +x-ish, and a positive angle
    // would lower the trailing edge; the left hinge points the other way. Sign per side keeps "positive = TE up".
    const sideSign = this.axis.x >= 0 ? -1 : 1;
    this.pivot.quaternion.setFromAxisAngle(this.axis, sideSign * norm * ELEVON_MAX);
  }
}

class Exhaust {
  readonly group = new THREE.Group();
  private readonly plume: THREE.Mesh;
  private readonly core: THREE.Mesh;
  private readonly plumeMat: THREE.MeshBasicMaterial;
  private readonly coreMat: THREE.MeshBasicMaterial;

  constructor(side: 1 | -1) {
    this.group.position.copy(S(NOZZLE_X, side * ENGINE_Y, 0.12));
    this.plumeMat = new THREE.MeshBasicMaterial({ color: neon(PALETTE.amber, 2), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
    this.coreMat = new THREE.MeshBasicMaterial({ color: neon(0xfff0d0, 2.4), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    // cones from the nozzle (base) back along +z (apex), stretched by thrust
    const plumeGeo = new THREE.ConeGeometry(0.2, 1, 20, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    const coreGeo = new THREE.ConeGeometry(0.11, 1, 16, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    this.plume = new THREE.Mesh(plumeGeo, this.plumeMat);
    this.core = new THREE.Mesh(coreGeo, this.coreMat);
    const nozzle = new THREE.Mesh(
      new THREE.TorusGeometry(0.2, 0.035, 8, 24),
      new THREE.MeshBasicMaterial({ color: neon(PALETTE.cyan, 2.5) }),
    );
    this.group.add(nozzle, this.plume, this.core);
  }

  /** spool 0 (idle) .. 1 (full), thrust fraction 0..1. */
  set(spool: number, thrust: number, flicker: number): void {
    const len = 0.4 + 3.2 * thrust * (0.92 + 0.08 * flicker);
    this.plume.scale.set(1 + 0.25 * thrust, 1 + 0.25 * thrust, len);
    this.core.scale.set(1, 1, len * 0.55);
    this.plumeMat.opacity = 0.12 + 0.4 * thrust;
    this.coreMat.opacity = 0.3 + 0.7 * spool;
    this.plumeMat.color.copy(new THREE.Color(PALETTE.amber).lerp(new THREE.Color(PALETTE.magenta), 1 - thrust).multiplyScalar(1.2 + 1.6 * thrust));
  }
}

/** A ribbon trail of a wingtip, in world space (the vapour of a hard turn). */
class Trail {
  readonly mesh: THREE.Mesh;
  private readonly n = 90;
  private readonly pts: THREE.Vector3[] = [];
  private readonly alpha: number[] = [];
  private readonly geo = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private head = 0;
  private filled = 0;

  constructor(color: number) {
    this.pos = new Float32Array(this.n * 2 * 3);
    this.col = new Float32Array(this.n * 2);
    for (let i = 0; i < this.n; i++) {
      this.pts.push(new THREE.Vector3());
      this.alpha.push(0);
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.col, 1).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < this.n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    const c = new THREE.Color(color).multiplyScalar(2.2);
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: { uColor: { value: c } },
        vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor * vA, vA); }',
      }),
    );
    this.mesh.frustumCulled = false;
  }

  reset(): void {
    this.filled = 0;
  }

  /** Add the tip's world position with this strength (0 = invisible). `side` is the world-space vector across the ribbon. */
  push(p: THREE.Vector3, strength: number): void {
    this.head = (this.head + 1) % this.n;
    this.pts[this.head].copy(p);
    this.alpha[this.head] = strength;
    this.filled = Math.min(this.n, this.filled + 1);
  }

  /** Rebuild the ribbon facing the camera; positions relative to `origin` (the ribbon mesh sits at `origin`). */
  build(camera: THREE.Camera, origin: THREE.Vector3): void {
    const width = 0.22;
    const toCam = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const side = new THREE.Vector3();
    for (let k = 0; k < this.n; k++) {
      const i = (this.head - k + this.n) % this.n;
      const valid = k < this.filled;
      const p = this.pts[i];
      const q = this.pts[(i - 1 + this.n) % this.n];
      dir.subVectors(p, q);
      toCam.subVectors(camera.position, p);
      side.crossVectors(dir, toCam).normalize().multiplyScalar(width * (1 + k * 0.02));
      const fade = valid ? this.alpha[i] * (1 - k / this.n) : 0;
      const o = k * 6;
      this.pos[o] = p.x - origin.x + side.x;
      this.pos[o + 1] = p.y - origin.y + side.y;
      this.pos[o + 2] = p.z - origin.z + side.z;
      this.pos[o + 3] = p.x - origin.x - side.x;
      this.pos[o + 4] = p.y - origin.y - side.y;
      this.pos[o + 5] = p.z - origin.z - side.z;
      this.col[k * 2] = fade;
      this.col[k * 2 + 1] = fade;
    }
    this.mesh.position.copy(origin);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
  }
}

export class AircraftView {
  /** The aircraft (moves with the flight state). */
  readonly object = new THREE.Group();
  /** World-space effects (trails); add to the scene next to `object`. */
  readonly effects = new THREE.Group();
  private readonly elevons: [Elevon, Elevon];
  private readonly exhausts: [Exhaust, Exhaust];
  private readonly trails: [Trail, Trail];
  private readonly tipL = S(trailingEdge(HALF_SPAN) - 0.3, -HALF_SPAN, 0.05);
  private readonly tipR = S(trailingEdge(HALF_SPAN) - 0.3, HALF_SPAN, 0.05);
  private readonly tmp = new THREE.Vector3();
  private readonly lineMaterials: LineMaterial[] = [];
  private time = 0;

  constructor() {
    const body = bodyMaterial();
    const edge = new LineMaterial({ color: neon(PALETTE.cyan, 3.2), linewidth: 2.6 });
    const fins = new LineMaterial({ color: neon(PALETTE.magenta, 3), linewidth: 2.6 });
    this.lineMaterials.push(edge, fins);
    const wing = new THREE.Mesh(loftWing(), body);
    this.object.add(wing);
    this.object.add(neonLines(outlinePoints(), edge));

    // canopy: a dark glass bump with a magenta rim
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x120a2a, roughness: 0.05, metalness: 0.9, emissive: new THREE.Color(PALETTE.magenta).multiplyScalar(0.08) }),
    );
    canopy.scale.set(0.42, 0.34, 1.0);
    canopy.position.copy(S(2.3, 0, 0.14));
    this.object.add(canopy);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.025, 6, 40), new THREE.MeshBasicMaterial({ color: neon(PALETTE.magenta, 2.6) }));
    rim.rotation.x = Math.PI / 2;
    rim.scale.set(0.42, 1.0, 1);
    rim.position.copy(S(2.3, 0, 0.15));
    this.object.add(rim);

    // engine nacelles: humps on top of the wing, ending in the nozzles
    for (const s of [1, -1] as const) {
      const nac = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 1.4, 6, 16).rotateX(Math.PI / 2), body);
      nac.position.copy(S(5.15, s * ENGINE_Y, 0.12));
      this.object.add(nac);
    }

    // winglets
    for (const s of [1, -1] as const) {
      const a = S(5.0, s * HALF_SPAN, 0.02), b = S(5.9, s * HALF_SPAN, 0.02);
      const c = S(6.15, s * (HALF_SPAN + 0.12), 0.9), d = S(5.7, s * (HALF_SPAN + 0.12), 0.9);
      const g = new THREE.BufferGeometry().setFromPoints([a, b, c, a, c, d]);
      g.computeVertexNormals();
      this.object.add(new THREE.Mesh(g, body));
      this.object.add(neonLines([a, d, d, c, c, b], fins));
    }

    this.elevons = [new Elevon(-1, body, edge), new Elevon(1, body, edge)];
    for (const e of this.elevons) this.object.add(e.pivot);
    this.exhausts = [new Exhaust(-1), new Exhaust(1)];
    for (const e of this.exhausts) this.object.add(e.group);
    this.trails = [new Trail(PALETTE.cyan), new Trail(PALETTE.magenta)];
    for (const t of this.trails) this.effects.add(t.mesh);
  }

  /** The drawing-buffer size, for the screen-space line widths. */
  setResolution(width: number, height: number): void {
    for (const m of this.lineMaterials) m.resolution.set(width, height);
  }

  /** Pose from the flight state (call once per frame, after the flight update). */
  update(s: FlightState, dt: number, camera: THREE.Camera): void {
    this.time += dt;
    this.object.position.copy(s.position);
    this.object.quaternion.copy(s.quaternion);
    this.elevons[0].set(s.elevons[0]);
    this.elevons[1].set(s.elevons[1]);
    for (let i = 0; i < 2; i++) {
      const spool = Math.max(0, Math.min(1, (s.n2[i] - 60) / 40));
      const thrust = Math.max(0, Math.min(1, s.thrust[i] / 11000));
      const flicker = Math.sin(this.time * 61 + i * 2.1) * 0.5 + Math.sin(this.time * 37 + i) * 0.5;
      this.exhausts[i].set(spool, thrust, flicker);
    }
    this.object.updateMatrixWorld();
    if (!s.crashed) {
      // vapour from about 3 g, full at 7 g; also at high angle of attack
      const vapour = Math.max(0, Math.min(1, (Math.abs(s.g) - 3) / 4)) * Math.min(1, s.speed / 80);
      const aoa = Math.max(0, Math.min(1, (s.alphaDeg - 10) / 5)) * 0.6;
      const strength = Math.max(vapour, aoa);
      this.trails[0].push(this.tmp.copy(this.tipL).applyMatrix4(this.object.matrixWorld), strength);
      this.trails[1].push(this.tmp.copy(this.tipR).applyMatrix4(this.object.matrixWorld), strength);
    }
    for (const t of this.trails) t.build(camera, s.position);
    this.object.visible = !s.crashed;
  }

  reset(): void {
    for (const t of this.trails) t.reset();
  }
}

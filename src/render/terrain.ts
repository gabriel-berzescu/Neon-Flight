/**
 * The terrain renderer: a GPU geometry clipmap. TERRAIN_LEVELS nested square grids around the camera, each twice as coarse as the
 * one inside it (2 m cells at the centre, 512 m at the rim, reaching ~57 km), all drawn by one vertex shader that evaluates the
 * terrain function itself (src/render/terrainGlsl.ts, the GLSL twin of heightAt() in src/world/terrain.ts). Nothing is uploaded
 * per frame except a few uniforms: no heightmaps, nothing to stream, endless in every direction.
 *
 * Level k has cells of 2 * 2^k m and is centred on the camera snapped to 4 * 2^k m, so its vertices stay fixed in the world as
 * the camera moves (no swimming). Level k leaves a hole where level k-1 lies; the hole is at most one cell off-centre, which is
 * why there are four index buffers per hole position. Near its outer rim a level morphs into the next coarser one (see
 * TERRAIN_VERT), so the seams are closed and nothing pops.
 *
 * Precision: the vertex shader works in positions relative to `origin`, the camera snapped to 2 m. The object sits at `origin`
 * (three.js builds the model-view matrix in float64), so everything the GPU sees is a small number. The noise lattice offsets for
 * that origin come from terrainLattice() in float64. World-fixed lines (grid) use the origin modulo 5000 m (after the grid shift).
 *
 * A canyon run (setCanyon) uploads its carve field (src/world/canyon-field.ts) as two float textures; the vertex shader carves it
 * into the terrain after the base height, addressed like the noise lattice (CanyonUniforms: the origin's cell and fraction in
 * the field's grid, float64 here). Set the same field on the CPU side (setActiveCanyon) so the physics flies the same canyon.
 */
import * as THREE from 'three';
import type { CanyonField } from '../world/canyon-field';
import { groundAt, TERRAIN_SLOT_COUNT, terrainLattice } from '../world/terrain';
import { PALETTE } from './palette';
import { SKY_UNIFORMS } from './skyGlsl';
import { TERRAIN_CELLS, TERRAIN_FOG_DISTANCE, TERRAIN_FRAG, TERRAIN_GRID_SHIFT, TERRAIN_LEVELS, TERRAIN_VERT } from './terrainGlsl';
export { TERRAIN_CELLS, TERRAIN_FOG_DISTANCE, TERRAIN_LEVELS };

const N = TERRAIN_CELLS;
const SIDE = N + 1;
if (N % 4 !== 0 || N < 32) throw new Error('TERRAIN_CELLS must be a multiple of 4 (the hole is a quarter of a level wide)');
/** The finest cell size (m). */
const CELL0 = 2;

/** One mesh "kind": the shared vertex grid with an index buffer that skips the hole (dx, dz = 0 or 1 cell off-centre). */
function buildGeometry(hole: { dx: number; dz: number } | null, positions: THREE.BufferAttribute): THREE.BufferGeometry {
  const idx: number[] = [];
  const lo = N / 4 + (hole ? hole.dx : 0);
  const hi = (3 * N) / 4 + (hole ? hole.dx : 0);
  const loZ = N / 4 + (hole ? hole.dz : 0);
  const hiZ = (3 * N) / 4 + (hole ? hole.dz : 0);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (hole && i >= lo && i < hi && j >= loZ && j < hiZ) continue;
      const v00 = j * SIDE + i;
      const v10 = v00 + 1;
      const v01 = v00 + SIDE;
      const v11 = v01 + 1;
      // the same diagonal everywhere (v00 - v11), so a morphed fine mesh is exactly the coarse mesh; counter-clockwise seen from above
      idx.push(v00, v11, v10, v00, v01, v11);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', positions);
  g.setIndex(new THREE.BufferAttribute(SIDE * SIDE <= 65536 ? new Uint16Array(idx) : new Uint32Array(idx), 1));
  // the vertex shader displaces everything: a fixed generous bound (and the object is never frustum culled anyway)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-1e6, -1e4, -1e6), new THREE.Vector3(1e6, 1e4, 1e6));
  return g;
}

/**
 * The uniforms of the canyon carve (CANYON_GLSL in terrainGlsl.ts): the field's textures and, per origin, where the origin lies in
 * the field's grid. Used by TerrainView, and by sandbox/terrain-check to test the GLSL against the CPU.
 */
export class CanyonUniforms {
  readonly uniforms = {
    uCanyonOn: { value: 0 },
    uCanyonField: { value: emptyFloatTexture() as THREE.Texture },
    uCanyonSec: { value: emptyFloatTexture() as THREE.Texture },
    uCanyonGrid: { value: new THREE.Vector4() },
    uCanyonDim: { value: new THREE.Vector4(2, 2, 1, 2) },
    uCanyonBox: { value: new THREE.Vector4() },
    uCanyonLen: { value: 0 },
  };
  private field: CanyonField | null = null;
  private textures: THREE.DataTexture[] = [];

  get active(): CanyonField | null {
    return this.field;
  }

  set(field: CanyonField | null): void {
    for (const t of this.textures) t.dispose();
    this.textures = [];
    this.field = field;
    const u = this.uniforms;
    if (!field) {
      u.uCanyonOn.value = 0;
      return;
    }
    const tex = (data: Float32Array, w: number, h: number): THREE.DataTexture => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      this.textures.push(t);
      return t;
    };
    u.uCanyonField.value = tex(field.data, field.nx, field.nz);
    u.uCanyonSec.value = tex(field.section, field.n, 1);
    u.uCanyonDim.value.set(field.nx, field.nz, 1 / field.cell, field.n);
    u.uCanyonLen.value = field.length;
    u.uCanyonOn.value = 1;
  }

  /** Per origin (the camera-snapped origin the shader's positions are relative to; float64 here). */
  update(ox: number, oz: number): void {
    const f = this.field;
    if (!f) return;
    const gx = (ox - f.x0) / f.cell;
    const gz = (oz - f.z0) / f.cell;
    const cx = Math.floor(gx);
    const cz = Math.floor(gz);
    this.uniforms.uCanyonGrid.value.set(cx, cz, gx - cx, gz - cz);
    this.uniforms.uCanyonBox.value.set(f.minX - ox, f.minZ - oz, f.maxX - ox, f.maxZ - oz);
  }

  dispose(): void {
    this.set(null);
    this.uniforms.uCanyonField.value.dispose();
    this.uniforms.uCanyonSec.value.dispose();
  }
}

function emptyFloatTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
}

export class TerrainView {
  readonly object = new THREE.Group();

  private readonly positions: THREE.BufferAttribute;
  private readonly full: THREE.BufferGeometry;
  /** hole variants indexed by dx + 2 * dz */
  private readonly holes: THREE.BufferGeometry[] = [];
  private readonly meshes: THREE.Mesh[] = [];
  private readonly materials: THREE.ShaderMaterial[] = [];
  private readonly lattice = new Float32Array(TERRAIN_SLOT_COUNT * 4);
  private readonly canyon = new CanyonUniforms();

  private readonly shared = {
    uSlot: { value: this.lattice as unknown as THREE.Vector4[] },
    uCam: { value: new THREE.Vector2() },
    uGridOff: { value: new THREE.Vector2() },
    uTime: { value: 0 },
    uAgl: { value: 1000 },
    uDebug: { value: 0 },
    uPlanes: { value: new Float32Array(24) as unknown as THREE.Vector4[] },
    uGround: { value: new THREE.Color(PALETTE.ground) },
    uWater: { value: new THREE.Color(PALETTE.water) },
    uCyan: { value: new THREE.Color(PALETTE.cyan) },
    uMagenta: { value: new THREE.Color(PALETTE.magenta) },
    uAmber: { value: new THREE.Color(PALETTE.amber) },
    ...SKY_UNIFORMS,
    ...this.canyon.uniforms,
  };

  private readonly tmp = new THREE.Vector3();
  private readonly clip = new THREE.Matrix4();
  /** Frustum culling of vertices in the vertex shader (it only skips work: the picture is the same). */
  cull = true;

  /** Debug views: 0 = normal, 1 = colour by clipmap level (darker where morphing), 2 = morph amount, 3 = flat green (to find cracks), 4 = geometry only, 5 = positions as floats (for sandbox/terrain-check). */
  set debugMode(v: number) {
    this.shared.uDebug.value = v;
  }
  get debugMode(): number {
    return this.shared.uDebug.value;
  }
  set wireframe(v: boolean) {
    for (const m of this.materials) m.wireframe = v;
  }

  constructor() {
    const pos = new Float32Array(SIDE * SIDE * 3);
    for (let j = 0; j < SIDE; j++) {
      for (let i = 0; i < SIDE; i++) {
        const o = (j * SIDE + i) * 3;
        pos[o] = i;
        pos[o + 2] = j;
      }
    }
    this.positions = new THREE.BufferAttribute(pos, 3);
    this.full = buildGeometry(null, this.positions);
    for (let k = 0; k < 4; k++) this.holes.push(buildGeometry({ dx: k & 1, dz: k >> 1 }, this.positions));

    for (let k = 0; k < TERRAIN_LEVELS; k++) {
      const material = new THREE.ShaderMaterial({
        uniforms: { ...this.shared, uLevel: { value: new THREE.Vector4(CELL0 * 2 ** k, 0, 0, k) } },
        vertexShader: TERRAIN_VERT,
        fragmentShader: TERRAIN_FRAG,
        // single-sided: it is a heightfield seen from above (the camera must stay above the ground, as the chase camera does)
      });
      const mesh = new THREE.Mesh(k === 0 ? this.full : this.holes[0], material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = true;
      mesh.name = `terrain-level-${k}`;
      // the frustum used for culling vertices is the one of the camera that really draws, whatever it did since update()
      mesh.onBeforeRender = (_renderer, _scene, cam) => this.updatePlanes(cam as THREE.PerspectiveCamera);
      this.materials.push(material);
      this.meshes.push(mesh);
      this.object.add(mesh);
    }
    this.object.name = 'terrain';
  }

  /**
   * Carves a canyon run into the picture (null: the plain terrain). Pass the field given to setActiveCanyon() (src/world/terrain.ts),
   * so the physics and the picture agree. Uploads two float textures (the field: 4-12 MB; the section table: 19 KB).
   */
  setCanyon(field: CanyonField | null): void {
    this.canyon.set(field);
  }

  /** Call every frame before rendering. */
  update(camera: THREE.PerspectiveCamera, timeSeconds: number): void {
    camera.updateMatrixWorld();
    camera.getWorldPosition(this.tmp);
    const cx = this.tmp.x;
    const cz = this.tmp.z;

    // the origin: the camera snapped to the finest cell size, so every level's grid is a whole number of metres from it
    const ox = Math.floor(cx / CELL0) * CELL0;
    const oz = Math.floor(cz / CELL0) * CELL0;
    this.object.position.set(ox, 0, oz);

    this.shared.uCam.value.set(cx - ox, cz - oz);
    this.shared.uGridOff.value.set(mod(ox - TERRAIN_GRID_SHIFT.x, 5000), mod(oz - TERRAIN_GRID_SHIFT.z, 5000));
    this.shared.uTime.value = timeSeconds;
    this.shared.uAgl.value = this.tmp.y - groundAt(cx, cz);
    terrainLattice(ox, oz, this.lattice);
    this.canyon.update(ox, oz);
    this.updatePlanes(camera);

    for (let k = 0; k < TERRAIN_LEVELS; k++) {
      const c = CELL0 * 2 ** k;
      // level k is centred on the camera snapped to 2c; the next finer level on the camera snapped to c
      const ckx = Math.floor(cx / (2 * c)) * 2 * c;
      const ckz = Math.floor(cz / (2 * c)) * 2 * c;
      this.materials[k].uniforms.uLevel.value.set(c, ckx - ox, ckz - oz, k);
      if (k > 0) {
        const fx = Math.floor(cx / c) * c;
        const fz = Math.floor(cz / c) * c;
        const dx = Math.round((fx - ckx) / c);
        const dz = Math.round((fz - ckz) / c);
        this.meshes[k].geometry = this.holes[dx + 2 * dz];
      }
    }
  }

  /** The view frustum's six planes in the object's local space (relative to the origin), for the vertex shader's culling. */
  private updatePlanes(camera: THREE.PerspectiveCamera): void {
    const planes = this.shared.uPlanes.value as unknown as Float32Array;
    if (!this.cull) {
      // every plane is "everything is inside"
      for (let i = 0; i < 6; i++) planes.set([0, 0, 0, 1e9], i * 4);
      return;
    }
    this.object.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    this.clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.object.matrixWorld);
    const e = this.clip.elements;
    // rows of the clip matrix: r_i = (e[i], e[4 + i], e[8 + i], e[12 + i]); the six planes are r3 + r0, r3 - r0, r3 + r1, ... (left,
    // right, bottom, top, near, far); a point is inside where dot(plane.xyz, p) + plane.w >= 0
    for (let k = 0; k < 6; k++) {
      const row = k >> 1;
      const sign = k & 1 ? -1 : 1;
      for (let c = 0; c < 4; c++) planes[k * 4 + c] = e[c * 4 + 3] + sign * e[c * 4 + row];
    }
  }

  dispose(): void {
    this.full.dispose();
    for (const g of this.holes) g.dispose();
    for (const m of this.materials) m.dispose();
    this.canyon.dispose();
    this.object.clear();
  }
}

function mod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

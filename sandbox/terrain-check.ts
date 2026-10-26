/**
 * Does the GPU draw the surface the physics uses?
 *
 *  1. height: renders terrainHD() (the GLSL twin of heightAt) at sample points into a float render target for many camera-snapped
 *     origins, up to +-300 km from the world origin, and compares with heightAt() in float64. The samples lie within ~100 m of the
 *     camera, where every octave is at full strength. Result: window.__CHECK__ = { maxErr, p999Err, ... } (metres).
 *  2. mesh: renders the real TerrainView (clipmap, morph, culling, origin offsets) from above into a float target that holds each
 *     pixel's position, and compares the height the mesh has there with heightAt(x, z) at that very (x, z). The difference is what
 *     the physics could ever disagree with the picture about: the sag of the linear interpolation between vertices plus the GPU
 *     error. Reported for the 2 m zone (within 120 m of the camera) and for everything within 400 m (4-8 m cells).
 *     Result: window.__CHECK_MESH__ = { near: {...}, mid: {...}, views: [...] }.
 *  3. snap: renders the mesh with the camera 4 mm either side of a point where EVERY clipmap level re-centres (a multiple of
 *     1024 m), and as a control 4 mm either side of a point where none does. The mesh error map (|mesh - heightAt|) must not
 *     change more across the snap than across the control: a pop would show as a jump. Result: window.__CHECK_SNAP__.
 *
 * ?canyon=<seed>: the same three checks for a canyon run (src/world/canyon-field.ts) carved into both: the CPU's heightAt (via
 * setActiveCanyon) and the GPU's (canyonApply after terrainHD, TerrainView.setCanyon). The height check samples around origins all
 * along the canyon and across it (floor, walls, rim, mesa); the mesh check looks at the walls from inside the canyon and also
 * reports the error measured perpendicular to the surface (on a wall of slope 8, 1 cm sideways is 8 cm of height); the snap check
 * puts the camera on the clipmap snap point nearest to the canyon.
 *
 * window.__READY__ = true when done.
 * Run:  node scripts/shot.mjs "sandbox/terrain-check.html" --port 5242 --ready --eval "window.__CHECK__"
 *       node scripts/shot.mjs "sandbox/terrain-check.html?canyon=123" --port 5242 --ready --eval "[window.__CHECK__, window.__CHECK_MESH__, window.__CHECK_SNAP__]"
 */
import * as THREE from 'three';
import { baseHeightAt, heightAt, setActiveCanyon, terrainLattice, TERRAIN_SLOT_COUNT } from '../src/world/terrain';
import { CANYON_GLSL, TERRAIN_HEIGHT_GLSL } from '../src/render/terrainGlsl';
import { CanyonUniforms, TerrainView } from '../src/render/terrain';
import { generateCanyon, type Canyon } from '../src/world/canyon';
import { buildCanyonField, type CanyonField } from '../src/world/canyon-field';

declare global {
  interface Window {
    __READY__?: boolean;
    __CHECK__?: unknown;
    __CHECK_MESH__?: unknown;
    __CHECK_SNAP__?: unknown;
  }
}

const N = 36; // samples per side per origin
const STEP = 4.1; // metres between samples

// ?canyon=<seed>: carve that canyon run into both sides
const params = new URLSearchParams(location.search);
let canyon: Canyon | null = null;
let field: CanyonField | null = null;
const canyonUniforms = new CanyonUniforms();
if (params.has('canyon')) {
  canyon = generateCanyon(+params.get('canyon')! >>> 0, baseHeightAt);
  field = buildCanyonField(canyon);
  setActiveCanyon(field);
  canyonUniforms.set(field);
}

const FRAG = /* glsl */ `
${TERRAIN_HEIGHT_GLSL}
${CANYON_GLSL}
uniform vec2 uCam;
void main() {
  vec2 ij = floor(gl_FragCoord.xy);
  vec2 p = (ij - ${(N / 2 - 0.5).toFixed(1)}) * ${STEP.toFixed(2)};
  vec3 hd = canyonApply(terrainHD(p, uCam), p);
  gl_FragColor = vec4(hd, 1.0);
}
`;
const VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
const target = new THREE.WebGLRenderTarget(N, N, {
  type: THREE.FloatType,
  format: THREE.RGBAFormat,
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  depthBuffer: false,
});
const lattice = new Float32Array(TERRAIN_SLOT_COUNT * 4);
const material = new THREE.ShaderMaterial({
  uniforms: { uSlot: { value: lattice as unknown as THREE.Vector4[] }, uCam: { value: new THREE.Vector2() }, ...canyonUniforms.uniforms },
  vertexShader: VERT,
  fragmentShader: FRAG,
});
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const scene = new THREE.Scene();
const quad = new THREE.Mesh(geometry, material);
quad.frustumCulled = false;
scene.add(quad);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// deterministic origins: the spawn, then a spread of points up to +-300 km (and some that are exactly on lattice-ish values)
let seed = 12345;
const rnd = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const origins: Array<[number, number]> = [[0, 0], [2, -4], [-20000, 3000], [300000, 300000], [-300000, 300000], [300000, -300000], [-300000, -300000]];
for (let i = 0; i < 150; i++) {
  const r = i < 50 ? 8000 : i < 100 ? 80000 : 300000;
  origins.push([Math.floor((rnd() * 2 - 1) * r / 2) * 2, Math.floor((rnd() * 2 - 1) * r / 2) * 2]);
}
if (canyon) {
  // all along the canyon (from behind the mouth to past the exit) and across it: floor, walls, rim, mesa, the fade
  origins.length = 0;
  for (let s = -150; s <= canyon.length + 150; s += 200) {
    const i = Math.max(0, Math.min(canyon.n - 1, Math.round(s / 10)));
    const ext = s < 0 ? s : s > canyon.length ? s - canyon.length : 0;
    for (const lat of [0, -60, 60, -130, 130, -220, 450, -1500]) {
      const x = canyon.x[i] + canyon.tx[i] * ext - canyon.tz[i] * lat;
      const z = canyon.z[i] + canyon.tz[i] * ext + canyon.tx[i] * lat;
      origins.push([Math.floor(x / 2) * 2, Math.floor(z / 2) * 2]);
    }
  }
}

const buf = new Float32Array(N * N * 4);
let maxErr = 0;
let maxGradErr = 0;
const errs: number[] = [];
const gradErrs: number[] = [];
const perOrigin: Array<{ o: [number, number]; max: number; hmax: number; hmin: number }> = [];
let worst: { o: [number, number]; i: number; j: number; gpu: number; cpu: number } | null = null;
let nonSea = 0;

renderer.setRenderTarget(target);
for (const [ox, oz] of origins) {
  terrainLattice(ox, oz, lattice);
  canyonUniforms.update(ox, oz);
  // the camera is a little off the origin, like in the game (the origin is the camera snapped to 2 m)
  (material.uniforms.uCam.value as THREE.Vector2).set(0.7, 1.3);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, N, N, buf);
  let m = 0;
  let hmax = -1e9;
  let hmin = 1e9;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const px = (i - (N / 2 - 0.5)) * STEP;
      const pz = (j - (N / 2 - 0.5)) * STEP;
      const cpu = heightAt(ox + px, oz + pz);
      const o = (j * N + i) * 4;
      const gpu = buf[o];
      const e = Math.abs(gpu - cpu);
      errs.push(e);
      if (e > m) m = e;
      if (e > maxErr) {
        maxErr = e;
        worst = { o: [ox, oz], i, j, gpu, cpu };
      }
      hmax = Math.max(hmax, cpu);
      hmin = Math.min(hmin, cpu);
      if (cpu > -50) {
        // gradient: central difference of the CPU function against the GPU's analytic gradient
        const d = 0.5;
        const gx = (heightAt(ox + px + d, oz + pz) - heightAt(ox + px - d, oz + pz)) / (2 * d);
        const gz = (heightAt(ox + px, oz + pz + d) - heightAt(ox + px, oz + pz - d)) / (2 * d);
        const ge = Math.hypot(buf[o + 1] - gx, buf[o + 2] - gz);
        gradErrs.push(ge);
        if (ge > maxGradErr) maxGradErr = ge;
        nonSea++;
      }
    }
  }
  perOrigin.push({ o: [ox, oz], max: m, hmax, hmin });
}
renderer.setRenderTarget(null);

errs.sort((a, b) => a - b);
gradErrs.sort((a, b) => a - b);
const pct = (a: number[], p: number): number => a[Math.min(a.length - 1, Math.floor(p * a.length))];
const result = {
  origins: origins.length,
  samples: errs.length,
  maxErr,
  p999Err: pct(errs, 0.999),
  p99Err: pct(errs, 0.99),
  medianErr: pct(errs, 0.5),
  worst,
  worstOrigins: [...perOrigin].sort((a, b) => b.max - a.max).slice(0, 5),
  gradSamples: nonSea,
  gradMedian: pct(gradErrs, 0.5),
  gradP99: pct(gradErrs, 0.99),
  gradMax: maxGradErr,
  heightRange: [Math.min(...perOrigin.map((p) => p.hmin)), Math.max(...perOrigin.map((p) => p.hmax))],
};
window.__CHECK__ = result;

// ---- 2. the real mesh
const MW = 480;
const MH = 270;
const meshTarget = new THREE.WebGLRenderTarget(MW, MH, {
  type: THREE.FloatType,
  format: THREE.RGBAFormat,
  minFilter: THREE.NearestFilter,
  magFilter: THREE.NearestFilter,
  depthBuffer: true,
});
const terrain = new TerrainView();
terrain.debugMode = 5;
terrain.setCanyon(field);
const meshScene = new THREE.Scene();
meshScene.add(terrain.object);
const cam = new THREE.PerspectiveCamera(65, MW / MH, 0.5, 60000);
const meshBuf = new Float32Array(MW * MH * 4);
const views: Array<{ x: number; z: number; agl: number; yaw: number; pitch: number; maxDist: number }> = [
  { x: 0.3, z: 0.7, agl: 120, yaw: 0, pitch: -89.9, maxDist: 400 },
  { x: 0.3, z: 0.7, agl: 400, yaw: 30, pitch: -60, maxDist: 400 },
  { x: 3001.37, z: -4003.91, agl: 150, yaw: 200, pitch: -75, maxDist: 400 },
  { x: 14003.5, z: -17001.1, agl: 90, yaw: 0, pitch: -45, maxDist: 400 },
  { x: 250000.4, z: -280000.9, agl: 130, yaw: 60, pitch: -80, maxDist: 400 },
  { x: -299999.7, z: 299999.2, agl: 300, yaw: 10, pitch: -55, maxDist: 400 },
  { x: 123456.1, z: -99999.9, agl: 200, yaw: 100, pitch: -70, maxDist: 400 },
  { x: -2047.9, z: 2049.1, agl: 60, yaw: 45, pitch: -40, maxDist: 400 },
];
if (canyon) {
  // inside the canyon: along it, at the walls, and down into it from above the rim
  views.length = 0;
  const yawAt = (i: number): number => (Math.atan2(canyon!.tx[i], -canyon!.tz[i]) * 180) / Math.PI;
  for (const s of [600, 2500, 5000, 8000, 10000, 11600]) {
    const i = Math.round(s / 10);
    const x = canyon.x[i] + 0.37;
    const z = canyon.z[i] + 0.71;
    views.push({ x, z, agl: 40, yaw: yawAt(i), pitch: -12, maxDist: 400 });
    views.push({ x, z, agl: 60, yaw: yawAt(i) + 90, pitch: -5, maxDist: 400 });
    views.push({ x, z, agl: canyon.rim[i] - canyon.floor[i] + 150, yaw: yawAt(i) + 20, pitch: -70, maxDist: 400 });
  }
}
const meshResults: unknown[] = [];
const nearErr: number[] = [];
const midErr: number[] = [];
const nearPerp: number[] = [];
renderer.setClearColor(0x000000, 0);
for (const v of views) {
  const gy = Math.max(heightAt(v.x, v.z), 0);
  cam.position.set(v.x, gy + v.agl, v.z);
  cam.rotation.order = 'YXZ';
  cam.rotation.y = -(v.yaw * Math.PI) / 180;
  cam.rotation.x = (v.pitch * Math.PI) / 180;
  cam.updateMatrixWorld();
  terrain.update(cam, 0);
  renderer.setRenderTarget(meshTarget);
  renderer.clear();
  renderer.render(meshScene, cam);
  renderer.readRenderTargetPixels(meshTarget, 0, 0, MW, MH, meshBuf);
  const ox = terrain.object.position.x;
  const oz = terrain.object.position.z;
  const errs: number[] = [];
  const errsNear: number[] = [];
  let covered = 0;
  for (let i = 0; i < MW * MH; i++) {
    if (meshBuf[i * 4 + 3] < 0.5) continue;
    covered++;
    const lx = meshBuf[i * 4];
    const ly = meshBuf[i * 4 + 1];
    const lz = meshBuf[i * 4 + 2];
    const dx = ox + lx - v.x;
    const dz = oz + lz - v.z;
    const dist = Math.hypot(dx, dz);
    if (dist > v.maxDist) continue;
    const wx = ox + lx;
    const wz = oz + lz;
    const hc = heightAt(wx, wz);
    const e = Math.abs(ly - hc);
    errs.push(e);
    if (dist <= 120) {
      errsNear.push(e);
      if (canyon) {
        // perpendicular to the surface: the height error over sqrt(1 + slope^2)
        const d = 0.25;
        const gx = (heightAt(wx + d, wz) - heightAt(wx - d, wz)) / (2 * d);
        const gz = (heightAt(wx, wz + d) - heightAt(wx, wz - d)) / (2 * d);
        nearPerp.push(e / Math.sqrt(1 + gx * gx + gz * gz));
      }
    }
  }
  errs.sort((a, b) => a - b);
  errsNear.sort((a, b) => a - b);
  for (const e of errs) midErr.push(e);
  for (const e of errsNear) nearErr.push(e);
  meshResults.push({
    view: [v.x, v.z, v.agl, v.yaw, v.pitch],
    covered: covered / (MW * MH),
    near: { samples: errsNear.length, median: pct(errsNear, 0.5), p99: pct(errsNear, 0.99), max: errsNear[errsNear.length - 1] },
    mid: { samples: errs.length, median: pct(errs, 0.5), p99: pct(errs, 0.99), max: errs[errs.length - 1] },
  });
}
renderer.setRenderTarget(null);
nearErr.sort((a, b) => a - b);
midErr.sort((a, b) => a - b);
const summary = (a: number[]): Record<string, number> => ({
  samples: a.length,
  median: pct(a, 0.5),
  p99: pct(a, 0.99),
  p999: pct(a, 0.999),
  max: a[a.length - 1],
});
nearPerp.sort((a, b) => a - b);
window.__CHECK_MESH__ = { near: summary(nearErr), mid: summary(midErr), ...(canyon ? { nearPerpendicular: summary(nearPerp) } : {}), views: meshResults };

// ---- 3. no pops across clipmap snaps
const bufA = new Float32Array(MW * MH * 4);
const bufB = new Float32Array(MW * MH * 4);
function renderAt(x: number, agl: number, z: number, yaw: number, pitch: number, out: Float32Array): number[] {
  const gy = Math.max(heightAt(x, z), 0);
  cam.position.set(x, gy + agl, z);
  cam.rotation.order = 'YXZ';
  cam.rotation.y = -(yaw * Math.PI) / 180;
  cam.rotation.x = (pitch * Math.PI) / 180;
  cam.updateMatrixWorld();
  terrain.update(cam, 0);
  renderer.setRenderTarget(meshTarget);
  renderer.clear();
  renderer.render(meshScene, cam);
  renderer.readRenderTargetPixels(meshTarget, 0, 0, MW, MH, out);
  return [terrain.object.position.x, terrain.object.position.z];
}
function errMap(buf: Float32Array, o: number[]): Float32Array {
  const e = new Float32Array(MW * MH).fill(NaN);
  for (let i = 0; i < MW * MH; i++) {
    if (buf[i * 4 + 3] < 0.5) continue;
    e[i] = buf[i * 4 + 1] - heightAt(o[0] + buf[i * 4], o[1] + buf[i * 4 + 2]);
  }
  return e;
}
function popStat(x: number, z: number, agl: number, yaw: number, pitch: number): { max: number; p9999: number; n: number } {
  const eps = 0.002;
  const oa = renderAt(x - eps, agl, z - eps, yaw, pitch, bufA);
  const ea = errMap(bufA, oa);
  const ob = renderAt(x + eps, agl, z + eps, yaw, pitch, bufB);
  const eb = errMap(bufB, ob);
  const d: number[] = [];
  for (let i = 0; i < MW * MH; i++) {
    if (Number.isNaN(ea[i]) || Number.isNaN(eb[i])) continue;
    // only pixels that see the same spot (the camera moved 4 mm, so the spot moved a few mm at most)
    const dx = oa[0] + bufA[i * 4] - (ob[0] + bufB[i * 4]);
    const dz = oa[1] + bufA[i * 4 + 2] - (ob[1] + bufB[i * 4 + 2]);
    if (Math.hypot(dx, dz) > 0.05) continue;
    d.push(Math.abs(ea[i] - eb[i]));
  }
  d.sort((p, q) => p - q);
  return { max: d[d.length - 1], p9999: pct(d, 0.9999), n: d.length };
}
const snapViews: Array<[number, number, number, number, number]> = [
  [5120, -9216, 300, 20, -8],
  [15360, -4096, 150, 100, -12],
  [-2048, 3072, 80, 200, -5],
  [250880, -280576, 200, 60, -10],
];
if (canyon) {
  // the clipmap snap points (multiples of 1024 m: every level re-centres there) nearest to the canyon's centreline
  snapViews.length = 0;
  const found: Array<[number, number, number]> = [];
  for (let i = 0; i < canyon.n; i += 5) {
    const sx = Math.round(canyon.x[i] / 1024) * 1024;
    const sz = Math.round(canyon.z[i] / 1024) * 1024;
    let best = Infinity;
    for (let j = 0; j < canyon.n; j += 2) best = Math.min(best, Math.hypot(canyon.x[j] - sx, canyon.z[j] - sz));
    if (!found.some((f) => f[0] === sx && f[1] === sz)) found.push([sx, sz, best]);
  }
  found.sort((a, b) => a[2] - b[2]);
  for (const [sx, sz] of found.slice(0, 4)) {
    // look at the nearest centreline point, from 150 m above the ground
    let bi = 0;
    for (let j = 0; j < canyon.n; j++) if (Math.hypot(canyon.x[j] - sx, canyon.z[j] - sz) < Math.hypot(canyon.x[bi] - sx, canyon.z[bi] - sz)) bi = j;
    const dx = canyon.x[bi] - sx;
    const dz = canyon.z[bi] - sz;
    const yaw = Math.hypot(dx, dz) > 1 ? (Math.atan2(dx, -dz) * 180) / Math.PI : (Math.atan2(canyon.tx[bi], -canyon.tz[bi]) * 180) / Math.PI;
    snapViews.push([sx, sz, 150, yaw, -20]);
  }
}
const snapResults: unknown[] = [];
let snapWorst = 0;
let controlWorst = 0;
for (const [sx, sz, agl, yaw, pitch] of snapViews) {
  const atSnap = popStat(sx, sz, agl, yaw, pitch);
  const control = popStat(sx + 3.3, sz + 1.7, agl, yaw, pitch);
  snapWorst = Math.max(snapWorst, atSnap.max);
  controlWorst = Math.max(controlWorst, control.max);
  snapResults.push({ at: [sx, sz], atSnap, control });
}
renderer.setRenderTarget(null);
window.__CHECK_SNAP__ = { snapWorst, controlWorst, views: snapResults };

(document.getElementById('out') as HTMLElement).textContent = JSON.stringify({ height: result, mesh: window.__CHECK_MESH__, snap: window.__CHECK_SNAP__ }, null, 1);
window.__READY__ = true;

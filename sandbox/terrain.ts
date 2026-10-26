/**
 * Terrain sandbox: Stage + SkyView + TerrainView with a free-fly camera.
 *
 *   ?x=&y=&z=&yaw=&pitch=   camera preset (metres, degrees; yaw 0 = looking north / -z, 90 = east; pitch + = up)
 *   ?fly=1                  move forward along the view at 250 m/s (speed with ?speed=): to check swimming and popping in motion
 *   ?alt=500                start 500 m above the ground at (x, z) instead of using y
 *   ?agl=30                 hold 30 m above the ground (terrain following) while flying
 *   ?bloom=0 ?dpr=1 ?cull=0 ?freeze=1  render options (freeze: time stands still, for image diffs)
 *   ?debug=1|2|3|4 ?wire=1   clipmap level colours / morph amount / flat green (cracks) / geometry; wireframe
 *   ?hud=0                  hide the corner text (for clean screenshots)
 *   mouse drag = look, W/S/A/D = move, Q/E = down/up, Shift = fast, Ctrl = slow, wheel = base speed, F = toggle the 250 m/s flight
 *
 * The corner shows fps, CPU ms per frame and the GPU ms per frame of the whole pipeline (EXT_disjoint_timer_query_webgl2, median of 60).
 * window.__READY__ is set after the first frames; window.__sandbox has helpers (setView, bench, stats) for scripted runs.
 */
import * as THREE from 'three';
import { Stage } from '../src/render/stage';
import { SkyView } from '../src/render/sky';
import { TerrainView } from '../src/render/terrain';
import { groundAt, heightAt } from '../src/world/terrain';

declare global {
  interface Window {
    __READY__?: boolean;
    __sandbox?: unknown;
  }
}

const q = new URLSearchParams(location.search);
const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(+q.get(k)!) ? +q.get(k)! : d);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
if (q.get('hud') === '0') hud.style.display = 'none';
const stage = new Stage(canvas, { maxPixelRatio: num('dpr', 1.5), bloom: q.get('bloom') !== '0' });
stage.renderer.info.autoReset = false;
const sky = new SkyView();
const terrain = new TerrainView();
terrain.cull = q.get('cull') !== '0';
terrain.debugMode = num('debug', 0);
terrain.wireframe = q.get('wire') === '1';
stage.scene.add(sky.object);
stage.scene.add(terrain.object);

// ---- camera state
const cam = stage.camera;
const view = { x: num('x', 0), y: num('y', 600), z: num('z', 0), yaw: num('yaw', 0), pitch: num('pitch', -8) };
if (q.has('alt')) view.y = groundAt(view.x, view.z) + num('alt', 500);
const flySpeed = num('speed', 250);
let fly = q.get('fly') === '1';
const agl = num('agl', 0);
let baseSpeed = 150;
let benching = false;
const freeze = q.get('freeze') === '1';

function applyView(): void {
  cam.position.set(view.x, view.y, view.z);
  cam.rotation.order = 'YXZ';
  cam.rotation.y = -THREE.MathUtils.degToRad(view.yaw);
  cam.rotation.x = THREE.MathUtils.degToRad(view.pitch);
  cam.rotation.z = 0;
}
applyView();

// ---- input
const keys = new Set<string>();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyF') fly = !fly;
});
addEventListener('keyup', (e) => keys.delete(e.code));
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  view.yaw += e.movementX * 0.15;
  view.pitch = Math.max(-89, Math.min(89, view.pitch - e.movementY * 0.15));
});
canvas.addEventListener('wheel', (e) => {
  baseSpeed = Math.max(5, Math.min(3000, baseSpeed * (e.deltaY < 0 ? 1.25 : 0.8)));
  e.preventDefault();
}, { passive: false });

// ---- GPU timing (EXT_disjoint_timer_query_webgl2 when the browser offers it)
const gl = stage.renderer.getContext() as WebGL2RenderingContext;
const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
let pendingQuery: WebGLQuery | null = null;
const gpuHistory: number[] = [];
let gpuAvg = NaN;

let finishFrames = 0;
let gpuIsApprox = false;

function renderTimed(): void {
  if (!timer) {
    // no timer queries in this browser: every 15th frame, drain the GPU before and after the frame and time the CPU wall clock
    // around it (it includes the submission, so it is an upper bound of the GPU time)
    if (++finishFrames % 15 === 0) {
      gl.finish();
      const a = performance.now();
      stage.render();
      gl.finish();
      gpuHistory.push(performance.now() - a);
      if (gpuHistory.length > 30) gpuHistory.shift();
      gpuAvg = [...gpuHistory].sort((x, y) => x - y)[gpuHistory.length >> 1];
      gpuIsApprox = true;
    } else {
      stage.render();
    }
    return;
  }
  if (timer && !pendingQuery) {
    const query = gl.createQuery()!;
    gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
    stage.render();
    gl.endQuery(timer.TIME_ELAPSED_EXT);
    pendingQuery = query;
  } else {
    stage.render();
  }
  if (timer && pendingQuery && gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT_AVAILABLE)) {
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
    if (!disjoint) {
      gpuHistory.push((gl.getQueryParameter(pendingQuery, gl.QUERY_RESULT) as number) / 1e6);
      if (gpuHistory.length > 60) gpuHistory.shift();
      gpuAvg = [...gpuHistory].sort((a, b) => a - b)[gpuHistory.length >> 1];
    }
    gl.deleteQuery(pendingQuery);
    pendingQuery = null;
  }
}

// ---- main loop
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
let last = performance.now();
let firstFrameMs = NaN;
let frames = 0;
let fps = 0;
let cpuMs = 0;
let fpsT = last;
let fpsN = 0;
const t0 = last;

const frameMs: number[] = [];

function frame(now: number): void {
  frameMs.push(now - last);
  if (frameMs.length > 2000) frameMs.shift();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t = freeze ? 0 : (now - t0) / 1000;

  // movement
  cam.getWorldDirection(fwd);
  right.crossVectors(fwd, cam.up).normalize();
  const sp = baseSpeed * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 8 : 1) * (keys.has('ControlLeft') ? 0.1 : 1);
  if (fly) {
    view.x += fwd.x * flySpeed * dt;
    view.y += fwd.y * flySpeed * dt;
    view.z += fwd.z * flySpeed * dt;
  }
  const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const r = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const u = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
  view.x += (fwd.x * f + right.x * r) * sp * dt;
  view.y += (fwd.y * f + right.y * r + u) * sp * dt;
  view.z += (fwd.z * f + right.z * r) * sp * dt;
  if (agl > 0) view.y = groundAt(view.x, view.z) + agl;
  applyView();

  stage.renderer.info.reset();
  const c0 = performance.now();
  if (!benching) {
    sky.update(cam, t);
    terrain.update(cam, t);
    renderTimed();
  }
  const c1 = performance.now();
  if (!Number.isFinite(firstFrameMs)) firstFrameMs = c1 - c0;
  cpuMs = cpuMs * 0.95 + (c1 - c0) * 0.05;

  frames++;
  fpsN++;
  if (now - fpsT > 500) {
    fps = (fpsN * 1000) / (now - fpsT);
    fpsT = now;
    fpsN = 0;
  }
  const info = stage.renderer.info.render;
  const g = groundAt(view.x, view.z);
  hud.textContent =
    `fps ${fps.toFixed(0)}   cpu ${cpuMs.toFixed(2)} ms   gpu ${Number.isFinite(gpuAvg) ? gpuAvg.toFixed(2) + (gpuIsApprox ? ' ms (approx)' : ' ms (median)') : 'n/a'}\n` +
    `draws ${info.calls}   tris ${(info.triangles / 1000).toFixed(0)}k\n` +
    `x ${view.x.toFixed(0)}  y ${view.y.toFixed(0)}  z ${view.z.toFixed(0)}   yaw ${view.yaw.toFixed(1)}  pitch ${view.pitch.toFixed(1)}\n` +
    `ground ${g.toFixed(0)} m   agl ${(view.y - g).toFixed(0)} m   ${fly ? 'FLY ' + flySpeed + ' m/s' : 'hold'}   speed ${baseSpeed.toFixed(0)}`;

  if (frames === 6) window.__READY__ = true;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- scripted helpers
function setView(x: number, y: number, z: number, yaw: number, pitch: number): void {
  Object.assign(view, { x, y, z, yaw, pitch });
  applyView();
}

const nextFrame = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));

/** GPU time per frame (ms, median over n frames) of one render function, from timer queries (they resolve a frame or two later). */
async function gpuTime(n: number, render: () => void): Promise<number> {
  const times: number[] = [];
  const pending: WebGLQuery[] = [];
  const collect = (): void => {
    while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
      const query = pending.shift()!;
      if (!gl.getParameter(timer!.GPU_DISJOINT_EXT)) times.push((gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6);
      gl.deleteQuery(query);
    }
  };
  for (let i = 0; i < n + 6; i++) {
    await nextFrame();
    const query = gl.createQuery()!;
    gl.beginQuery(timer!.TIME_ELAPSED_EXT, query);
    render();
    gl.endQuery(timer!.TIME_ELAPSED_EXT);
    pending.push(query);
    collect();
  }
  for (let i = 0; i < 20 && pending.length; i++) {
    await nextFrame();
    collect();
  }
  times.splice(0, 4);
  times.sort((a, b) => a - b);
  return times.length ? times[Math.floor(times.length / 2)] : NaN;
}

/** Median GPU ms per frame for the full pipeline and its parts (needs EXT_disjoint_timer_query_webgl2). */
async function bench(n = 90): Promise<Record<string, number>> {
  if (!timer) return { error: -1 };
  benching = true;
  const out: Record<string, number> = {};
  const saved = { fly, pitch: view.pitch };
  fly = false;
  const draw = (): void => {
    sky.update(cam, 0);
    terrain.update(cam, 0);
  };
  const direct = (): void => {
    draw();
    stage.renderer.render(stage.scene, cam);
  };
  view.pitch = saved.pitch;
  applyView();
  out.fullPipeline = await gpuTime(n, () => {
    draw();
    stage.render();
  });
  out.sceneDirect = await gpuTime(n, direct);
  terrain.object.visible = false;
  out.skyOnly = await gpuTime(n, direct);
  sky.object.visible = false;
  out.empty = await gpuTime(n, direct);
  terrain.object.visible = true;
  out.terrainOnly = await gpuTime(n, direct);
  // looking straight up: every vertex is still shaded but no terrain pixel is drawn, so this is the vertex stage alone
  view.pitch = 85;
  applyView();
  out.terrainVertexOnly = await gpuTime(n, direct);
  sky.object.visible = true;
  view.pitch = saved.pitch;
  fly = saved.fly;
  applyView();
  benching = false;
  return out;
}

/** Frame-time statistics of the last n frames (ms between requestAnimationFrame callbacks). */
function stats(n = 600): Record<string, number> {
  const a = frameMs.slice(-n).slice(1);
  const sorted = [...a].sort((x, y) => x - y);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    frames: a.length,
    fps: (1000 * a.length) / a.reduce((x, y) => x + y, 0),
    p50: at(0.5),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    over10ms: a.filter((v) => v > 10).length,
    over20ms: a.filter((v) => v > 20).length,
  };
}

window.__sandbox = { setView, bench, stats, firstFrame: () => firstFrameMs, view, stage, terrain, sky, heightAt, groundAt };

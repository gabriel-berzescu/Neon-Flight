#!/usr/bin/env node
/**
 * Scripted flight in headless Chrome (GPU) with a fake F310, for QA: screenshots and state at given times.
 *
 *   node scripts/fly.mjs [path] --plan "<steps>" [--port 5240] [--out shots/fly] [--w 1600] [--h 900] [--log]
 *                        [--gpu high|default] [--uncapped]
 *
 * --gpu default leaves the GPU choice to Windows (what a plain browser tab gets: on this laptop the Intel one); --uncapped turns
 * vsync and the frame-rate limit off, so the fps line measures what the machine can do.
 *
 * path defaults to index.html. Steps are `time:action` separated by `;` (time in seconds after the game is ready), actions
 * separated by `,`:
 *   ly=0.6  ry=-0.6        left / right stick Y (+1 = pulled back)
 *   lt=0.8  rt=1           left / right trigger
 *   start=1 / start=0      the Start button
 *   shot=name              screenshot to <out>/<name>.png
 *   state                  print the flight state (speed, altitude, g, attitude, crashed)
 *   perf                   time every frame for 5 s: fps, frame-time percentiles, and how fast game time runs vs real time
 *   eval=<js>              evaluate in the page and print the result (no commas inside: use a separate step)
 * Example: --plan "0:lt=0.8,rt=0.8;1:shot=start;2:ly=0.5,ry=0.5;3:state,shot=pull;3.2:ly=0,ry=0"
 *
 * Uses launchChrome (seeded profile): never a fresh-profile Chrome on this laptop (see scripts/chrome.mjs).
 */
import { launchChrome } from './chrome.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const valued = new Set(['plan', 'port', 'out', 'w', 'h', 'gpu', 'dpr']);
const opts = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (valued.has(k)) opts[k] = argv[++i];
    else opts[k] = true;
  } else pos.push(a);
}
const port = opts.port ?? '5240';
let target = pos[0] ?? 'index.html';
if (!/^https?:/.test(target)) target = `http://127.0.0.1:${port}/${target.replace(/^\//, '')}`;
const outDir = resolve(opts.out ?? 'shots/fly');
mkdirSync(outDir, { recursive: true });

const steps = String(opts.plan ?? '0:state,shot=start')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf(':');
    return { t: +s.slice(0, i), actions: s.slice(i + 1).split(',').map((a) => a.trim()).filter(Boolean) };
  })
  .sort((a, b) => a.t - b.t);

const browser = await launchChrome({
  channel: 'chrome',
  headless: true,
  args: [
    '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    ...(opts.gpu === 'default' ? [] : ['--force_high_performance_gpu']),
    ...(opts.uncapped ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  ],
});
const page = await browser.newPage({ viewport: { width: +(opts.w ?? 1600), height: +(opts.h ?? 900) }, deviceScaleFactor: +(opts.dpr ?? 1) });
await page.addInitScript({ content: readFileSync(join(ROOT, 'scripts', 'fixtures', 'fake-pad.js'), 'utf8') });
let threw = false;
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning' || opts.log) console.log(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => {
  threw = true;
  console.log(`[pageerror] ${e.message}\n${e.stack ?? ''}`);
});
await page.goto(target, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 90000, polling: 100 });
const t0 = Date.now();
const state = () =>
  page.evaluate(() => {
    const s = window.__nf.flight.state;
    const r = (v, d = 1) => +v.toFixed(d);
    return {
      t: r(s.time, 2), kmh: Math.round(s.airspeed * 3.6), alt: Math.round(s.altitude), agl: Math.round(s.agl), g: r(s.g, 2),
      pitch: r(s.pitchDeg), roll: r(s.rollDeg), hdg: r(s.headingDeg), aoa: r(s.alphaDeg), n2: s.n2.map((v) => Math.round(v)),
      elevons: s.elevons.map((v) => r(v, 2)), crashed: s.crashed, pos: [Math.round(s.position.x), Math.round(s.position.z)],
    };
  });
const pad = { ly: [1, 'axis'], ry: [3, 'axis'], lt: [6, 'btn'], rt: [7, 'btn'], start: [9, 'btn'] };
for (const step of steps) {
  const wait = t0 + step.t * 1000 - Date.now();
  if (wait > 0) await page.waitForTimeout(wait);
  for (const a of step.actions) {
    const [k, v] = a.split('=');
    if (k in pad) {
      const [i, kind] = pad[k];
      await page.evaluate(([i, kind, v]) => (kind === 'axis' ? window.__pad.axis(i, v) : window.__pad.btn(i, v)), [i, kind, +v]);
    } else if (k === 'shot') {
      const file = join(outDir, `${v}.png`);
      await page.screenshot({ path: file });
      console.log(`[shot ${step.t}s] ${file}`);
    } else if (k === 'perf') {
      const r = await page.evaluate(
        () =>
          new Promise((res) => {
            const f = window.__nf.flight;
            const d = [];
            const t0 = performance.now();
            const g0 = f.state.time;
            let last = t0;
            const tick = (now) => {
              d.push(now - last);
              last = now;
              if (now - t0 < 5000) requestAnimationFrame(tick);
              else {
                d.sort((a, b) => a - b);
                const q = (p) => +d[Math.min(d.length - 1, Math.floor(p * d.length))].toFixed(1);
                res({ fps: Math.round((d.length * 1000) / (now - t0)), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +d[d.length - 1].toFixed(1), over50ms: d.filter((x) => x > 50).length, gameSpeed: +((f.state.time - g0) / ((now - t0) / 1000)).toFixed(2), canvas: [window.__nf.stage.renderer.domElement.width, window.__nf.stage.renderer.domElement.height] });
              }
            };
            requestAnimationFrame(tick);
          }),
      );
      console.log(`[perf ${step.t}s]`, JSON.stringify(r));
    } else if (k === 'state') {
      console.log(`[state ${step.t}s]`, JSON.stringify(await state()));
    } else if (k === 'eval') {
      console.log(`[eval ${step.t}s]`, JSON.stringify(await page.evaluate(a.slice(5))));
    } else console.log(`[plan] unknown action ${a}`);
  }
}
const fps = await page.evaluate(
  () =>
    new Promise((res) => {
      let n = 0;
      const t = performance.now();
      const f = () => (++n < 60 ? requestAnimationFrame(f) : res(Math.round((60 * 1000) / (performance.now() - t))));
      requestAnimationFrame(f);
    }),
);
const gl = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2');
  const d = c && c.getExtension('WEBGL_debug_renderer_info');
  return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`[fly] done, ~${fps} fps (headless${opts.uncapped ? ', uncapped' : ', vsync-capped'}), GPU: ${gl}`);
await browser.close();
process.exit(threw ? 1 : 0);

// Proof that the WebAssembly JSBSim flies: loads a stock aircraft from JSBSim's own tree and flies it for 20 s.
//   node sandbox/proof-stock.mjs [aircraft]     (default f16; needs .cache/jsbsim-src, fetched by scripts/build-jsbsim.mjs)
import createJSBSim from '../src/fdm/wasm/jsbsim.mjs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = new URL('../.cache/jsbsim-src/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const name = process.argv[2] ?? 'f16';
const M = await createJSBSim();
const copy = (from, to) => {
  for (const f of readdirSync(from)) {
    const p = join(from, f);
    const t = `${to}/${f}`;
    if (statSync(p).isDirectory()) { M.FS.mkdirTree(t); copy(p, t); }
    else M.FS.writeFile(t, readFileSync(p));
  }
};
for (const d of ['engine', 'systems']) { M.FS.mkdirTree(`/jsbsim/${d}`); copy(join(SRC, d), `/jsbsim/${d}`); }
M.FS.mkdirTree(`/jsbsim/aircraft/${name}`); copy(join(SRC, 'aircraft', name), `/jsbsim/aircraft/${name}`);

console.log('JSBSim', M.version());
const sim = new M.Sim();
const t0 = performance.now();
if (!sim.loadModel(name)) throw new Error('load failed: ' + sim.lastError());
console.log(`loaded ${name} in ${(performance.now() - t0).toFixed(0)} ms`);
sim.setDt(1 / 120);
sim.set('ic/h-sl-ft', 5000);
sim.set('ic/vc-kts', 300);
sim.set('ic/psi-true-deg', 0);
sim.set('ic/gamma-deg', 0);
if (!sim.runIC()) throw new Error('runIC failed: ' + sim.lastError());
sim.set('propulsion/set-running', -1);
sim.set('fcs/throttle-cmd-norm', 0.8);
const show = (t) => console.log(`t=${t.toFixed(1).padStart(5)} s  alt ${sim.get('position/h-sl-ft').toFixed(0).padStart(6)} ft  KCAS ${sim.get('velocities/vc-kts').toFixed(1).padStart(6)}  pitch ${sim.get('attitude/theta-deg').toFixed(1).padStart(6)}°  roll ${sim.get('attitude/phi-deg').toFixed(1).padStart(6)}°  thrust ${sim.get('propulsion/engine[0]/thrust-lbs').toFixed(0).padStart(6)} lbf`);
const t1 = performance.now();
let steps = 0;
for (let s = 0; s <= 20; s += 2) {
  show(sim.simTime());
  if (s === 10) sim.set('fcs/aileron-cmd-norm', 0.3);
  steps += sim.steps(240);
}
const ms = performance.now() - t1;
console.log(`${steps} steps in ${ms.toFixed(0)} ms = ${(ms * 1000 / steps).toFixed(1)} µs/step (${(steps / 120 / (ms / 1000)).toFixed(0)}x real time at 120 Hz)`);

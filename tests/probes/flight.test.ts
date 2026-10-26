// Flight-model probe: prints how the Neon Wing flies (trim, top speed, pulls, rolls, one engine). Run with
//   PROBE=1 npx vitest run tests/probes/flight.test.ts --disableConsoleIntercept
// GAINS='{"fcs/gain/pitch-kp":0.04}' overrides fly-by-wire properties for tuning.
import { describe, it } from 'vitest';
import { createSim, type JSBSimSim } from '../../src/fdm/jsbsim';

const on = !!process.env.PROBE;
const KT = 0.514444, FT = 0.3048;
const gains: Record<string, number> = process.env.GAINS ? JSON.parse(process.env.GAINS) : {};

async function start(opts: { kts?: number; altFt?: number; thr?: number; theta?: number } = {}): Promise<JSBSimSim> {
  const sim = await createSim();
  sim.setDt(1 / 120);
  sim.setTerrain(() => 0);
  sim.set('ic/h-sl-ft', opts.altFt ?? 3000);
  sim.set('ic/vt-kts', opts.kts ?? 250);
  sim.set('ic/gamma-deg', opts.theta ?? 0);
  sim.set('ic/alpha-deg', 1.5);
  sim.set('ic/psi-true-deg', 0);
  if (!sim.runIC()) throw new Error(sim.lastError());
  for (const [k, v] of Object.entries(gains)) sim.set(k, v);
  sim.set('propulsion/set-running', -1);
  sim.set('fcs/throttle-cmd-norm[0]', opts.thr ?? 0.5);
  sim.set('fcs/throttle-cmd-norm[1]', opts.thr ?? 0.5);
  return sim;
}
const sticks = (sim: JSBSimSim, l: number, r: number) => {
  sim.set('fcs/stick-left-cmd', l);
  sim.set('fcs/stick-right-cmd', r);
};
const row = (sim: JSBSimSim, label = '') =>
  `${label.padEnd(10)} t ${sim.simTime().toFixed(2).padStart(5)}  alt ${(sim.get('position/h-sl-ft') * FT).toFixed(0).padStart(5)} m  TAS ${(sim.get('velocities/vtrue-kts') * KT).toFixed(0).padStart(4)} m/s  M ${sim.get('velocities/mach').toFixed(2)}  ` +
  `pitch ${sim.get('attitude/theta-deg').toFixed(1).padStart(6)}  roll ${sim.get('attitude/phi-deg').toFixed(1).padStart(7)}  hdg ${sim.get('attitude/psi-deg').toFixed(1).padStart(6)}  ` +
  `gamma ${sim.get('flight-path/gamma-deg').toFixed(1).padStart(6)}  AoA ${sim.get('aero/alpha-deg').toFixed(1).padStart(5)}  beta ${sim.get('aero/beta-deg').toFixed(2).padStart(6)}  ` +
  `nz ${sim.get('accelerations/Nz').toFixed(2).padStart(5)}/${sim.get('fcs/nz-cmd').toFixed(2).padStart(5)}  p ${(sim.get('velocities/p-rad_sec') * 57.3).toFixed(0).padStart(4)}°/s  ` +
  `el ${sim.get('fcs/elevon-left-pos-norm').toFixed(2).padStart(5)}/${sim.get('fcs/elevon-right-pos-norm').toFixed(2).padStart(5)}  N2 ${sim.get('propulsion/engine[0]/n2').toFixed(0)}/${sim.get('propulsion/engine[1]/n2').toFixed(0)}`;
const fly = (sim: JSBSimSim, label: string, rows: number, stepsPerRow: number) => {
  for (let i = 0; i <= rows; i++) {
    console.log(row(sim, label));
    if (i < rows) sim.steps(stepsPerRow);
  }
};

describe.skipIf(!on)('flight probe', () => {
  it('hands off at half throttle, 130 m/s', async () => fly(await start({ thr: 0.5 }), 'handsoff', 6, 600));
  it('hands off at 230 m/s', async () => fly(await start({ thr: 0.7, kts: 450 }), 'fast', 4, 600));
  it('full throttle hands off: top speed', async () => fly(await start({ thr: 1, kts: 400 }), 'full', 6, 2400));
  it('idle hands off: glide', async () => fly(await start({ thr: 0, kts: 250 }), 'glide', 6, 1200));
  it('pitch step: half stick at 150 m/s', async () => {
    const sim = await start({ kts: 290, thr: 0.7 });
    sim.steps(120);
    sticks(sim, 0.5, 0.5);
    fly(sim, 'step', 12, 12);
  });
  it('full pull at 250 m/s', async () => {
    const sim = await start({ kts: 486, thr: 1 });
    sticks(sim, 1, 1);
    fly(sim, 'pull', 10, 24);
  });
  it('full pull at 90 m/s', async () => {
    const sim = await start({ kts: 175, thr: 1 });
    sticks(sim, 1, 1);
    fly(sim, 'pullslow', 8, 60);
  });
  it('full roll left at 150 m/s, then release', async () => {
    const sim = await start({ kts: 290, thr: 0.6 });
    sim.steps(60);
    sticks(sim, 1, -1);
    fly(sim, 'roll', 5, 24);
    sticks(sim, 0, 0);
    fly(sim, 'release', 6, 60);
  });
  it('roll 45 left at 150 m/s and hold: level turn?', async () => {
    const sim = await start({ kts: 290, thr: 0.8 });
    sim.steps(60);
    sticks(sim, 0.5, -0.5);
    while (sim.get('attitude/phi-deg') > -45) sim.steps(1);
    sticks(sim, 0, 0);
    fly(sim, 'turn45', 6, 240);
  });
  it('right engine only at 150 m/s', async () => {
    const sim = await start({ kts: 290, thr: 0.0 });
    sim.set('fcs/throttle-cmd-norm[1]', 1);
    fly(sim, 'right-eng', 8, 240);
  });
  it('limiter off: full pull at 90 m/s', async () => {
    const sim = await start({ kts: 175, thr: 1 });
    sim.set('fcs/aoa-limiter-enable', 0);
    sticks(sim, 1, 1);
    fly(sim, 'stall', 8, 60);
  });
});

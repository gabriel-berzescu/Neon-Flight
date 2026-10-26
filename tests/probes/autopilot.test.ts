// PROBE=1 npx vitest run tests/probes/autopilot.test.ts --disableConsoleIntercept
import { describe, it } from 'vitest';
import { createSim } from '../../src/fdm/jsbsim';
import { Flight } from '../../src/flight/flight';
import { autopilot } from '../../src/game/autopilot';
describe.skipIf(!process.env.PROBE)('autopilot', () => {
  it('turns toward a gate to the north-east', async () => {
    const f = new Flight(await createSim(), () => 0);
    f.spawn({ x: 0, z: 0, agl: 300, heading: 0, speed: 175 });
    const gate = { index: 0, s: 0, x: 600, y: 300, z: -1000, tx: 0, tz: -1, width: 40, height: 30 };
    for (let i = 0; i <= 60; i++) {
      const s = f.state;
      const o = autopilot(s, gate);
      if (i % 6 === 0) console.log(`t ${s.time.toFixed(1)} pos (${s.position.x.toFixed(0)}, ${s.position.z.toFixed(0)}) hdg ${s.headingDeg.toFixed(0)} roll ${s.rollDeg.toFixed(0)} sticks ${o.stickLeft.toFixed(2)}/${o.stickRight.toFixed(2)}`);
      for (let k = 0; k < 6; k++) f.update(1 / 60, autopilot(f.state, gate));
    }
  });
});

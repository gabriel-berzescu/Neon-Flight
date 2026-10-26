// Prints the JSBSim property catalog (filtered by CAT=regex). PROBE=1 CAT=gear npx vitest run tests/probes/catalog.test.ts --disableConsoleIntercept
import { describe, it } from 'vitest';
import { createSim } from '../../src/fdm/jsbsim';
describe.skipIf(!process.env.PROBE)('catalog', () => {
  it('prints', async () => {
    const sim = await createSim();
    const re = new RegExp(process.env.CAT ?? '.');
    console.log(sim.propertyCatalog().split('\n').filter((l) => re.test(l)).join('\n'));
  });
});

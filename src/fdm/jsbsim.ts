/**
 * Loading JSBSim (WebAssembly) and giving it our aircraft.
 *
 * The aircraft and engine definitions are plain XML files in src/fdm/aircraft/, imported as text and written into the module's
 * in-memory file system under /jsbsim (aircraft/, engine/, systems/), where `Sim.loadModel` reads them. So tuning the aircraft
 * never needs a rebuild of the WebAssembly, and Vite hot-reloads it like any other source.
 */
import createJSBSim, { type JSBSimModule, type JSBSimSim } from './wasm/jsbsim.mjs';
import neonwingXml from './aircraft/neonwing/neonwing.xml?raw';
import neonjetXml from './aircraft/engine/neonjet.xml?raw';
import directXml from './aircraft/engine/direct.xml?raw';

export type { JSBSimModule, JSBSimSim };

/** Every file the module needs, by path under /jsbsim. */
export const AIRCRAFT_FILES: Readonly<Record<string, string>> = {
  'aircraft/neonwing/neonwing.xml': neonwingXml,
  'engine/neonjet.xml': neonjetXml,
  // (JSBSim's stock thruster for jets: the engine computes the thrust itself)
  'engine/direct.xml': directXml,
};

export const AIRCRAFT_MODEL = 'neonwing';

let loading: Promise<JSBSimModule> | null = null;

/** The module, loaded once, with the aircraft files in place. */
export function loadJSBSim(): Promise<JSBSimModule> {
  loading ??= createJSBSim({
    // JSBSim prints a banner and the odd notice on stdout; keep the console clean, keep its errors.
    print: () => {},
    printErr: (s: string) => console.warn('[JSBSim]', s),
  }).then((M) => {
    M.FS.mkdirTree('/jsbsim/systems');
    for (const [path, text] of Object.entries(AIRCRAFT_FILES)) {
      M.FS.mkdirTree(`/jsbsim/${path.slice(0, path.lastIndexOf('/'))}`);
      M.FS.writeFile(`/jsbsim/${path}`, text);
    }
    return M;
  });
  return loading;
}

/** A new simulation with the aircraft loaded. Throws with JSBSim's message if the model does not load. */
export async function createSim(model = AIRCRAFT_MODEL): Promise<JSBSimSim> {
  const M = await loadJSBSim();
  const sim = new M.Sim();
  if (!sim.loadModel(model)) {
    const err = sim.lastError();
    sim.delete();
    throw new Error(`JSBSim could not load ${model}${err ? `: ${err}` : ''}`);
  }
  return sim;
}

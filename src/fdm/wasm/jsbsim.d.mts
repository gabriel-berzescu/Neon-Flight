// Types of the Emscripten module built by scripts/build-jsbsim.mjs from native/jsbsim-bridge.cpp.

export interface JSBSimSim {
  /** Load /jsbsim/aircraft/<name>/<name>.xml. False (and `lastError()`) on failure. */
  loadModel(name: string): boolean;
  setDt(dt: number): void;
  getDt(): number;
  simTime(): number;
  runIC(): boolean;
  run(): boolean;
  /** Run `n` steps; returns how many ran. */
  steps(n: number): number;
  get(name: string): number;
  set(name: string, value: number): void;
  has(name: string): boolean;
  /** A numeric handle for a property (created if missing); -1 on failure. */
  handle(name: string): number;
  getH(handle: number): number;
  setH(handle: number, value: number): void;
  /** fn(latitudeRad, longitudeRad) -> terrain height above the ellipsoid in metres. */
  setTerrain(fn: ((latRad: number, lonRad: number) => number) | null): void;
  propertyCatalog(): string;
  lastError(): string;
  /** Frees the C++ object. */
  delete(): void;
}

export interface JSBSimFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string, opts: { encoding: 'utf8' }): string;
  analyzePath(path: string): { exists: boolean };
}

export interface JSBSimModule {
  Sim: new () => JSBSimSim;
  FS: JSBSimFS;
  version(): string;
}

declare function createJSBSim(moduleArg?: Record<string, unknown>): Promise<JSBSimModule>;
export default createJSBSim;

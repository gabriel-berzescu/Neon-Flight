/**
 * Canyon runs: a slot canyon generated from a seed, carved into a mesa somewhere in the endless world, with gates to fly through.
 *
 * `generateCanyon(seed, base)` lays out one canyon: a centreline sampled every CANYON_STEP metres (position, tangent, floor and rim
 * heights, half-width of the floor, the walls' horizontal run), the gates along it, the spawn at its mouth and a par time.
 * It only reads the base terrain (`base`, the terrain without any canyon), so it never depends on another canyon being carved.
 *
 * The shape it describes (what src/world/canyon-field.ts carves, on the CPU for the physics and on the GPU for the picture):
 *   - the MESA: within `band` metres of the centreline the terrain is raised to at least the rim height, easing back down to the
 *     plain terrain over the next `fade` metres, so the canyon always has walls, whatever the land was;
 *   - the CANYON: at distance d from the centreline, the surface is the floor where d <= half, rises over `wall` metres to the
 *     rim, and above it the (raised) terrain takes over: the canyon cuts through anything higher, mountains included;
 *   - its ENDS: at the mouth (s = 0) the floor meets a wall behind the spawn; over the last EXIT_RUN metres the floor ramps up to
 *     the rim, so the canyon opens onto the mesa where the run ends.
 * Axes: src/world/coords.ts (x east, z south, heading 0 = north = -z, 90 = east).
 */

/** Metres between centreline samples. */
export const CANYON_STEP = 10;
/** Length of the canyon (m). */
export const CANYON_LENGTH = 12000;
/** The floor ramps up to the rim over the last EXIT_RUN metres. */
export const EXIT_RUN = 700;

export interface Gate {
  index: number;
  /** Distance along the centreline (m). */
  s: number;
  /** Centre of the opening (world). */
  x: number;
  y: number;
  z: number;
  /** Unit tangent of the canyon here (horizontal): the direction a pilot flies through. */
  tx: number;
  tz: number;
  /** Opening size (m). */
  width: number;
  height: number;
}

export interface Canyon {
  seed: number;
  /** Number of centreline samples (index i is at s = i * CANYON_STEP). */
  n: number;
  x: Float64Array;
  z: Float64Array;
  /** Unit tangent (horizontal). The right-hand side is (-tz, tx). */
  tx: Float64Array;
  tz: Float64Array;
  /** Half-width of the floor (m). */
  half: Float64Array;
  /** Floor and rim heights (m above sea level). */
  floor: Float64Array;
  rim: Float64Array;
  /** Horizontal run of a wall, from the floor's edge to the rim (m). */
  wall: Float64Array;
  /** The mesa: raised to the rim within `band` m of the centreline, back to the terrain over the next `fade` m. */
  band: number;
  fade: number;
  length: number;
  /** World bounds of everything the canyon changes (mesa and fade included). */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  gates: Gate[];
  /** Where a run starts: in the canyon, above the floor, flying along it. */
  start: { x: number; y: number; z: number; heading: number };
  /** Seconds to the last gate at a brisk pace: the time bonus counts down from here. */
  parTime: number;
}

/** A small, fast, seeded random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth01 = (t: number) => {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
};

/** Low-pass a series forwards and backwards (exponential, zero phase). */
function lowPass(v: Float64Array, k: number): void {
  for (let i = 1; i < v.length; i++) v[i] = v[i - 1] + (v[i] - v[i - 1]) * k;
  for (let i = v.length - 2; i >= 0; i--) v[i] = v[i + 1] + (v[i] - v[i + 1]) * k;
}

export interface CanyonOptions {
  /** Where the canyon's mouth is; by default a place 30-120 km from the origin chosen by the seed. */
  at?: { x: number; z: number };
  /** Heading of the mouth (degrees); by default chosen by the seed. */
  heading?: number;
}

/**
 * Lays out the canyon for `seed` over the base terrain `base(x, z)` (metres; the terrain WITHOUT any canyon carved in).
 * Deterministic: the same seed and terrain give the same canyon.
 */
export function generateCanyon(seed: number, base: (x: number, z: number) => number, opts: CanyonOptions = {}): Canyon {
  const r = rng(seed);
  const n = Math.floor(CANYON_LENGTH / CANYON_STEP) + 1;
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  const half = new Float64Array(n);
  const floor = new Float64Array(n);
  const rim = new Float64Array(n);
  const wall = new Float64Array(n);

  // where and which way
  const ang = r() * Math.PI * 2;
  const dist = 30000 + r() * 90000;
  const x0 = opts.at?.x ?? Math.sin(ang) * dist;
  const z0 = opts.at?.z ?? -Math.cos(ang) * dist;
  let heading = ((opts.heading ?? r() * 360) * Math.PI) / 180;

  // curvature: three slow waves, together never tighter than an 1800 m radius (about a 2 g turn at 175 m/s, easier at the
  // run's 150: every bend can be followed; 900 m made the canyon a fight); straight for the first 500 m
  const KMAX = 1 / 1800;
  const waves = [0, 1, 2].map(() => ({ len: 1400 + r() * 2600, phase: r() * Math.PI * 2, w: 0.5 + r() }));
  const wsum = waves.reduce((a, w) => a + w.w, 0);
  // widths and depths: slow waves too; the canyon narrows as the run goes on
  const wHalf = { len: 900 + r() * 1200, phase: r() * Math.PI * 2 };
  const wDepth = { len: 2000 + r() * 2000, phase: r() * Math.PI * 2 };
  const wWall = { len: 700 + r() * 900, phase: r() * Math.PI * 2 };
  const depth = new Float64Array(n);

  let px = x0;
  let pz = z0;
  for (let i = 0; i < n; i++) {
    const s = i * CANYON_STEP;
    let k = 0;
    for (const w of waves) k += (w.w / wsum) * Math.sin((2 * Math.PI * s) / w.len + w.phase);
    k *= KMAX * smooth01((s - 300) / 600);
    if (i > 0) heading += k * CANYON_STEP;
    const dx = Math.sin(heading);
    const dz = -Math.cos(heading);
    if (i > 0) {
      px += dx * CANYON_STEP;
      pz += dz * CANYON_STEP;
    }
    x[i] = px;
    z[i] = pz;
    tx[i] = dx;
    tz[i] = dz;
    const progress = s / CANYON_LENGTH;
    const wide = 0.5 + 0.5 * Math.sin((2 * Math.PI * s) / wHalf.len + wHalf.phase);
    half[i] = 55 + (55 - 25 * progress) * wide; // 55-110 m early, 55-85 m late
    depth[i] = 200 + 45 * Math.sin((2 * Math.PI * s) / wDepth.len + wDepth.phase);
    wall[i] = 40 + 18 * (0.5 + 0.5 * Math.sin((2 * Math.PI * s) / wWall.len + wWall.phase));
  }

  // the mesa's height: above the highest land across each section (the canyon's walls then always stand), smoothed along the
  // canyon so the floor never tilts more than a few percent; the floor stays well above the sea
  const band = 900;
  const fade = 1400;
  const rawRim = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let hi = -Infinity;
    for (let j = -4; j <= 4; j++) {
      const off = (j / 4) * (half[i] + wall[i] + 120);
      hi = Math.max(hi, base(x[i] - tz[i] * off, z[i] + tx[i] * off));
    }
    rawRim[i] = Math.max(hi + 25, 60 + depth[i]);
  }
  // The floor: the highest line below (raw rim - depth) that never tilts more than MAX_GRADE, so a mountain in the way is cut
  // through (its slopes become the canyon's walls, hundreds of metres tall) instead of being climbed. The rim, the mesa's height,
  // is the floor plus the depth; land higher than that just stands taller above the walls.
  const MAX_GRADE = 0.03;
  const rise = MAX_GRADE * CANYON_STEP;
  for (let i = 0; i < n; i++) floor[i] = rawRim[i] - depth[i];
  for (let i = 1; i < n; i++) floor[i] = Math.min(floor[i], floor[i - 1] + rise);
  for (let i = n - 2; i >= 0; i--) floor[i] = Math.min(floor[i], floor[i + 1] + rise);
  lowPass(floor, 0.15);
  for (let i = 0; i < n; i++) {
    rim[i] = floor[i] + depth[i];
    // the exit: the floor ramps up to the rim over the last EXIT_RUN metres
    const t = smooth01((i * CANYON_STEP - (CANYON_LENGTH - EXIT_RUN)) / EXIT_RUN);
    floor[i] += (rim[i] - floor[i]) * t;
  }

  // gates: every 500-650 m from 800 m in, until the exit; offsets and sizes harder as the run goes on
  const gates: Gate[] = [];
  const lastS = CANYON_LENGTH - EXIT_RUN - 300;
  for (let s = 800 + r() * 150; s <= lastS; s += 500 + r() * 150) {
    const i = Math.round(s / CANYON_STEP);
    const progress = s / lastS;
    const width = 56 - 14 * progress;
    const height = 40 - 10 * progress;
    const reach = 0.25 + 0.75 * progress;
    const lateralRoom = Math.max(0, half[i] - width / 2 - 8);
    const lateral = (r() * 2 - 1) * Math.min(lateralRoom, 40) * reach;
    const d = rim[i] - floor[i];
    const lift = 22 + r() * Math.max(0, (d - height - 70) * reach);
    gates.push({
      index: gates.length,
      s,
      x: x[i] - tz[i] * lateral,
      y: floor[i] + lift + height / 2,
      z: z[i] + tx[i] * lateral,
      tx: tx[i],
      tz: tz[i],
      width,
      height,
    });
  }

  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const reachOut = band + fade;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, x[i] - reachOut);
    maxX = Math.max(maxX, x[i] + reachOut);
    minZ = Math.min(minZ, z[i] - reachOut);
    maxZ = Math.max(maxZ, z[i] + reachOut);
  }

  const startI = Math.round(120 / CANYON_STEP);
  const lastGate = gates[gates.length - 1];
  return {
    seed,
    n,
    x, z, tx, tz, half, floor, rim, wall,
    band,
    fade,
    length: CANYON_LENGTH,
    bounds: { minX, minZ, maxX, maxZ },
    gates,
    start: {
      x: x[startI],
      y: floor[startI] + 75,
      z: z[startI],
      heading: ((Math.atan2(tx[startI], -tz[startI]) * 180) / Math.PI + 360) % 360,
    },
    parTime: (lastGate ? lastGate.s : CANYON_LENGTH) / 175,
  };
}

/** A fresh seed for a new run. */
export function newCanyonSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

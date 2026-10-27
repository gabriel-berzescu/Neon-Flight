# Neon-Flight

Free flight over an endless procedural neon landscape, flown with a gamepad. The physics is
[JSBSim](https://github.com/JSBSim-Team/jsbsim), the open-source flight dynamics engine behind FlightGear, compiled to
WebAssembly and running in the browser.

**Play:** https://gabriel-berzescu.github.io/Neon-Flight/ (Chrome or Edge; a Logitech F310 in X mode, or any XInput pad).

**Smoothest on Windows: `play.bat`** (needs [Node.js](https://nodejs.org)). Double-click it in a copy of this repository: it
builds the game if needed, serves it locally and opens it fullscreen in its own Chrome window on the fast GPU, with sound on
from the start; Alt+F4 closes it and stops everything. On a laptop with two GPUs, a browser tab usually runs on the slower integrated
one: measured on an RTX 3050 laptop, the game holds 144 fps on the NVIDIA GPU, against 30 fps on the Intel one at full quality.

The web version adapts to the GPU it gets: on an integrated GPU it starts at lower quality (render resolution, anti-aliasing,
glow), and it steps down further while the frame rate drops below 50 fps or hitches, remembering the level for that GPU.
`?q=lowest`, `low`, `medium` or `high` on the URL fixes a level. To give a browser the fast GPU for good, in Windows: Settings,
System, Display, Graphics, then set Chrome to High performance.

## Controls

Four controls, nothing else. Each stick moves one wing; the triggers set the power of both engines.

| Control | Does |
|---|---|
| Left stick, up/down | left wing (its elevon) |
| Right stick, up/down | right wing |
| Right trigger | more power |
| Left trigger | less power |
| Start | pause menu (resume, canyon run, settings, main menu) |

- Both sticks back pulls the nose up; both forward pushes it down.
- One back and one forward rolls the wing (left back + right forward rolls left).
- The power stays where you leave it, like a throttle lever: the harder you pull a trigger, the faster it moves (idle to
  full in about 1.4 s at full pull). The tick on each engine bar shows the setting; the bar is the thrust, spooling to it.
- The sticks' left/right axes do nothing.

Keyboard, as a fallback: W/S is the left stick, Up/Down the right stick, Right/Left Shift more/less power.

A fly-by-wire sits between the sticks and the elevons, as in a modern fighter:
- Centred sticks keep the wing flying where its nose points, at any speed and any attitude, so there's no trim to manage.
- A bank up to 60° holds a level turn; pull to tighten it. Full stick is about +9 g back and -3 g forward.
- An angle-of-attack limiter keeps the wing out of the stall.

## Menus

The game opens on its title screen: the logo over a slow flight across the land toward the sun. From there: **Free flight**,
**Canyon run** (your best score beside it), **Settings**, **Controls** and **Credits**. Settings, kept in the browser:
- **Graphics:** Auto adapts to the GPU, or pick a fixed level from lowest to high.
- **Roll response:** gentle (100°/s at full stick), calm (150°/s) or sharp (230°/s).
- **Sound volume.**
- **Flight-path marker:** on or off.

Start opens the pause menu in flight, with the same settings and a way back to the main menu. `?free` skips the title.

## Canyon runs

Start, then **Canyon run**: a new canyon every time. Each run gets a fresh seed:
- it raises a mesa somewhere in the endless world and carves a winding slot canyon into it, about 12 km long, 70–160 m wide
  and around 200 m deep, cutting straight through any mountain in its way;
- about 18 gates hang inside it at different heights and offsets, smaller as the run goes on;
- a diamond marks the next gate, or an arrow points to it when it's off screen.

Scoring:
- **Gates:** each one flown through is 100, +50 for a bullseye through its middle third.
- **Combo:** gates in a row multiply the score, +0.25 each up to ×3, and a miss resets it.
- **Finish:** 25 points for every second under the par time, and 500 for a perfect run.
- **Crash:** a wall ends the run with the score so far.

Afterwards: **New canyon** (A), **Fly this canyon again** (X), or **Free flight** (B). The best score is kept in the browser.

The canyon is carved into the same terrain function the physics flies on, so the walls you see are the walls you hit: rendered and
physical ground agree to millimetres. `?canyon=<seed>` starts straight into that canyon.

## The aircraft

The Neon Wing is a small tailless flying wing: 9 m span, 2.5 t, two 11 kN turbojets 0.75 m either side of the centre line,
and two elevons. It is a JSBSim model written for this game, in [`src/fdm/aircraft/neonwing/neonwing.xml`](src/fdm/aircraft/neonwing/neonwing.xml):
- aerodynamic coefficients (lift curve with a stall, drag polar, wave drag, stability and damping derivatives);
- the fly-by-wire (a load-factor and roll-rate control law with gain scheduling and anti-windup);
- the engines, with spool-up.

Top speed is about 1000 km/h (Mach 0.83) at low level, and the stall speed is about 150 km/h.

## How it works

- **Physics:** JSBSim 1.3.3, unmodified, compiled with Emscripten together with a small bridge,
  [`native/jsbsim-bridge.cpp`](native/jsbsim-bridge.cpp). The bridge exposes JSBSim's property tree and stepping, plus a
  ground callback, so JSBSim's contact points and altitude above ground use the game's own procedural terrain. It runs at
  120 Hz, about 25 µs per step. The compiled module (`src/fdm/wasm/`, 1.6 MB) is committed, so building the game needs no
  C++ toolchain.
- **Terrain and sky:** an endless procedural landscape (seas, coasts, plains, hills, ridged mountain ranges up to about
  3 km, valleys and canyons) from integer-hashed gradient noise. The CPU height function is the physics' ground; the GPU
  renders the very same function (its GLSL is generated from the same tables) as a 9-level geometry clipmap reaching about
  57 km, with 2 m cells near the camera. Rendered and physical ground agree within about a centimetre. Neon grid and contour
  lines, a striped synthwave sun due north, stars.
- **Rendering:** three.js with bloom. **Sound:** synthesised with Web Audio.

## Develop

```sh
npm install
npm run dev          # http://127.0.0.1:5240/
npm test             # flight-model, controls and terrain tests
npm run build
```

Dev pages: `sandbox/terrain.html` (free camera over the terrain, `?x=&y=&z=&yaw=&pitch=`, `?fly=1`),
`sandbox/terrain-check.html` (GPU vs CPU heights), `sandbox/flight.html` (the game on a flat stand-in world).
`node scripts/fly.mjs` flies the game in headless Chrome with a fake F310 and takes screenshots.

Flight-model probe (prints trim, top speed, pulls, rolls, one-engine behaviour):

```sh
PROBE=1 npx vitest run tests/probes/flight.test.ts --disableConsoleIntercept
```

Rebuilding the WebAssembly (only after changing `native/jsbsim-bridge.cpp` or the JSBSim version) needs the
[Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) in `~/emsdk` or `$EMSDK`:

```sh
npm run build:jsbsim
```

## License

The game is MIT licensed (see [LICENSE](LICENSE)). JSBSim is LGPL-2.1. The WebAssembly module in `src/fdm/wasm/` is built
from the unmodified JSBSim source at tag `v1.3.3` (https://github.com/JSBSim-Team/jsbsim) by `scripts/build-jsbsim.mjs`,
which you can use to rebuild it against your own copy of JSBSim. `src/fdm/aircraft/engine/direct.xml` and the engine thrust
tables come from JSBSim's data files.

# Neon-Flight

Free flight over an endless procedural neon landscape, flown with a gamepad. The physics is
[JSBSim](https://github.com/JSBSim-Team/jsbsim), the open-source flight dynamics engine behind FlightGear, compiled to
WebAssembly and running in the browser.

**Play:** https://gabriel-berzescu.github.io/Neon-Flight/ (Chrome or Edge; a Logitech F310 in X mode, or any XInput pad).

## Controls

Four controls, nothing else. Each stick moves one wing, each trigger is one engine.

| Control | Does |
|---|---|
| Left stick, up/down | left wing (its elevon) |
| Right stick, up/down | right wing |
| Left trigger | left engine |
| Right trigger | right engine |
| Start | pause |

- Both sticks back pulls the nose up; both forward pushes it down.
- One back and one forward rolls the wing (left back + right forward rolls left).
- One engine alone yaws the wing a little toward the idle side.
- The sticks' left/right axes do nothing.

Keyboard, as a fallback: W/S is the left stick, Up/Down the right stick, Left/Right Shift the engines (Space for both).

A fly-by-wire sits between the sticks and the elevons, as in a modern fighter:
- Centred sticks keep the wing flying where its nose points, at any speed and any attitude, so there's no trim to manage.
- A bank up to 60° holds a level turn; pull to tighten it. Full stick is about +9 g back and -3 g forward.
- An angle-of-attack limiter keeps the wing out of the stall.

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
- **Terrain and sky:** procedural, generated on the GPU, with the same height function on the CPU for the physics.
- **Rendering:** three.js with bloom. **Sound:** synthesised with Web Audio.

## Develop

```sh
npm install
npm run dev          # http://127.0.0.1:5240/
npm test             # flight-model, controls and terrain tests
npm run build
```

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

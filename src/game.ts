/**
 * The game. Two modes:
 *   FREE FLIGHT  spawn high over the land heading north and fly; crash, and a new flight starts above the crash site.
 *   CANYON RUN   a new canyon carved somewhere in the world (src/world/canyon.ts), gates to fly through (src/game/canyon-run.ts);
 *                a countdown, the run, then the results: a new canyon, the same one again, or back to free flight.
 * Start opens the pause menu, which switches between them.
 *
 * Each frame: read the controls (menus first), step the flight (JSBSim), check the gates, pose the wing and the camera, update
 * the world (terrain, sky, gates), the HUDs and the sound, render.
 *
 * Debug / QA hooks: `window.__nf` (the game), `window.__READY__` (true once the first frames are on screen).
 */
import * as THREE from 'three';
import { createSim } from './fdm/jsbsim';
import { Flight, type GroundFn } from './flight/flight';
import { Controls } from './input/controls';
import { AircraftView } from './render/aircraft';
import { Burst } from './render/burst';
import { ChaseCamera } from './render/chase-camera';
import { GatesView } from './render/gates';
import { PALETTE } from './render/palette';
import { QUALITY, Stage } from './render/stage';
import { QualityGovernor } from './render/quality';
import { Hud } from './ui/hud';
import { Menu, type MenuSpec } from './ui/menu';
import { RunHud } from './ui/run-hud';
import { Sound } from './audio/sound';
import { generateCanyon, newCanyonSeed, type Canyon } from './world/canyon';
import { CanyonRun } from './game/canyon-run';
import { autopilot } from './game/autopilot';
import { TitleCamera } from './render/title-camera';
import { loadSettings, ROLL_RATE, saveSettings, type Settings } from './settings';

/** Something in the world that follows the camera (terrain, sky). */
export interface WorldView {
  readonly object: THREE.Object3D;
  update(camera: THREE.PerspectiveCamera, timeSeconds: number): void;
}

export interface World {
  /** The ground the aircraft hits (terrain, sea, and the canyon while one is carved). */
  ground: GroundFn;
  views: WorldView[];
  /** Unit vector toward the sun (world space), for the aircraft's light. */
  sunDirection: THREE.Vector3;
  /** The terrain without any canyon (canyons are laid out on it); defaults to `ground`. */
  baseGround?: GroundFn;
  /** Carves a canyon into the world (physics and picture), or removes it (null). Without it, runs fly over plain terrain. */
  setCanyon?: (canyon: Canyon | null) => void;
}

const SPAWN_AGL = 550;
const SPAWN_SPEED = 150;
/** Engines hold this until the player first touches a trigger (so the help card can be read in flight). */
const SPAWN_ENGINES = 0.55;
const RESPAWN_DELAY = 3.5;
const RUN_SPEED = 150;
const RUN_ENGINES = 0.5;
const COUNTDOWN = 3.5;
/** Seconds between the end of a run and its results card (time to see the crash, or to fly out of the canyon). */
const RESULTS_DELAY = { crashed: 2.2, finished: 1.6 };
const BEST_KEY = 'neon-flight.best';

type Mode = 'title' | 'free' | 'canyon';

export class Game {
  readonly stage: Stage;
  readonly controls = new Controls();
  readonly aircraft = new AircraftView();
  readonly burst = new Burst();
  readonly gates = new GatesView();
  readonly hud: Hud;
  readonly runHud: RunHud;
  readonly menu: Menu;
  readonly sound = new Sound();
  readonly quality: QualityGovernor;
  flight!: Flight;
  mode: Mode = 'title';
  readonly settings: Settings = loadSettings();
  private titleCam!: TitleCamera;
  /** Where a settings menu goes back to. */
  private menuReturn: 'title' | 'pause' = 'title';
  /** The title-menu item a sub-menu was opened from (Back returns there). */
  private titleSel = 0;
  private qualityFromUrl = false;
  canyon: Canyon | null = null;
  run: CanyonRun | null = null;
  private chase!: ChaseCamera;
  private paused = false;
  private countdown = 0;
  private resultsIn = Infinity;
  private respawnIn = 0;
  private holdEngines = SPAWN_ENGINES;
  private wasCrashed = false;
  private readonly lastPos = new THREE.Vector3();
  private time = 0;
  private last = 0;
  private frames = 0;
  private readonly size = new THREE.Vector2();
  /** QA: `?autopilot=1` flies the run's gates (see game/autopilot.ts). */
  private readonly autopilot = new URLSearchParams(location.search).has('autopilot');

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement, readonly world: World) {
    this.stage = new Stage(canvas);
    // ?q=0..3 (or lowest/low/medium/high) fixes the quality level, for testing
    const q = new URLSearchParams(location.search).get('q');
    if (q !== null) this.stage.quality = /^\d$/.test(q) ? +q : QUALITY.findIndex((l) => l.name === q);
    this.hud = new Hud(ui);
    this.runHud = new RunHud(ui);
    this.menu = new Menu(ui);
    this.qualityFromUrl = q !== null;
    this.quality = new QualityGovernor(this.stage, q !== null);
    this.quality.onChange = (name) => this.hud.flash(`graphics: ${name}, for a smooth frame rate`);
    const scene = this.stage.scene;
    for (const v of world.views) scene.add(v.object);
    scene.add(this.aircraft.object, this.aircraft.effects, this.burst.object, this.gates.object);
    // light for the aircraft: a dim violet sky, the low sun
    scene.add(new THREE.HemisphereLight(0x6a3cff, 0x0a0614, 0.55));
    const sun = new THREE.DirectionalLight(PALETTE.sunGlow, 1.3);
    sun.position.copy(world.sunDirection).multiplyScalar(1000);
    sun.target = this.aircraft.object;
    scene.add(sun);
    (window as unknown as { __nf: Game }).__nf = this;
  }

  async boot(): Promise<void> {
    const sim = await createSim();
    this.flight = new Flight(sim, this.world.ground);
    this.chase = new ChaseCamera(this.stage.camera, this.world.ground);
    this.titleCam = new TitleCamera(this.stage.camera, this.world.baseGround ?? this.world.ground);
    this.applySettings();
    this.spawn(0, 0, 0);
    // ?canyon=<seed> (or ?canyon) starts straight in a canyon run, ?free in free flight (for testing); otherwise the title
    const params = new URLSearchParams(location.search);
    const c = params.get('canyon');
    if (c !== null) this.startRun(c === '' ? undefined : +c >>> 0);
    else if (params.has('free')) this.startFree();
    else this.openTitle();
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  /** A new free flight above (x, z), heading `heading` degrees. */
  spawn(x: number, z: number, heading: number): void {
    this.flight.spawn({ x, z, agl: SPAWN_AGL, heading, speed: SPAWN_SPEED, engines: SPAWN_ENGINES });
    this.holdEngines = SPAWN_ENGINES;
    this.afterSpawn();
  }

  private afterSpawn(): void {
    this.aircraft.reset();
    this.chase.reset();
    this.wasCrashed = false;
    this.lastPos.copy(this.flight.state.position);
  }

  /** A canyon run: a new canyon for `seed` (a fresh seed when left out), or the current one again with `again`. */
  startRun(seed?: number, again = false): void {
    if (!again || !this.canyon) {
      this.canyon = generateCanyon(seed ?? newCanyonSeed(), this.world.baseGround ?? this.world.ground);
      this.world.setCanyon?.(this.canyon);
      this.gates.setCanyon(this.canyon);
    }
    const c = this.canyon;
    this.mode = 'canyon';
    this.showFlight();
    this.run = new CanyonRun(c);
    this.flight.spawn({ x: c.start.x, z: c.start.z, agl: 0, y: c.start.y, heading: c.start.heading, speed: RUN_SPEED, engines: RUN_ENGINES });
    this.holdEngines = RUN_ENGINES;
    this.afterSpawn();
    this.countdown = COUNTDOWN;
    this.resultsIn = Infinity;
    this.paused = false;
    this.menu.close();
  }

  /** Back to free flight: the canyon goes, a new flight starts high above where the aircraft is. */
  freeFlight(): void {
    const s = this.flight.state;
    const at = { x: s.position.x, z: s.position.z, heading: s.headingDeg };
    this.mode = 'free';
    this.run = null;
    this.canyon = null;
    this.world.setCanyon?.(null);
    this.gates.setCanyon(null);
    this.runHud.hide();
    this.countdown = 0;
    this.paused = false;
    this.menu.close();
    this.showFlight();
    this.spawn(at.x, at.z, at.heading);
  }

  /** From the title: a new free flight at the start (high above the land, heading north toward the sun). */
  startFree(): void {
    this.mode = 'free';
    this.paused = false;
    this.countdown = 0;
    this.menu.close();
    this.showFlight();
    this.spawn(0, 0, 0);
  }

  /** The title screen: the logo over a slow flight across the land, and the main menu. */
  openTitle(): void {
    this.mode = 'title';
    this.run = null;
    this.canyon = null;
    this.world.setCanyon?.(null);
    this.gates.setCanyon(null);
    this.runHud.hide();
    this.hud.setVisible(false);
    this.aircraft.object.visible = false;
    this.aircraft.effects.visible = false;
    this.paused = false;
    this.countdown = 0;
    this.titleCam.reset(0, 9000);
    this.showTitleMenu();
  }

  private showFlight(): void {
    this.hud.setVisible(true);
    this.aircraft.effects.visible = true;
  }

  private showTitleMenu(selected = 0): void {
    this.menuReturn = 'title';
    let best = 0;
    try {
      best = Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
    } catch {
      // no storage
    }
    this.menu.open({
      title: 'Neon-Flight',
      style: 'title',
      body: 'a flying wing &middot; an endless neon world',
      selected,
      choices: [
        { id: 'free', label: 'Free flight' },
        { id: 'new', label: 'Canyon run', key: best > 0 ? `best ${best}` : undefined },
        { id: 'settings', label: 'Settings' },
        { id: 'controls', label: 'Controls' },
        { id: 'credits', label: 'Credits' },
      ],
    });
  }

  private openSettings(selected = 0): void {
    this.menuReturn = this.mode === 'title' ? 'title' : 'pause';
    const s = this.settings;
    const q = s.quality === 'auto' ? `auto (${QUALITY[this.stage.quality].name} now)` : QUALITY[s.quality].name;
    this.menu.open({
      title: 'Settings',
      style: this.mode === 'title' ? 'title' : 'card',
      body: this.mode === 'title' ? 'A / enter changes a setting' : undefined,
      selected,
      back: 'back',
      choices: [
        { id: 'set:quality', label: `graphics: ${this.qualityFromUrl ? 'fixed by the url' : q}` },
        { id: 'set:roll', label: `roll response: ${s.roll === 'calm' ? 'calm (150°/s)' : 'sharp (230°/s)'}` },
        { id: 'set:volume', label: `sound: ${Math.round(s.volume * 100)}%` },
        { id: 'set:fpm', label: `flight-path marker: ${s.fpm ? 'on' : 'off'}` },
        { id: 'back', label: 'back', key: 'B' },
      ],
    });
  }

  private changeSetting(key: string): void {
    const s = this.settings;
    const order: Settings['quality'][] = ['auto', 3, 2, 1, 0];
    if (key === 'quality') s.quality = order[(order.indexOf(s.quality) + 1) % order.length];
    else if (key === 'roll') s.roll = s.roll === 'calm' ? 'sharp' : 'calm';
    else if (key === 'volume') s.volume = s.volume >= 0.99 ? 0 : Math.round((s.volume + 0.2) * 10) / 10;
    else if (key === 'fpm') s.fpm = !s.fpm;
    saveSettings(s);
    this.applySettings();
    this.openSettings(['quality', 'roll', 'volume', 'fpm'].indexOf(key));
  }

  private applySettings(): void {
    const s = this.settings;
    if (!this.qualityFromUrl) this.quality.setMode(s.quality);
    this.sound.setVolume(s.volume);
    this.hud.setFpm(s.fpm);
    this.flight?.set('fcs/roll-rate-max', ROLL_RATE[s.roll]);
  }

  private openInfo(which: 'controls' | 'credits'): void {
    this.menuReturn = 'title';
    this.menu.open({
      title: which,
      style: 'title',
      body: `<div class="info">${which === 'controls' ? CONTROLS_HTML : CREDITS_HTML}</div>`,
      back: 'back',
      choices: [{ id: 'back', label: 'back', key: 'B' }],
    });
  }

  private openPause(): void {
    this.paused = true;
    const choices: MenuSpec['choices'] = [{ id: 'resume', label: 'Resume', key: 'start' }];
    if (this.mode === 'canyon') {
      choices.push({ id: 'retry', label: 'Restart this canyon', key: 'X' }, { id: 'new', label: 'New canyon' }, { id: 'free', label: 'Free flight' });
    } else {
      choices.push({ id: 'new', label: 'Canyon run' });
    }
    choices.push({ id: 'settings', label: 'Settings' }, { id: 'title', label: 'Main menu' });
    this.menu.open({ title: 'Paused', choices, back: 'resume', retry: this.mode === 'canyon' ? 'retry' : undefined });
  }

  private openResults(run: CanyonRun): void {
    const total = run.canyon.gates.length;
    const gatePoints = run.score - run.timeBonus - run.perfectBonus;
    let best = 0;
    try {
      best = Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
      if (run.score > best) localStorage.setItem(BEST_KEY, String(run.score));
    } catch {
      // no storage: no best score
    }
    const isBest = run.score > best && run.score > 0;
    const t = (s: number) => `${s.toFixed(1)} s`;
    const rows = [
      ['gates', `${run.passed} / ${total}`],
      ['best combo', `${run.bestStreak} in a row`],
      ['time', run.status === 'finished' ? `${t(run.elapsed)} (par ${t(run.canyon.parTime)})` : t(run.elapsed)],
      ['gate points', String(gatePoints)],
      ...(run.status === 'finished' ? [['time bonus', String(run.timeBonus)], ['perfect run', run.perfectBonus ? String(run.perfectBonus) : '-']] : []),
    ];
    const body =
      `<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}` +
      `<tr class="total"><td>score</td><td>${run.score}</td></tr></table>` +
      `<div class="note">${isBest ? 'a new best!' : best > 0 ? `best so far: ${Math.max(best, run.score)}` : ''}</div>`;
    this.menu.open({
      title: run.status === 'finished' ? 'Run complete' : 'Run over',
      body,
      choices: [
        { id: 'new', label: 'New canyon', key: 'A' },
        { id: 'retry', label: 'Fly this canyon again', key: 'X' },
        { id: 'free', label: 'Free flight', key: 'B' },
        { id: 'title', label: 'Main menu' },
      ],
      back: 'free',
      retry: 'retry',
    });
  }

  private pick(id: string): void {
    if (id === 'resume') {
      this.paused = false;
      this.menu.close();
    } else if (id === 'new') this.startRun();
    else if (id === 'retry') this.startRun(undefined, true);
    else if (id === 'free') {
      if (this.mode === 'title') this.startFree();
      else this.freeFlight();
    } else if (id === 'title') this.openTitle();
    else if (id === 'settings' || id === 'controls' || id === 'credits') {
      if (this.mode === 'title') this.titleSel = ['settings', 'controls', 'credits'].indexOf(id) + 2;
      if (id === 'settings') this.openSettings();
      else this.openInfo(id);
    }
    else if (id === 'back') {
      if (this.menuReturn === 'pause') this.openPause();
      else this.showTitleMenu(this.titleSel);
    } else if (id.startsWith('set:')) this.changeSetting(id.slice(4));
  }

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.step(dt);
    if (++this.frames === 3) (window as unknown as { __READY__: boolean }).__READY__ = true;
  };

  /** QA: the cost of `steps` physics steps (ms per step), flown hands-off from a fresh spawn here. */
  benchPhysics(steps = 1200): number {
    const s = this.flight.state;
    this.spawn(s.position.x, s.position.z, s.headingDeg);
    const c = { stickLeft: 0, stickRight: 0, throttleLeft: 0.8, throttleRight: 0.8 };
    const t = performance.now();
    let n = 0;
    while (n < steps) n += this.flight.update(1 / 120, c) || 1;
    return (performance.now() - t) / n;
  }

  /** One frame of game time (public so QA scripts can drive it). */
  step(dt: number): void {
    const c = this.controls.poll(dt);
    const f = this.flight;

    // menus first: an open menu takes the navigation buttons (and Start closes the pause menu)
    if (this.menu.isOpen) {
      let choice = this.menu.handle(c.nav);
      if (!choice && c.pause && this.paused) choice = 'resume';
      if (choice) this.pick(choice);
    } else if (c.pause && this.mode !== 'title') this.openPause();

    if (this.mode === 'title') {
      this.time += dt;
      this.quality.frame(dt, true);
      this.titleCam.update(dt);
      this.stage.camera.updateMatrixWorld();
      for (const v of this.world.views) v.update(this.stage.camera, this.time);
      this.sound.update(f.state, true);
      this.stage.render();
      return;
    }

    const frozen = this.paused || this.countdown > 0;
    this.quality.frame(dt, !frozen && !f.state.crashed);
    if (!frozen) {
      this.time += dt;
      if (c.engineLeft > 0.08 || c.engineRight > 0.08) this.holdEngines = 0;
      const hold = Math.sqrt(this.holdEngines);
      const ap = this.autopilot && this.run ? autopilot(f.state, this.run.canyon.gates[this.run.next], this.run.canyon, this.run.progress) : null;
      f.update(
        dt,
        ap ?? {
          stickLeft: c.stickLeft,
          stickRight: c.stickRight,
          throttleLeft: Math.max(c.throttleLeft, hold),
          throttleRight: Math.max(c.throttleRight, hold),
        },
      );
      const s = f.state;
      if (s.crashed && !this.wasCrashed) {
        this.burst.fire(s.position, s.velocity);
        if (this.mode === 'free') this.respawnIn = RESPAWN_DELAY;
        else this.run?.crash();
      }
      this.wasCrashed = s.crashed;
      if (this.mode === 'free' && s.crashed) {
        this.respawnIn -= dt;
        if (this.respawnIn <= 0) this.spawn(s.position.x, s.position.z, s.headingDeg);
      }
      const run = this.run;
      if (run) {
        for (const e of run.update(this.lastPos, s.position, dt)) {
          this.gates.flash(e.gate.index, e.result);
          this.runHud.event(e);
          this.sound.gate(e.result, e.bullseye);
        }
        if (run.status !== 'flying' && this.resultsIn === Infinity) this.resultsIn = RESULTS_DELAY[run.status];
        if (this.resultsIn !== Infinity && !this.menu.isOpen) {
          this.resultsIn -= dt;
          if (this.resultsIn <= 0) this.openResults(run);
        }
      }
    } else if (this.countdown > 0 && !this.paused) {
      this.countdown -= dt;
    }
    this.lastPos.copy(f.state.position);

    const s = f.state;
    const cam = this.stage.camera;
    const size = this.stage.renderer.getDrawingBufferSize(this.size);
    this.aircraft.setResolution(size.x, size.y);
    this.aircraft.update(s, frozen ? 0 : dt, cam);
    this.chase.update(s, frozen ? 0 : dt);
    cam.updateMatrixWorld();
    this.burst.update(this.paused ? 0 : dt, this.world.ground(s.position.x, s.position.z));
    if (this.run) {
      this.gates.update(this.run.results, this.run.next, dt);
      this.runHud.update(this.run, s.position, cam, dt, this.countdown);
    }
    for (const v of this.world.views) v.update(cam, this.time);
    this.hud.update(s, c, cam, dt, {
      paused: false,
      respawnIn: this.respawnIn,
      soundLocked: this.sound.locked,
      menuOpen: this.menu.isOpen,
      inRun: this.mode === 'canyon',
    });
    this.sound.update(s, frozen);
    this.stage.render();
  }
}

const CONTROLS_HTML = `<table>
<tr><td>left stick &#8597;</td><td>left wing</td></tr>
<tr><td>right stick &#8597;</td><td>right wing</td></tr>
<tr><td>LT / RT</td><td>left / right engine</td></tr>
<tr><td>both back / forward</td><td>nose up / down</td></tr>
<tr><td>one back, one forward</td><td>roll</td></tr>
<tr><td>START</td><td>pause menu</td></tr>
</table>
<p>Centred sticks keep flying where the nose points; a bank up to 60&deg; holds a level turn, pull to tighten it.
One engine alone yaws the wing a little. The flight-path marker shows where you are really going: put it on a gate.</p>
<p>Keyboard: W/S and &#8593;/&#8595; for the wings, Left/Right Shift for the engines, Esc to pause.</p>`;

const CREDITS_HTML = `<p><b>Idea, design and test flights</b><br>Gabriel Berzescu</p>
<p><b>Built by</b><br>Claude (Opus 5.5, Anthropic), with Claude helpers for the terrain, the sky and the canyons</p>
<p><b>Flight dynamics</b><br>JSBSim, by the JSBSim team (LGPL-2.1), compiled to WebAssembly with Emscripten</p>
<p><b>Graphics</b><br>three.js (MIT)</p>
<p>Made on 26 October 2026, in one long session.</p>`;

/**
 * The game: free flight. Spawn high over the land heading north, fly; crash, and a new flight starts above the crash site.
 *
 * Each frame: read the controls, step the flight (JSBSim), pose the wing and the camera, update the world (terrain, sky), the
 * HUD and the sound, render.
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
import { PALETTE } from './render/palette';
import { QUALITY, Stage } from './render/stage';
import { QualityGovernor } from './render/quality';
import { Hud } from './ui/hud';
import { Sound } from './audio/sound';

/** Something in the world that follows the camera (terrain, sky). */
export interface WorldView {
  readonly object: THREE.Object3D;
  update(camera: THREE.PerspectiveCamera, timeSeconds: number): void;
}

export interface World {
  ground: GroundFn;
  views: WorldView[];
  /** Unit vector toward the sun (world space), for the aircraft's light. */
  sunDirection: THREE.Vector3;
}

const SPAWN_AGL = 550;
const SPAWN_SPEED = 150;
/** Engines hold this until the player first touches a trigger (so the help card can be read in flight). */
const SPAWN_ENGINES = 0.55;
const RESPAWN_DELAY = 3.5;

export class Game {
  readonly stage: Stage;
  readonly controls = new Controls();
  readonly aircraft = new AircraftView();
  readonly burst = new Burst();
  readonly hud: Hud;
  readonly sound = new Sound();
  readonly quality: QualityGovernor;
  flight!: Flight;
  private chase!: ChaseCamera;
  private paused = false;
  private respawnIn = 0;
  private holdEngines = SPAWN_ENGINES;
  private wasCrashed = false;
  private time = 0;
  private last = 0;
  private frames = 0;
  private readonly size = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement, readonly world: World) {
    this.stage = new Stage(canvas);
    // ?q=0..3 (or lowest/low/medium/high) fixes the quality level, for testing
    const q = new URLSearchParams(location.search).get('q');
    if (q !== null) this.stage.quality = /^\d$/.test(q) ? +q : QUALITY.findIndex((l) => l.name === q);
    this.quality = new QualityGovernor(this.stage, q !== null);
    this.quality.onChange = (name) => this.hud.flash(`graphics: ${name}, for a smooth frame rate`);
    this.hud = new Hud(ui);
    const scene = this.stage.scene;
    for (const v of world.views) scene.add(v.object);
    scene.add(this.aircraft.object, this.aircraft.effects, this.burst.object);
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
    this.spawn(0, 0, 0);
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  /** A new flight above (x, z), heading `heading` degrees. */
  spawn(x: number, z: number, heading: number): void {
    this.flight.spawn({ x, z, agl: SPAWN_AGL, heading, speed: SPAWN_SPEED, engines: SPAWN_ENGINES });
    this.holdEngines = SPAWN_ENGINES;
    this.aircraft.reset();
    this.chase.reset();
    this.wasCrashed = false;
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
    this.quality.frame(dt, !this.paused && !this.flight.state.crashed);
    if (c.pause) this.paused = !this.paused;
    const f = this.flight;
    if (!this.paused) {
      this.time += dt;
      if (c.engineLeft > 0.08 || c.engineRight > 0.08) this.holdEngines = 0;
      const hold = Math.sqrt(this.holdEngines);
      f.update(dt, {
        stickLeft: c.stickLeft,
        stickRight: c.stickRight,
        throttleLeft: Math.max(c.throttleLeft, hold),
        throttleRight: Math.max(c.throttleRight, hold),
      });
      const s = f.state;
      if (s.crashed && !this.wasCrashed) {
        this.respawnIn = RESPAWN_DELAY;
        this.burst.fire(s.position, s.velocity);
      }
      this.wasCrashed = s.crashed;
      if (s.crashed) {
        this.respawnIn -= dt;
        if (this.respawnIn <= 0) this.spawn(s.position.x, s.position.z, s.headingDeg);
      }
    }
    const s = f.state;
    const cam = this.stage.camera;
    const size = this.stage.renderer.getDrawingBufferSize(this.size);
    this.aircraft.setResolution(size.x, size.y);
    this.aircraft.update(s, this.paused ? 0 : dt, cam);
    this.chase.update(s, this.paused ? 0 : dt);
    cam.updateMatrixWorld();
    this.burst.update(this.paused ? 0 : dt, this.world.ground(s.position.x, s.position.z));
    for (const v of this.world.views) v.update(cam, this.time);
    this.hud.update(s, c, cam, dt, { paused: this.paused, respawnIn: this.respawnIn, soundLocked: this.sound.locked });
    this.sound.update(s, this.paused);
    this.stage.render();
  }
}

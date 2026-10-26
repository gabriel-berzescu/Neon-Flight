/**
 * The four flight controls, from a gamepad (Logitech F310 in X mode = the `standard` mapping) or the keyboard.
 *
 *   left stick  Y  -> left wing   (stickLeft:  -1 pushed forward .. +1 pulled back)
 *   right stick Y  -> right wing  (stickRight: the same)
 *   left trigger   -> left engine  (engineLeft:  0..1)
 *   right trigger  -> right engine (engineRight: 0..1)
 * The sticks' X axes do nothing. Start (or Esc / P) pauses.
 *
 * Keyboard (fallback, mirrors the pad): W / S = left stick forward / back, Up / Down = right stick forward / back,
 * Left Shift = left engine, Right Shift = right engine, Space = both engines.
 *
 * Stick values get a radial-free dead zone and a mild expo curve (fine control near the centre, full deflection at the end).
 * Trigger values are mapped so thrust grows linearly with the trigger: a turbojet's thrust grows with the square of its spool
 * speed, and the throttle sets the spool speed, so the throttle is the square root of the trigger.
 */

export interface FlightControls {
  stickLeft: number;
  stickRight: number;
  engineLeft: number;
  engineRight: number;
}

export interface ControlFrame extends FlightControls {
  /** Throttle commands for JSBSim (0..1), already shaped from the triggers. */
  throttleLeft: number;
  throttleRight: number;
  /** Pause pressed this frame (edge). */
  pause: boolean;
  /** Menu navigation, edges this frame (the D-pad, A / B / X; the arrow keys, Enter, Escape / Backspace, R). Menus only. */
  nav: { up: boolean; down: boolean; confirm: boolean; back: boolean; retry: boolean };
  /** Any control moved this frame (to hide the help card, unlock audio, ...). */
  active: boolean;
  device: 'gamepad' | 'keyboard' | 'none';
  padName: string | null;
}

/** The part of a Gamepad this module reads (tests fake it). */
export interface PadLike {
  readonly id: string;
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: ArrayLike<number>;
  readonly buttons: ArrayLike<{ readonly pressed: boolean; readonly value: number }>;
}

export const STICK_DEADZONE = 0.08;
/** 0 = linear, 1 = cubic. */
export const STICK_EXPO = 0.35;
export const TRIGGER_DEADZONE = 0.02;

/** F310 standard mapping indices. */
const AXIS_LEFT_Y = 1;
const AXIS_RIGHT_Y = 3;
const BTN_LT = 6;
const BTN_RT = 7;
const BTN_START = 9;
const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_UP = 12;
const BTN_DOWN = 13;
const NAV_BUTTONS = [BTN_UP, BTN_DOWN, BTN_A, BTN_B, BTN_X] as const;

export function shapeStick(v: number): number {
  const a = Math.abs(v);
  if (!(a > STICK_DEADZONE)) return 0;
  const t = Math.min(1, (a - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return Math.sign(v) * ((1 - STICK_EXPO) * t + STICK_EXPO * t * t * t);
}

export function shapeTrigger(v: number): number {
  if (!(v > TRIGGER_DEADZONE)) return 0;
  return Math.min(1, (v - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE));
}

/** Trigger (thrust fraction) -> JSBSim throttle (spool fraction). */
export function throttleFor(engine: number): number {
  return Math.sqrt(Math.max(0, Math.min(1, engine)));
}

const KEYS = new Set(['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown', 'ShiftLeft', 'ShiftRight', 'Space', 'Escape', 'KeyP', 'Enter', 'NumpadEnter', 'Backspace', 'KeyR']);
/** Keyboard ramps (per second). */
const KEY_STICK_RATE = 3.0;
const KEY_STICK_RETURN = 5.0;
const KEY_ENGINE_RATE = 1.5;

function approach(v: number, target: number, up: number, down: number, dt: number): number {
  const rate = Math.abs(target) > Math.abs(v) || Math.sign(target) !== Math.sign(v) ? up : down;
  const d = target - v;
  const s = rate * dt;
  return Math.abs(d) <= s ? target : v + Math.sign(d) * s;
}

export class Controls {
  readonly frame: ControlFrame = {
    stickLeft: 0, stickRight: 0, engineLeft: 0, engineRight: 0, throttleLeft: 0, throttleRight: 0,
    pause: false, nav: { up: false, down: false, confirm: false, back: false, retry: false }, active: false, device: 'none', padName: null,
  };
  private readonly held = new Set<string>();
  private pausePending = false;
  private startWasDown = false;
  private navWasDown: boolean[] = [false, false, false, false, false];
  private navPending = { up: false, down: false, confirm: false, back: false, retry: false };
  private kb = { l: 0, r: 0, el: 0, er: 0 };
  private lastPadActivity = -Infinity;
  private lastKeyActivity = -Infinity;
  private time = 0;

  constructor(
    private readonly getPads: () => ArrayLike<PadLike | null> = () => (typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []),
    target: EventTarget | null = typeof window !== 'undefined' ? window : null,
  ) {
    if (target) {
      target.addEventListener('keydown', (e) => this.onKey(e as KeyboardEvent, true));
      target.addEventListener('keyup', (e) => this.onKey(e as KeyboardEvent, false));
      target.addEventListener('blur', () => this.held.clear());
    }
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!KEYS.has(e.code)) return;
    e.preventDefault();
    if (down && !e.repeat && (e.code === 'Escape' || e.code === 'KeyP')) this.pausePending = true;
    if (down && !e.repeat) {
      const n = this.navPending;
      if (e.code === 'ArrowUp') n.up = true;
      else if (e.code === 'ArrowDown') n.down = true;
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') n.confirm = true;
      else if (e.code === 'Escape' || e.code === 'Backspace') n.back = true;
      else if (e.code === 'KeyR') n.retry = true;
    }
    if (down) this.held.add(e.code);
    else this.held.delete(e.code);
    this.lastKeyActivity = this.time;
  }

  /** The pad to read: the first connected one in standard mapping (else the first connected one). */
  private pad(): PadLike | null {
    let any: PadLike | null = null;
    let pads: ArrayLike<PadLike | null>;
    try {
      pads = this.getPads();
    } catch {
      return null;
    }
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      if (p.mapping === 'standard') return p;
      any ??= p;
    }
    return any;
  }

  poll(dt: number): ControlFrame {
    this.time += dt;
    const f = this.frame;
    const prev = { l: f.stickLeft, r: f.stickRight, el: f.engineLeft, er: f.engineRight };

    // keyboard state (always tracked, so switching devices is seamless)
    const h = this.held;
    const kl = (h.has('KeyS') ? 1 : 0) - (h.has('KeyW') ? 1 : 0);
    const kr = (h.has('ArrowDown') ? 1 : 0) - (h.has('ArrowUp') ? 1 : 0);
    const kel = h.has('ShiftLeft') || h.has('Space') ? 1 : 0;
    const ker = h.has('ShiftRight') || h.has('Space') ? 1 : 0;
    const kb = this.kb;
    kb.l = approach(kb.l, kl, KEY_STICK_RATE, KEY_STICK_RETURN, dt);
    kb.r = approach(kb.r, kr, KEY_STICK_RATE, KEY_STICK_RETURN, dt);
    kb.el = approach(kb.el, kel, KEY_ENGINE_RATE, KEY_ENGINE_RATE, dt);
    kb.er = approach(kb.er, ker, KEY_ENGINE_RATE, KEY_ENGINE_RATE, dt);

    const pad = this.pad();
    let pl = 0, pr = 0, pel = 0, per = 0;
    let start = false;
    if (pad) {
      pl = shapeStick(pad.axes[AXIS_LEFT_Y] ?? 0);
      pr = shapeStick(pad.axes[AXIS_RIGHT_Y] ?? 0);
      pel = shapeTrigger(pad.buttons[BTN_LT]?.value ?? 0);
      per = shapeTrigger(pad.buttons[BTN_RT]?.value ?? 0);
      start = !!pad.buttons[BTN_START]?.pressed;
      if (pl !== 0 || pr !== 0 || pel > 0.05 || per > 0.05 || start) this.lastPadActivity = this.time;
    }
    const usePad = pad !== null && this.lastPadActivity >= this.lastKeyActivity;
    if (usePad) {
      f.stickLeft = pl; f.stickRight = pr; f.engineLeft = pel; f.engineRight = per;
      f.device = 'gamepad';
    } else {
      f.stickLeft = kb.l; f.stickRight = kb.r; f.engineLeft = kb.el; f.engineRight = kb.er;
      f.device = pad || this.lastKeyActivity > -Infinity ? 'keyboard' : 'none';
    }
    f.throttleLeft = throttleFor(f.engineLeft);
    f.throttleRight = throttleFor(f.engineRight);
    f.padName = pad ? pad.id.replace(/\s*\(.*$/, '').trim() || 'Gamepad' : null;

    f.pause = this.pausePending || (start && !this.startWasDown);
    const navDown = NAV_BUTTONS.map((b) => !!pad?.buttons[b]?.pressed);
    const edge = (i: number) => navDown[i] && !this.navWasDown[i];
    const n = this.navPending;
    f.nav.up = n.up || edge(0);
    f.nav.down = n.down || edge(1);
    f.nav.confirm = n.confirm || edge(2);
    f.nav.back = n.back || edge(3);
    f.nav.retry = n.retry || edge(4);
    this.navWasDown = navDown;
    this.navPending = { up: false, down: false, confirm: false, back: false, retry: false };
    this.pausePending = false;
    this.startWasDown = start;
    f.active =
      f.pause ||
      Math.abs(f.stickLeft - prev.l) > 1e-3 || Math.abs(f.stickRight - prev.r) > 1e-3 ||
      Math.abs(f.engineLeft - prev.el) > 1e-3 || Math.abs(f.engineRight - prev.er) > 1e-3;
    return f;
  }
}

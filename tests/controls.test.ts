import { describe, expect, it } from 'vitest';
import { Controls, POWER_RATE, shapeStick, shapeTrigger, stepPower, throttleFor, type PadLike } from '../src/input/controls';
import { loadSettings, nextRoll, ROLL_RATE } from '../src/settings';

function fakePad(): PadLike & { axes: number[]; buttons: { pressed: boolean; value: number }[] } {
  return {
    id: 'Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c21d)',
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
  };
}

describe('shaping', () => {
  it('sticks: dead zone, sign, full deflection, gentler near the centre', () => {
    expect(shapeStick(0.05)).toBe(0);
    expect(shapeStick(-0.05)).toBe(0);
    expect(shapeStick(1)).toBeCloseTo(1, 9);
    expect(shapeStick(-1)).toBeCloseTo(-1, 9);
    expect(shapeStick(0.5)).toBeGreaterThan(0);
    expect(shapeStick(0.5)).toBeLessThan(0.5);
    expect(shapeStick(Number.NaN)).toBe(0);
  });
  it('triggers: 0..1 with a small dead zone', () => {
    expect(shapeTrigger(0.01)).toBe(0);
    expect(shapeTrigger(1)).toBe(1);
    expect(shapeTrigger(0.51)).toBeCloseTo(0.5, 2);
  });
  it('the triggers move the power setting, which stays where it is left', () => {
    expect(stepPower(0.2, 1, 0, 1)).toBeCloseTo(0.2 + POWER_RATE, 9); // full RT for a second
    expect(stepPower(0.5, 0, 1, 0.5)).toBeCloseTo(0.5 - POWER_RATE / 2, 9); // full LT for half a second
    expect(stepPower(0.5, 0.3, 0, 1)).toBeCloseTo(0.5 + 0.09 * POWER_RATE, 9); // a light pull: fine steps
    expect(stepPower(0.5, 0.6, 0.6, 1)).toBe(0.5); // both: they cancel
    expect(stepPower(0.4, 0, 0, 10)).toBe(0.4); // let go: stays
    expect(stepPower(0.9, 1, 0, 1)).toBe(1);
    expect(stepPower(0.1, 0, 1, 1)).toBe(0);
  });
  it('throttle is the square root of the power (thrust grows with the power)', () => {
    expect(throttleFor(0.25)).toBeCloseTo(0.5, 9);
    expect(throttleFor(1)).toBe(1);
    expect(throttleFor(-1)).toBe(0);
  });
});

describe('Controls', () => {
  it('maps the F310: left Y / right Y / LT / RT, X axes ignored', () => {
    const pad = fakePad();
    const c = new Controls(() => [pad], null);
    pad.axes[0] = 1; // left stick X: nothing
    pad.axes[2] = -1; // right stick X: nothing
    pad.axes[1] = 1; // left stick pulled back
    pad.axes[3] = -1; // right stick pushed forward
    pad.buttons[6].value = 1;
    pad.buttons[7].value = 0.26;
    const f = c.poll(1 / 60);
    expect(f.device).toBe('gamepad');
    expect(f.stickLeft).toBeCloseTo(1, 9);
    expect(f.stickRight).toBeCloseTo(-1, 9);
    expect(f.powerDown).toBe(1); // LT
    expect(f.powerUp).toBeCloseTo(0.245, 2); // RT
    expect(f.padName).toBe('Logitech Gamepad F310');
  });
  it('Start pauses on the press, once', () => {
    const pad = fakePad();
    const c = new Controls(() => [pad], null);
    pad.buttons[9].pressed = true;
    expect(c.poll(0.016).pause).toBe(true);
    expect(c.poll(0.016).pause).toBe(false);
    pad.buttons[9].pressed = false;
    expect(c.poll(0.016).pause).toBe(false);
  });
  it('keyboard: W/S and Up/Down ramp the sticks, Left Shift less power', () => {
    const target = new EventTarget();
    const c = new Controls(() => [], target);
    const key = (code: string, down: boolean) => {
      const e = new Event(down ? 'keydown' : 'keyup') as Event & { code: string; repeat: boolean };
      e.code = code;
      e.repeat = false;
      target.dispatchEvent(e);
    };
    key('KeyS', true);
    key('ArrowUp', true);
    key('ShiftLeft', true);
    let f = c.poll(0.1);
    expect(f.device).toBe('keyboard');
    expect(f.stickLeft).toBeGreaterThan(0.2);
    expect(f.stickRight).toBeLessThan(-0.2);
    for (let i = 0; i < 30; i++) f = c.poll(0.1);
    expect(f.stickLeft).toBe(1);
    expect(f.stickRight).toBe(-1);
    expect(f.powerDown).toBe(1);
    expect(f.powerUp).toBe(0);
    key('ShiftLeft', false);
    expect(c.poll(0.1).powerDown).toBe(0);
    key('KeyS', false);
    for (let i = 0; i < 5; i++) f = c.poll(0.1);
    expect(f.stickLeft).toBe(0);
  });
});

describe('settings', () => {
  it('roll settings: four, slowest first, and the old names read back as the new', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
    expect(Object.values(ROLL_RATE)).toEqual([1.05, 1.75, 2.6, 4.0]);
    expect(nextRoll('fighter')).toBe('glide');
    for (const [old, now] of [['gentle', 'cruise'], ['calm', 'sport'], ['sharp', 'fighter'], ['bogus', 'sport']]) {
      store.set('neon-flight.settings', JSON.stringify({ roll: old }));
      expect(loadSettings().roll).toBe(now);
    }
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});

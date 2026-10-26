import { describe, expect, it } from 'vitest';
import { Controls, shapeStick, shapeTrigger, throttleFor, type PadLike } from '../src/input/controls';

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
  it('throttle is the square root of the trigger (thrust grows with the trigger)', () => {
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
    expect(f.engineLeft).toBe(1);
    expect(f.engineRight).toBeCloseTo(0.245, 2);
    expect(f.throttleRight).toBeCloseTo(Math.sqrt(f.engineRight), 9);
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
  it('keyboard: W/S and Up/Down ramp the sticks, Shift the engines', () => {
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
    expect(f.engineLeft).toBe(1);
    expect(f.engineRight).toBe(0);
    key('KeyS', false);
    for (let i = 0; i < 5; i++) f = c.poll(0.1);
    expect(f.stickLeft).toBe(0);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input, KEY_BRAKE_GENTLE, KEY_BRAKE_SERVICE } from '../src/controls/input';

afterEach(() => vi.unstubAllGlobals());

describe('input on focus loss', () => {
  it('clears held steering, throttle and queued actions before resuming', () => {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    vi.stubGlobal('window', { addEventListener: (name: string, fn: (e: unknown) => void) => {
      const fns = listeners.get(name) ?? [];
      fns.push(fn);
      listeners.set(name, fns);
    } });
    vi.stubGlobal('navigator', { getGamepads: () => [] });
    const input = new Input();
    for (const code of ['KeyW', 'KeyA', 'ShiftLeft', 'KeyQ']) {
      for (const fn of listeners.get('keydown')!) fn({ code });
    }
    input.update(0.2);
    expect(input.state.throttle).toBeGreaterThan(0);
    expect(input.state.steer).toBeGreaterThan(0);
    for (const fn of listeners.get('blur')!) fn({});
    input.update(1 / 60);
    expect(input.state).toEqual({ throttle: 0, brake: 0, steer: 0, handbrake: false, precise: false, horn: false });
    expect(input.drainTaps()).toEqual([]);
  });
});

describe('keyboard pedal and steering shaping', () => {
  const setup = () => {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    vi.stubGlobal('window', { addEventListener: (name: string, fn: (e: unknown) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
    } });
    vi.stubGlobal('navigator', { getGamepads: () => [] });
    const input = new Input();
    const key = (code: string, down: boolean) => {
      for (const fn of listeners.get(down ? 'keydown' : 'keyup')!) fn({ code, preventDefault() {} });
    };
    const hold = (s: number, speed = 0) => {
      for (let t = 0; t < s; t += 1 / 60) input.update(1 / 60, { speed, steerLimit: 1 });
    };
    return { input, key, hold };
  };

  it('a held brake key settles at a smooth service level; Shift makes it gentler', () => {
    const { input, key, hold } = setup();
    key('KeyS', true);
    hold(1);
    expect(input.state.brake).toBeCloseTo(KEY_BRAKE_SERVICE, 2);
    key('ShiftLeft', true);
    hold(1);
    expect(input.state.brake).toBeCloseTo(KEY_BRAKE_GENTLE, 2);
  });

  it('double-tapping the brake key engages emergency braking until released', () => {
    const { input, key, hold } = setup();
    key('KeyS', true);
    hold(0.1);
    key('KeyS', false);
    hold(0.1);
    key('KeyS', true);
    hold(0.5);
    expect(input.emergencyBrake).toBe(true);
    expect(input.state.brake).toBeGreaterThan(0.95);
    key('KeyS', false);
    hold(0.5);
    expect(input.emergencyBrake).toBe(false);
    expect(input.state.brake).toBe(0);
  });

  it('a quick tap-tap to scrub speed stays a smooth brake', () => {
    const { input, key, hold } = setup();
    let peak = 0;
    for (let i = 0; i < 2; i++) {
      key('KeyS', true);
      for (let t = 0; t < 0.08; t += 1 / 60) {
        input.update(1 / 60, { speed: 14, steerLimit: 1 });
        peak = Math.max(peak, input.state.brake);
      }
      key('KeyS', false);
      hold(0.1, 14);
    }
    expect(peak).toBeLessThanOrEqual(KEY_BRAKE_SERVICE);
  });

  it('steering builds more slowly at speed', () => {
    const slow = setup();
    slow.key('KeyA', true);
    slow.hold(0.2, 2);
    const fast = setup();
    fast.key('KeyA', true);
    fast.hold(0.2, 28);
    expect(fast.input.state.steer).toBeLessThan(slow.input.state.steer * 0.6);
    expect(fast.input.steerHeld).toBe(true);
  });
});

describe('driving input toggling', () => {
  it('keeps a pause press that races the menu opening', () => {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    vi.stubGlobal('window', { addEventListener: (name: string, fn: (e: unknown) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
    } });
    vi.stubGlobal('navigator', { getGamepads: () => [] });
    const input = new Input();
    for (const code of ['KeyW', 'KeyQ', 'Escape']) for (const fn of listeners.get('keydown')!) fn({ code, preventDefault() {} });
    input.setEnabled(false);
    expect(input.drainTaps()).toEqual(['pause']);
    input.update(1 / 60);
    expect(input.state.throttle).toBe(0);
  });
});

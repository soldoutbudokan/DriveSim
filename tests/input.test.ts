import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../src/controls/input';

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

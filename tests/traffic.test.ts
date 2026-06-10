import { describe, expect, it } from 'vitest';
import { idm } from '../src/traffic/types';

describe('IDM car-following', () => {
  it('accelerates in free flow toward desired speed', () => {
    expect(idm(5, 14, null, 0)).toBeGreaterThan(0.5);
    expect(Math.abs(idm(14, 14, null, 0))).toBeLessThan(0.1);
  });

  it('brakes hard when closing fast on a slow leader', () => {
    const a = idm(14, 14, 12, 2);
    expect(a).toBeLessThan(-2);
  });

  it('settles to a comfortable gap behind a same-speed leader (simulated)', () => {
    // follower starts fast & close; integrate until steady state
    const leaderV = 12;
    let v = 16;
    let gap = 8;
    const dt = 0.05;
    for (let t = 0; t < 120; t += dt) {
      const a = idm(v, 14, gap, leaderV);
      v = Math.max(0, v + a * dt);
      gap += (leaderV - v) * dt;
    }
    // steady following at leader speed; equilibrium time-gap lands in the
    // 2-3 second band Ontario teaches (IDM with v0 slightly above leader)
    expect(Math.abs(v - leaderV)).toBeLessThan(0.4);
    const timeGap = gap / leaderV;
    expect(timeGap).toBeGreaterThan(1.5);
    expect(timeGap).toBeLessThan(3.0);
  });

  it('never commands more than emergency braking', () => {
    expect(idm(25, 25, 0.5, 0)).toBeGreaterThanOrEqual(-7);
  });
});

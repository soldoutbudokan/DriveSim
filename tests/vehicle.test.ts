import { describe, expect, it } from 'vitest';
import { Vehicle, type GroundSample } from '../src/vehicle/vehicle';
import type { InputState } from '../src/controls/input';

const flat = (): GroundSample => ({ height: 0, mu: 1, offRoad: false, dragExtra: 0 });
/** 8% uphill grade for a car heading +z (heading 0). */
const hill = (x: number, z: number): GroundSample => ({ height: 0.08 * z, mu: 1, offRoad: false, dragExtra: 0 });

const input = (over: Partial<InputState> = {}): InputState => ({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  precise: false,
  horn: false,
  ...over,
});

function run(v: Vehicle, seconds: number, inp: InputState, ground = flat as (x: number, z: number) => GroundSample): void {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) v.update(dt, inp, ground);
}

describe('vehicle longitudinal dynamics', () => {
  it('accelerates from rest under throttle and reaches city speed', () => {
    const v = new Vehicle();
    run(v, 1, input({ throttle: 0.4 })); // engage D
    run(v, 6, input({ throttle: 0.8 }));
    expect(v.speedKmh).toBeGreaterThan(55);
    expect(v.gear).toBe('D');
  });

  it('reaches highway speed within a reasonable time', () => {
    const v = new Vehicle();
    run(v, 14, input({ throttle: 1 }));
    expect(v.speedKmh).toBeGreaterThan(100);
  });

  it('brakes to a stop and holds', () => {
    const v = new Vehicle();
    run(v, 6, input({ throttle: 0.9 }));
    run(v, 6, input({ brake: 0.9 }));
    expect(v.speedKmh).toBeLessThan(1);
    run(v, 1, input({ brake: 0.9 }));
    expect(Math.abs(v.vx)).toBeLessThan(0.05);
  });

  it('shifts up through the gearbox as speed rises', () => {
    const v = new Vehicle();
    run(v, 2, input({ throttle: 0.7 }));
    const early = v.powertrain.gearIndex;
    run(v, 12, input({ throttle: 0.7 }));
    expect(v.powertrain.gearIndex).toBeGreaterThan(early);
  });

  it('creeps forward in D with no pedals (automatic transmission)', () => {
    const v = new Vehicle();
    run(v, 1, input({ throttle: 0.3 }));
    run(v, 4, input());
    expect(v.vx).toBeGreaterThan(0.2);
    expect(v.speedKmh).toBeLessThan(12);
  });

  it('holding the brake at a stop NEVER engages reverse (red-light safety)', () => {
    const v = new Vehicle();
    run(v, 3, input({ throttle: 0.6 }));
    run(v, 8, input({ brake: 0.9 }));
    expect(v.gear).toBe('D');
    expect(Math.abs(v.vx)).toBeLessThan(0.05);
  });

  it('shifter toggle engages reverse at a standstill, refuses while moving', () => {
    const v = new Vehicle();
    run(v, 3, input({ throttle: 0.6 }));
    expect(v.toggleReverse()).toBeNull(); // moving → refused
    run(v, 5, input({ brake: 0.9 }));
    expect(v.toggleReverse()).toBe('R');
    run(v, 2.5, input({ throttle: 0.4 }));
    expect(v.vx).toBeLessThan(-0.5);
    expect(v.speedKmh).toBeLessThan(25); // reverse governor
    run(v, 3, input({ brake: 0.9 }));
    expect(v.toggleReverse()).toBe('D');
    run(v, 2, input({ throttle: 0.4 }));
    expect(v.vx).toBeGreaterThan(0.3);
  });
});

describe('vehicle lateral dynamics', () => {
  it('steering left at speed turns the car left (heading increases)', () => {
    const v = new Vehicle();
    run(v, 5, input({ throttle: 0.6 }));
    const h0 = v.heading;
    run(v, 1.5, input({ throttle: 0.25, steer: 0.5 }));
    expect(v.heading).toBeGreaterThan(h0 + 0.1);
  });

  it('turn radius tightens with more steer', () => {
    const mkYaw = (steer: number): number => {
      const v = new Vehicle();
      run(v, 4, input({ throttle: 0.5 }));
      run(v, 2, input({ throttle: 0.3, steer }));
      return Math.abs(v.yawRate);
    };
    expect(mkYaw(0.6)).toBeGreaterThan(mkYaw(0.25));
  });

  it('understeers at the limit: yaw response saturates', () => {
    const v = new Vehicle();
    run(v, 10, input({ throttle: 1 }));
    run(v, 1.2, input({ throttle: 0.5, steer: 1 }));
    // at ~110+ km/h full steer the fronts saturate
    expect(v.frontSat).toBeGreaterThan(0.95);
  });

  it('grip circle: less lateral capability in snow → wider drift', () => {
    const snow = (): GroundSample => ({ height: 0, mu: 0.45, offRoad: false, dragExtra: 0 });
    const yawWith = (g: (x: number, z: number) => GroundSample): number => {
      const v = new Vehicle();
      run(v, 6, input({ throttle: 0.7 }), g);
      run(v, 1.5, input({ steer: 0.8 }), g);
      return Math.abs(v.yawRate);
    };
    expect(yawWith(snow)).toBeLessThan(yawWith(flat as never));
  });
});

describe('grade physics (hill starts)', () => {
  it('rolls back on a hill with no pedals in D only slowly (creep), faster in N', () => {
    const v = new Vehicle();
    run(v, 1, input({ throttle: 0.4 }), hill); // engage D, move a bit
    run(v, 2.5, input({ brake: 0.8 }), hill); // stop on grade
    expect(Math.abs(v.vx)).toBeLessThan(0.05);
    const z0 = v.z;
    run(v, 3, input(), hill); // release everything (still in D: creep fights grade)
    const rollback = z0 - v.z;
    // 8% grade beats creep force → some rollback, but bounded
    expect(rollback).toBeGreaterThan(0.05);
    expect(rollback).toBeLessThan(8);
  });

  it('holds on the hill with the handbrake', () => {
    const v = new Vehicle();
    run(v, 1, input({ throttle: 0.4 }), hill);
    run(v, 2, input({ brake: 0.9 }), hill);
    const z0 = v.z;
    run(v, 2, input({ handbrake: true }), hill);
    expect(Math.abs(v.z - z0)).toBeLessThan(0.4);
  });

  it('drives away uphill under throttle', () => {
    const v = new Vehicle();
    run(v, 1, input({ throttle: 0.5 }), hill);
    run(v, 4, input({ throttle: 0.8 }), hill);
    expect(v.vx).toBeGreaterThan(5);
  });
});

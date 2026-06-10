import { describe, expect, it } from 'vitest';
import { axleForces, magicFormula, peakSlipAngle } from '../src/vehicle/tires';
import { TRAINER_CAR } from '../src/vehicle/params';

const tire = TRAINER_CAR.tire;

describe('magic formula tire model', () => {
  it('rises, peaks, then falls off past the peak slip angle', () => {
    const peak = peakSlipAngle(tire);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(0.3);
    const atPeak = magicFormula(peak, tire.latB, tire.latC, tire.latE);
    const small = magicFormula(peak * 0.25, tire.latB, tire.latC, tire.latE);
    const beyond = magicFormula(peak * 3, tire.latB, tire.latC, tire.latE);
    expect(atPeak).toBeGreaterThan(small);
    expect(atPeak).toBeGreaterThan(beyond); // force drops past the peak = breakaway
    expect(atPeak).toBeGreaterThan(0.9);
  });

  it('is symmetric', () => {
    const f = magicFormula(0.1, tire.latB, tire.latC, tire.latE);
    const g = magicFormula(-0.1, tire.latB, tire.latC, tire.latE);
    expect(f).toBeCloseTo(-g, 10);
  });
});

describe('friction circle combining', () => {
  const fz = 6000;
  const mu = 1.0;

  it('positive slip angle drags the tire right (negative fy)', () => {
    const r = axleForces(0.08, 0, fz, mu, tire);
    expect(r.fy).toBeLessThan(0);
  });

  it('keeps combined force inside mu*Fz', () => {
    const r = axleForces(0.12, 9000, fz, mu, tire);
    expect(Math.hypot(r.fx, r.fy)).toBeLessThanOrEqual(mu * fz * 1.0001);
    expect(r.slipping).toBe(true);
  });

  it('longitudinal demand steals lateral grip (throttle-on understeer)', () => {
    const pure = axleForces(0.1, 0, fz, mu, tire);
    const combined = axleForces(0.1, 5500, fz, mu, tire);
    expect(Math.abs(combined.fy)).toBeLessThan(Math.abs(pure.fy));
  });

  it('less grip in the wet means smaller forces', () => {
    const dry = axleForces(0.1, 0, fz, 1.0, tire);
    const wet = axleForces(0.1, 0, fz, 0.7, tire);
    expect(Math.abs(wet.fy)).toBeLessThan(Math.abs(dry.fy));
  });
});

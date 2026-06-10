/**
 * Simplified Pacejka ("magic formula") tire model.
 *
 * Lateral force comes from slip angle through the magic formula; longitudinal
 * force is requested by the powertrain/brakes and the two are combined with a
 * friction-circle cap, which produces the classic behaviours: understeer when
 * the fronts saturate, oversteer / handbrake slides when the rears do, longer
 * stops and slithery steering in rain and snow.
 */

import type { TireParams } from './params';

/** Magic formula. slip in radians (lateral) or ratio (longitudinal); returns force in units of (mu*Fz). */
export function magicFormula(slip: number, B: number, C: number, E: number): number {
  const Bs = B * slip;
  return Math.sin(C * Math.atan(Bs - E * (Bs - Math.atan(Bs))));
}

export interface AxleForces {
  fx: number;
  fy: number;
  /** 0..1+, how saturated the friction circle is (1 = at the limit). */
  saturation: number;
  /** True when the requested longitudinal force exceeded available grip. */
  slipping: boolean;
}

/**
 * Combine lateral (from slip angle) and longitudinal (requested) tire forces
 * for one axle under load Fz with friction coefficient mu.
 *
 * @param slipAngle rad, positive = velocity points left of where the tire heads
 * @param fxRequest N, +forward
 * @param fz N normal load on the axle
 * @param mu effective friction (surface * weather)
 * @param lateralGripScale extra scale on lateral capability (handbrake/lockup washout)
 */
export function axleForces(
  slipAngle: number,
  fxRequest: number,
  fz: number,
  mu: number,
  tire: TireParams,
  lateralGripScale = 1,
): AxleForces {
  const cap = Math.max(0, mu * fz);
  if (cap < 1e-6) return { fx: 0, fy: 0, saturation: 1, slipping: true };

  // Positive slip angle (velocity to the LEFT of tire heading) drags the tire RIGHT (negative y).
  let fy = -cap * magicFormula(slipAngle, tire.latB, tire.latC, tire.latE) * lateralGripScale;
  let fx = fxRequest;

  const mag = Math.hypot(fx, fy);
  const saturation = mag / cap;
  let slipping = false;
  if (mag > cap) {
    // Friction circle: keep direction, clamp magnitude. Longitudinal demand
    // beyond grip steals lateral authority (throttle-on understeer, lockup slides).
    const k = cap / mag;
    fx *= k;
    fy *= k;
    slipping = Math.abs(fxRequest) > cap * 0.85;
  }
  return { fx, fy, saturation: Math.min(saturation, 2), slipping };
}

/** Peak slip angle (rad) for telemetry/coaching readouts. */
export function peakSlipAngle(tire: TireParams): number {
  // Numerically find peak of the magic formula once (cheap, called rarely).
  let bestA = 0;
  let bestF = 0;
  for (let a = 0; a < 0.5; a += 0.005) {
    const f = magicFormula(a, tire.latB, tire.latC, tire.latE);
    if (f > bestF) {
      bestF = f;
      bestA = a;
    }
  }
  return bestA;
}

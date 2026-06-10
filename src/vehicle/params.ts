/** Physical parameters for the trainer car — tuned to feel like a compact FWD sedan (think Corolla). */

export interface EnginePoint {
  rpm: number;
  torque: number; // Nm
}

export interface VehicleParams {
  mass: number; // kg
  inertiaZ: number; // kg·m² yaw inertia
  /** Distance CG -> front axle (m). */
  a: number;
  /** Distance CG -> rear axle (m). */
  b: number;
  cgHeight: number; // m
  wheelRadius: number; // m
  trackWidth: number; // m (visual + lateral load transfer)
  width: number; // m body width (collision)
  length: number; // m body length (collision)
  /** Maximum steer angle at standstill (rad). */
  maxSteer: number;
  /** Steering speed-sensitivity: max steer scales by 1/(1+v/steerSpeedRef). */
  steerSpeedRef: number;
  steerRate: number; // rad/s toward target
  dragCoeff: number; // 0.5*rho*Cd*A lumped (N per (m/s)^2)
  rollResist: number; // coefficient
  brakeForceMax: number; // N total at full pedal
  brakeBias: number; // fraction front
  handbrakeForce: number; // N at rear
  engineCurve: EnginePoint[];
  idleRpm: number;
  redlineRpm: number;
  gearRatios: number[]; // forward gears
  reverseRatio: number;
  finalDrive: number;
  driveline: 'fwd' | 'rwd';
  drivetrainEff: number;
  /** Torque converter multiplication at stall, decays to 1 by lockSpeed. */
  converterStallMult: number;
  converterLockSpeed: number; // m/s
  creepForce: number; // N at idle in D/R with no pedal
  shiftTimeS: number;
  tire: TireParams;
}

export interface TireParams {
  /** Lateral pacejka */
  latB: number;
  latC: number;
  latE: number;
  /** Longitudinal pacejka (used to shape force vs pseudo-slip) */
  longB: number;
  longC: number;
  /** Base friction coefficient on dry asphalt. */
  mu: number;
}

export const TRAINER_CAR: VehicleParams = {
  mass: 1380,
  inertiaZ: 2350,
  a: 1.12,
  b: 1.48,
  cgHeight: 0.52,
  wheelRadius: 0.31,
  trackWidth: 1.54,
  width: 1.78,
  length: 4.55,
  maxSteer: 0.58,
  steerSpeedRef: 15,
  steerRate: 3.0,
  dragCoeff: 0.42, // 0.5 * 1.2 * 0.30Cd * 2.2m² ≈ 0.40
  rollResist: 0.013,
  brakeForceMax: 14800, // ≈ 1.09 g before grip limits
  brakeBias: 0.62,
  handbrakeForce: 5200,
  engineCurve: [
    { rpm: 700, torque: 115 },
    { rpm: 1500, torque: 165 },
    { rpm: 2500, torque: 198 },
    { rpm: 4000, torque: 224 },
    { rpm: 5200, torque: 212 },
    { rpm: 6200, torque: 182 },
    { rpm: 6700, torque: 40 },
  ],
  idleRpm: 750,
  redlineRpm: 6500,
  gearRatios: [2.97, 1.95, 1.4, 1.03, 0.77],
  reverseRatio: 3.15,
  finalDrive: 3.61,
  driveline: 'fwd',
  drivetrainEff: 0.91,
  converterStallMult: 1.9,
  converterLockSpeed: 7,
  creepForce: 750,
  shiftTimeS: 0.34,
  tire: {
    latB: 8.6,
    latC: 1.34,
    latE: -0.2,
    longB: 11,
    longC: 1.65,
    mu: 1.02,
  },
};

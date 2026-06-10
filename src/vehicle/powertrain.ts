/**
 * Automatic transmission + engine model.
 *
 * Engine torque comes from a lookup curve; a simple torque-converter
 * approximation gives launch multiplication and creep; the shift logic uses
 * throttle-dependent up/down thresholds with a torque-cut shift delay, which
 * is what creates the audible/tachometer "shift feel".
 */

import { clamp, lerp } from '../core/math';
import type { VehicleParams } from './params';

export type GearMode = 'P' | 'R' | 'N' | 'D';

export class Powertrain {
  mode: GearMode = 'P';
  /** Current forward gear index, 0-based. */
  gearIndex = 0;
  rpm: number;
  /** >0 while a shift torque-cut is in progress. */
  private shiftTimer = 0;
  private shiftCooldown = 0;

  constructor(private p: VehicleParams) {
    this.rpm = p.idleRpm;
  }

  get gearLabel(): string {
    if (this.mode === 'D') return `D${this.gearIndex + 1}`;
    return this.mode;
  }

  get shifting(): boolean {
    return this.shiftTimer > 0;
  }

  engineTorqueAt(rpm: number): number {
    const c = this.p.engineCurve;
    if (rpm <= c[0].rpm) return c[0].torque;
    for (let i = 1; i < c.length; i++) {
      if (rpm <= c[i].rpm) {
        const t = (rpm - c[i - 1].rpm) / (c[i].rpm - c[i - 1].rpm);
        return lerp(c[i - 1].torque, c[i].torque, t);
      }
    }
    return c[c.length - 1].torque;
  }

  private wheelRpm(speed: number): number {
    return (Math.abs(speed) / this.p.wheelRadius) * (60 / (2 * Math.PI));
  }

  private ratioFor(mode: GearMode, gearIndex: number): number {
    if (mode === 'R') return this.p.reverseRatio;
    if (mode === 'D') return this.p.gearRatios[gearIndex];
    return 0;
  }

  /**
   * @param speed signed longitudinal speed m/s (forward positive)
   * @param throttle 0..1
   * @returns drive force at the wheels (signed; negative in reverse)
   */
  update(dt: number, speed: number, throttle: number): number {
    const p = this.p;
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);

    const ratio = this.ratioFor(this.mode, this.gearIndex) * p.finalDrive;
    const geared = this.wheelRpm(speed) * ratio;

    // Torque converter: engine can spin above the geared rpm at low speed.
    const targetRpm =
      this.mode === 'P' || this.mode === 'N'
        ? p.idleRpm + throttle * (p.redlineRpm - p.idleRpm) * 0.85
        : Math.max(p.idleRpm + throttle * 900, geared);
    this.rpm = clamp(this.rpm + (targetRpm - this.rpm) * Math.min(1, dt * 7), p.idleRpm * 0.9, p.redlineRpm);

    if (this.mode !== 'D' && this.mode !== 'R') return 0;

    // --- automatic shift logic (D only) -------------------------------
    if (this.mode === 'D' && this.shiftCooldown <= 0) {
      const upAt = 2400 + throttle * 3200; // rpm
      const downAt = 1250 + throttle * 1500;
      if (geared > upAt && this.gearIndex < p.gearRatios.length - 1) {
        this.gearIndex++;
        this.beginShift();
      } else if (geared < downAt && this.gearIndex > 0) {
        this.gearIndex--;
        this.beginShift();
      }
    }

    const speedAbs = Math.abs(speed);
    const converter = lerp(p.converterStallMult, 1, clamp(speedAbs / p.converterLockSpeed, 0, 1));
    const torqueCut = this.shiftTimer > 0 ? 0.15 : 1;
    const engineT = this.engineTorqueAt(this.rpm) * throttle * torqueCut;
    let force = (engineT * ratio * converter * p.drivetrainEff) / p.wheelRadius;

    // Idle creep: automatics crawl forward with no pedal input.
    if (throttle < 0.04 && speedAbs < 2.2) {
      force += p.creepForce * (1 - speedAbs / 2.5);
    }
    // Engine braking when off throttle at speed.
    if (throttle < 0.05 && speedAbs > 2.5) {
      force -= 18 * ratio * p.drivetrainEff / p.wheelRadius * Math.min(speedAbs, 12);
    }

    // Reverse governor: parking-speed reverse only (~20 km/h).
    if (this.mode === 'R') {
      force *= clamp(1 - (speedAbs - 4.2) / 1.6, 0, 1);
      return -force;
    }
    return force;
  }

  private beginShift(): void {
    this.shiftTimer = this.p.shiftTimeS;
    this.shiftCooldown = 0.9;
  }

  /** Driver gear selection — engine guards against selecting R/P while moving fast. */
  select(mode: GearMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'D') this.gearIndex = 0;
    this.shiftTimer = 0.15;
  }
}

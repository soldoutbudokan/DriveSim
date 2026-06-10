/**
 * Player vehicle dynamics.
 *
 * Dynamic single-track ("bicycle") model with:
 *  - Pacejka lateral tire forces per axle + friction-circle combining
 *  - longitudinal weight transfer feeding axle loads (brake dive grip effects)
 *  - torque-converter automatic powertrain with creep + engine braking
 *  - ABS brake-force limiting with a pulse, handbrake rear-grip washout
 *  - road grade forces (hill starts roll back for real)
 *  - kinematic blending below ~3.5 m/s so parking-speed handling stays sane
 *
 * Conventions: world axes +x east, +z south, y up. heading h gives
 * forward=(sin h, cos h); h increases turning LEFT; vy is +LEFT; yawRate +LEFT.
 */

import { clamp, clamp01, damp, headingForward, headingLeft, lerp, wrapAngle, type V2 } from '../core/math';
import type { InputState } from '../controls/input';
import { TRAINER_CAR, type VehicleParams } from './params';
import { axleForces } from './tires';
import { Powertrain, type GearMode } from './powertrain';

export interface GroundSample {
  height: number;
  /** Effective friction (surface × weather), e.g. dry asphalt ≈ 1.0, snow ≈ 0.45. */
  mu: number;
  offRoad: boolean;
  /** Extra rolling drag (N) for grass/gravel. */
  dragExtra: number;
}

export type GroundQuery = (x: number, z: number) => GroundSample;

export interface AssistSettings {
  abs: boolean;
  /** Traction control: trims drive force at the slip limit. */
  tc: boolean;
}

export interface VehiclePose {
  x: number;
  z: number;
  heading: number;
}

const SUBSTEP = 1 / 240;
const G = 9.81;

export class Vehicle {
  readonly p: VehicleParams;
  readonly powertrain: Powertrain;

  // --- pose & velocity ------------------------------------------------
  x = 0;
  z = 0;
  y = 0;
  heading = 0;
  /** Longitudinal body speed, m/s, +forward. */
  vx = 0;
  /** Lateral body speed, m/s, +left. */
  vy = 0;
  yawRate = 0;
  steer = 0; // current road-wheel angle, rad, +left

  // --- status flags / telemetry ----------------------------------------
  assists: AssistSettings = { abs: true, tc: false };
  handbrakeOn = false;
  absActive = false;
  wheelspin = false;
  /** Lateral saturation 0..1 of front / rear axles (for scrub audio + coaching). */
  frontSat = 0;
  rearSat = 0;
  offRoad = false;
  /** Smoothed body-frame accelerations (g) for HUD, camera and chassis roll. */
  gLong = 0;
  gLat = 0;
  odometer = 0;
  pitchSlope = 0; // sin of road grade along heading (+ = climbing)
  /** Set true for one frame when a collision impulse was applied. */
  hitThisFrame = false;
  lastImpact = 0;

  /** Effective pedals after R-mode remapping (S = reverse throttle in R). */
  accelPedal = 0;
  brakePedal = 0;

  private accum = 0;
  private axSmooth = 0;
  private absPhase = 0;
  private muHint = 1;

  constructor(params: VehicleParams = TRAINER_CAR) {
    this.p = params;
    this.powertrain = new Powertrain(params);
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }

  get speedKmh(): number {
    return Math.abs(this.vx) * 3.6;
  }

  get gear(): GearMode {
    return this.powertrain.mode;
  }

  get rpm(): number {
    return this.powertrain.rpm;
  }

  get pos(): V2 {
    return { x: this.x, z: this.z };
  }

  get forward(): V2 {
    return headingForward(this.heading);
  }

  /** Velocity in world frame. */
  get worldVel(): V2 {
    const f = headingForward(this.heading);
    const l = headingLeft(this.heading);
    return { x: f.x * this.vx + l.x * this.vy, z: f.z * this.vx + l.z * this.vy };
  }

  teleport(pose: VehiclePose): void {
    this.x = pose.x;
    this.z = pose.z;
    this.heading = pose.heading;
    this.vx = 0;
    this.vy = 0;
    this.yawRate = 0;
    this.steer = 0;
    this.axSmooth = 0;
    this.gLat = 0;
    this.gLong = 0;
    this.powertrain.select('P');
  }

  /** Rectangle corners on the ground plane (for collision / examiner checks). */
  corners(margin = 0): V2[] {
    const f = headingForward(this.heading);
    const l = headingLeft(this.heading);
    const hl = this.p.length / 2 + margin;
    const hw = this.p.width / 2 + margin;
    const c: V2[] = [];
    for (const [df, dl] of [
      [hl, hw],
      [hl, -hw],
      [-hl, -hw],
      [-hl, hw],
    ]) {
      c.push({ x: this.x + f.x * df + l.x * dl, z: this.z + f.z * df + l.z * dl });
    }
    return c;
  }

  /**
   * Apply a collision response: positional correction along `normal`
   * (unit, pointing AWAY from the obstacle) plus velocity reflection.
   * Returns impulse magnitude (m/s of velocity removed) for audio/fault scaling.
   */
  applyImpact(normal: V2, depth: number, restitution = 0.25, contactOffsetAlong = 0): number {
    this.x += normal.x * depth;
    this.z += normal.z * depth;
    const wv = this.worldVel;
    const vn = wv.x * normal.x + wv.z * normal.z;
    if (vn >= 0) return 0;
    const j = -(1 + restitution) * vn;
    const nvx = wv.x + normal.x * j;
    const nvz = wv.z + normal.z * j;
    const f = headingForward(this.heading);
    const l = headingLeft(this.heading);
    this.vx = nvx * f.x + nvz * f.z;
    this.vy = nvx * l.x + nvz * l.z;
    // glancing hits twist the car a little
    this.yawRate += clamp(contactOffsetAlong * j * 0.12, -1.2, 1.2);
    this.hitThisFrame = true;
    this.lastImpact = j;
    return j;
  }

  /**
   * Gear selection works like a real automatic:
   *  - X (engine calls toggleReverse) flips D ↔ R only at a standstill
   *  - W from Park/Neutral selects Drive
   *  - handbrake held at a standstill selects Park
   * Pedals never change roles: W accelerates in the selected gear, S brakes.
   */
  private updateGearIntent(input: InputState, dt: number): void {
    const pt = this.powertrain;
    const stopped = Math.abs(this.vx) < 0.35;

    if (this.handbrakeOn && stopped && input.throttle < 0.05) {
      if (pt.mode !== 'P') pt.select('P');
      return;
    }
    if (input.throttle > 0.06 && (pt.mode === 'P' || pt.mode === 'N')) pt.select('D');
  }

  /** Shifter input (X key / gamepad A). Returns the new mode, or null if refused (moving). */
  toggleReverse(): 'D' | 'R' | null {
    if (Math.abs(this.vx) > 0.6) return null;
    const next = this.powertrain.mode === 'R' ? 'D' : 'R';
    this.powertrain.select(next);
    return next;
  }

  private mapPedals(input: InputState): void {
    this.accelPedal = input.throttle;
    this.brakePedal = input.brake;
  }

  update(dt: number, input: InputState, ground: GroundQuery): void {
    this.hitThisFrame = false;
    this.handbrakeOn = input.handbrake;
    this.updateGearIntent(input, dt);
    this.mapPedals(input);

    // Steering: speed-sensitive authority + rate-limited motion toward target.
    const speedAbs = Math.abs(this.vx);
    const maxSteer = this.p.maxSteer / (1 + speedAbs / this.p.steerSpeedRef);
    const target = clamp(input.steer, -1, 1) * maxSteer;
    const rate = this.p.steerRate * (Math.abs(target) < Math.abs(this.steer) ? 1.7 : 1);
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);

    this.accum += Math.min(dt, 0.1);
    while (this.accum >= SUBSTEP) {
      this.substep(SUBSTEP, input, ground);
      this.accum -= SUBSTEP;
    }

    // ground height + grade for rendering & physics next frame
    const g = ground(this.x, this.z);
    this.y = g.height;
    this.offRoad = g.offRoad;
    this.muHint = g.mu;
  }

  private substep(dt: number, input: InputState, ground: GroundQuery): void {
    const p = this.p;
    const m = p.mass;
    const L = p.a + p.b;

    const fwd = headingForward(this.heading);
    const frontPos = { x: this.x + fwd.x * p.a, z: this.z + fwd.z * p.a };
    const rearPos = { x: this.x - fwd.x * p.b, z: this.z - fwd.z * p.b };
    const gF = ground(frontPos.x, frontPos.z);
    const gR = ground(rearPos.x, rearPos.z);
    const slopeSin = clamp((gF.height - gR.height) / L, -0.35, 0.35);
    this.pitchSlope = slopeSin;

    // --- axle normal loads with longitudinal weight transfer ----------
    let fzF = m * G * (p.b / L) - m * this.axSmooth * (p.cgHeight / L);
    let fzR = m * G * (p.a / L) + m * this.axSmooth * (p.cgHeight / L);
    fzF = Math.max(fzF, m * G * 0.12);
    fzR = Math.max(fzR, m * G * 0.12);

    // --- longitudinal force requests -----------------------------------
    let driveForce = this.powertrain.update(dt, this.vx, this.accelPedal);
    // Comfort governor (driving-school spec): cap launch force so a floored
    // start tops out around 0.38 g — brisk, but under the examiner's
    // harsh-acceleration line. Engine force at speed never reaches the cap.
    if (driveForce > 0) driveForce = Math.min(driveForce, m * 3.9);
    const movingSign = Math.abs(this.vx) > 0.05 ? Math.sign(this.vx) : 0;

    let brakeReqF = this.brakePedal * p.brakeForceMax * p.brakeBias;
    let brakeReqR = this.brakePedal * p.brakeForceMax * (1 - p.brakeBias);
    const hbForce = input.handbrake ? p.handbrakeForce : 0;

    // ABS: keep front brake demand inside the friction circle (with a pulse).
    this.absActive = false;
    if (this.assists.abs && movingSign !== 0 && Math.abs(this.vx) > 2) {
      this.absPhase += dt * 13 * Math.PI * 2;
      const capF = gF.mu * fzF;
      if (brakeReqF > capF * 0.95) {
        brakeReqF = capF * (0.88 + 0.07 * Math.sin(this.absPhase));
        this.absActive = true;
      }
      const capR = gR.mu * fzR;
      if (brakeReqR > capR * 0.9) brakeReqR = capR * 0.85;
    }

    // Brakes oppose motion; near standstill they act as a holding force.
    const stopped = Math.abs(this.vx) < 0.12;
    const brakeF = stopped ? 0 : -movingSign * brakeReqF;
    const brakeR = stopped ? 0 : -movingSign * (brakeReqR + hbForce);

    const fwdDrive = p.driveline === 'fwd' ? driveForce : 0;
    const rearDrive = p.driveline === 'fwd' ? 0 : driveForce;

    // --- slip angles ----------------------------------------------------
    const vxa = Math.max(Math.abs(this.vx), 0.5);
    const steerEff = this.vx >= 0 ? this.steer : -this.steer * 0.7;
    const alphaF = Math.atan2(this.vy + p.a * this.yawRate, vxa) - steerEff;
    const alphaR = Math.atan2(this.vy - p.b * this.yawRate, vxa);

    // Handbrake / lockup wash out lateral grip.
    const rearLatScale = input.handbrake ? 0.28 : 1;
    const fwdLockScale = !this.assists.abs && this.brakePedal > 0.9 ? 0.45 : 1;

    const F = axleForces(alphaF, fwdDrive + brakeF, fzF, gF.mu, p.tire, fwdLockScale);
    const R = axleForces(alphaR, rearDrive + brakeR, fzR, gR.mu, p.tire, rearLatScale);
    this.frontSat = F.saturation;
    this.rearSat = R.saturation;
    this.wheelspin = (p.driveline === 'fwd' ? F.slipping : R.slipping) && this.accelPedal > 0.4 && driveForce > 0;
    if (this.assists.tc && this.wheelspin) {
      // crude TC: re-run front axle with trimmed drive
      const F2 = axleForces(alphaF, fwdDrive * 0.6 + brakeF, fzF, gF.mu, p.tire, fwdLockScale);
      F.fx = F2.fx;
      F.fy = F2.fy;
    }

    // --- resistive forces ----------------------------------------------
    const fDrag = p.dragCoeff * this.vx * Math.abs(this.vx);
    const offRoadDrag = (gF.dragExtra + gR.dragExtra) / 2;
    const fRoll = (p.rollResist * m * G + offRoadDrag) * Math.tanh(this.vx / 0.4);
    const fGrade = m * G * slopeSin;

    // --- equations of motion --------------------------------------------
    const cos = Math.cos(this.steer);
    const sin = Math.sin(this.steer);
    const sumFx = R.fx + F.fx * cos - F.fy * sin - fDrag - fRoll - fGrade;
    const sumFy = R.fy + F.fy * cos + F.fx * sin;
    const yawMoment = p.a * (F.fy * cos + F.fx * sin) - p.b * R.fy;

    const axBody = sumFx / m;
    let dvx = (axBody + this.vy * this.yawRate) * dt;
    let dvy = (sumFy / m - this.vx * this.yawRate) * dt;
    let dw = (yawMoment / p.inertiaZ) * dt;

    let nvx = this.vx + dvx;
    let nvy = this.vy + dvy;
    let nw = this.yawRate + dw;

    // --- low-speed kinematic blend --------------------------------------
    const blend = clamp01(Math.abs(nvx) / 3.5);
    const wKin = (nvx * Math.tan(this.steer)) / L;
    const vyKin = wKin * p.b * 0.5;
    nw = lerp(wKin, nw, blend);
    nvy = lerp(vyKin, nvy, blend);

    // --- static hold (brakes/handbrake/park vs grade) --------------------
    const holding =
      (this.brakePedal > 0.15 ? brakeReqF + brakeReqR : 0) + (input.handbrake ? p.handbrakeForce : 0);
    const parked = this.powertrain.mode === 'P';
    if (Math.abs(nvx) < 0.15 && Math.abs(driveForce) < 900) {
      const external = Math.abs(fGrade);
      if (parked || holding > external) {
        nvx = 0;
        nvy = 0;
        nw *= 0.1;
      }
    }
    if (parked && Math.abs(nvx) < 0.6) {
      nvx = 0;
    }

    this.vx = nvx;
    this.vy = nvy;
    this.yawRate = nw;

    // --- integrate pose ---------------------------------------------------
    const f2 = headingForward(this.heading);
    const l2 = headingLeft(this.heading);
    this.x += (f2.x * this.vx + l2.x * this.vy) * dt;
    this.z += (f2.z * this.vx + l2.z * this.vy) * dt;
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    this.odometer += Math.abs(this.vx) * dt;

    // --- smoothed accelerations for transfer + HUD -----------------------
    this.axSmooth = damp(this.axSmooth, axBody, 5, dt);
    this.gLong = damp(this.gLong, axBody / G, 6, dt);
    this.gLat = damp(this.gLat, (sumFy / m) / G, 6, dt);
  }
}

/**
 * Camera rig: chase / cockpit / top-down, plus the observation glances that
 * are core pedagogy — shoulder (blind-spot) checks snap the view over the
 * shoulder, mirror checks glance at the rear-view. A free orbit mode is used
 * by replay.
 */

import * as THREE from 'three';
import { clamp, damp, dampAngle, headingForward, headingLeft, lerp } from '../core/math';
import type { CameraMode } from '../core/types';

export interface CamTargetState {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  vx: number;
  pitchSlope: number;
}

export type Glance = 'none' | 'shoulderLeft' | 'shoulderRight' | 'mirror';

const GLANCE_TIME = 0.85;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  reducedMotion = false;

  private glance: Glance = 'none';
  private glanceT = 0;
  private pos = new THREE.Vector3(0, 4, -8);
  private lookAt = new THREE.Vector3();
  private yawSmooth = 0;
  private fovSmooth = 62;
  private shake = 0;
  private freeMode = false;
  private freeYaw = 0.6;
  private freePitch = 0.45;
  private freeDist = 18;
  private dragging = false;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.1, 2400);
    this.camera.position.copy(this.pos);
  }

  cycleMode(): CameraMode {
    this.mode = this.mode === 'chase' ? 'top' : this.mode === 'top' ? 'cockpit' : 'chase';
    return this.mode;
  }

  setMode(m: CameraMode): void {
    this.mode = m;
  }

  toggleCockpit(): CameraMode {
    this.mode = this.mode === 'cockpit' ? 'chase' : 'cockpit';
    return this.mode;
  }

  /** Trigger a shoulder/mirror glance (returns its duration for scoring). */
  doGlance(g: Glance): number {
    this.glance = g;
    this.glanceT = GLANCE_TIME;
    return GLANCE_TIME;
  }

  get glanceActive(): Glance {
    return this.glanceT > 0 ? this.glance : 'none';
  }

  /** Enable free-orbit (replay) mode with pointer controls on the given element. */
  enableFreeOrbit(el: HTMLElement): () => void {
    this.freeMode = true;
    const down = (e: PointerEvent) => {
      this.dragging = true;
      el.setPointerCapture(e.pointerId);
    };
    const up = () => (this.dragging = false);
    const move = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.freeYaw -= e.movementX * 0.005;
      this.freePitch = clamp(this.freePitch + e.movementY * 0.004, 0.08, 1.45);
    };
    const wheelFn = (e: WheelEvent) => {
      this.freeDist = clamp(this.freeDist * (1 + e.deltaY * 0.001), 5, 220);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointermove', move);
    el.addEventListener('wheel', wheelFn, { passive: true });
    return () => {
      this.freeMode = false;
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('wheel', wheelFn);
    };
  }

  addShake(amount: number): void {
    this.shake = Math.min(this.shake + amount, 0.5);
  }

  update(dt: number, t: CamTargetState): void {
    this.glanceT = Math.max(0, this.glanceT - dt);
    this.shake = Math.max(0, this.shake - dt * 1.4);

    if (this.freeMode) {
      const cx = t.x + Math.sin(this.freeYaw) * Math.cos(this.freePitch) * this.freeDist;
      const cz = t.z + Math.cos(this.freeYaw) * Math.cos(this.freePitch) * this.freeDist;
      const cy = t.y + Math.sin(this.freePitch) * this.freeDist;
      this.camera.position.set(cx, cy, cz);
      this.camera.lookAt(t.x, t.y + 1, t.z);
      return;
    }

    const f = headingForward(t.heading);
    const l = headingLeft(t.heading);
    this.yawSmooth = dampAngle(this.yawSmooth, t.heading, this.mode === 'cockpit' ? 18 : 5.5, dt);
    const fs = headingForward(this.yawSmooth);

    // glance progression 0..1..0
    const gPhase = this.glanceT > 0 ? Math.min(1, (GLANCE_TIME - this.glanceT) / 0.14, this.glanceT / 0.18) : 0;

    if (this.mode === 'chase') {
      const dist = 7.4 + t.speed * 0.06;
      const height = 2.7 + t.speed * 0.012;
      let px = t.x - fs.x * dist;
      let pz = t.z - fs.z * dist;
      let py = t.y + height;
      let lx = t.x + f.x * 4;
      let lz = t.z + f.z * 4;
      let ly = t.y + 1.0;

      if (gPhase > 0) {
        // swing the camera to look over the shoulder / behind
        const side = this.glance === 'shoulderLeft' ? 1 : this.glance === 'shoulderRight' ? -1 : 0;
        if (this.glance === 'mirror') {
          // rear view: camera moves ahead of car looking back
          px = lerp(px, t.x + f.x * 8, gPhase);
          pz = lerp(pz, t.z + f.z * 8, gPhase);
          py = lerp(py, t.y + 2.2, gPhase);
          lx = lerp(lx, t.x - f.x * 6, gPhase);
          lz = lerp(lz, t.z - f.z * 6, gPhase);
        } else {
          px = lerp(px, t.x + f.x * 2.4 - l.x * side * 1.2, gPhase);
          pz = lerp(pz, t.z + f.z * 2.4 - l.z * side * 1.2, gPhase);
          py = lerp(py, t.y + 1.6, gPhase);
          lx = lerp(lx, t.x - f.x * 7 + l.x * side * 7, gPhase);
          lz = lerp(lz, t.z - f.z * 7 + l.z * side * 7, gPhase);
          ly = t.y + 1.2;
        }
      }

      const lam = 7;
      this.pos.x = damp(this.pos.x, px, lam, dt);
      this.pos.y = damp(this.pos.y, py, lam, dt);
      this.pos.z = damp(this.pos.z, pz, lam, dt);
      this.lookAt.set(
        damp(this.lookAt.x, lx, 10, dt),
        damp(this.lookAt.y, ly, 10, dt),
        damp(this.lookAt.z, lz, 10, dt),
      );
      this.camera.position.copy(this.pos);
      if (!this.reducedMotion && this.shake > 0) {
        this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.4;
        this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.3;
      }
      this.camera.lookAt(this.lookAt);
      const targetFov = 60 + clamp(t.speed - 14, 0, 18) * 0.55;
      this.fovSmooth = damp(this.fovSmooth, targetFov, 3, dt);
      this.camera.fov = this.fovSmooth;
      this.camera.updateProjectionMatrix();
    } else if (this.mode === 'cockpit') {
      // driver eye: left seat (Ontario), slightly behind windshield
      const eye = new THREE.Vector3(
        t.x + l.x * 0.37 + f.x * 0.3,
        t.y + 1.16,
        t.z + l.z * 0.37 + f.z * 0.3,
      );
      this.camera.position.copy(eye);
      let yaw = t.heading;
      let pitch = -Math.atan(t.pitchSlope) * 0.7;
      if (gPhase > 0) {
        if (this.glance === 'shoulderLeft') yaw += 2.4 * gPhase;
        else if (this.glance === 'shoulderRight') yaw -= 2.4 * gPhase;
        else if (this.glance === 'mirror') {
          yaw -= 0.18 * gPhase;
          pitch += 0.1 * gPhase;
        }
      }
      const look = new THREE.Vector3(
        eye.x + Math.sin(yaw) * Math.cos(pitch),
        eye.y + Math.sin(pitch),
        eye.z + Math.cos(yaw) * Math.cos(pitch),
      );
      this.camera.lookAt(look);
      this.camera.fov = 68;
      this.camera.updateProjectionMatrix();
    } else {
      // top-down, north-up
      const h = 86;
      this.pos.x = damp(this.pos.x, t.x, 8, dt);
      this.pos.z = damp(this.pos.z, t.z, 8, dt);
      this.camera.position.set(this.pos.x, t.y + h, this.pos.z);
      this.camera.up.set(0, 0, -1);
      this.camera.lookAt(this.pos.x, t.y, this.pos.z);
      this.camera.up.set(0, 1, 0);
      this.camera.fov = 55;
      this.camera.updateProjectionMatrix();
    }
  }
}

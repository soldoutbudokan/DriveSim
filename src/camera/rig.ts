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
  /** Yaw rate (rad/s, +left) — the chase camera looks into turns. */
  yawRate?: number;
}

export type Glance = 'none' | 'shoulderLeft' | 'shoulderRight' | 'mirror';

const GLANCE_TIME = 0.85;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  reducedMotion = false;
  /** Main-menu beauty shot: a slow orbit with the car framed right of centre. */
  showcase = false;

  private glance: Glance = 'none';
  private glanceT = 0;
  private pos = new THREE.Vector3(0, 4, -8);
  private lookAt = new THREE.Vector3();
  private yawSmooth = 0;
  private turnLook = 0;
  private fovSmooth = 62;
  private shake = 0;
  private freeMode = false;
  private freeYaw = 0.6;
  private freePitch = 0.45;
  private freeDist = 18;
  private dragging = false;
  private showcaseYaw = 2.4;
  private snapNext = false;
  private viewOffset = false;

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

  /** Jump straight to the chase position next frame (after a spawn/teleport). */
  snap(): void {
    this.snapNext = true;
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

    if (this.showcase) {
      this.showcaseYaw += dt * 0.09;
      const a = t.heading + this.showcaseYaw;
      this.pos.set(t.x + Math.sin(a) * 8.2, t.y + 2.1, t.z + Math.cos(a) * 8.2);
      this.lookAt.set(t.x, t.y + 0.75, t.z);
      this.yawSmooth = t.heading;
      this.camera.position.copy(this.pos);
      this.camera.lookAt(this.lookAt);
      this.camera.fov = 42;
      // shift the projection so the car sits in the right half, clear of the menu
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (w > 760) this.camera.setViewOffset(w, h, -w * 0.2, 0, w, h);
      else this.camera.clearViewOffset();
      this.viewOffset = true;
      this.camera.updateProjectionMatrix();
      return;
    }
    if (this.viewOffset) {
      this.viewOffset = false;
      this.camera.clearViewOffset();
    }

    const f = headingForward(t.heading);
    const l = headingLeft(t.heading);
    if (this.snapNext) this.yawSmooth = t.heading;
    this.yawSmooth = dampAngle(this.yawSmooth, t.heading, this.mode === 'cockpit' ? 18 : 6.5, dt);
    this.turnLook = damp(this.turnLook, clamp((t.yawRate ?? 0) * 0.45, -0.3, 0.3), 3, dt);
    const fs = headingForward(this.yawSmooth);

    // glance progression 0..1..0
    const gPhase = this.glanceT > 0 ? Math.min(1, (GLANCE_TIME - this.glanceT) / 0.14, this.glanceT / 0.18) : 0;

    if (this.mode === 'chase') {
      // Sit a little high and aim well down the road, so the car sits in
      // the lower third and lanes, signals and crossings ahead stay in view.
      const dist = 6.9 + t.speed * 0.05;
      const height = 3.05 + t.speed * 0.012;
      const ahead = 9 + t.speed * 0.3;
      const fl = headingForward(t.heading + this.turnLook);
      let px = t.x - fs.x * dist;
      let pz = t.z - fs.z * dist;
      let py = t.y + height;
      let lx = t.x + fl.x * ahead;
      let lz = t.z + fl.z * ahead;
      let ly = t.y + 1.15;

      // Shoulder checks swing the camera to look over that shoulder. Mirror
      // checks leave it alone — the rear-view inset already shows behind.
      if (gPhase > 0 && this.glance !== 'mirror') {
        const side = this.glance === 'shoulderLeft' ? 1 : -1;
        px = lerp(px, t.x + f.x * 2.4 - l.x * side * 1.2, gPhase);
        pz = lerp(pz, t.z + f.z * 2.4 - l.z * side * 1.2, gPhase);
        py = lerp(py, t.y + 1.6, gPhase);
        lx = lerp(lx, t.x - f.x * 7 + l.x * side * 7, gPhase);
        lz = lerp(lz, t.z - f.z * 7 + l.z * side * 7, gPhase);
        ly = t.y + 1.2;
      }

      if (this.snapNext) {
        this.snapNext = false;
        this.pos.set(px, py, pz);
        this.lookAt.set(lx, ly, lz);
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

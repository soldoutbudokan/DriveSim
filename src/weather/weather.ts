/**
 * Weather: clear / rain / fog / light snow. Each condition changes tire grip
 * (the coaching engine also tightens its thresholds), sight lines (scene fog),
 * ambient audio, and renders particles (rain streaks / drifting flakes)
 * recycled around the player.
 */

import * as THREE from 'three';
import { clamp01, damp, lerp } from '../core/math';
import type { WeatherKind } from '../core/types';

interface WeatherProfile {
  grip: number;
  fogNear: number;
  fogFar: number;
  rainAudio: number;
  particles: 'rain' | 'snow' | null;
  skyDim: number;
}

const PROFILES: Record<WeatherKind, WeatherProfile> = {
  clear: { grip: 1, fogNear: 250, fogFar: 1500, rainAudio: 0, particles: null, skyDim: 0 },
  rain: { grip: 0.74, fogNear: 150, fogFar: 800, rainAudio: 1, particles: 'rain', skyDim: 0.45 },
  fog: { grip: 0.95, fogNear: 18, fogFar: 150, rainAudio: 0, particles: null, skyDim: 0.3 },
  snow: { grip: 0.52, fogNear: 60, fogFar: 420, rainAudio: 0.25, particles: 'snow', skyDim: 0.35 },
};

const RAIN_COUNT = 1400;
const SNOW_COUNT = 1100;
const BOX = { w: 90, h: 40, d: 90 };

export class WeatherSystem {
  kind: WeatherKind = 'clear';
  /** 0..1 transition blend. */
  private blend = 1;
  private from: WeatherProfile = PROFILES.clear;
  private to: WeatherProfile = PROFILES.clear;

  gripMul = 1;
  rainLevel = 0;
  /** Extra dim factor applied to sun/sky by overcast. */
  skyDim = 0;

  private rain: THREE.Points;
  private snow: THREE.Points;
  private rainVel: Float32Array;
  private snowPhase: Float32Array;
  particleScale = 1;

  constructor(scene: THREE.Scene) {
    // rain: stretched sprites via small line-ish points
    const rainGeo = new THREE.BufferGeometry();
    const rp = new Float32Array(RAIN_COUNT * 3);
    this.rainVel = new Float32Array(RAIN_COUNT);
    for (let i = 0; i < RAIN_COUNT; i++) {
      rp[i * 3] = (Math.random() - 0.5) * BOX.w;
      rp[i * 3 + 1] = Math.random() * BOX.h;
      rp[i * 3 + 2] = (Math.random() - 0.5) * BOX.d;
      this.rainVel[i] = 22 + Math.random() * 10;
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.Points(
      rainGeo,
      new THREE.PointsMaterial({ color: 0x9fb6cc, size: 0.09, transparent: true, opacity: 0.0, depthWrite: false }),
    );
    this.rain.frustumCulled = false;
    scene.add(this.rain);

    const snowGeo = new THREE.BufferGeometry();
    const sp = new Float32Array(SNOW_COUNT * 3);
    this.snowPhase = new Float32Array(SNOW_COUNT);
    for (let i = 0; i < SNOW_COUNT; i++) {
      sp[i * 3] = (Math.random() - 0.5) * BOX.w;
      sp[i * 3 + 1] = Math.random() * BOX.h;
      sp[i * 3 + 2] = (Math.random() - 0.5) * BOX.d;
      this.snowPhase[i] = Math.random() * Math.PI * 2;
    }
    snowGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.snow = new THREE.Points(
      snowGeo,
      new THREE.PointsMaterial({ color: 0xeef4fa, size: 0.16, transparent: true, opacity: 0.0, depthWrite: false }),
    );
    this.snow.frustumCulled = false;
    scene.add(this.snow);
  }

  set(kind: WeatherKind): void {
    if (kind === this.kind) return;
    this.from = this.lerpedProfile();
    this.to = PROFILES[kind];
    this.kind = kind;
    this.blend = 0;
  }

  private lerpedProfile(): WeatherProfile {
    const t = this.blend;
    return {
      grip: lerp(this.from.grip, this.to.grip, t),
      fogNear: lerp(this.from.fogNear, this.to.fogNear, t),
      fogFar: lerp(this.from.fogFar, this.to.fogFar, t),
      rainAudio: lerp(this.from.rainAudio, this.to.rainAudio, t),
      particles: this.to.particles,
      skyDim: lerp(this.from.skyDim, this.to.skyDim, t),
    };
  }

  update(dt: number, scene: THREE.Scene, px: number, py: number, pz: number, vx: number, vz: number): void {
    this.blend = Math.min(1, this.blend + dt / 5);
    const p = this.lerpedProfile();
    this.gripMul = p.grip;
    this.rainLevel = p.rainAudio;
    this.skyDim = p.skyDim;

    const fog = scene.fog as THREE.Fog;
    fog.near = damp(fog.near, p.fogNear, 1.2, dt);
    fog.far = damp(fog.far, p.fogFar, 1.2, dt);

    // --- particles around the player ---------------------------------
    const rainOn = this.to.particles === 'rain' ? this.blend : this.from.particles === 'rain' ? 1 - this.blend : 0;
    const snowOn = this.to.particles === 'snow' ? this.blend : this.from.particles === 'snow' ? 1 - this.blend : 0;
    (this.rain.material as THREE.PointsMaterial).opacity = rainOn * 0.75;
    (this.snow.material as THREE.PointsMaterial).opacity = snowOn * 0.9;
    this.rain.visible = rainOn > 0.01;
    this.snow.visible = snowOn > 0.01;

    const activeRain = Math.floor(RAIN_COUNT * this.particleScale);
    if (this.rain.visible) {
      const pos = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < activeRain; i++) {
        arr[i * 3 + 1] -= this.rainVel[i] * dt;
        if (arr[i * 3 + 1] < py - 2) {
          arr[i * 3] = px + (Math.random() - 0.5) * BOX.w + vx * 1.2;
          arr[i * 3 + 1] = py + BOX.h * (0.7 + Math.random() * 0.3);
          arr[i * 3 + 2] = pz + (Math.random() - 0.5) * BOX.d + vz * 1.2;
        }
      }
      pos.needsUpdate = true;
    }
    const activeSnow = Math.floor(SNOW_COUNT * this.particleScale);
    if (this.snow.visible) {
      const pos = this.snow.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < activeSnow; i++) {
        this.snowPhase[i] += dt;
        arr[i * 3 + 1] -= (1.6 + Math.sin(this.snowPhase[i]) * 0.3) * dt * 2.2;
        arr[i * 3] += Math.sin(this.snowPhase[i] * 1.7) * dt * 1.2;
        if (arr[i * 3 + 1] < py - 2) {
          arr[i * 3] = px + (Math.random() - 0.5) * BOX.w + vx * 2;
          arr[i * 3 + 1] = py + BOX.h * (0.6 + Math.random() * 0.4);
          arr[i * 3 + 2] = pz + (Math.random() - 0.5) * BOX.d + vz * 2;
        }
      }
      pos.needsUpdate = true;
    }
  }

  /** Coaching context: following-gap & speed thresholds tighten in poor grip. */
  get severity(): number {
    return clamp01(1 - this.gripMul);
  }
}

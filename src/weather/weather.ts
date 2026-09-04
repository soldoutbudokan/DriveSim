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
  cloud: number;
  wet: number;
  snow: number;
}

const PROFILES: Record<WeatherKind, WeatherProfile> = {
  clear: { grip: 1, fogNear: 250, fogFar: 1500, rainAudio: 0, particles: null, skyDim: 0, cloud: 0.38, wet: 0, snow: 0 },
  rain: { grip: 0.74, fogNear: 150, fogFar: 800, rainAudio: 1, particles: 'rain', skyDim: 0.45, cloud: 0.96, wet: 1, snow: 0 },
  fog: { grip: 0.95, fogNear: 18, fogFar: 150, rainAudio: 0, particles: null, skyDim: 0.3, cloud: 0.85, wet: 0.35, snow: 0 },
  snow: { grip: 0.52, fogNear: 60, fogFar: 420, rainAudio: 0.25, particles: 'snow', skyDim: 0.35, cloud: 0.92, wet: 0.3, snow: 1 },
};

const RAIN_COUNT = 1800;

let flakeTex: THREE.CanvasTexture | null = null;
function flakeSprite(): THREE.CanvasTexture {
  if (flakeTex) return flakeTex;
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  flakeTex = new THREE.CanvasTexture(c);
  return flakeTex;
}
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
  /** Cloud cover 0..1 for the sky dome. */
  cloudCover = 0.38;
  /** Road sheen 0..1 and snow cover 0..1 for the world materials. */
  wetness = 0;
  snowCover = 0;

  private rain: THREE.LineSegments;
  private snow: THREE.Points;
  private rainVel: Float32Array;
  private snowPhase: Float32Array;
  particleScale = 1;

  constructor(scene: THREE.Scene) {
    // rain: short vertical streaks (line segments) falling through a box around the player
    const rainGeo = new THREE.BufferGeometry();
    const rp = new Float32Array(RAIN_COUNT * 6);
    this.rainVel = new Float32Array(RAIN_COUNT);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const x = (Math.random() - 0.5) * BOX.w;
      const y = Math.random() * BOX.h;
      const z = (Math.random() - 0.5) * BOX.d;
      rp[i * 6] = x;
      rp[i * 6 + 1] = y;
      rp[i * 6 + 2] = z;
      rp[i * 6 + 3] = x;
      rp[i * 6 + 4] = y + 0.45;
      rp[i * 6 + 5] = z;
      this.rainVel[i] = 22 + Math.random() * 10;
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xaebfd0, transparent: true, opacity: 0.0, depthWrite: false }));
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
      new THREE.PointsMaterial({ color: 0xf4f8fc, size: 0.22, map: flakeSprite(), transparent: true, opacity: 0.0, depthWrite: false, alphaTest: 0.05 }),
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
      cloud: lerp(this.from.cloud, this.to.cloud, t),
      wet: lerp(this.from.wet, this.to.wet, t),
      snow: lerp(this.from.snow, this.to.snow, t),
    };
  }

  update(dt: number, scene: THREE.Scene, px: number, py: number, pz: number, vx: number, vz: number): void {
    this.blend = Math.min(1, this.blend + dt / 5);
    const p = this.lerpedProfile();
    this.gripMul = p.grip;
    this.rainLevel = p.rainAudio;
    this.skyDim = p.skyDim;
    this.cloudCover = p.cloud;
    this.wetness = p.wet;
    this.snowCover = p.snow;

    const fog = scene.fog as THREE.Fog;
    fog.near = damp(fog.near, p.fogNear, 1.2, dt);
    fog.far = damp(fog.far, p.fogFar, 1.2, dt);

    // --- particles around the player ---------------------------------
    const rainOn = this.to.particles === 'rain' ? this.blend : this.from.particles === 'rain' ? 1 - this.blend : 0;
    const snowOn = this.to.particles === 'snow' ? this.blend : this.from.particles === 'snow' ? 1 - this.blend : 0;
    (this.rain.material as THREE.LineBasicMaterial).opacity = rainOn * 0.55;
    (this.snow.material as THREE.PointsMaterial).opacity = snowOn * 0.9;
    this.rain.visible = rainOn > 0.01;
    this.snow.visible = snowOn > 0.01;

    const activeRain = Math.floor(RAIN_COUNT * this.particleScale);
    this.rain.geometry.setDrawRange(0, activeRain * 2);
    if (this.rain.visible) {
      const pos = this.rain.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < activeRain; i++) {
        const fall = this.rainVel[i] * dt;
        arr[i * 6 + 1] -= fall;
        arr[i * 6 + 4] -= fall;
        if (arr[i * 6 + 1] < py - 2) {
          const x = px + (Math.random() - 0.5) * BOX.w + vx * 1.2;
          const y = py + BOX.h * (0.7 + Math.random() * 0.3);
          const z = pz + (Math.random() - 0.5) * BOX.d + vz * 1.2;
          arr[i * 6] = x;
          arr[i * 6 + 1] = y;
          arr[i * 6 + 2] = z;
          arr[i * 6 + 3] = x - vx * 0.02;
          arr[i * 6 + 4] = y + 0.45;
          arr[i * 6 + 5] = z - vz * 0.02;
        }
      }
      pos.clearUpdateRanges();
      pos.addUpdateRange(0, activeRain * 6);
      pos.needsUpdate = true;
    }
    const activeSnow = Math.floor(SNOW_COUNT * this.particleScale);
    this.snow.geometry.setDrawRange(0, activeSnow);
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
      pos.clearUpdateRanges();
      pos.addUpdateRange(0, activeSnow * 3);
      pos.needsUpdate = true;
    }
  }

  /** Coaching context: following-gap & speed thresholds tighten in poor grip. */
  get severity(): number {
    return clamp01(1 - this.gripMul);
  }
}

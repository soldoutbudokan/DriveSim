/**
 * Day/night cycle: sun/moon position + intensity, sky/fog colour palettes,
 * hemisphere light, and the night factor that drives streetlights, building
 * windows and auto-headlights.
 */

import * as THREE from 'three';
import { clamp01, lerp, TAU } from '../core/math';

interface Palette {
  sky: THREE.Color;
  fog: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
}

const P = (sky: number, fog: number, sun: number, si: number, hs: number, hg: number, hi: number): Palette => ({
  sky: new THREE.Color(sky),
  fog: new THREE.Color(fog),
  sunColor: new THREE.Color(sun),
  sunIntensity: si,
  hemiSky: new THREE.Color(hs),
  hemiGround: new THREE.Color(hg),
  hemiIntensity: hi,
});

// keyed by hour
const KEYS: Array<{ h: number; p: Palette }> = [
  { h: 0, p: P(0x0a0e1a, 0x0a0e18, 0x223355, 0.0, 0x141c30, 0x0c0f16, 0.22) },
  { h: 5, p: P(0x131a2e, 0x141a28, 0x554466, 0.0, 0x1d2638, 0x12141c, 0.3) },
  { h: 6.5, p: P(0x9c7d8a, 0xb08a86, 0xffb070, 1.4, 0x8a7d96, 0x4a4544, 0.55) },
  { h: 9, p: P(0x8fb8e8, 0xbcd0e6, 0xfff0d8, 2.6, 0xbfd6ff, 0x55624f, 0.8) },
  { h: 13, p: P(0x9fc3ef, 0xc6d8ea, 0xffefdc, 3.0, 0xcfe0ff, 0x5d6a55, 0.9) },
  { h: 17.5, p: P(0x92aed6, 0xc2c4d2, 0xffe2b8, 2.2, 0xb8c8ea, 0x575f4e, 0.8) },
  { h: 19.5, p: P(0x6a5a78, 0x8a6a70, 0xff9a55, 1.0, 0x6a6a8a, 0x3a3633, 0.5) },
  { h: 21, p: P(0x16203a, 0x182030, 0x445577, 0.05, 0x222d44, 0x14161e, 0.3) },
  { h: 24, p: P(0x0a0e1a, 0x0a0e18, 0x223355, 0.0, 0x141c30, 0x0c0f16, 0.22) },
];

export class SkySystem {
  /** Hour of day 0..24. */
  hour = 13.5;
  /** Sim-hours advanced per real second when cycling (0 = fixed). */
  cycleSpeed = 0;
  nightFactor = 0;

  private current: Palette = KEYS[4].p;
  private tmp = {
    sky: new THREE.Color(),
    fog: new THREE.Color(),
    sun: new THREE.Color(),
    hs: new THREE.Color(),
    hg: new THREE.Color(),
  };

  setPreset(preset: 'day' | 'dusk' | 'night' | 'dawn' | 'cycle'): void {
    this.cycleSpeed = 0;
    switch (preset) {
      case 'day': this.hour = 13.5; break;
      case 'dusk': this.hour = 19.2; break;
      case 'night': this.hour = 22.5; break;
      case 'dawn': this.hour = 6.6; break;
      case 'cycle':
        this.hour = 10;
        this.cycleSpeed = 24 / (60 * 14); // full day in ~14 minutes
        break;
    }
  }

  private paletteAt(h: number): void {
    let a = KEYS[0];
    let b = KEYS[KEYS.length - 1];
    for (let i = 0; i < KEYS.length - 1; i++) {
      if (h >= KEYS[i].h && h <= KEYS[i + 1].h) {
        a = KEYS[i];
        b = KEYS[i + 1];
        break;
      }
    }
    const t = b.h === a.h ? 0 : (h - a.h) / (b.h - a.h);
    this.tmp.sky.lerpColors(a.p.sky, b.p.sky, t);
    this.tmp.fog.lerpColors(a.p.fog, b.p.fog, t);
    this.tmp.sun.lerpColors(a.p.sunColor, b.p.sunColor, t);
    this.tmp.hs.lerpColors(a.p.hemiSky, b.p.hemiSky, t);
    this.tmp.hg.lerpColors(a.p.hemiGround, b.p.hemiGround, t);
    this.current = {
      sky: this.tmp.sky,
      fog: this.tmp.fog,
      sunColor: this.tmp.sun,
      sunIntensity: lerp(a.p.sunIntensity, b.p.sunIntensity, t),
      hemiSky: this.tmp.hs,
      hemiGround: this.tmp.hg,
      hemiIntensity: lerp(a.p.hemiIntensity, b.p.hemiIntensity, t),
    };
  }

  update(
    dt: number,
    scene: THREE.Scene,
    sun: THREE.DirectionalLight,
    moon: THREE.DirectionalLight,
    hemi: THREE.HemisphereLight,
    playerX: number,
    playerZ: number,
  ): void {
    this.hour = (this.hour + this.cycleSpeed * dt) % 24;
    this.paletteAt(this.hour);
    const p = this.current;

    // sun path: angle over the day; elevation peaks at 13:00
    const dayPhase = ((this.hour - 6.5) / 13) * Math.PI; // 0 at sunrise, π at sunset
    const elev = Math.sin(Math.max(0.03, Math.min(Math.PI - 0.03, dayPhase)));
    const azim = (this.hour / 24) * TAU + Math.PI * 0.5;
    const r = 240;
    sun.position.set(
      playerX + Math.cos(azim) * r * (1 - elev * 0.4),
      40 + elev * 260,
      playerZ + Math.sin(azim) * r * (1 - elev * 0.4),
    );
    sun.color.copy(p.sunColor);
    sun.intensity = p.sunIntensity;
    sun.castShadow = p.sunIntensity > 0.15;

    this.nightFactor = clamp01(1 - p.sunIntensity / 1.2);
    moon.intensity = this.nightFactor * 0.32;
    moon.position.set(playerX - 120, 200, playerZ - 80);
    moon.target.position.set(playerX, 0, playerZ);

    hemi.color.copy(p.hemiSky);
    hemi.groundColor.copy(p.hemiGround);
    hemi.intensity = p.hemiIntensity;

    (scene.background as THREE.Color).copy(p.sky);
    if (scene.fog) scene.fog.color.copy(p.fog);
  }
}

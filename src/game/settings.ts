/** User settings model + (light) persistence. Profiles store these per-user. */

import type { WeatherKind } from '../core/types';
import type { Tier } from '../core/quality';

export type TimePreset = 'day' | 'dusk' | 'night' | 'dawn' | 'cycle';

export interface Settings {
  tier: Tier | 'auto';
  audio: { master: number; engine: number; effects: number; ambient: number };
  steerSensitivity: number;
  invertSteer: boolean;
  assists: { abs: boolean; tc: boolean };
  autoHeadlights: boolean;
  reducedMotion: boolean;
  trafficDensity: number;
  weather: WeatherKind;
  time: TimePreset;
  emergencyEvents: boolean;
  carColor: number;
  uiScale: number;
}

export const CAR_COLORS: Array<{ name: string; value: number }> = [
  { name: 'Lake Blue', value: 0x2f6fce },
  { name: 'Stealth Grey', value: 0x4a5058 },
  { name: 'Cherry Red', value: 0xb8252e },
  { name: 'Forest Green', value: 0x2e5d3f },
  { name: 'Polar White', value: 0xe6e9ec },
  { name: 'Midnight Black', value: 0x16181d },
  { name: 'Sunset Orange', value: 0xd96c2a },
];

export function defaultSettings(): Settings {
  return {
    tier: 'auto',
    audio: { master: 0.8, engine: 0.8, effects: 0.9, ambient: 0.6 },
    steerSensitivity: 1,
    invertSteer: false,
    assists: { abs: true, tc: false },
    autoHeadlights: true,
    reducedMotion: false,
    trafficDensity: 1,
    weather: 'clear',
    time: 'day',
    emergencyEvents: true,
    carColor: CAR_COLORS[0].value,
    uiScale: 1,
  };
}

const KEY = 'drivesim.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* fresh */
  }
  return defaultSettings();
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

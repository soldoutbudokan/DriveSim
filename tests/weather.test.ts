import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WeatherSystem } from '../src/weather/weather';
import { TIERS, TIER_ORDER } from '../src/core/quality';

afterEach(() => vi.unstubAllGlobals());

describe('weather particle budgets', () => {
  it('draws and uploads only active particles across quality changes without changing grip', () => {
    vi.stubGlobal('document', { createElement: () => ({
      getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }),
    }) });
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xffffff, 1, 1000);
    const weather = new WeatherSystem(scene);
    const rain = scene.children.find(o => o instanceof THREE.LineSegments) as THREE.LineSegments;
    const snow = scene.children.find(o => o instanceof THREE.Points) as THREE.Points;
    for (const tier of [...TIER_ORDER, 'low', 'high'] as const) {
      weather.particleScale = TIERS[tier].particleScale;
      weather.set('rain');
      weather.update(5, scene, 0, 0, 0, 0, 0);
      const rainCount = Math.floor(1800 * TIERS[tier].particleScale);
      expect(rain.geometry.drawRange.count).toBe(rainCount * 2);
      expect((rain.geometry.getAttribute('position') as THREE.BufferAttribute).updateRanges).toEqual([{ start: 0, count: rainCount * 6 }]);
      expect(weather.gripMul).toBeCloseTo(0.74);
      weather.set('snow');
      weather.update(5, scene, 0, 0, 0, 0, 0);
      const snowCount = Math.floor(1100 * TIERS[tier].particleScale);
      expect(snow.geometry.drawRange.count).toBe(snowCount);
      expect((snow.geometry.getAttribute('position') as THREE.BufferAttribute).updateRanges).toEqual([{ start: 0, count: snowCount * 3 }]);
      expect(weather.gripMul).toBeCloseTo(0.52);
    }
    weather.set('clear');
    weather.update(5, scene, 0, 0, 0, 0, 0);
    expect(rain.visible).toBe(false);
    expect(snow.visible).toBe(false);
  });
});

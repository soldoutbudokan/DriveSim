import { describe, expect, it } from 'vitest';
import { AutoQuality, renderPixelRatio, TIERS, TIER_ORDER } from '../src/core/quality';

describe('laptop graphics budgets', () => {
  it('starts auto without bloom and drops under sustained load', () => {
    const quality = new AutoQuality();
    expect(quality.current).toBe('medium');
    expect(TIERS[quality.current].bloom).toBe(false);
    expect(quality.evaluate(2, 25)).toBeNull();
    expect(quality.evaluate(1, 25)).toBe('low');
    expect(quality.evaluate(30, 10)).toBeNull();
  });

  it('only climbs after sustained headroom and never selects ultra', () => {
    const quality = new AutoQuality();
    quality.evaluate(3, 20);
    for (let i = 0; i < 12; i++) quality.evaluate(1, 60);
    expect(quality.current).toBe('low');
    quality.evaluate(1, 45); // reset the consecutive headroom timer
    for (let i = 0; i < 15; i++) quality.evaluate(1, 60);
    expect(quality.current).toBe('medium');
    for (let i = 0; i < 40; i++) quality.evaluate(1, 60);
    expect(quality.current).toBe('high');
  });

  it('resets timing on tab resume and respects manual mode', () => {
    const quality = new AutoQuality();
    quality.evaluate(2, 20);
    quality.reset();
    expect(quality.evaluate(1, 20)).toBeNull();
    quality.enabled = false;
    expect(quality.evaluate(30, 10)).toBeNull();
    expect(quality.current).toBe('medium');
  });

  it('bounds actual pixels on 1080p, Retina and 4K screens', () => {
    for (const [width, height, dpr] of [[1920, 1080, 1], [1512, 982, 2], [3840, 2160, 2]]) {
      for (const tier of TIER_ORDER) {
        const ratio = renderPixelRatio(tier, width, height, dpr);
        expect(width * height * ratio ** 2).toBeLessThanOrEqual(TIERS[tier].maxPixels + 0.001);
        expect(ratio).toBeLessThanOrEqual(dpr);
        expect(ratio).toBeLessThanOrEqual(TIERS[tier].pixelRatioCap);
      }
    }
    expect(renderPixelRatio('low', 3840, 2160, 1)).toBeCloseTo(1 / 3);
    expect(renderPixelRatio('low', 640, 360, 1)).toBe(1);
  });
});

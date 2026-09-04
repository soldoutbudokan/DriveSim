/** Graphics quality tiers + auto-detection targeting 60 fps. */

export type Tier = 'low' | 'medium' | 'high' | 'ultra';

export interface TierConfig {
  pixelRatioCap: number;
  shadowMap: number; // 0 = off
  bloom: boolean;
  particleScale: number;
  antialias: boolean;
  /** Maximum drawing-buffer area, independent of monitor resolution. */
  maxPixels: number;
}

export const TIERS: Record<Tier, TierConfig> = {
  low: { pixelRatioCap: 1, maxPixels: 1280 * 720, shadowMap: 0, bloom: false, particleScale: 0.35, antialias: false },
  medium: { pixelRatioCap: 1.25, maxPixels: 1600 * 900, shadowMap: 1024, bloom: false, particleScale: 0.7, antialias: true },
  high: { pixelRatioCap: 1.75, maxPixels: 2560 * 1440, shadowMap: 2048, bloom: true, particleScale: 1, antialias: true },
  ultra: { pixelRatioCap: 2, maxPixels: 3840 * 2160, shadowMap: 4096, bloom: true, particleScale: 1, antialias: true },
};

export function renderPixelRatio(tier: Tier, width: number, height: number, dpr: number): number {
  const cfg = TIERS[tier];
  return Math.min(dpr, cfg.pixelRatioCap, Math.sqrt(cfg.maxPixels / Math.max(1, width * height)));
}

export const TIER_ORDER: Tier[] = ['low', 'medium', 'high', 'ultra'];

/** Auto-tier state machine: drops fast under load, climbs slowly when steady. */
export class AutoQuality {
  enabled = true;
  current: Tier = 'medium';
  private timer = 0;
  private stableTime = 0;

  reset(): void {
    this.timer = 0;
    this.stableTime = 0;
  }

  /** Returns the new tier when a change should be applied. */
  evaluate(dt: number, fps: number): Tier | null {
    if (!this.enabled) return null;
    this.timer += dt;
    if (this.timer < 3) return null; // warmup / between checks
    const idx = TIER_ORDER.indexOf(this.current);
    if (fps < 42 && idx > 0) {
      this.current = TIER_ORDER[idx - 1];
      this.timer = 0;
      this.stableTime = 0;
      return this.current;
    }
    if (fps > 57) {
      this.stableTime += dt;
      if (this.stableTime > 14 && idx < TIER_ORDER.length - 2) {
        // climb at most to 'high' automatically; ultra is opt-in
        this.current = TIER_ORDER[idx + 1];
        this.timer = 0;
        this.stableTime = 0;
        return this.current;
      }
    } else {
      this.stableTime = 0;
    }
    return null;
  }
}

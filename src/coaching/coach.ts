/**
 * Coach: runs the rule set over the per-frame DriveContext, manages per-code
 * cooldowns so feedback never nags, maintains the fault log + observation
 * score, and routes output as live toasts (free roam / lessons) or silent
 * logging (examiner mode — real examiners don't coach).
 */

import type { Engine } from '../core/engine';
import type { CityWorld } from '../world/world';
import type { TrafficManager } from '../traffic/manager';
import type { Fault, RubricCategory, Severity } from '../core/types';
import { ContextTracker, type DriveContext } from './context';
import { buildRules, type Rule, type RuleSink } from './rules';

const COACH_COOLDOWN = 9;
const FAULT_COOLDOWN = 6;

export class Coach implements RuleSink {
  readonly tracker: ContextTracker;
  private rules: Rule[] = buildRules();
  faults: Fault[] = [];
  /** Live coaching toasts on/off (off in examiner mode). */
  liveCoaching = true;
  /** Fault sounds/toasts visible (kept for lessons; exam logs silently). */
  showFaults = true;
  /** 0..100 rolling observation score (mirror cadence + checks). */
  observationScore = 100;

  private coachCooldowns = new Map<string, number>();
  private faultCooldowns = new Map<string, number>();
  private lastCtx: DriveContext | null = null;
  private mirrorCredit = 0;

  constructor(
    private engine: Engine,
    private world: CityWorld,
    private traffic: TrafficManager,
  ) {
    this.tracker = new ContextTracker(engine, world, traffic);
  }

  reset(): void {
    this.faults = [];
    this.tracker.reset();
    this.rules = buildRules();
    this.coachCooldowns.clear();
    this.faultCooldowns.clear();
    this.observationScore = 100;
  }

  get context(): DriveContext | null {
    return this.lastCtx;
  }

  fault(code: string, category: RubricCategory, severity: Severity, message: string, ctx: DriveContext): void {
    const until = this.faultCooldowns.get(code) ?? -99;
    if (ctx.time < until) return;
    this.faultCooldowns.set(code, ctx.time + FAULT_COOLDOWN);
    const fault: Fault = { code, category, severity, message, time: ctx.time, x: ctx.x, z: ctx.z };
    this.faults.push(fault);
    this.engine.events.emit('fault', fault);
    this.engine.minimap?.addHeat(
      ctx.x,
      ctx.z,
      severity === 'minor' ? 'rgba(255,181,71,0.5)' : 'rgba(255,80,60,0.55)',
      severity === 'minor' ? 4 : 6,
    );
    if (category === 'observation') this.observationScore = Math.max(0, this.observationScore - 9);
    if (this.showFaults) {
      const label = severity === 'minor' ? '' : severity === 'major' ? ' (major)' : severity === 'dangerous' ? ' (dangerous)' : ' (automatic fail)';
      this.engine.hud.toast(`✗ ${message}${label}`, severity === 'minor' ? 'warn' : 'warn');
      this.engine.audio.ui(severity === 'minor' ? 'warn' : 'fail');
    }
  }

  coach(text: string, kind: 'info' | 'warn' | 'good' = 'info'): void {
    if (!this.liveCoaching || !this.lastCtx) return;
    const until = this.coachCooldowns.get(text) ?? -99;
    if (this.lastCtx.time < until) return;
    this.coachCooldowns.set(text, this.lastCtx.time + COACH_COOLDOWN);
    this.engine.events.emit('coach', { kind, text, time: this.lastCtx.time });
    this.engine.hud.toast(text, kind);
    if (kind === 'good') this.engine.audio.ui('good');
  }

  update(dt: number): void {
    const ctx = this.tracker.build(dt);
    this.lastCtx = ctx;
    for (const rule of this.rules) rule.update(ctx, this);

    // observation score slowly recovers; regular mirror checks feed it
    this.mirrorCredit += dt;
    if (ctx.time - ctx.lastMirror < 0.3 && this.mirrorCredit > 4) {
      this.observationScore = Math.min(100, this.observationScore + 3);
      this.mirrorCredit = 0;
    }
    if (ctx.speedMs > 3 && ctx.time - ctx.lastMirror > 15) {
      this.observationScore = Math.max(0, this.observationScore - dt * 0.7);
    }
  }

  /** Summary counts by severity (for HUD/report). */
  summary(): { minor: number; major: number; dangerous: number; autofail: number } {
    const s = { minor: 0, major: 0, dangerous: 0, autofail: 0 };
    for (const f of this.faults) s[f.severity]++;
    return s;
  }
}

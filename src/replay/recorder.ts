/**
 * Drive recorder: samples the player (20 Hz) + nearby road users, telemetry
 * series (5 Hz) and observation counters during free roam / lessons / exams,
 * then packs + stores the drive in IndexedDB for replay and the dashboard.
 */

import type { GameApp } from '../game/app';
import { AGENT_KINDS, FLAG, pack, type RecFrame, type ReplayPayload } from './format';
import { saveReplay, type StoredReplayMeta } from '../persistence/store';

const FRAME_HZ = 20;
const SERIES_HZ = 5;
const MAX_SECONDS = 35 * 60;
const AGENT_RADIUS = 260;

const KIND_INDEX = new Map<string, number>(AGENT_KINDS.map((k, i) => [k, i]));

export class Recorder {
  private app: GameApp;
  recording = false;
  private mode = 'free';
  private t0 = 0;
  private frames: RecFrame[] = [];
  private series: number[] = [];
  private frameAcc = 0;
  private seriesAcc = 0;
  private counters = { laneChanges: 0, mirrorChecks: 0, shoulderChecks: 0, merges: 0 };
  private lastMirror = -99;
  private lastShoulder = -99;

  constructor(app: GameApp) {
    this.app = app;
  }

  begin(mode: string): void {
    this.recording = true;
    this.mode = mode;
    this.t0 = this.app.engine.simTime;
    this.frames = [];
    this.series = [];
    this.frameAcc = 99; // capture immediately
    this.seriesAcc = 99;
    this.counters = { laneChanges: 0, mirrorChecks: 0, shoulderChecks: 0, merges: 0 };
  }

  /** Called every app tick while a drive mode is active. */
  tick(dt: number): void {
    if (!this.recording) return;
    const app = this.app;
    const e = app.engine;
    const ctx = app.coach.context;
    const t = e.simTime - this.t0;
    if (t > MAX_SECONDS) return;

    if (ctx) {
      if (ctx.laneChanged) this.counters.laneChanges++;
      if (ctx.merged) this.counters.merges++;
      if (ctx.lastMirror !== this.lastMirror) {
        this.lastMirror = ctx.lastMirror;
        this.counters.mirrorChecks++;
      }
      const sh = Math.max(ctx.lastShoulderLeft, ctx.lastShoulderRight);
      if (sh !== this.lastShoulder) {
        this.lastShoulder = sh;
        this.counters.shoulderChecks++;
      }
    }

    this.frameAcc += dt;
    if (this.frameAcc >= 1 / FRAME_HZ) {
      this.frameAcc = 0;
      const v = e.vehicle;
      let flags = 0;
      if (e.signal === 'left' || e.hazards) flags |= FLAG.sigL;
      if (e.signal === 'right' || e.hazards) flags |= FLAG.sigR;
      if (v.brakePedal > 0.05 || v.handbrakeOn) flags |= FLAG.brake;
      if (e.headlights) flags |= FLAG.headlights;
      if (v.gear === 'R') flags |= FLAG.reverse;

      const agents: RecFrame['agents'] = [];
      const consider = (kind: string, x: number, z: number, h: number): void => {
        if (agents.length >= 44) return;
        if (Math.hypot(x - v.x, z - v.z) > AGENT_RADIUS) return;
        const k = KIND_INDEX.get(kind);
        if (k !== undefined) agents.push({ k, x, z, h });
      };
      const tm = app.traffic;
      for (const c of tm.cars) consider(c.kindName, c.user.x, c.user.z, c.user.heading);
      consider('streetcar', tm.streetcar.user.x, tm.streetcar.user.z, tm.streetcar.user.heading);
      consider('schoolbus', tm.schoolBus.user.x, tm.schoolBus.user.z, tm.schoolBus.user.heading);
      if (tm.emergency?.active) consider('police', tm.emergency.user.x, tm.emergency.user.z, tm.emergency.user.heading);
      for (const cy of tm.cyclists.users) consider('cyclist', cy.x, cy.z, cy.heading);
      for (const p of tm.peds.users) consider('ped', p.x, p.z, 0);

      this.frames.push({ t, x: v.x, z: v.z, y: v.y, heading: v.heading, speed: Math.abs(v.vx), steer: v.steer, flags, agents });
    }

    this.seriesAcc += dt;
    if (this.seriesAcc >= 1 / SERIES_HZ && ctx) {
      this.seriesAcc = 0;
      this.series.push(
        t,
        ctx.speedKmh,
        ctx.limitKmh,
        ctx.gLong,
        ctx.gLat,
        ctx.followingTimeGap ?? -1,
        ctx.x,
        ctx.z,
      );
    }
  }

  /** Stop and persist. Returns the payload (also used directly by the dashboard). */
  async end(score: number | null, passed: boolean | null): Promise<ReplayPayload | null> {
    if (!this.recording) return null;
    this.recording = false;
    if (this.frames.length < FRAME_HZ * 5) return null; // ignore <5s stubs
    const app = this.app;
    const payload = pack(
      this.frames,
      this.series,
      {
        mode: this.mode,
        at: Date.now(),
        durationS: this.frames[this.frames.length - 1].t,
        weather: app.engine.weather.kind,
        hour: app.engine.sky.hour,
        observationScore: app.coach.observationScore,
        counters: { ...this.counters },
        score,
        passed,
      },
      [...app.coach.faults],
    );
    const meta: StoredReplayMeta = {
      key: `${app.profiles.active.id}.${payload.meta.at}`,
      profileId: app.profiles.active.id,
      at: payload.meta.at,
      mode: this.mode,
      durationS: payload.meta.durationS,
      faultCount: payload.faults.length,
      score,
      passed,
    };
    await saveReplay({ key: meta.key, meta, data: payload });
    app.lastDrive = payload;
    return payload;
  }
}

/**
 * Lesson runner: spawns the lesson, drives the task sequence against the
 * coach's DriveContext, renders the 3D target beacon + minimap route, the
 * optional parallel-parking ghost guide, and produces the end-of-lesson
 * summary with habit feedback. Completion is persisted.
 */

import * as THREE from 'three';
import type { GameApp } from './app';
import { LESSONS, type LessonDef, type LessonEnv } from '../scenarios/lessons';
import type { Fault } from '../core/types';
import type { TurnCompleted } from '../coaching/context';
import { headingForward, headingLeft, polylineAt, headingOf } from '../core/math';
import { loadProgress, saveProgress } from './progress';

export class LessonRunner {
  private app: GameApp;
  private lesson: LessonDef | null = null;
  private taskIdx = 0;
  private taskTime = 0;
  private faultsAtTaskStart = 0;
  private turns: TurnCompleted[] = [];
  private laneChanges: Array<'left' | 'right'> = [];
  private merges = 0;
  private gearChanges = 0;
  private prevGear = 'P';
  private scratch: Record<string, number> = {};
  private beacon: THREE.Group | null = null;
  private ghost: THREE.Group | null = null;
  private routeTimer = 0;
  private startedAt = 0;

  constructor(app: GameApp) {
    this.app = app;
  }

  get active(): boolean {
    return this.lesson !== null;
  }

  start(lesson: LessonDef): void {
    const app = this.app;
    this.lesson = lesson;
    this.taskIdx = 0;
    this.taskTime = 0;
    this.turns = [];
    this.laneChanges = [];
    this.merges = 0;
    this.gearChanges = 0;
    this.scratch = {};
    app.menus.hide();
    app.mode = 'lesson';
    app.coach.reset();
    app.coach.liveCoaching = true;
    app.coach.showFaults = true;
    app.engine.minimap?.clearHeat();

    // conditions
    if (lesson.weather) app.engine.weather.set(lesson.weather);
    else app.engine.weather.set(app.settings.weather);
    app.engine.sky.setPreset(lesson.time ?? app.settings.time);
    app.traffic.setDensity(lesson.trafficDensity ?? app.settings.trafficDensity);

    // spawn
    if ('edgeId' in lesson.spawn) {
      const lane = app.world.net.laneById(`${lesson.spawn.edgeId}:F${lesson.spawn.lane ?? 0}`);
      if (lane) {
        const smp = polylineAt(lane.poly, lesson.spawn.s);
        app.engine.spawnAt({ x: smp.point.x, z: smp.point.z, heading: headingOf(smp.dir) });
      }
    } else {
      app.engine.spawnAt(lesson.spawn);
    }

    this.startedAt = app.engine.simTime;
    this.faultsAtTaskStart = 0;
    app.engine.hud.setVisible(true);
    app.engine.hud.clearToasts();
    app.engine.hud.centerMsg(lesson.title, lesson.objective);
    app.engine.audio.ui('info');
    if (lesson.parkGhost) this.buildParkGhost();
    this.applyTask();
    app.modeTick = (dt) => this.tick(dt);
    app.onQuitDrive = () => this.quit();
    app.engine.setPaused(false);
  }

  private quit(): void {
    this.cleanup();
    this.app.showMainMenu();
  }

  private cleanup(): void {
    this.lesson = null;
    this.removeBeacon();
    if (this.ghost) {
      this.app.engine.scene.remove(this.ghost);
      this.ghost = null;
    }
    this.app.engine.routeOverlay = null;
    this.app.engine.mapMarkers = [];
    this.app.modeTick = null;
    this.app.onQuitDrive = null;
  }

  /* ---------------- markers ---------------- */

  private removeBeacon(): void {
    if (this.beacon) {
      this.app.engine.scene.remove(this.beacon);
      this.beacon = null;
    }
  }

  private ensureBeacon(x: number, z: number): void {
    if (!this.beacon) {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.6, 0.18, 8, 32),
        new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.85 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.4;
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.16, 9, 8, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.32 }),
      );
      pillar.position.y = 4.5;
      g.add(ring, pillar);
      this.app.engine.scene.add(g);
      this.beacon = g;
    }
    const y = this.app.world.ground(x, z).height;
    this.beacon.position.set(x, y, z);
    const t = this.app.engine.simTime;
    this.beacon.children[0].scale.setScalar(1 + Math.sin(t * 3) * 0.12);
  }

  /** Dashed guide curve + bay outline for the parallel-parking exercise. */
  private buildParkGhost(): void {
    const gap = this.app.world.parkingGap();
    const fwd = headingForward(gap.heading);
    const left = headingLeft(gap.heading);
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x46d68c, transparent: true, opacity: 0.55 });
    // bay outline
    const outline = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.2, 4), mat);
    void outline;
    const mkDash = (x: number, z: number): void => {
      const y = this.app.world.ground(x, z).height + 0.08;
      const dash = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.02, 0.7), mat);
      dash.position.set(x, y, z);
      g.add(dash);
    };
    // S-curve: start beside the lane (left of bay), ahead of the gap, sweep back into the bay
    for (let i = 0; i <= 22; i++) {
      const t = i / 22;
      const along = 9 - t * 13; // from ahead of the bay to its rear half
      const lateral = 3.4 * (1 - Math.sin((Math.min(t, 0.9) / 0.9) * Math.PI * 0.5)); // ease toward curb line
      const px = gap.center.x + fwd.x * along + left.x * lateral;
      const pz = gap.center.z + fwd.z * along + left.z * lateral;
      mkDash(px, pz);
    }
    // bay corners
    const hw = 1.0;
    const hl = gap.length / 2 - 0.8;
    for (const [a, l] of [
      [hl, hw],
      [hl, -hw],
      [-hl, -hw],
      [-hl, hw],
    ]) {
      const px = gap.center.x + fwd.x * a + left.x * l;
      const pz = gap.center.z + fwd.z * a + left.z * l;
      const y = this.app.world.ground(px, pz).height + 0.08;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), mat);
      post.position.set(px, y + 0.25, pz);
      g.add(post);
    }
    this.app.engine.scene.add(g);
    this.ghost = g;
  }

  /* ---------------- task lifecycle ---------------- */

  private applyTask(): void {
    const lesson = this.lesson!;
    const task = lesson.tasks[this.taskIdx];
    const e = this.app.engine;
    e.hud.setObjective(`${this.taskIdx + 1}/${lesson.tasks.length} · ${task.instruction}`, task.sub ?? '');
    this.taskTime = 0;
    this.scratch = {};
    this.turns = [];
    this.laneChanges = [];
    this.merges = 0;
    this.gearChanges = 0;
    this.faultsAtTaskStart = this.app.coach.faults.length;
  }

  private buildEnv(): LessonEnv {
    const app = this.app;
    const ctx = app.coach.context!;
    return {
      ctx,
      taskTime: this.taskTime,
      scratch: this.scratch,
      turns: this.turns,
      laneChanges: this.laneChanges,
      merges: this.merges,
      faults: app.coach.faults.slice(this.faultsAtTaskStart),
      gearChanges: this.gearChanges,
      dist: (x, z) => Math.hypot(ctx.x - x, ctx.z - z),
      spot: (key) => app.world.maneuverSpot(key),
      parkingGap: () => app.world.parkingGap(),
      local: (x, z, heading) => {
        const fwd = headingForward(heading);
        const left = headingLeft(heading);
        const dx = ctx.x - x;
        const dz = ctx.z - z;
        return { along: dx * fwd.x + dz * fwd.z, left: dx * left.x + dz * left.z };
      },
      playerHeading: () => app.engine.vehicle.heading,
      playerGear: () => app.engine.vehicle.powertrain.gearLabel,
      note: (text, kind = 'info') => {
        app.engine.hud.toast(text, kind);
        if (kind === 'good') app.engine.audio.ui('good');
      },
      faultCount: (code) =>
        app.coach.faults.slice(this.faultsAtTaskStart).filter((f) => (code ? f.code === code : true)).length,
    };
  }

  private tick(dt: number): void {
    const lesson = this.lesson;
    if (!lesson) return;
    const ctx = this.app.coach.context;
    if (!ctx) return;
    this.taskTime += dt;

    // accumulate events
    if (ctx.turnCompleted) this.turns.push(ctx.turnCompleted);
    if (ctx.laneChanged) this.laneChanges.push(ctx.laneChanged);
    if (ctx.merged) this.merges++;
    const gear = this.app.engine.vehicle.gear;
    if (gear !== this.prevGear && (gear === 'R' || this.prevGear === 'R')) this.gearChanges++;
    this.prevGear = gear;

    const task = lesson.tasks[this.taskIdx];
    const env = this.buildEnv();

    // markers + route
    const target = task.target?.(env) ?? null;
    if (target) {
      this.ensureBeacon(target.x, target.z);
      this.app.engine.mapMarkers = [{ x: target.x, z: target.z, color: '#4da3ff', r: 5 }];
      this.routeTimer -= dt;
      if (this.routeTimer <= 0) {
        this.routeTimer = 2;
        this.updateRoute(target.x, target.z);
      }
    } else {
      this.removeBeacon();
      this.app.engine.mapMarkers = [];
      this.app.engine.routeOverlay = null;
    }

    if (task.done(env)) {
      task.onComplete?.(env);
      this.app.engine.audio.ui('good');
      this.taskIdx++;
      if (this.taskIdx >= lesson.tasks.length) {
        this.finish();
      } else {
        this.applyTask();
      }
    }
  }

  private updateRoute(tx: number, tz: number): void {
    const net = this.app.world.net;
    const from = net.nearestLane({ x: this.app.engine.vehicle.x, z: this.app.engine.vehicle.z }, this.app.engine.vehicle.heading, 20);
    const to = net.nearestLane({ x: tx, z: tz }, undefined, 30);
    if (!from || !to) {
      this.app.engine.routeOverlay = null;
      return;
    }
    const path = net.findPath(from.lane.toNode, to.lane.fromNode);
    if (!path) {
      this.app.engine.routeOverlay = null;
      return;
    }
    const pts = [{ x: this.app.engine.vehicle.x, z: this.app.engine.vehicle.z }];
    for (const id of path) {
      const n = net.node(id);
      pts.push({ x: n.def.x, z: n.def.z });
    }
    pts.push({ x: tx, z: tz });
    this.app.engine.routeOverlay = pts;
  }

  private finish(): void {
    const lesson = this.lesson!;
    const app = this.app;
    const faults = app.coach.faults;
    const sum = app.coach.summary();
    const duration = app.engine.simTime - this.startedAt;
    const obs = Math.round(app.coach.observationScore);

    // persist completion
    const progress = loadProgress();
    const prevBest = progress.lessons[lesson.id]?.bestFaults ?? Infinity;
    progress.lessons[lesson.id] = {
      completed: true,
      bestFaults: Math.min(prevBest, faults.length),
      at: Date.now(),
    };
    saveProgress(progress);

    const faultRows = faults.length
      ? faults
          .map(
            (f: Fault) =>
              `<li class="${f.severity}"><span class="t">${fmtTime(f.time - this.startedAt)}</span><span class="sev">${f.severity}</span>${f.message}</li>`,
          )
          .join('')
      : '<li class="minor"><span class="sev" style="color:var(--good)">clean</span>No faults recorded — examiner-clean drive.</li>';

    const el = app.menus.showCustom(`
      <h1>✅ ${lesson.title} — complete</h1>
      <p class="dim">${Math.round(duration)}s · habits practised: ${lesson.habits.join(' · ')}</p>
      <div class="statgrid">
        <div class="stat"><b>${faults.length}</b><span>faults</span></div>
        <div class="stat"><b>${sum.major + sum.dangerous + sum.autofail}</b><span>major+</span></div>
        <div class="stat"><b>${obs}</b><span>observation score</span></div>
      </div>
      <h2>Fault log</h2>
      <ul class="fault-list">${faultRows}</ul>
      <div class="row" style="margin-top:18px">
        <button class="btn primary" id="next">Next lesson</button>
        <button class="btn" id="retry">Retry</button>
        <button class="btn ghost" id="menu">Main menu</button>
      </div>
    `);
    app.engine.audio.ui('good');
    const idx = LESSONS.findIndex((l) => l.id === lesson.id);
    (el.querySelector('#next') as HTMLElement).onclick = () => {
      this.cleanup();
      if (idx >= 0 && idx < LESSONS.length - 1) this.start(LESSONS[idx + 1]);
      else app.openExam();
    };
    (el.querySelector('#retry') as HTMLElement).onclick = () => {
      this.cleanup();
      this.start(lesson);
    };
    (el.querySelector('#menu') as HTMLElement).onclick = () => {
      this.cleanup();
      app.showMainMenu();
    };
    this.app.modeTick = null;
  }
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/**
 * Examiner Mode: a full mock G road test. The examiner speaks turn-by-turn
 * instructions (SpeechSynthesis + persistent banner), runs a fixed route
 * covering city + every maneuver + the highway, grades silently through the
 * coach's fault log (plus maneuver-specific checks), self-heals when you go
 * off-route, and produces the weighted report card at the end.
 */

import type { GameApp } from '../game/app';
import { computeReport, type ExamReport } from '../scoring/rubric';
import { angleDiff, headingForward, headingLeft, polylineAt, headingOf } from '../core/math';
import { LOT_RECT } from '../world/map';
import { speak, stopSpeaking } from './voice';

type ManeuverKind = 'roadside' | 'hill' | 'park' | 'threePoint';

type Step =
  | { kind: 'drive'; node: string; say?: string; trigger?: number }
  | { kind: 'maneuver'; m: ManeuverKind }
  | { kind: 'finish' };

const ROUTE: Step[] = [
  { kind: 'drive', node: 'LE', say: 'When you are ready: pull out of the lot and turn right onto Adelaide Frontage Road.' },
  { kind: 'drive', node: 'FS', say: 'At the lights ahead, turn right onto Spadina Avenue.' },
  { kind: 'drive', node: 'KS', say: 'At the next lights, turn left onto King Street West. You may get an advanced green.' },
  { kind: 'drive', node: 'KM', say: 'Continue along King Street — watch the construction zone ahead and merge early.' },
  { kind: 'drive', node: 'RBW', say: 'At the roundabout, take the second exit to continue on King Street.' },
  { kind: 'drive', node: 'RBE' },
  { kind: 'drive', node: 'KE', say: 'At the next intersection, turn right onto Logan Avenue.' },
  { kind: 'drive', node: 'QE', say: 'At the stop sign, turn right onto Queen Street West.' },
  { kind: 'drive', node: 'QM', say: 'Stay on Queen Street — watch for the streetcar and the pedestrian crossover.' },
  { kind: 'drive', node: 'QU', say: 'At the next lights, turn left onto University Avenue.' },
  { kind: 'drive', node: 'PU', say: 'Straight through the four-way stop — first to arrive, first to go.' },
  { kind: 'drive', node: 'US' },
  { kind: 'maneuver', m: 'roadside' },
  { kind: 'drive', node: 'MS' },
  { kind: 'drive', node: 'PM', say: 'At the stop sign, continue straight up McCaul Avenue.' },
  { kind: 'drive', node: 'FM', say: 'At the lights at the top, turn left onto the Frontage Road.' },
  { kind: 'drive', node: 'R1', say: 'Take the Highway 401 East on-ramp on your right. Build speed on the ramp and merge when clear.', trigger: 150 },
  { kind: 'drive', node: 'MB' },
  { kind: 'drive', node: 'ED', say: 'Take Exit 12, McCaul Avenue — signal early, move right, and slow down on the ramp.', trigger: 260 },
  { kind: 'drive', node: 'R2', say: 'Yield at the bottom of the ramp and continue east along the Frontage Road.' },
  { kind: 'drive', node: 'FD', say: 'At the next intersection, turn right onto Davenport Road.' },
  { kind: 'drive', node: 'RBN', say: 'At the roundabout, continue straight through — second exit.' },
  { kind: 'drive', node: 'QD', say: 'Straight through the lights and up the hill.' },
  { kind: 'maneuver', m: 'hill' },
  { kind: 'drive', node: 'PD', say: 'At the stop sign, turn right onto Palmerston Avenue — school zone, mind your speed.' },
  { kind: 'drive', node: 'PU', say: 'Straight through the four-way stop.' },
  { kind: 'drive', node: 'PW', say: 'At the end of Palmerston, turn right onto Shaw Street.' },
  { kind: 'drive', node: 'QW', say: 'At the stop, turn right onto Queen Street West.' },
  { kind: 'drive', node: 'QB', say: 'At the lights, turn right onto Bathurst Avenue.' },
  { kind: 'maneuver', m: 'park' },
  { kind: 'drive', node: 'BS', say: 'Continue south to the end of Bathurst.' },
  { kind: 'maneuver', m: 'threePoint' },
  { kind: 'drive', node: 'QB', say: 'Head back north and turn right onto Queen Street at the lights.' },
  { kind: 'drive', node: 'QS', say: 'At the next lights, turn left onto Spadina Avenue.' },
  { kind: 'drive', node: 'FS', say: 'At the lights, turn left onto the Frontage Road.' },
  { kind: 'drive', node: 'LE', say: 'The test centre is ahead — turn left into the lot.' },
  { kind: 'finish' },
];

export class Examiner {
  private app: GameApp;
  active = false;
  private idx = 0;
  private startedAt = 0;
  private odoStart = 0;
  private announced = false;
  private routeTimer = 0;
  private offRouteSince = 0;
  private lastTargetDist = Infinity;
  /** maneuver sub-state */
  private mPhase = 0;
  private mScratch: Record<string, number> = {};
  private startGraded = false;
  private prevGear = 'P';
  private gearMoves = 0;
  onReport: ((r: ExamReport) => void) | null = null;

  constructor(app: GameApp) {
    this.app = app;
  }

  start(): void {
    const app = this.app;
    this.active = true;
    this.idx = 0;
    this.announced = false;
    this.mPhase = 0;
    this.mScratch = {};
    this.startGraded = false;
    this.gearMoves = 0;
    app.menus.hide();
    app.mode = 'exam';
    app.coach.reset();
    app.coach.liveCoaching = false; // examiners don't coach
    app.coach.showFaults = false; // silent grading
    app.engine.minimap?.clearHeat();
    app.engine.weather.set(app.settings.weather);
    app.engine.sky.setPreset(app.settings.time === 'cycle' ? 'day' : app.settings.time);
    app.traffic.setDensity(app.settings.trafficDensity);
    app.engine.spawnAt(app.world.examSpawn());
    app.engine.hud.setVisible(true);
    app.engine.hud.clearToasts();
    this.startedAt = app.engine.simTime;
    this.odoStart = app.engine.vehicle.odometer;
    app.engine.hud.centerMsg('Mock G Road Test', 'The examiner grades silently. Listen for instructions.', false);
    app.modeTick = (dt) => this.tick(dt);
    app.onQuitDrive = () => this.abort();
    app.engine.setPaused(false);
    speak('Hello! I will be your examiner today. Follow my directions, and drive the way you normally would.');
  }

  abort(): void {
    this.cleanup();
    this.app.showMainMenu();
  }

  private cleanup(): void {
    this.active = false;
    stopSpeaking();
    this.app.engine.routeOverlay = null;
    this.app.engine.mapMarkers = [];
    this.app.modeTick = null;
    this.app.onQuitDrive = null;
  }

  /* ---------------- helpers ---------------- */

  private get step(): Step {
    return ROUTE[this.idx];
  }

  private advance(): void {
    this.idx++;
    this.announced = false;
    this.mPhase = 0;
    this.mScratch = {};
    this.lastTargetDist = Infinity;
    this.offRouteSince = 0;
  }

  private banner(text: string, sub = ''): void {
    this.app.engine.hud.setObjective(text, sub || 'Mock G Test — graded silently');
  }

  private say(text: string): void {
    speak(text);
    this.banner(text);
  }

  private fault(code: string, category: Parameters<GameApp['coach']['fault']>[1], severity: Parameters<GameApp['coach']['fault']>[2], message: string): void {
    const ctx = this.app.coach.context;
    if (ctx) this.app.coach.fault(code, category, severity, message, ctx);
  }

  /* ---------------- per-frame ---------------- */

  private tick(dt: number): void {
    if (!this.active) return;
    const app = this.app;
    const ctx = app.coach.context;
    if (!ctx) return;
    const v = app.engine.vehicle;

    // start grading: pulling away from the test centre
    if (!this.startGraded && app.engine.simTime - this.startedAt < 25) {
      if (ctx.speedMs > 2.5) {
        this.startGraded = true;
        if (ctx.indicator === 'off' && ctx.indicatorAge === 0) {
          this.fault('start-no-signal', 'start', 'minor', 'Pulled away without signalling');
        }
        if (ctx.time - Math.max(ctx.lastShoulderLeft, ctx.lastShoulderRight) > 10) {
          this.fault('start-no-check', 'start', 'minor', 'Pulled away without checking blind spots');
        }
      }
    }

    // collision-class autofails end the test immediately
    const af = app.coach.faults.find((f) => f.severity === 'autofail' && (f.code === 'collision' || f.code === 'hit-pedestrian' || f.code === 'hit-cyclist'));
    if (af) {
      this.say('I’m sorry — I have to end the test here. Pull over when safe.');
      this.finish();
      return;
    }

    const step = this.step;
    if (step.kind === 'drive') this.tickDrive(step, dt);
    else if (step.kind === 'maneuver') this.tickManeuver(step.m, dt, ctx, v);
    else this.tickFinish(ctx);
  }

  private tickDrive(step: { node: string; say?: string; trigger?: number }, dt: number): void {
    const app = this.app;
    const v = app.engine.vehicle;
    const node = app.world.net.node(step.node);
    const dist = Math.hypot(v.x - node.def.x, v.z - node.def.z);
    const trigger = step.trigger ?? 130;

    if (!this.announced && step.say && dist < trigger) {
      this.say(step.say);
      this.announced = true;
    }
    if (!this.announced && !step.say) this.announced = true;
    if (this.announced && step.say) {
      this.banner(step.say, dist > 40 ? `${Math.round(dist / 10) * 10} m` : 'Now');
    }

    // route overlay + marker
    this.routeTimer -= dt;
    if (this.routeTimer <= 0) {
      this.routeTimer = 2.5;
      this.updateRoute(step.node);
      // off-route recovery: if we're getting farther for a while, re-speak guidance
      if (dist > this.lastTargetDist + 45) {
        this.offRouteSince += 2.5;
        if (this.offRouteSince > 5) {
          this.offRouteSince = 0;
          const hint = this.rerouteHint(step.node);
          if (hint) this.say(`No problem — let’s get back on route. ${hint}`);
        }
      } else {
        this.lastTargetDist = Math.min(this.lastTargetDist, dist);
      }
    }
    app.engine.mapMarkers = [{ x: node.def.x, z: node.def.z, color: '#46d68c', r: 5 }];

    if (dist < node.radius + 7) this.advance();
  }

  private updateRoute(targetNode: string): void {
    const app = this.app;
    const net = app.world.net;
    const from = net.nearestLane({ x: app.engine.vehicle.x, z: app.engine.vehicle.z }, app.engine.vehicle.heading, 22);
    if (!from) return;
    const path = net.findPath(from.lane.toNode, targetNode);
    if (!path) return;
    const pts = [{ x: app.engine.vehicle.x, z: app.engine.vehicle.z }];
    for (const id of path) {
      const n = net.node(id);
      pts.push({ x: n.def.x, z: n.def.z });
    }
    app.engine.routeOverlay = pts;
  }

  private rerouteHint(targetNode: string): string | null {
    const app = this.app;
    const net = app.world.net;
    const from = net.nearestLane({ x: app.engine.vehicle.x, z: app.engine.vehicle.z }, app.engine.vehicle.heading, 22);
    if (!from) return null;
    const path = net.findPath(from.lane.toNode, targetNode);
    if (!path || path.length < 2) return null;
    const n0 = net.node(from.lane.toNode);
    const n1 = net.node(path[1] === from.lane.toNode ? path[Math.min(2, path.length - 1)] : path[1]);
    const dir = headingOf({ x: n1.def.x - n0.def.x, z: n1.def.z - n0.def.z });
    const rel = angleDiff(dir, app.engine.vehicle.heading);
    const turn = Math.abs(rel) < 0.5 ? 'continue straight' : rel > 0 ? 'turn left' : 'turn right';
    return `At the next intersection, ${turn}.`;
  }

  /* ---------------- maneuvers ---------------- */

  private tickManeuver(m: ManeuverKind, dt: number, ctx: NonNullable<GameApp['coach']['context']>, v: GameApp['engine']['vehicle']): void {
    const app = this.app;
    const gear = v.gear;
    if (gear !== this.prevGear && (gear === 'R' || this.prevGear === 'R')) this.gearMoves++;
    this.prevGear = gear;

    if (m === 'roadside') {
      if (this.mPhase === 0) {
        this.say('On this quiet crescent: when it is safe, pull over to the right and stop parallel to the curb.');
        this.mPhase = 1;
        this.gearMoves = 0;
      } else if (this.mPhase === 1) {
        if (ctx.indicator === 'right') this.mScratch.sig = 1;
        const stopped = ctx.speedMs < 0.3;
        const onEuclid = ctx.laneObj?.edge.def.id === 'eucl1';
        if (stopped && onEuclid) {
          this.mScratch.t = (this.mScratch.t ?? 0) + dt;
          if (this.mScratch.t > 1.6) {
            if (!this.mScratch.sig) this.fault('roadside-no-signal', 'roadside', 'minor', 'Pulled over without signalling');
            if (ctx.laneOffset > -0.3) this.fault('roadside-too-far', 'roadside', 'minor', 'Roadside stop too far from the curb');
            else if (ctx.laneOffset < -0.9 || ctx.offRoad) this.fault('roadside-curb', 'roadside', 'minor', 'Touched the curb on the roadside stop');
            this.say('Good. When you are ready: signal, check your blind spot, and re-enter traffic.');
            this.mPhase = 2;
            this.mScratch.t = 0;
          }
        } else {
          this.mScratch.t = 0;
        }
      } else if (this.mPhase === 2) {
        if (ctx.speedMs > 3.5 && Math.abs(ctx.laneOffset) < 0.7) {
          if (ctx.time - ctx.lastShoulderLeft > 7) {
            this.fault('reenter-no-check', 'roadside', 'major', 'Re-entered traffic without a blind-spot check');
          }
          this.advance();
        }
      }
      return;
    }

    if (m === 'hill') {
      const spot = app.world.maneuverSpot('hillStop');
      const dist = Math.hypot(v.x - spot.x, v.z - spot.z);
      if (this.mPhase === 0) {
        this.say('Stop on the hill near the marker, and put the car in Park.');
        app.engine.mapMarkers = [{ x: spot.x, z: spot.z, color: '#46d68c', r: 5 }];
        this.mPhase = 1;
      } else if (this.mPhase === 1) {
        if (dist < 24 && v.gear === 'P' && ctx.speedMs < 0.2) {
          this.mScratch.t = (this.mScratch.t ?? 0) + dt;
          if (this.mScratch.t > 1.4) {
            this.say('Thank you. Carry on up the hill when you are ready.');
            this.mPhase = 2;
            this.mScratch.zPrev = ctx.z;
            this.mScratch.roll = 0;
          }
        } else this.mScratch.t = 0;
      } else if (this.mPhase === 2) {
        const dz = ctx.z - (this.mScratch.zPrev ?? ctx.z);
        this.mScratch.zPrev = ctx.z;
        const fwdZ = Math.cos(v.heading);
        if (dz * fwdZ < 0) this.mScratch.roll = (this.mScratch.roll ?? 0) + Math.abs(dz);
        if (ctx.speedMs > 4) {
          const roll = this.mScratch.roll ?? 0;
          if (roll > 1.2) this.fault('rollback-major', 'roadside', 'major', `Rolled back ${roll.toFixed(1)} m on the hill start`);
          else if (roll > 0.45) this.fault('rollback', 'roadside', 'minor', `Rolled back ${roll.toFixed(1)} m on the hill start`);
          this.advance();
        }
      }
      return;
    }

    if (m === 'park') {
      const gap = app.world.parkingGap();
      if (this.mPhase === 0) {
        this.say('Parallel park between the two cars on your right. Take your time.');
        app.engine.mapMarkers = [{ x: gap.center.x, z: gap.center.z, color: '#46d68c', r: 5 }];
        this.mPhase = 1;
        this.gearMoves = 0;
        this.mScratch.faults0 = app.coach.faults.length;
      } else if (this.mPhase === 1) {
        const fwd = headingForward(gap.heading);
        const left = headingLeft(gap.heading);
        const dx = ctx.x - gap.center.x;
        const dz = ctx.z - gap.center.z;
        const along = dx * fwd.x + dz * fwd.z;
        const lat = dx * left.x + dz * left.z;
        const parallel = Math.abs(angleDiff(v.heading, gap.heading)) < 0.15;
        const inBay = Math.abs(along) < gap.length / 2 - 1.5 && Math.abs(lat) < 0.6;
        if (inBay && parallel && ctx.speedMs < 0.25) {
          this.mScratch.t = (this.mScratch.t ?? 0) + dt;
          if (this.mScratch.t > 1.6) {
            const curbCm = Math.round((lat + 0.26) * 100);
            if (curbCm > 45) this.fault('park-too-far', 'parking', 'minor', `Parked ${curbCm} cm from the curb`);
            if (ctx.offRoad) this.fault('park-curb', 'parking', 'minor', 'Touched the curb while parking');
            if (this.gearMoves > 5) this.fault('park-moves', 'parking', 'minor', 'Excessive repositioning during the parallel park');
            this.say('Thank you. Pull out when it is safe and continue south on Bathurst.');
            this.advance();
          }
        } else {
          this.mScratch.t = 0;
        }
        // taking far too long is itself noted
        this.mScratch.tt = (this.mScratch.tt ?? 0) + dt;
        if (this.mScratch.tt > 150 && !this.mScratch.warned) {
          this.mScratch.warned = 1;
          this.fault('park-timeout', 'parking', 'major', 'Could not complete the parallel park in good time');
          this.say('That’s alright — let’s move on. Continue south on Bathurst.');
          this.advance();
        }
      }
      return;
    }

    // three-point turn
    if (this.mPhase === 0) {
      this.say('This is a dead end. Turn the car around using a three-point turn.');
      this.mPhase = 1;
      this.mScratch.h0 = v.heading;
      this.gearMoves = 0;
    } else if (this.mPhase === 1) {
      const reversed = Math.abs(angleDiff(v.heading, this.mScratch.h0 ?? 0)) > 2.45;
      if (reversed && ctx.speedMs > 1.5) {
        if (this.gearMoves > 5) this.fault('threepoint-moves', 'parking', 'minor', `Three-point turn took ${this.gearMoves} movements`);
        if (ctx.offRoad) this.fault('threepoint-curb', 'parking', 'minor', 'Touched the curb during the three-point turn');
        this.advance();
      }
    }
  }

  private tickFinish(ctx: NonNullable<GameApp['coach']['context']>): void {
    if (!this.announced) {
      this.say('Pull into a parking spot at the test centre and put the car in Park.');
      this.announced = true;
    }
    const v = this.app.engine.vehicle;
    const inLot = v.x >= LOT_RECT.x0 && v.x <= LOT_RECT.x1 && v.z >= LOT_RECT.z0 && v.z <= LOT_RECT.z1;
    if (inLot && v.gear === 'P' && ctx.speedMs < 0.2) this.finish();
  }

  private finish(): void {
    const app = this.app;
    const duration = app.engine.simTime - this.startedAt;
    const distanceKm = (app.engine.vehicle.odometer - this.odoStart) / 1000;
    const report = computeReport(app.coach.faults, app.coach.observationScore, duration, distanceKm);
    this.cleanup();
    speak(
      report.passed
        ? `Congratulations — that is a pass. Your score: ${report.overall} percent.`
        : `I’m afraid that’s not a pass today. Your score: ${report.overall} percent. The report shows exactly what to practise.`,
    );
    this.onReport?.(report);
  }
}

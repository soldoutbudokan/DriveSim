/**
 * AI traffic car: IDM car-following along lane polylines, Ontario rule
 * obedience (signal phases incl. amber dilemma + right-turn-on-red after a
 * full stop, stop signs with arrival-order at all-ways, yield/roundabout gap
 * acceptance, left turns yielding to oncoming), lane changes with gap checks
 * and indicators, mandatory merges from the acceleration lane, construction
 * closures, and pulling right for emergency vehicles.
 */

import { clamp, headingOf, lerp, polylineAt, smoothstep, type V2 } from '../core/math';
import type { Lane, LaneLink } from '../world/network';
import { idm, type RoadUser } from './types';
import type { TrafficContext } from './manager';

let agentSeq = 0;

const DRIVER_VARIANCE = () => 0.9 + Math.random() * 0.18;

export class TrafficCar {
  readonly user: RoadUser;
  lane: Lane;
  s: number;
  speed = 0;
  accel = 0;
  next: LaneLink | null = null;
  signal: 'off' | 'left' | 'right' = 'off';
  braking = false;
  /** Fixed route (transit / cyclists): looped lane sequence. */
  routePlan: Lane[] | null = null;
  planIdx = 0;
  noLaneChange = false;
  /** Speed cap m/s (cyclists, streetcar). */
  vCap = Infinity;

  /** lane change state */
  private lcFrom: Lane | null = null;
  private lcT = 1;
  private lcCooldown = 0;
  private pendingLc: { target: Lane; timer: number } | null = null;

  /** stop-control state */
  private stoppedFor = 0;
  private registeredAt: string | null = null;
  private clearedNode: string | null = null;

  private driver = DRIVER_VARIANCE();
  private crashTimer = 0;
  pullover = false;

  constructor(lane: Lane, s: number, halfL: number, halfW: number, kind: RoadUser['kind'] = 'car') {
    this.lane = lane;
    this.s = s;
    const smp = polylineAt(lane.poly, s);
    this.user = {
      id: `ai${agentSeq++}`,
      kind,
      x: smp.point.x,
      z: smp.point.z,
      heading: headingOf(smp.dir),
      speed: 0,
      halfL,
      halfW,
      laneId: lane.id,
      s,
    };
  }

  crash(): void {
    this.crashTimer = 4;
    this.speed = Math.min(this.speed, 1);
  }

  /** Choose the next link with lane continuity + route randomness. */
  private chooseNext(ctx: TrafficContext): void {
    if (this.routePlan) {
      const nextLane = this.routePlan[(this.planIdx + 1) % this.routePlan.length];
      const hIn = ctx.net.laneHeading(this.lane, this.lane.len - 2);
      const hOut = ctx.net.laneHeading(nextLane, 2);
      const sameEdgeBack = nextLane.edge === this.lane.edge && nextLane.dir !== this.lane.dir;
      this.next = {
        lane: nextLane,
        turn: sameEdgeBack ? 'uturn' : ((): 'straight' | 'left' | 'right' | 'uturn' => {
          const deg = ((hOut - hIn + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          if (Math.abs(deg) < 0.56) return 'straight';
          if (Math.abs(deg) > 2.58) return 'uturn';
          return deg > 0 ? 'left' : 'right';
        })(),
      };
      return;
    }
    const links = ctx.net.successors(this.lane);
    if (!links.length) {
      this.next = null;
      return;
    }
    // mandatory: merge lane continues into the RIGHTMOST mainline lane
    if (this.lane.merge) {
      const sorted = [...links].sort((a, b) => b.lane.index - a.lane.index);
      this.next = sorted[0];
      return;
    }
    const weights = links.map((l) => {
      if (l.lane.edge.def.kind === 'lot') return 0.001;
      let w = l.turn === 'straight' ? 3.2 : l.turn === 'right' ? 1.6 : l.turn === 'left' ? 1.2 : 0.05;
      if (l.lane.edge.def.kind === 'highway') w *= 1.25;
      // straight prefers same lane index (continuity)
      if (l.turn === 'straight') w *= l.lane.index === Math.min(this.lane.index, l.lane.laneCount - 1) ? 2.5 : 0.6;
      if (l.lane.isHov) w *= 0.5;
      return w;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < links.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        this.next = links[i];
        return;
      }
    }
    this.next = links[links.length - 1];
  }

  private desiredSpeed(ctx: TrafficContext): number {
    let v0 = (this.lane.speed / 3.6) * this.driver;
    // zones (school/construction) override
    const zoneLimit = ctx.world.speedLimitAt(this.user.x, this.user.z);
    v0 = Math.min(v0, (zoneLimit / 3.6) * this.driver);
    // slow for upcoming turns
    const dNode = this.lane.len - this.s;
    if (this.next && dNode < 30) {
      if (this.next.turn === 'right') v0 = Math.min(v0, lerp(3.6, v0, clamp(dNode / 30, 0, 1)));
      else if (this.next.turn === 'left' || this.next.turn === 'uturn') v0 = Math.min(v0, lerp(4.2, v0, clamp(dNode / 30, 0, 1)));
    }
    if (this.lane.edge.def.kind === 'roundabout') v0 = Math.min(v0, 7.5);
    if (this.lane.exit && this.s > 10) v0 = Math.min(v0, 16);
    v0 *= Math.sqrt(ctx.gripMul);
    if (this.pullover) v0 = 0;
    return Math.min(v0, this.vCap);
  }

  /**
   * Distance to where we must stop for the control at the end of this lane,
   * or null if we may proceed.
   */
  private controlStopDistance(ctx: TrafficContext): number | null {
    const control = ctx.net.approachControl(this.lane);
    const nodeId = this.lane.toNode;
    if (control === 'none' || this.clearedNode === nodeId) {
      // uncontrolled left turns still yield to oncoming
      if (this.next && (this.next.turn === 'left' || this.next.turn === 'uturn') && this.clearedNode !== nodeId) {
        const sStop = ctx.net.stopLineS(this.lane);
        const d = sStop - this.s;
        if (d < 22 && !ctx.oncomingClear(this.lane, 26)) return Math.max(d, 0.1);
        if (d < 3) this.clearedNode = nodeId;
      }
      return null;
    }
    const sStop = ctx.net.stopLineS(this.lane);
    const d = sStop - this.s;
    if (d < -3) {
      this.clearedNode = nodeId;
      return null;
    }

    if (control === 'signal') {
      const light = ctx.world.signalForLane(this.lane, ctx.simTime);
      if (!light) return null;
      const turn = this.next?.turn ?? 'straight';
      if (light.leftArrow) {
        // protected left: lefts go, others wait
        if (turn === 'left' || turn === 'uturn') return null;
        return Math.max(d, 0.05);
      }
      if (light.ball === 'green') {
        if ((turn === 'left' || turn === 'uturn') && d < 16 && !ctx.oncomingClear(this.lane, 30)) {
          return Math.max(d + ctx.net.node(nodeId).radius * 0.4, 0.1);
        }
        return null;
      }
      if (light.ball === 'amber') {
        const needed = (this.speed * this.speed) / (2 * Math.max(d, 0.5));
        return needed > 3.4 ? null : Math.max(d, 0.05);
      }
      // red: RTOR after full stop when clear
      if (turn === 'right') {
        if (this.stoppedFor > 1.1 && d < 3.5 && ctx.conflictsClear(this.lane, 'right')) {
          this.clearedNode = nodeId;
          return null;
        }
      }
      return Math.max(d, 0.05);
    }

    if (control === 'stop') {
      const node = ctx.net.node(nodeId);
      const atLine = d < 2.6 && this.speed < 0.35;
      if (atLine) this.stoppedFor += 0; // accumulated in update
      if (node.def.control === 'stop-all') {
        if (this.registeredAt !== nodeId && d < 4) {
          ctx.registerArrival(nodeId, this.user.id);
          this.registeredAt = nodeId;
        }
        if (this.stoppedFor > 1.0 && ctx.arrivalTurn(nodeId, this.user.id) && ctx.boxClear(nodeId, this.user.id)) {
          ctx.releaseArrival(nodeId, this.user.id);
          this.registeredAt = null;
          this.clearedNode = nodeId;
          return null;
        }
        return Math.max(d, 0.05);
      }
      // minor stop: full stop then gap acceptance
      if (this.stoppedFor > 1.0 && ctx.conflictsClear(this.lane, this.next?.turn ?? 'straight')) {
        this.clearedNode = nodeId;
        return null;
      }
      return Math.max(d, 0.05);
    }

    if (control === 'yield' || control === 'roundabout-yield') {
      const clear =
        control === 'roundabout-yield'
          ? ctx.roundaboutClear(nodeId)
          : ctx.conflictsClear(this.lane, this.next?.turn ?? 'straight');
      if (clear && d < 14) {
        this.clearedNode = nodeId;
        return null;
      }
      if (!clear) return Math.max(d, 0.05);
      return null;
    }
    return null;
  }

  /** Lane-change / merge decisions. */
  private updateLaneChange(dt: number, ctx: TrafficContext): void {
    if (this.noLaneChange) return;
    this.lcCooldown = Math.max(0, this.lcCooldown - dt);
    if (this.lcT < 1) {
      this.lcT = Math.min(1, this.lcT + dt / 2.4);
      if (this.lcT >= 1) {
        this.lcFrom = null;
        if (!this.lane.merge) this.signal = this.nextTurnSignal();
      }
      return;
    }

    // pending change waiting out the signal lead time
    if (this.pendingLc) {
      this.pendingLc.timer -= dt;
      const t = this.pendingLc.target;
      const stillOk = ctx.gapOk(t, this.user, this.speed);
      if (!stillOk) {
        this.pendingLc = null;
        this.signal = this.nextTurnSignal();
      } else if (this.pendingLc.timer <= 0) {
        this.beginChange(t);
        this.pendingLc = null;
      }
      return;
    }

    if (this.lcCooldown > 0) return;

    // --- merge from acceleration lane (cross-edge mandatory) -------------
    if (this.lane.merge) {
      this.signal = 'left';
      const target = ctx.mergeTargetLane(this.lane);
      if (target && this.s > this.lane.len * 0.3) {
        if (ctx.mergeGapOk(this, target)) {
          // switch onto the mainline lane at the projected position
          const proj = ctx.projectOnto(target, this.user);
          if (proj) {
            this.lcFrom = this.lane;
            this.lane = target;
            this.s = proj;
            this.lcT = 0;
            this.next = null;
            this.lcCooldown = 4;
          }
        } else if (this.lane.len - this.s < 40) {
          this.speed = Math.max(this.speed - 2.5 * dt, 6); // adjust to find a gap
        }
      }
      return;
    }

    const sameDir = ctx.parallelLanes(this.lane);
    if (sameDir.length === 0) return;

    // mandatory: construction closure ahead in my lane
    const closure = this.lane.closed;
    let mandatory: Lane | null = null;
    if (closure && this.s < closure[0] && closure[0] - this.s < 90) {
      mandatory = sameDir.find((l) => l.index === this.lane.index - 1) ?? sameDir[0];
    }
    // mandatory: get into the proper turn lane near the node
    const dNode = this.lane.len - this.s;
    if (!mandatory && this.next && dNode < 80 && dNode > 18) {
      if (this.next.turn === 'right' && this.lane.index < this.lane.laneCount - 1) {
        mandatory = sameDir.find((l) => l.index === this.lane.index + 1) ?? null;
      } else if ((this.next.turn === 'left' || this.next.turn === 'uturn') && this.lane.index > 0) {
        mandatory = sameDir.find((l) => l.index === this.lane.index - 1) ?? null;
      }
      // exiting the highway needs the rightmost lane
      const nextIsExit = this.next.lane.exit;
      if (!mandatory && nextIsExit && this.lane.index < this.lane.laneCount - 1) {
        mandatory = sameDir.find((l) => l.index === this.lane.index + 1) ?? null;
      }
    }

    let target = mandatory;
    if (!target && ctx.lod === 'full' && Math.random() < dt * 0.12) {
      // discretionary: escape a slow leader
      const leader = ctx.leaderFor(this);
      if (leader && leader.gap < 26 && leader.user.speed < this.desiredSpeed(ctx) * 0.6) {
        const candidates = sameDir.filter((l) => Math.abs(l.index - this.lane.index) === 1 && !l.isHov);
        for (const c of candidates) {
          if (ctx.gapOk(c, this.user, this.speed)) {
            target = c;
            break;
          }
        }
      }
    }

    if (target && ctx.gapOk(target, this.user, this.speed)) {
      this.signal = target.index < this.lane.index ? 'left' : 'right';
      this.pendingLc = { target, timer: this.lane.edge.def.kind === 'highway' ? 1.6 : 1.1 };
    } else if (mandatory && closure && closure[0] - this.s < 30) {
      // can't get over yet: slow down before the cones
      this.speed = Math.max(this.speed - 3.2 * dt, 2);
    }
  }

  private beginChange(target: Lane): void {
    this.lcFrom = this.lane;
    this.lane = target;
    this.lcT = 0;
    this.lcCooldown = 5;
    this.next = null; // re-plan from the new lane
  }

  private nextTurnSignal(): 'off' | 'left' | 'right' {
    if (!this.next) return 'off';
    const d = this.lane.len - this.s;
    if (d > 38) return 'off';
    if (this.next.turn === 'left' || this.next.turn === 'uturn') return 'left';
    if (this.next.turn === 'right' || this.next.lane.exit) return 'right';
    return 'off';
  }

  update(dt: number, ctx: TrafficContext): void {
    if (this.crashTimer > 0) {
      this.crashTimer -= dt;
      this.speed = Math.max(0, this.speed - 6 * dt);
      this.sync(dt);
      return;
    }

    if (!this.next || this.next.lane.fromNode !== this.lane.toNode) this.chooseNext(ctx);

    // emergency vehicles: pull right + stop
    this.pullover = ctx.emergencyNearby(this.user);

    this.updateLaneChange(dt, ctx);

    const v0 = this.desiredSpeed(ctx);
    const leader = ctx.leaderFor(this);
    let a = idm(this.speed, v0, leader ? leader.gap : null, leader ? leader.user.speed : 0, 1.7 * this.driver, 2.6);

    const stopD = ctx.lod === 'full' || this.lane.len - this.s < 60 ? this.controlStopDistance(ctx) : null;
    if (stopD !== null) {
      const aStop = idm(this.speed, v0, Math.max(stopD - 1.2, 0.05), 0, 1.7, 2.6);
      a = Math.min(a, aStop);
    }

    this.accel = a;
    this.braking = a < -0.6;
    this.speed = Math.max(0, this.speed + a * dt);

    // stopped-time accounting for stop signs / RTOR
    const nearLine = ctx.net.stopLineS(this.lane) - this.s < 3.2;
    if (this.speed < 0.3 && nearLine) this.stoppedFor += dt;
    else if (this.speed > 1.5) this.stoppedFor = 0;

    this.s += this.speed * dt;

    // indicator management
    if (this.lcT >= 1 && !this.pendingLc && !this.lane.merge) this.signal = this.nextTurnSignal();

    // advance to the next lane
    if (this.s >= this.lane.len) {
      if (this.next) {
        const carry = this.s - this.lane.len;
        if (this.registeredAt) {
          ctx.releaseArrival(this.registeredAt, this.user.id);
          this.registeredAt = null;
        }
        this.lane = this.next.lane;
        if (this.routePlan) this.planIdx = (this.planIdx + 1) % this.routePlan.length;
        this.s = Math.min(carry, Math.max(this.lane.len - 1, 0.5));
        this.next = null;
        this.clearedNode = null;
        this.stoppedFor = 0;
        this.signal = 'off';
        this.lcFrom = null;
        this.lcT = 1;
        this.onLaneAdvanced();
      } else {
        this.s = this.lane.len;
        this.speed = 0;
      }
    }

    this.sync(dt);
  }

  private sync(dt: number): void {
    const smp = polylineAt(this.lane.poly, Math.min(this.s, this.lane.len));
    let x = smp.point.x;
    let z = smp.point.z;
    let dir = smp.dir;
    if (this.lcFrom && this.lcT < 1) {
      const t = smoothstep(this.lcT);
      const sFrom = Math.min(this.s, this.lcFrom.len - 0.5);
      const old = polylineAt(this.lcFrom.poly, sFrom);
      x = lerp(old.point.x, x, t);
      z = lerp(old.point.z, z, t);
      dir = { x: lerp(old.dir.x, dir.x, t), z: lerp(old.dir.z, dir.z, t) };
    }
    this.user.x = x;
    this.user.z = z;
    this.user.heading = headingOf(dir);
    this.user.speed = this.speed;
    this.user.laneId = this.lane.id;
    this.user.s = this.s;
    void dt;
  }

  /** Hook for subclasses (transit stop scheduling). */
  protected onLaneAdvanced(): void {}

  /** Ground position incl. elevation (for the visual). */
  elevatedY(): number {
    const sEdge = this.lane.dir === 1 ? this.s : this.lane.edge.len - this.s;
    return this.lane.edge.elev(sEdge);
  }
}

/**
 * DriveContext: everything the coaching rules need to judge a frame of
 * driving, computed once per frame. The tracker also derives EVENTS —
 * lane changes, highway merges, intersection entries (with right-of-way
 * snapshots taken at the moment of entry) and completed turns — which is
 * what lets rules grade "did you stop / signal / check before doing X".
 */

import { angleDiff, headingOf, type V2 } from '../core/math';
import type { Engine } from '../core/engine';
import type { CityWorld } from '../world/world';
import type { TrafficManager } from '../traffic/manager';
import type { Lane, LaneHit, Turn } from '../world/network';
import type { LightState } from '../world/signals';
import type { LeaderInfo } from '../traffic/types';
import type { ZoneDef } from '../world/map';

export interface IntersectionEntry {
  node: string;
  control: 'signal' | 'stop' | 'yield' | 'roundabout-yield' | 'none';
  /** Signal state at the moment of entry. */
  signal: LightState | null;
  /** Lowest speed (m/s) observed in the 25 m before the line. */
  minApproachSpeed: number;
  /** Stopped position relative to the stop line (m past line; negative = before). */
  stopOverrun: number;
  conflictsClear: boolean;
  oncomingClear: boolean;
  pedsCrossing: number;
  myTurnAtAllWay: boolean;
  approachHeading: number;
  enteredAt: number;
  /** Indicator state captured at the moment of entry (for turn-signal grading). */
  indicatorAtEntry: 'off' | 'left' | 'right';
  indicatorAgeAtEntry: number;
  lastMirrorAtEntry: number;
}

export interface TurnCompleted extends IntersectionEntry {
  turn: Turn;
  exitHeading: number;
}

export interface DriveContext {
  time: number;
  dt: number;
  x: number;
  z: number;
  heading: number;
  speedMs: number;
  speedKmh: number;
  gLong: number;
  gLat: number;
  /** Brake pedal position 0..1 (distinguishes real braking from coasting decel). */
  brakePedal: number;
  lane: LaneHit | null;
  laneObj: Lane | null;
  limitKmh: number;
  zone: ZoneDef | null;
  laneOffset: number;
  wrongWay: boolean;
  inBikeLane: boolean;
  inHovLane: boolean;
  offRoad: boolean;
  /** Distance to the stop line of the current approach (m), if approaching a control. */
  approach: {
    control: 'signal' | 'stop' | 'yield' | 'roundabout-yield' | 'none';
    node: string;
    dist: number;
    signal: LightState | null;
  } | null;
  insideNode: string | null;
  leader: LeaderInfo | null;
  followingTimeGap: number | null;
  indicator: 'off' | 'left' | 'right';
  indicatorAge: number;
  lastMirror: number;
  lastShoulderLeft: number;
  lastShoulderRight: number;
  headlights: boolean;
  wipers: boolean;
  night: number;
  weatherKind: string;
  weatherSeverity: number;
  /* ---- events (this frame only) ---- */
  laneChanged: 'left' | 'right' | null;
  merged: boolean;
  enteredIntersection: IntersectionEntry | null;
  turnCompleted: TurnCompleted | null;
  collision: { impulse: number; kind: string } | null;
  /* ---- continuous hazards ---- */
  streetcar: { doorsOpen: boolean; x: number; z: number; sameStreetAhead: boolean; behindIt: boolean; passingIt: boolean };
  schoolBus: { flashing: boolean; x: number; z: number; sameStreet: boolean; passingIt: boolean };
  emergency: { active: boolean; near: boolean; x: number; z: number };
  pxo: { activeNear: boolean; occupied: number; dist: number };
  onMergeLane: boolean;
  mergeLaneRemaining: number;
}

export class ContextTracker {
  prev: DriveContext | null = null;

  private lastLaneId: string | null = null;
  private lastLaneObj: Lane | null = null;
  private laneCandidateId: string | null = null;
  private laneCandidateT = 0;
  private insideNode: string | null = null;
  private entrySnapshot: IntersectionEntry | null = null;
  private minApproachSpeed = Infinity;
  private stopOverrun = -99;
  private collisionQueue: { impulse: number; kind: string }[] = [];

  constructor(
    private engine: Engine,
    private world: CityWorld,
    private traffic: TrafficManager,
  ) {
    engine.events.on('collision', (c) => this.collisionQueue.push({ impulse: c.impulse, kind: c.kind }));
  }

  reset(): void {
    this.prev = null;
    this.lastLaneId = null;
    this.lastLaneObj = null;
    this.insideNode = null;
    this.entrySnapshot = null;
    this.minApproachSpeed = Infinity;
    this.collisionQueue.length = 0;
  }

  build(dt: number): DriveContext {
    const e = this.engine;
    const v = e.vehicle;
    const net = this.world.net;
    const pos: V2 = { x: v.x, z: v.z };

    // --- lane tracking with hysteresis -------------------------------
    const hit = net.nearestLane(pos, v.heading, 11);
    let laneChanged: 'left' | 'right' | null = null;
    let merged = false;
    if (hit) {
      if (this.lastLaneId === null) {
        this.lastLaneId = hit.lane.id;
        this.lastLaneObj = hit.lane;
      } else if (hit.lane.id !== this.lastLaneId) {
        if (this.laneCandidateId === hit.lane.id) {
          this.laneCandidateT += dt;
        } else {
          this.laneCandidateId = hit.lane.id;
          this.laneCandidateT = 0;
        }
        if (this.laneCandidateT > 0.45) {
          const oldLane = this.lastLaneObj;
          const newLane = hit.lane;
          if (oldLane && oldLane.edge === newLane.edge && oldLane.dir === newLane.dir && oldLane.kind === 'drive' && newLane.kind === 'drive') {
            laneChanged = newLane.index < oldLane.index ? 'left' : 'right';
          } else if (oldLane && oldLane.merge && newLane.edge.def.kind === 'highway') {
            merged = true;
          }
          this.lastLaneId = newLane.id;
          this.lastLaneObj = newLane;
          this.laneCandidateId = null;
          this.laneCandidateT = 0;
        }
      } else {
        this.laneCandidateId = null;
        this.laneCandidateT = 0;
      }
    }
    const lane = this.lastLaneObj && hit && hit.lane.id === this.lastLaneId ? hit : hit;
    const laneObj = lane?.lane ?? null;

    // wrong-way: nearest lane regardless of heading disagrees badly
    let wrongWay = false;
    if (laneObj && lane) {
      const align = Math.abs(angleDiff(v.heading, headingOf(lane.dir)));
      wrongWay = align > Math.PI * 0.62 && v.vx > 1.5;
    }

    // --- approach / intersection state ---------------------------------
    let approach: DriveContext['approach'] = null;
    if (laneObj && lane) {
      const control = net.approachControl(laneObj);
      const dist = net.stopLineS(laneObj) - lane.s;
      if (dist > -2 && dist < 90) {
        approach = {
          control,
          node: laneObj.toNode,
          dist,
          signal: control === 'signal' ? this.world.signalForLane(laneObj, e.simTime) : null,
        };
        if (dist < 25) {
          this.minApproachSpeed = Math.min(this.minApproachSpeed, Math.abs(v.vx));
          if (Math.abs(v.vx) < 0.4) this.stopOverrun = Math.max(this.stopOverrun, -dist);
        }
      }
    }

    // node containment
    let insideNode: string | null = null;
    let entered: IntersectionEntry | null = null;
    let turnDone: TurnCompleted | null = null;
    const checkNode = (nodeId: string): boolean => {
      const n = net.node(nodeId);
      return Math.hypot(v.x - n.def.x, v.z - n.def.z) < n.radius + 0.8;
    };
    if (this.insideNode && checkNode(this.insideNode)) {
      insideNode = this.insideNode;
    } else if (this.insideNode) {
      // exited: classify the turn
      if (this.entrySnapshot) {
        const turn = ((): Turn => {
          const d = angleDiff(v.heading, this.entrySnapshot.approachHeading);
          const deg = (d * 180) / Math.PI;
          if (Math.abs(deg) < 35) return 'straight';
          if (Math.abs(deg) > 145) return 'uturn';
          return deg > 0 ? 'left' : 'right';
        })();
        turnDone = { ...this.entrySnapshot, turn, exitHeading: v.heading };
      }
      this.insideNode = null;
      this.entrySnapshot = null;
    } else if (laneObj && approach && approach.dist < 2 && checkNode(laneObj.toNode)) {
      // entering now: snapshot right-of-way state
      const nodeId = laneObj.toNode;
      const arrival = this.traffic.playerArrivalStatus();
      entered = {
        node: nodeId,
        control: approach.control,
        signal: approach.signal,
        minApproachSpeed: this.minApproachSpeed === Infinity ? Math.abs(v.vx) : this.minApproachSpeed,
        stopOverrun: this.stopOverrun,
        conflictsClear: laneObj ? this.traffic.conflictsClear(laneObj, 'straight') : true,
        oncomingClear: laneObj ? this.traffic.oncomingClear(laneObj, 30) : true,
        pedsCrossing: this.traffic.peds.crossingAt(nodeId),
        myTurnAtAllWay: arrival && arrival.node === nodeId ? arrival.myTurn : true,
        approachHeading: v.heading,
        enteredAt: e.simTime,
        indicatorAtEntry: e.signal,
        indicatorAgeAtEntry: e.signalAgeS,
        lastMirrorAtEntry: e.lastMirrorCheck,
      };
      if (approach.control === 'roundabout-yield') {
        entered.conflictsClear = this.traffic.roundaboutClear(nodeId);
      }
      this.insideNode = nodeId;
      this.entrySnapshot = entered;
      this.minApproachSpeed = Infinity;
      this.stopOverrun = -99;
      insideNode = nodeId;
    }
    if (!approach || approach.dist > 26) {
      this.minApproachSpeed = Infinity;
      this.stopOverrun = -99;
    }

    // --- hazards ---------------------------------------------------------
    const sc = this.traffic.streetcar;
    const scSameStreet = !!(laneObj && sc.lane.edge === laneObj.edge);
    const scDx = Math.hypot(sc.user.x - v.x, sc.user.z - v.z);
    const sameDir = scSameStreet && laneObj ? sc.lane.dir === laneObj.dir : false;
    const streetcar = {
      doorsOpen: sc.doorsOpen,
      x: sc.user.x,
      z: sc.user.z,
      sameStreetAhead: scSameStreet && sameDir && scDx < 60,
      behindIt: scSameStreet && sameDir && lane != null && lane.s < sc.s,
      passingIt: scSameStreet && sameDir && scDx < sc.user.halfL + 6 && Math.abs(v.vx) > 1,
    };
    const bus = this.traffic.schoolBus;
    const busSame = !!(laneObj && bus.lane.edge === laneObj.edge);
    const busDx = Math.hypot(bus.user.x - v.x, bus.user.z - v.z);
    const schoolBus = {
      flashing: bus.flashing,
      x: bus.user.x,
      z: bus.user.z,
      sameStreet: busSame && busDx < 70,
      passingIt: busSame && busDx < bus.user.halfL + 5 && Math.abs(v.vx) > 1,
    };
    const em = this.traffic.emergency;
    const emergency = {
      active: !!em?.active,
      near: !!em?.active && Math.hypot(em.user.x - v.x, em.user.z - v.z) < 70,
      x: em?.user.x ?? 0,
      z: em?.user.z ?? 0,
    };
    const pxoDist = Math.hypot(this.world.pxo.x - v.x, this.world.pxo.z - v.z);
    const pxo = {
      activeNear: this.world.pxo.active && pxoDist < 55,
      occupied: this.world.pxo.occupied,
      dist: pxoDist,
    };

    const leader = this.traffic.playerLeader();
    const collision = this.collisionQueue.shift() ?? null;

    const ctx: DriveContext = {
      time: e.simTime,
      dt,
      x: v.x,
      z: v.z,
      heading: v.heading,
      speedMs: Math.abs(v.vx),
      speedKmh: v.speedKmh,
      gLong: v.gLong,
      gLat: v.gLat,
      brakePedal: v.brakePedal,
      lane,
      laneObj,
      limitKmh: this.world.speedLimitAt(v.x, v.z),
      zone: this.world.zoneAt(v.x, v.z),
      laneOffset: lane ? lane.lateral : 0,
      wrongWay,
      inBikeLane: laneObj?.kind === 'bike',
      inHovLane: !!laneObj?.isHov,
      offRoad: v.offRoad,
      approach,
      insideNode,
      leader,
      followingTimeGap: leader && Math.abs(v.vx) > 2 ? leader.gap / Math.abs(v.vx) : null,
      indicator: e.signal,
      indicatorAge: e.signalAgeS,
      lastMirror: e.lastMirrorCheck,
      lastShoulderLeft: e.lastShoulderLeft,
      lastShoulderRight: e.lastShoulderRight,
      headlights: e.headlights,
      wipers: e.wipers,
      night: e.sky.nightFactor,
      weatherKind: e.weather.kind,
      weatherSeverity: e.weather.severity,
      laneChanged,
      merged,
      enteredIntersection: entered,
      turnCompleted: turnDone,
      collision,
      streetcar,
      schoolBus,
      emergency,
      pxo,
      onMergeLane: !!laneObj?.merge,
      mergeLaneRemaining: laneObj?.merge && lane ? laneObj.len - lane.s : Infinity,
    };
    this.prev = ctx;
    return ctx;
  }
}

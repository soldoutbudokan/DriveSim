/**
 * Traffic manager: owns every road user (AI cars, streetcar, school bus,
 * emergency vehicles, cyclists, pedestrians), maintains per-lane occupancy
 * for leader queries, implements right-of-way primitives (conflict checks,
 * all-way-stop arrival queues, roundabout gaps, merge gap acceptance), and
 * keeps the population spawned around the player at the requested density.
 */

import * as THREE from 'three';
import { angleDiff, clamp, polylineAt, v2dist } from '../core/math';
import type { CityWorld } from '../world/world';
import type { Lane, RoadNetwork, Turn } from '../world/network';
import { buildCar, CarVisual } from '../vehicle/carFactory';
import type { CarKind } from '../vehicle/carFactory';
import { carOBB, type CircleCollider, type OBB } from '../physics/collision';
import { TrafficCar } from './agent';
import { idm, type LeaderInfo, type RoadUser } from './types';
import { Streetcar } from './streetcar';
import { SchoolBus } from './schoolbus';
import { EmergencyVehicle } from './emergency';
import { PedestrianSystem } from './pedestrian';
import { CyclistSystem } from './cyclist';

export interface TrafficContext {
  net: RoadNetwork;
  world: CityWorld;
  simTime: number;
  gripMul: number;
  lod: 'full' | 'far';
  leaderFor(agent: TrafficCar): LeaderInfo | null;
  conflictsClear(lane: Lane, turn: Turn): boolean;
  oncomingClear(lane: Lane, range: number): boolean;
  roundaboutClear(entryNodeId: string): boolean;
  registerArrival(nodeId: string, id: string): void;
  releaseArrival(nodeId: string, id: string): void;
  arrivalTurn(nodeId: string, id: string): boolean;
  boxClear(nodeId: string, selfId: string): boolean;
  parallelLanes(lane: Lane): Lane[];
  gapOk(target: Lane, user: RoadUser, speed: number): boolean;
  mergeTargetLane(lane: Lane): Lane | null;
  mergeGapOk(agent: TrafficCar, target: Lane): boolean;
  projectOnto(target: Lane, user: RoadUser): number | null;
  emergencyNearby(user: RoadUser): boolean;
}

interface OccEntry {
  s: number;
  u: RoadUser;
}

const AI_KINDS: Array<{ kind: CarKind; w: number }> = [
  { kind: 'sedan', w: 5 },
  { kind: 'hatch', w: 3 },
  { kind: 'suv', w: 3 },
  { kind: 'taxi', w: 1 },
  { kind: 'truck', w: 0.8 },
];
const AI_COLORS = [0x8a8d93, 0x33424f, 0x6d2e2a, 0x2e4d3a, 0xcfd2d6, 0x1d1f24, 0x596273, 0x7a5a3a, 0xa8552e, 0x46586a];

export class TrafficManager implements TrafficContext {
  readonly group = new THREE.Group();
  readonly net: RoadNetwork;
  readonly world: CityWorld;
  simTime = 0;
  gripMul = 1;
  lod: 'full' | 'far' = 'full';
  /** Target car population scale (settings). */
  density = 1;
  baseCars = 26;

  cars: TrafficCar[] = [];
  private visuals = new Map<string, CarVisual>();
  readonly streetcar: Streetcar;
  readonly schoolBus: SchoolBus;
  emergency: EmergencyVehicle | null = null;
  /** Spawn an emergency response every ~N seconds of driving (0 = off). */
  emergencyInterval = 240;
  private emergencyTimer = 130;
  readonly peds: PedestrianSystem;
  readonly cyclists: CyclistSystem;

  readonly playerUser: RoadUser = {
    id: 'player',
    kind: 'player',
    x: 0,
    z: 0,
    heading: 0,
    speed: 0,
    halfL: 2.3,
    halfW: 0.9,
    laneId: null,
    s: 0,
  };

  private occ = new Map<string, OccEntry[]>();
  private arrivals = new Map<string, string[]>();
  private arrivalStamp = new Map<string, number>();
  private playerArrivalNode: string | null = null;
  private nightFactor = 0;

  constructor(world: CityWorld) {
    this.world = world;
    this.net = world.net;
    this.streetcar = new Streetcar(world, this.group);
    this.schoolBus = new SchoolBus(world, this.group);
    this.peds = new PedestrianSystem(world, this.group);
    this.cyclists = new CyclistSystem(world, this.group);
  }

  /* ---------------- population ---------------- */

  private pickAiKind(): { kind: CarKind; color: number } {
    const total = AI_KINDS.reduce((a, k) => a + k.w, 0);
    let r = Math.random() * total;
    for (const k of AI_KINDS) {
      r -= k.w;
      if (r <= 0) return { kind: k.kind, color: AI_COLORS[Math.floor(Math.random() * AI_COLORS.length)] };
    }
    return { kind: 'sedan', color: 0x8a8d93 };
  }

  private spawnCar(px: number, pz: number): void {
    const drive = this.net.lanes.filter(
      (l) => l.kind === 'drive' && !l.merge && l.edge.def.kind !== 'lot' && l.edge.def.kind !== 'roundabout' && l.len > 40,
    );
    for (let tries = 0; tries < 24; tries++) {
      const lane = drive[Math.floor(Math.random() * drive.length)];
      const s = 12 + Math.random() * (lane.len - 26);
      const smp = polylineAt(lane.poly, s);
      const dp = Math.hypot(smp.point.x - px, smp.point.z - pz);
      if (dp < 60 || dp > 460) continue;
      const list = this.occ.get(lane.id) ?? [];
      if (list.some((e) => Math.abs(e.s - s) < 18)) continue;
      if (lane.closed && s > lane.closed[0] - 30 && s < lane.closed[1]) continue;
      const { kind, color } = this.pickAiKind();
      const built = buildCar(kind, color);
      const car = new TrafficCar(lane, s, built.dims.length / 2, built.dims.width / 2);
      car.kindName = kind;
      car.speed = (lane.speed / 3.6) * 0.7;
      const vis = new CarVisual(built);
      built.root.traverse((o) => (o.castShadow = o.castShadow || o.type === 'Mesh'));
      this.group.add(built.root);
      this.visuals.set(car.user.id, vis);
      this.cars.push(car);
      // seed occupancy immediately so later spawns this frame see it
      const arr = this.occ.get(lane.id) ?? [];
      arr.push({ s, u: car.user });
      this.occ.set(lane.id, arr);
      return;
    }
  }

  private maintainPopulation(px: number, pz: number): void {
    const target = Math.round(this.baseCars * this.density);
    // despawn far cars
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const d = Math.hypot(c.user.x - px, c.user.z - pz);
      if (d > 520 || (this.cars.length > target && d > 420)) {
        const vis = this.visuals.get(c.user.id);
        if (vis) {
          this.group.remove(vis.root);
          this.visuals.delete(c.user.id);
        }
        this.cars.splice(i, 1);
      }
    }
    let budget = 2;
    while (this.cars.length < target && budget-- > 0) this.spawnCar(px, pz);
  }

  /* ---------------- occupancy ---------------- */

  private addOcc(laneId: string | null, s: number, u: RoadUser): void {
    if (!laneId) return;
    let arr = this.occ.get(laneId);
    if (!arr) {
      arr = [];
      this.occ.set(laneId, arr);
    }
    arr.push({ s, u });
  }

  private rebuildOccupancy(): void {
    this.occ.clear();
    for (const c of this.cars) this.addOcc(c.user.laneId, c.user.s, c.user);
    this.addOcc(this.playerUser.laneId, this.playerUser.s, this.playerUser);
    // streetcar + door blockers
    this.streetcar.addOccupancy((laneId, s, u) => this.addOcc(laneId, s, u));
    this.schoolBus.addOccupancy((laneId, s, u) => this.addOcc(laneId, s, u));
    if (this.emergency?.active) this.addOcc(this.emergency.user.laneId, this.emergency.user.s, this.emergency.user);
    this.cyclists.addOccupancy((laneId, s, u) => this.addOcc(laneId, s, u));
    // PXO blockers when occupied/active
    const pxo = this.world.pxo;
    if (pxo.active || pxo.occupied > 0) {
      const edge = this.net.edge('qn4');
      for (const lane of this.net.lanes) {
        if (lane.edge !== edge || lane.kind !== 'drive') continue;
        const sPxo = lane.dir === 1 ? 150 : lane.len - 150;
        this.addOcc(lane.id, sPxo - 4, {
          id: `pxo-${lane.id}`,
          kind: 'blocker',
          x: pxo.x,
          z: pxo.z,
          heading: 0,
          speed: 0,
          halfL: 0.5,
          halfW: 1,
          laneId: lane.id,
          s: sPxo - 4,
        });
      }
    }
    for (const arr of this.occ.values()) arr.sort((a, b) => a.s - b.s);
  }

  /* ---------------- TrafficContext ---------------- */

  leaderFor(agent: TrafficCar): LeaderInfo | null {
    return this.leaderInLane(agent.lane, agent.s, agent.user.id, agent.user.halfL, agent.next?.lane ?? null);
  }

  private leaderInLane(lane: Lane, s: number, selfId: string, selfHalfL: number, nextLane: Lane | null): LeaderInfo | null {
    const list = this.occ.get(lane.id);
    let best: OccEntry | null = null;
    if (list) {
      for (const e of list) {
        if (e.u.id === selfId) continue;
        if (e.s > s + 0.3 && (!best || e.s < best.s)) best = e;
      }
    }
    if (best) {
      const gap = best.s - s - selfHalfL - best.u.halfL;
      if (gap < 75) return { user: best.u, gap: Math.max(gap, 0.05) };
    }
    // look into the next lane
    const remain = lane.len - s;
    if (remain < 60) {
      const follow = nextLane ?? this.net.successors(lane).find((l) => l.turn === 'straight')?.lane ?? null;
      if (follow) {
        const list2 = this.occ.get(follow.id);
        if (list2) {
          let b2: OccEntry | null = null;
          for (const e of list2) {
            if (e.u.id === selfId) continue;
            if (e.s < 55 && (!b2 || e.s < b2.s)) b2 = e;
          }
          if (b2) {
            const gap = remain + b2.s - selfHalfL - b2.u.halfL;
            if (gap < 75) return { user: b2.u, gap: Math.max(gap, 0.05) };
          }
        }
      }
    }
    return null;
  }

  /** Priority approaches into the node that conflict with this movement. */
  conflictsClear(lane: Lane, turn: Turn): boolean {
    const node = this.net.node(lane.toNode);
    const hMe = this.net.laneHeading(lane, lane.len - 2);
    for (const inb of node.inbound) {
      if (inb.edge === lane.edge) continue;
      if (this.net.approachControl(inb) !== 'none' && this.net.approachControl(inb) !== 'signal') continue; // they also stop/yield
      const hThem = this.net.laneHeading(inb, inb.len - 2);
      const rel = angleDiff(hThem, hMe);
      if (turn === 'right' && !(rel < -Math.PI / 4 && rel > (-3 * Math.PI) / 4)) continue; // only from-left conflicts
      const list = this.occ.get(inb.id);
      if (!list) continue;
      for (const e of list) {
        if (e.u.kind === 'blocker') continue;
        const dist = inb.len - e.s;
        if (dist < -2) continue;
        const ttc = e.u.speed > 0.5 ? dist / e.u.speed : dist < 10 ? 0 : Infinity;
        if (dist < 9 || ttc < 3.6) return false;
      }
    }
    return this.boxClear(lane.toNode, '');
  }

  oncomingClear(lane: Lane, range: number): boolean {
    const node = this.net.node(lane.toNode);
    const hMe = this.net.laneHeading(lane, lane.len - 2);
    for (const inb of node.inbound) {
      const hThem = this.net.laneHeading(inb, inb.len - 2);
      if (Math.abs(angleDiff(hThem, hMe)) < 2.5) continue; // not oncoming
      if (Math.abs(Math.abs(angleDiff(hThem, hMe)) - Math.PI) > 0.8) continue;
      const list = this.occ.get(inb.id);
      if (!list) continue;
      for (const e of list) {
        if (e.u.kind === 'blocker') continue;
        const dist = inb.len - e.s;
        if (dist < -2 || dist > range + 28) continue;
        if (e.u.speed < 0.4 && dist > 8) continue; // stopped & not at the box
        const ttc = e.u.speed > 0.5 ? dist / e.u.speed : Infinity;
        if (dist < 10 || ttc < 3.8) return false;
      }
    }
    return true;
  }

  roundaboutClear(entryNodeId: string): boolean {
    for (const edge of this.net.edges.values()) {
      if (edge.def.kind !== 'roundabout' || edge.def.to !== entryNodeId) continue;
      for (const lane of this.net.lanes) {
        if (lane.edge !== edge) continue;
        const list = this.occ.get(lane.id);
        if (!list) continue;
        for (const e of list) {
          if (e.u.kind === 'blocker') continue;
          const dist = lane.len - e.s;
          if (dist < 17) return false;
        }
      }
    }
    return true;
  }

  registerArrival(nodeId: string, id: string): void {
    let q = this.arrivals.get(nodeId);
    if (!q) {
      q = [];
      this.arrivals.set(nodeId, q);
    }
    if (!q.includes(id)) {
      q.push(id);
      this.arrivalStamp.set(`${nodeId}|${id}`, this.simTime);
    }
  }

  releaseArrival(nodeId: string, id: string): void {
    const q = this.arrivals.get(nodeId);
    if (!q) return;
    const i = q.indexOf(id);
    if (i >= 0) q.splice(i, 1);
    this.arrivalStamp.delete(`${nodeId}|${id}`);
  }

  arrivalTurn(nodeId: string, id: string): boolean {
    const q = this.arrivals.get(nodeId);
    if (!q || !q.length) return true;
    // stale head protection (e.g. player parked at the line forever)
    const head = q[0];
    const stamp = this.arrivalStamp.get(`${nodeId}|${head}`) ?? this.simTime;
    if (head !== id && this.simTime - stamp > 9) {
      q.shift();
      return this.arrivalTurn(nodeId, id);
    }
    return head === id;
  }

  boxClear(nodeId: string, selfId: string): boolean {
    const node = this.net.node(nodeId);
    const r = node.radius + 1.5;
    const check = (u: RoadUser): boolean => Math.hypot(u.x - node.def.x, u.z - node.def.z) < r;
    for (const c of this.cars) if (c.user.id !== selfId && check(c.user)) return false;
    if (selfId !== 'player' && this.playerUser.laneId && check(this.playerUser)) return false;
    if (this.peds.crossingAt(nodeId) > 0) return false;
    if (check(this.streetcar.user)) return false;
    return true;
  }

  parallelLanes(lane: Lane): Lane[] {
    return this.net.lanes.filter(
      (l) => l.edge === lane.edge && l.dir === lane.dir && l.kind === 'drive' && l.index !== lane.index,
    );
  }

  gapOk(target: Lane, user: RoadUser, speed: number): boolean {
    const list = this.occ.get(target.id);
    if (!list) return true;
    const s = user.s; // same edge ⇒ comparable arc length
    for (const e of list) {
      if (e.u.id === user.id) continue;
      const ds = e.s - s;
      if (ds >= 0 && ds - user.halfL - e.u.halfL < speed * 1.1 + 7) return false;
      if (ds < 0 && -ds - user.halfL - e.u.halfL < e.u.speed * 1.0 + 6) return false;
    }
    return true;
  }

  mergeTargetLane(lane: Lane): Lane | null {
    const node = this.net.node(lane.toNode);
    let best: Lane | null = null;
    for (const inb of node.inbound) {
      if (inb.edge === lane.edge || inb.kind !== 'drive') continue;
      if (!best || inb.index > best.index) best = inb;
    }
    return best;
  }

  projectOnto(target: Lane, user: RoadUser): number | null {
    // distance to shared node must match
    const myLane = this.net.lanes.find((l) => l.id === user.laneId);
    if (!myLane) return null;
    const distToNode = myLane.len - user.s;
    const proj = target.len - distToNode;
    return proj > 4 && proj < target.len - 2 ? proj : null;
  }

  mergeGapOk(agent: TrafficCar, target: Lane): boolean {
    const proj = this.projectOnto(target, agent.user);
    if (proj === null) return false;
    const list = this.occ.get(target.id);
    if (!list) return true;
    for (const e of list) {
      const ds = e.s - proj;
      if (ds >= 0 && ds - agent.user.halfL - e.u.halfL < agent.speed * 1.0 + 6) return false;
      if (ds < 0 && -ds - agent.user.halfL - e.u.halfL < e.u.speed * 1.1 + 7) return false;
    }
    return true;
  }

  emergencyNearby(user: RoadUser): boolean {
    const em = this.emergency;
    if (!em?.active) return false;
    return Math.hypot(user.x - em.user.x, user.z - em.user.z) < 80;
  }

  /* ---------------- per-frame ---------------- */

  /** Player following-distance info for the coaching engine. */
  playerLeader(): LeaderInfo | null {
    if (!this.playerUser.laneId) return null;
    const lane = this.net.laneById(this.playerUser.laneId);
    if (!lane) return null;
    return this.leaderInLane(lane, this.playerUser.s, 'player', this.playerUser.halfL, null);
  }

  /** All-way-stop bookkeeping for the player (AI waits its turn vs the player). */
  private updatePlayerArrival(): void {
    const lane = this.playerUser.laneId ? this.net.laneById(this.playerUser.laneId) : null;
    if (!lane) return;
    const node = this.net.node(lane.toNode);
    if (node.def.control === 'stop-all') {
      const d = this.net.stopLineS(lane) - this.playerUser.s;
      if (d < 4 && d > -2 && this.playerUser.speed < 0.5 && this.playerArrivalNode !== node.def.id) {
        this.registerArrival(node.def.id, 'player');
        this.playerArrivalNode = node.def.id;
      }
    }
    if (this.playerArrivalNode) {
      const n = this.net.node(this.playerArrivalNode);
      const dist = Math.hypot(this.playerUser.x - n.def.x, this.playerUser.z - n.def.z);
      if (dist < n.radius || dist > 14) {
        this.releaseArrival(this.playerArrivalNode, 'player');
        this.playerArrivalNode = null;
      }
    }
  }

  /** Whether it is the player's turn at an all-way stop they're waiting at. */
  playerArrivalStatus(): { node: string; myTurn: boolean } | null {
    if (!this.playerArrivalNode) return null;
    return { node: this.playerArrivalNode, myTurn: this.arrivalTurn(this.playerArrivalNode, 'player') };
  }

  update(
    dt: number,
    simTime: number,
    player: { x: number; z: number; heading: number; speed: number },
    gripMul: number,
    nightFactor: number,
  ): void {
    this.simTime = simTime;
    this.gripMul = gripMul;
    this.nightFactor = nightFactor;

    // player occupancy
    this.playerUser.x = player.x;
    this.playerUser.z = player.z;
    this.playerUser.heading = player.heading;
    this.playerUser.speed = player.speed;
    const hit = this.net.nearestLane({ x: player.x, z: player.z }, player.heading, 9);
    this.playerUser.laneId = hit ? hit.lane.id : null;
    this.playerUser.s = hit ? hit.s : 0;

    this.maintainPopulation(player.x, player.z);
    this.rebuildOccupancy();
    this.updatePlayerArrival();

    // emergency spawns
    if (this.emergencyInterval > 0) {
      this.emergencyTimer -= dt;
      if (this.emergencyTimer <= 0 && !this.emergency?.active) {
        this.spawnEmergency();
        this.emergencyTimer = this.emergencyInterval * (0.8 + Math.random() * 0.5);
      }
    }

    // agents
    for (const car of this.cars) {
      const d = Math.hypot(car.user.x - player.x, car.user.z - player.z);
      this.lod = d < 240 ? 'full' : 'far';
      car.update(dt, this);
      const vis = this.visuals.get(car.user.id);
      if (vis) {
        vis.root.position.set(car.user.x, car.elevatedY(), car.user.z);
        vis.root.rotation.set(0, car.user.heading, 0);
        vis.update(dt, simTime, car.speed, 0, {
          headlights: this.nightFactor > 0.45,
          braking: car.braking,
          reversing: false,
          signalLeft: car.signal === 'left',
          signalRight: car.signal === 'right',
          hazards: false,
        });
      }
    }

    this.streetcar.update(dt, this);
    this.schoolBus.update(dt, this);
    this.peds.update(dt, this);
    this.cyclists.update(dt, this);
    if (this.emergency) {
      this.emergency.update(dt, this);
      if (!this.emergency.active) {
        this.group.remove(this.emergency.visualRoot);
        this.emergency = null;
      }
    }
  }

  spawnEmergency(): void {
    if (this.emergency?.active) return;
    this.emergency = new EmergencyVehicle(this.world, this.group, { x: this.playerUser.x, z: this.playerUser.z });
  }

  /** Dynamic colliders near the player for physical collision + faults. */
  dynamicObstacles(px: number, pz: number, radius: number): { obbs: OBB[]; circles: CircleCollider[] } {
    const obbs: OBB[] = [];
    const circles: CircleCollider[] = [];
    const consider = (u: RoadUser, tag: string): void => {
      if (Math.hypot(u.x - px, u.z - pz) > radius) return;
      obbs.push({ x: u.x, z: u.z, heading: u.heading, halfL: u.halfL, halfW: u.halfW, tag, ref: u.id });
    };
    for (const c of this.cars) consider(c.user, 'traffic');
    consider(this.streetcar.user, 'streetcar');
    consider(this.schoolBus.user, 'schoolbus');
    if (this.emergency?.active) consider(this.emergency.user, 'emergency');
    for (const cy of this.cyclists.users) consider(cy, 'cyclist');
    for (const p of this.peds.users) {
      if (Math.hypot(p.x - px, p.z - pz) > radius) continue;
      circles.push({ x: p.x, z: p.z, r: 0.34, tag: 'pedestrian', ref: p.id });
    }
    return { obbs, circles };
  }

  /** Mark an AI car as crashed (player contact). */
  notifyHit(ref: unknown): void {
    const car = this.cars.find((c) => c.user.id === ref);
    car?.crash();
  }

  setDensity(d: number): void {
    this.density = clamp(d, 0.2, 2);
  }
}

// re-export for engine convenience
export { idm, v2dist, carOBB };

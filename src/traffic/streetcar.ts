/**
 * The Queen St streetcar: loops the streetcar route on the track (innermost)
 * lanes, dwells at stops with doors open — while doors are open, same-
 * direction traffic must stop behind the rear doors (enforced for AI via
 * occupancy blockers; the coaching engine grades the player).
 */

import * as THREE from 'three';
import { buildCar, type BuiltCar } from '../vehicle/carFactory';
import type { CityWorld } from '../world/world';
import type { Lane } from '../world/network';
import { STREETCAR_ROUTE, STREETCAR_STOPS } from '../world/map';
import { TrafficCar } from './agent';
import type { TrafficContext } from './manager';
import type { RoadUser } from './types';

export class Streetcar extends TrafficCar {
  doorsOpen = false;
  /** Set true for one poll when doors close (engine plays the bell). */
  bellPending = false;
  private dwell = 0;
  private stopsInLane: number[] = [];
  private stopsDone = new Set<number>();
  private built: BuiltCar;
  private world: CityWorld;

  constructor(world: CityWorld, parent: THREE.Group) {
    const lanes: Lane[] = [];
    for (const id of STREETCAR_ROUTE) {
      const l = world.net.laneById(`${id}:F0`);
      if (l) lanes.push(l);
    }
    for (const id of [...STREETCAR_ROUTE].reverse()) {
      const l = world.net.laneById(`${id}:B0`);
      if (l) lanes.push(l);
    }
    super(lanes[0], 10, 8, 1.27, 'streetcar');
    this.world = world;
    this.routePlan = lanes;
    this.noLaneChange = true;
    this.vCap = 9.5;
    this.built = buildCar('streetcar', 0xc02434);
    this.built.root.traverse((o) => (o.castShadow = true));
    parent.add(this.built.root);
    this.refreshStops();
  }

  protected override onLaneAdvanced(): void {
    this.refreshStops();
  }

  private refreshStops(): void {
    this.stopsInLane = [];
    this.stopsDone.clear();
    for (const st of STREETCAR_STOPS) {
      if (st.edgeId !== this.lane.edge.def.id) continue;
      this.stopsInLane.push(this.lane.dir === 1 ? st.s : this.lane.len - st.s);
    }
    this.stopsInLane.sort((a, b) => a - b);
  }

  override update(dt: number, ctx: TrafficContext): void {
    if (this.doorsOpen) {
      this.dwell -= dt;
      this.speed = 0;
      if (this.dwell <= 0) {
        this.doorsOpen = false;
        this.bellPending = true;
      }
      this.syncVisual(dt, ctx.simTime);
      return;
    }

    // approach a stop?
    const nextStop = this.stopsInLane.find((s, i) => !this.stopsDone.has(i) && s > this.s - 1);
    if (nextStop !== undefined) {
      const d = nextStop - this.s;
      if (d < 1.2 && this.speed < 0.4) {
        const idx = this.stopsInLane.indexOf(nextStop);
        this.stopsDone.add(idx);
        this.doorsOpen = true;
        this.dwell = 6.5 + Math.random() * 3;
        this.syncVisual(dt, ctx.simTime);
        return;
      }
      if (d < 40) {
        // brake for the stop (virtual leader)
        const a = Math.min(-0.2, -(this.speed * this.speed) / (2 * Math.max(d - 1, 0.4)));
        if (a < -0.25) {
          this.speed = Math.max(0, this.speed + Math.max(a, -2.6) * dt);
          this.s += this.speed * dt;
          this.syncVisual(dt, ctx.simTime);
          return;
        }
      }
    }

    super.update(dt, ctx);
    this.syncVisual(dt, ctx.simTime);
  }

  private syncVisual(dt: number, simTime: number): void {
    this.built.root.position.set(this.user.x, this.elevatedY(), this.user.z);
    this.built.root.rotation.set(0, this.user.heading, 0);
    const l = this.built.lights;
    l.head.emissiveIntensity = 1.8;
    l.tail.emissiveIntensity = this.braking || this.doorsOpen ? 3.5 : 0.9;
    const blink = simTime % 0.8 < 0.4;
    l.signalL.emissiveIntensity = this.doorsOpen && blink ? 3 : 0;
    l.signalR.emissiveIntensity = this.doorsOpen && blink ? 3 : 0;
    void dt;
  }

  /** Own occupancy + a blocker on the adjacent same-direction lane while doors are open. */
  addOccupancy(cb: (laneId: string, s: number, u: RoadUser) => void): void {
    cb(this.lane.id, this.s, this.user);
    if (this.doorsOpen) {
      const adjacent = this.world.net.lanes.find(
        (l) => l.edge === this.lane.edge && l.dir === this.lane.dir && l.kind === 'drive' && l.index !== this.lane.index,
      );
      if (adjacent) {
        cb(adjacent.id, this.s - this.user.halfL - 2.5, {
          id: 'streetcar-door-blocker',
          kind: 'blocker',
          x: this.user.x,
          z: this.user.z,
          heading: this.user.heading,
          speed: 0,
          halfL: 0.5,
          halfW: 1,
          laneId: adjacent.id,
          s: this.s - this.user.halfL - 2.5,
        });
      }
    }
  }
}

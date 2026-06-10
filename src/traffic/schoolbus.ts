/**
 * School bus on the residential loop: stops mid-block with red lights
 * flashing and the stop arm out — traffic in BOTH directions must stop
 * (undivided street). AI compliance via occupancy blockers; the coach grades
 * the player (passing a flashing school bus is an automatic fail in Ontario).
 */

import * as THREE from 'three';
import { buildCar, type BuiltCar } from '../vehicle/carFactory';
import type { CityWorld } from '../world/world';
import type { Lane } from '../world/network';
import { SCHOOLBUS_ROUTE } from '../world/map';
import { TrafficCar } from './agent';
import type { TrafficContext } from './manager';
import type { RoadUser } from './types';

export class SchoolBus extends TrafficCar {
  flashing = false;
  private dwell = 0;
  private stopDoneForLane = false;
  private built: BuiltCar;
  private world: CityWorld;

  constructor(world: CityWorld, parent: THREE.Group) {
    const lanes: Lane[] = [];
    for (const id of SCHOOLBUS_ROUTE) {
      const l = world.net.laneById(`${id}:F0`);
      if (l) lanes.push(l);
    }
    for (const id of [...SCHOOLBUS_ROUTE].reverse()) {
      const l = world.net.laneById(`${id}:B0`);
      if (l) lanes.push(l);
    }
    super(lanes[0], 14, 5.25, 1.25, 'schoolbus');
    this.world = world;
    this.routePlan = lanes;
    this.noLaneChange = true;
    this.vCap = 10;
    this.built = buildCar('schoolbus', 0xf2b705);
    this.built.root.traverse((o) => (o.castShadow = true));
    parent.add(this.built.root);
  }

  protected override onLaneAdvanced(): void {
    this.stopDoneForLane = false;
  }

  override update(dt: number, ctx: TrafficContext): void {
    if (this.flashing) {
      this.dwell -= dt;
      this.speed = 0;
      if (this.dwell <= 0) this.flashing = false;
      this.syncVisual(dt, ctx.simTime);
      return;
    }

    if (!this.stopDoneForLane && this.lane.len > 80) {
      const stopS = this.lane.len * 0.5;
      const d = stopS - this.s;
      if (d > 0 && d < 36) {
        const a = -(this.speed * this.speed) / (2 * Math.max(d - 1, 0.4));
        if (a < -0.25 || d < 2) {
          if (d < 1.4 && this.speed < 0.4) {
            this.stopDoneForLane = true;
            this.flashing = true;
            this.dwell = 8 + Math.random() * 3;
          } else {
            this.speed = Math.max(0, this.speed + Math.max(a, -2.4) * dt);
            this.s += this.speed * dt;
          }
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
    const flash = simTime % 0.6 < 0.3;
    if (this.built.lights.beaconA) this.built.lights.beaconA.emissiveIntensity = this.flashing && flash ? 4 : 0;
    if (this.built.lights.beaconB) this.built.lights.beaconB.emissiveIntensity = this.flashing && !flash ? 4 : 0;
    this.built.lights.tail.emissiveIntensity = this.braking || this.flashing ? 3.4 : 0.6;
    this.built.lights.head.emissiveIntensity = 1.4;
    void dt;
  }

  /** Blocks both directions while flashing. */
  addOccupancy(cb: (laneId: string, s: number, u: RoadUser) => void): void {
    cb(this.lane.id, this.s, this.user);
    if (this.flashing) {
      const oncoming = this.world.net.lanes.find(
        (l) => l.edge === this.lane.edge && l.dir !== this.lane.dir && l.kind === 'drive',
      );
      if (oncoming) {
        const sOn = oncoming.len - this.s - 13;
        cb(oncoming.id, sOn, {
          id: 'bus-blocker-oncoming',
          kind: 'blocker',
          x: this.user.x,
          z: this.user.z,
          heading: this.user.heading + Math.PI,
          speed: 0,
          halfL: 0.5,
          halfW: 1,
          laneId: oncoming.id,
          s: sOn,
        });
      }
    }
  }
}

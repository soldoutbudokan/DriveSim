/**
 * Emergency response: a police car / ambulance runs a route through the
 * district with lights + siren. Other AI pulls right and stops (manager);
 * the coaching engine grades the player's pull-over response.
 */

import * as THREE from 'three';
import { headingOf, polylineAt } from '../core/math';
import { buildCar, type BuiltCar } from '../vehicle/carFactory';
import type { CityWorld } from '../world/world';
import type { Lane } from '../world/network';
import type { TrafficContext } from './manager';
import type { RoadUser } from './types';

const ROUTE_ENDS = ['KW', 'KE', 'FU', 'QW', 'QE', 'FW', 'PD'];

export class EmergencyVehicle {
  active = true;
  readonly user: RoadUser;
  readonly visualRoot: THREE.Group;
  private built: BuiltCar;
  private lanes: Lane[] = [];
  private idx = 0;
  private s = 4;
  private speed = 8;

  constructor(world: CityWorld, parent: THREE.Group, near: { x: number; z: number }) {
    // start far from the player, end far on the other side, passing the middle
    const sorted = [...ROUTE_ENDS].sort((a, b) => {
      const na = world.net.node(a).def;
      const nb = world.net.node(b).def;
      return Math.hypot(nb.x - near.x, nb.z - near.z) - Math.hypot(na.x - near.x, na.z - near.z);
    });
    const start = sorted[0];
    const end = sorted[1] === start ? sorted[2] : sorted[1];
    const path = world.net.findPath(start, end) ?? [start, end];
    for (let i = 0; i < path.length - 1; i++) {
      const lane = world.net.laneBetween(path[i], path[i + 1], 0);
      if (lane) this.lanes.push(lane);
    }
    if (!this.lanes.length) this.active = false;

    const kind = Math.random() < 0.55 ? 'police' : 'ambulance';
    this.built = buildCar(kind, kind === 'police' ? 0xf2f4f6 : 0xfdfdfb);
    this.built.root.traverse((o) => (o.castShadow = true));
    this.visualRoot = this.built.root;
    parent.add(this.visualRoot);

    const lane = this.lanes[0];
    const smp = lane ? polylineAt(lane.poly, this.s) : { point: { x: 0, z: 0 }, dir: { x: 0, z: 1 } };
    this.user = {
      id: 'emergency',
      kind: 'emergency',
      x: smp.point.x,
      z: smp.point.z,
      heading: headingOf(smp.dir),
      speed: this.speed,
      halfL: this.built.dims.length / 2,
      halfW: this.built.dims.width / 2,
      laneId: lane?.id ?? null,
      s: this.s,
    };
  }

  update(dt: number, ctx: TrafficContext): void {
    if (!this.active) return;
    const lane = this.lanes[this.idx];
    if (!lane) {
      this.active = false;
      return;
    }
    // responder speed: well over the limit, slows through intersections
    const dEnd = lane.len - this.s;
    let v0 = Math.min((lane.speed / 3.6) * 1.5, 26);
    if (dEnd < 26 || this.s < 14) v0 *= 0.55;
    // don't plough through cars that haven't yielded yet
    const leader = ctx.leaderFor({ lane, s: this.s, user: this.user, next: null } as never);
    if (leader && leader.gap < 14) v0 = Math.min(v0, Math.max(leader.user.speed - 0.5, 2));
    this.speed += (v0 - this.speed) * Math.min(1, dt * 1.6);
    this.s += this.speed * dt;
    if (this.s >= lane.len) {
      this.idx++;
      this.s = 1;
      if (this.idx >= this.lanes.length) {
        this.active = false;
        return;
      }
    }
    const cur = this.lanes[this.idx];
    const smp = polylineAt(cur.poly, Math.min(this.s, cur.len));
    this.user.x = smp.point.x;
    this.user.z = smp.point.z;
    this.user.heading = headingOf(smp.dir);
    this.user.speed = this.speed;
    this.user.laneId = cur.id;
    this.user.s = this.s;

    this.visualRoot.position.set(this.user.x, 0, this.user.z);
    this.visualRoot.rotation.set(0, this.user.heading, 0);
    const flash = ctx.simTime % 0.3 < 0.15;
    if (this.built.lights.beaconA) this.built.lights.beaconA.emissiveIntensity = flash ? 5 : 0.3;
    if (this.built.lights.beaconB) this.built.lights.beaconB.emissiveIntensity = flash ? 0.3 : 5;
    this.built.lights.head.emissiveIntensity = flash ? 3 : 1.4;
  }
}

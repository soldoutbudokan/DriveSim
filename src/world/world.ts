/**
 * CityWorld: assembles the network, geometry, signals and props into the
 * drivable district, implements the engine's WorldBase (ground/limits/
 * location/spawn) and exposes the richer queries used by AI traffic, the
 * coaching engine and the examiner (signal state per lane, zones, PXO state,
 * maneuver locations, parking-gap geometry).
 */

import * as THREE from 'three';
import { nearestOnPolyline, polylineAt, headingOf, type V2 } from '../core/math';
import { CollisionWorld } from '../physics/collision';
import type { GroundSample, VehiclePose } from '../vehicle/vehicle';
import type { WorldBase } from '../core/engine';
import { RoadNetwork, type Lane, SIDEWALK_W } from './network';
import { buildMapDefs, LOT_RECT, MANEUVERS, PARKING_BAYS, PXO, SPAWNS, ZONES, type ZoneDef } from './map';
import { buildRoadGeometry, type RoadGroup } from './geometry';
import { SignalSystem, type LightState } from './signals';
import { buildProps, type PropsResult } from './props';

export interface ManeuverSpot {
  x: number;
  z: number;
  heading: number;
  edgeId: string;
  s: number;
}

export interface PxoState {
  x: number;
  z: number;
  heading: number;
  /** A pedestrian is waiting or crossing. */
  active: boolean;
  /** Number of pedestrians currently on the crossing. */
  occupied: number;
}

export class CityWorld implements WorldBase {
  readonly group = new THREE.Group();
  readonly collision = new CollisionWorld();
  readonly net: RoadNetwork;
  readonly signals: SignalSystem;
  readonly props: PropsResult;
  readonly pxo: PxoState;
  private roads: RoadGroup;
  readonly zones: ZoneDef[] = ZONES;

  constructor() {
    const t0 = performance.now();
    const defs = buildMapDefs();
    this.net = new RoadNetwork(defs.nodes, defs.edges);
    const t1 = performance.now();
    this.roads = buildRoadGeometry(this.net);
    this.group.add(this.roads);
    const t2 = performance.now();
    this.signals = new SignalSystem(this.net);
    this.group.add(this.signals.group);
    const t3 = performance.now();
    this.props = buildProps(this.net, this.collision);
    this.group.add(this.props.group);
    const t4 = performance.now();
    console.info(`DriveSim world built in ${Math.round(t4 - t0)} ms (network ${Math.round(t1 - t0)}, roads ${Math.round(t2 - t1)}, signals ${Math.round(t3 - t2)}, props ${Math.round(t4 - t3)})`);

    const pxoEdge = this.net.edge(PXO.edgeId);
    const smp = polylineAt(pxoEdge.center, PXO.s);
    this.pxo = { x: smp.point.x, z: smp.point.z, heading: headingOf(smp.dir), active: false, occupied: 0 };
    this.signals.buildPxo(this.pxo.x, this.pxo.z, this.pxo.heading);
    // zebra paint for the PXO
    this.paintPxo(smp.point, smp.dir, Math.max(pxoEdge.halfL, pxoEdge.halfR));
  }

  private paintPxo(p: V2, dir: V2, halfW: number): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0xdfe5ea, roughness: 0.7 });
    for (let t = -halfW + 0.6; t <= halfW - 0.6; t += 1.05) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 2.8), mat);
      bar.rotation.x = -Math.PI / 2;
      bar.rotation.z = -Math.atan2(dir.x, dir.z);
      bar.position.set(p.x + dir.z * t, 0.06, p.z - dir.x * t);
      bar.receiveShadow = true;
      this.group.add(bar);
    }
  }

  /* ---------------- WorldBase ---------------- */

  ground(x: number, z: number): GroundSample {
    // practice lot pad
    if (x >= LOT_RECT.x0 && x <= LOT_RECT.x1 && z >= LOT_RECT.z0 && z <= LOT_RECT.z1) {
      return { height: 0, mu: 1.0, offRoad: false, dragExtra: 0 };
    }
    const edges = this.net.edgesNear(x, z);
    let bestRoad: { h: number } | null = null;
    let bestWalk: { h: number } | null = null;
    for (const e of edges) {
      const near = nearestOnPolyline(e.center, { x, z });
      const onRoad = near.lateral <= e.halfL + 0.05 && near.lateral >= -e.halfR - 0.05;
      if (onRoad) {
        const h = e.elev(near.s);
        if (!bestRoad || h > bestRoad.h) bestRoad = { h };
      } else if (near.lateral <= e.halfL + SIDEWALK_W && near.lateral >= -e.halfR - SIDEWALK_W) {
        const h = e.elev(near.s) + 0.12;
        if (!bestWalk || h > bestWalk.h) bestWalk = { h };
      }
    }
    // intersection discs: near a node within radius counts as road
    if (!bestRoad) {
      for (const e of edges) {
        for (const nid of [e.def.from, e.def.to]) {
          const n = this.net.node(nid);
          const d = Math.hypot(x - n.def.x, z - n.def.z);
          if (d <= n.radius + 0.6) {
            bestRoad = { h: 0 };
            break;
          }
        }
        if (bestRoad) break;
      }
    }
    if (bestRoad) return { height: bestRoad.h, mu: 1.0, offRoad: false, dragExtra: 0 };
    if (bestWalk) return { height: bestWalk.h, mu: 0.85, offRoad: true, dragExtra: 250 };
    return { height: 0, mu: 0.55, offRoad: true, dragExtra: 750 };
  }

  speedLimitAt(x: number, z: number): number {
    for (const zone of this.zones) {
      if (x >= zone.x0 && x <= zone.x1 && z >= zone.z0 && z <= zone.z1) return zone.limit;
    }
    const hit = this.net.nearestLane({ x, z }, undefined, 16);
    return hit ? hit.lane.speed : 50;
  }

  zoneAt(x: number, z: number): ZoneDef | null {
    for (const zone of this.zones) {
      if (x >= zone.x0 && x <= zone.x1 && z >= zone.z0 && z <= zone.z1) return zone;
    }
    return null;
  }

  locationAt(x: number, z: number): { street: string; area: string } {
    if (x >= LOT_RECT.x0 && x <= LOT_RECT.x1 && z >= LOT_RECT.z0 && z <= LOT_RECT.z1) {
      return { street: 'DriveTest Centre', area: 'North End' };
    }
    const hit = this.net.nearestLane({ x, z }, undefined, 26);
    if (!hit) return { street: '—', area: '' };
    return { street: hit.lane.edge.def.name, area: hit.lane.edge.def.area };
  }

  spawn(): VehiclePose {
    const lane = this.net.laneById(`${SPAWNS.freeRoam.edgeId}:F${SPAWNS.freeRoam.lane}`);
    if (!lane) return { x: 0, z: 0, heading: 0 };
    const smp = polylineAt(lane.poly, SPAWNS.freeRoam.s);
    return { x: smp.point.x, z: smp.point.z, heading: headingOf(smp.dir) };
  }

  examSpawn(): VehiclePose {
    return { x: SPAWNS.examStart.x, z: SPAWNS.examStart.z, heading: SPAWNS.examStart.heading };
  }

  onPropHit(ref: unknown): void {
    const cone = this.props.cones[ref as number];
    if (cone && !cone.knocked) {
      cone.knocked = true;
      cone.t = 0;
      this.collision.removeCircle(cone.collider);
    }
  }

  setNight(f: number): void {
    this.props.setNight(f);
  }

  /** Rain sheen on asphalt / paint (0..1). */
  setWetness(f: number): void {
    this.roads.setWetness?.(f);
  }

  /** Snow cover on grass (0..1). */
  setSnow(f: number): void {
    this.props.setSnow(f);
  }

  update(dt: number, simTime: number): void {
    this.signals.update(simTime);
    this.signals.setPxoActive(this.pxo.active);
    for (const cone of this.props.cones) {
      if (cone.knocked && cone.t < 1) {
        cone.t = Math.min(1, cone.t + dt * 3);
        cone.mesh.rotation.z = (cone.t * Math.PI) / 2.2;
        cone.mesh.position.y = 0.3 - cone.t * 0.18;
      }
    }
  }

  /* ---------------- rich queries (AI / coaching / examiner) ---------------- */

  /** Signal state for a lane approaching its end node (null if not signalized). */
  signalForLane(lane: Lane, simTime: number): LightState | null {
    if (this.net.approachControl(lane) !== 'signal') return null;
    const h = this.net.laneHeading(lane, lane.len - 3);
    return this.signals.stateFor(lane.toNode, h, simTime);
  }

  maneuverSpot(key: keyof typeof MANEUVERS): ManeuverSpot {
    const m = MANEUVERS[key];
    const edge = this.net.edge(m.edgeId);
    const smp = polylineAt(edge.center, m.s);
    return { x: smp.point.x, z: smp.point.z, heading: headingOf(smp.dir), edgeId: m.edgeId, s: m.s };
  }

  /** Geometry of the parallel-parking gap (curb side, target box). */
  parkingGap(): { center: V2; heading: number; curbOffset: number; length: number; laneOffset: number } {
    const edge = this.net.edge(PARKING_BAYS.edgeId);
    const sMid = (PARKING_BAYS.gap0 + PARKING_BAYS.gap1) / 2;
    const smp = polylineAt(edge.center, sMid);
    const laneW = edge.laneW;
    const off = -(laneW + 2.3 / 2 + 0.15);
    return {
      center: { x: smp.point.x + smp.dir.z * off, z: smp.point.z - smp.dir.x * off },
      heading: headingOf(smp.dir),
      curbOffset: -(laneW + 2.3 + 0.15),
      length: PARKING_BAYS.gap1 - PARKING_BAYS.gap0,
      laneOffset: off,
    };
  }
}

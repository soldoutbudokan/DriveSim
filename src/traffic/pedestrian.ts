/**
 * Pedestrians: walk the sidewalks, cross at signalized/all-way intersections
 * on the proper phase, and use the Queen St PXO (activating its beacons —
 * vehicles must stop until the crossover is completely clear).
 */

import * as THREE from 'three';
import { mulberry32, polylineAt } from '../core/math';
import type { CityWorld } from '../world/world';
import type { EdgeRT } from '../world/network';
import { PXO } from '../world/map';
import type { TrafficContext } from './manager';

type PedState = 'walk' | 'waitCross' | 'cross' | 'pxoWait' | 'pxoCross';

interface Ped {
  id: string;
  group: THREE.Group;
  state: PedState;
  edge: EdgeRT;
  /** +1 = left sidewalk of from→to, -1 = right. */
  side: 1 | -1;
  s: number;
  dir: 1 | -1;
  speed: number;
  bobT: number;
  x: number;
  z: number;
  /** crossing progress 0..1 */
  crossT: number;
  crossingNode: string | null;
  waitT: number;
  pxoUser: boolean;
}

const COUNT = 14;
const SKIN = [0xc9a188, 0x8a6248, 0x6e4a34, 0xd8b49a];
const SHIRT = [0x5a7d9a, 0x9a5a5a, 0x6a8a5a, 0x8a7a9a, 0xd0c8b8, 0x44505e, 0xb86a3a];

export class PedestrianSystem {
  private peds: Ped[] = [];
  private world: CityWorld;
  private rng = mulberry32(99);

  constructor(world: CityWorld, parent: THREE.Group) {
    this.world = world;
    for (let i = 0; i < COUNT; i++) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.17, 0.2, 0.92, 7),
        new THREE.MeshStandardMaterial({ color: SHIRT[i % SHIRT.length], roughness: 0.9 }),
      );
      body.position.y = 0.78;
      body.castShadow = true;
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 7),
        new THREE.MeshStandardMaterial({ color: SKIN[i % SKIN.length], roughness: 0.8 }),
      );
      head.position.y = 1.42;
      const legs = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13, 0.16, 0.62, 7),
        new THREE.MeshStandardMaterial({ color: 0x2e3540, roughness: 0.95 }),
      );
      legs.position.y = 0.31;
      group.add(body, head, legs);
      parent.add(group);
      const ped: Ped = {
        id: `ped${i}`,
        group,
        state: 'walk',
        edge: world.net.edge('qn3'),
        side: 1,
        s: 10,
        dir: 1,
        speed: 1.1 + this.rng() * 0.5,
        bobT: this.rng() * 10,
        x: 0,
        z: 0,
        crossT: 0,
        crossingNode: null,
        waitT: 0,
        pxoUser: false,
      };
      this.respawn(ped, { x: 0, z: 100 });
      this.peds.push(ped);
    }
  }

  get users(): Array<{ id: string; x: number; z: number }> {
    return this.peds;
  }

  crossingAt(nodeId: string): number {
    let n = 0;
    for (const p of this.peds) if (p.crossingNode === nodeId && (p.state === 'cross' || p.state === 'waitCross')) n++;
    return n;
  }

  private walkableEdges(): EdgeRT[] {
    return [...this.world.net.edges.values()].filter(
      (e) => e.def.kind === 'city' || e.def.kind === 'residential',
    );
  }

  private respawn(ped: Ped, near: { x: number; z: number }): void {
    const edges = this.walkableEdges();
    for (let tries = 0; tries < 20; tries++) {
      const e = edges[Math.floor(this.rng() * edges.length)];
      const s = 8 + this.rng() * Math.max(8, e.len - 16);
      const smp = polylineAt(e.center, s);
      const d = Math.hypot(smp.point.x - near.x, smp.point.z - near.z);
      if (d < 40 || d > 300) continue;
      ped.edge = e;
      ped.s = s;
      ped.side = this.rng() < 0.5 ? 1 : -1;
      ped.dir = this.rng() < 0.5 ? 1 : -1;
      ped.state = 'walk';
      ped.crossingNode = null;
      ped.pxoUser = false;
      return;
    }
  }

  private sidewalkPos(ped: Ped): { x: number; z: number; heading: number } {
    const smp = polylineAt(ped.edge.center, ped.s);
    const off = ped.side * ((ped.side > 0 ? ped.edge.halfL : ped.edge.halfR) + 1.2);
    return {
      x: smp.point.x + smp.dir.z * off,
      z: smp.point.z - smp.dir.x * off,
      heading: Math.atan2(smp.dir.x * ped.dir, smp.dir.z * ped.dir),
    };
  }

  update(dt: number, ctx: TrafficContext): void {
    const player = ctx.world; // for pxo state
    void player;
    let pxoWaiting = 0;
    let pxoCrossing = 0;

    for (const ped of this.peds) {
      ped.bobT += dt * (ped.state === 'walk' || ped.state === 'cross' || ped.state === 'pxoCross' ? 7 : 0);

      if (ped.state === 'walk') {
        ped.s += ped.dir * ped.speed * dt;
        const pos = this.sidewalkPos(ped);
        ped.x = pos.x;
        ped.z = pos.z;
        ped.group.position.set(pos.x, 0.12 + Math.abs(Math.sin(ped.bobT)) * 0.03, pos.z);
        ped.group.rotation.y = pos.heading;

        // PXO opportunity
        if (ped.edge.def.id === PXO.edgeId && !ped.pxoUser && Math.abs(ped.s - PXO.s) < 1.6 && this.rng() < 0.012) {
          ped.state = 'pxoWait';
          ped.waitT = 1.4;
          ped.pxoUser = true;
        }

        // reached the end of the block?
        if (ped.s < 6 || ped.s > ped.edge.len - 6) {
          const nodeId = ped.s < 6 ? ped.edge.def.from : ped.edge.def.to;
          const node = this.world.net.node(nodeId);
          const canCross = (node.def.control === 'signal' || node.def.control === 'stop-all') && this.rng() < 0.4;
          if (canCross) {
            ped.state = 'waitCross';
            ped.crossingNode = nodeId;
            ped.crossT = 0;
            ped.waitT = 0;
          } else {
            // continue onto a random connected edge
            const options = node.edges.filter((e) => e !== ped.edge && (e.def.kind === 'city' || e.def.kind === 'residential'));
            if (options.length && this.rng() < 0.8) {
              const next = options[Math.floor(this.rng() * options.length)];
              const atStart = next.def.from === nodeId;
              ped.edge = next;
              ped.s = atStart ? 7 : next.len - 7;
              ped.dir = atStart ? 1 : -1;
              ped.side = this.rng() < 0.5 ? 1 : -1;
            } else {
              ped.dir = -ped.dir as 1 | -1;
              ped.s += ped.dir * 2;
            }
          }
        }
      } else if (ped.state === 'waitCross') {
        const nodeId = ped.crossingNode!;
        // cross my own street at this corner: allowed on the cross-street's green
        const axis = Math.abs(Math.sin(this.headingOfEdge(ped.edge))) > 0.7 ? 'ew' : 'ns';
        const node = this.world.net.node(nodeId);
        const ok =
          node.def.control === 'signal'
            ? this.world.signals.pedPhase(nodeId, axis === 'ns' ? 'ns' : 'ew', ctx.simTime)
            : (ped.waitT += dt) > 0.8;
        if (ok) {
          ped.state = 'cross';
          ped.crossT = 0;
        }
      } else if (ped.state === 'cross') {
        const width = ped.edge.halfL + ped.edge.halfR + 2.4;
        ped.crossT += (ped.speed * dt) / width;
        const sEnd = ped.s < ped.edge.len / 2 ? Math.max(ped.s, 7) : Math.min(ped.s, ped.edge.len - 7);
        const smp = polylineAt(ped.edge.center, sEnd);
        const startOff = ped.side * ((ped.side > 0 ? ped.edge.halfL : ped.edge.halfR) + 1.2);
        const endOff = -ped.side * ((ped.side > 0 ? ped.edge.halfR : ped.edge.halfL) + 1.2);
        const off = startOff + (endOff - startOff) * Math.min(ped.crossT, 1);
        ped.x = smp.point.x + smp.dir.z * off;
        ped.z = smp.point.z - smp.dir.x * off;
        ped.group.position.set(ped.x, 0.1 + Math.abs(Math.sin(ped.bobT)) * 0.03, ped.z);
        if (ped.crossT >= 1) {
          ped.side = -ped.side as 1 | -1;
          ped.state = 'walk';
          ped.crossingNode = null;
        }
      } else if (ped.state === 'pxoWait') {
        pxoWaiting++;
        ped.waitT -= dt;
        if (ped.waitT <= 0) {
          ped.state = 'pxoCross';
          ped.crossT = 0;
        }
      } else if (ped.state === 'pxoCross') {
        pxoCrossing++;
        const width = ped.edge.halfL + ped.edge.halfR + 2.4;
        ped.crossT += (ped.speed * 0.9 * dt) / width;
        const smp = polylineAt(ped.edge.center, PXO.s);
        const startOff = ped.side * ((ped.side > 0 ? ped.edge.halfL : ped.edge.halfR) + 1.2);
        const endOff = -ped.side * ((ped.side > 0 ? ped.edge.halfR : ped.edge.halfL) + 1.2);
        const off = startOff + (endOff - startOff) * Math.min(ped.crossT, 1);
        ped.x = smp.point.x + smp.dir.z * off;
        ped.z = smp.point.z - smp.dir.x * off;
        ped.group.position.set(ped.x, 0.1 + Math.abs(Math.sin(ped.bobT)) * 0.03, ped.z);
        if (ped.crossT >= 1) {
          ped.side = -ped.side as 1 | -1;
          ped.state = 'walk';
        }
      }

      // recycle far-away peds
      const dp = Math.hypot(ped.x - ctx.world.pxo.x, ped.z - ctx.world.pxo.z);
      void dp;
    }

    // PXO beacon state: active while anyone waits or crosses
    this.world.pxo.active = pxoWaiting > 0 || pxoCrossing > 0;
    this.world.pxo.occupied = pxoCrossing;
  }

  private headingOfEdge(edge: EdgeRT): number {
    const a = edge.center[0];
    const b = edge.center[edge.center.length - 1];
    return Math.atan2(b.x - a.x, b.z - a.z);
  }

  /** Re-seed pedestrians around a position (mode changes). */
  reseed(near: { x: number; z: number }): void {
    for (const ped of this.peds) this.respawn(ped, near);
  }
}

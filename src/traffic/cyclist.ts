/**
 * Cyclists: ride fixed loops in bike lanes (Palmerston, University) and —
 * Toronto classic — the Queen St curb lane, where cars must follow patiently.
 * They reuse the TrafficCar control logic so they stop at reds and stops.
 */

import * as THREE from 'three';
import type { CityWorld } from '../world/world';
import type { Lane } from '../world/network';
import { TrafficCar } from './agent';
import type { TrafficContext } from './manager';
import type { RoadUser } from './types';

const ROUTES: string[][] = [
  ['pm2:Fbike', 'pm3:Fbike', 'pm4:Fbike', 'pm5:Fbike', 'pm5:Bbike', 'pm4:Bbike', 'pm3:Bbike', 'pm2:Bbike'],
  ['uni3:Fbike', 'uni4:Fbike', 'uni4:Bbike', 'uni3:Bbike'],
  ['qn2:F1', 'qn3:F1', 'qn4:F1', 'qn5:F1', 'qn5:B1', 'qn4:B1', 'qn3:B1', 'qn2:B1'],
  ['shaw1:F0', 'shaw2:F0', 'shaw3:F0', 'shaw3:B0', 'shaw2:B0', 'shaw1:B0'],
];

class Cyclist extends TrafficCar {
  visual: THREE.Group;
  private wheelF: THREE.Mesh;
  private wheelR: THREE.Mesh;

  constructor(lanes: Lane[], startS: number, parent: THREE.Group) {
    super(lanes[0], startS, 0.95, 0.35, 'cyclist');
    this.routePlan = lanes;
    this.noLaneChange = true;
    this.vCap = 5 + Math.random() * 1.4;

    this.visual = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({ color: [0xc23b22, 0x2b6fb0, 0x3aa05a][Math.floor(Math.random() * 3)], roughness: 0.5, metalness: 0.4 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.5, 1.1), frameMat);
    frame.position.y = 0.65;
    const wheelGeo = new THREE.TorusGeometry(0.33, 0.045, 6, 14);
    this.wheelF = new THREE.Mesh(wheelGeo, new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.8 }));
    this.wheelF.position.set(0, 0.34, 0.55);
    this.wheelR = this.wheelF.clone();
    this.wheelR.position.set(0, 0.34, -0.55);
    const rider = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.17, 0.55, 3, 7),
      new THREE.MeshStandardMaterial({ color: [0x5a7d9a, 0x8a5a6a, 0x6a8a5a][Math.floor(Math.random() * 3)], roughness: 0.9 }),
    );
    rider.position.set(0, 1.18, -0.12);
    rider.rotation.x = 0.22;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 7, 6), new THREE.MeshStandardMaterial({ color: 0xd8b49a, roughness: 0.8 }));
    head.position.set(0, 1.62, 0.05);
    this.visual.add(frame, this.wheelF, this.wheelR, rider, head);
    this.visual.traverse((o) => (o.castShadow = true));
    parent.add(this.visual);
  }

  syncVisualState(simTime: number): void {
    this.visual.position.set(this.user.x, this.elevatedY(), this.user.z);
    this.visual.rotation.set(0, this.user.heading, 0);
    this.wheelF.rotation.x += this.speed * 0.05;
    this.wheelR.rotation.x = this.wheelF.rotation.x;
    void simTime;
  }
}

export class CyclistSystem {
  private cyclists: Cyclist[] = [];

  constructor(world: CityWorld, parent: THREE.Group) {
    for (const route of ROUTES) {
      const lanes: Lane[] = [];
      for (const id of route) {
        const l = world.net.laneById(id);
        if (l) lanes.push(l);
      }
      if (lanes.length >= 2) {
        this.cyclists.push(new Cyclist(lanes, 12 + Math.random() * 40, parent));
      }
    }
  }

  get users(): RoadUser[] {
    return this.cyclists.map((c) => c.user);
  }

  addOccupancy(cb: (laneId: string, s: number, u: RoadUser) => void): void {
    for (const c of this.cyclists) cb(c.user.laneId!, c.user.s, c.user);
  }

  update(dt: number, ctx: TrafficContext): void {
    for (const c of this.cyclists) {
      c.update(dt, ctx);
      c.syncVisualState(ctx.simTime);
    }
  }
}

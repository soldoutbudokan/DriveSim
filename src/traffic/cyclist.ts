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
import { buildFigure, type Figure } from './figure';

const ROUTES: string[][] = [
  ['pm2:Fbike', 'pm3:Fbike', 'pm4:Fbike', 'pm5:Fbike', 'pm5:Bbike', 'pm4:Bbike', 'pm3:Bbike', 'pm2:Bbike'],
  ['uni3:Fbike', 'uni4:Fbike', 'uni4:Bbike', 'uni3:Bbike'],
  ['qn2:F1', 'qn3:F1', 'qn4:F1', 'qn5:F1', 'qn5:B1', 'qn4:B1', 'qn3:B1', 'qn2:B1'],
  ['shaw1:F0', 'shaw2:F0', 'shaw3:F0', 'shaw3:B0', 'shaw2:B0', 'shaw1:B0'],
];

class Cyclist extends TrafficCar {
  visual: THREE.Group;
  private wheelF: THREE.Group;
  private wheelR: THREE.Group;
  private crank: THREE.Group;
  private rider: Figure;
  private crankAngle = 0;

  constructor(lanes: Lane[], startS: number, parent: THREE.Group) {
    super(lanes[0], startS, 0.95, 0.35, 'cyclist');
    this.routePlan = lanes;
    this.noLaneChange = true;
    this.vCap = 5 + Math.random() * 1.4;

    this.visual = new THREE.Group();
    const frameCol = [0xc23b22, 0x2b6fb0, 0x3aa05a, 0x222226, 0xe8e2d0][Math.floor(Math.random() * 5)];
    const frameMat = new THREE.MeshStandardMaterial({ color: frameCol, roughness: 0.4, metalness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.8 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.3, metalness: 0.9 });
    const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material): THREE.Mesh => {
      const len = a.distanceTo(b);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), m);
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3().subVectors(b, a).normalize());
      return mesh;
    };
    const R = 0.34;
    const bb = new THREE.Vector3(0, 0.3, 0.05); // bottom bracket
    const seat = new THREE.Vector3(0, 0.95, -0.2);
    const head = new THREE.Vector3(0, 0.85, 0.5);
    const rearHub = new THREE.Vector3(0, R, -0.55);
    const frontHub = new THREE.Vector3(0, R, 0.58);
    this.visual.add(
      tube(bb, seat, 0.018, frameMat),
      tube(bb, head, 0.02, frameMat),
      tube(seat, new THREE.Vector3(0, 0.88, 0.45), 0.018, frameMat),
      tube(bb, rearHub, 0.012, frameMat),
      tube(seat, rearHub, 0.012, frameMat),
      tube(head, frontHub, 0.014, frameMat),
      tube(new THREE.Vector3(-0.22, 0.98, 0.5), new THREE.Vector3(0.22, 0.98, 0.5), 0.012, chrome),
      tube(new THREE.Vector3(0, 0.88, 0.45), new THREE.Vector3(0, 0.98, 0.5), 0.014, chrome),
    );
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.26), dark);
    saddle.position.set(0, 0.99, -0.22);
    this.visual.add(saddle);
    const mkWheel = (): THREE.Group => {
      const g = new THREE.Group();
      const tire = new THREE.Mesh(new THREE.TorusGeometry(R, 0.03, 8, 24), dark);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(R - 0.035, 0.012, 6, 24), chrome);
      g.add(tire, rim);
      for (let i = 0; i < 6; i++) {
        const sp = new THREE.Mesh(new THREE.BoxGeometry(0.006, R * 2 - 0.08, 0.006), chrome);
        sp.rotation.z = (i / 6) * Math.PI;
        g.add(sp);
      }
      g.rotation.y = Math.PI / 2;
      return g;
    };
    this.wheelF = mkWheel();
    this.wheelF.position.copy(frontHub);
    this.wheelR = mkWheel();
    this.wheelR.position.copy(rearHub);
    this.crank = new THREE.Group();
    this.crank.position.copy(bb);
    for (const s of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.02), chrome);
      arm.position.set(s * 0.07, s * 0.08, 0);
      const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.06), dark);
      pedal.position.set(s * 0.1, s * 0.16, 0);
      this.crank.add(arm, pedal);
    }
    this.visual.add(this.wheelF, this.wheelR, this.crank);
    // rider: seated figure, helmet
    this.rider = buildFigure(Math.random, 0.95);
    this.rider.root.position.set(0, 0.2, -0.15);
    this.rider.pedal(0);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshStandardMaterial({ color: [0xe6e6e6, 0x2b2b2b, 0xd93b3b][Math.floor(Math.random() * 3)], roughness: 0.5 }));
    helmet.position.y = 0.79 * 0.95;
    this.rider.torso.add(helmet);
    this.visual.add(this.rider.root);
    this.visual.traverse((o) => (o.castShadow = true));
    parent.add(this.visual);
  }

  syncVisualState(dt: number): void {
    this.visual.position.set(this.user.x, this.elevatedY(), this.user.z);
    this.visual.rotation.set(0, this.user.heading, 0);
    const spin = (this.speed / 0.34) * dt;
    this.wheelF.rotation.x += spin;
    this.wheelR.rotation.x += spin;
    this.crankAngle += spin * 0.42;
    this.crank.rotation.x = this.crankAngle;
    this.rider.pedal(this.crankAngle);
    this.visual.rotation.z = -this.steerLean();
  }

  private steerLean(): number {
    return 0;
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
      c.syncVisualState(dt);
    }
  }
}

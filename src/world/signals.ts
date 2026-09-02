/**
 * Ontario traffic signals: per-node phase controllers with protected-left
 * ("advanced green" left arrow) phases, amber + all-red clearance and
 * pedestrian walk phases. Each approach gets a Toronto-style mast-arm
 * assembly: a tapered pole on the far-right corner, a horizontal arm over
 * the roadway carrying the primary head (black housing, visors, yellow
 * backboard, optional arrow section), a secondary head on the pole,
 * pedestrian walk/hand heads with push buttons, and street-lighting on the
 * arm. Lens materials are shared per controller axis so every lit lens of
 * the same colour is one draw call. Also the PXO (pedestrian crossover)
 * beacons.
 */

import * as THREE from 'three';
import type { RoadNetwork, NodeRT } from './network';
import { compassOf } from './network';
import { signTexture } from './textures';
import { GeoBatch } from './batch';

export type Compass = 'N' | 'S' | 'E' | 'W';

export interface LightState {
  ball: 'red' | 'amber' | 'green';
  /** Protected left arrow active (flashing). */
  leftArrow: boolean;
  /** Pedestrians may start crossing parallel to this approach. */
  pedWalk: boolean;
  /** Seconds until the ball changes (rough, for AI dilemma decisions). */
  timeToChange: number;
}

interface Phase {
  dur: number;
  ns: 'red' | 'amber' | 'green' | 'arrow';
  ew: 'red' | 'amber' | 'green' | 'arrow';
}

interface AxisMats {
  red: THREE.MeshStandardMaterial;
  amber: THREE.MeshStandardMaterial;
  green: THREE.MeshStandardMaterial;
  arrow: THREE.MeshStandardMaterial;
  /** Pedestrian heads for people crossing the OTHER axis (walk with this axis' green). */
  walk: THREE.MeshStandardMaterial;
  hand: THREE.MeshStandardMaterial;
}

interface Controller {
  node: NodeRT;
  phases: Phase[];
  cycle: number;
  offset: number;
  ns: AxisMats;
  ew: AxisMats;
}

function lensMat(color: number, base = 0x151617): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: base,
    roughness: 0.35,
    metalness: 0.05,
    emissive: new THREE.Color(color),
    emissiveIntensity: 0,
  });
}

const HEAD_W = 0.36;
const SECTION = 0.4;

export class SignalSystem {
  readonly group = new THREE.Group();
  private controllers = new Map<string, Controller>();
  private pxoBeacons: THREE.MeshStandardMaterial[] = [];
  private batch = new GeoBatch();
  private lensBatch = new GeoBatch();
  private lensMats = new Map<string, THREE.Material>();
  private staticMats = new Map<string, THREE.Material>([
    ['pole', new THREE.MeshStandardMaterial({ color: 0x5c6167, roughness: 0.45, metalness: 0.7 })],
    ['housing', new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.6, metalness: 0.3 })],
    ['board', new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 })],
    ['boardEdge', new THREE.MeshStandardMaterial({ color: 0xf2c31a, roughness: 0.6 })],
    ['button', new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.5, metalness: 0.4 })],
  ]);
  pxoActive = false;

  constructor(net: RoadNetwork) {
    this.group.name = 'signals';
    for (const node of net.nodes.values()) {
      if (node.def.control !== 'signal') continue;
      const cfg = node.def.signal ?? {};
      const nsG = cfg.nsGreen ?? 16;
      const ewG = cfg.ewGreen ?? 16;
      const phases: Phase[] = [];
      if (cfg.advance === 'EW') phases.push({ dur: 7, ns: 'red', ew: 'arrow' });
      phases.push({ dur: ewG, ns: 'red', ew: 'green' });
      phases.push({ dur: 3.4, ns: 'red', ew: 'amber' });
      phases.push({ dur: 1.6, ns: 'red', ew: 'red' });
      if (cfg.advance === 'NS') phases.push({ dur: 7, ns: 'arrow', ew: 'red' });
      phases.push({ dur: nsG, ns: 'green', ew: 'red' });
      phases.push({ dur: 3.4, ns: 'amber', ew: 'red' });
      phases.push({ dur: 1.6, ns: 'red', ew: 'red' });
      const cycle = phases.reduce((a, p) => a + p.dur, 0);
      const mk = (): AxisMats => ({
        red: lensMat(0xff2d20),
        amber: lensMat(0xffb024),
        green: lensMat(0x2bd966),
        arrow: lensMat(0x2bd966),
        walk: lensMat(0xf4f8ff, 0x2a2c30),
        hand: lensMat(0xff7a1a, 0x2a2c30),
      });
      const ctrl: Controller = { node, phases, cycle, offset: cfg.offset ?? 0, ns: mk(), ew: mk() };
      this.buildAssemblies(ctrl, net, cfg.advance);
      this.controllers.set(node.def.id, ctrl);
    }
    this.batch.build(this.staticMats, this.group);
    this.lensBatch.build(this.lensMats, this.group, { shadows: false, receive: false });
  }

  /** One mast-arm assembly per approach that actually carries traffic. */
  private buildAssemblies(ctrl: Controller, net: RoadNetwork, advance?: 'NS' | 'EW'): void {
    const { x, z } = ctrl.node.def;
    const r = ctrl.node.radius;
    const approaches = new Set<Compass>();
    for (const lane of ctrl.node.inbound) approaches.add(compassOf(net.laneHeading(lane, lane.len - 2)));
    const id = ctrl.node.def.id;
    for (const c of approaches) {
      const heading = c === 'N' ? 0 : c === 'S' ? Math.PI : c === 'E' ? Math.PI / 2 : -Math.PI / 2;
      const fx = Math.sin(heading);
      const fz = Math.cos(heading);
      const rx = -Math.cos(heading); // right of travel
      const rz = Math.sin(heading);
      const axis = c === 'N' || c === 'S' ? 'ns' : 'ew';
      const other = axis === 'ns' ? 'ew' : 'ns';
      const mats = ctrl[axis];
      // pole at the far-right corner
      const px = x + fx * (r + 1.3) + rx * (r + 1.3);
      const pz = z + fz * (r + 1.3) + rz * (r + 1.3);
      const faceY = heading + Math.PI; // heads face approaching traffic
      const b = this.batch;
      b.add('pole', new THREE.CylinderGeometry(0.28, 0.32, 0.5, 10), px, 0.25, pz);
      b.add('pole', new THREE.CylinderGeometry(0.1, 0.16, 6.6, 10), px, 3.3, pz);
      // mast arm: tapered, back over the approach lanes toward the road centre
      const armLen = r + 1.0;
      const armGeo = new THREE.CylinderGeometry(0.06, 0.1, armLen, 8);
      armGeo.rotateZ(Math.PI / 2);
      armGeo.translate(-armLen / 2, 0, 0);
      const armYaw = Math.atan2(-rx, -rz) + Math.PI / 2; // arm points along -right
      b.add('pole', armGeo, px, 6.2, pz, armYaw);
      // brace
      b.add('pole', new THREE.CylinderGeometry(0.025, 0.025, 2.6, 6), px - rx * 1.1, 5.4, pz - rz * 1.1, armYaw, 1, 1, 1, 0, 0.9);
      // street light on the arm tip side
      b.add('pole', new THREE.BoxGeometry(0.3, 0.14, 0.7), px - rx * 1.0, 6.85, pz - rz * 1.0, heading);

      // primary head hanging from the arm over the left-ish lanes, secondary on the pole
      const hasArrow = (advance === 'NS' && axis === 'ns') || (advance === 'EW' && axis === 'ew');
      const primX = px - rx * (armLen - 1.2);
      const primZ = pz - rz * (armLen - 1.2);
      this.head(primX, 5.25, primZ, faceY, mats, hasArrow, true, `${id}-${axis}`);
      this.head(px - fx * 0.15 + rx * -0.35, 3.6, pz - fz * 0.15 + rz * -0.35, faceY, mats, false, false, `${id}-${axis}`);

      // pedestrian heads + push button on the pole
      const pedKey = `${id}-${axis}-ped`;
      this.pedHead(px - fx * 0.25, 2.5, pz - fz * 0.25, faceY, mats, pedKey);
      const pedKey2 = `${id}-${other}-ped`;
      this.pedHead(px - rx * 0.25, 2.5, pz - rz * 0.25, Math.atan2(-rx, -rz), ctrl[other], pedKey2);
      b.add('button', new THREE.BoxGeometry(0.12, 0.18, 0.08), px - fx * 0.18, 1.05, pz - fz * 0.18, faceY);
      // street name blade holder on the arm
      b.add('pole', new THREE.BoxGeometry(0.03, 0.03, 0.03), px, 6.2, pz);
    }
  }

  private head(x: number, y: number, z: number, faceY: number, mats: AxisMats, arrow: boolean, backboard: boolean, key: string): void {
    const b = this.batch;
    const sections = arrow ? 4 : 3;
    const H = sections * SECTION;
    b.add('housing', new THREE.BoxGeometry(HEAD_W, H, 0.28), x, y, z, faceY);
    if (backboard) {
      b.add('board', new THREE.BoxGeometry(HEAD_W + 0.42, H + 0.42, 0.03), x, y, z - 0.0, faceY);
      // yellow reflective border
      const bw = HEAD_W + 0.42;
      const bh = H + 0.42;
      for (const [dx, dy, w, h] of [[0, bh / 2 - 0.03, bw, 0.06], [0, -bh / 2 + 0.03, bw, 0.06], [-bw / 2 + 0.03, 0, 0.06, bh], [bw / 2 - 0.03, 0, 0.06, bh]]) {
        b.add('boardEdge', new THREE.BoxGeometry(w, h, 0.032), x + Math.cos(faceY) * dx, y + dy, z - Math.sin(faceY) * dx, faceY);
      }
    }
    // hanger to the arm
    b.add('pole', new THREE.CylinderGeometry(0.03, 0.03, 0.6, 6), x, y + H / 2 + 0.3, z);
    const lensZ = 0.145;
    const order: Array<[keyof AxisMats, number]> = arrow
      ? [['red', 1.5], ['amber', 0.5], ['green', -0.5], ['arrow', -1.5]]
      : [['red', 1], ['amber', 0], ['green', -1]];
    for (const [name, slot] of order) {
      const ly = y + slot * SECTION;
      // visor hood over each lens (half cylinder)
      const visor = new THREE.CylinderGeometry(0.17, 0.17, 0.22, 10, 1, true, 0, Math.PI);
      visor.rotateX(Math.PI / 2);
      visor.rotateY(Math.PI);
      b.add('housing', visor, x + Math.sin(faceY) * (lensZ + 0.02), ly + 0.02, z + Math.cos(faceY) * (lensZ + 0.02), faceY);
      const matKey = `${key}-${name}`;
      if (!this.lensMats.has(matKey)) this.lensMats.set(matKey, mats[name]);
      const lens = name === 'arrow' ? arrowGeo() : new THREE.CircleGeometry(0.135, 18);
      this.lensBatch.add(matKey, lens, x + Math.sin(faceY) * lensZ, ly, z + Math.cos(faceY) * lensZ, faceY);
    }
  }

  private pedHead(x: number, y: number, z: number, faceY: number, mats: AxisMats, key: string): void {
    const b = this.batch;
    b.add('housing', new THREE.BoxGeometry(0.34, 0.4, 0.22), x, y, z, faceY);
    b.add('housing', new THREE.BoxGeometry(0.36, 0.05, 0.3), x, y + 0.22, z + 0.0, faceY);
    const lensZ = 0.115;
    for (const [name, dx] of [['walk', 0.08], ['hand', -0.08]] as Array<[keyof AxisMats, number]>) {
      const matKey = `${key}-${name}`;
      if (!this.lensMats.has(matKey)) this.lensMats.set(matKey, mats[name]);
      const geo = name === 'walk' ? walkGeo() : handGeo();
      this.lensBatch.add(matKey, geo, x + Math.sin(faceY) * lensZ + Math.cos(faceY) * dx, y, z + Math.cos(faceY) * lensZ - Math.sin(faceY) * dx, faceY);
    }
  }

  /** Build the PXO overhead beacon set at a world position (called by world). */
  buildPxo(x: number, z: number, heading: number): void {
    const poleMat = this.staticMats.get('pole')!;
    for (const side of [-1, 1]) {
      const px = x + Math.cos(heading) * side * 8;
      const pz = z - Math.sin(heading) * side * 8;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 5.2, 8), poleMat);
      pole.position.set(px, 2.6, pz);
      pole.castShadow = true;
      this.group.add(pole);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.2, 8), poleMat);
      arm.rotation.z = Math.PI / 2;
      arm.rotation.y = heading + Math.PI / 2;
      arm.position.set(px - Math.cos(heading) * side * 1.1, 5.1, pz + Math.sin(heading) * side * 1.1);
      this.group.add(arm);
      const beacon = lensMat(0xffb024);
      for (const dy of [0, 0.5]) {
        const hood = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), this.staticMats.get('housing')!);
        hood.position.set(px - Math.cos(heading) * side * 2.1, 5.1 - dy, pz + Math.sin(heading) * side * 2.1);
        this.group.add(hood);
        for (const f of [heading + Math.PI / 2, heading - Math.PI / 2]) {
          const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.12, 14), beacon);
          lamp.position.set(hood.position.x + Math.sin(f) * 0.16, hood.position.y, hood.position.z + Math.cos(f) * 0.16);
          lamp.rotation.y = f;
          this.group.add(lamp);
        }
      }
      this.pxoBeacons.push(beacon);
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(0.74, 0.74),
        new THREE.MeshStandardMaterial({ map: signTexture('pxo'), roughness: 0.55, side: THREE.DoubleSide }),
      );
      sign.position.set(px, 3.8, pz);
      sign.rotation.y = heading + Math.PI / 2;
      this.group.add(sign);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.76, 0.03), this.staticMats.get('housing')!);
      back.position.copy(sign.position);
      back.rotation.y = sign.rotation.y;
      this.group.add(back);
    }
  }

  private phaseAt(ctrl: Controller, simTime: number): { phase: Phase; remain: number } {
    let t = (simTime + ctrl.offset) % ctrl.cycle;
    for (const p of ctrl.phases) {
      if (t < p.dur) return { phase: p, remain: p.dur - t };
      t -= p.dur;
    }
    return { phase: ctrl.phases[0], remain: ctrl.phases[0].dur };
  }

  /** Signal state for traffic approaching `nodeId` heading `approachHeading`. */
  stateFor(nodeId: string, approachHeading: number, simTime: number): LightState | null {
    const ctrl = this.controllers.get(nodeId);
    if (!ctrl) return null;
    const compass = compassOf(approachHeading);
    const axis = compass === 'N' || compass === 'S' ? 'ns' : 'ew';
    const { phase, remain } = this.phaseAt(ctrl, simTime);
    const own = axis === 'ns' ? phase.ns : phase.ew;
    const ball: LightState['ball'] = own === 'green' ? 'green' : own === 'amber' ? 'amber' : 'red';
    const leftArrow = own === 'arrow';
    const pedWalk = own === 'green' && remain > 6;
    return { ball, leftArrow, pedWalk, timeToChange: remain };
  }

  /** Whether pedestrians may cross the street that runs along `axis` at this node. */
  pedPhase(nodeId: string, crossingAxis: 'ns' | 'ew', simTime: number): boolean {
    const ctrl = this.controllers.get(nodeId);
    if (!ctrl) return true; // stop-controlled: peds have priority
    const { phase, remain } = this.phaseAt(ctrl, simTime);
    // crossing the NS street means walking with EW green
    const own = crossingAxis === 'ns' ? phase.ew : phase.ns;
    return own === 'green' && remain > 5;
  }

  setPxoActive(on: boolean): void {
    this.pxoActive = on;
  }

  update(simTime: number): void {
    const flash = simTime % 0.66 < 0.36;
    const pedFlash = simTime % 1.0 < 0.5;
    for (const ctrl of this.controllers.values()) {
      const { phase, remain } = this.phaseAt(ctrl, simTime);
      for (const axis of ['ns', 'ew'] as const) {
        const state = phase[axis];
        const m = ctrl[axis];
        m.red.emissiveIntensity = state === 'red' || state === 'arrow' ? 3.4 : 0;
        m.amber.emissiveIntensity = state === 'amber' ? 3.6 : 0;
        m.green.emissiveIntensity = state === 'green' ? 3.2 : 0;
        m.arrow.emissiveIntensity = state === 'arrow' && flash ? 3.6 : 0;
        // pedestrians parallel to this axis: walk while green with time left, flashing hand near the end
        const walk = state === 'green' && remain > 6;
        const clearing = state === 'green' && remain <= 6;
        m.walk.emissiveIntensity = walk ? 2.6 : 0;
        m.hand.emissiveIntensity = clearing ? (pedFlash ? 3 : 0) : walk ? 0 : 3;
      }
    }
    const pxFlash = simTime % 0.8 < 0.4;
    for (const b of this.pxoBeacons) b.emissiveIntensity = this.pxoActive && pxFlash ? 3.5 : 0;
  }
}

let arrowCache: THREE.BufferGeometry | null = null;
function arrowGeo(): THREE.BufferGeometry {
  if (arrowCache) return arrowCache;
  const s = new THREE.Shape();
  s.moveTo(-0.13, 0);
  s.lineTo(-0.03, 0.1);
  s.lineTo(-0.03, 0.035);
  s.lineTo(0.12, 0.035);
  s.lineTo(0.12, -0.035);
  s.lineTo(-0.03, -0.035);
  s.lineTo(-0.03, -0.1);
  s.closePath();
  arrowCache = new THREE.ShapeGeometry(s);
  return arrowCache;
}

let walkCache: THREE.BufferGeometry | null = null;
function walkGeo(): THREE.BufferGeometry {
  if (walkCache) return walkCache;
  const s = new THREE.Shape();
  // simple walking figure silhouette
  s.moveTo(-0.02, 0.12);
  s.lineTo(0.02, 0.12);
  s.lineTo(0.03, 0.05);
  s.lineTo(0.07, 0.0);
  s.lineTo(0.05, -0.02);
  s.lineTo(0.02, 0.02);
  s.lineTo(0.03, -0.12);
  s.lineTo(0.0, -0.12);
  s.lineTo(-0.01, -0.04);
  s.lineTo(-0.05, -0.12);
  s.lineTo(-0.08, -0.11);
  s.lineTo(-0.03, 0.0);
  s.lineTo(-0.03, 0.05);
  s.closePath();
  walkCache = new THREE.ShapeGeometry(s);
  return walkCache;
}

let handCache: THREE.BufferGeometry | null = null;
function handGeo(): THREE.BufferGeometry {
  if (handCache) return handCache;
  const s = new THREE.Shape();
  s.moveTo(-0.07, -0.1);
  s.lineTo(0.07, -0.1);
  s.lineTo(0.07, 0.02);
  s.lineTo(0.05, 0.11);
  s.lineTo(0.03, 0.11);
  s.lineTo(0.03, 0.03);
  s.lineTo(0.01, 0.12);
  s.lineTo(-0.01, 0.12);
  s.lineTo(-0.01, 0.03);
  s.lineTo(-0.03, 0.1);
  s.lineTo(-0.05, 0.1);
  s.lineTo(-0.05, 0.0);
  s.lineTo(-0.07, -0.02);
  s.closePath();
  handCache = new THREE.ShapeGeometry(s);
  return handCache;
}

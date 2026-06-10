/**
 * Ontario traffic signals: per-node phase controllers with protected-left
 * ("advanced green" left arrow) phases, amber + all-red clearance, pedestrian
 * walk phases, and corner-mounted signal heads whose lenses are driven by the
 * controller. Also the PXO (pedestrian crossover) overhead beacons.
 */

import * as THREE from 'three';
import type { RoadNetwork, NodeRT } from './network';
import { compassOf } from './network';
import { signTexture } from './textures';

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

interface Controller {
  node: NodeRT;
  phases: Phase[];
  cycle: number;
  offset: number;
  heads: Head[];
}

interface Head {
  approach: Compass;
  red: THREE.MeshStandardMaterial;
  amber: THREE.MeshStandardMaterial;
  green: THREE.MeshStandardMaterial;
  arrow: THREE.MeshStandardMaterial;
}

function lensMat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x1a1a1a,
    roughness: 0.4,
    emissive: new THREE.Color(color),
    emissiveIntensity: 0,
  });
}

const POLE_MAT = new THREE.MeshStandardMaterial({ color: 0x3c4046, roughness: 0.6, metalness: 0.65 });
const BOX_MAT = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.7 });

export class SignalSystem {
  readonly group = new THREE.Group();
  private controllers = new Map<string, Controller>();
  private pxoBeacons: THREE.MeshStandardMaterial[] = [];
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

      const ctrl: Controller = { node, phases, cycle, offset: cfg.offset ?? 0, heads: [] };
      this.buildHeads(ctrl);
      this.controllers.set(node.def.id, ctrl);
    }
  }

  /** Corner poles with heads facing each approach. */
  private buildHeads(ctrl: Controller): void {
    const { x, z } = ctrl.node.def;
    const r = ctrl.node.radius + 1.2;
    // (pole corner offset, approach it serves) — far-right corner for each approach
    const placements: Array<{ px: number; pz: number; approach: Compass }> = [
      { px: x - r, pz: z - r, approach: 'N' }, // serves traffic heading N (from south): far right = NW... keep simple corner mapping
      { px: x + r, pz: z + r, approach: 'S' },
      { px: x - r, pz: z + r, approach: 'E' },
      { px: x + r, pz: z - r, approach: 'W' },
    ];
    for (const pl of placements) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 5.2, 8), POLE_MAT);
      pole.position.set(pl.px, 2.6, pl.pz);
      pole.castShadow = true;
      this.group.add(pole);

      const head = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.25, 0.3), BOX_MAT);
      head.add(box);
      const mats: Head = {
        approach: pl.approach,
        red: lensMat(0xff2d20),
        amber: lensMat(0xffb024),
        green: lensMat(0x2bd966),
        arrow: lensMat(0x2bd966),
      };
      const lensGeo = new THREE.CircleGeometry(0.13, 12);
      const mkLens = (mat: THREE.MeshStandardMaterial, yy: number, arrowShape = false): void => {
        const lens = new THREE.Mesh(arrowShape ? new THREE.CircleGeometry(0.11, 3) : lensGeo, mat);
        lens.position.set(0, yy, 0.16);
        if (arrowShape) lens.rotation.z = Math.PI / 2; // triangle pointing left
        head.add(lens);
      };
      mkLens(mats.red, 0.45);
      mkLens(mats.amber, 0.15);
      mkLens(mats.green, -0.15);
      mkLens(mats.arrow, -0.47, true);

      // face the APPROACHING traffic: head looks toward the approach direction
      const facing: Record<Compass, number> = { N: 0, S: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 };
      // approach 'N' = traffic moving north (from the south): head faces south (+z)
      head.position.set(pl.px, 4.4, pl.pz);
      head.rotation.y = facing[pl.approach];
      this.group.add(head);
      ctrl.heads.push(mats);
    }
  }

  /** Build the PXO overhead beacon set at a world position (called by world). */
  buildPxo(x: number, z: number, heading: number): void {
    for (const side of [-1, 1]) {
      const px = x + Math.cos(heading) * side * 8;
      const pz = z - Math.sin(heading) * side * 8;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.6, 8), POLE_MAT);
      pole.position.set(px, 2.3, pz);
      pole.castShadow = true;
      this.group.add(pole);
      const beacon = lensMat(0xffb024);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), beacon);
      lamp.position.set(px, 4.4, pz);
      this.group.add(lamp);
      this.pxoBeacons.push(beacon);
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(0.74, 0.74),
        new THREE.MeshStandardMaterial({ map: signTexture('pxo'), roughness: 0.55, side: THREE.DoubleSide }),
      );
      sign.position.set(px, 3.6, pz);
      sign.rotation.y = heading + Math.PI / 2;
      this.group.add(sign);
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
    for (const ctrl of this.controllers.values()) {
      const { phase, remain } = this.phaseAt(ctrl, simTime);
      const flash = simTime % 0.66 < 0.36;
      for (const head of ctrl.heads) {
        const axis = head.approach === 'N' || head.approach === 'S' ? phase.ns : phase.ew;
        head.red.emissiveIntensity = axis === 'red' || axis === 'arrow' ? 3.4 : 0;
        head.amber.emissiveIntensity = axis === 'amber' ? 3.6 : 0;
        head.green.emissiveIntensity = axis === 'green' ? 3.2 : 0;
        head.arrow.emissiveIntensity = axis === 'arrow' && flash ? 3.6 : 0;
        // green flashes during the last moments? (Ontario: flashing green = advance; keep arrow distinct)
        void remain;
      }
    }
    const pxFlash = simTime % 0.8 < 0.4;
    for (const b of this.pxoBeacons) b.emissiveIntensity = this.pxoActive && pxFlash ? 3.5 : 0;
  }
}

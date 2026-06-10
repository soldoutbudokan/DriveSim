/**
 * Procedural vehicle visuals (no external assets). One factory builds every
 * vehicle kind in the sim — the player car, AI traffic, transit and emergency
 * vehicles — with working lights (head/brake/signal/reverse) and wheels that
 * spin and steer. A `CarVisual` wraps the mesh with per-frame light/suspension
 * animation shared by the player and AI.
 */

import * as THREE from 'three';
import { clamp, damp } from '../core/math';

export type CarKind =
  | 'sedan'
  | 'hatch'
  | 'suv'
  | 'taxi'
  | 'police'
  | 'ambulance'
  | 'firetruck'
  | 'truck'
  | 'schoolbus'
  | 'streetcar';

export interface CarDims {
  length: number;
  width: number;
  height: number;
  wheelRadius: number;
}

export const CAR_DIMS: Record<CarKind, CarDims> = {
  sedan: { length: 4.55, width: 1.78, height: 1.42, wheelRadius: 0.31 },
  hatch: { length: 4.15, width: 1.75, height: 1.48, wheelRadius: 0.3 },
  suv: { length: 4.7, width: 1.86, height: 1.7, wheelRadius: 0.35 },
  taxi: { length: 4.55, width: 1.78, height: 1.42, wheelRadius: 0.31 },
  police: { length: 4.8, width: 1.85, height: 1.48, wheelRadius: 0.33 },
  ambulance: { length: 5.6, width: 2.05, height: 2.4, wheelRadius: 0.36 },
  firetruck: { length: 8.5, width: 2.45, height: 3.1, wheelRadius: 0.45 },
  truck: { length: 6.6, width: 2.3, height: 2.6, wheelRadius: 0.42 },
  schoolbus: { length: 10.5, width: 2.5, height: 3.0, wheelRadius: 0.45 },
  streetcar: { length: 16, width: 2.54, height: 3.3, wheelRadius: 0.33 },
};

const matCache = new Map<string, THREE.MeshStandardMaterial>();

export function bodyMat(color: number, opts: { rough?: number; metal?: number; emissive?: number } = {}): THREE.MeshStandardMaterial {
  const key = `${color}|${opts.rough ?? 0.42}|${opts.metal ?? 0.55}|${opts.emissive ?? 0}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: opts.rough ?? 0.42,
      metalness: opts.metal ?? 0.55,
    });
    if (opts.emissive) {
      m.emissive = new THREE.Color(opts.emissive);
      m.emissiveIntensity = 1;
    }
    matCache.set(key, m);
  }
  return m;
}

const GLASS = new THREE.MeshStandardMaterial({ color: 0x16202c, roughness: 0.12, metalness: 0.85 });
const TIRE = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.92, metalness: 0 });
const HUB = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.35, metalness: 0.8 });
const TRIM = new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.7, metalness: 0.2 });

export interface CarLightMats {
  head: THREE.MeshStandardMaterial;
  tail: THREE.MeshStandardMaterial;
  signalL: THREE.MeshStandardMaterial;
  signalR: THREE.MeshStandardMaterial;
  reverse: THREE.MeshStandardMaterial;
  beaconA?: THREE.MeshStandardMaterial;
  beaconB?: THREE.MeshStandardMaterial;
}

export interface BuiltCar {
  root: THREE.Group;
  chassis: THREE.Group;
  wheels: THREE.Object3D[];
  frontWheels: THREE.Object3D[];
  lights: CarLightMats;
  dims: CarDims;
  kind: CarKind;
}

function mkLightMat(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x222222,
    roughness: 0.3,
    metalness: 0.1,
    emissive: new THREE.Color(color),
    emissiveIntensity: 0,
  });
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function wheel(r: number, w: number): THREE.Object3D {
  const grp = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 14), TIRE);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 10), HUB);
  hub.rotation.z = Math.PI / 2;
  grp.add(tire, hub);
  return grp;
}

/**
 * Build a vehicle mesh. The group faces +Z (forward) at rotation.y = 0,
 * sitting on y=0 (wheel contact).
 */
export function buildCar(kind: CarKind, color: number): BuiltCar {
  const dims = CAR_DIMS[kind];
  const { length: L, width: W, height: H, wheelRadius: R } = dims;
  const root = new THREE.Group();
  const chassis = new THREE.Group();
  root.add(chassis);

  const paint = bodyMat(color);
  const lights: CarLightMats = {
    head: mkLightMat(0xfff2cc),
    tail: mkLightMat(0xff2a1a),
    signalL: mkLightMat(0xffa01e),
    signalR: mkLightMat(0xffa01e),
    reverse: mkLightMat(0xffffff),
  };

  const isBig = kind === 'truck' || kind === 'schoolbus' || kind === 'streetcar' || kind === 'firetruck' || kind === 'ambulance';

  if (!isBig) {
    // --- passenger car: lower body + cabin -----------------------------
    const bodyH = H * 0.52;
    const body = box(W, bodyH, L, paint, 0, R * 0.7 + bodyH / 2, 0);
    const cabinH = H - bodyH - 0.04;
    const cabinL = kind === 'hatch' ? L * 0.52 : L * 0.45;
    const cabinZ = kind === 'hatch' ? -L * 0.1 : -L * 0.06;
    const cabin = box(W * 0.88, cabinH, cabinL, GLASS, 0, R * 0.7 + bodyH + cabinH / 2, cabinZ);
    const roof = box(W * 0.84, 0.05, cabinL * 0.82, paint, 0, R * 0.7 + bodyH + cabinH, cabinZ);
    const bumperF = box(W * 0.98, 0.18, 0.16, TRIM, 0, R * 0.62, L / 2 - 0.06);
    const bumperR = box(W * 0.98, 0.18, 0.16, TRIM, 0, R * 0.62, -L / 2 + 0.06);
    chassis.add(body, cabin, roof, bumperF, bumperR);

    if (kind === 'taxi') {
      const sign = box(0.5, 0.16, 0.3, bodyMat(0xfde9a8, { emissive: 0xffe9a0 }), 0, R * 0.7 + bodyH + cabinH + 0.12, cabinZ);
      chassis.add(sign);
    }
    if (kind === 'police') {
      lights.beaconA = mkLightMat(0xff2222);
      lights.beaconB = mkLightMat(0x2266ff);
      const barBase = box(W * 0.6, 0.07, 0.32, TRIM, 0, R * 0.7 + bodyH + cabinH + 0.06, cabinZ);
      const barA = box(W * 0.28, 0.1, 0.3, lights.beaconA, -W * 0.15, R * 0.7 + bodyH + cabinH + 0.14, cabinZ);
      const barB = box(W * 0.28, 0.1, 0.3, lights.beaconB, W * 0.15, R * 0.7 + bodyH + cabinH + 0.14, cabinZ);
      const stripe = box(W + 0.02, 0.16, L * 0.96, bodyMat(0x10254a), 0, R * 0.7 + bodyH * 0.55, 0);
      chassis.add(barBase, barA, barB, stripe);
    }
  } else {
    // --- vans / trucks / buses: single tall box + cab hint --------------
    const bodyH = H - R * 0.6;
    const body = box(W, bodyH, L, paint, 0, R * 0.6 + bodyH / 2, 0);
    chassis.add(body);
    // windshield band
    const band = box(W * 0.94, H * 0.22, 0.06, GLASS, 0, R * 0.6 + bodyH * 0.72, L / 2 - 0.02);
    chassis.add(band);
    if (kind === 'streetcar') {
      // TTC-style rocket: white roof band, doors
      const roofBand = box(W * 0.98, H * 0.18, L * 0.98, bodyMat(0xe8e8e6), 0, R * 0.6 + bodyH - H * 0.08, 0);
      chassis.add(roofBand);
      for (const dz of [L * 0.28, -L * 0.05, -L * 0.34]) {
        const door = box(0.05, H * 0.5, 1.3, GLASS, W / 2 + 0.01, R * 0.6 + bodyH * 0.4, dz);
        chassis.add(door);
      }
      const pant = box(0.08, 0.9, 1.6, TRIM, 0, R * 0.6 + bodyH + 0.45, L * 0.2);
      pant.rotation.x = 0.5;
      chassis.add(pant);
    }
    if (kind === 'schoolbus') {
      lights.beaconA = mkLightMat(0xff2222);
      lights.beaconB = mkLightMat(0xff2222);
      const fl = box(0.16, 0.16, 0.1, lights.beaconA, -W * 0.32, H - 0.1, L / 2 - 0.04);
      const fr = box(0.16, 0.16, 0.1, lights.beaconB, W * 0.32, H - 0.1, L / 2 - 0.04);
      const rl = box(0.16, 0.16, 0.1, lights.beaconA, -W * 0.32, H - 0.1, -L / 2 + 0.04);
      const rr = box(0.16, 0.16, 0.1, lights.beaconB, W * 0.32, H - 0.1, -L / 2 + 0.04);
      const stripeM = box(W + 0.02, 0.1, L * 0.98, TRIM, 0, R * 0.6 + bodyH * 0.45, 0);
      chassis.add(fl, fr, rl, rr, stripeM);
    }
    if (kind === 'ambulance' || kind === 'firetruck') {
      lights.beaconA = mkLightMat(0xff2222);
      lights.beaconB = mkLightMat(0x2266ff);
      const barA = box(W * 0.3, 0.12, 0.34, lights.beaconA, -W * 0.16, H + 0.02, L * 0.28);
      const barB = box(W * 0.3, 0.12, 0.34, lights.beaconB, W * 0.16, H + 0.02, L * 0.28);
      chassis.add(barA, barB);
      if (kind === 'ambulance') {
        const stripe2 = box(W + 0.02, 0.22, L * 0.98, bodyMat(0xd23b2e), 0, R * 0.6 + bodyH * 0.4, 0);
        chassis.add(stripe2);
      }
      if (kind === 'firetruck') {
        const ladder = box(0.5, 0.18, L * 0.6, bodyMat(0xc6cdd4, { metal: 0.85, rough: 0.3 }), 0, H + 0.12, -L * 0.12);
        chassis.add(ladder);
      }
    }
  }

  // --- lamps ------------------------------------------------------------
  const lampY = R * 0.85 + (isBig ? 0.25 : 0.18);
  const hw = W / 2 - 0.22;
  const front = L / 2 - 0.03;
  const rear = -L / 2 + 0.03;
  const headL = box(0.3, 0.12, 0.08, lights.head, -hw, lampY, front);
  const headR = box(0.3, 0.12, 0.08, lights.head, hw, lampY, front);
  const tailL = box(0.3, 0.12, 0.08, lights.tail, -hw, lampY, rear);
  const tailR = box(0.3, 0.12, 0.08, lights.tail, hw, lampY, rear);
  const sigFL = box(0.14, 0.1, 0.08, lights.signalL, -(hw + 0.24), lampY, front);
  const sigFR = box(0.14, 0.1, 0.08, lights.signalR, hw + 0.24, lampY, front);
  const sigRL = box(0.14, 0.1, 0.08, lights.signalL, -(hw + 0.24), lampY, rear);
  const sigRR = box(0.14, 0.1, 0.08, lights.signalR, hw + 0.24, lampY, rear);
  const revL = box(0.12, 0.09, 0.08, lights.reverse, -hw + 0.34, lampY, rear);
  const revR = box(0.12, 0.09, 0.08, lights.reverse, hw - 0.34, lampY, rear);
  chassis.add(headL, headR, tailL, tailR, sigFL, sigFR, sigRL, sigRR, revL, revR);

  // --- mirrors (passenger cars) ------------------------------------------
  if (!isBig) {
    const mirL = box(0.06, 0.1, 0.18, TRIM, -W / 2 - 0.08, R * 0.7 + H * 0.52, L * 0.12);
    const mirR = box(0.06, 0.1, 0.18, TRIM, W / 2 + 0.08, R * 0.7 + H * 0.52, L * 0.12);
    chassis.add(mirL, mirR);
  }

  // --- wheels --------------------------------------------------------------
  const wheels: THREE.Object3D[] = [];
  const frontWheels: THREE.Object3D[] = [];
  const wy = R;
  const wx = W / 2 - 0.12;
  const axleF = L * 0.32;
  const axleR = -L * 0.32;
  const ww = isBig ? 0.32 : 0.24;
  for (const [x, z, isFront] of [
    [-wx, axleF, true],
    [wx, axleF, true],
    [-wx, axleR, false],
    [wx, axleR, false],
  ] as Array<[number, number, boolean]>) {
    const steerPivot = new THREE.Group();
    steerPivot.position.set(x, wy, z);
    const w = wheel(R, ww);
    steerPivot.add(w);
    root.add(steerPivot);
    wheels.push(w);
    if (isFront) frontWheels.push(steerPivot);
  }

  return { root, chassis, wheels, frontWheels, lights, dims, kind };
}

export interface CarLightState {
  headlights: boolean;
  braking: boolean;
  reversing: boolean;
  signalLeft: boolean;
  signalRight: boolean;
  hazards: boolean;
}

/** Animates a built car: wheel spin/steer, light states, body roll/pitch. */
export class CarVisual {
  readonly built: BuiltCar;
  private roll = 0;
  private pitch = 0;
  private wheelAngle = 0;

  constructor(built: BuiltCar) {
    this.built = built;
  }

  get root(): THREE.Group {
    return this.built.root;
  }

  update(
    dt: number,
    time: number,
    speed: number,
    steer: number,
    lightState: CarLightState,
    gLat = 0,
    gLong = 0,
  ): void {
    const b = this.built;
    this.wheelAngle += (speed / b.dims.wheelRadius) * dt;
    for (const w of b.wheels) w.rotation.x = this.wheelAngle;
    for (const fw of b.frontWheels) fw.rotation.y = steer;

    // body roll (lean OUT of the turn) and pitch (dive under braking)
    this.roll = damp(this.roll, clamp(gLat * 0.055, -0.07, 0.07), 7, dt);
    this.pitch = damp(this.pitch, clamp(gLong * 0.045, -0.05, 0.05), 7, dt);
    b.chassis.rotation.z = this.roll;
    b.chassis.rotation.x = this.pitch;

    const blinkOn = time % 0.8 < 0.4;
    const l = b.lights;
    const sigL = (lightState.signalLeft || lightState.hazards) && blinkOn;
    const sigR = (lightState.signalRight || lightState.hazards) && blinkOn;
    l.signalL.emissiveIntensity = sigL ? 3.2 : 0;
    l.signalR.emissiveIntensity = sigR ? 3.2 : 0;
    l.head.emissiveIntensity = lightState.headlights ? 2.6 : 0;
    l.tail.emissiveIntensity = lightState.braking ? 4 : lightState.headlights ? 1.1 : 0;
    l.reverse.emissiveIntensity = lightState.reversing ? 2.5 : 0;
  }
}

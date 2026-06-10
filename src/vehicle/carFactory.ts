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

const GLASS = new THREE.MeshStandardMaterial({ color: 0x141e2a, roughness: 0.06, metalness: 0.9, envMapIntensity: 1.3 });
const TIRE = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.92, metalness: 0 });
const HUB = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.3, metalness: 0.85 });
const TRIM = new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.7, metalness: 0.2 });

/* ------------------------------------------------------------------ */
/* Rounded body shells: a side-profile silhouette extruded across the  */
/* car's width (with bevel) replaces the old stacked boxes. The body   */
/* stops at the belt line; a narrower glass greenhouse + painted roof  */
/* slab sit on top. Geometries are cached per kind.                    */
/* ------------------------------------------------------------------ */

/** [xFrac of L, yFrac of H] silhouette points, front (+x) first, clockwise. */
interface ProfileSpec {
  body: Array<[number, number]>;
  glass: Array<[number, number]>;
  /** Painted roof slab span as xFrac [front, rear] and its yFrac. */
  roof: [number, number, number];
}

const SEDAN_PROFILE: ProfileSpec = {
  body: [
    [0.5, 0.3], [0.5, 0.44], [0.44, 0.52], [0.12, 0.585], [-0.4, 0.615],
    [-0.48, 0.6], [-0.5, 0.52], [-0.5, 0.3], [-0.44, 0.18], [0.44, 0.18],
  ],
  glass: [
    [0.115, 0.575], [0.04, 0.95], [-0.295, 0.965], [-0.405, 0.605],
  ],
  roof: [0.04, -0.295, 0.955],
};

const HATCH_PROFILE: ProfileSpec = {
  body: [
    [0.5, 0.32], [0.5, 0.46], [0.43, 0.54], [0.1, 0.6], [-0.43, 0.64],
    [-0.5, 0.58], [-0.5, 0.32], [-0.44, 0.19], [0.44, 0.19],
  ],
  glass: [
    [0.095, 0.59], [0.02, 0.95], [-0.31, 0.965], [-0.435, 0.63],
  ],
  roof: [0.02, -0.31, 0.955],
};

const SUV_PROFILE: ProfileSpec = {
  body: [
    [0.5, 0.34], [0.5, 0.5], [0.42, 0.56], [0.12, 0.6], [-0.44, 0.63],
    [-0.5, 0.58], [-0.5, 0.34], [-0.45, 0.22], [0.45, 0.22],
  ],
  glass: [
    [0.115, 0.59], [0.05, 0.95], [-0.4, 0.96], [-0.445, 0.62],
  ],
  roof: [0.05, -0.4, 0.95],
};

const PROFILE_FOR: Partial<Record<CarKind, ProfileSpec>> = {
  sedan: SEDAN_PROFILE,
  taxi: SEDAN_PROFILE,
  police: SEDAN_PROFILE,
  hatch: HATCH_PROFILE,
  suv: SUV_PROFILE,
};

function extrudeProfile(pts: Array<[number, number]>, L: number, H: number, width: number, bevel: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  pts.forEach(([fx, fy], i) => {
    const x = fx * L;
    const y = fy * H;
    i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y);
  });
  shape.closePath();
  const depth = Math.max(0.1, width - 2 * bevel);
  const geo = new THREE.ExtrudeGeometry(shape, {
    steps: 1,
    depth,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel * 0.9,
    bevelSegments: 3,
  });
  geo.rotateY(-Math.PI / 2); // shape +x (longitudinal) → world +z (forward)
  geo.translate((depth + 2 * bevel) / 2 - bevel, 0, 0); // centre across width
  return geo;
}

interface ShellGeos {
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
  roofY: number;
}

const shellCache = new Map<CarKind, ShellGeos>();

function passengerShell(kind: CarKind): ShellGeos {
  const hit = shellCache.get(kind);
  if (hit) return hit;
  const { length: L, width: W, height: H } = CAR_DIMS[kind];
  const spec = PROFILE_FOR[kind]!;
  const body = extrudeProfile(spec.body, L, H, W, 0.06);
  const glass = extrudeProfile(spec.glass, L, H, W * 0.86, 0.035);
  const [rF, rR, rY] = spec.roof;
  const roofLen = (rF - rR) * L;
  const roof = new THREE.BoxGeometry(W * 0.8, H * 0.035, roofLen * 0.96);
  roof.translate(0, rY * H + H * 0.02, ((rF + rR) / 2) * L);
  const out = { body, glass, roof, roofY: rY * H };
  shellCache.set(kind, out);
  return out;
}

/** Rounded-rectangle cross-section shell for vans/trucks/buses. */
function bigShell(kind: CarKind, bodyH: number, yBase: number): THREE.BufferGeometry {
  const key = kind;
  const cached = shellCache.get(key);
  if (cached) return cached.body;
  const { length: L, width: W } = CAR_DIMS[kind];
  const r = Math.min(0.18, W * 0.09);
  const shape = new THREE.Shape();
  const x0 = -W / 2;
  const y0 = yBase;
  shape.moveTo(x0 + r, y0);
  shape.lineTo(x0 + W - r, y0);
  shape.quadraticCurveTo(x0 + W, y0, x0 + W, y0 + r);
  shape.lineTo(x0 + W, y0 + bodyH - r);
  shape.quadraticCurveTo(x0 + W, y0 + bodyH, x0 + W - r, y0 + bodyH);
  shape.lineTo(x0 + r, y0 + bodyH);
  shape.quadraticCurveTo(x0, y0 + bodyH, x0, y0 + bodyH - r);
  shape.lineTo(x0, y0 + r);
  shape.quadraticCurveTo(x0, y0, x0 + r, y0);
  const depth = L - 0.16;
  const geo = new THREE.ExtrudeGeometry(shape, {
    steps: 1,
    depth,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.07,
    bevelSegments: 2,
  });
  geo.translate(0, 0, -depth / 2);
  shellCache.set(key, { body: geo, glass: geo, roof: geo, roofY: 0 });
  return geo;
}

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
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 18), TIRE);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 12), HUB);
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

  const paint = bodyMat(color, { rough: 0.3, metal: 0.72 });
  const lights: CarLightMats = {
    head: mkLightMat(0xfff2cc),
    tail: mkLightMat(0xff2a1a),
    signalL: mkLightMat(0xffa01e),
    signalR: mkLightMat(0xffa01e),
    reverse: mkLightMat(0xffffff),
  };

  const isBig = kind === 'truck' || kind === 'schoolbus' || kind === 'streetcar' || kind === 'firetruck' || kind === 'ambulance';

  if (!isBig) {
    // --- passenger car: rounded extruded shell + glass greenhouse ------
    const shell = passengerShell(kind);
    const body = new THREE.Mesh(shell.body, paint);
    const glass = new THREE.Mesh(shell.glass, GLASS);
    const roof = new THREE.Mesh(shell.roof, paint);
    body.castShadow = true;
    glass.castShadow = true;
    chassis.add(body, glass, roof);
    // wheel-well shadows: dark discs tucked behind each wheel
    const archGeo = new THREE.CylinderGeometry(R + 0.06, R + 0.06, 0.3, 16);
    archGeo.rotateZ(Math.PI / 2);
    for (const [ax, az] of [
      [-(W / 2 - 0.13), L * 0.32],
      [W / 2 - 0.13, L * 0.32],
      [-(W / 2 - 0.13), -L * 0.32],
      [W / 2 - 0.13, -L * 0.32],
    ]) {
      const arch = new THREE.Mesh(archGeo, TRIM);
      arch.position.set(ax, R, az);
      chassis.add(arch);
    }
    const bumperF = box(W * 0.96, 0.16, 0.18, TRIM, 0, H * 0.26, L / 2 - 0.05);
    const bumperR = box(W * 0.96, 0.16, 0.18, TRIM, 0, H * 0.26, -L / 2 + 0.05);
    chassis.add(bumperF, bumperR);

    const roofY = shell.roofY + H * 0.04;
    if (kind === 'taxi') {
      const sign = box(0.5, 0.16, 0.3, bodyMat(0xfde9a8, { emissive: 0xffe9a0 }), 0, roofY + 0.1, -L * 0.13);
      chassis.add(sign);
    }
    if (kind === 'police') {
      lights.beaconA = mkLightMat(0xff2222);
      lights.beaconB = mkLightMat(0x2266ff);
      const barBase = box(W * 0.6, 0.07, 0.32, TRIM, 0, roofY + 0.04, -L * 0.13);
      const barA = box(W * 0.28, 0.1, 0.3, lights.beaconA, -W * 0.15, roofY + 0.12, -L * 0.13);
      const barB = box(W * 0.28, 0.1, 0.3, lights.beaconB, W * 0.15, roofY + 0.12, -L * 0.13);
      const stripe = box(W + 0.04, 0.16, L * 0.82, bodyMat(0x10254a), 0, H * 0.42, 0);
      chassis.add(barBase, barA, barB, stripe);
    }
  } else {
    // --- vans / trucks / buses: rounded-edge shell + cab hint -----------
    const bodyH = H - R * 0.6;
    const body = new THREE.Mesh(bigShell(kind, bodyH, R * 0.6), paint);
    body.castShadow = true;
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
  // beveled shells bulge past L/2 — push lamps out so they stay proud of the body
  const front = L / 2 + (isBig ? -0.03 : 0.03);
  const rear = -L / 2 - (isBig ? -0.03 : 0.03);
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
    const mirL = box(0.06, 0.1, 0.18, TRIM, -W / 2 - 0.08, H * 0.6, L * 0.1);
    const mirR = box(0.06, 0.1, 0.18, TRIM, W / 2 + 0.08, H * 0.6, L * 0.1);
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

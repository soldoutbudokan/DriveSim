/**
 * Lightweight 2D collision layer (the sim's collision needs are planar).
 * OBB-vs-OBB via SAT and OBB-vs-circle, with a spatial hash for statics.
 * Responses are soft impulses — enough to register faults and feel the hit,
 * per the design (no destruction physics).
 */

import { headingForward, headingLeft, type V2 } from '../core/math';

export interface OBB {
  x: number;
  z: number;
  heading: number;
  halfW: number; // lateral half-extent
  halfL: number; // longitudinal half-extent
  /** Arbitrary tag for fault attribution ('building', 'parkedCar', 'cone', ...). */
  tag: string;
  /** Optional back-reference (e.g. cone instance index). */
  ref?: unknown;
}

export interface CircleCollider {
  x: number;
  z: number;
  r: number;
  tag: string;
  ref?: unknown;
}

export interface Contact {
  /** Unit normal pointing away from the obstacle (direction to push the car). */
  nx: number;
  nz: number;
  depth: number;
  tag: string;
  ref?: unknown;
  /** Lateral offset of contact along car's left axis (for yaw impulse). */
  offsetAlong: number;
}

interface ObbAxes {
  fx: number;
  fz: number;
  lx: number;
  lz: number;
}

function axesOf(o: OBB): ObbAxes {
  const f = headingForward(o.heading);
  const l = headingLeft(o.heading);
  return { fx: f.x, fz: f.z, lx: l.x, lz: l.z };
}

/** Project OBB onto axis (ax,az); returns half-extent of projection. */
function projRadius(o: OBB, a: ObbAxes, ax: number, az: number): number {
  return Math.abs((a.fx * ax + a.fz * az) * o.halfL) + Math.abs((a.lx * ax + a.lz * az) * o.halfW);
}

/** SAT test for two OBBs; returns minimal translation vector contact for `a` or null. */
export function obbVsObb(a: OBB, b: OBB): Contact | null {
  const aAx = axesOf(a);
  const bAx = axesOf(b);
  const dx = a.x - b.x;
  const dz = a.z - b.z;

  const axes: Array<[number, number]> = [
    [aAx.fx, aAx.fz],
    [aAx.lx, aAx.lz],
    [bAx.fx, bAx.fz],
    [bAx.lx, bAx.lz],
  ];

  let minOverlap = Infinity;
  let bestAxis: [number, number] | null = null;
  for (const [ax, az] of axes) {
    const dist = dx * ax + dz * az;
    const ra = projRadius(a, aAx, ax, az);
    const rb = projRadius(b, bAx, ax, az);
    const overlap = ra + rb - Math.abs(dist);
    if (overlap <= 0) return null;
    if (overlap < minOverlap) {
      minOverlap = overlap;
      bestAxis = dist >= 0 ? [ax, az] : [-ax, -az];
    }
  }
  if (!bestAxis) return null;
  // contact offset along a's left axis, used for yaw impulse
  const offsetAlong = -(dx * aAx.lx + dz * aAx.lz);
  return { nx: bestAxis[0], nz: bestAxis[1], depth: minOverlap, tag: b.tag, ref: b.ref, offsetAlong };
}

/** OBB (the car) vs circle obstacle. Normal pushes the OBB away from the circle. */
export function obbVsCircle(a: OBB, c: CircleCollider): Contact | null {
  const aAx = axesOf(a);
  const dx = c.x - a.x;
  const dz = c.z - a.z;
  // circle center in OBB local coords
  const localF = dx * aAx.fx + dz * aAx.fz;
  const localL = dx * aAx.lx + dz * aAx.lz;
  const clF = Math.max(-a.halfL, Math.min(a.halfL, localF));
  const clL = Math.max(-a.halfW, Math.min(a.halfW, localL));
  const closestX = a.x + aAx.fx * clF + aAx.lx * clL;
  const closestZ = a.z + aAx.fz * clF + aAx.lz * clL;
  const ex = c.x - closestX;
  const ez = c.z - closestZ;
  const d2 = ex * ex + ez * ez;
  if (d2 > c.r * c.r) return null;
  const d = Math.sqrt(d2);
  let nx: number;
  let nz: number;
  if (d > 1e-6) {
    nx = -ex / d;
    nz = -ez / d;
  } else {
    nx = -dx;
    nz = -dz;
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
  }
  return { nx, nz, depth: c.r - d + 0.01, tag: c.tag, ref: c.ref, offsetAlong: clL };
}

const CELL = 12;

/** Static collision world with a uniform-grid broadphase. */
export class CollisionWorld {
  private grid = new Map<string, { obbs: OBB[]; circles: CircleCollider[] }>();
  /** Dynamic colliders are re-supplied each query (traffic). */

  private cellsFor(x: number, z: number, radius: number): string[] {
    const keys: string[] = [];
    const x0 = Math.floor((x - radius) / CELL);
    const x1 = Math.floor((x + radius) / CELL);
    const z0 = Math.floor((z - radius) / CELL);
    const z1 = Math.floor((z + radius) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) keys.push(`${cx},${cz}`);
    return keys;
  }

  addOBB(o: OBB): void {
    const radius = Math.hypot(o.halfL, o.halfW);
    for (const k of this.cellsFor(o.x, o.z, radius)) {
      let cell = this.grid.get(k);
      if (!cell) {
        cell = { obbs: [], circles: [] };
        this.grid.set(k, cell);
      }
      cell.obbs.push(o);
    }
  }

  addCircle(c: CircleCollider): void {
    for (const k of this.cellsFor(c.x, c.z, c.r)) {
      let cell = this.grid.get(k);
      if (!cell) {
        cell = { obbs: [], circles: [] };
        this.grid.set(k, cell);
      }
      cell.circles.push(c);
    }
  }

  removeCircle(c: CircleCollider): void {
    for (const k of this.cellsFor(c.x, c.z, c.r)) {
      const cell = this.grid.get(k);
      if (!cell) continue;
      const i = cell.circles.indexOf(c);
      if (i >= 0) cell.circles.splice(i, 1);
    }
  }

  /** All static contacts against a moving OBB. */
  collide(mover: OBB): Contact[] {
    const out: Contact[] = [];
    const radius = Math.hypot(mover.halfL, mover.halfW);
    const seen = new Set<OBB | CircleCollider>();
    for (const k of this.cellsFor(mover.x, mover.z, radius)) {
      const cell = this.grid.get(k);
      if (!cell) continue;
      for (const o of cell.obbs) {
        if (seen.has(o)) continue;
        seen.add(o);
        const c = obbVsObb(mover, o);
        if (c) out.push(c);
      }
      for (const ci of cell.circles) {
        if (seen.has(ci)) continue;
        seen.add(ci);
        const c = obbVsCircle(mover, ci);
        if (c) out.push(c);
      }
    }
    return out;
  }
}

export const carOBB = (x: number, z: number, heading: number, length: number, width: number, tag: string, ref?: unknown): OBB => ({
  x,
  z,
  heading,
  halfL: length / 2,
  halfW: width / 2,
  tag,
  ref,
});

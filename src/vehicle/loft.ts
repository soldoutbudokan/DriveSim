/**
 * Parametric vehicle hull. A body is described by a handful of side-profile
 * curves (roof/hood line, belt line, sill, half-width, roof width) and lofted
 * into a watertight mesh: each longitudinal station gets a cross-section
 * ring sampled from a spline (door bulge, tumblehome, rounded roof edge);
 * consecutive rings are stitched into quads. Faces are classified into
 * material groups (paint / windshield / side glass / trim) by station and
 * ring position, so windows are real surface regions of the same skin.
 * Normals are smoothed by crease angle so the cowl, sills and pillar edges
 * stay crisp while the sheet metal reads as curved.
 */

import * as THREE from 'three';

/** [x, y, roundRadius?] anchor along a profile curve (x ascending). */
export type Anchor = [number, number, number?];

export interface LoftSpec {
  /** Roof/hood/trunk line: z fraction of L → y fraction of H. */
  top: Anchor[];
  /** Belt line (bottom of the glass). */
  belt: Anchor[];
  /** Sill / underside line. */
  bottom: Anchor[];
  /** Half width at the belt line: z fraction → x fraction of W. */
  halfW: Anchor[];
  /** Half width at the roof. */
  roofW: Anchor[];
  /** Longitudinal glass layout (z fractions). */
  glass: {
    rearBase: number;
    roofRear: number;
    roofFront: number;
    cowl: number;
    /** Painted pillar bands [z, halfWidth] along the side glass. */
    pillars: Array<[number, number]>;
    /** Side-glass rear/front limits (defaults to rearBase..cowl). */
    sideFrom?: number;
    sideTo?: number;
  };
  /** 0 = curvy passenger car, 1 = flat-sided commercial body. */
  boxy: number;
  /** Below this y fraction the skin is dark trim (lower cladding). */
  trimBelow: number;
  /** Trim also covers the front/rear fascia below this y fraction. */
  fasciaTrimBelow: number;
  /** Stations along the length. */
  stations?: number;
}

export const GROUP_PAINT = 0;
export const GROUP_WINDSHIELD = 1;
export const GROUP_SIDEGLASS = 2;
export const GROUP_TRIM = 3;

const HALF_RING = 22; // samples per half cross-section
const LOWER_N = 12;
const UPPER_N = HALF_RING - LOWER_N;

/** Densify an anchor polyline, rounding corners with quadratic blends. */
function roundedCurve(anchors: Anchor[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < anchors.length; i++) {
    const [x, y, r = 0] = anchors[i];
    if (i === 0 || i === anchors.length - 1 || r <= 0) {
      out.push([x, y]);
      continue;
    }
    const [px, py] = anchors[i - 1];
    const [nx, ny] = anchors[i + 1];
    const rr = Math.min(r, (x - px) * 0.49, (nx - x) * 0.49);
    const t0 = rr / (x - px);
    const t1 = rr / (nx - x);
    const a: [number, number] = [x - rr, y + (py - y) * t0];
    const b: [number, number] = [x + rr, y + (ny - y) * t1];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * x + t * t * b[0], u * u * a[1] + 2 * u * t * y + t * t * b[1]]);
    }
  }
  return out;
}

function evalCurve(curve: Array<[number, number]>, x: number): number {
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    if (x <= curve[i][0]) {
      const [x0, y0] = curve[i - 1];
      const [x1, y1] = curve[i];
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return curve[curve.length - 1][1];
}

/** Catmull-Rom through anchors, `n` samples including both ends. */
function spline(pts: Array<[number, number]>, n: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const P = (i: number): [number, number] => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const segs = pts.length - 1;
  for (let s = 0; s < n; s++) {
    const t = (s / (n - 1)) * segs;
    const i = Math.min(segs - 1, Math.floor(t));
    const u = t - i;
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    const u2 = u * u;
    const u3 = u2 * u;
    const f = (a: number, b: number, c: number, d: number): number =>
      0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
    out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
  }
  return out;
}

/**
 * Smooth normals by crease angle on a non-indexed geometry: a vertex shares
 * normals only with coincident vertices whose face normal is within
 * `angleDeg` of its own.
 */
export function smoothNormalsByAngle(geo: THREE.BufferGeometry, angleDeg: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  const faceN: THREE.Vector3[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let f = 0; f < n / 3; f++) {
    a.fromBufferAttribute(pos, f * 3);
    b.fromBufferAttribute(pos, f * 3 + 1);
    c.fromBufferAttribute(pos, f * 3 + 2);
    const nn = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (nn.lengthSq() > 0) nn.normalize();
    faceN.push(nn);
  }
  const buckets = new Map<string, number[]>();
  const key = (i: number): string =>
    `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
  for (let i = 0; i < n; i++) {
    const k = key(i);
    let arr = buckets.get(k);
    if (!arr) {
      arr = [];
      buckets.set(k, arr);
    }
    arr.push(i);
  }
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const normals = new Float32Array(n * 3);
  const acc = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const fn = faceN[Math.floor(i / 3)];
    acc.set(0, 0, 0);
    for (const j of buckets.get(key(i))!) {
      const on = faceN[Math.floor(j / 3)];
      if (on.dot(fn) >= cosT) acc.add(on);
    }
    if (acc.lengthSq() === 0) acc.copy(fn);
    acc.normalize();
    normals[i * 3] = acc.x;
    normals[i * 3 + 1] = acc.y;
    normals[i * 3 + 2] = acc.z;
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
}

export interface ArchCut {
  /** Axle position (metres, +z forward). */
  z: number;
  /** Arch radius (metres). */
  r: number;
  /** How far the well wall sits inside the body side (metres). */
  inset: number;
}

export interface LoftResult {
  geometry: THREE.BufferGeometry;
  /** Geometry of just the painted + trim faces, for an interior liner. */
  liner: THREE.BufferGeometry;
  beltY(z: number): number;
  topY(z: number): number;
  bottomY(z: number): number;
  halfW(z: number): number;
}

/** Build the hull for a body of length L, width W, height H (metres). */
export function loftBody(spec: LoftSpec, L: number, W: number, H: number, arches: ArchCut[] = []): LoftResult {
  const top = roundedCurve(spec.top);
  const belt = roundedCurve(spec.belt);
  const bottom = roundedCurve(spec.bottom);
  const halfW = roundedCurve(spec.halfW);
  const roofW = roundedCurve(spec.roofW);
  const S = spec.stations ?? 46;
  const boxy = spec.boxy;

  const topY = (z: number): number => evalCurve(top, z / L) * H;
  const beltY = (z: number): number => evalCurve(belt, z / L) * H;
  const bottomY = (z: number): number => evalCurve(bottom, z / L) * H;
  const hwAt = (z: number): number => evalCurve(halfW, z / L) * W;
  const rwAt = (z: number): number => evalCurve(roofW, z / L) * W;

  // station positions: dense near the ends and around the windshield / rear glass
  const zs: number[] = [];
  const g = spec.glass;
  const dense = [g.cowl, g.roofFront, g.roofRear, g.rearBase];
  for (let i = 0; i < S; i++) {
    const f = -0.5 + i / (S - 1);
    zs.push(f);
  }
  for (const d of dense) for (const off of [-0.012, 0, 0.012]) zs.push(d + off);
  for (const p of g.pillars) zs.push(p[0] - p[1], p[0] + p[1]);
  for (const a of arches) {
    for (let k = 0; k <= 10; k++) {
      const t = -1 + (k / 10) * 2;
      zs.push((a.z + t * a.r) / L);
    }
  }
  zs.push(-0.5 + 0.004, 0.5 - 0.004);
  const uniq = [...new Set(zs.map((z) => Math.round(z * 2000) / 2000))].filter((z) => z >= -0.5 && z <= 0.5).sort((a, b) => a - b);

  // rings
  const rings: THREE.Vector3[][] = [];
  const archMasks: boolean[][] = [];
  const upperIsGlass: boolean[] = [];
  for (const zf of uniq) {
    const z = zf * L;
    const yb = bottomY(z);
    let yt = topY(z);
    const ybelt = beltY(z);
    const hw = hwAt(z);
    const hwTop = rwAt(z);
    const endTaper = 1 - Math.pow(Math.abs(zf) / 0.5, 30) * 0.12;
    yt = Math.max(yt, yb + 0.05 * H);
    const greenhouse = yt > ybelt + 0.02 * H;
    upperIsGlass.push(greenhouse);
    // lower body anchors (bottom centre → belt line)
    const sillY = yb + 0.05 * H;
    const bulgeY = yb + (Math.min(ybelt, yt) - yb) * 0.5;
    const lower: Array<[number, number]> = [
      [0, yb],
      [hw * (0.78 + 0.17 * boxy), yb],
      [hw * (0.965 + 0.03 * boxy), sillY],
      [hw * endTaper, bulgeY],
      [hw * (0.985 + 0.015 * boxy) * endTaper, Math.min(ybelt, yt)],
    ];
    let lowerPts = spline(lower, LOWER_N);
    // wheel arches: inside the arch circle the lower ring runs along the
    // well wall up to the arch edge, then continues on the body above it
    const mask: boolean[] = new Array(HALF_RING).fill(false);
    for (const a of arches) {
      const dz = z - a.z;
      if (Math.abs(dz) >= a.r) continue;
      const yTop = a.r * 0.75 + Math.sqrt(a.r * a.r - dz * dz);
      const wall = hw - a.inset;
      const WELL_N = 6; // ring indices 1..WELL_N sit on the wall
      const fine = spline(lower, 60).filter((p) => p[1] >= yTop);
      const bodyN = LOWER_N - WELL_N - 1;
      const body: Array<[number, number]> = [];
      for (let k = 0; k < bodyN; k++) {
        const idx = fine.length ? Math.min(fine.length - 1, Math.round((k / Math.max(1, bodyN - 1)) * (fine.length - 1))) : 0;
        body.push(fine.length ? fine[idx] : [hw, yTop + (k + 1) * 0.01]);
      }
      if (body.length && body[0][1] > yTop + 0.02) body[0] = [Math.max(wall, body[0][0]), yTop];
      const pts: Array<[number, number]> = [[0, yb]];
      for (let k = 0; k < WELL_N; k++) pts.push([wall, yb + ((yTop - yb) * k) / (WELL_N - 1)]);
      pts.push(...body);
      lowerPts = pts;
      for (let k = 1; k <= WELL_N; k++) mask[k] = true;
    }
    let upperPts: Array<[number, number]>;
    if (greenhouse) {
      const tumble = hwTop * (1.0 + 0.03 * (1 - boxy));
      const upper: Array<[number, number]> = [
        lower[4],
        [Math.min(hw, tumble * 1.06) * endTaper, ybelt + (yt - ybelt) * 0.3],
        [tumble * endTaper, ybelt + (yt - ybelt) * 0.8],
        [tumble * (0.9 - 0.08 * (1 - boxy)) * endTaper, yt],
        [0, yt + 0.01 * H],
      ];
      upperPts = spline(upper, UPPER_N + 1).slice(1);
    } else {
      // hood / trunk: shoulder + slightly crowned top
      const upper: Array<[number, number]> = [
        lower[4],
        [hw * 0.985 * endTaper, yt - 0.04 * H],
        [hw * 0.9 * endTaper, yt],
        [hw * 0.45, yt + 0.008 * H],
        [0, yt + 0.012 * H],
      ];
      upperPts = spline(upper, UPPER_N + 1).slice(1);
    }
    const half = [...lowerPts, ...upperPts];
    const ring: THREE.Vector3[] = [];
    const ringMask: boolean[] = [];
    for (let k = 0; k < half.length; k++) {
      ring.push(new THREE.Vector3(half[k][0], half[k][1], z));
      ringMask.push(mask[k]);
    }
    for (let k = half.length - 2; k >= 1; k--) {
      ring.push(new THREE.Vector3(-half[k][0], half[k][1], z));
      ringMask.push(mask[k]);
    }
    rings.push(ring);
    archMasks.push(ringMask);
  }
  const R = rings[0].length;

  // classify quads
  const region = (zf: number, kk: number, greenhouse: boolean, yMid: number, ybelt: number): number => {
    if (yMid < bottomY(zf * L) + spec.trimBelow * H) return GROUP_TRIM;
    if (Math.abs(zf) > 0.46 && yMid < bottomY(zf * L) + spec.fasciaTrimBelow * H) return GROUP_TRIM;
    if (kk < LOWER_N || !greenhouse) return GROUP_PAINT;
    if (yMid < ybelt + 0.01 * H) return GROUP_PAINT;
    const upperK = kk - LOWER_N; // 0 = belt side ... UPPER_N-1 = roof centre
    const sideFrom = g.sideFrom ?? g.rearBase;
    const sideTo = g.sideTo ?? g.cowl;
    const inWindshield = zf > g.roofFront && zf < g.cowl;
    const inRearGlass = zf > g.rearBase && zf < g.roofRear;
    const inSide = zf > sideFrom && zf < sideTo && zf >= g.roofRear - 0.02 && zf <= g.roofFront + 0.02;
    if (inWindshield || inRearGlass) {
      // sloped glass: everything above the pillar band up to the centre
      return upperK >= 2 ? GROUP_WINDSHIELD : GROUP_PAINT;
    }
    if (inSide) {
      for (const [pz, pw] of g.pillars) if (Math.abs(zf - pz) < pw) return GROUP_PAINT;
      return upperK <= UPPER_N - 4 ? GROUP_SIDEGLASS : GROUP_PAINT;
    }
    return GROUP_PAINT;
  };

  const groups: number[][] = [[], [], [], []];
  const verts: number[] = [];
  const uvs: number[] = [];
  let vcount = 0;
  const pushTri = (grp: number, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ua: number[], ub: number[], uc: number[]): void => {
    verts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    groups[grp].push(vcount, vcount + 1, vcount + 2);
    vcount += 3;
  };
  const uvOf = (i: number, j: number): number[] => {
    const kk = j < HALF_RING ? j : R - j;
    return [kk / (HALF_RING - 1), (uniq[i] + 0.5)];
  };
  for (let i = 0; i < rings.length - 1; i++) {
    const r0 = rings[i];
    const r1 = rings[i + 1];
    const zf = (uniq[i] + uniq[i + 1]) / 2;
    const gh = upperIsGlass[i] && upperIsGlass[i + 1];
    for (let j = 0; j < R; j++) {
      const j2 = (j + 1) % R;
      const kk = j < HALF_RING ? j : R - j;
      const kk2 = j2 < HALF_RING ? j2 : R - j2;
      const kMid = Math.min(kk, kk2);
      const yMid = (r0[j].y + r0[j2].y + r1[j].y + r1[j2].y) / 4;
      const inArch = (archMasks[i][j] || archMasks[i][j2]) && (archMasks[i + 1][j] || archMasks[i + 1][j2]);
      const grp = inArch ? GROUP_TRIM : region(zf, kMid, gh, yMid, beltY(zf * L));
      // outward winding: ring goes around +x side upward first
      const a = r0[j];
      const b = r0[j2];
      const c = r1[j2];
      const d = r1[j];
      pushTri(grp, a, b, c, uvOf(i, j), uvOf(i, j2), uvOf(i + 1, j2));
      pushTri(grp, a, c, d, uvOf(i, j), uvOf(i + 1, j2), uvOf(i + 1, j));
    }
  }
  // end caps
  const cap = (ring: THREE.Vector3[], front: boolean, zf: number): void => {
    const cen = new THREE.Vector3();
    for (const p of ring) cen.add(p);
    cen.multiplyScalar(1 / ring.length);
    for (let j = 0; j < R; j++) {
      const j2 = (j + 1) % R;
      const yMid = (ring[j].y + ring[j2].y) / 2;
      const grp = yMid < bottomY(zf * L) + spec.fasciaTrimBelow * H ? GROUP_TRIM : GROUP_PAINT;
      const u = [0.5, front ? 1 : 0];
      if (front) pushTri(grp, cen, ring[j], ring[j2], u, u, u);
      else pushTri(grp, cen, ring[j2], ring[j], u, u, u);
    }
  };
  cap(rings[rings.length - 1], true, uniq[uniq.length - 1]);
  cap(rings[0], false, uniq[0]);

  const build = (include: number[]): THREE.BufferGeometry => {
    const order: number[] = [];
    const geo = new THREE.BufferGeometry();
    const p: number[] = [];
    const u: number[] = [];
    let start = 0;
    for (const grp of include) {
      for (const idx of groups[grp]) {
        p.push(verts[idx * 3], verts[idx * 3 + 1], verts[idx * 3 + 2]);
        u.push(uvs[idx * 2], uvs[idx * 2 + 1]);
        order.push(idx);
      }
      geo.addGroup(start, groups[grp].length, grp);
      start += groups[grp].length;
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
    smoothNormalsByAngle(geo, 38);
    return geo;
  };

  return {
    geometry: build([GROUP_PAINT, GROUP_WINDSHIELD, GROUP_SIDEGLASS, GROUP_TRIM]),
    liner: build([GROUP_PAINT, GROUP_TRIM]),
    beltY,
    topY,
    bottomY,
    halfW: hwAt,
  };
}

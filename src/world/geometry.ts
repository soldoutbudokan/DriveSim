/**
 * Procedural road geometry from the network: asphalt strips with real
 * cross-section resolution (wheel-track wear, oil-stained lane centres and
 * gutter grime baked into vertex colour, metre-scaled UVs for the aggregate
 * normal/roughness maps), intersection patches, Ontario lane markings
 * (double-yellow centrelines, dashed white dividers, HOV diamonds, stop
 * lines, zebra crosswalks, yield teeth, painted turn arrows at signals),
 * streetcar rails, curbs and slab-jointed sidewalks, highway shoulders and
 * embankments. Everything merges into a handful of draw calls, and the
 * group exposes a wetness hook so rain turns the asphalt glossy.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { polylineAt, polylineLength, type V2 } from '../core/math';
import { BIKE_W, PARK_W, SIDEWALK_W, type EdgeRT, RoadNetwork } from './network';
import { asphaltSet, concreteSet, surfaceMaterial } from './materials';

type HeightFn = (s: number) => number;

/** Ribbon with independent heights per side (used for embankment skirts + curbs). */
function ribbon2(poly: V2[], leftOff: number, rightOff: number, yLeft: HeightFn, yRight: HeightFn, yLift: number): THREE.BufferGeometry {
  const n = poly.length;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx: number[] = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) s += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
    const prev = poly[Math.max(0, i - 1)];
    const next = poly[Math.min(n - 1, i + 1)];
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    const lx = dz;
    const lz = -dx;
    pos[i * 6 + 0] = poly[i].x + lx * leftOff;
    pos[i * 6 + 1] = yLeft(s) + yLift;
    pos[i * 6 + 2] = poly[i].z + lz * leftOff;
    pos[i * 6 + 3] = poly[i].x + lx * rightOff;
    pos[i * 6 + 4] = yRight(s) + yLift;
    pos[i * 6 + 5] = poly[i].z + lz * rightOff;
    uv[i * 4 + 0] = 0;
    uv[i * 4 + 1] = s;
    uv[i * 4 + 2] = Math.abs(leftOff - rightOff);
    uv[i * 4 + 3] = s;
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Two-vertex-wide ribbon spanning lateral offsets [rightOff, leftOff] (left positive). UVs in metres. */
function ribbon(poly: V2[], leftOff: number, rightOff: number, y: HeightFn, yLift: number): THREE.BufferGeometry {
  return ribbonMulti(poly, [rightOff, leftOff], y, yLift, null);
}

/**
 * Ribbon with several vertices across the width (lateral offsets ascending,
 * left positive). Optional per-vertex shade for wear/grime (vertex colour).
 */
function ribbonMulti(poly: V2[], offsets: number[], y: HeightFn, yLift: number, shade: ((lateral: number) => number) | null): THREE.BufferGeometry {
  const n = poly.length;
  const m = offsets.length;
  const pos = new Float32Array(n * m * 3);
  const uv = new Float32Array(n * m * 2);
  const col = shade ? new Float32Array(n * m * 3) : null;
  const idx: number[] = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) s += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
    const prev = poly[Math.max(0, i - 1)];
    const next = poly[Math.min(n - 1, i + 1)];
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    const lx = dz;
    const lz = -dx;
    const h = y(s) + yLift;
    for (let k = 0; k < m; k++) {
      const off = offsets[k];
      const v = (i * m + k) * 3;
      pos[v] = poly[i].x + lx * off;
      pos[v + 1] = h;
      pos[v + 2] = poly[i].z + lz * off;
      uv[(i * m + k) * 2] = off;
      uv[(i * m + k) * 2 + 1] = s;
      if (col && shade) {
        const c = shade(off);
        col[v] = c;
        col[v + 1] = c;
        col[v + 2] = c;
      }
    }
    if (i > 0) {
      for (let k = 0; k < m - 1; k++) {
        const a = (i - 1) * m + k;
        const b = a + 1;
        const c = a + m;
        const d = c + 1;
        // offsets ascend toward the left, so wind (a, c, b) to keep normals up
        idx.push(a, c, b, b, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Densify a polyline so ribbons follow elevation smoothly. */
function densify(poly: V2[], step = 6): V2[] {
  const len = polylineLength(poly);
  if (len < step * 1.5) return poly;
  const out: V2[] = [];
  for (let s = 0; s <= len; s += step) out.push(polylineAt(poly, s).point);
  out.push(poly[poly.length - 1]);
  return out;
}

/** Dash segments along an offset of a base polyline. */
function dashes(base: V2[], offset: number, width: number, y: HeightFn, dashLen: number, gapLen: number, yLift: number, margin = 6): THREE.BufferGeometry[] {
  const len = polylineLength(base);
  const out: THREE.BufferGeometry[] = [];
  for (let s = margin; s < len - margin; s += dashLen + gapLen) {
    const e = Math.min(s + dashLen, len - margin);
    const pts: V2[] = [];
    for (let t = s; t <= e; t += Math.max(1.5, dashLen / 2)) {
      const smp = polylineAt(base, t);
      const lx = smp.dir.z;
      const lz = -smp.dir.x;
      pts.push({ x: smp.point.x + lx * offset, z: smp.point.z + lz * offset });
    }
    if (pts.length >= 2) out.push(ribbon(pts, width / 2, -width / 2, (ss) => y(s + ss), yLift));
  }
  return out;
}

function solidLine(base: V2[], offset: number, width: number, y: HeightFn, yLift: number, margin = 5): THREE.BufferGeometry {
  const len = polylineLength(base);
  const pts: V2[] = [];
  for (let s = margin; s <= len - margin; s += 4) {
    const smp = polylineAt(base, s);
    const lx = smp.dir.z;
    const lz = -smp.dir.x;
    pts.push({ x: smp.point.x + lx * offset, z: smp.point.z + lz * offset });
  }
  if (pts.length < 2) return new THREE.BufferGeometry();
  return ribbon(pts, width / 2, -width / 2, (s) => y(s + margin), yLift);
}

/**
 * Quad centred at p, long axis along dir, length `along`, width `across`.
 * NOTE: every marking geometry must carry a uv attribute — mergeGeometries
 * refuses to merge mixed attribute sets and silently drops the whole batch.
 */
function bar(p: V2, dir: V2, along: number, across: number, yv: number): THREE.BufferGeometry {
  const lx = dir.z;
  const lz = -dir.x;
  const hx = (dir.x * along) / 2;
  const hz = (dir.z * along) / 2;
  const wx = (lx * across) / 2;
  const wz = (lz * across) / 2;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([
    p.x - hx - wx, yv, p.z - hz - wz,
    p.x - hx + wx, yv, p.z - hz + wz,
    p.x + hx - wx, yv, p.z + hz - wz,
    p.x + hx + wx, yv, p.z + hz + wz,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  g.computeVertexNormals();
  return g;
}

/** Small triangle (yield "shark tooth") pointing along -dir. */
function tooth(p: V2, dir: V2, size: number, yv: number): THREE.BufferGeometry {
  const lx = dir.z;
  const lz = -dir.x;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([
    p.x + lx * size * 0.5, yv, p.z + lz * size * 0.5,
    p.x - lx * size * 0.5, yv, p.z - lz * size * 0.5,
    p.x - dir.x * size, yv, p.z - dir.z * size,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
  g.setIndex([0, 1, 2]);
  g.computeVertexNormals();
  return g;
}

function diamond(p: V2, dir: V2, len: number, wid: number, yv: number): THREE.BufferGeometry {
  const lx = dir.z;
  const lz = -dir.x;
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([
    p.x + (dir.x * len) / 2, yv, p.z + (dir.z * len) / 2,
    p.x + (lx * wid) / 2, yv, p.z + (lz * wid) / 2,
    p.x - (dir.x * len) / 2, yv, p.z - (dir.z * len) / 2,
    p.x - (lx * wid) / 2, yv, p.z - (lz * wid) / 2,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0.5, 1, 1, 0.5, 0.5, 0, 0, 0.5]), 2));
  g.setIndex([0, 1, 3, 1, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/** Painted lane arrow (straight / left / right) laid flat at p, pointing along dir. */
function laneArrow(p: V2, dir: V2, kind: 'straight' | 'left' | 'right', yv: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  if (kind === 'straight') {
    s.moveTo(-0.16, -1.6);
    s.lineTo(0.16, -1.6);
    s.lineTo(0.16, 0.4);
    s.lineTo(0.55, 0.4);
    s.lineTo(0, 1.6);
    s.lineTo(-0.55, 0.4);
    s.lineTo(-0.16, 0.4);
    s.closePath();
  } else {
    const m = kind === 'left' ? 1 : -1;
    s.moveTo(-0.16, -1.6);
    s.lineTo(0.16, -1.6);
    s.lineTo(0.16, 0.5);
    s.lineTo(0.16, 0.9);
    s.lineTo(m * -0.3, 0.9);
    s.lineTo(m * -0.3, 1.4);
    s.lineTo(m * -1.2, 0.7);
    s.lineTo(m * -0.3, 0.0);
    s.lineTo(m * -0.3, 0.5);
    s.lineTo(-0.16, 0.5);
    s.closePath();
  }
  const g = new THREE.ShapeGeometry(s);
  // shape is in xy (y = forward); lay flat: y → -z... rotate so +y maps to +dir
  g.rotateX(-Math.PI / 2); // now in xz with shape +y → -z
  const heading = Math.atan2(dir.x, dir.z);
  g.rotateY(heading + Math.PI); // shape "forward" (-z) → dir
  g.translate(p.x, yv, p.z);
  return g;
}

const Y_ROAD = 0.02;
const Y_MARK = 0.055;
const Y_WALK = 0.14;

export interface RoadGroup extends THREE.Group {
  setWetness?: (f: number) => void;
}

export function buildRoadGeometry(net: RoadNetwork): RoadGroup {
  const group = new THREE.Group() as RoadGroup;
  group.name = 'roads';

  const asphalt: THREE.BufferGeometry[] = [];
  const white: THREE.BufferGeometry[] = [];
  const yellow: THREE.BufferGeometry[] = [];
  const walks: THREE.BufferGeometry[] = [];
  const curbs: THREE.BufferGeometry[] = [];
  const rails: THREE.BufferGeometry[] = [];
  const bikePaint: THREE.BufferGeometry[] = [];
  const skirts: THREE.BufferGeometry[] = [];
  const shoulders: THREE.BufferGeometry[] = [];

  /** Lane-centre lateral offsets (+left) for wear shading. */
  const laneCentres = (edge: EdgeRT): number[] => {
    const d = edge.def;
    const W = edge.laneW;
    const out: number[] = [];
    if (d.lanesB === 0) for (let i = 0; i < d.lanesF; i++) out.push(((d.lanesF - 1) / 2 - i) * W);
    else {
      for (let i = 0; i < d.lanesF; i++) out.push(-(i + 0.5) * W);
      for (let i = 0; i < d.lanesB; i++) out.push((i + 0.5) * W);
    }
    return out;
  };

  for (const edge of net.edges.values()) {
    const d = edge.def;
    const base = densify(edge.center, edge.hasElevation ? 4 : 18);
    const y: HeightFn = (s) => edge.elev(s);
    const centres = laneCentres(edge);
    const lot = d.kind === 'lot';
    // cross-section vertices every ~0.45 m so wheel tracks resolve
    const offsets: number[] = [];
    const step = 0.45;
    for (let o = -edge.halfR; o < edge.halfL - 1e-6; o += step) offsets.push(o);
    offsets.push(edge.halfL);
    const shade = (lat: number): number => {
      if (lot) return 1;
      let c = 1;
      for (const lc of centres) {
        const dl = lat - lc;
        // two wheel tracks per lane, darkened + polished
        for (const t of [-0.78, 0.78]) c -= 0.17 * Math.exp(-((dl - t) * (dl - t)) / (2 * 0.24 * 0.24));
        // oil drip line at the centre
        c -= 0.06 * Math.exp(-(dl * dl) / (2 * 0.22 * 0.22));
      }
      // gutter grime along the curbs
      const edgeDist = Math.min(edge.halfL - lat, lat + edge.halfR);
      c -= 0.14 * Math.exp(-(edgeDist * edgeDist) / (2 * 0.35 * 0.35));
      return Math.max(0.6, c);
    };
    asphalt.push(ribbonMulti(base, offsets, y, Y_ROAD, shade));

    // grass embankments under elevated sections
    if (edge.hasElevation) {
      const skirtW = SIDEWALK_W + 7;
      skirts.push(ribbon2(base, edge.halfL + skirtW, edge.halfL + SIDEWALK_W - 0.4, () => 0, (s) => y(s) + 0.1, 0));
      skirts.push(ribbon2(base, -edge.halfR - SIDEWALK_W + 0.4, -edge.halfR - skirtW, (s) => y(s) + 0.1, () => 0, 0));
    }

    const W = edge.laneW;

    if (d.lanesB > 0 && !d.unmarked) {
      if (d.kind === 'city') {
        yellow.push(solidLine(base, 0.14, 0.11, y, Y_MARK));
        yellow.push(solidLine(base, -0.14, 0.11, y, Y_MARK));
      } else {
        yellow.push(...dashes(base, 0, 0.11, y, 3, 6, Y_MARK));
      }
    }

    if (!d.unmarked) {
      for (const [count, sign] of [
        [d.lanesF, -1],
        [d.lanesB, 1],
      ] as Array<[number, number]>) {
        for (let i = 1; i < count; i++) {
          const off = d.lanesB === 0 ? (count / 2 - i) * W : sign * i * W;
          if (d.hov && i === 1) {
            white.push(solidLine(base, off + 0.14, 0.1, y, Y_MARK));
            white.push(solidLine(base, off - 0.14, 0.1, y, Y_MARK));
          } else {
            white.push(...dashes(base, off, 0.11, y, 3, 6, Y_MARK));
          }
        }
      }

      const edgeOffF = d.lanesB === 0 ? -(d.lanesF / 2) * W : -d.lanesF * W;
      const edgeOffB = d.lanesB === 0 ? (d.lanesF / 2) * W : d.lanesB * W;
      white.push(solidLine(base, edgeOffF, 0.11, y, Y_MARK));
      if (d.lanesB > 0 || d.kind === 'highway' || d.kind === 'ramp') {
        white.push(solidLine(base, edgeOffB, 0.11, y, Y_MARK));
      }

      if (d.bike) {
        for (const sign of d.lanesB > 0 ? [-1, 1] : [-1]) {
          const lanes = sign === -1 ? d.lanesF : d.lanesB;
          const off = sign * (lanes * W + BIKE_W);
          white.push(solidLine(base, off, 0.09, y, Y_MARK));
          const mid = sign * (lanes * W + BIKE_W / 2);
          const len = polylineLength(base);
          for (let s = 18; s < len - 12; s += 38) {
            const smp = polylineAt(base, s);
            const lx = smp.dir.z * mid;
            const lz = -smp.dir.x * mid;
            bikePaint.push(bar({ x: smp.point.x + lx, z: smp.point.z + lz }, smp.dir, 4.4, BIKE_W * 0.85, y(s) + Y_MARK - 0.008));
          }
        }
      }

      if (d.parkingF) {
        const off = -(d.lanesF * W + (d.bike ? BIKE_W : 0));
        white.push(solidLine(base, off, 0.09, y, Y_MARK));
        // parking bay ticks
        const len = polylineLength(base);
        for (let s = 40; s < len - 20; s += 6.5) {
          const smp = polylineAt(base, s);
          const mid = off - PARK_W / 2;
          white.push(bar({ x: smp.point.x + smp.dir.z * mid, z: smp.point.z - smp.dir.x * mid }, { x: smp.dir.z, z: -smp.dir.x }, PARK_W, 0.1, y(s) + Y_MARK));
        }
      }
    }

    if (d.hov && d.lanesB === 0) {
      const off = ((d.lanesF - 1) / 2) * W;
      const len = polylineLength(base);
      for (let s = 30; s < len - 30; s += 60) {
        const smp = polylineAt(base, s);
        const lx = smp.dir.z * off;
        const lz = -smp.dir.x * off;
        white.push(diamond({ x: smp.point.x + lx, z: smp.point.z + lz }, smp.dir, 3.6, 0.9, y(s) + Y_MARK));
      }
    }

    if (d.streetcar) {
      for (const sign of [-1, 1]) {
        const laneMid = sign * 0.5 * W;
        for (const railOff of [-0.75, 0.75]) {
          rails.push(solidLine(base, laneMid + railOff, 0.09, y, Y_MARK - 0.01, 0));
        }
      }
    }

    if (d.kind === 'city' || d.kind === 'residential' || d.kind === 'lot') {
      walks.push(ribbon(base, edge.halfL + SIDEWALK_W, edge.halfL + 0.12, y, Y_WALK));
      walks.push(ribbon(base, -edge.halfR - 0.12, -edge.halfR - SIDEWALK_W, y, Y_WALK));
      curbs.push(ribbon2(base, edge.halfL + 0.16, edge.halfL - 0.04, (s) => y(s) + Y_WALK, (s) => y(s) + Y_ROAD, 0));
      curbs.push(ribbon2(base, -edge.halfR + 0.04, -edge.halfR - 0.16, (s) => y(s) + Y_ROAD, (s) => y(s) + Y_WALK, 0));
    }
    if (d.kind === 'highway' || d.kind === 'ramp') {
      // gravel shoulders beyond the paved edge
      shoulders.push(ribbon(base, edge.halfL + 2.4, edge.halfL - 0.05, y, Y_ROAD - 0.004));
      shoulders.push(ribbon(base, -edge.halfR + 0.05, -edge.halfR - 2.4, y, Y_ROAD - 0.004));
    }
  }

  // --- intersection patches ------------------------------------------------
  for (const node of net.nodes.values()) {
    if (!node.edges.length) continue;
    const disc = new THREE.CircleGeometry(node.radius + 0.6, 28);
    disc.rotateX(-Math.PI / 2);
    disc.translate(node.def.x, Y_ROAD + 0.004, node.def.z);
    const uv = disc.getAttribute('uv') as THREE.BufferAttribute;
    const pos = disc.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
    const col = new Float32Array(pos.count * 3).fill(0.93);
    disc.setAttribute('color', new THREE.BufferAttribute(col, 3));
    asphalt.push(disc);
  }

  // --- per-lane approach markings (stop lines, crosswalks, teeth, arrows) --
  const crosswalkNodes = new Set<string>();
  for (const lane of net.lanes) {
    if (lane.kind !== 'drive') continue;
    const control = net.approachControl(lane);
    const node = net.nodes.get(lane.toNode)!;
    const sStop = net.stopLineS(lane);
    const smp = polylineAt(lane.poly, sStop);
    const yv = lane.edge.elev(lane.dir === 1 ? sStop : lane.edge.len - sStop) + Y_MARK;
    if (control === 'stop' || control === 'signal') {
      white.push(bar(smp.point, smp.dir, 0.55, lane.width * 0.92, yv));
    } else if (control === 'yield' || control === 'roundabout-yield') {
      for (let i = -1; i <= 1; i++) {
        const lx = smp.dir.z * i * (lane.width / 3.2);
        const lz = -smp.dir.x * i * (lane.width / 3.2);
        white.push(tooth({ x: smp.point.x + lx, z: smp.point.z + lz }, smp.dir, 0.7, yv));
      }
    }
    // painted turn arrows on multi-lane signalized approaches
    if (control === 'signal' && lane.laneCount > 1 && lane.len > 40) {
      const kind = lane.index === 0 ? 'left' : lane.index === lane.laneCount - 1 ? 'right' : 'straight';
      for (const back of [12, 30]) {
        const sa = sStop - back;
        if (sa < 6) continue;
        const a = polylineAt(lane.poly, sa);
        const ya = lane.edge.elev(lane.dir === 1 ? sa : lane.edge.len - sa) + Y_MARK;
        white.push(laneArrow(a.point, a.dir, kind === 'right' && lane.laneCount === 2 ? 'straight' : kind, ya));
      }
    }
    if ((node.def.control === 'signal' || node.def.control === 'stop-all') && !node.def.noCrosswalk) {
      crosswalkNodes.add(node.def.id);
    }
  }

  for (const id of crosswalkNodes) {
    const node = net.node(id);
    for (const edge of node.edges) {
      const atStart = edge.def.from === id;
      const len = edge.len;
      const sBand = atStart ? node.radius + 1.6 : len - node.radius - 1.6;
      const smp = polylineAt(edge.center, sBand);
      const span = Math.max(edge.halfL, edge.halfR) - 0.4;
      for (let t = -span; t <= span; t += 1.05) {
        const lx = smp.dir.z * t;
        const lz = -smp.dir.x * t;
        white.push(bar({ x: smp.point.x + lx, z: smp.point.z + lz }, smp.dir, 2.6, 0.5, edge.elev(sBand) + Y_MARK));
      }
    }
  }

  // --- materials + meshes ---------------------------------------------------
  const asphaltMat = surfaceMaterial(asphaltSet(), {
    normalScale: 0.9,
    macro: { scale: 34, strength: 0.13, tint: new THREE.Color(0x2c2e33), tintAmount: 0.35 },
  });
  asphaltMat.vertexColors = true;
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe6ebf0, roughness: 0.55 });
  const yellowMat = new THREE.MeshStandardMaterial({ color: 0xe0ad36, roughness: 0.55 });
  const walkMat = surfaceMaterial(concreteSet(), { color: 0xc4c1ba });
  const curbMat = new THREE.MeshStandardMaterial({ color: 0xa8aeb4, roughness: 0.85 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.3, metalness: 0.9 });
  const bikeMat = new THREE.MeshStandardMaterial({ color: 0x2e7d4f, roughness: 0.85 });
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x55793f, roughness: 1 });
  const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x8d8a80, roughness: 1 });

  const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material, receiveShadow = true, name = '', vertexColor = false): void => {
    if (!geos.length) return;
    const prepared = geos
      .filter((g) => g.getAttribute('position') && g.getAttribute('position').count > 0)
      .map((g) => {
        const ng = g.index ? g.toNonIndexed() : g;
        if (vertexColor && !ng.getAttribute('color')) {
          ng.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ng.getAttribute('position').count * 3).fill(1), 3));
        }
        return ng;
      });
    const merged = mergeGeometries(prepared, false);
    if (!merged) {
      console.error(`buildRoadGeometry: failed to merge "${name}" (${geos.length} geometries) — check attribute consistency`);
      return;
    }
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = receiveShadow;
    mesh.name = name;
    group.add(mesh);
  };

  addMerged(asphalt, asphaltMat, true, 'asphalt', true);
  addMerged(white, whiteMat, true, 'markWhite');
  addMerged(yellow, yellowMat, true, 'markYellow');
  addMerged(walks, walkMat, true, 'sidewalks');
  addMerged(curbs, curbMat, true, 'curbs');
  addMerged(rails, railMat, true, 'rails');
  addMerged(bikePaint, bikeMat, true, 'bikePaint');
  addMerged(skirts, grassMat, true, 'embankments');
  addMerged(shoulders, shoulderMat, true, 'shoulders');

  // rain: asphalt and paint turn glossy and darker
  const dryColor = new THREE.Color(0xffffff);
  const wetColor = new THREE.Color(0x8e9094);
  group.setWetness = (f: number): void => {
    asphaltMat.roughness = 1 - 0.62 * f;
    asphaltMat.envMapIntensity = 1 + 1.4 * f;
    asphaltMat.color.lerpColors(dryColor, wetColor, f);
    whiteMat.roughness = 0.55 - 0.35 * f;
    yellowMat.roughness = 0.55 - 0.35 * f;
    walkMat.roughness = 1 - 0.4 * f;
    walkMat.color.lerpColors(new THREE.Color(0xc4c1ba), new THREE.Color(0x8f8d88), f);
  };

  return group;
}

/**
 * Procedural road geometry from the network: asphalt ribbons (with elevation),
 * intersection patches, Ontario lane markings (double-yellow centrelines,
 * dashed white dividers, HOV diamonds, stop lines, zebra crosswalks, yield
 * teeth), streetcar rails, sidewalks and highway shoulders. Everything is
 * merged into a handful of draw calls.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { polylineAt, polylineLength, type V2 } from '../core/math';
import { BIKE_W, PARK_W, SIDEWALK_W, type EdgeRT, type Lane, RoadNetwork } from './network';
import { asphaltTexture, concreteTexture } from './textures';

type HeightFn = (s: number) => number;

/** Ribbon with independent heights per side (used for embankment skirts). */
function ribbon2(poly: V2[], leftOff: number, rightOff: number, yLeft: HeightFn, yRight: HeightFn, yLift: number): THREE.BufferGeometry {
  const n = poly.length;
  const pos = new Float32Array(n * 2 * 3);
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
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Build a ribbon along `poly` spanning lateral offsets [rightOff, leftOff] (left positive). */
function ribbon(poly: V2[], leftOff: number, rightOff: number, y: HeightFn, yLift: number): THREE.BufferGeometry {
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
    // left of travel = (dz, -dx)
    const lx = dz;
    const lz = -dx;
    const h = y(s) + yLift;
    pos[i * 6 + 0] = poly[i].x + lx * leftOff;
    pos[i * 6 + 1] = h;
    pos[i * 6 + 2] = poly[i].z + lz * leftOff;
    pos[i * 6 + 3] = poly[i].x + lx * rightOff;
    pos[i * 6 + 4] = h;
    pos[i * 6 + 5] = poly[i].z + lz * rightOff;
    uv[i * 4 + 0] = 0;
    uv[i * 4 + 1] = s / 8;
    uv[i * 4 + 2] = 1;
    uv[i * 4 + 3] = s / 8;
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
function dashes(
  base: V2[],
  offset: number,
  width: number,
  y: HeightFn,
  dashLen: number,
  gapLen: number,
  yLift: number,
  margin = 6,
): THREE.BufferGeometry[] {
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

const Y_ROAD = 0.02;
const Y_MARK = 0.055;
const Y_WALK = 0.14;

export function buildRoadGeometry(net: RoadNetwork): THREE.Group {
  const group = new THREE.Group();
  group.name = 'roads';

  const asphalt: THREE.BufferGeometry[] = [];
  const white: THREE.BufferGeometry[] = [];
  const yellow: THREE.BufferGeometry[] = [];
  const walks: THREE.BufferGeometry[] = [];
  const curbs: THREE.BufferGeometry[] = [];
  const rails: THREE.BufferGeometry[] = [];
  const bikePaint: THREE.BufferGeometry[] = [];
  const skirts: THREE.BufferGeometry[] = [];

  for (const edge of net.edges.values()) {
    const d = edge.def;
    const base = densify(edge.center, edge.hasElevation ? 4 : 24);
    const y: HeightFn = (s) => edge.elev(s);
    asphalt.push(ribbon(base, edge.halfL, -edge.halfR, y, Y_ROAD));

    // grass embankments under elevated sections
    if (edge.hasElevation) {
      const skirtW = SIDEWALK_W + 7;
      skirts.push(ribbon2(base, edge.halfL + skirtW, edge.halfL + SIDEWALK_W - 0.4, () => 0, (s) => y(s) + 0.1, 0));
      skirts.push(ribbon2(base, -edge.halfR - SIDEWALK_W + 0.4, -edge.halfR - skirtW, (s) => y(s) + 0.1, () => 0, 0));
    }

    const W = edge.laneW;

    if (d.lanesB > 0 && !d.unmarked) {
      // two-way centreline: double solid yellow on city, dashed yellow on residential
      if (d.kind === 'city') {
        yellow.push(solidLine(base, 0.14, 0.11, y, Y_MARK));
        yellow.push(solidLine(base, -0.14, 0.11, y, Y_MARK));
      } else {
        yellow.push(...dashes(base, 0, 0.11, y, 3, 6, Y_MARK));
      }
    }

    if (!d.unmarked) {
      // same-direction dividers (white dashed)
      for (const [count, sign] of [
        [d.lanesF, -1],
        [d.lanesB, 1],
      ] as Array<[number, number]>) {
        for (let i = 1; i < count; i++) {
          const off = d.lanesB === 0 ? (count / 2 - i) * W : sign * i * W;
          if (d.hov && i === 1) {
            // HOV separator: double solid white
            white.push(solidLine(base, off + 0.14, 0.1, y, Y_MARK));
            white.push(solidLine(base, off - 0.14, 0.1, y, Y_MARK));
          } else {
            white.push(...dashes(base, off, 0.11, y, 3, 6, Y_MARK));
          }
        }
      }

      // outer edge lines
      const edgeOffF = d.lanesB === 0 ? -(d.lanesF / 2) * W : -d.lanesF * W;
      const edgeOffB = d.lanesB === 0 ? (d.lanesF / 2) * W : d.lanesB * W;
      white.push(solidLine(base, edgeOffF, 0.11, y, Y_MARK));
      if (d.lanesB > 0 || d.kind === 'highway' || d.kind === 'ramp') {
        white.push(solidLine(base, edgeOffB, 0.11, y, Y_MARK));
      }

      // bike lane: outer line + periodic green pads
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

      // parking lane tick marks
      if (d.parkingF) {
        const off = -(d.lanesF * W + (d.bike ? BIKE_W : 0));
        white.push(solidLine(base, off, 0.09, y, Y_MARK));
      }
    }

    // HOV diamonds in lane 0 of one-way highway edges
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

    // streetcar rails (innermost lane each direction)
    if (d.streetcar) {
      for (const sign of [-1, 1]) {
        const laneMid = sign * 0.5 * W;
        for (const railOff of [-0.75, 0.75]) {
          rails.push(solidLine(base, laneMid + railOff, 0.09, y, Y_MARK - 0.01, 0));
        }
      }
    }

    // sidewalks + curb faces (city/residential streets)
    if (d.kind === 'city' || d.kind === 'residential' || d.kind === 'lot') {
      walks.push(ribbon(base, edge.halfL + SIDEWALK_W, edge.halfL + 0.12, y, Y_WALK));
      walks.push(ribbon(base, -edge.halfR - 0.12, -edge.halfR - SIDEWALK_W, y, Y_WALK));
      curbs.push(ribbon2(base, edge.halfL + 0.16, edge.halfL - 0.04, (s) => y(s) + Y_WALK, (s) => y(s) + Y_ROAD, 0));
      curbs.push(ribbon2(base, -edge.halfR + 0.04, -edge.halfR - 0.16, (s) => y(s) + Y_ROAD, (s) => y(s) + Y_WALK, 0));
    }
  }

  // --- intersection patches ------------------------------------------------
  for (const node of net.nodes.values()) {
    if (!node.edges.length) continue;
    const disc = new THREE.CircleGeometry(node.radius + 0.6, 26);
    disc.rotateX(-Math.PI / 2);
    disc.translate(node.def.x, Y_ROAD + 0.004, node.def.z);
    asphalt.push(disc);
  }

  // --- per-lane approach markings (stop lines, crosswalks, teeth) ---------
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
    if ((node.def.control === 'signal' || node.def.control === 'stop-all') && !node.def.noCrosswalk) {
      crosswalkNodes.add(node.def.id);
    }
  }

  for (const id of crosswalkNodes) {
    const node = net.node(id);
    for (const edge of node.edges) {
      // crossing band across this approach, just outside the node box
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
  const asphaltMat = new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.94, metalness: 0 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe8edf2, roughness: 0.62 });
  const yellowMat = new THREE.MeshStandardMaterial({ color: 0xe2b13c, roughness: 0.62 });
  const walkMat = new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.95 });
  const curbMat = new THREE.MeshStandardMaterial({ color: 0xa6adb5, roughness: 0.9 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x6a7077, roughness: 0.35, metalness: 0.9 });
  const bikeMat = new THREE.MeshStandardMaterial({ color: 0x2e7d4f, roughness: 0.85 });

  const addMerged = (geos: THREE.BufferGeometry[], mat: THREE.Material, receiveShadow = true, name = ''): void => {
    if (!geos.length) return;
    const merged = mergeGeometries(
      geos.filter((g) => g.getAttribute('position') && g.getAttribute('position').count > 0).map((g) => (g.index ? g.toNonIndexed() : g)),
      false,
    );
    if (!merged) {
      // mergeGeometries returns null on mixed attribute sets — never swallow that
      console.error(`buildRoadGeometry: failed to merge "${name}" (${geos.length} geometries) — check attribute consistency`);
      return;
    }
    const mesh = new THREE.Mesh(merged, mat);
    mesh.receiveShadow = receiveShadow;
    mesh.name = name;
    group.add(mesh);
  };

  const grassMat = new THREE.MeshStandardMaterial({ color: 0x55793f, roughness: 1 });

  addMerged(asphalt, asphaltMat, true, 'asphalt');
  addMerged(white, whiteMat, true, 'markWhite');
  addMerged(yellow, yellowMat, true, 'markYellow');
  addMerged(walks, walkMat, true, 'sidewalks');
  addMerged(curbs, curbMat, true, 'curbs');
  addMerged(rails, railMat, true, 'rails');
  addMerged(bikePaint, bikeMat, true, 'bikePaint');
  addMerged(skirts, grassMat, true, 'embankments');

  return group;
}

/**
 * World dressing: lays out the district's blocks with the building
 * generators (towers with podiums, condo midrises with balconies, Toronto
 * bay-and-gable semis, industrial yards, the school, the DriveTest centre),
 * plants boulevard / backyard / park / forest trees and front-yard hedges,
 * runs street furniture along the network (cobra-head streetlights, hydro
 * poles with sagging wires, streetcar catenary, hydrants, benches, bins,
 * transit shelters, guardrails, gantries, high-mast lighting, the roundabout
 * island, construction props), generates Ontario signage from the network,
 * and parks cars for the parallel-parking exercise. Returns the night hook.
 */

import * as THREE from 'three';
import { mulberry32, polylineAt, nearestOnPolyline, type V2 } from '../core/math';
import type { CollisionWorld, CircleCollider } from '../physics/collision';
import { buildCar, type BuiltCar } from '../vehicle/carFactory';
import { LANE_W, RoadNetwork, SIDEWALK_W, type EdgeRT } from './network';
import { PARKING_BAYS, LOT_RECT, ZONES, STREETCAR_STOPS } from './map';
import { streetBladeTexture, type SignKind } from './textures';
import { addDriveTest, addIndustrial, addMidrise, addSchool, addTower, buildHouses, buildingNight, finishBuildings, houseVariant, newBuildingContext, type HousePlacement } from './buildings';
import { buildGround, buildHedges, buildTrees, type HedgeSpot, type TreeSpot } from './vegetation';
import { Furniture, furnitureNight, type FurnitureResult } from './furniture';
import { tactileTexture } from './materials';

export interface Cone {
  mesh: THREE.Object3D;
  collider: CircleCollider;
  knocked: boolean;
  t: number;
}

export interface PropsResult {
  group: THREE.Group;
  cones: Cone[];
  parkedCars: BuiltCar[];
  /** Drive night factor 0..1: window/streetlight emissives. */
  setNight(f: number): void;
  /** Snow cover 0..1 on grass and roofs. */
  setSnow(f: number): void;
}

type BlockStyle = 'tower' | 'midrise' | 'house' | 'industrial' | 'park' | 'school';

interface BlockDef {
  /** Bounding street centrelines. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  style: BlockStyle;
}

export function buildProps(net: RoadNetwork, collision: CollisionWorld, seed = 20260610): PropsResult {
  const rng = mulberry32(seed);
  const group = new THREE.Group();
  group.name = 'props';
  const tStart = performance.now();
  const marks: string[] = [];
  const mark = (label: string): void => {
    marks.push(`${label} ${Math.round(performance.now() - tStart)}`);
  };
  const cones: Cone[] = [];
  const parkedCars: BuiltCar[] = [];

  /** Paved half-width of the street nearest a point (for setbacks). */
  const streetHalf = (x: number, z: number): number => {
    let best = 6;
    let bestD = Infinity;
    for (const e of net.edgesNear(x, z)) {
      const n = nearestOnPolyline(e.center, { x, z });
      if (n.dist < bestD) {
        bestD = n.dist;
        best = Math.max(e.halfL, e.halfR);
      }
    }
    return best;
  };

  /* ---------------- ground, water, landmark ---------------- */
  const groundMat = buildGround(group);
  const furn = new Furniture(collision, rng);
  furn.lake(group);
  furn.cnTower(group);
  furn.skyline(group, rng);

  mark('ground+lake');
  /* ---------------- blocks ---------------- */
  const colEdges = [-700, -600, -300, 0, 300, 600, 700];
  const rowEdges = [-380, -150, 100, 350, 550];
  const styleGrid: BlockStyle[][] = [
    ['industrial', 'midrise', 'midrise', 'midrise', 'midrise', 'industrial'],
    ['midrise', 'tower', 'tower', 'tower', 'midrise', 'park'],
    ['midrise', 'house', 'midrise', 'house', 'house', 'park'],
    ['house', 'house', 'park', 'school', 'house', 'park'],
  ];
  const blocks: BlockDef[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) blocks.push({ x0: colEdges[c], x1: colEdges[c + 1], z0: rowEdges[r], z1: rowEdges[r + 1], style: styleGrid[r][c] });

  const bctx = newBuildingContext(collision, rng);
  const treeSpots: TreeSpot[] = [];
  const hedges: HedgeSpot[] = [];
  const bushes: Array<{ x: number; z: number; s: number }> = [];
  const houses: HousePlacement[] = [];
  let towerIdx = 0;

  for (const b of blocks) {
    const M = 24;
    const x0 = b.x0 + M;
    const x1 = b.x1 - M;
    const z0 = b.z0 + M;
    const z1 = b.z1 - M;
    const bw = x1 - x0;
    const bd = z1 - z0;
    if (bw < 18 || bd < 18) continue;
    if (b.style === 'tower') {
      const n = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        const w = 22 + rng() * 14;
        const d = 20 + rng() * 12;
        const h = 40 + rng() * 75;
        const x = Math.min(x0 + w / 2 + 4 + rng() * Math.max(4, bw - w - 8), x1 - w / 2 - 4);
        const z = Math.min(z0 + d / 2 + 4 + rng() * Math.max(4, bd - d - 8), z1 - d / 2 - 4);
        addTower(bctx, x, z, w, d, h, towerIdx++);
      }
      // plaza trees between towers
      for (let i = 0; i < 10; i++) treeSpots.push({ x: x0 + rng() * bw, z: z0 + rng() * bd, kind: 'maple', scale: 0.7 });
    } else if (b.style === 'midrise') {
      // a row along the north and south streets, storefronts facing the street
      for (const [zEdge, facing] of [[b.z0, 0], [b.z1, 1]] as Array<[number, number]>) {
        const half = streetHalf((b.x0 + b.x1) / 2, zEdge);
        const front = zEdge + (facing === 0 ? 1 : -1) * (half + SIDEWALK_W + 1.0);
        let x = x0 + 2;
        while (x < x1 - 14) {
          const w = 14 + rng() * 12;
          if (x + w > x1 - 2) break;
          const d = 14 + rng() * 8;
          const h = 12 + rng() * 14;
          const zc = front + (facing === 0 ? 1 : -1) * (d / 2);
          addMidrise(bctx, x + w / 2, zc, w, d, h, towerIdx++, facing);
          x += w + 1.5 + rng() * 3;
        }
      }
      for (let i = 0; i < 6; i++) treeSpots.push({ x: x0 + rng() * bw, z: (z0 + z1) / 2 + (rng() - 0.5) * 20, scale: 0.8 });
    } else if (b.style === 'house') {
      for (const [zEdge, heading] of [[b.z0, Math.PI], [b.z1, 0]] as Array<[number, number]>) {
        const half = streetHalf((b.x0 + b.x1) / 2, zEdge);
        const lotLine = zEdge + (heading === Math.PI ? 1 : -1) * (half + SIDEWALK_W + 0.3);
        let x = b.x0 + half + SIDEWALK_W + 4;
        const xEnd = b.x1 - (half + SIDEWALK_W + 4);
        while (x < xEnd) {
          const variant = Math.floor(rng() * 6);
          const hv = houseVariant(variant);
          if (x + hv.width > xEnd) break;
          const cx = x + hv.width / 2;
          const setback = 5.5 + rng() * 1.5;
          const cz = lotLine + (heading === Math.PI ? 1 : -1) * (setback + hv.depth / 2);
          houses.push({ x: cx, z: cz, heading, variant });
          // front-yard hedge / bushes and a boulevard tree
          const sign = heading === Math.PI ? 1 : -1;
          if (rng() < 0.55) hedges.push({ x: cx + (rng() < 0.5 ? -hv.width * 0.25 : hv.width * 0.25), z: lotLine + sign * 0.8, heading: 0, length: hv.width * 0.42 });
          if (rng() < 0.6) bushes.push({ x: cx - hv.width * 0.42, z: lotLine + sign * (setback - 1.2), s: 0.7 + rng() * 0.5 });
          if (rng() < 0.75) treeSpots.push({ x: cx + (rng() - 0.5) * 3, z: lotLine - sign * 1.6, kind: rng() < 0.6 ? 'maple' : 'oak', scale: 0.8 + rng() * 0.4 });
          // backyard tree
          if (rng() < 0.6) treeSpots.push({ x: cx + (rng() - 0.5) * hv.width * 0.6, z: cz + sign * (hv.depth / 2 + 4 + rng() * 5) });
          x += hv.width + 1.2 + rng() * 1.5;
        }
      }
    } else if (b.style === 'park' || b.style === 'school') {
      const n = Math.floor((bw * bd) / 520);
      for (let i = 0; i < n; i++) treeSpots.push({ x: x0 + rng() * bw, z: z0 + rng() * bd, scale: 0.9 + rng() * 0.6 });
      if (b.style === 'park') {
        // park paths in a cross, benches and bins at the centre
        const cx = (x0 + x1) / 2;
        const cz = (z0 + z1) / 2;
        furn.batch.add('sidewalk', pathSlab(bw, 2.4), cx, 0.02, cz);
        furn.batch.add('sidewalk', pathSlab(2.4, bd), cx, 0.02, cz);
        for (const [dx, dz, h] of [[-4, 3, 0], [4, -3, Math.PI], [3, 4, Math.PI / 2], [-3, -4, -Math.PI / 2]] as Array<[number, number, number]>) furn.bench(cx + dx, cz + dz, h);
        furn.bin(cx + 5.5, cz + 5.5);
        for (let i = 0; i < 6; i++) bushes.push({ x: x0 + rng() * bw, z: z0 + rng() * bd, s: 0.8 + rng() * 0.8 });
      } else {
        addSchool(bctx, x0 - 6, z0 - 8, x1 + 6, z1 + 8);
      }
    } else if (b.style === 'industrial') {
      addIndustrial(bctx, x0 - 6, z0 - 6, x1 + 6, z1 + 6, towerIdx++);
    }
  }
  addDriveTest(bctx, LOT_RECT);
  mark('blocks');
  buildHouses(houses, group, collision);
  mark('houses');
  const buildings = finishBuildings(bctx, group);
  mark('buildings-merge');

  /* ---------------- vegetation ---------------- */
  for (let i = 0; i < 140; i++) treeSpots.push({ x: -960 + rng() * 1920, z: -760 + rng() * 80, kind: rng() < 0.45 ? 'spruce' : 'oak', scale: 1 + rng() * 0.6 });
  for (let i = 0; i < 50; i++) treeSpots.push({ x: -960 + rng() * 300, z: 300 + rng() * 340, scale: 1 + rng() * 0.5 });
  for (let i = 0; i < 50; i++) treeSpots.push({ x: 760 + rng() * 220, z: -300 + rng() * 900, scale: 1 + rng() * 0.5 });
  for (let i = 0; i < 40; i++) treeSpots.push({ x: -800 + rng() * 1600, z: -560 + rng() * 40, kind: 'spruce', scale: 0.8 + rng() * 0.4 });
  // boulevard trees on the main streets (outside the sidewalk)
  for (const edge of net.edges.values()) {
    const k = edge.def.kind;
    if (k !== 'city' && k !== 'residential') continue;
    const step = k === 'city' ? 22 : 16;
    for (let s = 14; s < edge.len - 14; s += step) {
      const smp = polylineAt(edge.center, s);
      for (const side of [1, -1]) {
        if (rng() < 0.35) continue;
        const off = side * ((side > 0 ? edge.halfL : edge.halfR) + SIDEWALK_W + 1.4);
        treeSpots.push({ x: smp.point.x + smp.dir.z * off, z: smp.point.z - smp.dir.x * off, kind: rng() < 0.7 ? 'maple' : 'oak', scale: 0.75 + rng() * 0.35 });
      }
    }
  }
  const rb = furn.roundaboutIsland(600, -150, 13);
  for (const s of rb) treeSpots.push({ x: s.x, z: s.z, kind: 'maple', scale: s.scale });
  bushes.push({ x: 600, z: -150, s: 1.6 });
  // cull trees that landed on pavement
  const clear = treeSpots.filter((t) => {
    for (const e of net.edgesNear(t.x, t.z)) {
      const n = nearestOnPolyline(e.center, t);
      const half = (n.lateral > 0 ? e.halfL : e.halfR) + SIDEWALK_W + 0.6;
      if (Math.abs(n.lateral) < half && n.s > -2 && n.s < e.len + 2) return false;
      for (const nid of [e.def.from, e.def.to]) {
        const nd = net.node(nid);
        if (Math.hypot(t.x - nd.def.x, t.z - nd.def.z) < nd.radius + SIDEWALK_W + 2) return false;
      }
    }
    if (t.x > LOT_RECT.x0 - 4 && t.x < LOT_RECT.x1 + 4 && t.z > LOT_RECT.z0 - 4 && t.z < LOT_RECT.z1 + 4) return false;
    return true;
  });
  buildTrees(clear, group, collision, rng);
  buildHedges(hedges, bushes, group);
  mark('vegetation');

  /* ---------------- street furniture along the network ---------------- */
  const sidePoint = (edge: EdgeRT, s: number, side: 1 | -1, extra: number): { x: number; z: number; heading: number; y: number; dir: V2 } => {
    const smp = polylineAt(edge.center, s);
    const off = side * ((side > 0 ? edge.halfL : edge.halfR) + extra);
    return {
      x: smp.point.x + smp.dir.z * off,
      z: smp.point.z - smp.dir.x * off,
      heading: Math.atan2(smp.dir.x, smp.dir.z),
      y: edge.elev(s),
      dir: smp.dir,
    };
  };

  for (const edge of net.edges.values()) {
    const k = edge.def.kind;
    if (k === 'city' || k === 'highway' || k === 'ramp') {
      // cobra-head streetlights, alternating sides; taller on the highway
      const step = k === 'highway' ? 60 : k === 'ramp' ? 45 : 36;
      for (let s = step / 2; s < edge.len - 8; s += step) {
        const side: 1 | -1 = Math.floor(s / step) % 2 === 0 ? 1 : -1;
        const p = sidePoint(edge, s, side, k === 'highway' ? 0.8 : SIDEWALK_W - 0.5);
        furn.streetlight(p.x, p.z, p.heading + (side > 0 ? -1 : 1) * Math.PI * 0.5, p.y, k === 'highway');
      }
    }
    if (k === 'residential' || (k === 'city' && edge.def.name.includes('Bathurst'))) {
      // wooden hydro poles with wires down one side
      const step = 34;
      let prev: THREE.Vector3[] | null = null;
      for (let s = 10; s < edge.len - 6; s += step) {
        const p = sidePoint(edge, s, -1, SIDEWALK_W + 0.3);
        const pts = furn.hydroPole(p.x, p.z, p.heading + Math.PI / 2, rng() < 0.3, p.y);
        if (prev) furn.wires(prev, pts, 0.5);
        prev = pts;
      }
    }
    if (edge.def.streetcar) {
      // catenary: paired poles + span wire + two contact wires along the tracks
      const H = 5.6;
      let prevL: V2 | null = null;
      let prevR: V2 | null = null;
      for (let s = 12; s < edge.len - 8; s += 30) {
        const a = sidePoint(edge, s, 1, SIDEWALK_W - 0.7);
        const c = sidePoint(edge, s, -1, SIDEWALK_W - 0.7);
        for (const p of [a, c]) furn.batch.add('poleDark', new THREE.CylinderGeometry(0.09, 0.12, 7.2, 8), p.x, p.y + 3.6, p.z);
        furn.wires([new THREE.Vector3(a.x, a.y + H + 0.9, a.z)], [new THREE.Vector3(c.x, c.y + H + 0.9, c.z)], 0.35);
        const smp = polylineAt(edge.center, s);
        const L: V2 = { x: smp.point.x + smp.dir.z * (LANE_W.city * 0.5), z: smp.point.z - smp.dir.x * (LANE_W.city * 0.5) };
        const R: V2 = { x: smp.point.x - smp.dir.z * (LANE_W.city * 0.5), z: smp.point.z + smp.dir.x * (LANE_W.city * 0.5) };
        for (const [p, q] of [[L, prevL], [R, prevR]] as Array<[V2, V2 | null]>) {
          if (q) furn.lines.push(new THREE.Vector3(q.x, H, q.z), new THREE.Vector3(p.x, H, p.z));
        }
        // hangers from the span down to each contact wire
        for (const p of [L, R]) furn.lines.push(new THREE.Vector3(p.x, H + 0.55, p.z), new THREE.Vector3(p.x, H, p.z));
        prevL = L;
        prevR = R;
      }
    }
    if (k === 'city' || k === 'residential') {
      // hydrants, bins, benches, manholes
      for (let s = 30 + rng() * 20; s < edge.len - 20; s += 70 + rng() * 40) {
        const side: 1 | -1 = rng() < 0.5 ? 1 : -1;
        const p = sidePoint(edge, s, side, 0.7);
        furn.hydrant(p.x, p.z, p.y + 0.12);
      }
      if (k === 'city') {
        for (let s = 50 + rng() * 30; s < edge.len - 30; s += 90 + rng() * 50) {
          const side: 1 | -1 = rng() < 0.5 ? 1 : -1;
          const p = sidePoint(edge, s, side, SIDEWALK_W - 0.6);
          furn.bench(p.x, p.z, p.heading + (side > 0 ? -1 : 1) * Math.PI * 0.5, p.y + 0.12);
          furn.bin(p.x + p.dir.x * 1.6, p.z + p.dir.z * 1.6, p.y + 0.12);
        }
      }
      for (let s = 25 + rng() * 40; s < edge.len - 20; s += 55 + rng() * 40) {
        const lane = (rng() < 0.5 ? 1 : -1) * LANE_W[k] * (0.5 + Math.floor(rng() * Math.max(1, edge.def.lanesF)));
        const smp = polylineAt(edge.center, s);
        furn.batch.add('poleDark', new THREE.CylinderGeometry(0.34, 0.34, 0.03, 16), smp.point.x + smp.dir.z * lane, edge.elev(s) + 0.035, smp.point.z - smp.dir.x * lane);
      }
    }
    if (k === 'highway') {
      // guardrails on both shoulders, plus the median barrier side
      const sampleAt = (s: number) => polylineAt(edge.center, s);
      furn.guardrail(edge.center, edge.halfL + 0.4, 4, edge.len - 4, (s) => edge.elev(s), sampleAt);
      furn.guardrail(edge.center, -(edge.halfR + 0.4), 4, edge.len - 4, (s) => edge.elev(s), sampleAt);
    }
    if (k === 'ramp') {
      const sampleAt = (s: number) => polylineAt(edge.center, s);
      furn.guardrail(edge.center, -(edge.halfR + 0.3), 6, edge.len - 6, (s) => edge.elev(s), sampleAt);
    }
  }
  // high-mast lighting at the ramp junctions
  furn.highMast(-140, -500);
  furn.highMast(160, -500);
  furn.highMast(-310, -430);
  furn.highMast(480, -400);

  // corner furniture: postboxes + bins at signalized corners, curb ramps at crosswalks
  const tactile = new THREE.MeshStandardMaterial({ map: tactileTexture(), roughness: 0.8 });
  for (const node of net.nodes.values()) {
    const c = node.def.control;
    if ((c === 'signal' || c === 'stop-all') && !node.def.noCrosswalk) {
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const r = node.radius + 1.0;
        const px = node.def.x + sx * r;
        const pz = node.def.z + sz * r;
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), tactile);
        plate.rotation.x = -Math.PI / 2;
        plate.rotation.z = Math.atan2(sx, sz);
        plate.position.set(px + sx * 0.6, 0.145, pz + sz * 0.6);
        group.add(plate);
      }
      if (c === 'signal' && rng() < 0.6) {
        const r = node.radius + SIDEWALK_W;
        furn.postbox(node.def.x + r, node.def.z - r, Math.PI / 2, 0.12);
        furn.bin(node.def.x - r, node.def.z + r, 0.12);
      }
    }
  }

  /* ---------------- network signage ---------------- */
  for (const lane of net.lanes) {
    if (lane.kind !== 'drive' || lane.index !== lane.laneCount - 1) continue; // one sign per approach (curb lane)
    const control = net.approachControl(lane);
    if (control === 'none') continue;
    const sStop = net.stopLineS(lane);
    const smp = polylineAt(lane.poly, sStop - 1);
    const heading = Math.atan2(smp.dir.x, smp.dir.z);
    const off = -(lane.width / 2 + 1.0);
    const px = smp.point.x + smp.dir.z * off;
    const pz = smp.point.z - smp.dir.x * off;
    const y = lane.edge.elev(lane.dir === 1 ? sStop : lane.edge.len - sStop);
    if (control === 'stop') furn.signPost(px, pz, y, heading + Math.PI, 'stop', '', 0.66);
    else if (control === 'yield' || control === 'roundabout-yield') furn.signPost(px, pz, y, heading + Math.PI, 'yield', '', 0.66);
    if (control === 'roundabout-yield') {
      const smp2 = polylineAt(lane.poly, Math.max(4, sStop - 24));
      furn.signPost(smp2.point.x + smp2.dir.z * off, smp2.point.z - smp2.dir.x * off, 0, heading + Math.PI, 'roundabout', '', 0.6);
    }
  }
  for (const edge of net.edges.values()) {
    const d = edge.def;
    if (d.kind === 'roundabout' || d.kind === 'lot' || d.merge) continue;
    if (edge.len < 90) continue;
    const positions = d.kind === 'highway' ? [0.35, 0.75] : [0.5];
    for (const frac of positions) {
      for (const dir of d.lanesB > 0 ? [1, -1] : [1]) {
        const s = edge.len * (dir === 1 ? frac : 1 - frac);
        const smp = polylineAt(edge.center, s);
        const side = dir === 1 ? -(edge.halfR + 0.9) : edge.halfL + 0.9;
        const px = smp.point.x + smp.dir.z * side;
        const pz = smp.point.z - smp.dir.x * side;
        const heading = Math.atan2(smp.dir.x * dir, smp.dir.z * dir);
        furn.signPost(px, pz, edge.elev(s), heading + Math.PI, 'max', String(d.limit), 0.5);
      }
    }
  }
  for (const zone of ZONES) {
    const kind: SignKind = zone.kind === 'school' ? 'school' : zone.kind === 'construction' ? 'construction' : 'playground';
    const cz = (zone.z0 + zone.z1) / 2;
    const tab = zone.kind === 'construction' ? 'constructionMax' : 'schoolMax';
    furn.signPost(zone.x0 + 4, cz - 6, 0, Math.PI / 2 + Math.PI, kind, '', 0.6);
    furn.signPost(zone.x0 + 14, cz - 6, 0, Math.PI / 2 + Math.PI, tab, String(zone.limit), 0.48);
    furn.signPost(zone.x1 - 4, cz + 6, 0, -Math.PI / 2 + Math.PI, kind, '', 0.6);
    furn.signPost(zone.x1 - 14, cz + 6, 0, -Math.PI / 2 + Math.PI, tab, String(zone.limit), 0.48);
  }
  // highway guidance: gantries over the eastbound lanes + posts
  furn.signPost(-500, -373, 0, Math.PI / 2 + Math.PI, 'guide401', 'EAST', 1.1, 3.4);
  furn.signPost(-350, -437, 0, (3 * Math.PI) / 4 + Math.PI, 'merge', '', 0.7);
  furn.signPost(-80, -448, 0, Math.PI / 2 + Math.PI, 'hov', '', 0.7);
  furn.gantry(-60, -460, Math.PI / 2, 16, [{ kind: 'exit', text: 'EXIT 12 · 500 m', at: 4, w: 4.2 }, { kind: 'guide401', text: 'EAST', at: -4, w: 3.2 }]);
  furn.gantry(150, -462, Math.PI / 2, 18, [{ kind: 'exit', text: 'EXIT 12', at: 6, w: 4.2 }]);
  furn.signPost(248, -451, 0, Math.PI / 2 + Math.PI, 'max', '60', 0.5);
  furn.signPost(594, 130, 0, Math.PI, 'hill', '10%', 0.6);
  furn.signPost(-594, 368, 0, 0, 'deadEnd', '', 0.55);
  furn.signPost(-600, -392, 0, Math.PI, 'driveTest', '', 1.2, 2.8);

  // street name blades at signalized corners
  for (const node of net.nodes.values()) {
    if (node.def.control !== 'signal') continue;
    const names = new Set<string>();
    for (const e of node.edges) names.add(e.def.name);
    const arr = [...names].slice(0, 2);
    arr.forEach((name, i) => {
      const blade = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.32), new THREE.MeshStandardMaterial({ map: streetBladeTexture(name), roughness: 0.5, side: THREE.DoubleSide }));
      blade.position.set(node.def.x - node.radius - 1.2, 3.5 - i * 0.36, node.def.z - node.radius - 1.2);
      blade.rotation.y = i === 0 ? Math.PI / 2 : 0;
      group.add(blade);
    });
  }

  /* ---------------- construction zone ---------------- */
  const kg5 = net.edges.get('kg5');
  if (kg5?.def.closureF) {
    const [s0, s1] = kg5.def.closureF;
    const coneGeo = new THREE.ConeGeometry(0.2, 0.7, 10);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1e, roughness: 0.6 });
    const bandMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.6 });
    const laneOff = -(kg5.def.lanesF - 0.5) * LANE_W.city;
    let i = 0;
    for (let s = s0 - 28; s <= s1; s += 7) {
      const taper = Math.min(1, Math.max(0, (s - (s0 - 28)) / 30));
      const smp = polylineAt(kg5.center, Math.min(s, kg5.len - 4));
      const off = laneOff + (1 - taper) * LANE_W.city * 0.9 - 0.2 * taper;
      const px = smp.point.x + smp.dir.z * (off + LANE_W.city / 2 - 0.4);
      const pz = smp.point.z - smp.dir.x * (off + LANE_W.city / 2 - 0.4);
      const cone = new THREE.Group();
      const body = new THREE.Mesh(coneGeo, coneMat);
      body.position.y = 0.35;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 0.1, 10), bandMat);
      band.position.y = 0.45;
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.5), coneMat);
      base.position.y = 0.025;
      cone.add(body, band, base);
      cone.position.set(px, 0.02, pz);
      body.castShadow = true;
      group.add(cone);
      const collider: CircleCollider = { x: px, z: pz, r: 0.32, tag: 'cone', ref: i++ };
      collision.addCircle(collider);
      cones.push({ mesh: cone, collider, knocked: false, t: 0 });
    }
    const smpMid = polylineAt(kg5.center, (s0 + s1) / 2);
    const heading = Math.atan2(smpMid.dir.x, smpMid.dir.z);
    const at = (s: number, lat: number): [number, number] => {
      const p = polylineAt(kg5.center, s);
      return [p.point.x + p.dir.z * lat, p.point.z - p.dir.x * lat];
    };
    furn.excavator(...at((s0 + s1) / 2, laneOff), heading + 0.3);
    for (const s of [s0 + 12, s0 + 15.2, s1 - 20, s1 - 16.8]) furn.jerseyBarrier(...at(s, laneOff - LANE_W.city * 0.42), heading);
    for (const s of [s0 + 30, s0 + 55, s1 - 40]) furn.barrel(...at(s, laneOff + LANE_W.city * 0.35));
    // spoil pile + a portable sign
    furn.batch.add('boardwalk', new THREE.SphereGeometry(1.6, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), ...at(s1 - 8, laneOff), 0, 1, 0.6, 1);
    furn.signPost(...at(s0 - 45, laneOff - LANE_W.city * 0.6), 0, heading + Math.PI, 'construction', '', 0.7, 1.6);
  }

  /* ---------------- parked cars (parallel-parking exercise) ---------------- */
  const bat3 = net.edges.get(PARKING_BAYS.edgeId);
  if (bat3) {
    const off = -(LANE_W.residential + 2.3 / 2 + 0.15);
    const place = (s: number, kind: 'sedan' | 'suv' | 'hatch', color: number): void => {
      const smp = polylineAt(bat3.center, s);
      const px = smp.point.x + smp.dir.z * off;
      const pz = smp.point.z - smp.dir.x * off;
      const heading = Math.atan2(smp.dir.x, smp.dir.z);
      const car = buildCar(kind, color);
      car.root.position.set(px, 0, pz);
      car.root.rotation.y = heading;
      car.root.traverse((o) => (o.castShadow = o.castShadow || o.type === 'Mesh'));
      group.add(car.root);
      parkedCars.push(car);
      collision.addOBB({ x: px, z: pz, heading, halfW: car.dims.width / 2, halfL: car.dims.length / 2, tag: 'parkedCar' });
    };
    const colors = [0x8a8d93, 0x3b4754, 0x6d2e2a, 0x2e4d3a, 0xcfd2d6, 0x1d1f24];
    for (let s = PARKING_BAYS.s0; s <= PARKING_BAYS.s1; s += 12.5) {
      const inGap = s > PARKING_BAYS.gap0 - 6 && s < PARKING_BAYS.gap1 + 6;
      if (inGap || rng() < 0.3) continue;
      place(s, rng() < 0.3 ? 'suv' : rng() < 0.5 ? 'hatch' : 'sedan', colors[Math.floor(rng() * colors.length)]);
    }
    place(PARKING_BAYS.gap0 - 3.2, 'sedan', 0xb8434e);
    place(PARKING_BAYS.gap1 + 3.2, 'sedan', 0x3a5f8a);
  }

  /* ---------------- transit stops: shelters + signs ---------------- */
  for (const stop of STREETCAR_STOPS) {
    const edge = net.edges.get(stop.edgeId);
    if (!edge) continue;
    for (const dir of [1, -1] as const) {
      const s = dir === 1 ? stop.s : edge.len - stop.s;
      const p = sidePoint(edge, s, dir === 1 ? -1 : 1, 1.2);
      const facing = dir === 1 ? p.heading + Math.PI : p.heading;
      furn.signPost(p.x, p.z, 0, facing, 'streetcarStop', '', 0.46);
      const sh = sidePoint(edge, s - dir * 6, dir === 1 ? -1 : 1, SIDEWALK_W - 1.0);
      furn.shelter(sh.x, sh.z, p.heading + (dir === 1 ? 0 : Math.PI), 0.12);
    }
  }

  mark('furniture-place');
  const furnRes: FurnitureResult = furn.finish(group);
  mark('furniture-merge');
  console.info(`DriveSim props: ${marks.join(', ')} ms`);

  const setNight = (f: number): void => {
    buildingNight(f);
    furnitureNight(furnRes, f);
    void buildings;
  };

  const grassDry = new THREE.Color(0xffffff);
  const grassSnow = new THREE.Color(0xf4f7fa);
  const setSnow = (f: number): void => {
    groundMat.color.lerpColors(grassDry, grassSnow, f);
    // snow flattens the grass detail: fade the normal map and blur the macro tint
    groundMat.normalScale.setScalar(1 - f * 0.85);
    groundMat.roughness = 1 - f * 0.25;
    groundMat.map!.repeat.setScalar(f > 0.5 ? 1 / 40 : 1 / 4);
  };

  return { group, cones, parkedCars, setNight, setSnow };
}

function pathSlab(w: number, d: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * d);
  return g;
}

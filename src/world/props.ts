/**
 * World dressing: city blocks (towers, midrises, houses with night-lit
 * windows), the school + playground, trees and streetlights (instanced),
 * Ontario signage generated from the network (stop/yield, MAXIMUM tabs,
 * school/construction/playground zones, highway guides, street blades),
 * construction cones, parked cars, the DriveTest centre, the lake and a
 * CN-Tower-style landmark. Returns night-control hooks for emissives.
 */

import * as THREE from 'three';
import { mulberry32, polylineAt, type V2 } from '../core/math';
import type { CollisionWorld, CircleCollider } from '../physics/collision';
import { buildCar, bodyMat, type BuiltCar } from '../vehicle/carFactory';
import { LANE_W, RoadNetwork, SIDEWALK_W } from './network';
import { PARKING_BAYS, LOT_RECT, ZONES, STREETCAR_STOPS } from './map';
import { buildingTexture, signTexture, streetBladeTexture, type SignKind } from './textures';

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
}

const TRUNK_MAT = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.95 });
const CROWN_MAT = new THREE.MeshStandardMaterial({ color: 0x3f6f35, roughness: 0.95 });
const POLE_MAT = new THREE.MeshStandardMaterial({ color: 0x4a4f55, roughness: 0.55, metalness: 0.6 });

function signPost(
  group: THREE.Group,
  x: number,
  z: number,
  y: number,
  faceHeading: number,
  kind: SignKind,
  text = '',
  scale = 0.62,
  postH = 2.4,
): void {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, postH, 6), POLE_MAT);
  post.position.set(x, y + postH / 2, z);
  group.add(post);
  const t = signTexture(kind, text);
  const aspect = (t.image as HTMLCanvasElement).height / (t.image as HTMLCanvasElement).width;
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(scale, scale * aspect),
    new THREE.MeshStandardMaterial({ map: t, roughness: 0.5 }),
  );
  face.position.set(x, y + postH - (scale * aspect) / 2 + 0.1, z);
  face.rotation.y = faceHeading;
  group.add(face);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(scale, scale * aspect), POLE_MAT);
  back.position.copy(face.position);
  back.rotation.y = faceHeading + Math.PI;
  group.add(back);
}

export function buildProps(net: RoadNetwork, collision: CollisionWorld, seed = 20260610): PropsResult {
  const rng = mulberry32(seed);
  const group = new THREE.Group();
  group.name = 'props';
  const cones: Cone[] = [];
  const parkedCars: BuiltCar[] = [];
  const windowMats: THREE.MeshStandardMaterial[] = [];
  const lampMats: THREE.MeshStandardMaterial[] = [];

  /* ---------------- ground base + lake + landmark ---------------- */
  const groundPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(2600, 2300),
    new THREE.MeshStandardMaterial({ color: 0x5d8147, roughness: 1 }),
  );
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.position.set(0, -0.05, -60);
  groundPlane.receiveShadow = true;
  group.add(groundPlane);

  const lake = new THREE.Mesh(
    new THREE.PlaneGeometry(2600, 600),
    new THREE.MeshStandardMaterial({ color: 0x2c5f8a, roughness: 0.25, metalness: 0.55 }),
  );
  lake.rotation.x = -Math.PI / 2;
  lake.position.set(0, 0.02, 980);
  group.add(lake);
  // shoreline
  const shore = new THREE.Mesh(new THREE.PlaneGeometry(2600, 30), new THREE.MeshStandardMaterial({ color: 0xb9a77c, roughness: 1 }));
  shore.rotation.x = -Math.PI / 2;
  shore.position.set(0, 0.0, 690);
  group.add(shore);

  // CN-Tower-style landmark by the lake
  const tower = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 8, 260, 10), bodyMat(0xb9c0c7, { rough: 0.5, metal: 0.3 }));
  shaft.position.y = 130;
  const pod = new THREE.Mesh(new THREE.CylinderGeometry(16, 13, 16, 12), bodyMat(0x9aa3ad, { rough: 0.45, metal: 0.4 }));
  pod.position.y = 240;
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 2.2, 90, 8), bodyMat(0xb9c0c7, { rough: 0.5, metal: 0.3 }));
  spire.position.y = 305;
  tower.add(shaft, pod, spire);
  tower.position.set(220, 0, 800);
  group.add(tower);

  /* ---------------- buildings ---------------- */

  interface BlockDef {
    x0: number;
    x1: number;
    z0: number;
    z1: number;
    style: 'tower' | 'midrise' | 'house' | 'industrial' | 'park' | 'school';
  }

  const M = 22; // margin from street centerlines
  const blocks: BlockDef[] = [];
  const colEdges = [-700, -600, -300, 0, 300, 600, 700];
  const rowEdges = [-380, -150, 100, 350, 550];
  const styleGrid: BlockDef['style'][][] = [
    // rows: Frontage→King, King→Queen, Queen→Palmerston, Palmerston→south
    ['industrial', 'midrise', 'midrise', 'midrise', 'midrise', 'industrial'],
    ['midrise', 'tower', 'tower', 'tower', 'midrise', 'park'],
    ['midrise', 'house', 'midrise', 'house', 'house', 'park'],
    ['house', 'house', 'park', 'school', 'house', 'park'],
  ];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 6; c++) {
      blocks.push({
        x0: colEdges[c] + M,
        x1: colEdges[c + 1] - M,
        z0: rowEdges[r] + M,
        z1: rowEdges[r + 1] - M,
        style: styleGrid[r][c],
      });
    }
  }

  const houseGeo = new THREE.BoxGeometry(1, 1, 1);
  const roofGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 3);

  const addBuildingCollider = (x: number, z: number, w: number, d: number, heading = 0): void => {
    collision.addOBB({ x, z, heading, halfW: w / 2, halfL: d / 2, tag: 'building' });
  };

  const mkTower = (x: number, z: number, w: number, d: number, h: number, ti: number): void => {
    const texSet = buildingTexture(ti, ['#5d6770', '#6e6259', '#54616e', '#746a5e', '#616d62'][ti % 5], 6, Math.max(6, Math.round(h / 7)));
    const mat = new THREE.MeshStandardMaterial({
      map: texSet.map,
      emissiveMap: texSet.emissive,
      emissive: new THREE.Color(0xffe2a6),
      emissiveIntensity: 0,
      roughness: 0.8,
    });
    windowMats.push(mat);
    const mesh = new THREE.Mesh(houseGeo, mat);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, h / 2, z);
    mesh.castShadow = h < 60; // tallest towers skip shadow casting (shadow camera is small anyway)
    group.add(mesh);
    addBuildingCollider(x, z, w + 0.6, d + 0.6);
  };

  const mkHouse = (x: number, z: number, heading: number, hi: number): void => {
    const w = 7 + rng() * 3;
    const d = 9 + rng() * 3;
    const h = 4.6 + rng() * 1.6;
    const palette = [0x8a7a68, 0x9a8d7f, 0x7d8a96, 0xa08a78, 0x96a08a, 0x8d8d99];
    const body = new THREE.Mesh(houseGeo, bodyMat(palette[hi % palette.length], { rough: 0.85, metal: 0.05 }));
    body.scale.set(w, h, d);
    body.position.set(x, h / 2, z);
    body.rotation.y = heading;
    body.castShadow = true;
    const roof = new THREE.Mesh(roofGeo, bodyMat(0x4e4035, { rough: 0.9, metal: 0 }));
    roof.scale.set(d * 1.06, w * 1.12, 2.6);
    roof.rotation.z = Math.PI / 2;
    roof.rotation.y = heading + Math.PI / 2;
    roof.position.set(x, h + 1.28, z);
    roof.castShadow = true;
    group.add(body, roof);
    addBuildingCollider(x, z, w + 0.4, d + 0.4, heading);
  };

  let towerIdx = 0;
  const treeSpots: V2[] = [];
  for (const b of blocks) {
    const bw = b.x1 - b.x0;
    const bd = b.z1 - b.z0;
    if (bw < 18 || bd < 18) continue;
    if (b.style === 'tower') {
      const n = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        const w = 24 + rng() * 16;
        const d = 22 + rng() * 14;
        const h = 36 + rng() * 60;
        const x = b.x0 + w / 2 + rng() * Math.max(4, bw - w);
        const z = b.z0 + d / 2 + rng() * Math.max(4, bd - d);
        mkTower(Math.min(x, b.x1 - w / 2), Math.min(z, b.z1 - d / 2), w, d, h, towerIdx++);
      }
    } else if (b.style === 'midrise') {
      const n = 3 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        const w = 18 + rng() * 14;
        const d = 14 + rng() * 10;
        const h = 10 + rng() * 16;
        const x = b.x0 + w / 2 + rng() * Math.max(4, bw - w);
        const z = b.z0 + d / 2 + rng() * Math.max(4, bd - d);
        mkTower(Math.min(x, b.x1 - w / 2), Math.min(z, b.z1 - d / 2), w, d, h, towerIdx++);
      }
    } else if (b.style === 'house') {
      // rows of houses facing the bounding streets
      const step = 16;
      for (let x = b.x0 + 8; x < b.x1 - 6; x += step) {
        mkHouse(x, b.z0 + 7, Math.PI, Math.floor(rng() * 6));
        mkHouse(x, b.z1 - 7, 0, Math.floor(rng() * 6));
        if (rng() < 0.7) treeSpots.push({ x: x + 6, z: b.z0 + 16 });
        if (rng() < 0.7) treeSpots.push({ x: x + 6, z: b.z1 - 16 });
      }
    } else if (b.style === 'park' || b.style === 'school') {
      const n = Math.floor((bw * bd) / 420);
      for (let i = 0; i < n; i++) treeSpots.push({ x: b.x0 + rng() * bw, z: b.z0 + rng() * bd });
      if (b.style === 'school') {
        // school building + yard on the south side of Palmerston
        const sx = (b.x0 + b.x1) / 2;
        const sz = b.z0 + 28;
        const school = new THREE.Mesh(houseGeo, bodyMat(0xa3543c, { rough: 0.8, metal: 0 }));
        school.scale.set(56, 9, 22);
        school.position.set(sx, 4.5, sz);
        school.castShadow = true;
        group.add(school);
        addBuildingCollider(sx, sz, 56, 22);
        const gym = new THREE.Mesh(houseGeo, bodyMat(0xb9a77c, { rough: 0.85, metal: 0 }));
        gym.scale.set(18, 6.5, 16);
        gym.position.set(sx + 38, 3.25, sz + 4);
        gym.castShadow = true;
        group.add(gym);
        addBuildingCollider(sx + 38, sz + 4, 18, 16);
        // playground frame
        const frame = new THREE.Mesh(new THREE.BoxGeometry(6, 0.4, 0.4), bodyMat(0xd97706, { rough: 0.6 }));
        frame.position.set(sx - 20, 2.2, sz + 24);
        const legs = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.2, 0.3), bodyMat(0xd97706, { rough: 0.6 }));
        legs.position.set(sx - 23, 1.1, sz + 24);
        const legs2 = legs.clone();
        legs2.position.x = sx - 17;
        group.add(frame, legs, legs2);
      }
    } else if (b.style === 'industrial') {
      const n = 2;
      for (let i = 0; i < n; i++) {
        const w = 30 + rng() * 22;
        const d = 20 + rng() * 14;
        const h = 7 + rng() * 5;
        const x = b.x0 + w / 2 + rng() * Math.max(4, bw - w);
        const z = b.z0 + d / 2 + rng() * Math.max(4, bd - d);
        const shed = new THREE.Mesh(houseGeo, bodyMat([0x7d8a96, 0x8d8478, 0x77808a][i % 3], { rough: 0.8, metal: 0.25 }));
        shed.scale.set(w, h, d);
        shed.position.set(Math.min(x, b.x1 - w / 2), h / 2, Math.min(z, b.z1 - d / 2));
        shed.castShadow = true;
        group.add(shed);
        addBuildingCollider(shed.position.x, shed.position.z, w, d);
      }
    }
  }

  // forest band north of the highway + scattered south
  for (let i = 0; i < 110; i++) {
    treeSpots.push({ x: -940 + rng() * 1880, z: -740 + rng() * 60 });
  }
  for (let i = 0; i < 40; i++) {
    treeSpots.push({ x: -940 + rng() * 300, z: 300 + rng() * 320 });
  }
  // median trees between the highway directions
  for (let i = 0; i < 36; i++) {
    treeSpots.push({ x: -800 + rng() * 1600, z: -560 + rng() * 40 });
  }

  /* ---------------- trees (instanced) ---------------- */
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 2.6, 6);
  const crownGeo = new THREE.ConeGeometry(1.9, 4.6, 8);
  const trunks = new THREE.InstancedMesh(trunkGeo, TRUNK_MAT, treeSpots.length);
  const crowns = new THREE.InstancedMesh(crownGeo, CROWN_MAT, treeSpots.length);
  crowns.castShadow = true;
  const m4 = new THREE.Matrix4();
  treeSpots.forEach((p, i) => {
    const s = 0.8 + rng() * 0.7;
    m4.makeScale(s, s, s).setPosition(p.x, 1.3 * s, p.z);
    trunks.setMatrixAt(i, m4);
    m4.makeScale(s, s, s).setPosition(p.x, (2.6 + 2.3) * s * 0.92, p.z);
    crowns.setMatrixAt(i, m4);
    if (Math.abs(p.z) < 660) collision.addCircle({ x: p.x, z: p.z, r: 0.3, tag: 'tree' });
  });
  group.add(trunks, crowns);

  /* ---------------- streetlights along arterials ---------------- */
  const lampHeadGeo = new THREE.BoxGeometry(0.5, 0.12, 0.22);
  const lampPoleGeo = new THREE.CylinderGeometry(0.07, 0.09, 6.4, 6);
  const lampSpots: Array<{ p: V2; heading: number }> = [];
  for (const edge of net.edges.values()) {
    const k = edge.def.kind;
    if (k !== 'city' && k !== 'highway') continue;
    const step = k === 'highway' ? 55 : 38;
    for (let s = step / 2; s < edge.len - 10; s += step) {
      const smp = polylineAt(edge.center, s);
      const side = Math.floor(s / step) % 2 === 0 ? 1 : -1;
      const off = (side > 0 ? edge.halfL : -edge.halfR) + side * (SIDEWALK_W - 0.6);
      const lx = smp.dir.z * off;
      const lz = -smp.dir.x * off;
      lampSpots.push({
        p: { x: smp.point.x + lx, z: smp.point.z + lz },
        heading: Math.atan2(smp.dir.x, smp.dir.z) + (side > 0 ? -1 : 1) * Math.PI * 0.5,
      });
    }
  }
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xfff6dc,
    emissive: new THREE.Color(0xffe9b0),
    emissiveIntensity: 0,
    roughness: 0.4,
  });
  lampMats.push(lampMat);
  const poles = new THREE.InstancedMesh(lampPoleGeo, POLE_MAT, lampSpots.length);
  const heads = new THREE.InstancedMesh(lampHeadGeo, lampMat, lampSpots.length);
  lampSpots.forEach((l, i) => {
    m4.makeRotationY(l.heading).setPosition(l.p.x, 3.2, l.p.z);
    poles.setMatrixAt(i, m4);
    const armX = l.p.x + Math.sin(l.heading) * 1.5;
    const armZ = l.p.z + Math.cos(l.heading) * 1.5;
    m4.makeRotationY(l.heading).setPosition(armX, 6.35, armZ);
    heads.setMatrixAt(i, m4);
  });
  group.add(poles, heads);

  /* ---------------- network signage ---------------- */
  for (const lane of net.lanes) {
    if (lane.kind !== 'drive' || lane.index !== lane.laneCount - 1) continue; // one sign per approach (curb lane)
    const control = net.approachControl(lane);
    if (control === 'none') continue;
    const sStop = net.stopLineS(lane);
    const smp = polylineAt(lane.poly, sStop - 1);
    const heading = Math.atan2(smp.dir.x, smp.dir.z);
    // right side of the lane
    const off = -(lane.width / 2 + 1.0);
    const px = smp.point.x + smp.dir.z * off;
    const pz = smp.point.z - smp.dir.x * off;
    const y = lane.edge.elev(lane.dir === 1 ? sStop : lane.edge.len - sStop);
    if (control === 'stop') signPost(group, px, pz, y, heading + Math.PI, 'stop', '', 0.66);
    else if (control === 'yield' || control === 'roundabout-yield') signPost(group, px, pz, y, heading + Math.PI, 'yield', '', 0.66);
    if (control === 'roundabout-yield') {
      const smp2 = polylineAt(lane.poly, Math.max(4, sStop - 24));
      signPost(group, smp2.point.x + smp2.dir.z * off, smp2.point.z - smp2.dir.x * off, 0, heading + Math.PI, 'roundabout', '', 0.6);
    }
  }

  // MAXIMUM speed tabs mid-block (both directions of named streets)
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
        signPost(group, px, pz, edge.elev(s), heading + Math.PI, 'max', String(d.limit), 0.5);
      }
    }
  }

  // zone signs at boundaries
  for (const zone of ZONES) {
    const kind: SignKind = zone.kind === 'school' ? 'school' : zone.kind === 'construction' ? 'construction' : 'playground';
    const cx = (zone.x0 + zone.x1) / 2;
    const cz = (zone.z0 + zone.z1) / 2;
    const horizontal = zone.x1 - zone.x0 > zone.z1 - zone.z0;
    if (horizontal) {
      signPost(group, zone.x0 + 4, cz - 6, 0, Math.PI / 2 + Math.PI, kind, '', 0.6);
      signPost(group, zone.x0 + 14, cz - 6, 0, Math.PI / 2 + Math.PI, zone.kind === 'construction' ? 'constructionMax' : 'schoolMax', String(zone.limit), 0.48);
      signPost(group, zone.x1 - 4, cz + 6, 0, -Math.PI / 2 + Math.PI, kind, '', 0.6);
      signPost(group, zone.x1 - 14, cz + 6, 0, -Math.PI / 2 + Math.PI, zone.kind === 'construction' ? 'constructionMax' : 'schoolMax', String(zone.limit), 0.48);
    }
  }

  // highway guides: on-ramp entrance + advance exit + exit gore + HOV + merge
  signPost(group, -500, -373, 0, Math.PI / 2 + Math.PI, 'guide401', 'EAST', 1.1, 3.4);
  signPost(group, -350, -437, 0, (3 * Math.PI) / 4 + Math.PI, 'merge', '', 0.7);
  signPost(group, -80, -448, 0, Math.PI / 2 + Math.PI, 'hov', '', 0.7);
  signPost(group, -60, -472, 0, Math.PI / 2 + Math.PI, 'exit', 'EXIT 12 · 500 m', 1.0, 3.2);
  signPost(group, 150, -472, 0, Math.PI / 2 + Math.PI, 'exit', 'EXIT 12', 1.0, 3.2);
  signPost(group, 248, -451, 0, Math.PI / 2 + Math.PI, 'max', '60', 0.5);
  // hill warning before Davenport climb + dead ends
  signPost(group, 594, 130, 0, Math.PI, 'hill', '10%', 0.6);
  signPost(group, -594, 368, 0, 0, 'deadEnd', '', 0.55);
  // DriveTest centre
  signPost(group, -600, -392, 0, Math.PI, 'driveTest', '', 1.2, 2.8);

  // street name blades at signalized corners
  for (const node of net.nodes.values()) {
    if (node.def.control !== 'signal') continue;
    const names = new Set<string>();
    for (const e of node.edges) names.add(e.def.name);
    const arr = [...names].slice(0, 2);
    arr.forEach((name, i) => {
      const bladeT = streetBladeTexture(name);
      const blade = new THREE.Mesh(
        new THREE.PlaneGeometry(1.7, 0.32),
        new THREE.MeshStandardMaterial({ map: bladeT, roughness: 0.5, side: THREE.DoubleSide }),
      );
      blade.position.set(node.def.x - node.radius - 1.2, 3.5 - i * 0.36, node.def.z - node.radius - 1.2);
      blade.rotation.y = i === 0 ? Math.PI / 2 : 0;
      group.add(blade);
    });
  }

  /* ---------------- construction zone (cones + barrels) ---------------- */
  const kg5 = net.edges.get('kg5');
  if (kg5?.def.closureF) {
    const [s0, s1] = kg5.def.closureF;
    const coneGeo = new THREE.ConeGeometry(0.22, 0.6, 9);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1e, roughness: 0.65 });
    const laneOff = -(kg5.def.lanesF - 0.5) * LANE_W.city; // centre of closed curb lane
    let i = 0;
    for (let s = s0 - 28; s <= s1; s += 7) {
      const taper = Math.min(1, Math.max(0, (s - (s0 - 28)) / 30));
      const smp = polylineAt(kg5.center, Math.min(s, kg5.len - 4));
      const off = laneOff + (1 - taper) * LANE_W.city * 0.9 - 0.2 * taper;
      const px = smp.point.x + smp.dir.z * (off + LANE_W.city / 2 - 0.4);
      const pz = smp.point.z - smp.dir.x * (off + LANE_W.city / 2 - 0.4);
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.set(px, 0.3, pz);
      cone.castShadow = true;
      group.add(cone);
      const collider: CircleCollider = { x: px, z: pz, r: 0.32, tag: 'cone', ref: i++ };
      collision.addCircle(collider);
      cones.push({ mesh: cone, collider, knocked: false, t: 0 });
    }
    // works: barrier + excavator-ish blocks inside the closure
    const smpMid = polylineAt(kg5.center, (s0 + s1) / 2);
    const bx = smpMid.point.x + smpMid.dir.z * laneOff;
    const bz = smpMid.point.z - smpMid.dir.x * laneOff;
    const digger = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.4, 5.6), bodyMat(0xe8a020, { rough: 0.6 }));
    digger.position.set(bx, 1.2, bz);
    digger.castShadow = true;
    group.add(digger);
    collision.addOBB({ x: bx, z: bz, heading: Math.atan2(smpMid.dir.x, smpMid.dir.z), halfW: 1.7, halfL: 2.8, tag: 'construction' });
  }

  /* ---------------- parked cars (parallel-parking exercise) ---------------- */
  const bat3 = net.edges.get(PARKING_BAYS.edgeId);
  if (bat3) {
    const off = -(LANE_W.residential + 2.3 / 2 + 0.15); // parking lane centre, right of southbound
    for (let s = PARKING_BAYS.s0; s <= PARKING_BAYS.s1; s += 12.5) {
      const inGap = s > PARKING_BAYS.gap0 - 6 && s < PARKING_BAYS.gap1 + 6;
      if (inGap || rng() < 0.3) continue;
      const smp = polylineAt(bat3.center, s);
      const px = smp.point.x + smp.dir.z * off;
      const pz = smp.point.z - smp.dir.x * off;
      const heading = Math.atan2(smp.dir.x, smp.dir.z);
      const colors = [0x8a8d93, 0x3b4754, 0x6d2e2a, 0x2e4d3a, 0xcfd2d6];
      const car = buildCar(rng() < 0.3 ? 'suv' : 'sedan', colors[Math.floor(rng() * colors.length)]);
      car.root.position.set(px, 0, pz);
      car.root.rotation.y = heading;
      group.add(car.root);
      parkedCars.push(car);
      collision.addOBB({ x: px, z: pz, heading, halfW: car.dims.width / 2, halfL: car.dims.length / 2, tag: 'parkedCar' });
    }
    // the two exercise cars framing the gap
    for (const s of [PARKING_BAYS.gap0 - 3.2, PARKING_BAYS.gap1 + 3.2]) {
      const smp = polylineAt(bat3.center, s);
      const px = smp.point.x + smp.dir.z * off;
      const pz = smp.point.z - smp.dir.x * off;
      const heading = Math.atan2(smp.dir.x, smp.dir.z);
      const car = buildCar('sedan', s < PARKING_BAYS.gap0 ? 0xb8434e : 0x3a5f8a);
      car.root.position.set(px, 0, pz);
      car.root.rotation.y = heading;
      group.add(car.root);
      parkedCars.push(car);
      collision.addOBB({ x: px, z: pz, heading, halfW: car.dims.width / 2, halfL: car.dims.length / 2, tag: 'parkedCar' });
    }
  }

  /* ---------------- transit stops ---------------- */
  for (const stop of STREETCAR_STOPS) {
    const edge = net.edges.get(stop.edgeId);
    if (!edge) continue;
    for (const dir of [1, -1]) {
      const s = dir === 1 ? stop.s : edge.len - stop.s;
      const smp = polylineAt(edge.center, s);
      const side = dir === 1 ? -(edge.halfR + 1.2) : edge.halfL + 1.2;
      const px = smp.point.x + smp.dir.z * side;
      const pz = smp.point.z - smp.dir.x * side;
      signPost(group, px, pz, 0, Math.atan2(smp.dir.x * dir, smp.dir.z * dir) + Math.PI, 'streetcarStop', '', 0.46);
    }
  }

  /* ---------------- DriveTest centre + practice lot ---------------- */
  const lotPad = new THREE.Mesh(
    new THREE.PlaneGeometry(LOT_RECT.x1 - LOT_RECT.x0, LOT_RECT.z1 - LOT_RECT.z0),
    new THREE.MeshStandardMaterial({ color: 0x43474e, roughness: 0.95 }),
  );
  lotPad.rotation.x = -Math.PI / 2;
  lotPad.position.set((LOT_RECT.x0 + LOT_RECT.x1) / 2, 0.018, (LOT_RECT.z0 + LOT_RECT.z1) / 2);
  lotPad.receiveShadow = true;
  group.add(lotPad);
  const dtc = new THREE.Mesh(houseGeo, bodyMat(0x6b7884, { rough: 0.7, metal: 0.15 }));
  dtc.scale.set(34, 6, 14);
  dtc.position.set(-620, 3, -445);
  dtc.castShadow = true;
  group.add(dtc);
  addBuildingCollider(-620, -445, 34, 14);

  const setNight = (f: number): void => {
    for (const m of windowMats) m.emissiveIntensity = f * 1.1;
    for (const m of lampMats) m.emissiveIntensity = f * 3.2;
  };

  return { group, cones, parkedCars, setNight };
}

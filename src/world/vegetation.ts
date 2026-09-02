/**
 * Vegetation: trees built from a bark-textured trunk with branches and a
 * crown of alpha-tested leaf cards (several crossed + tilted planes so the
 * crown reads volumetric from every angle), two broadleaf species and a
 * spruce, instanced with per-tree scale/rotation/tint; plus hedges and
 * bushes for front yards, and the grass ground plane with macro variation
 * so the tile grid never shows.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/math';
import type { CollisionWorld } from '../physics/collision';
import { normalizeAttrs } from './batch';
import { barkSet, canvas, grassSet, leafCardTexture, surfaceMaterial, tex } from './materials';

export type TreeKind = 'maple' | 'oak' | 'spruce';

export interface TreeSpot {
  x: number;
  z: number;
  kind?: TreeKind;
  scale?: number;
}

interface TreeVariant {
  trunk: THREE.BufferGeometry;
  crown: THREE.BufferGeometry;
  kind: TreeKind;
}

const variants: TreeVariant[] = [];

function leafCard(w: number, h: number, x: number, y: number, z: number, ry: number, rx: number, rz: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

function buildVariant(kind: TreeKind, seed: number): TreeVariant {
  const rng = mulberry32(seed * 977 + 13);
  const trunkParts: THREE.BufferGeometry[] = [];
  const crownParts: THREE.BufferGeometry[] = [];
  if (kind === 'spruce') {
    const H = 9;
    const trunk = new THREE.CylinderGeometry(0.1, 0.28, H * 0.6, 8);
    trunk.translate(0, H * 0.3, 0);
    trunkParts.push(trunk);
    // stacked cone skirts with the needle texture
    for (let i = 0; i < 4; i++) {
      const y0 = 1.6 + i * 1.7;
      const r = 2.6 - i * 0.5;
      const cone = new THREE.ConeGeometry(r, 2.6, 10, 1, true);
      cone.translate(0, y0 + 1.3, 0);
      crownParts.push(cone);
    }
    const tip = new THREE.ConeGeometry(0.7, 2.0, 8, 1, true);
    tip.translate(0, 8.5, 0);
    crownParts.push(tip);
  } else {
    const H = kind === 'oak' ? 3.4 : 3.0;
    const trunk = new THREE.CylinderGeometry(0.16, 0.3, H, 8);
    trunk.translate(0, H / 2, 0);
    trunkParts.push(trunk);
    // three main branches leaning out
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + rng() * 0.6;
      const br = new THREE.CylinderGeometry(0.06, 0.12, 2.4, 6);
      br.translate(0, 1.2, 0);
      br.rotateZ(0.55 + rng() * 0.2);
      br.rotateY(a);
      br.translate(0, H - 0.3, 0);
      trunkParts.push(br);
    }
    // crown cards: 3 vertical crossed cards + 4 tilted cards at varying heights
    const R = kind === 'oak' ? 3.4 : 3.0;
    const cy = H + R * 0.55;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI + rng() * 0.3;
      crownParts.push(leafCard(R * 2, R * 1.7, (rng() - 0.5) * 0.4, cy, (rng() - 0.5) * 0.4, a, 0, 0));
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rng();
      const tilt = 0.9 + rng() * 0.5;
      crownParts.push(leafCard(R * 1.6, R * 1.4, Math.cos(a) * R * 0.3, cy + (rng() - 0.3) * R * 0.5, Math.sin(a) * R * 0.3, a, tilt, 0));
    }
    // a horizontal cap card so the top isn't a hole from above
    crownParts.push(leafCard(R * 1.7, R * 1.7, 0, cy + R * 0.6, 0, rng() * Math.PI, Math.PI / 2, 0));
  }
  return {
    trunk: mergeGeometries(trunkParts.map(normalizeAttrs), false)!,
    crown: mergeGeometries(crownParts.map(normalizeAttrs), false)!,
    kind,
  };
}

function getVariants(): TreeVariant[] {
  if (variants.length) return variants;
  variants.push(buildVariant('maple', 1), buildVariant('maple', 2), buildVariant('oak', 3), buildVariant('oak', 4), buildVariant('spruce', 5));
  return variants;
}

export function buildTrees(spots: TreeSpot[], group: THREE.Group, collision: CollisionWorld, rng: () => number): void {
  const vars = getVariants();
  const bark = surfaceMaterial(barkSet());
  const leafMats: Record<TreeKind, THREE.MeshStandardMaterial> = {
    maple: new THREE.MeshStandardMaterial({ map: leafCardTexture('maple'), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, color: 0xffffff }),
    oak: new THREE.MeshStandardMaterial({ map: leafCardTexture('oak'), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, color: 0xffffff }),
    spruce: new THREE.MeshStandardMaterial({ map: leafCardTexture('spruce'), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9, color: 0xffffff }),
  };
  // assign a variant to each spot
  const buckets: TreeSpot[][] = vars.map(() => []);
  for (const s of spots) {
    const kind = s.kind ?? (rng() < 0.15 ? 'spruce' : rng() < 0.55 ? 'maple' : 'oak');
    const options = vars.map((v, i) => (v.kind === kind ? i : -1)).filter((i) => i >= 0);
    buckets[options[Math.floor(rng() * options.length)]].push(s);
  }
  const m4 = new THREE.Matrix4();
  const tint = new THREE.Color();
  vars.forEach((v, vi) => {
    const list = buckets[vi];
    if (!list.length) return;
    const trunks = new THREE.InstancedMesh(v.trunk, bark, list.length);
    const crowns = new THREE.InstancedMesh(v.crown, leafMats[v.kind], list.length);
    list.forEach((s, i) => {
      const sc = (s.scale ?? 0.85 + rng() * 0.5) * (v.kind === 'spruce' ? 0.9 : 1);
      const ry = rng() * Math.PI * 2;
      m4.makeRotationY(ry).scale(new THREE.Vector3(sc, sc * (0.9 + rng() * 0.2), sc)).setPosition(s.x, 0, s.z);
      trunks.setMatrixAt(i, m4);
      crowns.setMatrixAt(i, m4);
      tint.setHSL(0.24 + (rng() - 0.5) * 0.06, 0.45 + rng() * 0.2, 0.42 + rng() * 0.16);
      crowns.setColorAt(i, tint);
      if (Math.abs(s.z) < 700) collision.addCircle({ x: s.x, z: s.z, r: 0.3, tag: 'tree' });
    });
    trunks.castShadow = true;
    crowns.castShadow = true;
    trunks.receiveShadow = true;
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    group.add(trunks, crowns);
  });
}

/* ------------------------------------------------------------------ */
/* hedges + bushes                                                     */
/* ------------------------------------------------------------------ */

let hedgeTex: THREE.CanvasTexture | null = null;
function hedgeTexture(): THREE.CanvasTexture {
  if (hedgeTex) return hedgeTex;
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#243f1c';
  g.fillRect(0, 0, 256, 256);
  const rng = mulberry32(77);
  for (let i = 0; i < 1400; i++) {
    const k = rng();
    g.fillStyle = `rgb(${40 + k * 50},${80 + k * 70},${28 + k * 22})`;
    g.save();
    g.translate(rng() * 256, rng() * 256);
    g.rotate(rng() * Math.PI);
    g.beginPath();
    g.ellipse(0, 0, 5 + rng() * 5, 3 + rng() * 3, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  hedgeTex = tex(c);
  return hedgeTex;
}

export interface HedgeSpot {
  x: number;
  z: number;
  heading: number;
  length: number;
}

export function buildHedges(hedges: HedgeSpot[], bushes: Array<{ x: number; z: number; s: number }>, group: THREE.Group): void {
  const mat = new THREE.MeshStandardMaterial({ map: hedgeTexture(), roughness: 0.95 });
  mat.map!.repeat.set(1, 1);
  if (hedges.length) {
    const geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
    const inst = new THREE.InstancedMesh(geo, mat, hedges.length);
    const m4 = new THREE.Matrix4();
    hedges.forEach((h, i) => {
      m4.makeRotationY(h.heading).scale(new THREE.Vector3(h.length, 0.9, 0.7)).setPosition(h.x, 0.45, h.z);
      inst.setMatrixAt(i, m4);
    });
    inst.castShadow = true;
    inst.receiveShadow = true;
    group.add(inst);
  }
  if (bushes.length) {
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const inst = new THREE.InstancedMesh(geo, mat, bushes.length);
    const m4 = new THREE.Matrix4();
    bushes.forEach((b, i) => {
      m4.makeScale(b.s, b.s * 0.75, b.s).setPosition(b.x, b.s * 0.55, b.z);
      inst.setMatrixAt(i, m4);
    });
    inst.castShadow = true;
    group.add(inst);
  }
}

/* ------------------------------------------------------------------ */
/* ground                                                              */
/* ------------------------------------------------------------------ */

export function buildGround(group: THREE.Group): THREE.MeshStandardMaterial {
  const mat = surfaceMaterial(grassSet(), {
    rep: [2600 / 4, 2300 / 4],
    macro: { scale: 55, strength: 0.22, tint: new THREE.Color(0x6e6a48), tintAmount: 0.45 },
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2300, 1, 1), mat);
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(0, -0.05, -60);
  plane.receiveShadow = true;
  group.add(plane);
  // far backdrop: rolling hills beyond the district
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x5f7a4c, roughness: 1 });
  const rng = mulberry32(5);
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const r = 1450 + rng() * 250;
    if (Math.sin(a) > 0.35) continue; // leave the lake side open
    const hill = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), hillMat);
    const sx = 260 + rng() * 260;
    hill.scale.set(sx, 40 + rng() * 70, 200 + rng() * 120);
    hill.position.set(Math.cos(a) * r, -10, -60 + Math.sin(a) * r);
    hill.rotation.y = rng() * Math.PI;
    group.add(hill);
  }
  return mat;
}

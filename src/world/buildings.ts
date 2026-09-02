/**
 * Building generators. Towers and midrises are facade-textured shells with
 * real podiums, setbacks, parapets, mechanical penthouses and balconies;
 * houses are Toronto bay-and-gable semis (steep street-facing gable, bay
 * window, porch with columns and railing, steps, chimney, punched windows
 * with trim) built once per variant and instanced; plus industrial sheds
 * with roll-up doors and fences, a school with a yard, and the DriveTest
 * centre. Everything merges into a few meshes per material.
 */

import * as THREE from 'three';
import { mulberry32 } from '../core/math';
import type { CollisionWorld } from '../physics/collision';
import { GeoBatch, gableRoof, metreBox, shedRoof, slab, wallBox } from './batch';
import {
  asphaltSet,
  brickSet,
  concreteSet,
  corrugatedSet,
  facadeSet,
  flagTexture,
  shingleSet,
  storefrontSet,
  surfaceMaterial,
  canvas,
  tex,
  type TextureSet,
} from './materials';

export interface BuildingsResult {
  group: THREE.Group;
  nightMats: THREE.MeshStandardMaterial[];
}

/* ------------------------------------------------------------------ */
/* shared materials                                                    */
/* ------------------------------------------------------------------ */

const mats = new Map<string, THREE.Material>();
const nightMats: THREE.MeshStandardMaterial[] = [];

function facadeMat(key: string, set: TextureSet, night = 0.9): THREE.MeshStandardMaterial {
  let m = mats.get(key) as THREE.MeshStandardMaterial | undefined;
  if (!m) {
    m = surfaceMaterial(set, { emissiveIntensity: 0 });
    m.userData.night = night;
    mats.set(key, m);
    if (set.emissive) nightMats.push(m);
  }
  return m;
}

function plainMat(key: string, color: number, rough = 0.85, metal = 0): THREE.MeshStandardMaterial {
  let m = mats.get(key) as THREE.MeshStandardMaterial | undefined;
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    mats.set(key, m);
  }
  return m;
}

function ensureMaterials(): void {
  if (mats.has('concrete')) return;
  const concrete = surfaceMaterial(concreteSet(), { color: 0xc9c6bf });
  mats.set('concrete', concrete);
  mats.set('roof', surfaceMaterial(asphaltSet(), { color: 0x9a9892, roughness: 1 }));
  mats.set('roofDark', surfaceMaterial(asphaltSet(), { color: 0x5a5a58 }));
  mats.set('shingle', surfaceMaterial(shingleSet()));
  mats.set('shingleGrey', surfaceMaterial(shingleSet(), { color: 0xb8bcc0 }));
  mats.set('brickRed', surfaceMaterial(brickSet('red')));
  mats.set('brickBrown', surfaceMaterial(brickSet('brown')));
  mats.set('brickBuff', surfaceMaterial(brickSet('buff')));
  mats.set('brickPainted', surfaceMaterial(brickSet('painted')));
  mats.set('corrugated', surfaceMaterial(corrugatedSet([150, 156, 160])));
  mats.set('corrugatedBlue', surfaceMaterial(corrugatedSet([92, 118, 140])));
  mats.set('corrugatedTan', surfaceMaterial(corrugatedSet([168, 150, 122])));
  plainMat('trim', 0xf1efe8, 0.7);
  plainMat('trimDark', 0x3a3a3c, 0.6, 0.2);
  plainMat('door', 0x4a2b1e, 0.55);
  plainMat('doorGreen', 0x2f4f3a, 0.55);
  plainMat('mullion', 0x2a2d31, 0.5, 0.4);
  plainMat('parapet', 0x8f8d88, 0.85);
  plainMat('mech', 0x7d8087, 0.7, 0.3);
  plainMat('railing', 0x2b2d31, 0.5, 0.5);
  plainMat('balconyGlass', 0x6b8fa8, 0.2, 0.6);
  plainMat('steel', 0x9aa1a8, 0.4, 0.8);
  plainMat('fencePost', 0x5a5f66, 0.5, 0.7);
  plainMat('playRed', 0xc8352a, 0.55, 0.1);
  plainMat('playBlue', 0x2c62b8, 0.55, 0.1);
  plainMat('playYellow', 0xe7b71b, 0.55, 0.1);
  plainMat('flagpole', 0xd8dde2, 0.3, 0.9);
  plainMat('dumpster', 0x2f5a3a, 0.6, 0.3);
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x1a2732,
    roughness: 0.08,
    metalness: 0.4,
    envMapIntensity: 1.3,
    emissive: new THREE.Color(0xffd9a0),
    emissiveIntensity: 0,
  });
  glass.userData.night = 0.7;
  mats.set('houseGlassLit', glass);
  nightMats.push(glass);
  mats.set('houseGlass', new THREE.MeshPhysicalMaterial({ color: 0x141c26, roughness: 0.08, metalness: 0.4, envMapIntensity: 1.3 }));
  const signLit = new THREE.MeshStandardMaterial({ map: labelTex('DriveTest', '#0c4a9e', '#ffffff', 512, 128, '800 84px system-ui'), emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.5 });
  signLit.userData.night = 0.5;
  nightMats.push(signLit);
  mats.set('dtSign', signLit);
  mats.set('schoolSign', new THREE.MeshStandardMaterial({ map: labelTex('PALMERSTON PUBLIC SCHOOL', '#1c3f8f', '#ffffff', 1024, 128, '700 64px system-ui'), roughness: 0.6 }));
  mats.set('flag', new THREE.MeshStandardMaterial({ map: flagTexture('canada'), side: THREE.DoubleSide, roughness: 0.8 }));
  mats.set('court', new THREE.MeshStandardMaterial({ map: courtTexture(), roughness: 0.9 }));
  mats.set('stalls', new THREE.MeshStandardMaterial({ map: stallTexture(), roughness: 0.9 }));
  mats.set('chainlink', new THREE.MeshStandardMaterial({ map: chainlinkTexture(), transparent: true, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.6 }));
}

function labelTex(text: string, bg: string, fg: string, w: number, h: number, font: string): THREE.CanvasTexture {
  const [c, g] = canvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 2);
  return tex(c, { repeat: false });
}

function courtTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 256);
  g.fillStyle = '#3d4047';
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = '#e5e7ea';
  g.lineWidth = 4;
  g.strokeRect(16, 16, 480, 224);
  g.beginPath();
  g.moveTo(256, 16);
  g.lineTo(256, 240);
  g.stroke();
  g.beginPath();
  g.arc(256, 128, 40, 0, Math.PI * 2);
  g.stroke();
  for (const x of [16, 496]) {
    g.strokeRect(Math.min(x, x + (x < 256 ? 90 : -90)), 80, 90, 96);
  }
  return tex(c, { repeat: false });
}

function stallTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512, 256);
  g.fillStyle = '#44484f';
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = '#e8eaee';
  g.lineWidth = 3;
  for (let x = 0; x <= 512; x += 64) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 110);
    g.moveTo(x, 146);
    g.lineTo(x, 256);
    g.stroke();
  }
  return tex(c, { repeat: true });
}

function chainlinkTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = '#b8bec4';
  g.lineWidth = 2;
  for (let i = -128; i < 256; i += 16) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 128, 128);
    g.moveTo(i + 128, 0);
    g.lineTo(i, 128);
    g.stroke();
  }
  const t = tex(c);
  return t;
}

/* ------------------------------------------------------------------ */
/* towers / midrises                                                   */
/* ------------------------------------------------------------------ */

const TOWER_WALLS: Array<[number, number, number]> = [
  [96, 104, 112], [120, 116, 108], [88, 96, 104], [140, 132, 120], [70, 78, 88], [110, 118, 128],
];

interface Ctx {
  batch: GeoBatch;
  collision: CollisionWorld;
  rng: () => number;
}

const addCollider = (ctx: Ctx, x: number, z: number, w: number, d: number, heading = 0): void => {
  ctx.collision.addOBB({ x, z, heading, halfW: w / 2, halfL: d / 2, tag: 'building' });
};

function rooftop(ctx: Ctx, x: number, z: number, w: number, d: number, top: number, big: boolean): void {
  const b = ctx.batch;
  // parapet ring
  const t = 0.4;
  const ph = 0.9;
  b.add('parapet', metreBox(w + 0.2, ph, t), x, top + ph / 2, z - d / 2 + t / 2);
  b.add('parapet', metreBox(w + 0.2, ph, t), x, top + ph / 2, z + d / 2 - t / 2);
  b.add('parapet', metreBox(t, ph, d), x - w / 2 + t / 2, top + ph / 2, z);
  b.add('parapet', metreBox(t, ph, d), x + w / 2 - t / 2, top + ph / 2, z);
  b.add('roof', slab(w - 0.2, d - 0.2), x, top + 0.03, z);
  // mechanical penthouse + units + vents + antenna
  if (big) {
    const mw = Math.min(w * 0.45, 14);
    const md = Math.min(d * 0.45, 10);
    const mh = 4.2;
    b.add('concrete', metreBox(mw, mh, md), x + (ctx.rng() - 0.5) * (w - mw) * 0.5, top + mh / 2, z + (ctx.rng() - 0.5) * (d - md) * 0.5);
    b.add('steel', new THREE.CylinderGeometry(0.12, 0.12, 9, 8), x - w * 0.3, top + 4.5, z - d * 0.3);
    b.add('steel', new THREE.CylinderGeometry(0.03, 0.03, 4, 6), x - w * 0.3, top + 11, z - d * 0.3);
  }
  const n = 1 + Math.floor(ctx.rng() * 3);
  for (let k = 0; k < n; k++) {
    const s = 0.8 + ctx.rng() * 0.8;
    b.add('mech', new THREE.BoxGeometry(2 * s, 1.1 * s, 1.4 * s), x + (ctx.rng() - 0.5) * (w - 6), top + 0.55 * s, z + (ctx.rng() - 0.5) * (d - 6), ctx.rng() * Math.PI);
  }
  for (let k = 0; k < 2; k++) {
    b.add('mech', new THREE.CylinderGeometry(0.3, 0.3, 1.2, 10), x + (ctx.rng() - 0.5) * (w - 4), top + 0.6, z + (ctx.rng() - 0.5) * (d - 4));
  }
}

export function addTower(ctx: Ctx, x: number, z: number, w: number, d: number, h: number, seed: number): void {
  const b = ctx.batch;
  const rng = mulberry32(seed * 31 + 11);
  const style = rng() < 0.55 ? 'glass' : 'ribbon';
  const wall = TOWER_WALLS[seed % TOWER_WALLS.length];
  const floorH = 3.2;
  const facade = facadeMat(`tw-${style}-${seed % 6}`, facadeSet({ seed: 100 + (seed % 6), style, wall, floorH, bayW: 3.6, lit: 0.4 }));
  const facadeKey = `tw-${style}-${seed % 6}`;
  mats.set(facadeKey, facade);
  // podium: 3 floors, wider footprint, storefront ground floor
  const pw = w + 6;
  const pd = d + 5;
  const gf = 4.6;
  const podiumH = gf + floorH * 2;
  const storeKey = `store-${seed % 4}`;
  facadeMat(storeKey, storefrontSet(seed % 4), 1.0);
  b.add(storeKey, wallBox(pw, gf, pd), x, gf / 2, z);
  const podKey = `mid-punched-${seed % 4}`;
  facadeMat(podKey, facadeSet({ seed: 200 + (seed % 4), style: 'punched', wall: [wall[0] * 0.9, wall[1] * 0.88, wall[2] * 0.85], floorH, bayW: 3.6, lit: 0.3 }));
  b.add(podKey, wallBox(pw, podiumH - gf, pd, gf), x, gf + (podiumH - gf) / 2, z);
  b.add('concrete', metreBox(pw + 0.6, 0.5, pd + 0.6), x, gf + 0.25, z); // canopy slab over the storefronts
  rooftopFlat(ctx, x, z, pw, pd, podiumH);
  // tower shaft(s)
  const floors = Math.max(6, Math.round((h - podiumH) / floorH));
  const towerH = floors * floorH;
  b.add(facadeKey, wallBox(w, towerH, d, podiumH), x, podiumH + towerH / 2, z);
  let top = podiumH + towerH;
  if (h > 70 && rng() < 0.7) {
    const w2 = w * 0.72;
    const d2 = d * 0.72;
    const h2 = floorH * Math.round(6 + rng() * 8);
    b.add(facadeKey, wallBox(w2, h2, d2, top), x + (w - w2) * 0.25 * (rng() < 0.5 ? 1 : -1), top + h2 / 2, z);
    rooftop(ctx, x, z, w, d, top, false);
    top += h2;
    rooftop(ctx, x + 0, z, w2, d2, top, true);
  } else {
    rooftop(ctx, x, z, w, d, top, true);
  }
  // slab lines every floor read as depth (thin dark bands)
  addCollider(ctx, x, z, pw + 0.6, pd + 0.6);
}

function rooftopFlat(ctx: Ctx, x: number, z: number, w: number, d: number, top: number): void {
  const b = ctx.batch;
  b.add('roof', slab(w - 0.4, d - 0.4), x, top + 0.02, z);
  const t = 0.35;
  b.add('parapet', metreBox(w, 0.6, t), x, top + 0.3, z - d / 2 + t / 2);
  b.add('parapet', metreBox(w, 0.6, t), x, top + 0.3, z + d / 2 - t / 2);
  b.add('parapet', metreBox(t, 0.6, d), x - w / 2 + t / 2, top + 0.3, z);
  b.add('parapet', metreBox(t, 0.6, d), x + w / 2 - t / 2, top + 0.3, z);
}

export function addMidrise(ctx: Ctx, x: number, z: number, w: number, d: number, h: number, seed: number, facing: number): void {
  const b = ctx.batch;
  const rng = mulberry32(seed * 17 + 3);
  const floorH = 3.0;
  const gf = 4.6;
  const floors = Math.max(3, Math.round((h - gf) / floorH));
  const bodyH = floors * floorH;
  const condo = rng() < 0.55;
  const wall = TOWER_WALLS[(seed + 2) % TOWER_WALLS.length];
  const BRICK_TONES: Array<[number, number, number]> = [[152, 92, 72], [168, 108, 84], [140, 100, 78], [176, 118, 90]];
  const brickish = BRICK_TONES[seed % BRICK_TONES.length];
  const key = condo ? `mid-condo-${seed % 4}` : `mid-punched-${seed % 4}`;
  facadeMat(key, facadeSet({ seed: (condo ? 300 : 200) + (seed % 4), style: condo ? 'condo' : 'punched', wall: condo ? wall : brickish, floorH, bayW: 3.6, lit: 0.35 }));
  const storeKey = `store-${(seed + 1) % 4}`;
  facadeMat(storeKey, storefrontSet((seed + 1) % 4), 1.0);
  b.add(storeKey, wallBox(w, gf, d), x, gf / 2, z);
  b.add('concrete', metreBox(w + 0.5, 0.35, d + 0.5), x, gf + 0.17, z);
  b.add(key, wallBox(w, bodyH, d, gf), x, gf + bodyH / 2, z);
  const top = gf + bodyH;
  // cornice / parapet + roof
  b.add('parapet', metreBox(w + 0.5, 0.5, d + 0.5), x, top + 0.25, z);
  rooftop(ctx, x, z, w, d, top + 0.5, floors > 5);
  // balconies on the street-facing side(s) for condos
  if (condo) {
    const bayW = 3.6;
    const sides: Array<[number, number, number]> = facing === 0 ? [[0, 1, w]] : [[0, -1, w]];
    if (rng() < 0.5) sides.push([1, 0, d]);
    for (const [sx, sz, span] of sides) {
      const nBays = Math.floor(span / bayW);
      for (let f = 1; f < floors; f++) {
        for (let bi = 0; bi < nBays; bi++) {
          if (rng() < 0.15) continue;
          const along = -span / 2 + bayW * (bi + 0.5);
          const y = gf + f * floorH + 0.1;
          const px = x + sx * (w / 2 + 0.7) + (sx === 0 ? along : 0);
          const pz = z + sz * (d / 2 + 0.7) + (sz === 0 ? along : 0);
          const ry = sx !== 0 ? Math.PI / 2 : 0;
          b.add('concrete', new THREE.BoxGeometry(bayW * 0.7, 0.16, 1.4), px, y, pz, ry);
          b.add('balconyGlass', new THREE.BoxGeometry(bayW * 0.7, 1.0, 0.04), px + sz * 0 + (sx === 0 ? 0 : sx * 0.68), y + 0.6, pz + (sz === 0 ? 0 : sz * 0.68), ry);
          b.add('railing', new THREE.BoxGeometry(bayW * 0.7 + 0.04, 0.05, 0.06), px + (sx === 0 ? 0 : sx * 0.68), y + 1.12, pz + (sz === 0 ? 0 : sz * 0.68), ry);
        }
      }
    }
  }
  addCollider(ctx, x, z, w + 0.6, d + 0.6);
}

/* ------------------------------------------------------------------ */
/* houses (bay-and-gable semis, instanced per variant)                 */
/* ------------------------------------------------------------------ */

export interface HouseVariant {
  /** Merged geometry per material key, in local space: front faces +z, sits on y=0. */
  parts: Map<string, THREE.BufferGeometry>;
  width: number;
  depth: number;
}

const houseVariants: HouseVariant[] = [];

function buildHouseVariant(seed: number): HouseVariant {
  const rng = mulberry32(seed * 101 + 7);
  const b = new GeoBatch();
  const semi = rng() < 0.75;
  const unitW = 5.6 + rng() * 1.2; // one half of a semi
  const W = semi ? unitW * 2 : unitW + 1.6;
  const D = 10 + rng() * 3;
  const storeyH = 2.9;
  const H = storeyH * 2 + 0.5; // eave height
  const brick = ['brickRed', 'brickBrown', 'brickBuff', 'brickPainted'][Math.floor(rng() * 4)];
  const roofKey = rng() < 0.7 ? 'shingle' : 'shingleGrey';
  const foundation = 0.6;
  // foundation + main brick block
  b.add('concrete', metreBox(W + 0.1, foundation, D + 0.1), 0, foundation / 2, 0);
  b.add(brick, wallBox(W, H - foundation, D, foundation), 0, foundation + (H - foundation) / 2, 0);
  // roof: ridge runs front-to-back; steep front gable is the Toronto look
  const rise = W * 0.42;
  const roof = gableRoof(W, D, rise, 0.4, 0.5);
  b.add(roofKey, roof.slopes, 0, H, 0);
  b.add(brick, roof.gables, 0, H, 0);
  // fascia boards
  b.add('trim', new THREE.BoxGeometry(0.08, 0.22, D + 1.0), -(W / 2 + 0.4), H + 0.05, 0);
  b.add('trim', new THREE.BoxGeometry(0.08, 0.22, D + 1.0), W / 2 + 0.4, H + 0.05, 0);
  // party-wall parapet / chimneys
  const chimneys = semi ? [0] : [W * 0.3];
  for (const cx of chimneys) {
    const cy = H + rise * (1 - Math.abs(cx) / (W / 2)) * 0.9;
    b.add(brick, metreBox(0.7, cy + 1.4 - (H - 1), 0.7), cx, (H - 1 + cy + 1.4) / 2, -D * 0.15);
  }
  const units = semi ? [-unitW / 2, unitW / 2] : [0];
  for (const ux of units) {
    const mirror = ux < 0 ? -1 : 1;
    const uW = semi ? unitW : W;
    // bay window: 3-sided protrusion, 2 storeys tall on the outer side of each unit
    const bayW = uW * 0.5;
    const bayX = ux + mirror * (uW * 0.22);
    const bayD = 0.9;
    const bayH = storeyH * 2 - 0.3;
    b.add(brick, wallBox(bayW, bayH, bayD, foundation), bayX, foundation + bayH / 2, D / 2 + bayD / 2);
    b.add('concrete', metreBox(bayW + 0.1, foundation, bayD + 0.1), bayX, foundation / 2, D / 2 + bayD / 2);
    b.add('trim', new THREE.BoxGeometry(bayW + 0.5, 0.12, bayD + 0.4), bayX, foundation + bayH - 0.02, D / 2 + bayD / 2);
    b.add(roofKey, shedRoof(bayW + 0.5, bayD + 0.35, 0.55), bayX, foundation + bayH + 0.05, D / 2 - 0.05);
    for (const fl of [0, 1]) {
      const wy = foundation + 0.9 + fl * storeyH;
      windowGeo(b, bayX, wy, D / 2 + bayD + 0.02, bayW * 0.5, 1.5, 0, rng() < 0.45);
      windowGeo(b, bayX + mirror * (bayW / 2 + 0.02), wy, D / 2 + bayD / 2, bayD * 0.55, 1.5, Math.PI / 2 * mirror, rng() < 0.45);
    }
    // porch on the inner side of each unit (shared for a semi)
    const porchW = uW - bayW - 0.2;
    const porchX = ux - mirror * (uW / 2 - porchW / 2);
    const porchD = 2.0;
    const porchY = 0.55;
    b.add('concrete', metreBox(porchW, porchY, porchD), porchX, porchY / 2, D / 2 + porchD / 2);
    // door + transom + a window beside it
    b.add(rng() < 0.5 ? 'door' : 'doorGreen', new THREE.BoxGeometry(0.95, 2.1, 0.08), porchX - mirror * (porchW * 0.2), porchY + 1.05, D / 2 + 0.03);
    b.add('trim', new THREE.BoxGeometry(1.15, 2.3, 0.04), porchX - mirror * (porchW * 0.2), porchY + 1.15, D / 2 + 0.005);
    windowGeo(b, porchX - mirror * (porchW * 0.2), foundation + 0.9 + storeyH, D / 2 + 0.02, 1.0, 1.5, 0, rng() < 0.5);
    // porch roof on columns + railing
    const roofY = porchY + 2.6;
    b.add('trim', new THREE.BoxGeometry(porchW + 0.3, 0.16, porchD + 0.4), porchX, roofY - 0.04, D / 2 + porchD / 2);
    b.add(roofKey, shedRoof(porchW + 0.3, porchD + 0.45, 0.6), porchX, roofY + 0.05, D / 2);
    const cols = semi && mirror > 0 ? [porchX + porchW / 2 - 0.25] : mirror > 0 ? [porchX - porchW / 2 + 0.25, porchX + porchW / 2 - 0.25] : [porchX - porchW / 2 + 0.25];
    for (const cx of cols) {
      b.add('trim', new THREE.CylinderGeometry(0.1, 0.12, roofY - porchY, 10), cx, porchY + (roofY - porchY) / 2, D / 2 + porchD - 0.3);
    }
    // railing along the porch front + balusters
    b.add('trim', new THREE.BoxGeometry(porchW - 0.5, 0.08, 0.08), porchX, porchY + 0.95, D / 2 + porchD - 0.15);
    for (let k = 0; k < Math.floor(porchW / 0.35); k++) {
      const bx = porchX - porchW / 2 + 0.4 + k * 0.35;
      b.add('trim', new THREE.BoxGeometry(0.04, 0.85, 0.04), bx, porchY + 0.5, D / 2 + porchD - 0.15);
    }
    // steps down to the walk
    for (let st = 0; st < 3; st++) {
      b.add('concrete', metreBox(1.2, porchY / 3, 0.3), porchX, (porchY / 3) * (st + 0.5), D / 2 + porchD + 0.15 + (2 - st) * 0.3);
    }
    // front walk
    b.add('concrete', slab(1.1, 3.2), porchX, 0.03, D / 2 + porchD + 2.2);
    // side + rear windows
    for (const fl of [0, 1]) {
      const wy = foundation + 0.9 + fl * storeyH;
      windowGeo(b, ux, wy, -D / 2 - 0.02, 1.1, 1.5, Math.PI, rng() < 0.4);
      if (!semi || Math.abs(ux) > 0) {
        const sx = mirror * (W / 2 + 0.02);
        for (const zz of [-D * 0.25, D * 0.1]) windowGeo(b, sx, wy, zz, 1.0, 1.4, (Math.PI / 2) * mirror, rng() < 0.4);
      }
    }
  }
  // attic gable window
  b.add('trim', new THREE.BoxGeometry(0.9, 1.1, 0.06), 0, H + rise * 0.35, D / 2 + 0.01);
  b.add('houseGlass', new THREE.BoxGeometry(0.7, 0.9, 0.04), 0, H + rise * 0.35, D / 2 + 0.03);
  return { parts: b.merged(), width: W, depth: D };
}

/** Punched window: white frame, dark glass, sill. `ry` rotates about y so it faces the wall normal. */
function windowGeo(b: GeoBatch, x: number, y: number, z: number, w: number, h: number, ry: number, lit: boolean): void {
  b.add('trim', new THREE.BoxGeometry(w + 0.16, h + 0.16, 0.1), x, y + h / 2, z, ry);
  b.add(lit ? 'houseGlassLit' : 'houseGlass', new THREE.BoxGeometry(w, h, 0.06), x, y + h / 2, z, ry);
  b.add('mullion', new THREE.BoxGeometry(0.04, h, 0.02), x, y + h / 2, z, ry, 1, 1, 1);
  b.add('mullion', new THREE.BoxGeometry(w, 0.04, 0.02), x, y + h * 0.55, z, ry);
  b.add('trim', new THREE.BoxGeometry(w + 0.3, 0.08, 0.18), x, y - 0.04, z, ry);
}

export interface HousePlacement {
  x: number;
  z: number;
  heading: number;
  variant: number;
}

const HOUSE_VARIANT_COUNT = 6;

export function houseVariant(i: number): HouseVariant {
  while (houseVariants.length < HOUSE_VARIANT_COUNT) houseVariants.push(buildHouseVariant(houseVariants.length + 1));
  return houseVariants[i % HOUSE_VARIANT_COUNT];
}

/** Instance every placement per variant/material. */
export function buildHouses(placements: HousePlacement[], group: THREE.Group, collision: CollisionWorld): void {
  ensureMaterials();
  const m4 = new THREE.Matrix4();
  for (let v = 0; v < HOUSE_VARIANT_COUNT; v++) {
    const list = placements.filter((p) => p.variant % HOUSE_VARIANT_COUNT === v);
    if (!list.length) continue;
    const variant = houseVariant(v);
    for (const [key, geo] of variant.parts) {
      const mat = mats.get(key);
      if (!mat) continue;
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((p, i) => {
        m4.makeRotationY(p.heading).setPosition(p.x, 0, p.z);
        inst.setMatrixAt(i, m4);
      });
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
    }
    for (const p of list) collision.addOBB({ x: p.x, z: p.z, heading: p.heading, halfW: variant.width / 2 + 0.2, halfL: variant.depth / 2 + 0.6, tag: 'building' });
  }
}

/* ------------------------------------------------------------------ */
/* industrial / school / DriveTest                                      */
/* ------------------------------------------------------------------ */

export function addIndustrial(ctx: Ctx, x0: number, z0: number, x1: number, z1: number, seed: number): void {
  const b = ctx.batch;
  const rng = mulberry32(seed * 7 + 5);
  const bw = x1 - x0;
  const bd = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  // yard pad
  b.add('roofDark', slab(bw, bd), cx, 0.01, cz);
  // main shed: corrugated walls, low-slope roof with parapet, roll-up doors on the south face
  const w = Math.min(bw - 16, 34 + rng() * 20);
  const d = Math.min(bd - 18, 22 + rng() * 10);
  const h = 8 + rng() * 3;
  const sx = cx - (bw - w) * 0.2;
  const sz = cz - 4;
  const clad = ['corrugated', 'corrugatedBlue', 'corrugatedTan'][seed % 3];
  b.add('concrete', metreBox(w + 0.2, 1.0, d + 0.2), sx, 0.5, sz);
  b.add(clad, wallBox(w, h - 1, d, 1), sx, 1 + (h - 1) / 2, sz);
  rooftopFlat(ctx, sx, sz, w, d, h);
  b.add('mech', new THREE.BoxGeometry(3, 1.6, 2.2), sx - w * 0.2, h + 0.8, sz);
  b.add('mech', new THREE.CylinderGeometry(0.5, 0.5, 2.4, 10), sx + w * 0.25, h + 1.2, sz - d * 0.2);
  const nDoors = Math.max(2, Math.floor(w / 9));
  for (let i = 0; i < nDoors; i++) {
    const dx = sx - w / 2 + (w / nDoors) * (i + 0.5);
    b.add('trimDark', new THREE.BoxGeometry(4.2, 4.4, 0.16), dx, 3.2, sz + d / 2 + 0.02);
    for (let r = 0; r < 8; r++) b.add('steel', new THREE.BoxGeometry(4.0, 0.03, 0.05), dx, 1.2 + r * 0.5, sz + d / 2 + 0.11);
    // loading dock bumper + platform
    b.add('concrete', metreBox(4.6, 1.2, 2.4), dx, 0.6, sz + d / 2 + 1.3);
  }
  // office corner: brick with windows
  const ow = 10;
  const od = 8;
  const ox = sx + w / 2 - ow / 2;
  const oz = sz + d / 2 + od / 2 + 3;
  b.add('brickBuff', wallBox(ow, 4, od), ox, 2, oz);
  rooftopFlat(ctx, ox, oz, ow, od, 4);
  for (let i = 0; i < 3; i++) windowGeo(b, ox - ow / 2 + 2 + i * 3, 1.0, oz + od / 2 + 0.02, 1.6, 1.4, 0, i === 1);
  b.add('door', new THREE.BoxGeometry(1.0, 2.1, 0.08), ox + ow / 2 - 1.5, 1.05, oz + od / 2 + 0.04);
  // chain-link fence around the yard with a gate gap on the street side
  fence(b, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 2.2, rng() < 0.5 ? 'south' : 'north');
  // dumpsters + stacked pallets
  for (let i = 0; i < 2; i++) b.add('dumpster', new THREE.BoxGeometry(2.4, 1.5, 1.6), sx - w / 2 - 4, 0.75, sz - d / 4 + i * 3);
  for (let i = 0; i < 4; i++) b.add('door', new THREE.BoxGeometry(1.2, 0.14 * (1 + (i % 3)), 1.0), sx + w / 2 + 4 + (i % 2) * 1.6, 0.1 * (1 + (i % 3)), sz + Math.floor(i / 2) * 1.4);
  addCollider(ctx, sx, sz, w + 0.4, d + 0.4);
  addCollider(ctx, ox, oz, ow, od);
}

function fence(b: GeoBatch, x0: number, z0: number, x1: number, z1: number, h: number, gate: 'north' | 'south'): void {
  const post = new THREE.CylinderGeometry(0.04, 0.04, h, 6);
  const run = (ax: number, az: number, bx: number, bz: number, gap: boolean): void => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.floor(len / 3);
    const ang = Math.atan2(bx - ax, bz - az);
    const midS = len / 2;
    for (let i = 0; i <= n; i++) {
      const s = (i / n) * len;
      if (gap && Math.abs(s - midS) < 6) continue;
      b.add('fencePost', post, ax + Math.sin(ang) * s, h / 2, az + Math.cos(ang) * s);
    }
    const segs: Array<[number, number]> = gap ? [[0, midS - 6], [midS + 6, len]] : [[0, len]];
    for (const [s0, s1] of segs) {
      const l = s1 - s0;
      if (l <= 0) continue;
      const mesh = new THREE.PlaneGeometry(l, h - 0.1);
      const uv = mesh.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * l * 2, uv.getY(i) * h * 2);
      mesh.rotateY(ang + Math.PI / 2);
      const mid = s0 + l / 2;
      b.add('chainlink', mesh, ax + Math.sin(ang) * mid, h / 2, az + Math.cos(ang) * mid);
      b.add('fencePost', new THREE.BoxGeometry(0.03, 0.03, l), ax + Math.sin(ang) * mid, h - 0.05, az + Math.cos(ang) * mid, ang);
    }
  };
  run(x0, z0, x1, z0, gate === 'north');
  run(x1, z0, x1, z1, false);
  run(x1, z1, x0, z1, gate === 'south');
  run(x0, z1, x0, z0, false);
}

export function addSchool(ctx: Ctx, x0: number, z0: number, x1: number, z1: number): void {
  const b = ctx.batch;
  const cx = (x0 + x1) / 2;
  const bw = x1 - x0;
  const sz = z0 + 22;
  const w = Math.min(bw - 30, 58);
  const d = 20;
  const h = 8.4;
  facadeMat('school', facadeSet({ seed: 501, style: 'ribbon', wall: [178, 150, 112], floorH: 4.0, bayW: 4.5, lit: 0.15 }));
  b.add('concrete', metreBox(w + 0.2, 0.8, d + 0.2), cx, 0.4, sz);
  b.add('school', wallBox(w, h - 0.8, d, 0.8), cx, 0.8 + (h - 0.8) / 2, sz);
  rooftop(ctx, cx, sz, w, d, h, true);
  // entrance canopy + doors on the street (north) side
  const ez = sz - d / 2;
  b.add('concrete', metreBox(8, 0.4, 4), cx, 3.6, ez - 2);
  for (const dx of [-3.4, 3.4]) b.add('steel', new THREE.CylinderGeometry(0.12, 0.12, 3.4, 8), cx + dx, 1.7, ez - 3.6);
  for (const dx of [-1.0, 1.0]) b.add('door', new THREE.BoxGeometry(1.0, 2.2, 0.08), cx + dx, 1.1, ez - 0.04);
  b.add('schoolSign', new THREE.BoxGeometry(12, 1.5, 0.1), cx, 5.5, ez - 0.06);
  // gym block
  const gx = cx + w / 2 + 9;
  b.add('brickBuff', wallBox(18, 7, 16), gx, 3.5, sz + 2);
  rooftopFlat(ctx, gx, sz + 2, 18, 16, 7);
  // flagpole with flag
  b.add('flagpole', new THREE.CylinderGeometry(0.05, 0.07, 9, 8), cx - 12, 4.5, ez - 8);
  b.add('flag', new THREE.PlaneGeometry(1.8, 0.9), cx - 11.1, 8.3, ez - 8, Math.PI / 2);
  // yard: asphalt pad, basketball court, playground, fence
  const yz = sz + d / 2 + 22;
  b.add('roofDark', slab(w, 36), cx, 0.012, yz);
  b.add('court', slab(28, 15), cx - 12, 0.02, yz + 4);
  for (const dx of [-26, 2]) {
    b.add('steel', new THREE.CylinderGeometry(0.06, 0.06, 3.2, 8), cx + dx, 1.6, yz + 4);
    b.add('trim', new THREE.BoxGeometry(1.8, 1.05, 0.05), cx + dx + (dx < -12 ? 0.6 : -0.6), 3.0, yz + 4);
    b.add('playRed', new THREE.TorusGeometry(0.23, 0.02, 6, 16), cx + dx + (dx < -12 ? 0.9 : -0.9), 2.75, yz + 4, 0, 1, 1, 1, Math.PI / 2);
  }
  playground(b, cx + 16, yz + 2);
  fence(b, x0 + 2, sz + d / 2 + 3, x1 - 2, z1 - 2, 1.8, 'south');
  addCollider(ctx, cx, sz, w + 0.4, d + 0.4);
  addCollider(ctx, gx, sz + 2, 18, 16);
}

function playground(b: GeoBatch, x: number, z: number): void {
  // swing set: two A-frames + top bar + swings
  for (const dx of [-2.5, 2.5]) {
    b.add('playBlue', new THREE.CylinderGeometry(0.05, 0.05, 2.7, 6), x + dx, 1.3, z - 0.7, 0, 1, 1, 1, 0.25);
    b.add('playBlue', new THREE.CylinderGeometry(0.05, 0.05, 2.7, 6), x + dx, 1.3, z + 0.7, 0, 1, 1, 1, -0.25);
  }
  b.add('playBlue', new THREE.CylinderGeometry(0.05, 0.05, 5.4, 6), x, 2.55, z, 0, 1, 1, 1, 0, Math.PI / 2);
  for (const dx of [-1.2, 0, 1.2]) {
    b.add('steel', new THREE.BoxGeometry(0.02, 2.0, 0.02), x + dx - 0.2, 1.5, z);
    b.add('steel', new THREE.BoxGeometry(0.02, 2.0, 0.02), x + dx + 0.2, 1.5, z);
    b.add('trimDark', new THREE.BoxGeometry(0.5, 0.05, 0.2), x + dx, 0.5, z);
  }
  // slide: platform, ladder, sloped chute
  const sx = x + 7;
  b.add('playRed', new THREE.BoxGeometry(1.2, 0.1, 1.2), sx, 1.8, z);
  for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) b.add('playYellow', new THREE.CylinderGeometry(0.05, 0.05, 1.8, 6), sx + dx, 0.9, z + dz);
  b.add('playYellow', new THREE.BoxGeometry(0.9, 0.1, 3.6), sx, 1.0, z + 2.2, 0, 1, 1, 1, 0.48);
  for (let i = 0; i < 4; i++) b.add('steel', new THREE.BoxGeometry(0.8, 0.03, 0.03), sx, 0.4 + i * 0.4, z - 0.9 - i * 0.2);
  // climber dome
  b.add('playRed', new THREE.IcosahedronGeometry(1.6, 1), x + 3.5, 0.2, z + 6, 0, 1, 0.7, 1);
  // bench
  b.add('trimDark', new THREE.BoxGeometry(1.8, 0.05, 0.45), x - 6, 0.45, z + 6);
}

export function addDriveTest(ctx: Ctx, lot: { x0: number; z0: number; x1: number; z1: number }): void {
  const b = ctx.batch;
  const cx = -620;
  const cz = -445;
  const w = 34;
  const d = 14;
  const h = 5.2;
  facadeMat('dt-glass', facadeSet({ seed: 601, style: 'glass', wall: [120, 124, 130], floorH: 5.2, bayW: 3.4, lit: 0.6 }));
  b.add('concrete', metreBox(w + 0.2, 0.6, d + 0.2), cx, 0.3, cz);
  b.add('dt-glass', wallBox(w, h - 0.6, d, 0.6), cx, 0.6 + (h - 0.6) / 2, cz);
  rooftop(ctx, cx, cz, w, d, h, false);
  b.add('dtSign', new THREE.BoxGeometry(9, 2.2, 0.3), cx, h + 2.2, cz + 2, 0);
  b.add('steel', new THREE.BoxGeometry(0.2, 1.2, 0.2), cx - 3, h + 0.6, cz + 2);
  b.add('steel', new THREE.BoxGeometry(0.2, 1.2, 0.2), cx + 3, h + 0.6, cz + 2);
  // entrance canopy
  b.add('concrete', metreBox(6, 0.35, 3), cx + 6, 3.4, cz + d / 2 + 1.5);
  for (const dx of [-2.6, 2.6]) b.add('steel', new THREE.CylinderGeometry(0.08, 0.08, 3.3, 8), cx + 6 + dx, 1.65, cz + d / 2 + 2.6);
  // parking stalls pad with painted lines
  const lw = lot.x1 - lot.x0;
  const ld = lot.z1 - lot.z0;
  const pad = slab(lw, ld);
  const uv = pad.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 24, uv.getY(i) / 14);
  b.add('stalls', pad, (lot.x0 + lot.x1) / 2, 0.02, (lot.z0 + lot.z1) / 2);
  // flagpole
  b.add('flagpole', new THREE.CylinderGeometry(0.05, 0.07, 9, 8), cx - 20, 4.5, cz + 10);
  b.add('flag', new THREE.PlaneGeometry(1.8, 0.9), cx - 19.1, 8.3, cz + 10, Math.PI / 2);
  addCollider(ctx, cx, cz, w + 0.4, d + 0.4);
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

export function newBuildingContext(collision: CollisionWorld, rng: () => number): Ctx {
  ensureMaterials();
  return { batch: new GeoBatch(), collision, rng };
}

export function finishBuildings(ctx: Ctx, group: THREE.Group): BuildingsResult {
  ctx.batch.build(mats, group);
  return { group, nightMats };
}

export function buildingNight(f: number): void {
  for (const m of nightMats) m.emissiveIntensity = f * (m.userData.night ?? 1);
}

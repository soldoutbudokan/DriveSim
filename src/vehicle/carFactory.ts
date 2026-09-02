/**
 * Procedural vehicle visuals (no external assets). One factory builds every
 * vehicle kind in the sim — the player car, AI traffic, transit and emergency
 * vehicles. Bodies are parametric lofts (see loft.ts) with real glass regions
 * in the skin, clear-coated paint that reflects the sky, an interior visible
 * through the glass (dashboard, wheel, seats), lathe-turned tires with spoked
 * rims, headlamp clusters with lenses, tail-light bars, mirrors, handles,
 * wipers and Ontario plates. A `CarVisual` wraps the mesh with per-frame
 * light / suspension / steering-wheel animation shared by the player and AI.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, damp, mulberry32 } from '../core/math';
import { loftBody, type LoftSpec, type LoftResult, smoothNormalsByAngle } from './loft';
import { plateTexture, randomPlate, canvas, tex } from '../world/materials';

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

/* ------------------------------------------------------------------ */
/* materials                                                           */
/* ------------------------------------------------------------------ */

const matCache = new Map<string, THREE.MeshStandardMaterial>();

/** Generic cached standard material (also used by world props). */
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

const paintCache = new Map<string, THREE.MeshPhysicalMaterial>();

/** Clear-coated metallic paint. */
export function paintMat(color: number, map?: THREE.Texture): THREE.MeshPhysicalMaterial {
  const key = `${color}|${map ? map.uuid : ''}`;
  let m = paintCache.get(key);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color,
      metalness: 0.55,
      roughness: 0.38,
      clearcoat: 1,
      clearcoatRoughness: 0.06,
      envMapIntensity: 1.1,
      map: map ?? null,
    });
    paintCache.set(key, m);
  }
  return m;
}

const WINDSHIELD = new THREE.MeshPhysicalMaterial({
  color: 0xc4d4de,
  transparent: true,
  opacity: 0.22,
  roughness: 0.04,
  metalness: 0,
  envMapIntensity: 1.6,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const SIDE_GLASS = new THREE.MeshPhysicalMaterial({
  color: 0x0e161f,
  transparent: true,
  opacity: 0.62,
  roughness: 0.05,
  metalness: 0.2,
  envMapIntensity: 1.5,
  side: THREE.DoubleSide,
  depthWrite: false,
});
const TRIM = new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.78, metalness: 0.08 });
const CHROME = new THREE.MeshStandardMaterial({ color: 0xdfe3e7, roughness: 0.14, metalness: 1.0, envMapIntensity: 1.2 });
const TIRE = new THREE.MeshStandardMaterial({ color: 0x101113, roughness: 0.92, metalness: 0 });
const RIM = new THREE.MeshStandardMaterial({ color: 0xcdd2d8, roughness: 0.36, metalness: 0.8 });
const INTERIOR = new THREE.MeshStandardMaterial({ color: 0x1d1f24, roughness: 0.92, metalness: 0.02 });
const LINER = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.95, metalness: 0, side: THREE.BackSide });
const LAMP_GLASS = new THREE.MeshPhysicalMaterial({
  color: 0xe8f0f8,
  transparent: true,
  opacity: 0.32,
  roughness: 0.03,
  metalness: 0,
  envMapIntensity: 1.5,
  depthWrite: false,
});

function mkLightMat(color: number, base = 0x2a2c30, opacity = 1): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: base,
    roughness: 0.25,
    metalness: 0.15,
    emissive: new THREE.Color(color),
    emissiveIntensity: 0,
  });
  if (opacity < 1) {
    m.transparent = true;
    m.opacity = opacity;
    m.depthWrite = false;
  }
  return m;
}

const labelCache = new Map<string, THREE.CanvasTexture>();
function labelTexture(text: string, bg: string, fg: string, w = 256, h = 64, font = '700 40px system-ui'): THREE.CanvasTexture {
  const key = `${text}|${bg}|${fg}|${w}x${h}|${font}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const [c, g] = canvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 2);
  const t = tex(c, { repeat: false });
  labelCache.set(key, t);
  return t;
}

/** Police livery drawn in loft UV space (u = ring fraction, v = station). */
function liveryTexture(kind: 'police' | 'taxi'): THREE.CanvasTexture {
  const key = `livery-${kind}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const [c, g] = canvas(256, 256);
  if (kind === 'police') {
    g.fillStyle = '#f4f6f8';
    g.fillRect(0, 0, 256, 256);
    // door band (u ≈ 0.26..0.40 of the ring is the door bulge), stations 0.12..0.86
    g.fillStyle = '#1c3f8f';
    g.fillRect(256 * 0.27, 256 * (1 - 0.86), 256 * 0.13, 256 * 0.74);
    g.fillStyle = '#d2232a';
    g.fillRect(256 * 0.405, 256 * (1 - 0.86), 256 * 0.02, 256 * 0.74);
    // hood + trunk are white; roof band dark
    g.fillStyle = '#1c3f8f';
    g.fillRect(256 * 0.86, 256 * (1 - 0.7), 256 * 0.14, 256 * 0.55);
  } else {
    g.fillStyle = '#f5a623';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#2b7a3e';
    g.fillRect(256 * 0.86, 0, 256 * 0.14, 256);
    // checker band at the belt
    for (let i = 0; i < 24; i++) {
      g.fillStyle = i % 2 ? '#111' : '#fff';
      g.fillRect(256 * 0.47, i * (256 / 24), 256 * 0.05, 256 / 24);
    }
  }
  const t = tex(c, { repeat: false });
  labelCache.set(key, t);
  return t;
}

/* ------------------------------------------------------------------ */
/* body specs                                                          */
/* ------------------------------------------------------------------ */

const SEDAN: LoftSpec = {
  top: [
    [-0.5, 0.50], [-0.485, 0.555, 0.01], [-0.45, 0.585, 0.02], [-0.31, 0.605, 0.02], [-0.165, 0.93, 0.06],
    [-0.03, 0.995, 0.12], [0.11, 0.965, 0.05], [0.235, 0.615, 0.03], [0.30, 0.59, 0.03], [0.46, 0.56, 0.02],
    [0.49, 0.52, 0.01], [0.5, 0.42],
  ],
  belt: [[-0.5, 0.56], [-0.3, 0.58], [0.25, 0.62], [0.5, 0.62]],
  bottom: [[-0.5, 0.26], [-0.47, 0.17, 0.02], [-0.35, 0.14, 0.03], [0.35, 0.14, 0.03], [0.47, 0.17, 0.02], [0.5, 0.26]],
  halfW: [[-0.5, 0.455], [-0.47, 0.49, 0.015], [-0.4, 0.5, 0.03], [0.4, 0.5, 0.03], [0.47, 0.49, 0.015], [0.5, 0.46]],
  roofW: [[-0.5, 0.40], [-0.2, 0.41], [0.1, 0.405], [0.5, 0.39]],
  glass: { rearBase: -0.31, roofRear: -0.165, roofFront: 0.11, cowl: 0.235, pillars: [[-0.05, 0.012]] },
  boxy: 0.45,
  trimBelow: 0.04,
  fasciaTrimBelow: 0.15,
};

const HATCH: LoftSpec = {
  top: [
    [-0.5, 0.52], [-0.485, 0.60, 0.01], [-0.455, 0.90, 0.03], [-0.40, 0.975, 0.05], [-0.1, 0.995, 0.1],
    [0.10, 0.955, 0.05], [0.235, 0.62, 0.03], [0.32, 0.60, 0.03], [0.46, 0.57, 0.02], [0.49, 0.53, 0.01], [0.5, 0.44],
  ],
  belt: [[-0.5, 0.58], [0.5, 0.63]],
  bottom: [[-0.5, 0.26], [-0.47, 0.17, 0.02], [-0.35, 0.14, 0.03], [0.35, 0.14, 0.03], [0.47, 0.17, 0.02], [0.5, 0.26]],
  halfW: [[-0.5, 0.46], [-0.47, 0.49, 0.015], [-0.4, 0.5, 0.03], [0.4, 0.5, 0.03], [0.47, 0.49, 0.015], [0.5, 0.46]],
  roofW: [[-0.5, 0.42], [0.5, 0.40]],
  glass: { rearBase: -0.485, roofRear: -0.40, roofFront: 0.10, cowl: 0.235, pillars: [[-0.06, 0.012], [-0.33, 0.016]] },
  boxy: 0.5,
  trimBelow: 0.04,
  fasciaTrimBelow: 0.15,
};

const SUV: LoftSpec = {
  top: [
    [-0.5, 0.55], [-0.49, 0.62, 0.01], [-0.47, 0.92, 0.03], [-0.42, 0.98, 0.04], [-0.1, 0.995, 0.1],
    [0.12, 0.965, 0.05], [0.235, 0.66, 0.03], [0.32, 0.64, 0.03], [0.46, 0.62, 0.02], [0.495, 0.56, 0.01], [0.5, 0.46],
  ],
  belt: [[-0.5, 0.60], [0.5, 0.65]],
  bottom: [[-0.5, 0.32], [-0.47, 0.22, 0.02], [-0.35, 0.19, 0.03], [0.35, 0.19, 0.03], [0.47, 0.22, 0.02], [0.5, 0.30]],
  halfW: [[-0.5, 0.46], [-0.47, 0.49, 0.015], [-0.4, 0.5, 0.03], [0.4, 0.5, 0.03], [0.47, 0.49, 0.015], [0.5, 0.46]],
  roofW: [[-0.5, 0.44], [0.5, 0.42]],
  glass: { rearBase: -0.485, roofRear: -0.42, roofFront: 0.12, cowl: 0.235, pillars: [[-0.05, 0.012], [-0.30, 0.014]] },
  boxy: 0.6,
  trimBelow: 0.08,
  fasciaTrimBelow: 0.18,
};

/** Cab-forward van / truck cab (also the ambulance and fire-truck cab). */
const VAN_CAB: LoftSpec = {
  top: [[-0.5, 0.99], [0.15, 0.99, 0.08], [0.30, 0.62, 0.04], [0.42, 0.56, 0.03], [0.49, 0.46, 0.01], [0.5, 0.36]],
  belt: [[-0.5, 0.55], [0.5, 0.58]],
  bottom: [[-0.5, 0.22], [0.4, 0.22, 0.02], [0.5, 0.30]],
  halfW: [[-0.5, 0.5], [0.44, 0.5, 0.03], [0.5, 0.42]],
  roofW: [[-0.5, 0.47], [0.5, 0.45]],
  glass: { rearBase: -0.7, roofRear: -0.6, roofFront: 0.15, cowl: 0.30, pillars: [[-0.12, 0.02]], sideFrom: -0.45, sideTo: 0.28 },
  boxy: 0.8,
  trimBelow: 0.04,
  fasciaTrimBelow: 0.16,
};

const CREW_CAB: LoftSpec = {
  ...VAN_CAB,
  glass: { rearBase: -0.7, roofRear: -0.6, roofFront: 0.15, cowl: 0.30, pillars: [[-0.35, 0.02], [0.0, 0.02]], sideFrom: -0.47, sideTo: 0.28 },
};

function pillarsEvery(from: number, to: number, step: number, w = 0.012): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let z = from; z <= to + 1e-6; z += step) out.push([z, w]);
  return out;
}

const BUS: LoftSpec = {
  top: [[-0.5, 0.98], [0.30, 0.98, 0.05], [0.36, 0.62, 0.03], [0.47, 0.58, 0.03], [0.5, 0.40]],
  belt: [[-0.5, 0.55], [0.5, 0.56]],
  bottom: [[-0.5, 0.28], [-0.46, 0.26, 0.01], [0.46, 0.26, 0.01], [0.5, 0.32]],
  halfW: [[-0.5, 0.47, 0.01], [-0.47, 0.5, 0.01], [0.3, 0.5, 0.01], [0.36, 0.48, 0.02], [0.5, 0.45]],
  roofW: [[-0.5, 0.46], [0.5, 0.44]],
  glass: { rearBase: -0.7, roofRear: -0.6, roofFront: 0.30, cowl: 0.36, pillars: pillarsEvery(-0.42, 0.24, 0.11, 0.01), sideFrom: -0.48, sideTo: 0.29 },
  boxy: 1,
  trimBelow: 0.03,
  fasciaTrimBelow: 0.12,
  stations: 60,
};

const STREETCAR: LoftSpec = {
  top: [[-0.5, 0.62], [-0.49, 0.9, 0.02], [-0.46, 0.99, 0.03], [0.40, 0.99, 0.03], [0.46, 0.72, 0.03], [0.5, 0.45]],
  belt: [[-0.5, 0.40], [0.5, 0.42]],
  bottom: [[-0.5, 0.14], [0.5, 0.14]],
  halfW: [[-0.5, 0.46, 0.01], [-0.47, 0.5], [0.44, 0.5], [0.5, 0.44]],
  roofW: [[-0.5, 0.45], [0.5, 0.44]],
  glass: { rearBase: -0.7, roofRear: -0.6, roofFront: 0.40, cowl: 0.46, pillars: pillarsEvery(-0.44, 0.38, 0.082, 0.008), sideFrom: -0.47, sideTo: 0.42 },
  boxy: 1,
  trimBelow: 0.05,
  fasciaTrimBelow: 0.1,
  stations: 80,
};

/* ------------------------------------------------------------------ */
/* geometry helpers                                                    */
/* ------------------------------------------------------------------ */

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const V = new THREE.Vector3();

/** Collects geometries per material key, merged into one mesh each. */
class Parts {
  private lists = new Map<string, THREE.BufferGeometry[]>();
  add(key: string, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): void {
    const g = geo.clone();
    M.compose(V.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
    g.applyMatrix4(M);
    let arr = this.lists.get(key);
    if (!arr) {
      arr = [];
      this.lists.set(key, arr);
    }
    arr.push(g);
  }
  merged(): Map<string, THREE.BufferGeometry> {
    const out = new Map<string, THREE.BufferGeometry>();
    for (const [k, arr] of this.lists) {
      const geos = arr.map((g) => {
        const gg = g.index ? g.toNonIndexed() : g;
        // drop attributes that not every geometry shares
        for (const name of Object.keys(gg.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') gg.deleteAttribute(name);
        if (!gg.getAttribute('uv')) gg.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(gg.getAttribute('position').count * 2), 2));
        return gg;
      });
      const m = mergeGeometries(geos, false);
      if (m) out.set(k, m);
    }
    return out;
  }
}

function box(w: number, h: number, d: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

/** Rounded-rectangle profile extruded along z (cargo boxes, modules). */
function roundedBox(w: number, h: number, d: number, r: number, bevel = 0.04): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const x0 = -w / 2;
  const y0 = -h / 2;
  shape.moveTo(x0 + r, y0);
  shape.lineTo(x0 + w - r, y0);
  shape.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
  shape.lineTo(x0 + w, y0 + h - r);
  shape.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
  shape.lineTo(x0 + r, y0 + h);
  shape.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
  shape.lineTo(x0, y0 + r);
  shape.quadraticCurveTo(x0, y0, x0 + r, y0);
  const depth = d - 2 * bevel;
  const geo = new THREE.ExtrudeGeometry(shape, { steps: 1, depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 2 });
  geo.translate(0, 0, -depth / 2);
  const ng = geo.index ? geo.toNonIndexed() : geo;
  smoothNormalsByAngle(ng, 40);
  return ng;
}

/** Headlamp lens: rounded quad wrapped slightly around the corner. */
function lensGeo(w: number, h: number, depth: number, sweep: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const r = Math.min(w, h) * 0.3;
  shape.moveTo(-w / 2 + r, -h / 2);
  shape.lineTo(w / 2 - r, -h / 2);
  shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
  shape.lineTo(w / 2 + sweep, h / 2 - r);
  shape.quadraticCurveTo(w / 2 + sweep, h / 2, w / 2 + sweep - r, h / 2);
  shape.lineTo(-w / 2 + r, h / 2);
  shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  shape.lineTo(-w / 2, -h / 2 + r);
  shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const geo = new THREE.ExtrudeGeometry(shape, { steps: 1, depth, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 2 });
  geo.translate(0, 0, -depth);
  return geo;
}

interface WheelGeos {
  rubber: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
}
const wheelCache = new Map<string, WheelGeos>();

/** Lathe-turned tire + rim barrel + spoked face + hub; face on +x. */
function wheelGeos(R: number, w: number, spokes = 5): WheelGeos {
  const key = `${R}|${w}|${spokes}`;
  const hit = wheelCache.get(key);
  if (hit) return hit;
  const prof: THREE.Vector2[] = [
    new THREE.Vector2(R * 0.56, -w / 2 + 0.02),
    new THREE.Vector2(R * 0.6, -w / 2),
    new THREE.Vector2(R * 0.86, -w / 2),
    new THREE.Vector2(R * 0.965, -w / 2 + 0.025),
    new THREE.Vector2(R, -w / 2 + 0.06),
    new THREE.Vector2(R, w / 2 - 0.06),
    new THREE.Vector2(R * 0.965, w / 2 - 0.025),
    new THREE.Vector2(R * 0.86, w / 2),
    new THREE.Vector2(R * 0.6, w / 2),
    new THREE.Vector2(R * 0.56, w / 2 - 0.02),
  ];
  const tire = new THREE.LatheGeometry(prof, 28);
  tire.rotateZ(-Math.PI / 2); // lathe axis Y → X
  // inner dark disc hides the hollow behind the spokes
  const disc = new THREE.CylinderGeometry(R * 0.58, R * 0.58, 0.02, 24);
  disc.rotateZ(Math.PI / 2);
  disc.translate(w / 2 - 0.09, 0, 0);
  const rubberParts = [tire.toNonIndexed(), disc.toNonIndexed()];
  // rim: barrel ring + face ring + spokes + hub
  const rimProf: THREE.Vector2[] = [
    new THREE.Vector2(R * 0.57, -w / 2 + 0.03),
    new THREE.Vector2(R * 0.6, -w / 2 + 0.03),
    new THREE.Vector2(R * 0.6, w / 2 - 0.02),
    new THREE.Vector2(R * 0.5, w / 2 - 0.03),
    new THREE.Vector2(R * 0.5, w / 2 - 0.06),
    new THREE.Vector2(R * 0.57, w / 2 - 0.05),
  ];
  const barrel = new THREE.LatheGeometry(rimProf, 28);
  barrel.rotateZ(-Math.PI / 2);
  const rimParts: THREE.BufferGeometry[] = [barrel.toNonIndexed()];
  const faceX = w / 2 - 0.045;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const sp = new THREE.BoxGeometry(0.03, R * 0.46, R * 0.13);
    sp.translate(0, R * 0.28, 0);
    sp.rotateX(a);
    sp.translate(faceX, 0, 0);
    rimParts.push(sp.toNonIndexed());
  }
  const hub = new THREE.CylinderGeometry(R * 0.17, R * 0.17, 0.05, 16);
  hub.rotateZ(Math.PI / 2);
  hub.translate(faceX + 0.01, 0, 0);
  rimParts.push(hub.toNonIndexed());
  const strip = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    return g;
  };
  const out = {
    rubber: mergeGeometries(rubberParts.map(strip), false)!,
    rim: mergeGeometries(rimParts.map(strip), false)!,
  };
  wheelCache.set(key, out);
  return out;
}

/* ------------------------------------------------------------------ */
/* built car                                                           */
/* ------------------------------------------------------------------ */

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
  /** Steering wheel (rotates with steer), passenger cars only. */
  steeringWheel?: THREE.Object3D;
}

interface KindGeos {
  hull: THREE.BufferGeometry;
  liner: THREE.BufferGeometry;
  loft: LoftResult;
  /** Merged static parts by material key. */
  parts: Map<string, THREE.BufferGeometry>;
  /** Wheel placements: [x, y, z, isFront, mirrored]. */
  wheelPos: Array<[number, number, number, boolean, number]>;
  wheelW: number;
  wheelR: number;
  /** Local transform of the loft hull (cab offset for trucks). */
  hullZ: number;
  steeringWheel?: { x: number; y: number; z: number; tilt: number; r: number };
}

const kindCache = new Map<CarKind, KindGeos>();

function plateGeo(): THREE.PlaneGeometry {
  return new THREE.PlaneGeometry(0.37, 0.19);
}

/** Passenger-car detail parts around a loft (lamps, grille, mirrors, interior...). */
function passengerParts(kind: CarKind, loft: LoftResult, L: number, W: number, H: number, R: number, parts: Parts): void {
  const zF = L / 2;
  const zR = -L / 2;
  const hwF = loft.halfW(zF - 0.05);
  const yLampF = loft.topY(zF - 0.06) - 0.15 * H;
  // --- headlamps: reflector + lens, swept into the fender
  const lensW = W * 0.22;
  const lensH = H * 0.1;
  for (const s of [-1, 1]) {
    const x = s * (hwF - lensW * 0.5 - 0.03);
    parts.add('head', box(lensW - 0.02, lensH - 0.02, 0.06), x, yLampF, zF - 0.075, 0, s * -0.35);
    parts.add('lampGlass', lensGeo(lensW, lensH, 0.05, s * 0.06), x, yLampF, zF - 0.005, 0, s * -0.35, 0, s, 1, 1);
    // bezel
    parts.add('trim', box(lensW + 0.03, lensH + 0.03, 0.02), x, yLampF, zF - 0.095, 0, s * -0.35);
    // fog lamp in the lower fascia
    parts.add('chrome', new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12), s * hwF * 0.6, loft.bottomY(zF - 0.1) + 0.12, zF - 0.03, Math.PI / 2, 0, 0);
  }
  // --- grille + emblem + bumper lip
  const yGrille = loft.bottomY(zF - 0.05) + 0.27 * H;
  parts.add('trim', box(W * 0.46, H * 0.12, 0.05), 0, yGrille, zF - 0.02);
  for (let i = 0; i < 4; i++) parts.add('chrome', box(W * 0.44, 0.012, 0.02), 0, yGrille - H * 0.045 + i * H * 0.03, zF + 0.005);
  parts.add('chrome', new THREE.CylinderGeometry(0.05, 0.05, 0.02, 16), 0, yGrille + H * 0.075, zF + 0.01, Math.PI / 2, 0, 0);
  parts.add('trim', box(W * 0.9, 0.05, 0.1), 0, loft.bottomY(zF - 0.05) + 0.04, zF - 0.06);
  parts.add('trim', box(W * 0.9, 0.05, 0.1), 0, loft.bottomY(zR + 0.05) + 0.04, zR + 0.06);
  // --- tail lamps: wrap-around bar (red) + amber signal + white reverse
  const yLampR = loft.topY(zR + 0.05) - 0.13 * H;
  const hwR = loft.halfW(zR + 0.06);
  for (const s of [-1, 1]) {
    parts.add('tail', box(W * 0.24, H * 0.085, 0.05), s * (hwR - W * 0.15), yLampR, zR + 0.015, 0, s * 0.3);
    parts.add(s < 0 ? 'sigL' : 'sigR', box(W * 0.07, H * 0.085, 0.05), s * (hwR - W * 0.31), yLampR, zR + 0.02);
    parts.add('rev', box(W * 0.05, H * 0.05, 0.05), s * (hwR - W * 0.37), yLampR, zR + 0.02);
    parts.add(s < 0 ? 'sigL' : 'sigR', box(0.015, 0.04, 0.09), s * (loft.halfW(zF - 0.6) + 0.002), loft.beltY(zF - 0.6) - 0.03, zF - 0.6);
  }
  // --- plates
  parts.add('plateF', plateGeo(), 0, loft.bottomY(zF - 0.05) + 0.16 * H, zF + 0.012);
  parts.add('plateR', plateGeo(), 0, loft.bottomY(zR + 0.05) + 0.2 * H, zR - 0.012, 0, Math.PI, 0);
  parts.add('trim', box(0.42, 0.24, 0.01), 0, loft.bottomY(zR + 0.05) + 0.2 * H, zR - 0.004);
  // --- mirrors
  const zMir = loft.topY(L * 0.16) > loft.beltY(L * 0.16) ? L * 0.14 : L * 0.1;
  for (const s of [-1, 1]) {
    const hw = loft.halfW(zMir);
    const yb = loft.beltY(zMir) + 0.05;
    parts.add('paintExtra', roundedBox(0.1, 0.09, 0.18, 0.03, 0.01), s * (hw + 0.1), yb, zMir);
    parts.add('chrome', box(0.005, 0.07, 0.15), s * (hw + 0.1), yb, zMir - 0.09);
    parts.add('trim', box(0.1, 0.03, 0.05), s * (hw + 0.03), yb - 0.01, zMir);
  }
  // --- door handles + seams
  for (const zh of [L * 0.02, -L * 0.22]) {
    for (const s of [-1, 1]) {
      const hw = loft.halfW(zh);
      parts.add('chrome', box(0.012, 0.028, 0.15), s * (hw + 0.004), loft.beltY(zh) - 0.08, zh);
    }
  }
  // --- wipers, antenna, exhaust
  const zc = SEDAN.glass.cowl * L;
  for (const s of [-1, 1]) {
    parts.add('trim', box(0.012, 0.012, 0.42), s * 0.3 - 0.1, loft.topY(zc) + 0.02, zc - 0.16, -0.5, s * 0.3, 0);
  }
  parts.add('trim', box(0.06, 0.05, 0.2), 0, loft.topY(L * -0.12) + 0.02, L * -0.14);
  parts.add('chrome', new THREE.CylinderGeometry(0.03, 0.03, 0.14, 10), W * 0.3, loft.bottomY(zR + 0.1) + 0.03, zR + 0.03, Math.PI / 2, 0, 0);
  // --- wheel wells: dark drums inside the arches (hide the hollow body)
  for (const zw of [L * 0.32, -L * 0.32]) {
    for (const s of [-1, 1]) {
      parts.add('trim', new THREE.CylinderGeometry(R + 0.06, R + 0.06, 0.26, 20, 1, true), s * (loft.halfW(zw) - 0.2), R, zw, 0, 0, Math.PI / 2);
    }
  }
  // --- interior: dash, binnacle, console, seats, rear-view mirror
  const cowlZ = SEDAN.glass.cowl * L;
  const belt = loft.beltY(cowlZ);
  const floor = loft.bottomY(0) + 0.05;
  parts.add('interior', roundedBox(W * 0.86, 0.26, 0.55, 0.05, 0.02), 0, belt - 0.12, cowlZ - 0.32);
  parts.add('interior', box(0.36, 0.1, 0.16), -W * 0.22, belt + 0.03, cowlZ - 0.5);
  parts.add('interior', box(0.28, 0.3, 0.9), 0, floor + 0.15, cowlZ - 0.95);
  for (const s of [-1, 1]) {
    const x = s * W * 0.22;
    parts.add('interior', roundedBox(0.5, 0.14, 0.5, 0.05, 0.02), x, floor + 0.22, cowlZ - 0.95);
    parts.add('interior', roundedBox(0.5, 0.62, 0.12, 0.05, 0.02), x, floor + 0.56, cowlZ - 1.24, -0.22, 0, 0);
    parts.add('interior', roundedBox(0.26, 0.16, 0.1, 0.04, 0.01), x, floor + 0.92, cowlZ - 1.3);
  }
  parts.add('interior', roundedBox(W * 0.72, 0.14, 0.48, 0.05, 0.02), 0, floor + 0.2, L * -0.2);
  parts.add('interior', roundedBox(W * 0.72, 0.55, 0.12, 0.05, 0.02), 0, floor + 0.5, L * -0.27, -0.25, 0, 0);
  parts.add('interior', box(0.22, 0.06, 0.03), 0.08, loft.topY(L * 0.06) - 0.1, L * 0.09);
}

/** Truck / bus / streetcar / emergency parts. */
function bigParts(kind: CarKind, loft: LoftResult, cabL: number, cabZ: number, L: number, W: number, H: number, R: number, parts: Parts): void {
  const zF = L / 2;
  const zR = -L / 2;
  // headlamps + grille on the cab front
  const frontY = loft.bottomY(cabL / 2 - 0.05) + 0.42 * (loft.topY(cabL / 2 - 0.1) - loft.bottomY(cabL / 2 - 0.05));
  const hwF = loft.halfW(cabL / 2 - 0.08);
  for (const s of [-1, 1]) {
    parts.add('head', box(0.3, 0.16, 0.05), s * (hwF - 0.25), frontY, zF - 0.06);
    parts.add('lampGlass', lensGeo(0.32, 0.18, 0.04, 0), s * (hwF - 0.25), frontY, zF - 0.004);
    parts.add('trim', box(0.34, 0.2, 0.02), s * (hwF - 0.25), frontY, zF - 0.08);
    parts.add(s < 0 ? 'sigL' : 'sigR', box(0.12, 0.12, 0.05), s * (hwF - 0.06), frontY + 0.02, zF - 0.05, 0, s * 0.5);
  }
  parts.add('trim', box(W * 0.5, 0.22, 0.05), 0, frontY - 0.04, zF - 0.03);
  for (let i = 0; i < 3; i++) parts.add('chrome', box(W * 0.48, 0.02, 0.02), 0, frontY - 0.12 + i * 0.08, zF - 0.005);
  // bumpers
  parts.add(kind === 'firetruck' ? 'chrome' : 'trim', box(W * 0.98, 0.2, 0.14), 0, loft.bottomY(cabL / 2 - 0.1) + 0.06, zF - 0.02);
  parts.add('trim', box(W * 0.96, 0.18, 0.12), 0, 0.42, zR + 0.05);
  // tail lamps + plate
  for (const s of [-1, 1]) {
    parts.add('tail', box(0.14, 0.14, 0.04), s * (W / 2 - 0.2), 0.7, zR - 0.005);
    parts.add(s < 0 ? 'sigL' : 'sigR', box(0.14, 0.12, 0.04), s * (W / 2 - 0.2), 0.86, zR - 0.005);
    parts.add('rev', box(0.12, 0.1, 0.04), s * (W / 2 - 0.2), 0.58, zR - 0.005);
  }
  parts.add('plateR', plateGeo(), 0, 0.5, zR - 0.02, 0, Math.PI, 0);
  // big mirrors on stalks
  for (const s of [-1, 1]) {
    const zMir = cabZ + cabL * 0.22;
    const y = loft.beltY(zMir) + 0.35;
    parts.add('trim', box(0.04, 0.6, 0.04), s * (W / 2 + 0.3), y, zMir);
    parts.add('trim', box(0.04, 0.04, 0.34), s * (W / 2 + 0.14), y + 0.28, zMir);
    parts.add('trim', box(0.04, 0.04, 0.34), s * (W / 2 + 0.14), y - 0.28, zMir);
    parts.add('trim', box(0.06, 0.5, 0.22), s * (W / 2 + 0.32), y, zMir);
    parts.add('chrome', box(0.005, 0.44, 0.18), s * (W / 2 + 0.3), y, zMir - 0.12);
  }
  // wipers
  const cowlZ = cabZ + VAN_CAB.glass.cowl * cabL;
  for (const s of [-1, 1]) parts.add('trim', box(0.02, 0.02, 0.7), s * 0.45, loft.topY(cowlZ) + 0.03, cowlZ - 0.3, -0.45, s * 0.2, 0);
  // interior hint (dash + seats) so the cab is not hollow through the glass
  const belt = loft.beltY(cowlZ);
  parts.add('interior', roundedBox(W * 0.86, 0.3, 0.6, 0.05, 0.02), 0, belt - 0.14, cowlZ - 0.36);
  for (const s of [-1, 1]) {
    parts.add('interior', roundedBox(0.55, 0.16, 0.55, 0.05, 0.02), s * W * 0.27, belt - 0.45, cowlZ - 1.05);
    parts.add('interior', roundedBox(0.55, 0.7, 0.14, 0.05, 0.02), s * W * 0.27, belt - 0.05, cowlZ - 1.32, -0.2, 0, 0);
  }
}

function buildKind(kind: CarKind): KindGeos {
  const hit = kindCache.get(kind);
  if (hit) return hit;
  const dims = CAR_DIMS[kind];
  const { length: L, width: W, height: H, wheelRadius: R } = dims;
  const parts = new Parts();
  let loft: LoftResult;
  let hullZ = 0;
  const wheelPos: Array<[number, number, number, boolean, number]> = [];
  let wheelW = 0.225;
  let steeringWheel: KindGeos['steeringWheel'];

  const isPassenger = kind === 'sedan' || kind === 'hatch' || kind === 'suv' || kind === 'taxi' || kind === 'police';
  if (isPassenger) {
    const spec = kind === 'hatch' ? HATCH : kind === 'suv' ? SUV : SEDAN;
    loft = loftBody(spec, L, W, H, [
      { z: L * 0.32, r: R + 0.075, inset: 0.2 },
      { z: -L * 0.32, r: R + 0.075, inset: 0.2 },
    ]);
    passengerParts(kind, loft, L, W, H, R, parts);
    const wx = W / 2 - 0.15;
    for (const [z, f] of [[L * 0.32, true], [-L * 0.32, false]] as Array<[number, boolean]>) {
      wheelPos.push([-wx, R, z, f, -1], [wx, R, z, f, 1]);
    }
    const cowlZ = spec.glass.cowl * L;
    steeringWheel = { x: -W * 0.22, y: loft.beltY(cowlZ) + 0.02, z: cowlZ - 0.55, tilt: -0.5, r: 0.19 };
    if (kind === 'taxi') {
      parts.add('taxiSign', roundedBox(0.5, 0.16, 0.28, 0.04, 0.01), 0, loft.topY(-L * 0.1) + 0.1, -L * 0.1);
    }
    if (kind === 'police') {
      parts.add('trim', box(W * 0.62, 0.06, 0.32), 0, loft.topY(-L * 0.06) + 0.05, -L * 0.06);
      parts.add('beaconA', roundedBox(W * 0.28, 0.1, 0.3, 0.04, 0.01), -W * 0.16, loft.topY(-L * 0.06) + 0.12, -L * 0.06);
      parts.add('beaconB', roundedBox(W * 0.28, 0.1, 0.3, 0.04, 0.01), W * 0.16, loft.topY(-L * 0.06) + 0.12, -L * 0.06);
      parts.add('chrome', box(0.02, 0.5, 0.02), W * 0.42, loft.topY(-L * 0.35) + 0.25, -L * 0.35);
    }
  } else if (kind === 'truck' || kind === 'ambulance') {
    const cabL = kind === 'truck' ? 2.5 : 2.6;
    hullZ = L / 2 - cabL / 2;
    loft = loftBody(VAN_CAB, cabL, W, kind === 'truck' ? H * 0.85 : H * 0.88);
    bigParts(kind, loft, cabL, hullZ, L, W, H, R, parts);
    // cargo / patient module
    const boxL = L - cabL - 0.25;
    const boxZ = -L / 2 + boxL / 2;
    const boxBottom = 0.75;
    const boxH = H - boxBottom;
    parts.add('module', roundedBox(W, boxH, boxL, 0.08, 0.04), 0, boxBottom + boxH / 2, boxZ);
    // rear roll-up door ribs and the cab-box gap
    for (let i = 0; i < 9; i++) parts.add('trim', box(W * 0.84, 0.015, 0.02), 0, boxBottom + 0.25 + i * (boxH - 0.5) / 8, -L / 2 + 0.005);
    parts.add('trim', box(W * 0.9, 0.05, 0.05), 0, boxBottom + 0.12, -L / 2 + 0.01);
    parts.add('trim', box(W * 0.9, 0.05, 0.05), 0, boxBottom + boxH - 0.12, -L / 2 + 0.01);
    // chassis rails, fuel tank, mud flaps
    for (const s of [-1, 1]) {
      parts.add('trim', box(0.12, 0.25, L - 1.2), s * W * 0.3, 0.55, -0.3);
      parts.add('trim', box(0.4, 0.5, 0.06), s * (W / 2 - 0.25), 0.28, -L * 0.4);
    }
    parts.add('chrome', new THREE.CylinderGeometry(0.28, 0.28, 0.9, 14), -W * 0.3, 0.55, 0.2, 0, 0, Math.PI / 2);
    if (kind === 'ambulance') {
      // red belt stripe + module windows + light bars
      parts.add('stripe', box(W + 0.02, 0.22, boxL - 0.1), 0, boxBottom + boxH * 0.45, boxZ);
      parts.add('stripe', box(W * 0.92, 0.22, 0.02), 0, boxBottom + boxH * 0.45, -L / 2 - 0.005);
      for (const s of [-1, 1]) parts.add('sideGlass', box(0.02, 0.35, 0.5), s * (W / 2 + 0.005), boxBottom + boxH * 0.75, boxZ + boxL * 0.25);
      parts.add('sideGlass', box(0.4, 0.4, 0.02), 0, boxBottom + boxH * 0.72, -L / 2 - 0.005);
      parts.add('trim', box(W * 0.8, 0.06, 0.3), 0, H + 0.03, boxZ + boxL / 2 - 0.3);
      parts.add('beaconA', roundedBox(W * 0.36, 0.12, 0.28, 0.04, 0.01), -W * 0.2, H + 0.12, boxZ + boxL / 2 - 0.3);
      parts.add('beaconB', roundedBox(W * 0.36, 0.12, 0.28, 0.04, 0.01), W * 0.2, H + 0.12, boxZ + boxL / 2 - 0.3);
      parts.add('beaconA', box(0.2, 0.12, 0.08), -W * 0.32, H - 0.15, -L / 2 - 0.02);
      parts.add('beaconB', box(0.2, 0.12, 0.08), W * 0.32, H - 0.15, -L / 2 - 0.02);
    }
    wheelW = 0.3;
    const wx = W / 2 - 0.16;
    wheelPos.push([-wx, R, L / 2 - 1.15, true, -1], [wx, R, L / 2 - 1.15, true, 1]);
    for (const dx of [0, 0.3]) wheelPos.push([-(wx - dx), R, -L * 0.28, false, -1], [wx - dx, R, -L * 0.28, false, 1]);
  } else if (kind === 'firetruck') {
    const cabL = 3.4;
    hullZ = L / 2 - cabL / 2;
    loft = loftBody(CREW_CAB, cabL, W, H * 0.92);
    bigParts(kind, loft, cabL, hullZ, L, W, H, R, parts);
    const bodyL = L - cabL - 0.15;
    const bodyZ = -L / 2 + bodyL / 2;
    const bodyBottom = 0.7;
    const bodyH = H * 0.8 - bodyBottom;
    parts.add('paintExtra', roundedBox(W, bodyH, bodyL, 0.06, 0.03), 0, bodyBottom + bodyH / 2, bodyZ);
    // compartment doors (recessed panels)
    for (const s of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        parts.add('trim', box(0.02, bodyH * 0.72, bodyL / 4 - 0.14), s * (W / 2 + 0.006), bodyBottom + bodyH * 0.5, bodyZ - bodyL / 2 + bodyL / 8 + i * (bodyL / 4));
        parts.add('chrome', box(0.03, 0.03, 0.4), s * (W / 2 + 0.02), bodyBottom + bodyH * 0.2, bodyZ - bodyL / 2 + bodyL / 8 + i * (bodyL / 4));
      }
    }
    // hose bed rails + ladder
    parts.add('chrome', box(W * 0.9, 0.06, bodyL * 0.9), 0, bodyBottom + bodyH + 0.03, bodyZ);
    for (const s of [-1, 1]) parts.add('chrome', box(0.06, 0.1, bodyL * 0.95), s * 0.35, bodyBottom + bodyH + 0.2, bodyZ - 0.1);
    for (let i = 0; i < 12; i++) parts.add('chrome', box(0.72, 0.03, 0.03), 0, bodyBottom + bodyH + 0.2, bodyZ - bodyL * 0.45 + i * (bodyL * 0.9) / 11);
    parts.add('trim', box(W * 0.9, 0.06, 0.34), 0, H * 0.92 + 0.02, hullZ + cabL * 0.1);
    parts.add('beaconA', roundedBox(W * 0.42, 0.14, 0.32, 0.05, 0.01), -W * 0.23, H * 0.92 + 0.12, hullZ + cabL * 0.1);
    parts.add('beaconB', roundedBox(W * 0.42, 0.14, 0.32, 0.05, 0.01), W * 0.23, H * 0.92 + 0.12, hullZ + cabL * 0.1);
    parts.add('beaconA', box(0.24, 0.14, 0.08), -W * 0.34, H * 0.8 - 0.2, -L / 2 - 0.02);
    parts.add('beaconB', box(0.24, 0.14, 0.08), W * 0.34, H * 0.8 - 0.2, -L / 2 - 0.02);
    wheelW = 0.32;
    const wx = W / 2 - 0.17;
    wheelPos.push([-wx, R, L / 2 - 1.5, true, -1], [wx, R, L / 2 - 1.5, true, 1]);
    for (const dx of [0, 0.32]) wheelPos.push([-(wx - dx), R, -L * 0.26, false, -1], [wx - dx, R, -L * 0.26, false, 1]);
  } else if (kind === 'schoolbus') {
    loft = loftBody(BUS, L, W, H);
    bigParts(kind, loft, L, 0, L, W, H, R, parts);
    // rub rails, rear emergency door, stop arm, roof flashers, crossing gate
    for (const s of [-1, 1]) {
      for (const y of [0.95, 1.35, 1.85]) parts.add('trim', box(0.03, 0.08, L * 0.86), s * (W / 2 + 0.01), y, -L * 0.05);
    }
    parts.add('trim', box(0.9, 1.5, 0.03), 0, 1.6, -L / 2 - 0.01);
    parts.add('sideGlass', box(0.6, 0.5, 0.04), 0, 2.0, -L / 2 - 0.02);
    parts.add('trim', box(0.06, 0.06, 0.9), -W / 2 - 0.05, 1.6, -L * 0.1);
    parts.add('stopSign', new THREE.CylinderGeometry(0.3, 0.3, 0.02, 8), -W / 2 - 0.08, 1.6, -L * 0.1 - 0.35, Math.PI / 2, Math.PI / 8, 0);
    parts.add('busSign', box(1.2, 0.26, 0.05), 0, H - 0.3, L / 2 - 0.35);
    parts.add('busSign', box(1.2, 0.26, 0.05), 0, H - 0.25, -L / 2 + 0.05);
    for (const s of [-1, 1]) {
      parts.add('beaconA', box(0.2, 0.2, 0.1), s * (W / 2 - 0.3), H - 0.12, L / 2 - 0.5);
      parts.add('beaconB', box(0.2, 0.2, 0.1), s * (W / 2 - 0.3), H - 0.12, -L / 2 + 0.06);
      parts.add('sigL', box(0.14, 0.14, 0.1), s * (W / 2 - 0.6), H - 0.12, L / 2 - 0.5);
    }
    wheelW = 0.3;
    const wx = W / 2 - 0.2;
    wheelPos.push([-wx, R, L * 0.33, true, -1], [wx, R, L * 0.33, true, 1]);
    for (const dx of [0, 0.3]) wheelPos.push([-(wx - dx), R, -L * 0.2, false, -1], [wx - dx, R, -L * 0.2, false, 1]);
  } else {
    // streetcar
    loft = loftBody(STREETCAR, L, W, H);
    // doors on the right side: glass panels with frames
    for (const dz of [L * 0.3, L * 0.05, -L * 0.2, -L * 0.42]) {
      parts.add('trim', box(0.03, H * 0.62, 1.4), W / 2 + 0.005, H * 0.44, dz);
      parts.add('sideGlass', box(0.03, H * 0.4, 0.55), W / 2 + 0.015, H * 0.55, dz - 0.35);
      parts.add('sideGlass', box(0.03, H * 0.4, 0.55), W / 2 + 0.015, H * 0.55, dz + 0.35);
    }
    // articulation bellows, roof equipment, pantograph, route sign, lamps
    for (const dz of [L * 0.17, -L * 0.17]) {
      parts.add('trim', box(W + 0.04, H * 0.88, 0.5), 0, H * 0.5, dz);
    }
    parts.add('roofWhite', roundedBox(W * 0.9, 0.3, L * 0.9, 0.08, 0.03), 0, H + 0.12, 0);
    for (const dz of [L * 0.3, -L * 0.05, -L * 0.36]) parts.add('trim', roundedBox(W * 0.6, 0.3, 1.6, 0.06, 0.02), 0, H + 0.4, dz);
    parts.add('trim', box(0.06, 0.06, 2.4), 0, H + 0.9, L * 0.1, 0, 0, 0);
    parts.add('trim', box(0.06, 1.0, 0.06), 0.4, H + 0.55, L * 0.1 - 1.1, 0.35, 0, 0);
    parts.add('trim', box(0.06, 1.0, 0.06), -0.4, H + 0.55, L * 0.1 - 1.1, 0.35, 0, 0);
    parts.add('trim', box(1.6, 0.05, 0.1), 0, H + 1.02, L * 0.1);
    parts.add('routeSign', box(1.4, 0.3, 0.05), 0, H * 0.82, L / 2 - 0.3, 0.35, 0, 0);
    parts.add('routeSign', box(1.4, 0.3, 0.05), 0, H * 0.82, -L / 2 + 0.2, -0.3, 0, 0);
    for (const s of [-1, 1]) {
      parts.add('head', box(0.22, 0.14, 0.05), s * (W / 2 - 0.35), 0.9, L / 2 - 0.04);
      parts.add('lampGlass', lensGeo(0.24, 0.16, 0.04, 0), s * (W / 2 - 0.35), 0.9, L / 2 + 0.002);
      parts.add('tail', box(0.2, 0.14, 0.04), s * (W / 2 - 0.35), 0.9, -L / 2 - 0.005);
      parts.add(s < 0 ? 'sigL' : 'sigR', box(0.14, 0.12, 0.04), s * (W / 2 - 0.6), 1.05, L / 2 - 0.02);
      parts.add(s < 0 ? 'sigL' : 'sigR', box(0.14, 0.12, 0.04), s * (W / 2 - 0.6), 1.05, -L / 2 - 0.005);
    }
    parts.add('trim', box(W * 0.9, 0.5, 0.1), 0, 0.28, L / 2 - 0.03);
    // bogie skirts
    for (const dz of [L * 0.33, 0, -L * 0.33]) parts.add('trim', box(W * 0.9, 0.5, 2.2), 0, 0.3, dz);
    wheelW = 0.2;
    for (const dz of [L * 0.33, 0, -L * 0.33]) {
      for (const dd of [-0.9, 0.9]) wheelPos.push([-(W / 2 - 0.3), R, dz + dd, false, -1], [W / 2 - 0.3, R, dz + dd, false, 1]);
    }
  }

  const out: KindGeos = {
    hull: loft.geometry,
    liner: loft.liner,
    loft,
    parts: parts.merged(),
    wheelPos,
    wheelW,
    wheelR: R,
    hullZ,
    steeringWheel,
  };
  kindCache.set(kind, out);
  return out;
}

let plateSeq = 1;

/**
 * Build a vehicle mesh. The group faces +Z (forward) at rotation.y = 0,
 * sitting on y=0 (wheel contact).
 */
export function buildCar(kind: CarKind, color: number): BuiltCar {
  const dims = CAR_DIMS[kind];
  const kg = buildKind(kind);
  const root = new THREE.Group();
  const chassis = new THREE.Group();
  root.add(chassis);

  const livery = kind === 'police' ? liveryTexture('police') : kind === 'taxi' ? liveryTexture('taxi') : undefined;
  const paint = paintMat(kind === 'police' || kind === 'taxi' ? 0xffffff : color, livery);
  const paintPlain = paintMat(kind === 'police' ? 0xf4f6f8 : kind === 'taxi' ? 0xf5a623 : color);
  const lights: CarLightMats = {
    head: mkLightMat(0xfff4d6, 0xd8dde2),
    tail: mkLightMat(0xff2418, 0x7a1512, 0.92),
    signalL: mkLightMat(0xffa21c, 0x8a5a12, 0.92),
    signalR: mkLightMat(0xffa21c, 0x8a5a12, 0.92),
    reverse: mkLightMat(0xffffff, 0xdadfe4),
  };

  const hull = new THREE.Mesh(kg.hull, [paint, WINDSHIELD, SIDE_GLASS, TRIM]);
  hull.position.z = kg.hullZ;
  hull.castShadow = true;
  const liner = new THREE.Mesh(kg.liner, [LINER, LINER, LINER, LINER]);
  liner.position.z = kg.hullZ;
  liner.scale.set(0.985, 0.985, 0.995);
  liner.position.y = 0.01;
  chassis.add(hull, liner);

  const rng = mulberry32(plateSeq++ * 7919);
  const plate = randomPlate(rng);
  const plateM = new THREE.MeshStandardMaterial({ map: plateTexture(plate), roughness: 0.5, metalness: 0.1 });
  const materialFor: Record<string, THREE.Material> = {
    paintExtra: paintPlain,
    chrome: CHROME,
    trim: TRIM,
    interior: INTERIOR,
    head: lights.head,
    lampGlass: LAMP_GLASS,
    tail: lights.tail,
    sigL: lights.signalL,
    sigR: lights.signalR,
    rev: lights.reverse,
    plateF: plateM,
    plateR: plateM,
    sideGlass: SIDE_GLASS,
    module: bodyMat(0xf1f2f0, { rough: 0.5, metal: 0.2 }),
    stripe: bodyMat(0xd12a2a, { rough: 0.5, metal: 0.2 }),
    roofWhite: bodyMat(0xe9e9e6, { rough: 0.55, metal: 0.2 }),
    taxiSign: new THREE.MeshStandardMaterial({ map: labelTexture('TAXI', '#f8e29a', '#222'), emissive: 0xffe9a0, emissiveIntensity: 0.6, roughness: 0.5 }),
    stopSign: new THREE.MeshStandardMaterial({ color: 0xc41e1e, roughness: 0.5 }),
    busSign: new THREE.MeshStandardMaterial({ map: labelTexture('SCHOOL BUS', '#111', '#f2b705', 512, 96, '800 64px system-ui'), roughness: 0.6 }),
    routeSign: new THREE.MeshStandardMaterial({
      map: labelTexture('501 QUEEN', '#111', '#ffb000', 512, 96, '800 64px system-ui'),
      emissive: 0xffb000,
      emissiveIntensity: 0.7,
      roughness: 0.6,
    }),
  };
  if (kind === 'police' || kind === 'ambulance' || kind === 'firetruck') {
    lights.beaconA = mkLightMat(0xff2020, 0x5a1414);
    lights.beaconB = mkLightMat(0x2266ff, 0x14245a);
  } else if (kind === 'schoolbus') {
    lights.beaconA = mkLightMat(0xff2020, 0x5a1414);
    lights.beaconB = mkLightMat(0xff2020, 0x5a1414);
  }
  if (lights.beaconA) materialFor.beaconA = lights.beaconA;
  if (lights.beaconB) materialFor.beaconB = lights.beaconB;

  for (const [key, geo] of kg.parts) {
    const mat = materialFor[key];
    if (!mat) continue;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = !(mat as THREE.Material).transparent;
    chassis.add(m);
  }

  // --- wheels --------------------------------------------------------------
  const wheels: THREE.Object3D[] = [];
  const frontWheels: THREE.Object3D[] = [];
  const wg = wheelGeos(kg.wheelR, kg.wheelW, kind === 'streetcar' ? 0 : kind === 'truck' || kind === 'schoolbus' || kind === 'firetruck' ? 8 : 5);
  for (const [x, y, z, isFront, side] of kg.wheelPos) {
    const steerPivot = new THREE.Group();
    steerPivot.position.set(x, y, z);
    const w = new THREE.Group();
    const rubber = new THREE.Mesh(wg.rubber, TIRE);
    const rim = new THREE.Mesh(wg.rim, RIM);
    rubber.castShadow = true;
    w.add(rubber, rim);
    w.scale.x = side;
    steerPivot.add(w);
    root.add(steerPivot);
    wheels.push(w);
    if (isFront) frontWheels.push(steerPivot);
  }

  // --- steering wheel (passenger cars) ------------------------------------
  let steeringWheel: THREE.Object3D | undefined;
  if (kg.steeringWheel) {
    const s = kg.steeringWheel;
    const pivot = new THREE.Group();
    pivot.position.set(s.x, s.y, s.z);
    pivot.rotation.x = s.tilt;
    const rimT = new THREE.Mesh(new THREE.TorusGeometry(s.r, 0.018, 8, 28), INTERIOR);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 12), INTERIOR);
    hub.rotation.x = Math.PI / 2;
    pivot.add(rimT, hub);
    for (const a of [0, 2.1, -2.1]) {
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.03, s.r, 0.02), INTERIOR);
      sp.position.set(Math.sin(a) * s.r * 0.5, Math.cos(a) * s.r * 0.5, 0);
      sp.rotation.z = -a;
      pivot.add(sp);
    }
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.3, 8), INTERIOR);
    column.rotation.x = Math.PI / 2;
    column.position.z = 0.15;
    pivot.add(column);
    chassis.add(pivot);
    steeringWheel = pivot;
  }

  return { root, chassis, wheels, frontWheels, lights, dims, kind, steeringWheel };
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
    if (b.steeringWheel) b.steeringWheel.rotation.z = -steer * 2.4;

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
    l.head.emissiveIntensity = lightState.headlights ? 3.0 : 0;
    l.tail.emissiveIntensity = lightState.braking ? 4 : lightState.headlights ? 1.2 : 0;
    l.reverse.emissiveIntensity = lightState.reversing ? 2.5 : 0;
  }
}

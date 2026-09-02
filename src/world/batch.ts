/**
 * Geometry batching for static world dressing: collect transformed
 * geometries per material key and merge each key into a single mesh, so a
 * whole district of buildings, poles and furniture costs a few dozen draw
 * calls. Also provides metre-scaled box UVs so tiled surface textures keep
 * a constant real-world size across every building.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const V = new THREE.Vector3();
const S = new THREE.Vector3();

export class GeoBatch {
  private lists = new Map<string, THREE.BufferGeometry[]>();

  add(key: string, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0): void {
    const g = geo.clone();
    M.compose(V.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz)), S.set(sx, sy, sz));
    g.applyMatrix4(M);
    let arr = this.lists.get(key);
    if (!arr) {
      arr = [];
      this.lists.set(key, arr);
    }
    arr.push(g);
  }

  /** Add with an explicit matrix. */
  addM(key: string, geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const g = geo.clone();
    g.applyMatrix4(m);
    let arr = this.lists.get(key);
    if (!arr) {
      arr = [];
      this.lists.set(key, arr);
    }
    arr.push(g);
  }

  count(key: string): number {
    return this.lists.get(key)?.length ?? 0;
  }

  /** Merge every key into one geometry (no meshes), e.g. for instancing. */
  merged(): Map<string, THREE.BufferGeometry> {
    const out = new Map<string, THREE.BufferGeometry>();
    for (const [key, arr] of this.lists) {
      const m = mergeGeometries(arr.map(normalizeAttrs), false);
      if (m) out.set(key, m);
    }
    this.lists.clear();
    return out;
  }

  /** Merge every key into one mesh with the matching material. */
  build(materials: Map<string, THREE.Material>, group: THREE.Object3D, opts: { shadows?: boolean; receive?: boolean } = {}): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [key, arr] of this.lists) {
      const mat = materials.get(key);
      if (!mat) {
        console.warn(`GeoBatch: no material for key "${key}" (${arr.length} geometries)`);
        continue;
      }
      const merged = mergeGeometries(arr.map(normalizeAttrs), false);
      if (!merged) {
        console.error(`GeoBatch: merge failed for "${key}"`);
        continue;
      }
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = opts.shadows ?? true;
      mesh.receiveShadow = opts.receive ?? true;
      mesh.name = key;
      group.add(mesh);
      out.push(mesh);
    }
    this.lists.clear();
    return out;
  }
}

/** Non-indexed with exactly position/normal/uv so merges never fail. */
export function normalizeAttrs(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const gg = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(gg.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') gg.deleteAttribute(name);
  }
  if (!gg.getAttribute('normal')) gg.computeVertexNormals();
  if (!gg.getAttribute('uv')) {
    gg.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(gg.getAttribute('position').count * 2), 2));
  }
  return gg;
}

/**
 * Box whose UVs are in metres (1 UV unit = 1 m) per face, so a facade
 * texture tiles at true scale regardless of the box size. `v0` offsets the
 * vertical UV origin (stack boxes so floors line up).
 */
export function metreBox(w: number, h: number, d: number, v0 = 0, u0 = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const nx = n.getX(i);
    const ny = n.getY(i);
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (Math.abs(ny) > 0.5) uv.setXY(i, u * w, v * d);
    else if (Math.abs(nx) > 0.5) uv.setXY(i, u * d + u0, v * h + v0);
    else uv.setXY(i, u * w + u0, v * h + v0);
  }
  return g;
}

/** Only the four vertical faces of a box (metre UVs), for facades. */
export function wallBox(w: number, h: number, d: number, v0 = 0): THREE.BufferGeometry {
  const g = metreBox(w, h, d, v0);
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z with 6 vertices (2 tris) each after toNonIndexed
  const ng = g.toNonIndexed();
  const pos = ng.getAttribute('position') as THREE.BufferAttribute;
  const nor = ng.getAttribute('normal') as THREE.BufferAttribute;
  const uv = ng.getAttribute('uv') as THREE.BufferAttribute;
  const keepP: number[] = [];
  const keepN: number[] = [];
  const keepU: number[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    if (Math.abs(nor.getY(i)) > 0.5) continue;
    for (let k = 0; k < 3; k++) {
      keepP.push(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
      keepN.push(nor.getX(i + k), nor.getY(i + k), nor.getZ(i + k));
      keepU.push(uv.getX(i + k), uv.getY(i + k));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(keepP, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(keepN, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(keepU, 2));
  return out;
}

/** Horizontal quad (metre UVs) at y=0 facing up, centred. */
export function slab(w: number, d: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * d);
  return g;
}

/**
 * Gable roof prism: ridge along z, width w (x), length d (z), rise h.
 * Includes the two sloped faces (metre UVs) and the two gable triangles.
 */
export function gableRoof(w: number, d: number, h: number, overhangX = 0.35, overhangZ = 0.35): { slopes: THREE.BufferGeometry; gables: THREE.BufferGeometry } {
  const hw = w / 2 + overhangX;
  const hd = d / 2 + overhangZ;
  const slopeLen = Math.hypot(hw, h);
  const p: number[] = [];
  const u: number[] = [];
  const quad = (a: number[], b: number[], c: number[], dd: number[], ua: number[], ub: number[], uc: number[], ud: number[]): void => {
    p.push(...a, ...b, ...c, ...a, ...c, ...dd);
    u.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ud);
  };
  // right slope (+x side), facing +x/+y
  quad([0, h, -hd], [0, h, hd], [hw, 0, hd], [hw, 0, -hd], [0, 0], [d + 2 * overhangZ, 0], [d + 2 * overhangZ, slopeLen], [0, slopeLen]);
  // left slope
  quad([0, h, hd], [0, h, -hd], [-hw, 0, -hd], [-hw, 0, hd], [0, 0], [d + 2 * overhangZ, 0], [d + 2 * overhangZ, slopeLen], [0, slopeLen]);
  const slopes = new THREE.BufferGeometry();
  slopes.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  slopes.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
  slopes.computeVertexNormals();
  // gable triangles (at ±d/2, no overhang), facing outward
  const gp: number[] = [];
  const gu: number[] = [];
  const tri = (a: number[], b: number[], c: number[]): void => {
    gp.push(...a, ...b, ...c);
    gu.push(a[0] + w / 2, a[1], b[0] + w / 2, b[1], c[0] + w / 2, c[1]);
  };
  tri([-w / 2, 0, d / 2], [w / 2, 0, d / 2], [0, h, d / 2]);
  tri([w / 2, 0, -d / 2], [-w / 2, 0, -d / 2], [0, h, -d / 2]);
  const gables = new THREE.BufferGeometry();
  gables.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
  gables.setAttribute('uv', new THREE.Float32BufferAttribute(gu, 2));
  gables.computeVertexNormals();
  return { slopes, gables };
}

/**
 * Sloped roof plane for bays and porches: width w along x, high edge (y=h)
 * at z=0 against the wall, low edge (y=0) at z=run. Faces up.
 */
export function shedRoof(w: number, run: number, h: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const p = [-w / 2, h, 0, w / 2, h, 0, w / 2, 0, run, -w / 2, h, 0, w / 2, 0, run, -w / 2, 0, run];
  const L = Math.hypot(run, h);
  const u = [0, 0, w, 0, w, L, 0, 0, w, L, 0, L];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
  g.computeVertexNormals();
  return g;
}

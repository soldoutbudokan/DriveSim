/**
 * Street furniture and civic landmarks: cobra-head streetlights on tapered
 * poles (with night light pools), wooden hydro poles with crossarms,
 * transformers and sagging wires, streetcar overhead catenary, hydrants,
 * Canada Post boxes, benches, bins, transit shelters, W-beam guardrails,
 * overhead sign gantries and high-mast highway lighting, the roundabout
 * island, construction props (barrels, jersey barriers, an excavator), the
 * lake with rippled water and a boardwalk, and a CN-Tower-style landmark
 * with a distant skyline.
 */

import * as THREE from 'three';
import { mulberry32, type V2 } from '../core/math';
import type { CollisionWorld } from '../physics/collision';
import { GeoBatch, metreBox, slab } from './batch';
import { canvas, concreteSet, facadeSet, surfaceMaterial, tex, waterNormal } from './materials';
import { signTexture, type SignKind } from './textures';

const mats = new Map<string, THREE.Material>();
const nightMats: THREE.MeshStandardMaterial[] = [];

function plain(key: string, color: number, rough = 0.6, metal = 0.5): THREE.MeshStandardMaterial {
  let m = mats.get(key) as THREE.MeshStandardMaterial | undefined;
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    mats.set(key, m);
  }
  return m;
}

function ensureMats(): void {
  if (mats.has('poleGrey')) return;
  plain('poleGrey', 0x8e949a, 0.45, 0.7);
  plain('poleDark', 0x3b3f45, 0.6, 0.6);
  plain('wood', 0x6b5236, 0.9, 0);
  plain('hydrant', 0xd6281c, 0.5, 0.2);
  plain('postbox', 0xd1231f, 0.45, 0.3);
  plain('benchWood', 0x7a5a3a, 0.85, 0);
  plain('benchIron', 0x2a2d31, 0.6, 0.5);
  plain('bin', 0x4a4f55, 0.7, 0.4);
  plain('galv', 0xb4bcc4, 0.35, 0.85);
  plain('concrete', 0xb9b6ae, 0.9, 0);
  plain('orange', 0xf26a1b, 0.6, 0.05);
  plain('white', 0xf2f2ee, 0.6, 0.05);
  plain('yellowMachine', 0xe8a020, 0.55, 0.2);
  plain('track', 0x2a2a2a, 0.9, 0.1);
  plain('boardwalk', 0x8a6a48, 0.9, 0);
  plain('insulator', 0x7f8a94, 0.5, 0.3);
  plain('shelterFrame', 0x2f3338, 0.5, 0.6);
  mats.set('shelterGlass', new THREE.MeshPhysicalMaterial({ color: 0xaac4d4, transparent: true, opacity: 0.32, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false }));
  const lamp = new THREE.MeshStandardMaterial({ color: 0xf4f0e4, emissive: new THREE.Color(0xffe6b0), emissiveIntensity: 0, roughness: 0.4 });
  lamp.userData.night = 3.2;
  nightMats.push(lamp);
  mats.set('lampLens', lamp);
  const ad = new THREE.MeshStandardMaterial({ map: adTexture(), emissive: new THREE.Color(0xffffff), emissiveMap: adTexture(), emissiveIntensity: 0, roughness: 0.5 });
  ad.userData.night = 0.7;
  nightMats.push(ad);
  mats.set('ad', ad);
  mats.set('sidewalk', surfaceMaterial(concreteSet(), { color: 0xc9c6bf }));
}

let adTex: THREE.CanvasTexture | null = null;
function adTexture(): THREE.CanvasTexture {
  if (adTex) return adTex;
  const [c, g] = canvas(256, 384);
  g.fillStyle = '#1b4f8a';
  g.fillRect(0, 0, 256, 384);
  g.fillStyle = '#f5f7fa';
  g.fillRect(16, 16, 224, 352);
  g.fillStyle = '#1b4f8a';
  g.font = '800 34px system-ui';
  g.textAlign = 'center';
  g.fillText('DriveTest', 128, 90);
  g.font = '600 22px system-ui';
  g.fillText('Book your', 128, 180);
  g.fillText('road test', 128, 210);
  g.fillStyle = '#d6281c';
  g.fillRect(48, 250, 160, 60);
  g.fillStyle = '#fff';
  g.font = '700 26px system-ui';
  g.fillText('ontario.ca', 128, 288);
  adTex = tex(c, { repeat: false });
  return adTex;
}

/* ------------------------------------------------------------------ */
/* light pools (additive discs under streetlights at night)            */
/* ------------------------------------------------------------------ */

let poolTex: THREE.CanvasTexture | null = null;
function lightPoolTexture(): THREE.CanvasTexture {
  if (poolTex) return poolTex;
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,225,170,0.85)');
  grad.addColorStop(0.5, 'rgba(255,215,150,0.3)');
  grad.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  poolTex = tex(c, { repeat: false });
  return poolTex;
}

export interface FurnitureResult {
  group: THREE.Group;
  nightMats: THREE.MeshStandardMaterial[];
  poolMat: THREE.MeshBasicMaterial | null;
}

export class Furniture {
  readonly batch = new GeoBatch();
  readonly group = new THREE.Group();
  readonly lines: THREE.Vector3[] = [];
  readonly pools: Array<{ x: number; y: number; z: number; r: number }> = [];
  constructor(private collision: CollisionWorld, private rng: () => number) {
    ensureMats();
    this.group.name = 'furniture';
  }

  /* ---------------- lighting ---------------- */

  streetlight(x: number, z: number, heading: number, y = 0, tall = false): void {
    const b = this.batch;
    const H = tall ? 12 : 9;
    const arm = tall ? 3.2 : 2.4;
    b.add('concrete', new THREE.CylinderGeometry(0.28, 0.32, 0.5, 10), x, y + 0.25, z);
    b.add('poleGrey', new THREE.CylinderGeometry(0.07, 0.12, H, 10), x, y + H / 2, z);
    // curved arm: quadratic tube from the pole top out over the road
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, H - 0.3, 0), new THREE.Vector3(0, H + 0.9, arm * 0.55), new THREE.Vector3(0, H + 0.7, arm));
    const tube = new THREE.TubeGeometry(curve, 8, 0.045, 6, false);
    b.add('poleGrey', tube, x, y, z, heading);
    // cobra head
    const hx = x + Math.sin(heading) * arm;
    const hz = z + Math.cos(heading) * arm;
    b.add('poleDark', new THREE.BoxGeometry(0.34, 0.16, 0.8), hx, y + H + 0.68, hz, heading, 1, 1, 1, 0, 0);
    b.add('lampLens', new THREE.BoxGeometry(0.26, 0.05, 0.5), hx, y + H + 0.58, hz, heading);
    this.pools.push({ x: hx, y: y + 0.03, z: hz, r: tall ? 12 : 9 });
  }

  highMast(x: number, z: number): void {
    const b = this.batch;
    const H = 26;
    b.add('concrete', new THREE.CylinderGeometry(0.6, 0.7, 0.8, 12), x, 0.4, z);
    b.add('poleGrey', new THREE.CylinderGeometry(0.12, 0.3, H, 10), x, H / 2, z);
    b.add('poleDark', new THREE.TorusGeometry(1.1, 0.05, 6, 16), x, H - 0.5, z, 0, 1, 1, 1, Math.PI / 2);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.add('lampLens', new THREE.BoxGeometry(0.5, 0.2, 0.5), x + Math.cos(a) * 1.1, H - 0.7, z + Math.sin(a) * 1.1, -a);
    }
    this.pools.push({ x, y: 0.03, z, r: 30 });
  }

  /* ---------------- hydro poles + wires ---------------- */

  hydroPole(x: number, z: number, heading: number, transformer: boolean, y = 0): THREE.Vector3[] {
    const b = this.batch;
    const H = 10.5;
    b.add('wood', new THREE.CylinderGeometry(0.13, 0.17, H, 8), x, y + H / 2, z);
    const armY = y + H - 0.6;
    b.add('wood', new THREE.BoxGeometry(2.0, 0.1, 0.1), x, armY, z, heading);
    const pts: THREE.Vector3[] = [];
    for (const dx of [-0.85, 0, 0.85]) {
      const px = x + Math.cos(heading) * dx;
      const pz = z - Math.sin(heading) * dx;
      b.add('insulator', new THREE.CylinderGeometry(0.05, 0.06, 0.18, 6), px, armY + 0.14, pz);
      pts.push(new THREE.Vector3(px, armY + 0.22, pz));
    }
    // lower communication cable point
    pts.push(new THREE.Vector3(x + Math.cos(heading) * 0.15, y + H - 2.4, z - Math.sin(heading) * 0.15));
    if (transformer) {
      b.add('poleDark', new THREE.CylinderGeometry(0.32, 0.32, 0.9, 10), x + Math.cos(heading) * 0.42, y + H - 1.7, z - Math.sin(heading) * 0.42);
    }
    this.collision.addCircle({ x, z, r: 0.22, tag: 'pole' });
    return pts;
  }

  /** Sagging wires between matching attachment points of two poles. */
  wires(a: THREE.Vector3[], b: THREE.Vector3[], sag = 0.6): void {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const segs = 8;
      let prev = a[i];
      for (let k = 1; k <= segs; k++) {
        const t = k / segs;
        const p = new THREE.Vector3().lerpVectors(a[i], b[i], t);
        p.y -= sag * 4 * t * (1 - t);
        this.lines.push(prev, p);
        prev = p;
      }
    }
  }

  /* ---------------- small furniture ---------------- */

  hydrant(x: number, z: number, y = 0): void {
    const b = this.batch;
    b.add('hydrant', new THREE.CylinderGeometry(0.14, 0.16, 0.62, 10), x, y + 0.31, z);
    b.add('hydrant', new THREE.SphereGeometry(0.15, 10, 8), x, y + 0.66, z);
    b.add('hydrant', new THREE.CylinderGeometry(0.06, 0.06, 0.12, 8), x, y + 0.86, z);
    b.add('hydrant', new THREE.CylinderGeometry(0.06, 0.06, 0.16, 8), x + 0.18, y + 0.45, z, 0, 1, 1, 1, 0, Math.PI / 2);
    b.add('hydrant', new THREE.CylinderGeometry(0.06, 0.06, 0.16, 8), x - 0.18, y + 0.45, z, 0, 1, 1, 1, 0, Math.PI / 2);
    b.add('hydrant', new THREE.CylinderGeometry(0.08, 0.08, 0.16, 8), x, y + 0.42, z + 0.18, 0, 1, 1, 1, Math.PI / 2);
    this.collision.addCircle({ x, z, r: 0.2, tag: 'hydrant' });
  }

  postbox(x: number, z: number, heading: number, y = 0): void {
    const b = this.batch;
    b.add('postbox', new THREE.BoxGeometry(0.62, 1.0, 0.5), x, y + 0.6, z, heading);
    b.add('postbox', new THREE.CylinderGeometry(0.25, 0.25, 0.62, 12), x, y + 1.1, z, heading, 1, 1, 1, 0, Math.PI / 2);
    b.add('poleDark', new THREE.BoxGeometry(0.36, 0.04, 0.1), x + Math.sin(heading) * 0.24, y + 1.0, z + Math.cos(heading) * 0.24, heading);
    b.add('poleDark', new THREE.BoxGeometry(0.5, 0.1, 0.4), x, y + 0.05, z, heading);
    this.collision.addCircle({ x, z, r: 0.35, tag: 'postbox' });
  }

  bench(x: number, z: number, heading: number, y = 0): void {
    const b = this.batch;
    for (let i = 0; i < 4; i++) {
      const dz = -0.18 + i * 0.12;
      b.add('benchWood', new THREE.BoxGeometry(1.8, 0.04, 0.09), x + Math.cos(heading) * 0 - Math.sin(heading) * dz, y + 0.45, z - Math.cos(heading) * dz, heading);
      b.add('benchWood', new THREE.BoxGeometry(1.8, 0.09, 0.04), x - Math.sin(heading) * -0.24, y + 0.62 + i * 0.1, z - Math.cos(heading) * -0.24, heading);
    }
    for (const dx of [-0.8, 0.8]) {
      const px = x + Math.cos(heading) * dx;
      const pz = z - Math.sin(heading) * dx;
      b.add('benchIron', new THREE.BoxGeometry(0.06, 0.45, 0.5), px, y + 0.22, pz, heading);
      b.add('benchIron', new THREE.BoxGeometry(0.06, 0.5, 0.06), px - Math.sin(heading) * -0.24, y + 0.7, pz - Math.cos(heading) * -0.24, heading);
    }
  }

  bin(x: number, z: number, y = 0): void {
    const b = this.batch;
    b.add('bin', new THREE.CylinderGeometry(0.3, 0.26, 0.95, 12), x, y + 0.48, z);
    b.add('poleDark', new THREE.CylinderGeometry(0.32, 0.32, 0.12, 12), x, y + 1.0, z);
    b.add('poleDark', new THREE.SphereGeometry(0.3, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), x, y + 1.02, z);
  }

  shelter(x: number, z: number, heading: number, y = 0): void {
    const b = this.batch;
    const W = 4.0;
    const D = 1.6;
    const H = 2.5;
    const R = (dx: number, dz: number): [number, number] => [x + Math.cos(heading) * dx + Math.sin(heading) * dz, z - Math.sin(heading) * dx + Math.cos(heading) * dz];
    for (const [dx, dz] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) {
      const [px, pz] = R(dx, dz);
      b.add('shelterFrame', new THREE.BoxGeometry(0.08, H, 0.08), px, y + H / 2, pz, heading);
    }
    b.add('shelterFrame', new THREE.BoxGeometry(W + 0.3, 0.12, D + 0.3), x, y + H + 0.06, z, heading);
    b.add('shelterGlass', new THREE.BoxGeometry(W - 0.2, H - 0.2, 0.02), ...R(0, -D / 2), heading);
    b.add('shelterGlass', new THREE.BoxGeometry(0.02, H - 0.2, D - 0.2), ...R(-W / 2, 0), heading);
    b.add('ad', new THREE.BoxGeometry(0.06, 1.8, 1.2), ...R(W / 2, 0), heading);
    this.bench(...R(0, -D / 2 + 0.35), heading, y);
    this.collision.addOBB({ x, z, heading, halfW: W / 2, halfL: D / 2, tag: 'shelter' });
  }

  /* ---------------- roads-side structures ---------------- */

  /** W-beam guardrail along a polyline at a lateral offset over [s0, s1]: posts + one continuous beam strip. */
  guardrail(poly: V2[], offset: number, s0: number, s1: number, elev: (s: number) => number, sampleAt: (s: number) => { point: V2; dir: V2 }): void {
    const b = this.batch;
    const pts: Array<{ x: number; y: number; z: number; nx: number; nz: number }> = [];
    for (let s = s0; s <= s1; s += 3.0) {
      const smp = sampleAt(s);
      const px = smp.point.x + smp.dir.z * offset;
      const pz = smp.point.z - smp.dir.x * offset;
      const py = elev(s);
      pts.push({ x: px, y: py, z: pz, nx: smp.dir.z, nz: -smp.dir.x });
      b.add('poleDark', new THREE.BoxGeometry(0.15, 0.75, 0.1), px, py + 0.38, pz, Math.atan2(smp.dir.x, smp.dir.z));
    }
    if (pts.length < 2) return;
    // beam: two facing strips (front + back) 0.31 m tall, offset 0.06 m toward the road
    for (const face of [1, -1]) {
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      pts.forEach((p, i) => {
        const ox = p.nx * 0.03 * face * Math.sign(offset);
        const oz = p.nz * 0.03 * face * Math.sign(offset);
        pos.push(p.x + ox, p.y + 0.56, p.z + oz, p.x + ox, p.y + 0.87, p.z + oz);
        uv.push(i * 3, 0, i * 3, 0.31);
        if (i > 0) {
          const a = (i - 1) * 2;
          if (face > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      b.addM('galv', g, new THREE.Matrix4());
    }
  }

  /** Overhead sign gantry across a road. */
  gantry(x: number, z: number, heading: number, span: number, signs: Array<{ kind: SignKind; text: string; at: number; w: number }>, y = 0): void {
    const b = this.batch;
    const H = 7.5;
    const L = (dx: number): [number, number] => [x + Math.cos(heading) * dx, z - Math.sin(heading) * dx];
    for (const dx of [-span / 2, span / 2]) {
      const [px, pz] = L(dx);
      b.add('concrete', new THREE.BoxGeometry(1.2, 1.0, 1.2), px, y + 0.5, pz, heading);
      b.add('galv', new THREE.CylinderGeometry(0.22, 0.28, H, 10), px, y + H / 2, pz);
    }
    b.add('galv', new THREE.BoxGeometry(span + 0.6, 0.9, 0.9), x, y + H + 0.3, z, heading);
    for (let i = 0; i < Math.floor(span / 1.5); i++) {
      const [px, pz] = L(-span / 2 + 0.75 + i * 1.5);
      b.add('galv', new THREE.BoxGeometry(0.08, 0.9, 0.08), px, y + H + 0.3, pz, heading, 1, 1, 1, 0, 0.6);
    }
    for (const s of signs) {
      const [px, pz] = L(s.at);
      const t = signTexture(s.kind, s.text);
      const aspect = (t.image as HTMLCanvasElement).height / (t.image as HTMLCanvasElement).width;
      const mat = new THREE.MeshStandardMaterial({ map: t, roughness: 0.5 });
      const face = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.w * aspect), mat);
      face.position.set(px, y + H - (s.w * aspect) / 2 + 0.2, pz);
      face.rotation.y = heading + Math.PI;
      this.group.add(face);
      b.add('poleDark', new THREE.BoxGeometry(s.w, s.w * aspect, 0.06), px, y + H - (s.w * aspect) / 2 + 0.2, pz, heading);
    }
  }

  /** Sign on a square post with a dark backing plate. */
  signPost(x: number, z: number, y: number, faceHeading: number, kind: SignKind, text = '', scale = 0.62, postH = 2.4): void {
    const b = this.batch;
    b.add('galv', new THREE.BoxGeometry(0.06, postH, 0.06), x, y + postH / 2, z);
    const t = signTexture(kind, text);
    const aspect = (t.image as HTMLCanvasElement).height / (t.image as HTMLCanvasElement).width;
    const fh = scale * aspect;
    const fy = y + postH - fh / 2 + 0.1;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(scale, fh), new THREE.MeshStandardMaterial({ map: t, roughness: 0.45, metalness: 0.1 }));
    face.position.set(x + Math.sin(faceHeading) * 0.035, fy, z + Math.cos(faceHeading) * 0.035);
    face.rotation.y = faceHeading;
    this.group.add(face);
    b.add('poleDark', new THREE.BoxGeometry(scale, fh, 0.04), x, fy, z, faceHeading);
  }

  roundaboutIsland(cx: number, cz: number, r: number): TreeSpotLike[] {
    const b = this.batch;
    // truck apron (darker concrete ring) + raised curb + landscaped mound
    b.add('concrete', new THREE.RingGeometry(r - 3.2, r - 0.2, 40), cx, 0.06, cz, 0, 1, 1, 1, -Math.PI / 2);
    b.add('concrete', new THREE.CylinderGeometry(r - 3.2, r - 3.2, 0.3, 40), cx, 0.15, cz);
    b.add('boardwalk', new THREE.CylinderGeometry(r - 3.4, r - 3.6, 0.2, 40), cx, 0.4, cz); // mulch bed (brown)
    b.add('poleGrey', new THREE.CylinderGeometry(0.05, 0.05, 4.5, 8), cx, 2.5, cz);
    b.add('concrete', new THREE.BoxGeometry(2.4, 0.5, 0.3), cx, 0.75, cz + r - 5.2);
    this.collision.addCircle({ x: cx, z: cz, r: r - 3.2, tag: 'island' });
    const spots: TreeSpotLike[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      spots.push({ x: cx + Math.cos(a) * (r - 6.5), z: cz + Math.sin(a) * (r - 6.5), scale: 0.6 });
    }
    return spots;
  }

  /* ---------------- construction ---------------- */

  barrel(x: number, z: number, y = 0): void {
    const b = this.batch;
    b.add('orange', new THREE.CylinderGeometry(0.28, 0.25, 0.95, 12), x, y + 0.48, z);
    for (const yy of [0.25, 0.55, 0.85]) b.add('white', new THREE.CylinderGeometry(0.285, 0.285, 0.1, 12), x, y + yy, z);
    b.add('poleDark', new THREE.CylinderGeometry(0.4, 0.4, 0.06, 12), x, y + 0.03, z);
    this.collision.addCircle({ x, z, r: 0.3, tag: 'knockable' });
  }

  jerseyBarrier(x: number, z: number, heading: number, len = 3.0, y = 0): void {
    const shape = new THREE.Shape();
    shape.moveTo(-0.3, 0);
    shape.lineTo(0.3, 0);
    shape.lineTo(0.3, 0.1);
    shape.lineTo(0.12, 0.35);
    shape.lineTo(0.08, 0.8);
    shape.lineTo(-0.08, 0.8);
    shape.lineTo(-0.12, 0.35);
    shape.lineTo(-0.3, 0.1);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
    g.translate(0, 0, -len / 2);
    this.batch.add('concrete', g, x, y, z, heading);
    this.collision.addOBB({ x, z, heading, halfW: 0.3, halfL: len / 2, tag: 'construction' });
  }

  excavator(x: number, z: number, heading: number, y = 0): void {
    const b = this.batch;
    const R = (dx: number, dz: number): [number, number] => [x + Math.cos(heading) * dx + Math.sin(heading) * dz, z - Math.sin(heading) * dx + Math.cos(heading) * dz];
    for (const dx of [-1.2, 1.2]) b.add('track', new THREE.BoxGeometry(0.6, 0.9, 3.8), ...R(dx, 0), heading);
    b.add('yellowMachine', new THREE.BoxGeometry(2.6, 0.5, 3.2), x, y + 1.15, z, heading);
    b.add('yellowMachine', new THREE.BoxGeometry(2.4, 1.3, 2.2), ...R(0, -0.6), heading);
    b.add('shelterFrame', new THREE.BoxGeometry(1.1, 1.4, 1.2), ...R(-0.6, 0.6), heading);
    b.add('shelterGlass', new THREE.BoxGeometry(1.0, 1.1, 0.04), ...R(-0.6, 1.2), heading);
    // boom + stick + bucket
    b.add('yellowMachine', new THREE.BoxGeometry(0.5, 0.6, 3.6), ...R(0.5, 2.4), heading, 1, 1, 1, -0.6);
    b.add('yellowMachine', new THREE.BoxGeometry(0.4, 0.5, 2.6), ...R(0.5, 4.4), heading, 1, 1, 1, 0.9);
    b.add('poleDark', new THREE.BoxGeometry(1.0, 0.7, 0.8), ...R(0.5, 5.0), heading);
    this.collision.addOBB({ x, z, heading, halfW: 1.7, halfL: 2.6, tag: 'construction' });
  }

  /* ---------------- water + landmark ---------------- */

  lake(group: THREE.Group): void {
    const water = new THREE.MeshPhysicalMaterial({
      color: 0x2c5a80,
      roughness: 0.08,
      metalness: 0.15,
      envMapIntensity: 1.4,
      normalMap: waterNormal(),
      normalScale: new THREE.Vector2(0.35, 0.35),
    });
    water.normalMap!.repeat.set(220, 50);
    const lake = new THREE.Mesh(new THREE.PlaneGeometry(2600, 600), water);
    lake.rotation.x = -Math.PI / 2;
    lake.position.set(0, 0.02, 980);
    group.add(lake);
    // sand/rock shore + boardwalk with rails
    const shore = new THREE.Mesh(new THREE.PlaneGeometry(2600, 26), new THREE.MeshStandardMaterial({ color: 0xb9a77c, roughness: 1 }));
    shore.rotation.x = -Math.PI / 2;
    shore.position.set(0, 0.0, 692);
    group.add(shore);
    const b = this.batch;
    b.add('boardwalk', slab(2600, 5), 0, 0.35, 676);
    for (let x = -1290; x <= 1290; x += 4) {
      b.add('boardwalk', new THREE.BoxGeometry(0.12, 0.45, 0.12), x, 0.35, 676);
      b.add('poleDark', new THREE.BoxGeometry(0.12, 1.0, 0.12), x, 0.85, 678.4);
    }
    b.add('poleDark', new THREE.BoxGeometry(2600, 0.06, 0.06), 0, 1.35, 678.4);
  }

  cnTower(group: THREE.Group): void {
    const b = this.batch;
    const x = 220;
    const z = 800;
    // tripod base fins + main shaft
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const fin = new THREE.BoxGeometry(6, 200, 14);
      fin.translate(0, 100, 10);
      b.add('concrete', fin, x, 0, z, a);
    }
    b.add('concrete', new THREE.CylinderGeometry(6, 11, 330, 12), x, 165, z);
    // main pod: rings + observation deck
    b.add('poleDark', new THREE.CylinderGeometry(22, 18, 8, 14), x, 330, z);
    b.add('concrete', new THREE.CylinderGeometry(20, 22, 6, 14), x, 337, z);
    b.add('poleGrey', new THREE.CylinderGeometry(18, 20, 5, 14), x, 342, z);
    b.add('concrete', new THREE.CylinderGeometry(14, 18, 6, 14), x, 347, z);
    // skypod + antenna
    b.add('concrete', new THREE.CylinderGeometry(8, 8, 7, 12), x, 445, z);
    b.add('concrete', new THREE.CylinderGeometry(5, 5.5, 105, 10), x, 400, z);
    b.add('poleGrey', new THREE.CylinderGeometry(0.6, 2.2, 100, 8), x, 500, z);
    group.add(this.group);
  }

  /** Distant downtown skyline behind the lake shore for depth. */
  skyline(group: THREE.Group, rng: () => number): void {
    const mat = surfaceMaterial(facadeSet({ seed: 900, style: 'glass', wall: [90, 96, 108], floorH: 3.4, bayW: 3.4, lit: 0.5 }));
    (mat as THREE.MeshStandardMaterial).emissiveIntensity = 0;
    (mat as THREE.MeshStandardMaterial).userData.night = 0.9;
    nightMats.push(mat as THREE.MeshStandardMaterial);
    for (let i = 0; i < 26; i++) {
      const w = 22 + rng() * 30;
      const d = 22 + rng() * 30;
      const h = 60 + rng() * 190;
      const x = -600 + rng() * 1000;
      const z = 720 + rng() * 60;
      if (Math.abs(x - 220) < 60) continue;
      const g = metreBox(w, h, d);
      const m = new THREE.Mesh(g, mat);
      m.position.set(x, h / 2, z);
      group.add(m);
    }
  }

  /* ---------------- finish ---------------- */

  finish(parent: THREE.Group): FurnitureResult {
    this.batch.build(mats, this.group);
    if (this.lines.length) {
      const geo = new THREE.BufferGeometry().setFromPoints(this.lines);
      const wires = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x1c1c20 }));
      wires.frustumCulled = false;
      this.group.add(wires);
    }
    let poolMat: THREE.MeshBasicMaterial | null = null;
    if (this.pools.length) {
      poolMat = new THREE.MeshBasicMaterial({ map: lightPoolTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.rotateX(-Math.PI / 2);
      const inst = new THREE.InstancedMesh(geo, poolMat, this.pools.length);
      const m4 = new THREE.Matrix4();
      this.pools.forEach((p, i) => {
        m4.makeScale(p.r * 2, 1, p.r * 2).setPosition(p.x, p.y, p.z);
        inst.setMatrixAt(i, m4);
      });
      inst.renderOrder = 5;
      this.group.add(inst);
    }
    parent.add(this.group);
    return { group: this.group, nightMats, poolMat };
  }
}

export interface TreeSpotLike {
  x: number;
  z: number;
  scale?: number;
}

export function furnitureNight(res: FurnitureResult, f: number): void {
  for (const m of res.nightMats) m.emissiveIntensity = f * (m.userData.night ?? 1);
  if (res.poolMat) res.poolMat.opacity = f * 0.55;
}

export { mulberry32 };

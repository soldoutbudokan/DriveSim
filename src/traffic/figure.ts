/**
 * Articulated human figure shared by pedestrians and cyclists: torso, head
 * with hair or a hat, upper/lower arms and legs pivoting at shoulders and
 * hips, optional backpack. A walk cycle swings the limbs; a pedal cycle
 * drives the legs from a crank angle.
 */

import * as THREE from 'three';

const SKIN = [0xc9a188, 0x8a6248, 0x6e4a34, 0xd8b49a, 0xa87a5c, 0xf0cdb0];
const SHIRT = [0x5a7d9a, 0x9a5a5a, 0x6a8a5a, 0x8a7a9a, 0xd0c8b8, 0x44505e, 0xb86a3a, 0x2e2e34, 0xe9e2d3, 0x3f6b9c];
const PANTS = [0x2e3540, 0x3a3a44, 0x5c4a3a, 0x24344a, 0x6b6b70, 0x1e1e22];
const HAIR = [0x2b1d14, 0x0f0e0e, 0x6b4a2a, 0xb08a4a, 0x8a8a8a];

const matCache = new Map<number, THREE.MeshStandardMaterial>();
function mat(color: number, rough = 0.9): THREE.MeshStandardMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough });
    matCache.set(color, m);
  }
  return m;
}

export interface Figure {
  root: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  torso: THREE.Group;
  /** Advance the walk cycle (phase in radians) — swings limbs and bobs. */
  walk(phase: number, amount: number): void;
  /** Pose legs for pedalling from a crank angle. */
  pedal(crank: number): void;
}

const capsuleCache = new Map<string, THREE.CapsuleGeometry>();
function capsule(r: number, len: number): THREE.CapsuleGeometry {
  const k = `${r}|${len}`;
  let g = capsuleCache.get(k);
  if (!g) {
    g = new THREE.CapsuleGeometry(r, len, 3, 8);
    capsuleCache.set(k, g);
  }
  return g;
}

/** Build a ~1.7 m figure facing +z, feet at y=0. `rng` picks clothing. */
export function buildFigure(rng: () => number, scale = 1): Figure {
  const root = new THREE.Group();
  const skin = mat(SKIN[Math.floor(rng() * SKIN.length)]);
  const shirt = mat(SHIRT[Math.floor(rng() * SHIRT.length)]);
  const pants = mat(PANTS[Math.floor(rng() * PANTS.length)]);
  const hair = mat(HAIR[Math.floor(rng() * HAIR.length)]);
  const hipY = 0.86 * scale;
  const shoulderY = 1.42 * scale;

  const torso = new THREE.Group();
  torso.position.y = hipY;
  const body = new THREE.Mesh(capsule(0.16 * scale, 0.42 * scale), shirt);
  body.position.y = 0.32 * scale;
  body.castShadow = true;
  torso.add(body);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05 * scale, 0.06 * scale, 0.08 * scale, 8), skin);
  neck.position.y = 0.62 * scale;
  torso.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11 * scale, 12, 10), skin);
  head.position.y = 0.76 * scale;
  head.castShadow = true;
  torso.add(head);
  // hair cap or hat
  const style = rng();
  if (style < 0.6) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.115 * scale, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
    cap.position.y = 0.775 * scale;
    torso.add(cap);
  } else if (style < 0.8) {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.15 * scale, 0.15 * scale, 0.02 * scale, 12), mat(0x2a2a2e));
    brim.position.y = 0.8 * scale;
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * scale, 0.11 * scale, 0.1 * scale, 12), mat(0x2a2a2e));
    crown.position.y = 0.86 * scale;
    torso.add(brim, crown);
  } else {
    const beanie = new THREE.Mesh(new THREE.SphereGeometry(0.12 * scale, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), mat(SHIRT[Math.floor(rng() * SHIRT.length)]));
    beanie.position.y = 0.78 * scale;
    torso.add(beanie);
  }
  if (rng() < 0.35) {
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.26 * scale, 0.34 * scale, 0.14 * scale), mat(SHIRT[Math.floor(rng() * SHIRT.length)], 0.8));
    pack.position.set(0, 0.36 * scale, -0.2 * scale);
    torso.add(pack);
  }
  root.add(torso);

  const limb = (r: number, len: number, m: THREE.Material, y: number, x: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, y, 0);
    const upper = new THREE.Mesh(capsule(r, len), m);
    upper.position.y = -len / 2 - r * 0.5;
    upper.castShadow = true;
    g.add(upper);
    return g;
  };
  const armL = limb(0.05 * scale, 0.52 * scale, shirt, shoulderY, 0.22 * scale);
  const armR = limb(0.05 * scale, 0.52 * scale, shirt, shoulderY, -0.22 * scale);
  // hands
  for (const a of [armL, armR]) {
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05 * scale, 8, 6), skin);
    hand.position.y = -0.62 * scale;
    a.add(hand);
  }
  const legL = limb(0.07 * scale, 0.7 * scale, pants, hipY, 0.1 * scale);
  const legR = limb(0.07 * scale, 0.7 * scale, pants, hipY, -0.1 * scale);
  for (const l of [legL, legR]) {
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.1 * scale, 0.07 * scale, 0.24 * scale), mat(0x1a1a1c, 0.7));
    shoe.position.set(0, -0.83 * scale, 0.05 * scale);
    l.add(shoe);
  }
  root.add(armL, armR, legL, legR);

  return {
    root,
    armL,
    armR,
    legL,
    legR,
    torso,
    walk(phase, amount) {
      const sw = Math.sin(phase) * 0.55 * amount;
      legL.rotation.x = sw;
      legR.rotation.x = -sw;
      armL.rotation.x = -sw * 0.8;
      armR.rotation.x = sw * 0.8;
      torso.position.y = hipY + Math.abs(Math.cos(phase)) * 0.025 * amount;
      torso.rotation.y = Math.sin(phase) * 0.05 * amount;
    },
    pedal(crank) {
      legL.rotation.x = -0.9 + Math.sin(crank) * 0.45;
      legR.rotation.x = -0.9 + Math.sin(crank + Math.PI) * 0.45;
      armL.rotation.x = -1.1;
      armR.rotation.x = -1.1;
      torso.rotation.x = 0.35;
    },
  };
}

/**
 * Proving ground: a flat practice pad used by the "Vehicle Basics" lesson and
 * as the milestone-1 drivable surface — asphalt pad, painted guides, a cone
 * slalom (knockable), and a test hill for grade physics.
 */

import * as THREE from 'three';
import { CollisionWorld, type CircleCollider } from '../physics/collision';
import type { GroundSample, VehiclePose } from '../vehicle/vehicle';
import type { WorldBase } from '../core/engine';
import type { V2 } from '../core/math';

const PAD = 220; // half-size of asphalt pad

interface Cone {
  mesh: THREE.Object3D;
  collider: CircleCollider;
  knocked: boolean;
  t: number;
}

export class ProvingGround implements WorldBase {
  readonly group = new THREE.Group();
  readonly collision = new CollisionWorld();
  private cones: Cone[] = [];
  /** Hill center/size for the grade test mound. */
  private hill = { x: 140, z: -120, r: 60, h: 7 };

  constructor() {
    // asphalt pad
    const asphalt = new THREE.Mesh(
      new THREE.PlaneGeometry(PAD * 2, PAD * 2),
      new THREE.MeshStandardMaterial({ color: 0x3d4148, roughness: 0.95 }),
    );
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.receiveShadow = true;
    this.group.add(asphalt);

    // grass skirt
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(PAD * 8, PAD * 8),
      new THREE.MeshStandardMaterial({ color: 0x4d7a3f, roughness: 1 }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.02;
    grass.receiveShadow = true;
    this.group.add(grass);

    // hill mound (visual) — ground() supplies matching heights
    const hillGeo = new THREE.SphereGeometry(this.hill.r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    hillGeo.scale(1, this.hill.h / this.hill.r, 1);
    const hillMesh = new THREE.Mesh(hillGeo, new THREE.MeshStandardMaterial({ color: 0x45474d, roughness: 0.95 }));
    hillMesh.position.set(this.hill.x, 0, this.hill.z);
    hillMesh.receiveShadow = true;
    hillMesh.castShadow = false;
    this.group.add(hillMesh);

    // painted guide lines
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xdde3ea });
    for (let i = -3; i <= 3; i++) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 260), lineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(i * 12, 0.012, 0);
      this.group.add(line);
    }

    // cone slalom
    const coneGeo = new THREE.ConeGeometry(0.22, 0.55, 10);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1e, roughness: 0.7 });
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(coneGeo, coneMat);
      const x = -42 + (i % 2 === 0 ? -3.5 : 3.5);
      const z = -90 + i * 24;
      mesh.position.set(x, 0.28, z);
      mesh.castShadow = true;
      this.group.add(mesh);
      const collider: CircleCollider = { x, z, r: 0.35, tag: 'cone', ref: i };
      this.collision.addCircle(collider);
      this.cones.push({ mesh, collider, knocked: false, t: 0 });
    }
  }

  onPropHit(ref: unknown): void {
    const cone = this.cones[ref as number];
    if (cone && !cone.knocked) {
      cone.knocked = true;
      cone.t = 0;
      this.collision.removeCircle(cone.collider);
    }
  }

  ground(x: number, z: number): GroundSample {
    const onPad = Math.abs(x) < PAD && Math.abs(z) < PAD;
    let height = 0;
    const dx = x - this.hill.x;
    const dz = z - this.hill.z;
    const d = Math.hypot(dx, dz);
    if (d < this.hill.r) {
      const t = d / this.hill.r;
      height = Math.cos((t * Math.PI) / 2) ** 1.5 * this.hill.h;
    }
    return {
      height,
      mu: onPad ? 1.0 : 0.62,
      offRoad: !onPad,
      dragExtra: onPad ? 0 : 600,
    };
  }

  speedLimitAt(): number {
    return 50;
  }

  locationAt(): { street: string; area: string } {
    return { street: 'Proving Ground', area: 'Practice Pad' };
  }

  spawn(): VehiclePose {
    return { x: 0, z: 40, heading: Math.PI };
  }

  update(dt: number): void {
    for (const cone of this.cones) {
      if (cone.knocked && cone.t < 1) {
        cone.t = Math.min(1, cone.t + dt * 3);
        cone.mesh.rotation.z = (cone.t * Math.PI) / 2.3;
        cone.mesh.position.y = 0.28 - cone.t * 0.16;
      }
    }
  }
}

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GeoBatch } from '../src/world/batch';

describe('spatial geometry batches', () => {
  it('keeps nearby objects batched while culling distant objects independently', () => {
    const batch = new GeoBatch();
    const box = new THREE.BoxGeometry(2, 2, 2);
    const mat = new THREE.MeshBasicMaterial();
    batch.add('box', box, 10, 0, -20);
    batch.add('box', box, 20, 0, -20);
    batch.add('box', box, 800, 0, -20);
    const meshes = batch.build(new Map([['box', mat]]), new THREE.Group());
    expect(meshes).toHaveLength(2);
    expect(meshes.every(m => m.material === mat && m.castShadow && m.receiveShadow)).toBe(true);
    const triangles = (mesh: THREE.Mesh) => mesh.geometry.getAttribute('position').count / 3;
    expect(meshes.reduce((n, mesh) => n + triangles(mesh), 0)).toBe(36);
    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 1000);
    camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const visible = meshes.filter(m => frustum.intersectsObject(m));
    expect(visible).toHaveLength(1);
    expect(visible.reduce((n, mesh) => n + triangles(mesh), 0)).toBe(24);
    expect(batch.count('box')).toBe(0);
    expect(box.index).not.toBeNull(); // caller-owned geometry remains reusable
  });

  it('retains complete bounds for geometry spanning multiple cells and explicit matrices', () => {
    const batch = new GeoBatch();
    batch.addM('beam', new THREE.BoxGeometry(600, 2, 2), new THREE.Matrix4().makeTranslation(-160, 0, 0));
    const [mesh] = batch.build(new Map([['beam', new THREE.MeshBasicMaterial()]]), new THREE.Group(), { shadows: false });
    mesh.geometry.computeBoundingBox();
    expect(mesh.geometry.boundingBox!.min.x).toBe(-460);
    expect(mesh.geometry.boundingBox!.max.x).toBe(140);
    expect(mesh.castShadow).toBe(false);
  });

  it('still merges templates into one geometry per material for instancing', () => {
    const batch = new GeoBatch();
    batch.add('box', new THREE.BoxGeometry(), -500);
    batch.add('box', new THREE.BoxGeometry(), 500);
    const merged = batch.merged();
    expect(merged.size).toBe(1);
    expect(merged.get('box')!.getAttribute('position').count / 3).toBe(24);
  });
});

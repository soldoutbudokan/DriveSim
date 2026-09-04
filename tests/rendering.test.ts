import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Engine } from '../src/core/engine';
import { SkyDome } from '../src/weather/skyDome';
import { SkySystem } from '../src/weather/sky';

afterEach(() => vi.unstubAllGlobals());

describe('graphics resource lifecycle', () => {
  it('resizes both bloom buffers with DPR and frees them when switching to low', () => {
    vi.stubGlobal('window', { innerWidth: 1920, innerHeight: 1080 });
    vi.stubGlobal('devicePixelRatio', 2);
    let ratio = 1;
    const renderer = {
      setPixelRatio: (value: number) => { ratio = value; },
      getPixelRatio: () => ratio,
      getSize: (size: THREE.Vector2) => size.set(window.innerWidth, window.innerHeight),
      setSize: vi.fn(),
      shadowMap: { enabled: true },
    };
    const engine = Object.assign(Object.create(Engine.prototype), {
      renderer, sun: new THREE.DirectionalLight(), weather: {}, scene: new THREE.Scene(),
      camera: { camera: new THREE.PerspectiveCamera() }, composer: null, bloomPass: null,
    }) as Engine;
    const internal = engine as unknown as { composer: EffectComposer | null; onResize(): void };
    engine.setQuality('high');
    const composer = internal.composer!;
    expect(composer.renderTarget1.width).toBeCloseTo(1920 * ratio);
    expect(composer.renderTarget2.height).toBeCloseTo(1080 * ratio);
    expect(composer.renderTarget1.samples).toBe(4);
    vi.stubGlobal('window', { innerWidth: 3840, innerHeight: 2160 });
    internal.onResize();
    expect(composer.renderTarget1.width).toBeCloseTo(3840 * ratio);
    expect(composer.renderTarget2.height).toBeCloseTo(2160 * ratio);
    const disposed = vi.fn();
    composer.renderTarget1.addEventListener('dispose', disposed);
    composer.renderTarget2.addEventListener('dispose', disposed);
    const bloomDisposed = vi.spyOn(composer.passes[1], 'dispose');
    engine.setQuality('low');
    expect(internal.composer).toBeNull();
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(bloomDisposed).toHaveBeenCalledOnce();
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(ratio).toBeCloseTo(1 / 3);
    engine.setQuality('high');
    expect(internal.composer).not.toBe(composer);
    engine.setQuality('low');
  });

  it('releases the old environment render target and reuses the generator', () => {
    const dome = new SkyDome();
    const oldTarget = new THREE.WebGLRenderTarget(16, 16);
    const nextTarget = new THREE.WebGLRenderTarget(16, 16);
    const disposed = vi.fn();
    oldTarget.addEventListener('dispose', disposed);
    const fromScene = vi.fn().mockReturnValue(nextTarget);
    Object.assign(dome, { envTarget: oldTarget, pmrem: { fromScene } });
    const renderer = {} as THREE.WebGLRenderer;
    const sky = new SkySystem();
    expect(dome.refreshEnvironment(renderer, sky, true)).toBe(nextTarget.texture);
    expect(disposed).toHaveBeenCalledOnce();
    expect(dome.refreshEnvironment(renderer, sky)).toBe(nextTarget.texture);
    expect(fromScene).toHaveBeenCalledOnce();
    nextTarget.dispose();
  });
});

describe('shadow map toggling', () => {
  it('recompiles scene materials only when shadow maps turn on or off', () => {
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720 });
    vi.stubGlobal('devicePixelRatio', 1);
    const renderer = { setPixelRatio() {}, getPixelRatio: () => 1, shadowMap: { enabled: true } };
    const scene = new THREE.Scene();
    const mat = new THREE.MeshStandardMaterial();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), mat));
    const engine = Object.assign(Object.create(Engine.prototype), {
      renderer, sun: new THREE.DirectionalLight(), weather: {}, scene,
      camera: { camera: new THREE.PerspectiveCamera() }, composer: null, bloomPass: null,
    }) as Engine;
    const v0 = mat.version;
    engine.setQuality('medium'); // shadows stay on
    expect(mat.version).toBe(v0);
    engine.setQuality('low'); // off: old programs would keep sampling a disposed map
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(mat.version).toBe(v0 + 1);
    engine.setQuality('low');
    expect(mat.version).toBe(v0 + 1);
    engine.setQuality('medium'); // back on: programs need USE_SHADOWMAP again
    expect(mat.version).toBe(v0 + 2);
  });
});

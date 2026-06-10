/**
 * Replay player: scrubs a recorded drive. The live simulation is suspended;
 * the player car + ghost pool are positioned from interpolated frames. A
 * timeline bar offers play/pause, speeds, scrubbing and clickable fault
 * markers; the camera can follow (chase) or free-orbit.
 */

import * as THREE from 'three';
import type { GameApp } from '../game/app';
import { AGENT_KINDS, buildAgentOffsets, duration, FLAG, sampleAt, type ReplayPayload } from './format';
import { buildCar, type BuiltCar } from '../vehicle/carFactory';

export class ReplayPlayer {
  private app: GameApp;
  private payload: ReplayPayload | null = null;
  private offsets: Uint32Array | null = null;
  private time = 0;
  private playing = true;
  private speed = 1;
  private ghosts: BuiltCar[] = [];
  private ghostKinds: number[] = [];
  private ghostGroup = new THREE.Group();
  private bar: HTMLElement | null = null;
  private slider: HTMLInputElement | null = null;
  private timeEl: HTMLElement | null = null;
  private playBtn: HTMLElement | null = null;
  private disposeOrbit: (() => void) | null = null;
  private follow = true;

  constructor(app: GameApp) {
    this.app = app;
  }

  get active(): boolean {
    return this.payload !== null;
  }

  start(payload: ReplayPayload): void {
    const app = this.app;
    this.payload = payload;
    this.offsets = buildAgentOffsets(payload);
    this.time = 0;
    this.playing = true;
    this.speed = 1;
    app.menus.hide();
    app.mode = 'replay';
    app.engine.simulate = false;
    app.traffic.group.visible = false;
    app.engine.hud.setVisible(true);
    app.engine.hud.clearToasts();
    app.engine.hud.setObjective('Replay', `${payload.meta.mode} drive · drag to orbit, scroll to zoom`);
    app.engine.weather.set(payload.meta.weather);
    app.engine.sky.cycleSpeed = 0;
    app.engine.sky.hour = payload.meta.hour;
    app.engine.scene.add(this.ghostGroup);
    app.engine.minimap?.clearHeat();
    for (const f of payload.faults) {
      app.engine.minimap?.addHeat(f.x, f.z, f.severity === 'minor' ? 'rgba(255,181,71,0.5)' : 'rgba(255,80,60,0.55)', 5);
    }
    this.buildBar();
    app.modeTick = (dt) => this.tick(dt);
    app.onQuitDrive = () => this.stop();
    app.engine.setPaused(false);
  }

  stop(): void {
    const app = this.app;
    this.payload = null;
    app.engine.simulate = true;
    app.traffic.group.visible = true;
    app.engine.scene.remove(this.ghostGroup);
    this.ghostGroup.clear();
    this.ghosts = [];
    this.ghostKinds = [];
    this.bar?.remove();
    this.bar = null;
    this.disposeOrbit?.();
    this.disposeOrbit = null;
    app.engine.camera.setMode('chase');
    app.modeTick = null;
    app.onQuitDrive = null;
    app.showMainMenu();
  }

  /* ---------------- ghost pool ---------------- */

  private ghostFor(slot: number, kind: number): BuiltCar {
    if (this.ghosts[slot] && this.ghostKinds[slot] === kind) return this.ghosts[slot];
    if (this.ghosts[slot]) this.ghostGroup.remove(this.ghosts[slot].root);
    const name = AGENT_KINDS[kind] ?? 'sedan';
    let built: BuiltCar;
    if (name === 'ped') {
      const g = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.18, 0.9, 3, 8),
        new THREE.MeshStandardMaterial({ color: 0x8a93a3, roughness: 0.9 }),
      );
      body.position.y = 0.85;
      g.add(body);
      built = { root: g, chassis: g, wheels: [], frontWheels: [], lights: {} as never, dims: { length: 0.6, width: 0.6, height: 1.7, wheelRadius: 0 }, kind: 'sedan' };
    } else if (name === 'cyclist') {
      const g = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 1.4), new THREE.MeshStandardMaterial({ color: 0x4a6a8a, roughness: 0.7 }));
      frame.position.y = 0.7;
      g.add(frame);
      built = { root: g, chassis: g, wheels: [], frontWheels: [], lights: {} as never, dims: { length: 1.8, width: 0.6, height: 1.7, wheelRadius: 0.33 }, kind: 'sedan' };
    } else {
      built = buildCar(name, [0x8a8d93, 0x33424f, 0x6d2e2a, 0xcfd2d6][slot % 4]);
    }
    this.ghostGroup.add(built.root);
    this.ghosts[slot] = built;
    this.ghostKinds[slot] = kind;
    return built;
  }

  /* ---------------- timeline UI ---------------- */

  private buildBar(): void {
    const p = this.payload!;
    const dur = duration(p);
    const bar = document.createElement('div');
    bar.id = 'replayBar';
    bar.className = 'panel clickable';
    bar.innerHTML = `
      <button class="btn" id="rpPlay">⏸</button>
      <select id="rpSpeed"><option>0.5</option><option selected>1</option><option>2</option><option>4</option></select>
      <input type="range" id="rpSlider" min="0" max="${dur.toFixed(1)}" step="0.1" value="0">
      <div class="markers" id="rpMarkers"></div>
      <span class="time" id="rpTime">0:00 / ${fmt(dur)}</span>
      <button class="btn" id="rpCam">🎥 follow</button>
      <button class="btn danger" id="rpExit">Exit</button>
    `;
    document.getElementById('ui')!.appendChild(bar);
    this.bar = bar;
    this.slider = bar.querySelector('#rpSlider') as HTMLInputElement;
    this.timeEl = bar.querySelector('#rpTime') as HTMLElement;
    this.playBtn = bar.querySelector('#rpPlay') as HTMLElement;
    this.playBtn.onclick = () => {
      this.playing = !this.playing;
      this.playBtn!.textContent = this.playing ? '⏸' : '▶';
    };
    (bar.querySelector('#rpSpeed') as HTMLSelectElement).onchange = (ev) => {
      this.speed = Number((ev.target as HTMLSelectElement).value);
    };
    this.slider.oninput = () => {
      this.time = Number(this.slider!.value);
      this.playing = false;
      this.playBtn!.textContent = '▶';
    };
    (bar.querySelector('#rpExit') as HTMLElement).onclick = () => this.stop();
    const camBtn = bar.querySelector('#rpCam') as HTMLElement;
    camBtn.onclick = () => {
      this.follow = !this.follow;
      camBtn.textContent = this.follow ? '🎥 follow' : '🎥 orbit';
      if (this.follow) {
        this.disposeOrbit?.();
        this.disposeOrbit = null;
        this.app.engine.camera.setMode('chase');
      } else {
        this.disposeOrbit = this.app.engine.camera.enableFreeOrbit(this.app.engine.renderer.domElement);
      }
    };
    // fault markers
    const markers = bar.querySelector('#rpMarkers') as HTMLElement;
    for (const f of p.faults) {
      const i = document.createElement('i');
      i.style.left = `${(f.time / Math.max(dur, 1)) * 100}%`;
      i.title = `${fmt(f.time)} — ${f.message}`;
      i.style.pointerEvents = 'auto';
      i.style.cursor = 'pointer';
      i.onclick = () => {
        this.time = Math.max(0, f.time - 4);
        this.app.engine.hud.toast(`⏪ ${f.message}`, 'warn');
      };
      markers.appendChild(i);
    }
  }

  /* ---------------- per-frame ---------------- */

  private tick(dt: number): void {
    const p = this.payload;
    if (!p) return;
    const dur = duration(p);
    if (this.playing) {
      this.time += dt * this.speed;
      if (this.time >= dur) {
        this.time = dur;
        this.playing = false;
        if (this.playBtn) this.playBtn.textContent = '▶';
      }
    }
    const s = sampleAt(p, this.time, this.offsets ?? undefined);
    if (!s) return;
    const e = this.app.engine;
    const v = e.vehicle;
    // drive the live vehicle state kinematically: render/camera/HUD all follow
    v.x = s.x;
    v.z = s.z;
    v.y = s.y;
    v.heading = s.heading;
    v.vx = s.speed;
    v.vy = 0;
    v.steer = s.steer;
    e.signal = s.flags & FLAG.sigL ? 'left' : s.flags & FLAG.sigR ? 'right' : 'off';
    e.headlights = !!(s.flags & FLAG.headlights);

    // ghosts
    let slot = 0;
    for (const a of s.agents) {
      const g = this.ghostFor(slot, a.k);
      g.root.visible = true;
      const y = this.app.world.ground(a.x, a.z).height;
      g.root.position.set(a.x, y, a.z);
      g.root.rotation.set(0, a.h, 0);
      slot++;
    }
    for (let i = slot; i < this.ghosts.length; i++) {
      if (this.ghosts[i]) this.ghosts[i].root.visible = false;
    }

    if (this.slider && this.playing) this.slider.value = this.time.toFixed(1);
    if (this.timeEl) this.timeEl.textContent = `${fmt(this.time)} / ${fmt(dur)}`;
  }
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

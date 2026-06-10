/**
 * Engine: owns the renderer, scene, player vehicle, cameras, audio, HUD and
 * the fixed-step game loop. Game modes (free roam / lessons / examiner /
 * replay) orchestrate on top of this via hooks.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Emitter } from './events';
import type { GameEvents, CameraMode } from './types';
import { clamp, clamp01, headingForward, type V2 } from './math';
import { AutoQuality, TIERS, type Tier } from './quality';
import { SkySystem } from '../weather/sky';
import { WeatherSystem } from '../weather/weather';
import { Input } from '../controls/input';
import { Vehicle, type GroundSample, type VehiclePose } from '../vehicle/vehicle';
import { buildCar, CarVisual } from '../vehicle/carFactory';
import { CameraRig } from '../camera/rig';
import { AudioManager } from '../audio/audio';
import { Hud } from '../ui/hud';
import { Minimap, type MinimapMarker } from '../ui/minimap';
import type { RoadNetwork } from '../world/network';
import type { TrafficManager } from '../traffic/manager';
import type { CollisionWorld } from '../physics/collision';
import { carOBB, obbVsCircle, obbVsObb } from '../physics/collision';

export interface WorldBase {
  readonly group: THREE.Object3D;
  readonly collision: CollisionWorld;
  /** Base surface sample (mu BEFORE weather scaling). */
  ground(x: number, z: number): GroundSample;
  speedLimitAt(x: number, z: number): number;
  locationAt(x: number, z: number): { street: string; area: string };
  spawn(): VehiclePose;
  update(dt: number, simTime: number, playerPos: V2): void;
  /** Called when the player hits a knockable prop (cones). */
  onPropHit?(ref: unknown): void;
  /** Night factor 0..1 for emissives (streetlights, windows). */
  setNight?(f: number): void;
}

export type SignalSide = 'off' | 'left' | 'right';

export interface EngineHooks {
  /** Called every frame after physics, before render. */
  tick?: (dt: number) => void;
  /** Whether driving input should reach the car. */
  inputEnabled?: () => boolean;
}

const BLINK_PERIOD = 0.8;

export class Engine {
  readonly events = new Emitter<GameEvents>();
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly input = new Input();
  readonly audio = new AudioManager();
  readonly vehicle = new Vehicle();
  readonly camera: CameraRig;
  readonly hud: Hud;

  world!: WorldBase;
  playerVisual!: CarVisual;
  headlightL!: THREE.SpotLight;
  headlightR!: THREE.SpotLight;
  minimap: Minimap | null = null;
  traffic: TrafficManager | null = null;
  /** Overlays drawn on the minimap (examiner route, lesson markers). */
  routeOverlay: { x: number; z: number }[] | null = null;
  mapMarkers: MinimapMarker[] = [];

  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly moon: THREE.DirectionalLight;
  readonly sky = new SkySystem();
  readonly weather: WeatherSystem;
  readonly autoQuality = new AutoQuality();
  tier: Tier = 'high';
  /** Auto-headlights at night (toggleable in settings). */
  autoHeadlights = true;
  private prevNight = 0;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private renderPass!: RenderPass;

  simTime = 0;
  paused = false;
  signal: SignalSide = 'off';
  headlights = false;
  hazards = false;
  wipers = false;
  /** Effective grip multiplier from weather (set by weather system). */
  weatherMu = 1;
  weatherDrag = 0;

  hooks: EngineHooks = {};

  /** Time of last mirror / shoulder observation (for HUD + coaching). */
  lastMirrorCheck = -99;
  lastShoulderLeft = -99;
  lastShoulderRight = -99;

  private signalYawAcc = 0;
  private signalOnSince = -99;
  private safePose: VehiclePose | null = null;
  private safePoseTimer = 0;
  private mirrorViewT = 0;
  private rearCam: THREE.PerspectiveCamera;
  private clockPrev = 0;
  private raf = 0;
  /** Per-frame fps sampling for the auto quality tier. */
  fpsSmooth = 60;
  private collisionCooldown = 0;

  constructor(appEl: HTMLElement, uiEl: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    appEl.appendChild(this.renderer.domElement);

    this.camera = new CameraRig(window.innerWidth / window.innerHeight);
    this.rearCam = new THREE.PerspectiveCamera(58, 2.6, 0.3, 600);
    this.hud = new Hud(uiEl);

    // lighting (the sky/weather system drives these per-frame)
    this.hemi = new THREE.HemisphereLight(0xbfd6ff, 0x46557093, 0.75);
    this.sun = new THREE.DirectionalLight(0xffeedd, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 420;
    const sc = 95;
    this.sun.shadow.camera.left = -sc;
    this.sun.shadow.camera.right = sc;
    this.sun.shadow.camera.top = sc;
    this.sun.shadow.camera.bottom = -sc;
    this.sun.shadow.bias = -0.0007;
    this.moon = new THREE.DirectionalLight(0x8899ff, 0);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.moon, this.moon.target);
    this.scene.fog = new THREE.Fog(0xbfd2e8, 250, 1500);
    this.scene.background = new THREE.Color(0x9fc3ef);

    this.weather = new WeatherSystem(this.scene);
    this.setQuality('high');

    window.addEventListener('resize', () => this.onResize());
    this.input.onFirstGesture(() => this.audio.init());
  }

  setQuality(tier: Tier): void {
    this.tier = tier;
    const cfg = TIERS[tier];
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, cfg.pixelRatioCap));
    this.renderer.shadowMap.enabled = cfg.shadowMap > 0;
    if (cfg.shadowMap > 0) {
      this.sun.shadow.mapSize.set(cfg.shadowMap, cfg.shadowMap);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.weather.particleScale = cfg.particleScale;
    if (cfg.bloom && !this.composer) {
      this.composer = new EffectComposer(this.renderer);
      this.renderPass = new RenderPass(this.scene, this.camera.camera);
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.28, 0.5, 0.82);
      this.composer.addPass(this.renderPass);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    }
    if (this.bloomPass) this.bloomPass.enabled = cfg.bloom;
  }

  setWorld(world: WorldBase): void {
    if (this.world) this.scene.remove(this.world.group);
    this.world = world;
    this.scene.add(world.group);
  }

  attachMinimap(net: RoadNetwork): void {
    this.minimap = new Minimap(net, this.hud.minimapCanvas);
  }

  attachTraffic(tm: TrafficManager): void {
    if (this.traffic) this.scene.remove(this.traffic.group);
    this.traffic = tm;
    this.scene.add(tm.group);
  }

  buildPlayer(color = 0x2f6fce): void {
    if (this.playerVisual) this.scene.remove(this.playerVisual.root);
    const built = buildCar('sedan', color);
    this.playerVisual = new CarVisual(built);
    built.root.traverse((o) => {
      o.castShadow = true;
    });
    // real spotlights for night driving
    this.headlightL = new THREE.SpotLight(0xfff3d0, 0, 60, 0.42, 0.45, 1.2);
    this.headlightR = new THREE.SpotLight(0xfff3d0, 0, 60, 0.42, 0.45, 1.2);
    for (const [light, side] of [
      [this.headlightL, -0.62] as const,
      [this.headlightR, 0.62] as const,
    ]) {
      light.position.set(side, 0.7, this.vehicle.p.length / 2 - 0.1);
      const target = new THREE.Object3D();
      target.position.set(side * 0.5, 0.15, 14);
      built.root.add(target);
      light.target = target;
      built.root.add(light);
    }
    this.scene.add(built.root);
  }

  /** Weather-aware ground query passed to vehicle physics. */
  groundQuery = (x: number, z: number): GroundSample => {
    const g = this.world.ground(x, z);
    return {
      height: g.height,
      mu: g.mu * this.weatherMu,
      offRoad: g.offRoad,
      dragExtra: g.dragExtra + this.weatherDrag,
    };
  };

  get blinkPhase(): boolean {
    return this.simTime % BLINK_PERIOD < BLINK_PERIOD / 2;
  }

  setSignal(side: SignalSide, auto = false): void {
    if (this.signal === side && side !== 'off') side = 'off';
    this.signal = side;
    this.signalYawAcc = 0;
    if (side !== 'off') this.signalOnSince = this.simTime;
    this.events.emit('signal', { side, auto });
    this.audio.click(side === 'off' ? 700 : 980);
  }

  get signalAgeS(): number {
    return this.signal === 'off' ? 0 : this.simTime - this.signalOnSince;
  }

  respawn(): void {
    if (!this.safePose) this.safePose = this.world.spawn();
    this.vehicle.teleport(this.safePose);
    this.signal = 'off';
    this.hud.toast('Respawned at the last safe spot.', 'info');
  }

  spawnAt(pose: VehiclePose): void {
    this.vehicle.teleport(pose);
    this.safePose = { ...pose };
    this.signal = 'off';
  }

  private handleTaps(): void {
    for (const tap of this.input.drainTaps()) {
      switch (tap) {
        case 'pause':
          this.setPaused(!this.paused);
          break;
        case 'help':
          this.hud.showHelp();
          break;
        case 'signalLeft':
          this.setSignal('left');
          break;
        case 'signalRight':
          this.setSignal('right');
          break;
        case 'checkLeft':
          this.camera.doGlance('shoulderLeft');
          this.lastShoulderLeft = this.simTime;
          this.events.emit('check', { kind: 'shoulderLeft', time: this.simTime });
          break;
        case 'checkRight':
          this.camera.doGlance('shoulderRight');
          this.lastShoulderRight = this.simTime;
          this.events.emit('check', { kind: 'shoulderRight', time: this.simTime });
          break;
        case 'mirror':
          this.camera.doGlance('mirror');
          this.mirrorViewT = 1.0;
          this.lastMirrorCheck = this.simTime;
          this.events.emit('check', { kind: 'mirror', time: this.simTime });
          break;
        case 'camera':
          this.camera.cycleMode();
          break;
        case 'cockpit':
          this.camera.toggleCockpit();
          break;
        case 'respawn':
          this.respawn();
          break;
        case 'headlights':
          this.headlights = !this.headlights;
          this.audio.click(this.headlights ? 900 : 600);
          break;
        case 'hazards':
          this.hazards = !this.hazards;
          this.audio.click(880);
          break;
        case 'wipers':
          this.wipers = !this.wipers;
          this.audio.click(820);
          break;
        case 'gearToggle': {
          const next = this.vehicle.toggleReverse();
          if (next) {
            this.audio.click(next === 'R' ? 640 : 900);
            this.events.emit('gear', { gear: next });
          } else {
            this.hud.toast('Stop fully before selecting Reverse.', 'warn');
          }
          break;
        }
        default:
          break;
      }
    }
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (p) this.hud.centerMsg('PAUSED', 'P to resume · ? for help', true);
    else this.hud.centerMsg('');
  }

  setCameraMode(m: CameraMode): void {
    this.camera.setMode(m);
  }

  private updateSignals(dt: number): void {
    if (this.signal === 'off') return;
    this.signalYawAcc += this.vehicle.yawRate * dt;
    const steered = Math.abs(this.vehicle.steer) < 0.05;
    if (
      (this.signal === 'left' && this.signalYawAcc > 0.62 && steered) ||
      (this.signal === 'right' && this.signalYawAcc < -0.62 && steered)
    ) {
      this.setSignal('off', true);
    }
  }

  private updateCollisions(dt: number): void {
    this.collisionCooldown = Math.max(0, this.collisionCooldown - dt);
    const v = this.vehicle;
    const obb = carOBB(v.x, v.z, v.heading, v.p.length, v.p.width, 'player');
    const contacts = this.world.collision.collide(obb);
    // dynamic obstacles: traffic, transit, cyclists, pedestrians
    if (this.traffic) {
      const dyn = this.traffic.dynamicObstacles(v.x, v.z, 32);
      for (const o of dyn.obbs) {
        const c = obbVsObb(obb, o);
        if (c) {
          contacts.push(c);
          this.traffic.notifyHit(o.ref);
        }
      }
      for (const ci of dyn.circles) {
        const c = obbVsCircle(obb, ci);
        if (c) contacts.push(c);
      }
    }
    for (const c of contacts) {
      if (c.tag === 'cone' || c.tag === 'knockable') {
        this.world.onPropHit?.(c.ref);
        if (this.collisionCooldown <= 0) {
          this.audio.impact(1.2);
          this.events.emit('collision', { impulse: 0.6, x: v.x, z: v.z, kind: c.tag });
          this.collisionCooldown = 0.5;
        }
        continue;
      }
      const j = v.applyImpact({ x: c.nx, z: c.nz }, c.depth, 0.22, c.offsetAlong);
      if (j > 0.25 && this.collisionCooldown <= 0) {
        this.audio.impact(j);
        this.camera.addShake(clamp(j / 10, 0.06, 0.4));
        this.events.emit('collision', { impulse: j, x: v.x, z: v.z, kind: c.tag });
        this.collisionCooldown = 0.65;
      }
    }
  }

  private updateSafePose(dt: number): void {
    this.safePoseTimer -= dt;
    const v = this.vehicle;
    if (this.safePoseTimer <= 0 && !v.offRoad && v.speed < 6 && this.collisionCooldown <= 0) {
      this.safePose = { x: v.x, z: v.z, heading: v.heading };
      this.safePoseTimer = 3;
    }
  }

  /** One simulation + render frame. */
  private frame = (tMs: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min((tMs - this.clockPrev) / 1000 || 0.016, 0.1);
    this.clockPrev = tMs;
    const fps = dt > 0 ? 1 / dt : 60;
    this.fpsSmooth += (fps - this.fpsSmooth) * 0.05;

    this.input.update(dt);
    this.handleTaps();

    if (!this.paused) {
      this.simTime += dt;
      const inputEnabled = this.hooks.inputEnabled?.() ?? true;
      const effInput = inputEnabled
        ? this.input.state
        : { throttle: 0, brake: 0.4, steer: 0, handbrake: false, precise: false, horn: false };

      this.vehicle.update(dt, effInput, this.groundQuery);
      this.updateCollisions(dt);
      this.updateSignals(dt);
      this.updateSafePose(dt);
      this.world.update(dt, this.simTime, this.vehicle.pos);
      this.traffic?.update(
        dt,
        this.simTime,
        { x: this.vehicle.x, z: this.vehicle.z, heading: this.vehicle.heading, speed: this.vehicle.vx },
        this.weatherMu,
        this.sky.nightFactor,
      );

      // environment
      const v = this.vehicle;
      this.sky.update(dt, this.scene, this.sun, this.moon, this.hemi, v.x, v.z);
      const wv = v.worldVel;
      this.weather.update(dt, this.scene, v.x, v.y, v.z, wv.x, wv.z);
      this.sun.intensity *= 1 - this.weather.skyDim;
      this.world.setNight?.(this.sky.nightFactor);
      this.weatherMu = this.weather.gripMul;
      this.weatherDrag = this.weather.kind === 'snow' ? 60 : 0;
      if (this.autoHeadlights && this.sky.nightFactor > 0.55 && this.prevNight <= 0.55) this.headlights = true;
      this.prevNight = this.sky.nightFactor;

      this.hooks.tick?.(dt);
    }

    const newTier = this.autoQuality.evaluate(dt, this.fpsSmooth);
    if (newTier) {
      this.setQuality(newTier);
      this.hud.toast(`Graphics auto-adjusted to ${newTier}.`, 'info');
    }

    this.render(dt);
  };

  private render(dt: number): void {
    const v = this.vehicle;
    this.mirrorViewT = Math.max(0, this.mirrorViewT - dt);

    // player visual
    this.playerVisual.root.position.set(v.x, v.y, v.z);
    this.playerVisual.root.rotation.set(0, v.heading, 0);
    // pitch the whole car with road grade
    this.playerVisual.root.rotation.x = -Math.asin(clamp(v.pitchSlope, -0.4, 0.4));
    this.playerVisual.update(
      dt,
      this.simTime,
      v.vx,
      v.steer,
      {
        headlights: this.headlights,
        braking: v.brakePedal > 0.04 || v.handbrakeOn,
        reversing: v.gear === 'R',
        signalLeft: this.signal === 'left',
        signalRight: this.signal === 'right',
        hazards: this.hazards,
      },
      v.gLat * 9.81,
      v.gLong * 9.81,
    );
    const beam = this.headlights ? 90 : 0;
    this.headlightL.intensity = beam;
    this.headlightR.intensity = beam;

    // camera + sun follow
    this.camera.update(dt, {
      x: v.x,
      y: v.y,
      z: v.z,
      heading: v.heading,
      speed: v.speed,
      vx: v.vx,
      pitchSlope: v.pitchSlope,
    });
    this.sun.target.position.set(v.x, 0, v.z);

    // audio
    const skid = clamp01(Math.max(v.frontSat, v.rearSat) - 0.92) * 8 * clamp01(v.speed / 6 - 0.2) + (v.wheelspin ? 0.35 : 0);
    this.audio.setHorn(this.input.state.horn);
    this.audio.update(dt, {
      rpm: v.rpm,
      throttle: v.accelPedal,
      speed: v.speed,
      skid: clamp01(skid),
      shifting: v.powertrain.shifting,
      rainLevel: this.weather.rainLevel * (this.wipers ? 0.8 : 1),
      blinkPhaseOn: this.signal !== 'off' || this.hazards ? this.blinkPhase : undefined,
      idleCity: 0.5,
    });
    const fwd = headingForward(v.heading);
    // emergency siren + streetcar bell
    const em = this.traffic?.emergency;
    this.audio.setSiren(!!em?.active);
    this.audio.setSpatial(
      { x: v.x, y: v.y + 1.2, z: v.z, fx: fwd.x, fz: fwd.z },
      em?.active ? { x: em.user.x, y: 1.5, z: em.user.z } : undefined,
    );
    if (this.traffic?.streetcar.bellPending) {
      this.traffic.streetcar.bellPending = false;
      this.audio.bell();
    }

    // HUD
    const loc = this.world.locationAt(v.x, v.z);
    this.hud.update({
      speedKmh: v.speedKmh,
      limitKmh: this.world.speedLimitAt(v.x, v.z),
      rpmFrac: clamp01((v.rpm - 600) / (v.p.redlineRpm - 600)),
      gear: v.powertrain.gearLabel,
      signalLeft: this.signal === 'left',
      signalRight: this.signal === 'right',
      blinkPhase: this.blinkPhase,
      headlights: this.headlights,
      hazards: this.hazards,
      handbrake: v.handbrakeOn || v.gear === 'P',
      abs: v.absActive,
      wipers: this.wipers,
      scanAge: this.simTime - this.lastMirrorCheck,
      street: loc.street,
      area: loc.area,
    });

    this.minimap?.update({ x: v.x, z: v.z, heading: v.heading }, this.routeOverlay ?? undefined, this.mapMarkers);

    // main render (bloom composer at high tiers)
    this.renderer.setScissorTest(false);
    if (this.composer && this.bloomPass?.enabled) {
      this.renderPass.camera = this.camera.camera;
      this.composer.render();
    } else {
      this.renderer.render(this.scene, this.camera.camera);
    }

    // rear-view mirror inset (scissor viewport)
    const showMirror = this.mirrorViewT > 0 || (this.camera.mode === 'cockpit' && this.camera.glanceActive === 'mirror');
    if (showMirror) {
      const w = Math.min(420, window.innerWidth * 0.32);
      const h = w / 2.6;
      const x = (window.innerWidth - w) / 2;
      const y = 14;
      this.rearCam.position.set(v.x - fwd.x * 0.5, v.y + 1.35, v.z - fwd.z * 0.5);
      this.rearCam.lookAt(v.x - fwd.x * 30, v.y + 1.1, v.z - fwd.z * 30);
      this.rearCam.aspect = w / h;
      this.rearCam.updateProjectionMatrix();
      const dpr = this.renderer.getPixelRatio();
      this.renderer.setScissorTest(true);
      this.renderer.setScissor(x * dpr, (window.innerHeight - y - h) * dpr, w * dpr, h * dpr);
      this.renderer.setViewport(x * dpr, (window.innerHeight - y - h) * dpr, w * dpr, h * dpr);
      this.renderer.render(this.scene, this.rearCam);
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, window.innerWidth * dpr, window.innerHeight * dpr);
      this.hud.layoutMirror(x, y, w, h, true);
    } else {
      this.hud.layoutMirror(0, 0, 0, 0, false);
    }
  }

  private onResize(): void {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer?.setSize(window.innerWidth, window.innerHeight);
    this.camera.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.camera.updateProjectionMatrix();
  }

  start(): void {
    this.spawnAt(this.world.spawn());
    this.clockPrev = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }
}

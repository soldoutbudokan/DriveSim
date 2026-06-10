/**
 * Procedural spatial audio — every sound is synthesized with the Web Audio
 * API (no asset files): RPM-pitched engine, blinker relay, tire scrub, wind,
 * rain, horn, collisions, sirens (positional), streetcar bell, ambient city.
 */

import { clamp, clamp01, lerp } from '../core/math';

function makeNoiseBuffer(ctx: AudioContext, seconds = 2): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    // pinkish noise via leaky integrator mix
    const white = Math.random() * 2 - 1;
    last = 0.97 * last + 0.03 * white;
    data[i] = white * 0.55 + last * 1.6;
  }
  return buf;
}

export interface AudioLevels {
  master: number;
  engine: number;
  effects: number;
  ambient: number;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineBus!: GainNode;
  private fxBus!: GainNode;
  private ambientBus!: GainNode;

  private engOsc1!: OscillatorNode;
  private engOsc2!: OscillatorNode;
  private engGain!: GainNode;
  private engFilter!: BiquadFilterNode;
  private engNoiseGain!: GainNode;

  private skidGain!: GainNode;
  private windGain!: GainNode;
  private rainGain!: GainNode;
  private noiseBuf!: AudioBuffer;

  private hornOsc: OscillatorNode[] = [];
  private hornGain!: GainNode;
  private hornOn = false;

  private sirenNodes: { osc: OscillatorNode; gain: GainNode; pan: PannerNode; phase: number } | null = null;

  private lastBlinkPhase = false;
  private ambientTimer = 8;

  levels: AudioLevels = { master: 0.8, engine: 0.8, effects: 0.9, ambient: 0.6 };
  enabled = true;

  get ready(): boolean {
    return this.ctx !== null;
  }

  /** Must be called from a user gesture. */
  init(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.noiseBuf = makeNoiseBuffer(ctx);

    this.master = ctx.createGain();
    this.master.gain.value = this.levels.master;
    this.master.connect(ctx.destination);

    this.engineBus = ctx.createGain();
    this.fxBus = ctx.createGain();
    this.ambientBus = ctx.createGain();
    this.engineBus.connect(this.master);
    this.fxBus.connect(this.master);
    this.ambientBus.connect(this.master);
    this.applyLevels();

    // --- engine: two saws + filtered noise ---------------------------
    this.engOsc1 = ctx.createOscillator();
    this.engOsc1.type = 'sawtooth';
    this.engOsc2 = ctx.createOscillator();
    this.engOsc2.type = 'square';
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 500;
    this.engFilter.Q.value = 1.1;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    const engMix = ctx.createGain();
    engMix.gain.value = 0.5;
    this.engOsc1.connect(engMix);
    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.35;
    this.engOsc2.connect(osc2Gain);
    osc2Gain.connect(engMix);
    const engNoise = ctx.createBufferSource();
    engNoise.buffer = this.noiseBuf;
    engNoise.loop = true;
    const engNoiseFilter = ctx.createBiquadFilter();
    engNoiseFilter.type = 'bandpass';
    engNoiseFilter.frequency.value = 180;
    this.engNoiseGain = ctx.createGain();
    this.engNoiseGain.gain.value = 0;
    engNoise.connect(engNoiseFilter).connect(this.engNoiseGain).connect(engMix);
    engMix.connect(this.engFilter).connect(this.engGain).connect(this.engineBus);
    this.engOsc1.start();
    this.engOsc2.start();
    engNoise.start();

    // --- tire skid ------------------------------------------------------
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = this.noiseBuf;
    skidSrc.loop = true;
    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = 'bandpass';
    skidFilter.frequency.value = 950;
    skidFilter.Q.value = 1.6;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    skidSrc.connect(skidFilter).connect(this.skidGain).connect(this.fxBus);
    skidSrc.start();

    // --- wind -------------------------------------------------------------
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this.noiseBuf;
    windSrc.loop = true;
    windSrc.playbackRate.value = 0.6;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 480;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(this.windGain).connect(this.ambientBus);
    windSrc.start();

    // --- rain ---------------------------------------------------------------
    const rainSrc = ctx.createBufferSource();
    rainSrc.buffer = this.noiseBuf;
    rainSrc.loop = true;
    rainSrc.playbackRate.value = 1.4;
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'highpass';
    rainFilter.frequency.value = 1200;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rainSrc.connect(rainFilter).connect(this.rainGain).connect(this.ambientBus);
    rainSrc.start();

    // --- horn ------------------------------------------------------------------
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    for (const f of [420, 505]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.18;
      o.connect(g).connect(this.hornGain);
      o.start();
      this.hornOsc.push(o);
    }
    const hornFilter = ctx.createBiquadFilter();
    hornFilter.type = 'lowpass';
    hornFilter.frequency.value = 1600;
    this.hornGain.connect(hornFilter).connect(this.fxBus);
  }

  applyLevels(): void {
    if (!this.ctx) return;
    const on = this.enabled ? 1 : 0;
    this.master.gain.value = this.levels.master * on;
    this.engineBus.gain.value = this.levels.engine;
    this.fxBus.gain.value = this.levels.effects;
    this.ambientBus.gain.value = this.levels.ambient;
  }

  /** Per-frame engine + movement audio. */
  update(
    dt: number,
    state: {
      rpm: number;
      throttle: number;
      speed: number;
      skid: number; // 0..1
      shifting: boolean;
      rainLevel: number; // 0..1
      windScale?: number;
      blinkPhaseOn?: boolean; // current indicator phase, ticks on flip
      idleCity?: number; // ambient city level 0..1
    },
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const tau = 0.05;

    const fire = (state.rpm / 60) * 2; // 4-cyl firing frequency
    this.engOsc1.frequency.setTargetAtTime(fire, t, tau);
    this.engOsc2.frequency.setTargetAtTime(fire * 0.5, t, tau);
    const load = clamp01(state.throttle * 0.85 + state.rpm / 9000);
    const vol = state.shifting ? 0.05 : 0.055 + load * 0.13;
    this.engGain.gain.setTargetAtTime(vol, t, tau);
    this.engFilter.frequency.setTargetAtTime(330 + state.rpm * 0.55 + state.throttle * 900, t, tau);
    this.engNoiseGain.gain.setTargetAtTime(0.15 + state.throttle * 0.5, t, tau);

    this.skidGain.gain.setTargetAtTime(clamp01(state.skid) * 0.5, t, 0.08);
    const wind = clamp01((state.speed / 42) ** 2) * (state.windScale ?? 1);
    this.windGain.gain.setTargetAtTime(wind * 0.5, t, 0.2);
    this.rainGain.gain.setTargetAtTime(state.rainLevel * 0.32, t, 0.4);

    if (state.blinkPhaseOn !== undefined && state.blinkPhaseOn !== this.lastBlinkPhase) {
      this.lastBlinkPhase = state.blinkPhaseOn;
      this.click(state.blinkPhaseOn ? 1180 : 870, 0.05);
    }

    // sparse ambient city honks/rumble
    this.ambientTimer -= dt;
    if (this.ambientTimer <= 0 && (state.idleCity ?? 0) > 0.1) {
      this.ambientTimer = 14 + Math.random() * 30;
      this.distantHonk();
    }

    if (this.sirenNodes) {
      this.sirenNodes.phase += dt * 0.45;
      const f = 700 + (Math.sin(this.sirenNodes.phase * Math.PI * 2) * 0.5 + 0.5) * 750;
      this.sirenNodes.osc.frequency.setTargetAtTime(f, t, 0.03);
    }
  }

  setHorn(on: boolean): void {
    if (!this.ctx || on === this.hornOn) return;
    this.hornOn = on;
    this.hornGain.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.02);
  }

  /** Short relay click for indicators/buttons. */
  click(freq = 1000, vol = 0.06): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.045);
    o.connect(g).connect(this.fxBus);
    o.start();
    o.stop(ctx.currentTime + 0.06);
  }

  /** Collision thump scaled to impulse (m/s removed). */
  impact(impulse: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const v = clamp(impulse / 8, 0.08, 1);
    const now = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.value = 900;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(v * 0.9, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    noise.connect(nf).connect(ng).connect(this.fxBus);
    noise.start(now, Math.random());
    noise.stop(now + 0.3);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(95, now);
    thump.frequency.exponentialRampToValueAtTime(38, now + 0.18);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(v, now);
    tg.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    thump.connect(tg).connect(this.fxBus);
    thump.start(now);
    thump.stop(now + 0.25);
  }

  /** Gentle UI confirmation/notification sounds. */
  ui(kind: 'good' | 'warn' | 'info' | 'fail'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const freqs = kind === 'good' ? [660, 880] : kind === 'warn' ? [420, 330] : kind === 'fail' ? [330, 220, 165] : [560];
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      const t0 = now + i * 0.1;
      g.gain.setValueAtTime(0.001, t0);
      g.gain.linearRampToValueAtTime(0.12, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
      o.connect(g).connect(this.fxBus);
      o.start(t0);
      o.stop(t0 + 0.2);
    });
  }

  bell(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 1320;
      const g = ctx.createGain();
      const t0 = now + i * 0.28;
      g.gain.setValueAtTime(0.18, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
      o.connect(g).connect(this.fxBus);
      o.start(t0);
      o.stop(t0 + 0.55);
    }
  }

  private distantHonk(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 300 + Math.random() * 220;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.014, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.4 + Math.random() * 0.4);
    o.connect(g).connect(this.ambientBus);
    o.start(now);
    o.stop(now + 1);
  }

  /** Start/stop the positional siren; call setSirenPos each frame while active. */
  setSiren(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (on && !this.sirenNodes) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 800;
      const gain = ctx.createGain();
      gain.gain.value = 0.0;
      const pan = ctx.createPanner();
      pan.panningModel = 'equalpower';
      pan.distanceModel = 'inverse';
      pan.refDistance = 14;
      pan.maxDistance = 380;
      pan.rolloffFactor = 1.3;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 2200;
      osc.connect(filt).connect(gain).connect(pan).connect(this.fxBus);
      osc.start();
      gain.gain.setTargetAtTime(0.34, ctx.currentTime, 0.4);
      this.sirenNodes = { osc, gain, pan, phase: 0 };
    } else if (!on && this.sirenNodes) {
      const s = this.sirenNodes;
      s.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
      const osc = s.osc;
      setTimeout(() => {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
      }, 1200);
      this.sirenNodes = null;
    }
  }

  /** Position the siren and the listener in world space. */
  setSpatial(listener: { x: number; y: number; z: number; fx: number; fz: number }, siren?: { x: number; y: number; z: number }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = listener.x;
      l.positionY.value = listener.y;
      l.positionZ.value = listener.z;
      l.forwardX.value = listener.fx;
      l.forwardY.value = 0;
      l.forwardZ.value = listener.fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    }
    if (siren && this.sirenNodes) {
      const p = this.sirenNodes.pan;
      if (p.positionX) {
        p.positionX.value = siren.x;
        p.positionY.value = siren.y;
        p.positionZ.value = siren.z;
      }
    }
  }
}

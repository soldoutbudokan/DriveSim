/**
 * Input system: keyboard + Gamepad API mapped onto a single analog action state.
 *
 * Keyboard keys are smoothed into analog throttle/brake/steer so the car is
 * controllable; gamepads pass through their analog values. Tap actions
 * (signals, shoulder checks, camera, …) are queued as edge events and drained
 * by the engine once per frame.
 */

import { clamp, clamp01 } from '../core/math';

export type TapAction =
  | 'signalLeft'
  | 'signalRight'
  | 'checkLeft'
  | 'checkRight'
  | 'mirror'
  | 'camera'
  | 'cockpit'
  | 'respawn'
  | 'pause'
  | 'help'
  | 'headlights'
  | 'hazards'
  | 'wipers'
  | 'gearToggle';

export interface InputState {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1..1, positive steers LEFT (matches physics convention). */
  steer: number;
  handbrake: boolean;
  /** Shift / precise modifier: gentle throttle. */
  precise: boolean;
  horn: boolean;
}

export interface InputSettings {
  steerSensitivity: number; // 0.5..1.5
  invertSteer: boolean;
}

const KEY_THROTTLE = ['KeyW', 'ArrowUp'];
const KEY_BRAKE = ['KeyS', 'ArrowDown'];
const KEY_LEFT = ['KeyA', 'ArrowLeft'];
const KEY_RIGHT = ['KeyD', 'ArrowRight'];

export class Input {
  readonly state: InputState = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    precise: false,
    horn: false,
  };

  settings: InputSettings = { steerSensitivity: 1, invertSteer: false };

  /** True when any gamepad provided input recently (used by HUD hints). */
  gamepadActive = false;

  private keys = new Set<string>();
  private taps: TapAction[] = [];
  private prevPadButtons: boolean[] = [];
  private rawSteer = 0;
  private enabled = true;
  private firstGestureFns: Array<() => void> = [];
  private gestureSeen = false;

  constructor() {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.releaseAll());
    const gesture = () => {
      if (this.gestureSeen) return;
      this.gestureSeen = true;
      for (const fn of this.firstGestureFns) fn();
      this.firstGestureFns.length = 0;
    };
    window.addEventListener('keydown', gesture, { once: false });
    window.addEventListener('pointerdown', gesture, { once: false });
  }

  /** Run once on the first user gesture (needed to unlock the AudioContext). */
  onFirstGesture(fn: () => void): void {
    if (this.gestureSeen) fn();
    else this.firstGestureFns.push(fn);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.releaseAll();
  }

  /** Drain tap actions queued since last call. */
  drainTaps(): TapAction[] {
    const t = this.taps;
    this.taps = [];
    return t;
  }

  private releaseAll(): void {
    this.keys.clear();
    this.state.throttle = 0;
    this.state.brake = 0;
    this.state.handbrake = false;
    this.state.horn = false;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.repeat) return;
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    // Pause/help must work even when driving input is disabled (menus handle their own keys).
    if (down) {
      if (e.code === 'KeyP' || e.code === 'Escape') {
        this.taps.push('pause');
        return;
      }
      if (e.key === '?' || e.code === 'Slash') {
        this.taps.push('help');
        return;
      }
    }

    if (!this.enabled) return;

    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);

    if (!down) return;
    switch (e.code) {
      case 'KeyQ': this.taps.push('signalLeft'); break;
      case 'KeyE': this.taps.push('signalRight'); break;
      case 'Comma': this.taps.push('checkLeft'); break;
      case 'Period': this.taps.push('checkRight'); break;
      case 'KeyM': this.taps.push('mirror'); break;
      case 'KeyC': this.taps.push('camera'); break;
      case 'KeyV': this.taps.push('cockpit'); break;
      case 'KeyR': this.taps.push('respawn'); break;
      case 'KeyL': this.taps.push('headlights'); break;
      case 'KeyU': this.taps.push('wipers'); break;
      case 'KeyX': this.taps.push('gearToggle'); break;
      case 'Tab': this.taps.push('hazards'); e.preventDefault(); break;
      default: break;
    }
    if (e.code === 'Space') e.preventDefault();
  }

  private anyKey(codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  update(dt: number): void {
    if (!this.enabled) {
      this.state.throttle = 0;
      this.state.brake = 0;
      this.state.steer = 0;
      this.state.handbrake = false;
      this.state.horn = false;
      return;
    }

    const s = this.state;
    s.precise = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    s.handbrake = this.keys.has('Space');
    s.horn = this.keys.has('KeyH');

    // --- keyboard analog emulation -----------------------------------
    const tUp = this.anyKey(KEY_THROTTLE);
    const tDown = this.anyKey(KEY_BRAKE);
    const throttleMax = s.precise ? 0.45 : 1;
    const attack = s.precise ? 1.6 : 2.8;
    s.throttle = clamp01(s.throttle + (tUp ? attack : -6) * dt);
    s.throttle = Math.min(s.throttle, tUp ? throttleMax : s.throttle);
    s.brake = clamp01(s.brake + (tDown ? 3.2 : -8) * dt);

    const left = this.anyKey(KEY_LEFT);
    const right = this.anyKey(KEY_RIGHT);
    const steerTarget = left === right ? 0 : left ? 1 : -1; // +1 = left
    const steerAttack = (steerTarget === 0 ? 4.5 : 2.6) * this.settings.steerSensitivity;
    this.rawSteer = clamp(this.rawSteer + clamp(steerTarget - this.rawSteer, -1, 1) * steerAttack * dt, -1, 1);
    s.steer = this.rawSteer;

    // --- gamepad ------------------------------------------------------
    this.pollGamepad();
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads.find((p) => p && p.connected);
    if (!pad) return;

    const dead = (v: number) => (Math.abs(v) < 0.12 ? 0 : v);
    const axisSteer = dead(pad.axes[0] ?? 0);
    const rt = pad.buttons[7]?.value ?? 0;
    const lt = pad.buttons[6]?.value ?? 0;

    let used = false;
    if (Math.abs(axisSteer) > 0) {
      // stick right = steer right = negative (physics left-positive)
      const shaped = Math.sign(axisSteer) * Math.pow(Math.abs(axisSteer), 1.4);
      this.state.steer = clamp((this.settings.invertSteer ? 1 : -1) * shaped * this.settings.steerSensitivity, -1, 1);
      this.rawSteer = this.state.steer;
      used = true;
    }
    if (rt > 0.02) {
      this.state.throttle = clamp01(rt) * (this.state.precise ? 0.45 : 1);
      used = true;
    }
    if (lt > 0.02) {
      this.state.brake = clamp01(lt);
      used = true;
    }
    if (pad.buttons[13]?.pressed) this.state.handbrake = true; // dpad down (hold)
    if (pad.buttons[1]?.pressed) this.state.horn = true; // B / Circle

    const tapMap: Array<[number, TapAction]> = [
      [0, 'gearToggle'], // A / Cross
      [4, 'signalLeft'], // LB
      [5, 'signalRight'], // RB
      [2, 'mirror'], // X / Square
      [3, 'camera'], // Y / Triangle
      [14, 'checkLeft'], // dpad left
      [15, 'checkRight'], // dpad right
      [12, 'cockpit'], // dpad up
      [9, 'pause'], // start
      [8, 'help'], // back
      [10, 'headlights'], // LS click
      [11, 'hazards'], // RS click
    ];
    for (const [idx, action] of tapMap) {
      const pressed = pad.buttons[idx]?.pressed ?? false;
      if (pressed && !this.prevPadButtons[idx]) this.taps.push(action);
      this.prevPadButtons[idx] = pressed;
      if (pressed) used = true;
    }
    if (used) this.gamepadActive = true;
  }
}

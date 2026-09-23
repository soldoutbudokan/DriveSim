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

/** Vehicle feedback the keyboard emulation shapes itself around. */
export interface DriveFeedback {
  /** Current speed, m/s. */
  speed: number;
  /** Largest normalized steer a held key may ask for at this speed (0..1]. */
  steerLimit: number;
}

/**
 * Keyboard brake pedal levels. A held S is a firm service stop that stays
 * under the examiner's harsh-braking line (~0.46 g); Shift+S is a gentle
 * scrub; a quick double-tap-and-hold of S is an emergency stop (ABS).
 */
export const KEY_BRAKE_SERVICE = 0.28;
export const KEY_BRAKE_GENTLE = 0.17;
const DOUBLE_TAP_S = 0.32;
/** The second press must be held this long, so tap-tap speed scrubbing stays smooth. */
const EMERGENCY_HOLD_S = 0.12;

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
  /** Driver is actively steering (key held or stick deflected) — assists stand down. */
  steerHeld = false;
  /** Emergency braking engaged: brake key double-tapped and held. */
  emergencyBrake = false;

  private keys = new Set<string>();
  private taps: TapAction[] = [];
  private prevPadButtons: boolean[] = [];
  private rawSteer = 0;
  private enabled = true;
  private firstGestureFns: Array<() => void> = [];
  private gestureSeen = false;
  /** Seconds of input time, for double-tap detection. */
  private clock = 0;
  private lastBrakeDown = -99;
  private brakeDoubleTap = false;

  constructor() {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.reset());
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

  /**
   * Driving input on/off. While off (menus up) only pause/help register, and
   * Tab/Space reach the page so menus can be driven from the keyboard.
   */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      // a pause/help press racing the menu opening must not be dropped
      const ui = this.taps.filter((t) => t === 'pause' || t === 'help');
      this.reset();
      this.taps.push(...ui);
    }
  }

  /** Drain tap actions queued since last call. */
  drainTaps(): TapAction[] {
    const t = this.taps;
    this.taps = [];
    return t;
  }

  reset(): void {
    this.keys.clear();
    this.taps.length = 0;
    this.prevPadButtons.length = 0;
    this.rawSteer = 0;
    this.steerHeld = false;
    this.emergencyBrake = false;
    this.brakeDoubleTap = false;
    this.state.throttle = 0;
    this.state.brake = 0;
    this.state.steer = 0;
    this.state.precise = false;
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

    if (KEY_BRAKE.includes(e.code)) {
      if (down && !this.anyKey(KEY_BRAKE)) {
        this.brakeDoubleTap = this.clock - this.lastBrakeDown < DOUBLE_TAP_S;
        this.lastBrakeDown = this.clock;
      }
    }
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (!this.anyKey(KEY_BRAKE)) this.brakeDoubleTap = false;

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

  update(dt: number, drive: DriveFeedback = { speed: 0, steerLimit: 1 }): void {
    this.clock += dt;
    if (!this.enabled) {
      this.state.throttle = 0;
      this.state.brake = 0;
      this.state.steer = 0;
      this.state.handbrake = false;
      this.state.horn = false;
      this.steerHeld = false;
      return;
    }

    const s = this.state;
    s.precise = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    s.handbrake = this.keys.has('Space');
    s.horn = this.keys.has('KeyH');

    // --- keyboard analog emulation -----------------------------------
    // Ramps stand in for pedal feel: holding W rolls into the throttle
    // over ~0.7 s; the brake settles at a smooth service level unless the
    // driver double-taps for an emergency stop.
    const tUp = this.anyKey(KEY_THROTTLE);
    const tDown = this.anyKey(KEY_BRAKE);
    const throttleMax = s.precise ? 0.45 : 1;
    const attack = s.precise ? 1.0 : 1.5;
    s.throttle = clamp01(s.throttle + (tUp ? attack : -6) * dt);
    s.throttle = Math.min(s.throttle, tUp ? throttleMax : s.throttle);
    this.emergencyBrake = tDown && this.brakeDoubleTap && this.clock - this.lastBrakeDown >= EMERGENCY_HOLD_S;
    const brakeLevel = !tDown ? 0 : this.emergencyBrake ? 1 : s.precise ? KEY_BRAKE_GENTLE : KEY_BRAKE_SERVICE;
    const brakeRate = brakeLevel > s.brake ? (this.emergencyBrake ? 5 : 1.2) : 6;
    s.brake = clamp01(s.brake + clamp(brakeLevel - s.brake, -brakeRate * dt, brakeRate * dt));

    // Steering builds quickly at parking speeds and more slowly as speed
    // rises, and a held key is capped at a firm-but-safe cornering load, so
    // a tap nudges the car at 100 km/h instead of throwing it across lanes.
    const left = this.anyKey(KEY_LEFT);
    const right = this.anyKey(KEY_RIGHT);
    const sens = this.settings.steerSensitivity;
    const limit = Math.min(1, drive.steerLimit * sens);
    const steerTarget = left === right ? 0 : (left ? 1 : -1) * limit; // +left
    const outward = steerTarget !== 0 && Math.abs(steerTarget) > Math.abs(this.rawSteer) && Math.sign(steerTarget) === Math.sign(this.rawSteer || steerTarget);
    const steerRate = outward ? (2.6 / (1 + drive.speed / 12)) * sens : 4.5;
    this.rawSteer = clamp(this.rawSteer + clamp(steerTarget - this.rawSteer, -steerRate * dt, steerRate * dt), -1, 1);
    s.steer = this.rawSteer;
    this.steerHeld = left !== right;

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
      this.steerHeld = true;
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

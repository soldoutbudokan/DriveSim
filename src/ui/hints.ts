/**
 * Contextual control hints: a short strip of "press this now" chips above
 * the dashboard. Control hints (how to get moving, reverse, emergency stop)
 * always show; habit hints (mirror, shoulder check, lights, wipers) only
 * when coaching is on — the examiner never prompts.
 */

export type HintAction =
  | 'throttle'
  | 'brake'
  | 'steer'
  | 'reverse'
  | 'signal'
  | 'checkLeft'
  | 'checkRight'
  | 'mirror'
  | 'lights'
  | 'wipers'
  | 'park'
  | 'help';

export interface Hint {
  keys: HintAction[];
  text: string;
  tone?: 'info' | 'warn';
}

export interface HintContext {
  /** Habit prompts allowed (free roam / lessons, not the examiner). */
  coaching: boolean;
  /** Seconds since this drive started — basics show for the first stretch. */
  driveTime: number;
  speedKmh: number;
  gear: 'P' | 'R' | 'N' | 'D';
  throttle: number;
  signal: 'off' | 'left' | 'right';
  signalAge: number;
  /** A shoulder check toward the signalled side since the signal went on. */
  shoulderChecked: boolean;
  scanAge: number;
  night: boolean;
  headlights: boolean;
  raining: boolean;
  wipers: boolean;
  emergencyBrake: boolean;
}

const BASICS_FOR = 40;

export function pickHints(c: HintContext): Hint[] {
  const out: Hint[] = [];
  const stopped = c.speedKmh < 1;

  if (c.emergencyBrake) out.push({ keys: ['brake'], text: 'Emergency braking', tone: 'warn' });
  if (c.gear === 'P' && stopped) out.push({ keys: ['throttle'], text: 'Drive' });
  if (c.gear === 'R') out.push({ keys: ['throttle'], text: 'Reverse' }, { keys: ['reverse'], text: 'Back to Drive' });

  if (c.coaching) {
    if (c.signal !== 'off' && !c.shoulderChecked && c.signalAge > 0.6) {
      out.push({ keys: [c.signal === 'left' ? 'checkLeft' : 'checkRight'], text: 'Shoulder check', tone: 'warn' });
    }
    if (c.speedKmh > 10 && c.scanAge > 11) out.push({ keys: ['mirror'], text: 'Check your mirror', tone: 'warn' });
    if (c.night && !c.headlights) out.push({ keys: ['lights'], text: 'Headlights', tone: 'warn' });
    if (c.raining && !c.wipers) out.push({ keys: ['wipers'], text: 'Wipers', tone: 'warn' });
  }

  if (c.driveTime < BASICS_FOR && out.length < 2) {
    if (c.gear !== 'P' && c.gear !== 'R') out.push({ keys: ['throttle', 'brake'], text: 'Go / brake' });
    out.push({ keys: ['steer'], text: 'Steer' }, { keys: ['signal'], text: 'Signal' });
    if (stopped && c.gear === 'D') out.push({ keys: ['reverse'], text: 'Reverse' });
    out.push({ keys: ['help'], text: 'All controls' });
  }
  return out.slice(0, 4);
}

/** Key caps for each action, keyboard and gamepad. */
export const HINT_KEYS: Record<HintAction, { kb: string[]; pad: string[] }> = {
  throttle: { kb: ['W'], pad: ['RT'] },
  brake: { kb: ['S'], pad: ['LT'] },
  steer: { kb: ['A', 'D'], pad: ['L-stick'] },
  reverse: { kb: ['X'], pad: ['A'] },
  signal: { kb: ['Q', 'E'], pad: ['LB', 'RB'] },
  checkLeft: { kb: [','], pad: ['◀'] },
  checkRight: { kb: ['.'], pad: ['▶'] },
  mirror: { kb: ['M'], pad: ['X'] },
  lights: { kb: ['L'], pad: ['L3'] },
  wipers: { kb: ['U'], pad: ['U'] },
  park: { kb: ['Space'], pad: ['▼'] },
  help: { kb: ['?'], pad: ['Back'] },
};

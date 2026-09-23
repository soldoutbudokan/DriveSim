import { describe, expect, it } from 'vitest';
import { pickHints, type HintContext } from '../src/ui/hints';

const ctx = (over: Partial<HintContext> = {}): HintContext => ({
  coaching: true,
  driveTime: 120,
  speedKmh: 40,
  gear: 'D',
  throttle: 0.3,
  signal: 'off',
  signalAge: 0,
  shoulderChecked: false,
  scanAge: 2,
  night: false,
  headlights: false,
  raining: false,
  wipers: false,
  emergencyBrake: false,
  ...over,
});

const texts = (c: HintContext): string[] => pickHints(c).map((h) => h.text);

describe('control hints', () => {
  it('tells a new driver how to get out of Park', () => {
    expect(pickHints(ctx({ gear: 'P', speedKmh: 0 }))[0]).toMatchObject({ keys: ['throttle'], text: 'Drive' });
  });

  it('prompts the shoulder check on the signalled side', () => {
    const hints = pickHints(ctx({ signal: 'right', signalAge: 1.5 }));
    expect(hints[0]).toMatchObject({ keys: ['checkRight'], tone: 'warn' });
    expect(texts(ctx({ signal: 'right', signalAge: 1.5, shoulderChecked: true }))).not.toContain('Shoulder check');
  });

  it('never coaches habits in examiner mode', () => {
    const exam = ctx({ coaching: false, scanAge: 30, night: true, signal: 'left', signalAge: 3 });
    expect(texts(exam)).toEqual([]);
    expect(texts({ ...exam, coaching: true })).toEqual(expect.arrayContaining(['Shoulder check', 'Check your mirror', 'Headlights']));
  });

  it('shows the basics only at the start of a drive', () => {
    expect(texts(ctx({ driveTime: 5 }))).toContain('Steer');
    expect(texts(ctx({ driveTime: 90 }))).toEqual([]);
  });

  it('caps the strip at four chips', () => {
    const busy = ctx({ driveTime: 1, gear: 'R', scanAge: 30, night: true, raining: true, signal: 'left', signalAge: 2 });
    expect(pickHints(busy).length).toBeLessThanOrEqual(4);
  });
});

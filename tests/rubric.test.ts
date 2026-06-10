import { describe, expect, it } from 'vitest';
import { computeReport, PASS_MARK } from '../src/scoring/rubric';
import type { Fault } from '../src/core/types';

const f = (code: string, category: Fault['category'], severity: Fault['severity']): Fault => ({
  code,
  category,
  severity,
  message: code,
  time: 10,
  x: 0,
  z: 0,
});

describe('exam rubric', () => {
  it('clean drive passes with 100', () => {
    const r = computeReport([], 100, 900, 8);
    expect(r.passed).toBe(true);
    expect(r.overall).toBe(100);
    expect(r.recommendations.length).toBe(0);
  });

  it('a few minors still pass', () => {
    const r = computeReport([f('lane-drift', 'driving', 'minor'), f('late-signal-turn', 'turns', 'minor')], 95, 900, 8);
    expect(r.passed).toBe(true);
    expect(r.overall).toBeGreaterThanOrEqual(PASS_MARK);
  });

  it('any autofail fails regardless of score', () => {
    const r = computeReport([f('ran-red', 'intersections', 'autofail')], 100, 900, 8);
    expect(r.passed).toBe(false);
    expect(r.autoFail?.code).toBe('ran-red');
  });

  it('a dangerous action fails even with a high overall', () => {
    const r = computeReport([f('left-across-traffic', 'turns', 'dangerous')], 100, 900, 8);
    expect(r.passed).toBe(false);
    expect(r.overall).toBeGreaterThan(PASS_MARK); // points alone would pass
  });

  it('an accumulation of majors fails on points', () => {
    const faults = [
      f('rolling-stop', 'intersections', 'major'),
      f('row-allway', 'intersections', 'major'),
      f('no-shoulder-check', 'observation', 'major'),
      f('speeding', 'driving', 'major'),
      f('tailgating', 'driving', 'major'),
      f('merge-too-slow', 'highway', 'major'),
      f('no-signal-lane-change', 'laneChanges', 'major'),
      f('straddling', 'driving', 'major'),
    ];
    const r = computeReport(faults, 60, 900, 8);
    expect(r.overall).toBeLessThan(PASS_MARK);
    expect(r.passed).toBe(false);
  });

  it('recommendations target the weakest categories and dedupe lessons', () => {
    const faults = [
      f('merge-no-signal', 'highway', 'major'),
      f('merge-too-slow', 'highway', 'major'),
      f('rolling-stop', 'intersections', 'major'),
      f('no-signal-turn', 'turns', 'major'),
    ];
    const r = computeReport(faults, 90, 900, 8);
    expect(r.recommendations.length).toBeGreaterThan(0);
    expect(r.recommendations[0].lessonId).toBe('highway'); // weakest first
    const ids = r.recommendations.map((x) => x.lessonId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('observation category is capped by the scan score', () => {
    const r = computeReport([], 40, 900, 8);
    const obs = r.categories.find((c) => c.id === 'observation')!;
    expect(obs.score).toBe(40);
  });
});

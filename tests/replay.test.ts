import { describe, expect, it } from 'vitest';
import { buildAgentOffsets, duration, frameIndexAt, pack, sampleAt, type RecFrame, type ReplayMetaInfo } from '../src/replay/format';

const meta: ReplayMetaInfo = {
  mode: 'free',
  at: 0,
  durationS: 2,
  weather: 'clear',
  hour: 13,
  observationScore: 90,
  counters: { laneChanges: 2, mirrorChecks: 5, shoulderChecks: 3, merges: 1 },
  score: null,
  passed: null,
};

function mkFrames(): RecFrame[] {
  const out: RecFrame[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i * 0.05;
    out.push({
      t,
      x: t * 10,
      z: 5,
      y: 0,
      heading: t * 0.1,
      speed: 10,
      steer: 0.05,
      flags: i % 2 ? 1 : 0,
      agents: i % 3 === 0 ? [{ k: 0, x: 1, z: 2, h: 0.5 }, { k: 9, x: 3, z: 4, h: 1 }] : [{ k: 2, x: 7, z: 8, h: 2 }],
    });
  }
  return out;
}

describe('replay codec', () => {
  it('round-trips player samples with interpolation', () => {
    const p = pack(mkFrames(), [], meta, []);
    expect(duration(p)).toBeCloseTo(2, 5);
    const s = sampleAt(p, 1.025)!; // halfway between two frames
    expect(s.x).toBeCloseTo(10.25, 2);
    expect(s.speed).toBeCloseTo(10, 5);
    expect(s.heading).toBeCloseTo(0.1025, 3);
  });

  it('clamps sampling beyond the ends', () => {
    const p = pack(mkFrames(), [], meta, []);
    expect(sampleAt(p, -5)!.x).toBeCloseTo(0, 5);
    expect(sampleAt(p, 99)!.x).toBeCloseTo(20, 5);
  });

  it('frame index binary search is consistent', () => {
    const p = pack(mkFrames(), [], meta, []);
    expect(frameIndexAt(p, 0)).toBe(0);
    expect(frameIndexAt(p, 0.051)).toBe(1);
    expect(frameIndexAt(p, 2)).toBe(40);
  });

  it('agents are preserved per frame with offsets', () => {
    const p = pack(mkFrames(), [], meta, []);
    const offsets = buildAgentOffsets(p);
    const s0 = sampleAt(p, 0, offsets)!; // frame 0: 2 agents
    expect(s0.agents.length).toBe(2);
    expect(s0.agents[1].k).toBe(9);
    const s1 = sampleAt(p, 0.07, offsets)!; // inside frame 1 (float32 times): 1 agent
    expect(s1.agents.length).toBe(1);
    expect(s1.agents[0].x).toBeCloseTo(7, 5);
  });

  it('handles heading wrap interpolation', () => {
    const frames: RecFrame[] = [
      { t: 0, x: 0, z: 0, y: 0, heading: 3.1, speed: 5, steer: 0, flags: 0, agents: [] },
      { t: 1, x: 1, z: 0, y: 0, heading: -3.1, speed: 5, steer: 0, flags: 0, agents: [] },
    ];
    const p = pack(frames, [], meta, []);
    const s = sampleAt(p, 0.5)!;
    // should go the short way around (through ±π), not through 0
    expect(Math.abs(s.heading)).toBeGreaterThan(3.1);
  });
});

/**
 * Replay payload format: typed-array packed (IndexedDB stores these
 * natively). Pure pack/sample functions so the codec is unit-testable.
 *
 * player frame: t, x, z, y, heading, speed, steer  (7 floats) + flag byte
 * agents:       kind, x, z, heading                (4 floats each)
 * series @5Hz:  t, speedKmh, limitKmh, gLong, gLat, gapS, x, z (8 floats)
 */

import type { Fault, WeatherKind } from '../core/types';

export const AGENT_KINDS = [
  'sedan',
  'hatch',
  'suv',
  'taxi',
  'police',
  'ambulance',
  'firetruck',
  'truck',
  'schoolbus',
  'streetcar',
  'cyclist',
  'ped',
] as const;

export type AgentKindName = (typeof AGENT_KINDS)[number];

export const FLAG = {
  sigL: 1,
  sigR: 2,
  brake: 4,
  headlights: 8,
  reverse: 16,
} as const;

export interface RecFrame {
  t: number;
  x: number;
  z: number;
  y: number;
  heading: number;
  speed: number;
  steer: number;
  flags: number;
  agents: Array<{ k: number; x: number; z: number; h: number }>;
}

export interface ReplayCounters {
  laneChanges: number;
  mirrorChecks: number;
  shoulderChecks: number;
  merges: number;
}

export interface ReplayMetaInfo {
  mode: string;
  at: number;
  durationS: number;
  weather: WeatherKind;
  hour: number;
  observationScore: number;
  counters: ReplayCounters;
  score: number | null;
  passed: boolean | null;
}

export interface ReplayPayload {
  version: 1;
  meta: ReplayMetaInfo;
  playerBuf: Float32Array;
  flagsBuf: Uint8Array;
  agentCounts: Uint16Array;
  agentBuf: Float32Array;
  series: Float32Array;
  faults: Fault[];
}

export const PLAYER_STRIDE = 7;
export const AGENT_STRIDE = 4;
export const SERIES_STRIDE = 8;

export function pack(frames: RecFrame[], series: number[], meta: ReplayMetaInfo, faults: Fault[]): ReplayPayload {
  const n = frames.length;
  const playerBuf = new Float32Array(n * PLAYER_STRIDE);
  const flagsBuf = new Uint8Array(n);
  const agentCounts = new Uint16Array(n);
  let total = 0;
  for (const f of frames) total += f.agents.length;
  const agentBuf = new Float32Array(total * AGENT_STRIDE);
  let ai = 0;
  frames.forEach((f, i) => {
    playerBuf.set([f.t, f.x, f.z, f.y, f.heading, f.speed, f.steer], i * PLAYER_STRIDE);
    flagsBuf[i] = f.flags;
    agentCounts[i] = f.agents.length;
    for (const a of f.agents) {
      agentBuf.set([a.k, a.x, a.z, a.h], ai * AGENT_STRIDE);
      ai++;
    }
  });
  return {
    version: 1,
    meta,
    playerBuf,
    flagsBuf,
    agentCounts,
    agentBuf,
    series: new Float32Array(series),
    faults,
  };
}

export interface SampledFrame {
  x: number;
  z: number;
  y: number;
  heading: number;
  speed: number;
  steer: number;
  flags: number;
  agents: Array<{ k: number; x: number; z: number; h: number }>;
}

/** Index of the last frame with t <= time (binary search). */
export function frameIndexAt(p: ReplayPayload, time: number): number {
  const n = p.flagsBuf.length;
  if (n === 0) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.playerBuf[mid * PLAYER_STRIDE] <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function agentOffset(p: ReplayPayload, frame: number): number {
  // prefix sum on the fly (cached externally if needed; frame counts are small)
  let off = 0;
  for (let i = 0; i < frame; i++) off += p.agentCounts[i];
  return off;
}

/** Interpolated sample at `time` (agents snap to the earlier frame, matched by slot). */
export function sampleAt(p: ReplayPayload, time: number, agentOffsets?: Uint32Array): SampledFrame | null {
  const n = p.flagsBuf.length;
  if (n === 0) return null;
  const i = Math.max(0, frameIndexAt(p, time));
  const j = Math.min(n - 1, i + 1);
  const a = i * PLAYER_STRIDE;
  const b = j * PLAYER_STRIDE;
  const t0 = p.playerBuf[a];
  const t1 = p.playerBuf[b];
  const u = t1 > t0 ? Math.min(1, Math.max(0, (time - t0) / (t1 - t0))) : 0;
  const lerp = (x: number, y: number): number => x + (y - x) * u;
  let dh = p.playerBuf[b + 4] - p.playerBuf[a + 4];
  if (dh > Math.PI) dh -= Math.PI * 2;
  if (dh < -Math.PI) dh += Math.PI * 2;

  const off = agentOffsets ? agentOffsets[i] : agentOffset(p, i);
  const count = p.agentCounts[i];
  const agents: SampledFrame['agents'] = [];
  for (let k = 0; k < count; k++) {
    const o = (off + k) * AGENT_STRIDE;
    agents.push({ k: p.agentBuf[o], x: p.agentBuf[o + 1], z: p.agentBuf[o + 2], h: p.agentBuf[o + 3] });
  }
  return {
    x: lerp(p.playerBuf[a + 1], p.playerBuf[b + 1]),
    z: lerp(p.playerBuf[a + 2], p.playerBuf[b + 2]),
    y: lerp(p.playerBuf[a + 3], p.playerBuf[b + 3]),
    heading: p.playerBuf[a + 4] + dh * u,
    speed: lerp(p.playerBuf[a + 5], p.playerBuf[b + 5]),
    steer: lerp(p.playerBuf[a + 6], p.playerBuf[b + 6]),
    flags: p.flagsBuf[i],
    agents,
  };
}

/** Precompute per-frame agent offsets for O(1) sampling. */
export function buildAgentOffsets(p: ReplayPayload): Uint32Array {
  const out = new Uint32Array(p.agentCounts.length);
  let acc = 0;
  for (let i = 0; i < p.agentCounts.length; i++) {
    out[i] = acc;
    acc += p.agentCounts[i];
  }
  return out;
}

export function duration(p: ReplayPayload): number {
  const n = p.flagsBuf.length;
  return n ? p.playerBuf[(n - 1) * PLAYER_STRIDE] : 0;
}

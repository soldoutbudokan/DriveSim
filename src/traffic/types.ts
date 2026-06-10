/** Shared traffic types: every entity that occupies road space is a RoadUser. */

import type { Lane } from '../world/network';

export type UserKind = 'car' | 'streetcar' | 'schoolbus' | 'emergency' | 'cyclist' | 'player' | 'blocker';

export interface RoadUser {
  id: string;
  kind: UserKind;
  x: number;
  z: number;
  heading: number;
  speed: number;
  halfL: number;
  halfW: number;
  /** Current lane occupancy (null when off-network). */
  laneId: string | null;
  s: number;
}

export interface LeaderInfo {
  user: RoadUser;
  /** Bumper-to-bumper gap in metres. */
  gap: number;
}

/** Intelligent Driver Model acceleration. */
export function idm(
  v: number,
  v0: number,
  leaderGap: number | null,
  leaderSpeed: number,
  aMax = 1.6,
  b = 2.4,
  T = 1.35,
  s0 = 2.2,
): number {
  const free = aMax * (1 - Math.pow(Math.max(v, 0) / Math.max(v0, 0.1), 4));
  if (leaderGap === null) return free;
  const dv = v - leaderSpeed;
  const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(aMax * b)));
  const inter = -aMax * Math.pow(sStar / Math.max(leaderGap, 0.5), 2);
  return Math.max(-7, free + inter);
}

/** Time to collision between a follower and a stationary point `dist` ahead. */
export function timeToReach(dist: number, speed: number): number {
  return speed < 0.3 ? Infinity : dist / speed;
}

export interface LaneRef {
  lane: Lane;
  s: number;
}

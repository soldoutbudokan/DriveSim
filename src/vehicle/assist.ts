/**
 * Steering assist. Keyboard steering integrates into heading error, so a
 * straight road needs constant micro-corrections. When the driver lets go
 * and the car is nearly aligned with its lane, this asks for just enough
 * wheel to run parallel to the lane. It never centres the car in the lane,
 * and it drops out for turns (large heading error) and at parking speeds.
 */

import { angleDiff, clamp } from '../core/math';
import type { Vehicle } from './vehicle';

export interface LaneSample {
  /** Lane travel direction at the nearest point (rad). */
  heading: number;
  /** Offset from the lane centre, m (+left). */
  lateral: number;
}

const MAX_ERR = 0.14; // ~8°: beyond this the driver is turning, not drifting
const ALIGN_RATE = 1.5; // 1/s — closes the heading error in well under a second

/** Normalized steer (-0.25..0.25, +left) that aligns the car with `lane`. */
export function laneAlignSteer(v: Vehicle, lane: LaneSample | null): number {
  if (!lane || v.vx < 5 || Math.abs(lane.lateral) > 2.6) return 0;
  const err = angleDiff(lane.heading, v.heading); // + = lane runs to our left
  if (Math.abs(err) > MAX_ERR) return 0;
  const wheel = (err * ALIGN_RATE * (v.p.a + v.p.b)) / v.vx;
  return clamp(wheel / v.maxSteerNow, -0.25, 0.25);
}

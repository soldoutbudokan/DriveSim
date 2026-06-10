/** Math helpers shared across physics, world generation and AI. */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : clamp01((v - a) / (b - a)));
export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Frame-rate independent exponential smoothing toward a target. */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Wrap an angle to (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
};

/** Shortest signed difference between two angles. */
export const angleDiff = (a: number, b: number): number => wrapAngle(a - b);

export const dampAngle = (current: number, target: number, lambda: number, dt: number): number =>
  current + angleDiff(target, current) * (1 - Math.exp(-lambda * dt));

export const kmh = (ms: number): number => ms * 3.6;
export const ms = (kmhV: number): number => kmhV / 3.6;

/** Deterministic PRNG (mulberry32) so world generation is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* 2D ground-plane vectors. World axes: +x east, +z south, y up.       */
/* Heading h: forward = (sin h, cos h); h increases turning LEFT.      */
/* ------------------------------------------------------------------ */

export interface V2 {
  x: number;
  z: number;
}

export const v2 = (x: number, z: number): V2 => ({ x, z });
export const v2add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, z: a.z + b.z });
export const v2sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, z: a.z - b.z });
export const v2scale = (a: V2, s: number): V2 => ({ x: a.x * s, z: a.z * s });
export const v2dot = (a: V2, b: V2): number => a.x * b.x + a.z * b.z;
/** 2D cross product (y component of 3D cross with both vectors in the ground plane). */
export const v2cross = (a: V2, b: V2): number => a.z * b.x - a.x * b.z;
export const v2len = (a: V2): number => Math.hypot(a.x, a.z);
export const v2dist = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const v2norm = (a: V2): V2 => {
  const l = v2len(a);
  return l < 1e-9 ? { x: 0, z: 1 } : { x: a.x / l, z: a.z / l };
};
export const v2lerp = (a: V2, b: V2, t: number): V2 => ({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t) });

export const headingForward = (h: number): V2 => ({ x: Math.sin(h), z: Math.cos(h) });
/** Unit vector pointing to the driver's LEFT for a given heading (viewed from above). */
export const headingLeft = (h: number): V2 => ({ x: Math.cos(h), z: -Math.sin(h) });
export const headingOf = (dir: V2): number => Math.atan2(dir.x, dir.z);

/* ------------------------------------------------------------------ */
/* Polylines (lane centerlines, routes)                                */
/* ------------------------------------------------------------------ */

export interface PolySample {
  point: V2;
  /** Forward tangent at the sample. */
  dir: V2;
  /** Distance along the polyline. */
  s: number;
}

export function polylineLength(pts: V2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += v2dist(pts[i - 1], pts[i]);
  return l;
}

/** Sample a polyline at arc length s (clamped). */
export function polylineAt(pts: V2[], s: number): PolySample {
  if (pts.length === 1) return { point: pts[0], dir: { x: 0, z: 1 }, s: 0 };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = v2dist(pts[i - 1], pts[i]);
    if (acc + seg >= s || i === pts.length - 1) {
      const t = seg < 1e-9 ? 0 : clamp01((s - acc) / seg);
      return {
        point: v2lerp(pts[i - 1], pts[i], t),
        dir: v2norm(v2sub(pts[i], pts[i - 1])),
        s: clamp(s, 0, acc + seg),
      };
    }
    acc += seg;
  }
  return { point: pts[pts.length - 1], dir: { x: 0, z: 1 }, s: acc };
}

export interface NearestOnPolyline {
  s: number;
  /** Unsigned distance from query point to the polyline. */
  dist: number;
  /** Signed lateral offset: positive when the point is LEFT of travel direction. */
  lateral: number;
  point: V2;
  dir: V2;
}

export function nearestOnPolyline(pts: V2[], p: V2): NearestOnPolyline {
  let best: NearestOnPolyline = { s: 0, dist: Infinity, lateral: 0, point: pts[0], dir: { x: 0, z: 1 } };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const ab = v2sub(b, a);
    const segLen = v2len(ab);
    if (segLen < 1e-9) continue;
    const dir = v2scale(ab, 1 / segLen);
    const t = clamp01(v2dot(v2sub(p, a), dir) / segLen);
    const proj = v2add(a, v2scale(ab, t));
    const d = v2dist(p, proj);
    if (d < best.dist) {
      const rel = v2sub(p, proj);
      // positive lateral = left of direction of travel
      const lat = v2cross(dir, rel) >= 0 ? d : -d;
      best = { s: acc + t * segLen, dist: d, lateral: lat, point: proj, dir };
    }
    acc += segLen;
  }
  return best;
}

/** Offset a polyline laterally (positive = left of travel). Simple per-vertex normal offset. */
export function offsetPolyline(pts: V2[], offset: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dir = v2norm(v2sub(next, prev));
    const left: V2 = { x: dir.z, z: -dir.x }; // left of travel (matches headingLeft convention)
    out.push(v2add(pts[i], v2scale(left, offset)));
  }
  return out;
}

/** Sample an arc from `start`, initial direction `dir0`, signed curvature (left positive), length, step count. */
export function arcPoints(start: V2, heading0: number, curvature: number, length: number, steps = 16): V2[] {
  const pts: V2[] = [{ ...start }];
  let h = heading0;
  let p = { ...start };
  const ds = length / steps;
  for (let i = 0; i < steps; i++) {
    h += curvature * ds;
    const f = headingForward(h);
    p = v2add(p, v2scale(f, ds));
    pts.push({ ...p });
  }
  return pts;
}

/** Quadratic bezier sampler for ramp/turn geometry. */
export function bezier(p0: V2, p1: V2, p2: V2, steps = 18): V2[] {
  const pts: V2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = v2lerp(p0, p1, t);
    const b = v2lerp(p1, p2, t);
    pts.push(v2lerp(a, b, t));
  }
  return pts;
}

/** Cubic bezier sampler. */
export function bezier3(p0: V2, p1: V2, p2: V2, p3: V2, steps = 24): V2[] {
  const pts: V2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = v2lerp(p0, p1, t);
    const b = v2lerp(p1, p2, t);
    const c = v2lerp(p2, p3, t);
    const d = v2lerp(a, b, t);
    const e = v2lerp(b, c, t);
    pts.push(v2lerp(d, e, t));
  }
  return pts;
}

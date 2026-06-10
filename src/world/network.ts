/**
 * Road network model: nodes (intersections) + edges (streets) compiled into
 * directed lanes with polyline geometry, a spatial index for nearest-lane
 * queries, intersection control metadata (signals, stops, yields, roundabout),
 * turn connectivity for AI/routing, and node-graph pathfinding.
 */

import {
  angleDiff,
  clamp,
  headingOf,
  nearestOnPolyline,
  offsetPolyline,
  polylineAt,
  polylineLength,
  v2dist,
  type NearestOnPolyline,
  type V2,
} from '../core/math';

export type NodeControl = 'signal' | 'stop-all' | 'minor-stop' | 'minor-yield' | 'roundabout' | 'none' | 'dead-end';

export interface SignalDef {
  /** Cycle offset seconds (staggers green waves). */
  offset?: number;
  /** Axes that get a protected-left "advanced green" phase: 'NS' | 'EW'. */
  advance?: 'NS' | 'EW';
  /** Green durations. */
  nsGreen?: number;
  ewGreen?: number;
}

export interface NodeDef {
  id: string;
  x: number;
  z: number;
  control: NodeControl;
  signal?: SignalDef;
  /** For minor-stop / minor-yield: edges whose approaches must stop/yield. */
  minorEdges?: string[];
  /** Suppress crosswalks (highway nodes, ramp gores). */
  noCrosswalk?: boolean;
}

export type EdgeKind = 'city' | 'residential' | 'highway' | 'ramp' | 'lot' | 'roundabout';

export interface EdgeDef {
  id: string;
  from: string;
  to: string;
  via?: V2[];
  lanesF: number;
  lanesB: number;
  limit: number;
  kind: EdgeKind;
  name: string;
  area: string;
  streetcar?: boolean;
  /** Bike lanes on the curb side of each direction. */
  bike?: boolean;
  /** Curbside parking lane on the right of this direction of travel. */
  parkingF?: boolean;
  parkingB?: boolean;
  /** Leftmost lane is HOV (one-way highway edges). */
  hov?: boolean;
  /** This edge is a highway acceleration lane that must merge left at its end. */
  merge?: boolean;
  /** This edge is an exit ramp (signed as EXIT). */
  exit?: boolean;
  /** Construction closure of the rightmost F lane over [s0, s1]. */
  closureF?: [number, number];
  /** Elevation profile along the edge (defaults to flat). */
  elevation?: (s: number, len: number) => number;
  /** Hide centre line (lots, roundabout). */
  unmarked?: boolean;
}

export const LANE_W: Record<EdgeKind, number> = {
  city: 3.3,
  residential: 3.1,
  highway: 3.7,
  ramp: 4.2,
  roundabout: 4.6,
  lot: 3.2,
};

export const BIKE_W = 1.7;
export const PARK_W = 2.3;
export const SIDEWALK_W = 2.6;

export interface EdgeRT {
  def: EdgeDef;
  center: V2[];
  len: number;
  laneW: number;
  /** Paved half-width to the LEFT / RIGHT of the from→to direction. */
  halfL: number;
  halfR: number;
  hasElevation: boolean;
  elev(s: number): number;
}

export type Turn = 'straight' | 'left' | 'right' | 'uturn' | 'merge';

export interface Lane {
  id: string;
  edge: EdgeRT;
  /** 1 = travels from→to, -1 = to→from. */
  dir: 1 | -1;
  /** 0 = leftmost lane in travel direction. */
  index: number;
  laneCount: number;
  poly: V2[];
  len: number;
  width: number;
  speed: number;
  kind: 'drive' | 'bike';
  isHov: boolean;
  merge: boolean;
  exit: boolean;
  fromNode: string;
  toNode: string;
  /** Closed range [s0,s1] for construction, if any. */
  closed?: [number, number];
}

export interface LaneHit extends NearestOnPolyline {
  lane: Lane;
}

export interface LaneLink {
  lane: Lane;
  turn: Turn;
}

export interface NodeRT {
  def: NodeDef;
  /** Paved radius of the intersection box. */
  radius: number;
  /** Lanes arriving at this node. */
  inbound: Lane[];
  /** Lanes departing this node. */
  outbound: Lane[];
  edges: EdgeRT[];
}

/** Compass axis of a heading (forward = (sin h, cos h); -z is north). */
export function compassOf(heading: number): 'N' | 'S' | 'E' | 'W' {
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? 'E' : 'W';
  return fz > 0 ? 'S' : 'N';
}

export function axisOf(heading: number): 'NS' | 'EW' {
  const c = compassOf(heading);
  return c === 'N' || c === 'S' ? 'NS' : 'EW';
}

export function classifyTurn(approachHeading: number, departHeading: number): Turn {
  const d = angleDiff(departHeading, approachHeading);
  const deg = (d * 180) / Math.PI;
  if (Math.abs(deg) < 32) return 'straight';
  if (Math.abs(deg) > 148) return 'uturn';
  return deg > 0 ? 'left' : 'right';
}

const GRID = 26;

export class RoadNetwork {
  readonly nodes = new Map<string, NodeRT>();
  readonly edges = new Map<string, EdgeRT>();
  readonly lanes: Lane[] = [];
  private laneGrid = new Map<string, Lane[]>();
  private edgeGrid = new Map<string, EdgeRT[]>();
  /** lane successors cache. */
  private succ = new Map<string, LaneLink[]>();

  constructor(nodeDefs: NodeDef[], edgeDefs: EdgeDef[]) {
    for (const nd of nodeDefs) {
      this.nodes.set(nd.id, { def: nd, radius: 6, inbound: [], outbound: [], edges: [] });
    }

    for (const ed of edgeDefs) {
      const a = this.nodes.get(ed.from);
      const b = this.nodes.get(ed.to);
      if (!a || !b) throw new Error(`edge ${ed.id}: missing node ${ed.from} or ${ed.to}`);
      const center: V2[] = [{ x: a.def.x, z: a.def.z }, ...(ed.via ?? []), { x: b.def.x, z: b.def.z }];
      const len = polylineLength(center);
      const laneW = LANE_W[ed.kind];
      const extraF = (ed.bike ? BIKE_W : 0) + (ed.parkingF ? PARK_W : 0);
      const extraB = (ed.bike ? BIKE_W : 0) + (ed.parkingB ? PARK_W : 0);
      let halfR: number;
      let halfL: number;
      if (ed.lanesB === 0) {
        // one-way: lanes centred on the centerline
        halfR = (ed.lanesF * laneW) / 2 + extraF + 0.3;
        halfL = (ed.lanesF * laneW) / 2 + 0.3;
      } else {
        halfR = ed.lanesF * laneW + extraF + 0.25;
        halfL = ed.lanesB * laneW + extraB + 0.25;
      }
      // paved shoulders on the highway / ramps
      if (ed.kind === 'highway') {
        halfL += 2.2;
        halfR += 2.2;
      } else if (ed.kind === 'ramp') {
        halfL += 1.0;
        halfR += 1.0;
      }
      const elevFn = ed.elevation;
      const rt: EdgeRT = {
        def: ed,
        center,
        len,
        laneW,
        halfL,
        halfR,
        hasElevation: !!elevFn,
        elev: elevFn ? (s: number) => elevFn(clamp(s, 0, len), len) : () => 0,
      };
      this.edges.set(ed.id, rt);
      a.edges.push(rt);
      b.edges.push(rt);

      // --- compile lanes ------------------------------------------------
      const mkLanes = (dir: 1 | -1, count: number): void => {
        if (count === 0) return;
        const base = dir === 1 ? center : [...center].reverse();
        for (let i = 0; i < count; i++) {
          // lateral offset, +left of travel
          let off: number;
          if (ed.lanesB === 0) {
            off = ((count - 1) / 2 - i) * laneW;
          } else {
            off = -(i + 0.5) * laneW;
          }
          const poly = offsetPolyline(base, off);
          const lane: Lane = {
            id: `${ed.id}:${dir === 1 ? 'F' : 'B'}${i}`,
            edge: rt,
            dir,
            index: i,
            laneCount: count,
            poly,
            len: polylineLength(poly),
            width: laneW,
            speed: ed.limit,
            kind: 'drive',
            isHov: !!ed.hov && i === 0,
            merge: !!ed.merge,
            exit: !!ed.exit,
            fromNode: dir === 1 ? ed.from : ed.to,
            toNode: dir === 1 ? ed.to : ed.from,
            closed: dir === 1 && ed.closureF && i === count - 1 ? ed.closureF : undefined,
          };
          this.lanes.push(lane);
        }
        if (ed.bike) {
          const off = -(count * laneW + BIKE_W / 2);
          const poly = offsetPolyline(base, off);
          this.lanes.push({
            id: `${ed.id}:${dir === 1 ? 'F' : 'B'}bike`,
            edge: rt,
            dir,
            index: count,
            laneCount: count,
            poly,
            len: polylineLength(poly),
            width: BIKE_W,
            speed: 22,
            kind: 'bike',
            isHov: false,
            merge: false,
            exit: false,
            fromNode: dir === 1 ? ed.from : ed.to,
            toNode: dir === 1 ? ed.to : ed.from,
          });
        }
      };
      mkLanes(1, ed.lanesF);
      mkLanes(-1, ed.lanesB);
    }

    // node radius from connected edge widths
    for (const node of this.nodes.values()) {
      let r = 5;
      for (const e of node.edges) r = Math.max(r, Math.max(e.halfL, e.halfR) + 1.6);
      node.radius = r;
    }

    // inbound/outbound lanes
    for (const lane of this.lanes) {
      if (lane.kind !== 'drive') continue;
      this.nodes.get(lane.toNode)?.inbound.push(lane);
      this.nodes.get(lane.fromNode)?.outbound.push(lane);
    }

    // spatial index over lane + edge segments
    for (const lane of this.lanes) {
      for (const p of this.samplePoints(lane.poly, GRID * 0.8)) {
        const key = this.gridKey(p.x, p.z);
        let arr = this.laneGrid.get(key);
        if (!arr) {
          arr = [];
          this.laneGrid.set(key, arr);
        }
        if (!arr.includes(lane)) arr.push(lane);
      }
    }
    for (const edge of this.edges.values()) {
      for (const p of this.samplePoints(edge.center, GRID * 0.8)) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const key = `${Math.floor(p.x / GRID) + dx},${Math.floor(p.z / GRID) + dz}`;
            let arr = this.edgeGrid.get(key);
            if (!arr) {
              arr = [];
              this.edgeGrid.set(key, arr);
            }
            if (!arr.includes(edge)) arr.push(edge);
          }
        }
      }
    }
  }

  private gridKey(x: number, z: number): string {
    return `${Math.floor(x / GRID)},${Math.floor(z / GRID)}`;
  }

  private samplePoints(poly: V2[], step: number): V2[] {
    const out: V2[] = [];
    const len = polylineLength(poly);
    for (let s = 0; s <= len; s += step) out.push(polylineAt(poly, s).point);
    out.push(poly[poly.length - 1]);
    return out;
  }

  /** Nearest drivable lane to a point, optionally preferring heading alignment. */
  nearestLane(p: V2, heading?: number, maxDist = 14, includeBike = false): LaneHit | null {
    const candidates = new Set<Lane>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const arr = this.laneGrid.get(`${Math.floor(p.x / GRID) + dx},${Math.floor(p.z / GRID) + dz}`);
        if (arr) for (const l of arr) candidates.add(l);
      }
    }
    let best: LaneHit | null = null;
    let bestScore = Infinity;
    for (const lane of candidates) {
      if (lane.kind === 'bike' && !includeBike) continue;
      const near = nearestOnPolyline(lane.poly, p);
      if (near.dist > maxDist) continue;
      let score = near.dist;
      if (heading !== undefined) {
        const align = Math.abs(angleDiff(heading, headingOf(near.dir)));
        score += align * 4;
        if (align > Math.PI * 0.6) score += 30; // wrong way: heavily penalize
      }
      if (score < bestScore) {
        bestScore = score;
        best = { lane, ...near };
      }
    }
    return best;
  }

  /** Edges near a point (for ground/paving queries). */
  edgesNear(x: number, z: number): EdgeRT[] {
    return this.edgeGrid.get(this.gridKey(x, z)) ?? [];
  }

  node(id: string): NodeRT {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`no node ${id}`);
    return n;
  }

  edge(id: string): EdgeRT {
    const e = this.edges.get(id);
    if (!e) throw new Error(`no edge ${id}`);
    return e;
  }

  laneById(id: string): Lane | undefined {
    return this.lanes.find((l) => l.id === id);
  }

  /** Heading of a lane at arc position s. */
  laneHeading(lane: Lane, s: number): number {
    return headingOf(polylineAt(lane.poly, s).dir);
  }

  /** Successor lanes at the end of `lane`, with turn classification. */
  successors(lane: Lane): LaneLink[] {
    const cached = this.succ.get(lane.id);
    if (cached) return cached;
    const node = this.nodes.get(lane.toNode);
    const out: LaneLink[] = [];
    if (node) {
      const hIn = this.laneHeading(lane, lane.len - 2);
      const deadEnd = node.def.control === 'dead-end';
      for (const next of node.outbound) {
        if (next.kind !== 'drive') continue;
        const sameEdgeBack = next.edge === lane.edge && next.dir !== lane.dir;
        if (sameEdgeBack && !deadEnd) continue; // no u-turn mid network (except dead ends)
        const hOut = this.laneHeading(next, 2);
        const turn = sameEdgeBack ? 'uturn' : classifyTurn(hIn, hOut);
        out.push({ lane: next, turn });
      }
    }
    this.succ.set(lane.id, out);
    return out;
  }

  /** Stop line position (arc length along lane) for an approach to its end node. */
  stopLineS(lane: Lane): number {
    const node = this.nodes.get(lane.toNode);
    if (!node) return lane.len;
    const cross = node.def.noCrosswalk ? 0 : 3.2;
    return Math.max(2, lane.len - node.radius - cross - 0.8);
  }

  /** The control governing this lane's approach to its end node. */
  approachControl(lane: Lane): 'signal' | 'stop' | 'yield' | 'roundabout-yield' | 'none' {
    const node = this.nodes.get(lane.toNode);
    if (!node) return 'none';
    const c = node.def.control;
    if (c === 'signal') return 'signal';
    if (c === 'stop-all') return 'stop';
    if (c === 'roundabout') {
      // entering traffic yields; circulating traffic flows
      return lane.edge.def.kind === 'roundabout' ? 'none' : 'roundabout-yield';
    }
    if (c === 'minor-stop' || c === 'minor-yield') {
      const minor = node.def.minorEdges?.includes(lane.edge.def.id);
      if (!minor) return 'none';
      return c === 'minor-stop' ? 'stop' : 'yield';
    }
    return 'none';
  }

  /** BFS shortest path by distance over the node graph. Returns node ids. */
  findPath(fromNode: string, toNode: string): string[] | null {
    if (fromNode === toNode) return [fromNode];
    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    const queue: Array<{ id: string; d: number }> = [{ id: fromNode, d: 0 }];
    dist.set(fromNode, 0);
    while (queue.length) {
      queue.sort((a, b) => a.d - b.d);
      const cur = queue.shift()!;
      if (cur.id === toNode) break;
      if (cur.d > (dist.get(cur.id) ?? Infinity)) continue;
      const node = this.nodes.get(cur.id);
      if (!node) continue;
      for (const lane of node.outbound) {
        if (lane.kind !== 'drive') continue;
        const nd = cur.d + lane.len;
        if (nd < (dist.get(lane.toNode) ?? Infinity)) {
          dist.set(lane.toNode, nd);
          prev.set(lane.toNode, cur.id);
          queue.push({ id: lane.toNode, d: nd });
        }
      }
    }
    if (!prev.has(toNode)) return null;
    const path = [toNode];
    let cur = toNode;
    while (cur !== fromNode) {
      cur = prev.get(cur)!;
      path.unshift(cur);
    }
    return path;
  }

  /** First drive lane from node a toward node b (leftmost by default). */
  laneBetween(a: string, b: string, index = 0): Lane | null {
    const node = this.nodes.get(a);
    if (!node) return null;
    const options = node.outbound.filter((l) => l.toNode === b && l.kind === 'drive');
    if (!options.length) return null;
    options.sort((l1, l2) => l1.index - l2.index);
    return options[Math.min(index, options.length - 1)];
  }
}

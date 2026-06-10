import { describe, expect, it } from 'vitest';
import { RoadNetwork, classifyTurn, compassOf } from '../src/world/network';
import { buildMapDefs, MANEUVERS, PARKING_BAYS, PXO, SPAWNS, STREETCAR_ROUTE } from '../src/world/map';

const defs = buildMapDefs();
const net = new RoadNetwork(defs.nodes, defs.edges);

describe('map integrity', () => {
  it('builds with every edge endpoint resolving to a node', () => {
    expect(net.lanes.length).toBeGreaterThan(100);
  });

  it('all minorEdges references exist', () => {
    for (const node of defs.nodes) {
      for (const id of node.minorEdges ?? []) {
        expect(net.edges.has(id), `node ${node.id} references missing edge ${id}`).toBe(true);
      }
    }
  });

  it('special map references resolve', () => {
    expect(net.edges.has(PXO.edgeId)).toBe(true);
    expect(net.edges.has(PARKING_BAYS.edgeId)).toBe(true);
    expect(net.edges.has(SPAWNS.freeRoam.edgeId)).toBe(true);
    for (const key of Object.keys(MANEUVERS) as Array<keyof typeof MANEUVERS>) {
      expect(net.edges.has(MANEUVERS[key].edgeId)).toBe(true);
    }
    for (const id of STREETCAR_ROUTE) expect(net.edges.has(id)).toBe(true);
  });

  it('every drive lane has at least one successor (no traffic dead ends)', () => {
    for (const lane of net.lanes) {
      if (lane.kind !== 'drive') continue;
      const succ = net.successors(lane);
      expect(succ.length, `lane ${lane.id} has no successors`).toBeGreaterThan(0);
    }
  });
});

describe('routing', () => {
  it('finds a path from downtown onto the highway and back', () => {
    const out = net.findPath('QB', 'HE2');
    expect(out).not.toBeNull();
    expect(out).toContain('RT1'); // must use the on-ramp
    const back = net.findPath('HE2', 'QB');
    expect(back).not.toBeNull();
    expect(back).toContain('R2'); // must come around the loop and exit
  });

  it('exiting the highway requires the marked EXIT edge', () => {
    const path = net.findPath('MB', 'FD');
    expect(path).not.toBeNull();
    expect(path!.join(',')).toContain('ED,R2');
  });
});

describe('controls & turns', () => {
  it('classifies turns correctly', () => {
    expect(classifyTurn(0, 0)).toBe('straight');
    expect(classifyTurn(0, Math.PI / 2)).toBe('left');
    expect(classifyTurn(0, -Math.PI / 2)).toBe('right');
    expect(classifyTurn(0, Math.PI)).toBe('uturn');
  });

  it('compass works in the world convention (-z = north)', () => {
    expect(compassOf(Math.PI)).toBe('N');
    expect(compassOf(0)).toBe('S');
    expect(compassOf(Math.PI / 2)).toBe('E');
    expect(compassOf(-Math.PI / 2)).toBe('W');
  });

  it('roundabout entries yield, circulating traffic flows', () => {
    const entry = net.lanes.find((l) => l.edge.def.id === 'dav1' && l.dir === 1)!; // FD → RBN
    expect(net.approachControl(entry)).toBe('roundabout-yield');
    const circ = net.lanes.find((l) => l.edge.def.id === 'rb1')!;
    expect(net.approachControl(circ)).toBe('none');
  });

  it('all-way stop at Palmerston & University', () => {
    const lane = net.lanes.find((l) => l.toNode === 'PU' && l.kind === 'drive')!;
    expect(net.approachControl(lane)).toBe('stop');
  });

  it('signalized approach reports signal control', () => {
    const lane = net.lanes.find((l) => l.toNode === 'QU' && l.kind === 'drive')!;
    expect(net.approachControl(lane)).toBe('signal');
  });

  it('nearest lane respects heading (no wrong-way matches)', () => {
    // a point on Queen St between QB and QS, heading east
    const hitE = net.nearestLane({ x: -450, z: 102 }, Math.PI / 2);
    expect(hitE).not.toBeNull();
    expect(hitE!.lane.dir).toBe(1); // F = west→east
    const hitW = net.nearestLane({ x: -450, z: 98 }, -Math.PI / 2);
    expect(hitW!.lane.dir).toBe(-1);
  });
});

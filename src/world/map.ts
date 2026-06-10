/**
 * The DriveSim district: a cohesive, Toronto-flavoured test world containing
 * every element the Ontario Full G grades.
 *
 * Layout (x east, z south, metres):
 *  - Highway 401 (one-way pair, 3 lanes + HOV, 100 km/h) loops along the
 *    north: EB at z=-460, WB at z=-620, joined by 180° curves at x=±840 so
 *    highway practice is continuous. One on-ramp + acceleration lane and one
 *    signed EXIT with deceleration geometry connect to the Frontage Rd.
 *  - A downtown grid: Adelaide Frontage (60), King St W (50, advanced-green
 *    signals, construction closure), Queen St W (50, streetcar + PXO).
 *  - Residential south: Palmerston Ave (40, bike lanes, school zone 30),
 *    Euclid Crescent (40, roadside-stop practice).
 *  - Avenues: Bathurst (parallel parking bays + cul-de-sac three-point turn),
 *    Spadina, University (bike lanes), McCaul, Davenport (roundabout + the
 *    hill for stop-on-grade).
 */

import type { NodeDef, EdgeDef } from './network';
import { bezier, type V2 } from '../core/math';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const nodes: NodeDef[] = [];
const edges: EdgeDef[] = [];

function N(id: string, x: number, z: number, control: NodeDef['control'] = 'none', extra: Partial<NodeDef> = {}): void {
  nodes.push({ id, x, z, control, ...extra });
}

function E(id: string, from: string, to: string, partial: Partial<EdgeDef> & Pick<EdgeDef, 'lanesF' | 'lanesB' | 'limit' | 'kind' | 'name' | 'area'>): void {
  edges.push({ id, from, to, ...partial });
}

/** Smooth plateau hill profile (rise → crest → descend), max height h. */
const hillProfile =
  (h: number, upStart: number, upEnd: number, downStart: number, downEnd: number) =>
  (s: number): number => {
    if (s <= upStart) return 0;
    if (s < upEnd) return (h * (1 - Math.cos(((s - upStart) / (upEnd - upStart)) * Math.PI))) / 2;
    if (s <= downStart) return h;
    if (s < downEnd) return (h * (1 + Math.cos(((s - downStart) / (downEnd - downStart)) * Math.PI))) / 2;
    return 0;
  };

/* ------------------------------------------------------------------ */
/* nodes                                                               */
/* ------------------------------------------------------------------ */

// Highway 401 mainline (EB along z=-460, WB along z=-620)
N('HE1', -840, -460, 'none', { noCrosswalk: true });
N('MB', -140, -460, 'none', { noCrosswalk: true }); // merge end joins here
N('ED', 160, -460, 'none', { noCrosswalk: true }); // exit departs here
N('HE2', 840, -460, 'none', { noCrosswalk: true });
N('HW1', 840, -620, 'none', { noCrosswalk: true });
N('HW2', -840, -620, 'none', { noCrosswalk: true });
// ramp feet on Frontage + accel-lane start
N('R1', -480, -380, 'none'); // on-ramp leaves Frontage
N('RT1', -310, -452.5, 'none', { noCrosswalk: true }); // top of on-ramp → accel lane
N('R2', 480, -380, 'minor-yield', { minorEdges: ['rampOff'] }); // off-ramp yields onto Frontage

// Adelaide Frontage Rd (z=-380)
N('FW', -700, -380, 'dead-end');
N('LE', -660, -380, 'none'); // practice-lot entrance
N('FB', -600, -380, 'minor-stop', { minorEdges: ['bat1'] });
N('FS', -300, -380, 'signal', { signal: { offset: 0 } });
N('FU', 0, -380, 'signal', { signal: { offset: 18 } });
N('FM', 300, -380, 'signal', { signal: { offset: 36 } });
N('FD', 600, -380, 'minor-stop', { minorEdges: ['dav1'] });
N('FE', 700, -380, 'dead-end');
N('LOTA', -660, -416, 'dead-end'); // inside the practice lot

// King St W (z=-150)
N('KW', -700, -150, 'minor-stop', { minorEdges: ['shaw1', 'shaw2'] });
N('KB', -600, -150, 'minor-stop', { minorEdges: ['bat1', 'bat2'] });
N('KS', -300, -150, 'signal', { signal: { advance: 'EW', offset: 6, ewGreen: 20 } });
N('KU', 0, -150, 'signal', { signal: { advance: 'NS', offset: 24 } });
N('KM', 300, -150, 'signal', { signal: { offset: 42 } });
// Roundabout at King & Davenport (centre 600,-150, R=13)
N('RBW', 574, -150, 'roundabout');
N('RBN', 600, -176, 'roundabout');
N('RBE', 626, -150, 'roundabout');
N('RBS', 600, -124, 'roundabout');
N('KE', 700, -150, 'minor-stop', { minorEdges: ['shawE1', 'shawE2'] });

// Queen St W (z=100) — streetcar street
N('QW', -700, 100, 'minor-stop', { minorEdges: ['shaw2', 'shaw3'] });
N('QB', -600, 100, 'signal', { signal: { offset: 10 } });
N('QS', -300, 100, 'signal', { signal: { offset: 26 } });
N('QU', 0, 100, 'signal', { signal: { advance: 'EW', offset: 44 } });
N('QM', 300, 100, 'signal', { signal: { offset: 62 } });
N('QD', 600, 100, 'signal', { signal: { offset: 80 } });
N('QE', 700, 100, 'minor-stop', { minorEdges: ['shawE2', 'shawE3'] });

// Palmerston Ave (z=350) — residential
N('PW', -700, 350, 'minor-stop', { minorEdges: ['pm1'] });
N('PB', -600, 350, 'minor-stop', { minorEdges: ['pm1', 'pm2'] });
N('PS', -300, 350, 'minor-stop', { minorEdges: ['spa4'] });
N('PU', 0, 350, 'stop-all');
N('PM', 300, 350, 'minor-stop', { minorEdges: ['mcc4', 'mcc5'] });
N('PD', 600, 350, 'minor-stop', { minorEdges: ['dav3', 'shawE3'] });

// South residential: Bathurst cul-de-sac + Euclid Crescent (bends, not intersections)
N('BS', -600, 550, 'dead-end');
N('US', 0, 550, 'none');
N('MS', 300, 550, 'none');

/* ------------------------------------------------------------------ */
/* edges — highway                                                     */
/* ------------------------------------------------------------------ */

const loopE: V2[] = bezier({ x: 840, z: -460 }, { x: 952, z: -460 }, { x: 952, z: -540 }, 12).concat(
  bezier({ x: 952, z: -540 }, { x: 952, z: -620 }, { x: 840, z: -620 }, 12),
);
const loopW: V2[] = bezier({ x: -840, z: -620 }, { x: -952, z: -620 }, { x: -952, z: -540 }, 12).concat(
  bezier({ x: -952, z: -540 }, { x: -952, z: -460 }, { x: -840, z: -460 }, 12),
);

E('hwyE1', 'HE1', 'MB', { lanesF: 3, lanesB: 0, limit: 100, kind: 'highway', name: 'Highway 401 EAST', area: 'Highway 401', hov: true });
E('hwyE2', 'MB', 'ED', { lanesF: 3, lanesB: 0, limit: 100, kind: 'highway', name: 'Highway 401 EAST', area: 'Highway 401', hov: true });
E('hwyE3', 'ED', 'HE2', { lanesF: 3, lanesB: 0, limit: 100, kind: 'highway', name: 'Highway 401 EAST', area: 'Highway 401', hov: true });
E('hwyLoopE', 'HE2', 'HW1', { lanesF: 2, lanesB: 0, limit: 60, kind: 'highway', name: 'Highway 401', area: 'Highway 401', via: loopE.slice(1, -1), unmarked: false });
E('hwyW', 'HW1', 'HW2', { lanesF: 3, lanesB: 0, limit: 100, kind: 'highway', name: 'Highway 401 WEST', area: 'Highway 401', hov: true });
E('hwyLoopW', 'HW2', 'HE1', { lanesF: 2, lanesB: 0, limit: 60, kind: 'highway', name: 'Highway 401', area: 'Highway 401', via: loopW.slice(1, -1) });

// On-ramp (R1 → RT1) climbs NE, then the acceleration lane runs beside EB
E('rampOn', 'R1', 'RT1', {
  lanesF: 1,
  lanesB: 0,
  limit: 60,
  kind: 'ramp',
  name: 'Hwy 401 EAST on-ramp',
  area: 'Highway 401',
  via: [
    { x: -448, z: -390 },
    { x: -408, z: -408 },
    { x: -368, z: -428 },
    { x: -334, z: -444 },
  ],
});
E('accel', 'RT1', 'MB', {
  lanesF: 1,
  lanesB: 0,
  limit: 100,
  kind: 'ramp',
  name: 'Hwy 401 EAST — accelerate & merge',
  area: 'Highway 401',
  merge: true,
  via: [
    { x: -240, z: -452.5 },
    { x: -185, z: -455 },
  ],
});
// Exit ramp leaves the mainline at ED with deceleration geometry, yields onto Frontage
E('rampOff', 'ED', 'R2', {
  lanesF: 1,
  lanesB: 0,
  limit: 60,
  kind: 'ramp',
  name: 'EXIT 12 — McCaul Ave',
  area: 'Highway 401',
  exit: true,
  via: [
    { x: 230, z: -455 },
    { x: 300, z: -443 },
    { x: 380, z: -418 },
    { x: 440, z: -396 },
  ],
});

/* ------------------------------------------------------------------ */
/* edges — east-west streets                                           */
/* ------------------------------------------------------------------ */

const FRONT = { limit: 60, kind: 'city' as const, name: 'Adelaide Frontage Rd', area: 'North End' };
E('fr0', 'FW', 'LE', { lanesF: 2, lanesB: 2, ...FRONT });
E('fr1', 'LE', 'FB', { lanesF: 2, lanesB: 2, ...FRONT });
E('fr2', 'FB', 'R1', { lanesF: 2, lanesB: 2, ...FRONT });
E('fr3', 'R1', 'FS', { lanesF: 2, lanesB: 2, ...FRONT });
E('fr4', 'FS', 'FU', { lanesF: 2, lanesB: 2, ...FRONT });
E('fr5', 'FU', 'FM', { lanesF: 2, lanesB: 2, ...FRONT });
E('fr6', 'FM', 'R2', { lanesF: 2, lanesB: 2, ...FRONT });
E('fr7', 'R2', 'FD', { lanesF: 2, lanesB: 2, ...FRONT });
E('fr8', 'FD', 'FE', { lanesF: 2, lanesB: 2, ...FRONT });
E('lotIn', 'LE', 'LOTA', { lanesF: 1, lanesB: 1, limit: 20, kind: 'lot', name: 'DriveTest Centre', area: 'North End', unmarked: true });

const KING = { limit: 50, kind: 'city' as const, name: 'King St W', area: 'Downtown' };
E('kg1', 'KW', 'KB', { lanesF: 2, lanesB: 2, ...KING });
E('kg2', 'KB', 'KS', { lanesF: 2, lanesB: 2, ...KING });
E('kg3', 'KS', 'KU', { lanesF: 2, lanesB: 2, ...KING });
E('kg4', 'KU', 'KM', { lanesF: 2, lanesB: 2, ...KING });
// construction: EB right lane closed mid-block
E('kg5', 'KM', 'RBW', { lanesF: 2, lanesB: 2, ...KING, closureF: [60, 235] });
E('kg6', 'RBE', 'KE', { lanesF: 2, lanesB: 2, ...KING });

const QUEEN = { limit: 50, kind: 'city' as const, name: 'Queen St W', area: 'Downtown', streetcar: true };
E('qn1', 'QW', 'QB', { lanesF: 2, lanesB: 2, limit: 50, kind: 'city', name: 'Queen St W', area: 'Downtown' });
E('qn2', 'QB', 'QS', { lanesF: 2, lanesB: 2, ...QUEEN });
E('qn3', 'QS', 'QU', { lanesF: 2, lanesB: 2, ...QUEEN });
E('qn4', 'QU', 'QM', { lanesF: 2, lanesB: 2, ...QUEEN });
E('qn5', 'QM', 'QD', { lanesF: 2, lanesB: 2, ...QUEEN });
E('qn6', 'QD', 'QE', { lanesF: 2, lanesB: 2, limit: 50, kind: 'city', name: 'Queen St W', area: 'Downtown' });

const PALM = { limit: 40, kind: 'residential' as const, name: 'Palmerston Ave', area: 'Harbord Village', bike: true };
E('pm1', 'PW', 'PB', { lanesF: 1, lanesB: 1, ...PALM });
E('pm2', 'PB', 'PS', { lanesF: 1, lanesB: 1, ...PALM });
E('pm3', 'PS', 'PU', { lanesF: 1, lanesB: 1, ...PALM });
E('pm4', 'PU', 'PM', { lanesF: 1, lanesB: 1, ...PALM }); // school zone (30) overlays here
E('pm5', 'PM', 'PD', { lanesF: 1, lanesB: 1, ...PALM });

// Euclid Crescent (US → MS through the south)
E('eucl1', 'US', 'MS', {
  lanesF: 1,
  lanesB: 1,
  limit: 40,
  kind: 'residential',
  name: 'Euclid Crescent',
  area: 'Harbord Village',
  via: [
    { x: 60, z: 596 },
    { x: 150, z: 614 },
    { x: 240, z: 596 },
  ],
});

/* ------------------------------------------------------------------ */
/* edges — north-south avenues                                         */
/* ------------------------------------------------------------------ */

const SHAW = { limit: 40, kind: 'residential' as const, name: 'Shaw St', area: 'West Side' };
E('shaw1', 'FW', 'KW', { lanesF: 1, lanesB: 1, ...SHAW });
E('shaw2', 'KW', 'QW', { lanesF: 1, lanesB: 1, ...SHAW });
E('shaw3', 'QW', 'PW', { lanesF: 1, lanesB: 1, ...SHAW });
const SHAWE = { limit: 40, kind: 'residential' as const, name: 'Logan Ave', area: 'East Side' };
E('shawE1', 'FE', 'KE', { lanesF: 1, lanesB: 1, ...SHAWE });
E('shawE2', 'KE', 'QE', { lanesF: 1, lanesB: 1, ...SHAWE });
E('shawE3', 'QE', 'PD', { lanesF: 1, lanesB: 1, ...SHAWE, via: [{ x: 700, z: 280 }, { x: 660, z: 340 }] });

const BAT = { limit: 50, kind: 'city' as const, name: 'Bathurst Ave', area: 'West Side' };
E('bat1', 'FB', 'KB', { lanesF: 1, lanesB: 1, ...BAT });
E('bat2', 'KB', 'QB', { lanesF: 1, lanesB: 1, ...BAT });
// parking bays on the west side (right of southbound travel)
E('bat3', 'QB', 'PB', { lanesF: 1, lanesB: 1, limit: 40, kind: 'residential', name: 'Bathurst Ave', area: 'Harbord Village', parkingF: true });
E('bat4', 'PB', 'BS', { lanesF: 1, lanesB: 1, limit: 40, kind: 'residential', name: 'Bathurst Ave', area: 'Harbord Village' });

const SPA = { limit: 50, kind: 'city' as const, name: 'Spadina Ave', area: 'Downtown' };
E('spa1', 'FS', 'KS', { lanesF: 2, lanesB: 2, ...SPA });
E('spa2', 'KS', 'QS', { lanesF: 2, lanesB: 2, ...SPA });
E('spa4', 'QS', 'PS', { lanesF: 1, lanesB: 1, limit: 40, kind: 'residential', name: 'Spadina Ave', area: 'Harbord Village' });

const UNI = { limit: 50, kind: 'city' as const, name: 'University Ave', area: 'Downtown' };
E('uni1', 'FU', 'KU', { lanesF: 2, lanesB: 2, ...UNI });
E('uni2', 'KU', 'QU', { lanesF: 2, lanesB: 2, ...UNI });
E('uni3', 'QU', 'PU', { lanesF: 2, lanesB: 2, limit: 50, kind: 'city', name: 'University Ave', area: 'Downtown', bike: true });
E('uni4', 'PU', 'US', { lanesF: 1, lanesB: 1, limit: 40, kind: 'residential', name: 'University Ave', area: 'Harbord Village', bike: true });

const MCC = { limit: 50, kind: 'city' as const, name: 'McCaul Ave', area: 'Downtown' };
E('mcc1', 'FM', 'KM', { lanesF: 1, lanesB: 1, ...MCC });
E('mcc2', 'KM', 'QM', { lanesF: 1, lanesB: 1, ...MCC });
E('mcc4', 'QM', 'PM', { lanesF: 1, lanesB: 1, limit: 40, kind: 'residential', name: 'McCaul Ave', area: 'Harbord Village' });
E('mcc5', 'PM', 'MS', { lanesF: 1, lanesB: 1, limit: 40, kind: 'residential', name: 'McCaul Ave', area: 'Harbord Village' });

const DAV = { limit: 50, kind: 'city' as const, name: 'Davenport Rd', area: 'East Side' };
E('dav1', 'FD', 'RBN', { lanesF: 1, lanesB: 1, ...DAV });
E('dav2', 'RBS', 'QD', { lanesF: 1, lanesB: 1, ...DAV });
// THE HILL: climbs to +6 m between Queen and Palmerston
E('dav3', 'QD', 'PD', {
  lanesF: 1,
  lanesB: 1,
  limit: 40,
  kind: 'residential',
  name: 'Davenport Rd',
  area: 'Hillcrest',
  elevation: hillProfile(6, 25, 110, 145, 228),
});

/* ------------------------------------------------------------------ */
/* roundabout (single-lane, counterclockwise circulation)              */
/* ------------------------------------------------------------------ */

const RB_C = { x: 600, z: -150 };
const RB_R = 13;

function rbArc(a0: number, a1: number, steps = 10): V2[] {
  const pts: V2[] = [];
  for (let i = 1; i < steps; i++) {
    const t = a0 + ((a1 - a0) * i) / steps;
    pts.push({ x: RB_C.x + RB_R * Math.cos(t), z: RB_C.z - RB_R * Math.sin(t) });
  }
  return pts;
}

// angles: E=0, N=π/2, W=π, S=3π/2 (CCW circulation: E→N→W→S→E)
const RB = { limit: 30, kind: 'roundabout' as const, name: 'King & Davenport Roundabout', area: 'East Side', unmarked: true };
E('rb1', 'RBE', 'RBN', { lanesF: 1, lanesB: 0, ...RB, via: rbArc(0, Math.PI / 2) });
E('rb2', 'RBN', 'RBW', { lanesF: 1, lanesB: 0, ...RB, via: rbArc(Math.PI / 2, Math.PI) });
E('rb3', 'RBW', 'RBS', { lanesF: 1, lanesB: 0, ...RB, via: rbArc(Math.PI, (3 * Math.PI) / 2) });
E('rb4', 'RBS', 'RBE', { lanesF: 1, lanesB: 0, ...RB, via: rbArc((3 * Math.PI) / 2, 2 * Math.PI) });

/* ------------------------------------------------------------------ */
/* zones, crossings, transit, maneuvers                                */
/* ------------------------------------------------------------------ */

export interface ZoneDef {
  kind: 'school' | 'construction' | 'playground';
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  limit: number;
  label: string;
}

export const ZONES: ZoneDef[] = [
  { kind: 'school', x0: 10, z0: 322, x1: 290, z1: 378, limit: 30, label: 'School Zone' },
  { kind: 'construction', x0: 350, z0: -178, x1: 580, z1: -122, limit: 40, label: 'Construction Zone' },
  { kind: 'playground', x0: 30, z0: 530, x1: 270, z1: 640, limit: 30, label: 'Playground Zone' },
];

export interface PxoDef {
  edgeId: string;
  /** Arc position along the edge centerline (from→to). */
  s: number;
}

/** Pedestrian crossover on Queen between University & McCaul. */
export const PXO: PxoDef = { edgeId: 'qn4', s: 150 };

export interface StreetcarStopDef {
  edgeId: string;
  s: number;
}

export const STREETCAR_ROUTE: string[] = ['qn2', 'qn3', 'qn4', 'qn5'];
export const STREETCAR_STOPS: StreetcarStopDef[] = [
  { edgeId: 'qn2', s: 150 },
  { edgeId: 'qn3', s: 150 },
  { edgeId: 'qn4', s: 220 },
  { edgeId: 'qn5', s: 150 },
];

/** Parallel-parking exercise on Bathurst (west curb, southbound). */
export interface ParkingBayArea {
  edgeId: string;
  /** s-range of the bay strip along the F direction. */
  s0: number;
  s1: number;
  /** s-range left EMPTY for the exercise (between two parked cars). */
  gap0: number;
  gap1: number;
}

export const PARKING_BAYS: ParkingBayArea = { edgeId: 'bat3', s0: 40, s1: 230, gap0: 104, gap1: 117 };

export interface ManeuverZones {
  parallelPark: { edgeId: string; s: number };
  threePoint: { edgeId: string; s: number };
  roadside: { edgeId: string; s: number };
  hillStop: { edgeId: string; s: number };
}

export const MANEUVERS: ManeuverZones = {
  parallelPark: { edgeId: 'bat3', s: 110 },
  threePoint: { edgeId: 'bat4', s: 120 },
  roadside: { edgeId: 'eucl1', s: 140 },
  hillStop: { edgeId: 'dav3', s: 70 },
};

/** School-bus loop through the residential area. */
export const SCHOOLBUS_ROUTE: string[] = ['pm2', 'pm3', 'pm4', 'pm5'];

export const SPAWNS = {
  freeRoam: { edgeId: 'qn2', s: 80, lane: 0 },
  examStart: { x: -652, z: -402, heading: Math.PI / 2 }, // parked in the DriveTest lot
  highway: { edgeId: 'rampOn', s: 10, lane: 0 },
};

/** The practice lot pad (also the DriveTest Centre). */
export const LOT_RECT = { x0: -706, z0: -452, x1: -560, z1: -390 };

export function buildMapDefs(): { nodes: NodeDef[]; edges: EdgeDef[] } {
  return { nodes, edges };
}

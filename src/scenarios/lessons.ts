/**
 * The curriculum: six lessons sequenced like real instruction. Each lesson
 * is a spawn + conditions + an ordered list of tasks with live completion
 * checks against the DriveContext stream (and the coach's fault log for
 * habit grading). Lesson 6 is the Mock G Test (examiner mode).
 */

import type { DriveContext, TurnCompleted } from '../coaching/context';
import type { Fault, WeatherKind } from '../core/types';
import type { ManeuverSpot } from '../world/world';
import type { TimePreset } from '../game/settings';
import { angleDiff } from '../core/math';

export interface LessonEnv {
  ctx: DriveContext;
  taskTime: number;
  scratch: Record<string, number>;
  /** Events accumulated since the current task started. */
  turns: TurnCompleted[];
  laneChanges: Array<'left' | 'right'>;
  merges: number;
  faults: Fault[];
  /** R↔D shifter transitions since task start. */
  gearChanges: number;
  /** Player distance to a point. */
  dist(x: number, z: number): number;
  spot(key: 'parallelPark' | 'threePoint' | 'roadside' | 'hillStop'): ManeuverSpot;
  parkingGap(): { center: { x: number; z: number }; heading: number; length: number };
  /** Player position in a local frame (along/left of a heading at a point). */
  local(x: number, z: number, heading: number): { along: number; left: number };
  playerHeading(): number;
  playerGear(): string;
  note(text: string, kind?: 'info' | 'warn' | 'good'): void;
  faultCount(code?: string): number;
}

export interface LessonTask {
  instruction: string;
  sub?: string;
  /** Marker for HUD/minimap/3D beacon. */
  target?: (env: LessonEnv) => { x: number; z: number; r: number } | null;
  done(env: LessonEnv): boolean;
  /** Called once when the task completes (praise / notes). */
  onComplete?(env: LessonEnv): void;
}

export interface LessonDef {
  id: string;
  title: string;
  desc: string;
  objective: string;
  habits: string[];
  spawn: { edgeId: string; s: number; lane?: number } | { x: number; z: number; heading: number };
  weather?: WeatherKind;
  time?: TimePreset;
  trafficDensity?: number;
  /** Show the parallel-park ghost guide. */
  parkGhost?: boolean;
  tasks: LessonTask[];
}

const stoppedFor = (env: LessonEnv, key: string, seconds: number): boolean => {
  if (env.ctx.speedMs < 0.3) env.scratch[key] = (env.scratch[key] ?? 0) + env.ctx.dt;
  else env.scratch[key] = 0;
  return (env.scratch[key] ?? 0) >= seconds;
};

const heldFor = (env: LessonEnv, key: string, cond: boolean, seconds: number): boolean => {
  env.scratch[key] = cond ? (env.scratch[key] ?? 0) + env.ctx.dt : 0;
  return (env.scratch[key] ?? 0) >= seconds;
};

/* ================================================================== */
/* Lesson 1 — Vehicle basics & smoothness                              */
/* ================================================================== */

const lesson1: LessonDef = {
  id: 'basics',
  title: '1 · Vehicle Basics & Smoothness',
  desc: 'Throttle, brake and steering feel; smooth stops; reverse; holding speed and lane position.',
  objective: 'Get comfortable with the car: smooth inputs are graded on every drive.',
  habits: ['Gentle throttle & brake', 'Steady lane position', 'Reverse control', 'Full smooth stops'],
  spawn: { x: -646, z: -402, heading: Math.PI / 2 },
  trafficDensity: 0.5,
  tasks: [
    {
      instruction: 'Reverse out of the stall',
      sub: 'Press X for Reverse, back up ~6 m, brake to a stop, X again for Drive',
      done: (env) => {
        if (env.ctx.speedMs > 0.5 && env.playerGear() === 'R') env.scratch.reversed = 1;
        return !!env.scratch.reversed && env.playerGear().startsWith('D') && env.ctx.speedMs < 2;
      },
      onComplete: (env) => env.note('Good — you now control Drive and Reverse.', 'good'),
    },
    {
      instruction: 'Exit the lot and turn RIGHT onto Adelaide Frontage Rd',
      sub: 'Creep to the edge, signal right (E), look both ways, turn when clear',
      target: () => ({ x: -660, z: -380, r: 10 }),
      done: (env) => env.turns.some((t) => t.turn === 'right' || t.turn === 'left') && env.ctx.laneObj?.edge.def.name.includes('Frontage') === true,
      onComplete: (env) => {
        if (env.faultCount('no-signal-turn') === 0) env.note('Signalled before turning — exactly right.', 'good');
      },
    },
    {
      instruction: 'Accelerate smoothly to 55–60 km/h',
      sub: 'Squeeze the throttle — no harsh acceleration',
      done: (env) => env.ctx.speedKmh >= 54,
      onComplete: (env) => {
        if (env.faultCount('hard-accel') === 0) env.note('Smooth acceleration. The examiner feels every jolt.', 'good');
        else env.note('That was harsh — roll into the throttle next time.', 'warn');
      },
    },
    {
      instruction: 'Hold 55–60 km/h, centred in your lane, for 12 seconds',
      sub: 'Small corrections early — don’t chase the wheel',
      done: (env) => heldFor(env, 'hold', env.ctx.speedKmh > 52 && env.ctx.speedKmh < 62 && Math.abs(env.ctx.laneOffset) < 0.7, 12),
    },
    {
      instruction: 'Stop smoothly at the lights at Spadina',
      sub: 'Mirror check (M), brake early and gently, full stop behind the line',
      target: () => ({ x: -300, z: -380, r: 14 }),
      done: (env) => env.ctx.approach?.node === 'FS' && env.ctx.approach.dist < 5 && stoppedFor(env, 'stop1', 1),
      onComplete: (env) => {
        if (env.faultCount('hard-brake') === 0) env.note('Lesson complete habits: smooth in, smooth out.', 'good');
      },
    },
  ],
};

/* ================================================================== */
/* Lesson 2 — Intersections & right-of-way                             */
/* ================================================================== */

const lesson2: LessonDef = {
  id: 'intersections',
  title: '2 · Intersections & Right-of-Way',
  desc: 'Advanced green (protected left), four-way stops, right-turn-on-red, pedestrian crossovers.',
  objective: 'Read Ontario signals and yield correctly — most test failures happen at intersections.',
  habits: ['Full stops behind the line', 'Advanced-green lefts', 'RTOR after a complete stop', 'All-way stop order', 'PXO yielding'],
  spawn: { edgeId: 'uni1', s: 40, lane: 0 },
  tasks: [
    {
      instruction: 'Drive south on University to King St and turn LEFT on the advanced green',
      sub: 'The flashing left arrow protects your turn — signal early, wait for the arrow if needed',
      target: () => ({ x: 0, z: -150, r: 14 }),
      done: (env) => env.turns.some((t) => t.node === 'KU' && t.turn === 'left'),
      onComplete: (env) => {
        const t = env.turns.find((tt) => tt.node === 'KU' && tt.turn === 'left');
        if (t?.signal?.leftArrow) env.note('Used the advanced green — oncoming traffic was held for you.', 'good');
        else env.note('That left was on a permissive green — legal, but you must yield to oncoming.', 'info');
      },
    },
    {
      instruction: 'Make your way to the ALL-WAY STOP at Palmerston & University',
      sub: 'Route yourself south — every stop on the way is graded too',
      target: () => ({ x: 0, z: 350, r: 14 }),
      done: (env) => env.turns.some((t) => t.node === 'PU'),
      onComplete: (env) => {
        const t = env.turns.find((tt) => tt.node === 'PU');
        if (t && t.minApproachSpeed < 0.45 && t.myTurnAtAllWay) env.note('Textbook all-way stop: full stop, went in order.', 'good');
        else if (t && t.minApproachSpeed >= 0.45) env.note('That was a rolling stop — examiners mark it every time.', 'warn');
      },
    },
    {
      instruction: 'Loop to McCaul Ave northbound and turn RIGHT at Queen St',
      sub: 'If the light is red: STOP fully behind the line, then turn when clear (RTOR)',
      target: () => ({ x: 300, z: 100, r: 14 }),
      done: (env) => env.turns.some((t) => t.node === 'QM' && t.turn === 'right'),
      onComplete: (env) => {
        const t = env.turns.find((tt) => tt.node === 'QM' && tt.turn === 'right');
        if (t?.signal?.ball === 'red' && t.minApproachSpeed < 0.45) env.note('Perfect right-on-red: stop first, then go.', 'good');
      },
    },
    {
      instruction: 'Drive west on Queen past the pedestrian crossover',
      sub: 'If the overhead ambers flash, stop and wait until the crossover is COMPLETELY clear',
      target: (env) => ({ x: env.ctx.x > 150 ? 150 : 150, z: 100, r: 12 }),
      done: (env) => env.ctx.x < 120 && Math.abs(env.ctx.z - 100) < 20,
      onComplete: (env) => {
        if (env.faultCount('pxo-violation') === 0) env.note('PXO handled correctly.', 'good');
      },
    },
  ],
};

/* ================================================================== */
/* Lesson 3 — Low-speed maneuvers                                      */
/* ================================================================== */

const lesson3: LessonDef = {
  id: 'maneuvers',
  title: '3 · Low-Speed Maneuvers',
  desc: 'Parallel parking between cars, three-point turn, roadside stop, and the hill start.',
  objective: 'Every G test includes two of these. Practise until they feel boring.',
  habits: ['Parallel parking ≤30 cm from the curb', '3-point turn in 3 moves', 'Roadside stop & safe re-entry', 'No-rollback hill starts'],
  spawn: { edgeId: 'bat3', s: 20, lane: 0 },
  trafficDensity: 0.4,
  parkGhost: true,
  tasks: [
    {
      instruction: 'Parallel park in the gap between the red and blue cars',
      sub: 'Signal right · pull beside the front car · reverse with right lock · straighten · within 30 cm of the curb',
      target: (env) => {
        const g = env.parkingGap();
        return { x: g.center.x, z: g.center.z, r: 7 };
      },
      done: (env) => {
        const g = env.parkingGap();
        const l = env.local(g.center.x, g.center.z, g.heading);
        const parallel = Math.abs(angleDiff(env.playerHeading(), g.heading)) < 0.14;
        const inBay = Math.abs(l.along) < g.length / 2 - 1.6 && Math.abs(l.left) < 0.55;
        return inBay && parallel && stoppedFor(env, 'park', 1.2);
      },
      onComplete: (env) => {
        const g = env.parkingGap();
        const l = env.local(g.center.x, g.center.z, g.heading);
        const curbCm = Math.round((l.left + 0.26) * 100);
        if (env.faultCount('off-road') > 0) env.note('You touched the curb — that costs points. Re-position with less rear lock.', 'warn');
        else if (curbCm <= 32) env.note(`Parked ${Math.max(curbCm, 8)} cm from the curb — examiner-clean.`, 'good');
        else env.note(`Parked, but ~${curbCm} cm off the curb — aim for 30 cm or less.`, 'info');
      },
    },
    {
      instruction: 'Pull out (signal left, shoulder check) and drive to the cul-de-sac',
      target: () => ({ x: -600, z: 540, r: 12 }),
      done: (env) => env.dist(-600, 540) < 16 && env.ctx.speedMs < 4,
    },
    {
      instruction: 'Three-point turn: end up facing back north',
      sub: 'Signal left · check traffic · turn across · reverse with checks · drive out. Three moves is the target',
      done: (env) => {
        if (env.scratch.h0 === undefined) env.scratch.h0 = env.playerHeading();
        const reversed = Math.abs(angleDiff(env.playerHeading(), env.scratch.h0)) > 2.5;
        return reversed && env.ctx.speedMs > 1.5 && env.dist(-600, 540) < 45;
      },
      onComplete: (env) => {
        if (env.gearChanges <= 3) env.note(`Turned in ${Math.max(env.gearChanges, 2)} moves — exactly what the examiner wants.`, 'good');
        else env.note(`That took ${env.gearChanges} moves — use the full road width to do it in 3.`, 'info');
        if (env.faultCount('off-road') > 0) env.note('You touched the curb during the turn — slow hands, more room.', 'warn');
      },
    },
    {
      instruction: 'Drive to Euclid Crescent for the roadside stop',
      target: (env) => {
        const s = env.spot('roadside');
        return { x: s.x, z: s.z, r: 12 };
      },
      done: (env) => {
        const s = env.spot('roadside');
        return env.dist(s.x, s.z) < 26;
      },
    },
    {
      instruction: 'Roadside stop: signal right, pull parallel within 30 cm of the curb, stop',
      sub: 'No need for hazards — just signal, mirror, shoulder, glide in',
      done: (env) => env.ctx.laneOffset < -0.33 && env.ctx.laneOffset > -0.85 && stoppedFor(env, 'rs', 1.5) && !env.ctx.offRoad,
      onComplete: (env) => env.note('Stopped at the roadside. Now re-enter safely.', 'good'),
    },
    {
      instruction: 'Re-enter traffic: signal left, MIRROR + SHOULDER CHECK, pull away',
      done: (env) =>
        env.ctx.speedMs > 3.5 &&
        Math.abs(env.ctx.laneOffset) < 0.6 &&
        env.ctx.time - env.ctx.lastShoulderLeft < 8,
      onComplete: (env) => env.note('Checked the blind spot before pulling out — the habit that passes tests.', 'good'),
    },
    {
      instruction: 'Drive to the Davenport hill',
      target: (env) => {
        const s = env.spot('hillStop');
        return { x: s.x, z: s.z, r: 14 };
      },
      done: (env) => {
        const s = env.spot('hillStop');
        return env.dist(s.x, s.z) < 18;
      },
    },
    {
      instruction: 'Stop on the grade and PARK (hold Space at a stop)',
      sub: 'Feel the grade try to pull you back',
      done: (env) => {
        const s = env.spot('hillStop');
        return env.dist(s.x, s.z) < 22 && env.playerGear() === 'P' && stoppedFor(env, 'hill', 1.2);
      },
    },
    {
      instruction: 'Pull away uphill WITHOUT rolling back',
      sub: 'Brake → throttle quickly; the examiner allows almost no rollback',
      done: (env) => {
        if (env.scratch.hz === undefined) {
          env.scratch.hz = env.ctx.z;
          env.scratch.roll = 0;
        }
        // rolling back = moving north (-z is north; heading south ⇒ rollback increases -dz? track via speed sign)
        const dz = env.ctx.z - (env.scratch.hzPrev ?? env.ctx.z);
        env.scratch.hzPrev = env.ctx.z;
        const fwdZ = Math.cos(env.playerHeading());
        if (dz * fwdZ < 0) env.scratch.roll += Math.abs(dz);
        return env.ctx.speedMs > 4;
      },
      onComplete: (env) => {
        const roll = env.scratch.roll ?? 0;
        if (roll < 0.4) env.note(`Hill start with ${roll < 0.1 ? 'zero' : 'minimal'} rollback — pass.`, 'good');
        else env.note(`You rolled back ${roll.toFixed(1)} m — be quicker from brake to gas, or hold the handbrake.`, 'warn');
      },
    },
  ],
};

/* ================================================================== */
/* Lesson 4 — Roundabout & city lane changes                           */
/* ================================================================== */

const lesson4: LessonDef = {
  id: 'roundabout',
  title: '4 · Roundabout & Lane Changes',
  desc: 'Mirror–signal–shoulder lane changes, the construction merge, and roundabout discipline.',
  objective: 'Change lanes like a ritual: mirror, signal, shoulder check, then move.',
  habits: ['M-S-S on every lane change', 'Early merges at closures', 'Yield on roundabout entry', 'Signal right before your roundabout exit'],
  spawn: { edgeId: 'kg3', s: 30, lane: 0 },
  tasks: [
    {
      instruction: 'On King St: change lanes RIGHT, then back LEFT',
      sub: 'Each time: mirror (M) · signal (E/Q) · shoulder check (. or ,) · move',
      done: (env) => env.laneChanges.includes('right') && env.laneChanges.includes('left'),
      onComplete: (env) => {
        const misses = env.faultCount('no-shoulder-check') + env.faultCount('no-signal-lane-change');
        if (misses === 0) env.note('Both lane changes fully observed — that is the standard.', 'good');
        else env.note('A check or signal was missed — examiners fail people for exactly this.', 'warn');
      },
    },
    {
      instruction: 'Construction ahead past McCaul — merge LEFT early',
      sub: 'The right lane is coned off. Move over before the taper, no cone contact',
      target: () => ({ x: 380, z: -150, r: 16 }),
      done: (env) => env.ctx.x > 560 && Math.abs(env.ctx.z + 150) < 25,
      onComplete: (env) => {
        if (env.faultCount('hit-cone') === 0) env.note('Through the work zone clean.', 'good');
        else env.note('You clipped a cone — in the real test that can end the drive.', 'warn');
      },
    },
    {
      instruction: 'Roundabout: yield on entry, take the 2nd exit (King St continues east)',
      sub: 'Slow to ~30, yield to circulating traffic from your left, signal RIGHT as you pass the exit before yours',
      target: () => ({ x: 600, z: -150, r: 18 }),
      done: (env) => {
        if (env.ctx.laneObj?.edge.def.id.startsWith('rb') && env.ctx.indicator === 'right') env.scratch.sigOk = 1;
        return env.ctx.laneObj?.edge.def.id === 'kg6';
      },
      onComplete: (env) => {
        if (env.scratch.sigOk) env.note('Signalled before exiting the roundabout — exactly right.', 'good');
        else env.note('Remember to signal right just before YOUR exit so others can enter.', 'info');
        if (env.faultCount('row-yield') === 0) env.note('Clean entry — yielded to circulating traffic.', 'good');
      },
    },
    {
      instruction: 'Come back through the roundabout westbound (2nd exit again)',
      sub: 'Same ritual from the other side',
      done: (env) => env.ctx.laneObj?.edge.def.id === 'kg5' && env.ctx.x < 540,
    },
  ],
};

/* ================================================================== */
/* Lesson 5 — Highway                                                  */
/* ================================================================== */

const lesson5: LessonDef = {
  id: 'highway',
  title: '5 · Highway 401: Merge, Maintain, Exit',
  desc: 'The defining G-test skill: acceleration-lane merges, highway speed, lane changes, clean exits.',
  objective: 'Merge at traffic speed with a shoulder check — merging blind is an automatic fail.',
  habits: ['Match speed on the acceleration lane', 'Signal + shoulder check to merge', '2–3 s gap at 100 km/h', 'Slow on the ramp, not the highway'],
  spawn: { edgeId: 'fr2', s: 30, lane: 0 },
  tasks: [
    {
      instruction: 'Take the Highway 401 EAST on-ramp ahead',
      sub: 'Green 401 sign on your left — turn onto the ramp',
      target: () => ({ x: -480, z: -380, r: 12 }),
      done: (env) => env.ctx.laneObj?.edge.def.id === 'rampOn' || env.ctx.laneObj?.edge.def.id === 'accel',
    },
    {
      instruction: 'MERGE: build speed to ~100, signal left, shoulder check, blend into a gap',
      sub: 'Use the whole acceleration lane — do not stop unless traffic forces it',
      done: (env) => env.merges > 0 || env.ctx.laneObj?.edge.def.kind === 'highway',
      onComplete: (env) => {
        if (env.faultCount('merge-no-shoulder-check') > 0) env.note('You merged without a shoulder check — AUTOMATIC FAIL on the real test.', 'warn');
        else if (env.faultCount('merge-too-slow') > 0) env.note('Merged under traffic speed — commit to the throttle on the ramp.', 'warn');
        else env.note('Clean merge. That skill IS the G test.', 'good');
      },
    },
    {
      instruction: 'Maintain 95–105 km/h with a safe gap for 20 seconds',
      sub: 'Middle or right lane; the diamond lane is HOV 2+',
      done: (env) => heldFor(env, 'cruise', env.ctx.speedKmh > 93 && env.ctx.speedKmh < 107 && !env.ctx.inHovLane, 20),
    },
    {
      instruction: 'Lane change LEFT, then back RIGHT, at highway speed',
      sub: 'Mirror · signal · shoulder · move. Smooth, no big steering',
      done: (env) => env.laneChanges.includes('left') && env.laneChanges.includes('right'),
      onComplete: (env) => {
        if (env.faultCount('no-shoulder-check') === 0) env.note('Highway lane changes fully observed.', 'good');
      },
    },
    {
      instruction: 'Take EXIT 12 (McCaul Ave)',
      sub: 'Signal right early, move into the right lane, slow down ON THE RAMP — not on the 401',
      done: (env) => env.ctx.laneObj?.edge.def.id === 'rampOff' && env.ctx.speedKmh < 70,
      onComplete: (env) => {
        if (env.faultCount('hard-brake') === 0) env.note('Decelerated on the ramp like you should.', 'good');
        else env.note('You braked hard on the mainline — exit speed management needs work.', 'warn');
      },
    },
    {
      instruction: 'Yield at the bottom of the ramp and return to Adelaide Frontage',
      done: (env) => env.ctx.laneObj?.edge.def.name.includes('Frontage') === true && env.ctx.speedMs > 2,
    },
  ],
};

export const LESSONS: LessonDef[] = [lesson1, lesson2, lesson3, lesson4, lesson5];

export const MOCK_TEST_CARD = {
  id: 'mocktest',
  title: '6 · Mock G Road Test',
  desc: 'The full examiner experience: routed instructions, silent grading, weighted rubric, report card.',
};

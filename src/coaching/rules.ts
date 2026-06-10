/**
 * The Ontario examiner, encoded as rules. Each rule watches the DriveContext
 * stream and reports faults (with DriveTest-style category + severity) and
 * gentle live coaching. Severities: minor / major / dangerous / autofail —
 * the autofail set mirrors the real test (collision, running a red, passing
 * open streetcar doors or a flashing school bus, merging blind, striking a
 * pedestrian, dangerous actions).
 */

import type { DriveContext } from './context';
import type { Fault, RubricCategory, Severity } from '../core/types';

export interface RuleSink {
  fault(code: string, category: RubricCategory, severity: Severity, message: string, ctx: DriveContext): void;
  coach(text: string, kind?: 'info' | 'warn' | 'good'): void;
}

export interface Rule {
  id: string;
  update(ctx: DriveContext, sink: RuleSink): void;
  reset?(): void;
}

const SHOULDER_WINDOW = 6; // seconds before a lane change in which a check counts
const SIGNAL_LEAD = 2.2; // seconds of indicator before the maneuver

/* ------------------------------------------------------------------ */

class SignalAndShoulderOnLaneChange implements Rule {
  id = 'lane-change-obs';
  update(ctx: DriveContext, sink: RuleSink): void {
    const side = ctx.laneChanged;
    if (!side) return;
    const lastShoulder = side === 'left' ? ctx.lastShoulderLeft : ctx.lastShoulderRight;
    const checked = ctx.time - lastShoulder < SHOULDER_WINDOW;
    const signalled = ctx.indicator === side && ctx.indicatorAge >= SIGNAL_LEAD;
    const signalledLate = ctx.indicator === side && ctx.indicatorAge < SIGNAL_LEAD;
    if (!checked) {
      sink.fault('no-shoulder-check', 'observation', 'major', `Lane change ${side} without a blind-spot check`, ctx);
      sink.coach(`Shoulder check ${side === 'left' ? '(,)' : '(.)'} before every lane change.`, 'warn');
    } else {
      sink.coach('Good blind-spot check.', 'good');
    }
    if (ctx.indicator !== side && !signalled) {
      sink.fault('no-signal-lane-change', 'laneChanges', 'major', `Lane change ${side} without signalling`, ctx);
      sink.coach('Signal before changing lanes (Q/E).', 'warn');
    } else if (signalledLate) {
      sink.fault('late-signal-lane-change', 'laneChanges', 'minor', 'Signal came on too late before the lane change', ctx);
    }
  }
}

class MergeRule implements Rule {
  id = 'merge';
  private wasOnMergeLane = false;
  private mergeSpeed = 0;
  update(ctx: DriveContext, sink: RuleSink): void {
    if (ctx.onMergeLane) {
      this.wasOnMergeLane = true;
      this.mergeSpeed = ctx.speedKmh;
      if (ctx.mergeLaneRemaining < 60 && ctx.indicator !== 'left') {
        sink.coach('Signal left and build speed to match traffic.', 'warn');
      }
    }
    if (ctx.merged) {
      const checked = ctx.time - ctx.lastShoulderLeft < SHOULDER_WINDOW;
      if (!checked) {
        sink.fault('merge-no-shoulder-check', 'highway', 'autofail', 'Merged onto the highway without a blind-spot check', ctx);
      } else if (this.mergeSpeed < 65) {
        sink.fault('merge-too-slow', 'highway', 'major', `Merged at only ${Math.round(this.mergeSpeed)} km/h — match traffic speed`, ctx);
      } else {
        sink.coach('Clean merge — speed matched, mirror–signal–shoulder.', 'good');
      }
      if (ctx.indicator !== 'left' && !checked) {
        // covered by autofail above; avoid double-fault
      } else if (ctx.indicator !== 'left' && ctx.indicatorAge === 0) {
        sink.fault('merge-no-signal', 'highway', 'major', 'Merged without signalling', ctx);
      }
      this.wasOnMergeLane = false;
    }
  }
  reset(): void {
    this.wasOnMergeLane = false;
  }
}

class TurnRules implements Rule {
  id = 'turns';
  update(ctx: DriveContext, sink: RuleSink): void {
    const t = ctx.turnCompleted;
    if (!t) return;
    if (t.turn === 'left' || t.turn === 'right') {
      const signalledAtEntry = t.indicatorAtEntry === t.turn;
      if (!signalledAtEntry && ctx.indicator !== t.turn) {
        sink.fault('no-signal-turn', 'turns', 'major', `Turned ${t.turn} without signalling`, ctx);
        sink.coach('Signal at least 3 seconds before turning (Q/E).', 'warn');
      } else if (signalledAtEntry && t.indicatorAgeAtEntry < SIGNAL_LEAD) {
        sink.fault('late-signal-turn', 'turns', 'minor', 'Signal came on too late before the turn', ctx);
        sink.coach('Get the signal on earlier — well before the intersection.', 'info');
      }
      if (t.enteredAt - t.lastMirrorAtEntry > 9) {
        sink.fault('no-mirror-turn', 'observation', 'minor', 'No mirror check before the turn', ctx);
      }
    }
  }
}

class StopAndRowRules implements Rule {
  id = 'stops-row';
  update(ctx: DriveContext, sink: RuleSink): void {
    const e = ctx.enteredIntersection;
    if (!e) return;
    const stopped = e.minApproachSpeed < 0.45;

    if (e.control === 'signal' && e.signal) {
      if (e.signal.ball === 'red' && !e.signal.leftArrow) {
        if (!stopped) {
          sink.fault('ran-red', 'intersections', 'autofail', 'Entered on a red light without stopping', ctx);
        } else {
          // RTOR is legal after a full stop; judged as a right turn by exit —
          // but proceeding straight/left from a stop on red is still a run
          sink.coach('Entered on red after stopping — only legal for a right turn on red.', 'warn');
          sink.fault('proceeded-on-red', 'intersections', 'dangerous', 'Proceeded on a red light after stopping', ctx);
        }
      } else if (e.signal.ball === 'amber') {
        const comfortable = (e.minApproachSpeed * e.minApproachSpeed) / (2 * 12) < 3.0;
        if (comfortable && e.minApproachSpeed > 8) {
          sink.fault('amber-run', 'intersections', 'minor', 'Entered on amber when a comfortable stop was possible', ctx);
        }
      }
      if (e.pedsCrossing > 0) {
        sink.fault('row-pedestrian', 'intersections', 'dangerous', 'Entered while a pedestrian was in the crosswalk', ctx);
      }
    }

    if (e.control === 'stop') {
      if (!stopped) {
        sink.fault('rolling-stop', 'intersections', 'major', `Rolling stop (${(e.minApproachSpeed * 3.6).toFixed(0)} km/h) — come to a complete stop`, ctx);
        sink.coach('Stop completely behind the line, count one-two, then go.', 'warn');
      } else if (e.stopOverrun > 1.2) {
        sink.fault('stopped-past-line', 'intersections', 'minor', 'Stopped past the stop line', ctx);
      } else {
        sink.coach('Full stop — nice.', 'good');
      }
      if (!e.myTurnAtAllWay) {
        sink.fault('row-allway', 'intersections', 'major', 'Went out of turn at the all-way stop', ctx);
      }
      if (stopped && !e.conflictsClear) {
        sink.fault('row-minor-stop', 'intersections', 'major', 'Pulled out without a safe gap', ctx);
      }
      if (e.pedsCrossing > 0) {
        sink.fault('row-pedestrian', 'intersections', 'dangerous', 'Failed to yield to a pedestrian at the stop', ctx);
      }
    }

    if (e.control === 'yield' || e.control === 'roundabout-yield') {
      if (!e.conflictsClear) {
        sink.fault(
          'row-yield',
          e.control === 'roundabout-yield' ? 'intersections' : 'intersections',
          'major',
          e.control === 'roundabout-yield' ? 'Entered the roundabout into circulating traffic' : 'Failed to yield right-of-way',
          ctx,
        );
      } else if (e.control === 'roundabout-yield') {
        sink.coach('Yield on entry, signal right before your exit.', 'info');
      }
    }
  }
}

class LeftTurnOncoming implements Rule {
  id = 'left-oncoming';
  update(ctx: DriveContext, sink: RuleSink): void {
    const t = ctx.turnCompleted;
    if (!t || t.turn !== 'left') return;
    if (t.control === 'signal' && t.signal?.ball === 'green' && !t.signal.leftArrow && !t.oncomingClear) {
      sink.fault('left-across-traffic', 'turns', 'dangerous', 'Turned left across oncoming traffic without a safe gap', ctx);
    }
    if (t.control === 'none' && !t.oncomingClear) {
      sink.fault('left-across-traffic', 'turns', 'dangerous', 'Left turn without yielding to oncoming traffic', ctx);
    }
    if (t.control === 'signal' && t.signal?.leftArrow) {
      sink.coach('Protected left on the advanced green — well used.', 'good');
    }
  }
}

class RtorRule implements Rule {
  id = 'rtor';
  update(ctx: DriveContext, sink: RuleSink): void {
    const t = ctx.turnCompleted;
    if (!t || t.turn !== 'right') return;
    if (t.control === 'signal' && t.signal?.ball === 'red') {
      if (t.minApproachSpeed >= 0.45) {
        sink.fault('rtor-no-stop', 'intersections', 'dangerous', 'Right turn on red without a complete stop first', ctx);
        sink.coach('Right on red is allowed only AFTER a full stop behind the line.', 'warn');
      } else if (!t.conflictsClear) {
        sink.fault('rtor-no-gap', 'intersections', 'major', 'Right on red without a safe gap', ctx);
      } else {
        sink.coach('Right-on-red done properly: full stop, then go when clear.', 'good');
      }
    }
  }
}

class MirrorScan implements Rule {
  id = 'mirror-scan';
  private nagT = 0;
  private brakeMirrorCooldown = 0;
  private brakingT = 0;
  update(ctx: DriveContext, sink: RuleSink): void {
    if (ctx.speedMs < 3) return;
    const age = ctx.time - ctx.lastMirror;
    this.nagT += ctx.dt;
    this.brakeMirrorCooldown = Math.max(0, this.brakeMirrorCooldown - ctx.dt);
    if (age > 14 && this.nagT > 16) {
      sink.coach('Scan your mirrors every ~10 seconds (M).', 'info');
      this.nagT = 0;
    }
    // mirror before sustained braking — requires an actual pedal press, so
    // engine-braking / coasting deceleration never counts
    if (ctx.brakePedal > 0.25 && ctx.gLong < -0.26 && ctx.speedMs > 7) {
      this.brakingT += ctx.dt;
    } else {
      this.brakingT = 0;
    }
    if (this.brakingT > 0.5 && this.brakeMirrorCooldown <= 0) {
      if (age > 5) {
        sink.fault('no-mirror-brake', 'observation', 'minor', 'Braked without checking the mirror first', ctx);
      }
      this.brakeMirrorCooldown = 9;
    }
  }
}

class FollowingDistance implements Rule {
  id = 'following';
  private tightT = 0;
  update(ctx: DriveContext, sink: RuleSink): void {
    const gap = ctx.followingTimeGap;
    if (gap === null || ctx.speedMs < 5) {
      this.tightT = 0;
      return;
    }
    const required = 2 + ctx.weatherSeverity * 1.6; // 2 s dry → ~3 s snow
    if (gap < 1.0) {
      this.tightT += ctx.dt;
      if (this.tightT > 1.2) {
        sink.fault('tailgating', 'driving', 'major', `Tailgating — ${gap.toFixed(1)} s gap`, ctx);
        this.tightT = -8;
      }
    } else if (gap < required) {
      this.tightT += ctx.dt;
      if (this.tightT > 3) {
        sink.fault('following-too-close', 'driving', 'minor', `Following gap ${gap.toFixed(1)} s — keep ${required.toFixed(0)}+ s${ctx.weatherSeverity > 0.1 ? ' in this weather' : ''}`, ctx);
        this.tightT = -10;
      }
    } else {
      this.tightT = Math.max(0, this.tightT - ctx.dt);
    }
  }
}

class SpeedRule implements Rule {
  id = 'speed';
  private overT = 0;
  private underT = 0;
  update(ctx: DriveContext, sink: RuleSink): void {
    const over = ctx.speedKmh - ctx.limitKmh;
    if (over > 4) {
      this.overT += ctx.dt;
      if (over > 20) {
        sink.fault('speed-dangerous', 'driving', 'dangerous', `${Math.round(ctx.speedKmh)} in a ${ctx.limitKmh} zone`, ctx);
        this.overT = -10;
      } else if (over > 12 && this.overT > 1.6) {
        sink.fault('speeding', 'driving', 'major', `${Math.round(ctx.speedKmh)} km/h in a ${ctx.limitKmh} zone`, ctx);
        this.overT = -8;
      } else if (this.overT > 3.2) {
        sink.fault('speeding-minor', 'driving', 'minor', `Over the limit (${Math.round(ctx.speedKmh)} in a ${ctx.limitKmh})`, ctx);
        this.overT = -10;
      }
      if (ctx.zone && over > 4) sink.coach(`${ctx.zone.label}: limit ${ctx.limitKmh} km/h.`, 'warn');
    } else {
      this.overT = Math.max(0, this.overT - ctx.dt);
    }
    // impeding traffic
    const freeRoad = !ctx.leader || ctx.leader.gap > 40;
    const noControlAhead = !ctx.approach || ctx.approach.dist > 55;
    if (freeRoad && noControlAhead && ctx.speedMs > 1.5 && ctx.speedKmh < ctx.limitKmh * 0.55 && !ctx.offRoad) {
      this.underT += ctx.dt;
      if (this.underT > 7) {
        sink.fault('too-slow', 'driving', 'minor', 'Driving well under the limit impedes traffic', ctx);
        sink.coach('Keep up with the posted limit when it is safe.', 'info');
        this.underT = -14;
      }
    } else {
      this.underT = Math.max(0, this.underT - ctx.dt);
    }
  }
}

class Smoothness implements Rule {
  id = 'smoothness';
  private cool = 0;
  private accelT = 0;
  update(ctx: DriveContext, sink: RuleSink): void {
    this.cool = Math.max(0, this.cool - ctx.dt);
    // Harsh acceleration must be SUSTAINED (>0.42 g for 0.55 s) — brief peaks
    // from gear shifts or grade changes don't count. A full-throttle launch in
    // the trainer car tops out ≈0.38 g, so it only fires on genuinely
    // aggressive moves (e.g. flooring it down a hill).
    if (ctx.gLong > 0.42) this.accelT += ctx.dt;
    else this.accelT = Math.max(0, this.accelT - ctx.dt * 2);
    if (this.cool > 0) return;
    if (ctx.gLong < -0.46 && ctx.speedMs > 6 && !ctx.collision) {
      sink.fault('hard-brake', 'driving', 'minor', 'Hard braking — brake earlier and more gently', ctx);
      this.cool = 7;
    } else if (this.accelT > 0.55) {
      sink.fault('hard-accel', 'driving', 'minor', 'Harsh acceleration', ctx);
      this.accelT = 0;
      this.cool = 7;
    } else if (Math.abs(ctx.gLat) > 0.5 && ctx.speedMs > 8) {
      sink.fault('hard-corner', 'turns', 'minor', 'Cornering too fast — slow before the turn, accelerate out gently', ctx);
      this.cool = 7;
    }
  }
  reset(): void {
    this.accelT = 0;
    this.cool = 0;
  }
}

class LaneDiscipline implements Rule {
  id = 'lane-discipline';
  private driftT = 0;
  private bikeT = 0;
  private hovT = 0;
  private curbCool = 0;
  update(ctx: DriveContext, sink: RuleSink): void {
    this.curbCool = Math.max(0, this.curbCool - ctx.dt);
    if (ctx.wrongWay) {
      sink.fault('wrong-way', 'driving', 'dangerous', 'Driving against traffic!', ctx);
      return;
    }
    if (ctx.offRoad && ctx.speedMs > 2 && this.curbCool <= 0) {
      sink.fault('off-road', 'driving', 'major', 'Left the roadway / mounted the curb', ctx);
      this.curbCool = 6;
    }
    // A live indicator means the driver is repositioning on purpose — judged
    // by the lane-change rules instead, so don't also count it as weaving.
    if (!ctx.laneObj || ctx.speedMs < 4 || ctx.insideNode || ctx.laneChanged || ctx.indicator !== 'off') {
      this.driftT = 0;
      return;
    }
    const off = Math.abs(ctx.laneOffset);
    if (off > 1.3) {
      this.driftT += ctx.dt;
      if (this.driftT > 2.4) {
        sink.fault('straddling', 'driving', 'major', 'Straddling lanes — pick a lane and centre in it', ctx);
        this.driftT = -8;
      }
    } else if (off > 0.85) {
      this.driftT += ctx.dt;
      if (this.driftT > 4.5) {
        sink.fault('lane-drift', 'driving', 'minor', 'Drifting in the lane — keep centred', ctx);
        this.driftT = -9;
      }
    } else {
      this.driftT = Math.max(0, this.driftT - ctx.dt * 1.5);
    }
    if (ctx.inBikeLane && ctx.speedMs > 3) {
      this.bikeT += ctx.dt;
      if (this.bikeT > 2) {
        sink.fault('bike-lane', 'driving', 'major', 'Driving in the bike lane', ctx);
        this.bikeT = -10;
      }
    } else {
      this.bikeT = 0;
    }
    if (ctx.inHovLane) {
      this.hovT += ctx.dt;
      if (this.hovT > 4) {
        sink.fault('hov-violation', 'highway', 'minor', 'HOV 2+ lane — you are driving alone', ctx);
        sink.coach('The diamond lane needs 2+ occupants. Move right.', 'warn');
        this.hovT = -22;
      }
    } else {
      this.hovT = Math.max(0, this.hovT - ctx.dt);
    }
  }
}

class TransitRules implements Rule {
  id = 'transit';
  private scCool = 0;
  private busCool = 0;
  update(ctx: DriveContext, sink: RuleSink): void {
    this.scCool = Math.max(0, this.scCool - ctx.dt);
    this.busCool = Math.max(0, this.busCool - ctx.dt);
    if (ctx.streetcar.doorsOpen && ctx.streetcar.sameStreetAhead && ctx.streetcar.behindIt) {
      if (ctx.streetcar.passingIt && this.scCool <= 0) {
        sink.fault('passed-streetcar-doors', 'driving', 'autofail', 'Passed a streetcar with its doors open', ctx);
        this.scCool = 10;
      } else if (ctx.speedMs > 3) {
        sink.coach('Streetcar doors open ahead — stop 2 m behind the rear doors.', 'warn');
      }
    }
    if (ctx.schoolBus.flashing && ctx.schoolBus.sameStreet) {
      if (ctx.schoolBus.passingIt && this.busCool <= 0) {
        sink.fault('passed-school-bus', 'driving', 'autofail', 'Passed a school bus with red lights flashing', ctx);
        this.busCool = 10;
      } else if (ctx.speedMs > 3) {
        sink.coach('School bus flashing — stop in both directions.', 'warn');
      }
    }
  }
}

class EmergencyRule implements Rule {
  id = 'emergency';
  private exposure = 0;
  private resolved = false;
  update(ctx: DriveContext, sink: RuleSink): void {
    if (!ctx.emergency.active) {
      this.exposure = 0;
      this.resolved = false;
      return;
    }
    if (!ctx.emergency.near) return;
    if (this.resolved) return;
    const pulledOver = ctx.speedMs < 0.6;
    if (pulledOver) {
      sink.coach('Good — stopped for the emergency vehicle.', 'good');
      this.resolved = true;
      return;
    }
    this.exposure += ctx.dt;
    if (this.exposure > 2 && this.exposure < 2.2) {
      sink.coach('Emergency vehicle! Signal, pull to the right, and STOP.', 'warn');
    }
    if (this.exposure > 7) {
      sink.fault('no-pullover', 'driving', 'major', 'Failed to pull over and stop for an emergency vehicle', ctx);
      this.resolved = true;
    }
  }
}

class PxoRule implements Rule {
  id = 'pxo';
  private cool = 0;
  update(ctx: DriveContext, sink: RuleSink): void {
    this.cool = Math.max(0, this.cool - ctx.dt);
    if (!ctx.pxo.activeNear && ctx.pxo.occupied === 0) return;
    if (ctx.pxo.dist < 30 && ctx.speedMs > 4 && this.cool <= 0) {
      sink.coach('Pedestrian crossover ahead — stop until it is completely clear.', 'warn');
      this.cool = 8;
    }
    // crossing the PXO line while occupied
    if (ctx.pxo.occupied > 0 && ctx.pxo.dist < 6 && ctx.speedMs > 1.5 && this.cool > -1) {
      sink.fault('pxo-violation', 'intersections', 'dangerous', 'Drove through an occupied pedestrian crossover', ctx);
      this.cool = 10;
    }
  }
}

class CollisionRule implements Rule {
  id = 'collision';
  update(ctx: DriveContext, sink: RuleSink): void {
    const c = ctx.collision;
    if (!c) return;
    if (c.kind === 'pedestrian') {
      sink.fault('hit-pedestrian', 'driving', 'autofail', 'Struck a pedestrian', ctx);
    } else if (c.kind === 'cyclist') {
      sink.fault('hit-cyclist', 'driving', 'autofail', 'Struck a cyclist', ctx);
    } else if (c.kind === 'cone') {
      sink.fault('hit-cone', 'driving', 'minor', 'Hit a construction cone', ctx);
    } else if (c.impulse > 1.2) {
      sink.fault('collision', 'driving', 'autofail', `Collision (${c.kind})`, ctx);
    } else {
      sink.fault('contact', 'driving', 'major', `Contact with ${c.kind}`, ctx);
    }
  }
}

class NightAndWeather implements Rule {
  id = 'night-weather';
  private lightsT = 0;
  private wiperT = 0;
  update(ctx: DriveContext, sink: RuleSink): void {
    if (ctx.night > 0.55 && !ctx.headlights && ctx.speedMs > 2) {
      this.lightsT += ctx.dt;
      if (this.lightsT > 4 && this.lightsT < 4.2) sink.coach('It’s dark — headlights on (L).', 'warn');
      if (this.lightsT > 12) {
        sink.fault('no-headlights', 'driving', 'major', 'Driving at night without headlights', ctx);
        this.lightsT = -20;
      }
    } else {
      this.lightsT = Math.max(0, this.lightsT - ctx.dt);
    }
    if ((ctx.weatherKind === 'rain' || ctx.weatherKind === 'snow') && !ctx.wipers && ctx.speedMs > 2) {
      this.wiperT += ctx.dt;
      if (this.wiperT > 5 && this.wiperT < 5.2) sink.coach('Wipers on (U) — keep your sightlines clear.', 'info');
      if (this.wiperT > 6) this.wiperT = -30;
    } else {
      this.wiperT = Math.max(0, this.wiperT - ctx.dt);
    }
  }
}

export function buildRules(): Rule[] {
  return [
    new SignalAndShoulderOnLaneChange(),
    new MergeRule(),
    new TurnRules(),
    new StopAndRowRules(),
    new LeftTurnOncoming(),
    new RtorRule(),
    new MirrorScan(),
    new FollowingDistance(),
    new SpeedRule(),
    new Smoothness(),
    new LaneDiscipline(),
    new TransitRules(),
    new EmergencyRule(),
    new PxoRule(),
    new CollisionRule(),
    new NightAndWeather(),
  ];
}

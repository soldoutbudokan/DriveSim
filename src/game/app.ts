/**
 * GameApp: top-level orchestration — owns the engine, world, traffic and
 * coach; manages modes (menu / free roam / lesson / exam / replay), menus,
 * and settings application. Lessons, the examiner and replay attach here.
 */

import { Engine } from '../core/engine';
import { CityWorld } from '../world/world';
import { TrafficManager } from '../traffic/manager';
import { Coach } from '../coaching/coach';
import { Menus } from '../ui/menus';
import { loadSettings, saveSettings, type Settings } from './settings';
import { LessonRunner } from './lessonRunner';
import { LESSONS, MOCK_TEST_CARD } from '../scenarios/lessons';
import { loadProgress, saveProgress } from './progress';
import { Examiner } from '../examiner/examiner';
import type { ExamReport } from '../scoring/rubric';

export type Mode = 'menu' | 'free' | 'lesson' | 'exam' | 'replay';

export class GameApp {
  readonly engine: Engine;
  readonly world: CityWorld;
  readonly traffic: TrafficManager;
  readonly coach: Coach;
  readonly menus: Menus;
  settings: Settings;
  mode: Mode = 'menu';
  readonly lessonRunner: LessonRunner;
  readonly examiner: Examiner;
  lastReport: ExamReport | null = null;

  /** Per-mode tick extensions (lesson runner, examiner, replay). */
  modeTick: ((dt: number) => void) | null = null;
  /** Called when the user quits the current drive from pause. */
  onQuitDrive: (() => void) | null = null;

  constructor(appEl: HTMLElement, uiEl: HTMLElement) {
    this.engine = new Engine(appEl, uiEl);
    this.world = new CityWorld();
    this.engine.setWorld(this.world);
    this.engine.attachMinimap(this.world.net);
    this.traffic = new TrafficManager(this.world);
    this.engine.attachTraffic(this.traffic);
    this.coach = new Coach(this.engine, this.world, this.traffic);
    this.menus = new Menus(uiEl);
    this.settings = loadSettings();
    this.lessonRunner = new LessonRunner(this);
    this.examiner = new Examiner(this);
    this.examiner.onReport = (r) => this.showExamReport(r, true);
    // the examiner's pencil scratches when a fault is logged silently
    this.engine.events.on('fault', () => {
      if (this.mode === 'exam') this.engine.audio.click(380, 0.035);
    });

    this.engine.buildPlayer(this.settings.carColor);
    this.applySettings();

    this.engine.hooks.tick = (dt) => this.tick(dt);
    this.engine.hooks.inputEnabled = () => !this.menus.visible && this.mode !== 'menu' && this.mode !== 'replay';
    this.engine.hooks.onPauseRequest = () => {
      if (this.mode === 'menu') return true; // swallow
      if (this.menus.visible) {
        this.closePause();
        return true;
      }
      this.openPause();
      return true;
    };
  }

  start(): void {
    this.engine.start();
    this.engine.spawnAt(this.world.examSpawn());
    this.engine.hud.setVisible(false);
    this.showMainMenu();
  }

  private tick(dt: number): void {
    if (this.mode === 'free' || this.mode === 'lesson' || this.mode === 'exam') {
      this.coach.update(dt);
    }
    this.modeTick?.(dt);
  }

  /* ---------------- menus ---------------- */

  showMainMenu(): void {
    this.mode = 'menu';
    this.modeTick = null;
    this.engine.hud.setVisible(false);
    this.engine.hud.setObjective('');
    this.engine.setPaused(false);
    this.menus.showMain(
      {
        freeRoam: () => this.goFreeRoam(),
        lessons: () => this.openLessons(),
        mockTest: () => this.openExam(),
        replays: () => this.openReplays(),
        dashboard: () => this.openDashboard(),
        settings: () => this.openSettings(() => this.showMainMenu()),
        help: () => this.engine.hud.showHelp(true),
      },
      this.menuStats(),
      () => this.openProfiles(),
    );
  }

  /** Hooked by later systems (examiner/replay/persistence). */
  openLessons: () => void = () => {
    const progress = loadProgress();
    const cards = LESSONS.map((l, i) => ({
      id: l.id,
      title: l.title,
      desc: l.desc,
      badge: progress.lessons[l.id]?.completed ? '✓ done' : `lesson ${i + 1}`,
      done: !!progress.lessons[l.id]?.completed,
    }));
    cards.push({
      id: MOCK_TEST_CARD.id,
      title: MOCK_TEST_CARD.title,
      desc: MOCK_TEST_CARD.desc,
      badge: 'examiner',
      done: progress.exams.some((e) => e.passed),
    });
    this.menus.showCards(
      'Lessons',
      'Sequenced like real instruction — finish each to unlock confidence, then take the mock test.',
      cards,
      (id) => {
        if (id === MOCK_TEST_CARD.id) {
          this.openExam();
          return;
        }
        const lesson = LESSONS.find((l) => l.id === id);
        if (lesson) this.lessonRunner.start(lesson);
      },
      () => this.showMainMenu(),
    );
  };
  openExam: () => void = () => {
    const el = this.menus.showCustom(`
      <h1>Mock G Road Test</h1>
      <p class="dim">A full DriveTest-style examination. The examiner gives spoken directions and grades
      <b>silently</b> — no coaching. The route covers city streets, the roundabout, the school zone,
      a roadside stop, the hill, parallel parking, a three-point turn, and Highway 401.</p>
      <h2>Remember</h2>
      <p class="dim">Mirror checks (M) every ~10 s · shoulder checks (, .) before every lane change and merge ·
      signal 3 s early (Q/E) · full stops behind the line · 2–3 s following gap · match traffic speed when merging.
      Collisions and dangerous actions end the test.</p>
      <div class="row" style="margin-top:18px">
        <button class="btn primary" id="begin">Begin the test</button>
        <button class="btn ghost" id="back">Back</button>
      </div>
    `);
    (el.querySelector('#begin') as HTMLElement).onclick = () => this.examiner.start();
    (el.querySelector('#back') as HTMLElement).onclick = () => this.showMainMenu();
  };
  openReplays: () => void = () => this.engine.hud.toast('No replays yet.', 'info');
  openDashboard: () => void = () => this.engine.hud.toast('Drive first — telemetry follows.', 'info');
  openProfiles: () => void = () => {};

  showExamReport(r: ExamReport, save: boolean): void {
    if (save) {
      this.mode = 'menu';
      this.lastReport = r;
      const progress = loadProgress();
      progress.exams.push({ at: r.at, score: r.overall, passed: r.passed });
      saveProgress(progress);
    }
    const catRows = r.categories
      .map(
        (c) => `
      <div class="cat-row">
        <span class="name">${c.label}</span>
        <div class="bar"><i style="width:${c.score}%; background:${c.score >= 85 ? 'var(--good)' : c.score >= 60 ? 'var(--warn)' : 'var(--bad)'}"></i></div>
        <span class="pct">${c.score}%</span>
      </div>`,
      )
      .join('');
    const t0 = r.faults.length ? r.faults[0].time : 0;
    void t0;
    const start = r.at;
    void start;
    const faultRows = r.faults.length
      ? r.faults
          .map(
            (f) =>
              `<li class="${f.severity}"><span class="t">${fmtClock(f.time)}</span><span class="sev">${f.severity}</span>${f.message}</li>`,
          )
          .join('')
      : '<li class="minor"><span class="sev" style="color:var(--good)">clean</span>No faults recorded.</li>';
    const recs = r.recommendations.length
      ? r.recommendations
          .map(
            (rec, i) =>
              `<div class="card" data-lesson="${rec.lessonId}"><h3>${i + 1}. ${rec.title}</h3><p>${rec.reason}</p></div>`,
          )
          .join('')
      : '<p class="dim">Nothing specific — keep your habits sharp and retake any time.</p>';

    const el = this.menus.showCustom(`
      <div class="spread">
        <div>
          <h1>${r.passed ? '✅ PASS' : '❌ FAIL'} — Mock G Road Test</h1>
          <p class="dim">${Math.round(r.durationS / 60)} min · ${r.distanceKm.toFixed(1)} km · observation score ${r.observationScore}
          ${r.autoFail ? ` · <b style="color:var(--bad)">automatic fail: ${r.autoFail.message}</b>` : ''}
          ${!r.autoFail && r.dangerous.length ? ` · <b style="color:var(--bad)">dangerous action recorded</b>` : ''}</p>
        </div>
        <div class="score-big ${r.passed ? 'pass' : 'fail'}">${r.overall}%</div>
      </div>
      <h2>Assessment areas</h2>
      ${catRows}
      <h2>Fault log (${r.faults.length})</h2>
      <ul class="fault-list">${faultRows}</ul>
      <h2>Work on these next</h2>
      <div class="card-grid">${recs}</div>
      <div class="row" style="margin-top:20px">
        <button class="btn primary" id="retake">Retake the test</button>
        <button class="btn" id="replayBtn">Watch replay</button>
        <button class="btn" id="dash">Telemetry</button>
        <button class="btn ghost" id="menu">Main menu</button>
      </div>
    `);
    el.querySelectorAll<HTMLElement>('[data-lesson]').forEach((card) => {
      card.onclick = () => {
        const lesson = LESSONS.find((l) => l.id === card.dataset.lesson);
        if (lesson) this.lessonRunner.start(lesson);
      };
    });
    (el.querySelector('#retake') as HTMLElement).onclick = () => this.openExam();
    (el.querySelector('#replayBtn') as HTMLElement).onclick = () => this.openReplays();
    (el.querySelector('#dash') as HTMLElement).onclick = () => this.openDashboard();
    (el.querySelector('#menu') as HTMLElement).onclick = () => this.showMainMenu();
  }
  menuStats: () => { profile: string; bestExam: string; lessonsDone: number; lessonsTotal: number } = () => {
    const progress = loadProgress();
    const done = LESSONS.filter((l) => progress.lessons[l.id]?.completed).length;
    const best = progress.exams.length ? Math.max(...progress.exams.map((e) => e.score)) : null;
    return {
      profile: 'Driver',
      bestExam: best !== null ? `${best}%` : '',
      lessonsDone: done,
      lessonsTotal: LESSONS.length + 1,
    };
  };

  goFreeRoam(): void {
    this.menus.hide();
    this.mode = 'free';
    this.coach.reset();
    this.coach.liveCoaching = true;
    this.coach.showFaults = true;
    this.engine.minimap?.clearHeat();
    this.engine.routeOverlay = null;
    this.engine.mapMarkers = [];
    this.engine.spawnAt(this.world.spawn());
    this.engine.hud.setVisible(true);
    this.engine.hud.clearToasts();
    this.engine.hud.setObjective('Free roam', 'Live coaching is on — drive like the examiner is watching. P pauses.');
    this.engine.setPaused(false);
  }

  openPause(): void {
    this.engine.setPaused(true);
    this.engine.hud.centerMsg('');
    this.menus.showPause(
      () => this.closePause(),
      null,
      () => this.openSettings(() => this.openPause()),
      () => {
        this.menus.hide();
        this.onQuitDrive ? this.onQuitDrive() : this.showMainMenu();
      },
    );
  }

  closePause(): void {
    this.menus.hide();
    this.engine.setPaused(false);
  }

  openSettings(back: () => void): void {
    this.menus.showSettings(
      this.settings,
      (s) => {
        this.settings = s;
        this.applySettings();
        saveSettings(s);
      },
      () => back(),
    );
  }

  applySettings(): void {
    const s = this.settings;
    const e = this.engine;
    if (s.tier === 'auto') {
      e.autoQuality.enabled = true;
      e.setQuality(e.autoQuality.current);
    } else {
      e.autoQuality.enabled = false;
      e.setQuality(s.tier);
    }
    e.audio.levels = { ...s.audio };
    e.audio.applyLevels();
    e.input.settings.steerSensitivity = s.steerSensitivity;
    e.input.settings.invertSteer = s.invertSteer;
    e.vehicle.assists = { ...s.assists };
    e.autoHeadlights = s.autoHeadlights;
    e.camera.reducedMotion = s.reducedMotion;
    this.traffic.setDensity(s.trafficDensity);
    this.traffic.emergencyInterval = s.emergencyEvents ? 240 : 0;
    e.weather.set(s.weather);
    e.sky.setPreset(s.time);
    document.documentElement.style.fontSize = `${16 * s.uiScale}px`;
    // repaint the car if needed
    const currentColor = s.carColor;
    if (this.lastCarColor !== currentColor) {
      const pose = { x: e.vehicle.x, z: e.vehicle.z, heading: e.vehicle.heading };
      e.buildPlayer(currentColor);
      void pose;
      this.lastCarColor = currentColor;
    }
  }

  private lastCarColor = -1;
}

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

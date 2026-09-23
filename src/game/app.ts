/**
 * GameApp: top-level orchestration — owns the engine, world, traffic and
 * coach; manages modes (menu / free roam / lesson / exam / replay), menus,
 * and settings application. Lessons, the examiner and replay attach here.
 */

import { Engine } from '../core/engine';
import { CityWorld } from '../world/world';
import { TrafficManager } from '../traffic/manager';
import { Coach } from '../coaching/coach';
import { Menus, MENU_ICON, escapeHtml } from '../ui/menus';
import { loadSettings, saveSettings, type Settings } from './settings';
import { LessonRunner } from './lessonRunner';
import { LESSONS, MOCK_TEST_CARD } from '../scenarios/lessons';
import { loadProgress, saveProgress } from './progress';
import { Examiner } from '../examiner/examiner';
import type { ExamReport } from '../scoring/rubric';
import { Recorder } from '../replay/recorder';
import { ReplayPlayer } from '../replay/player';
import type { ReplayPayload } from '../replay/format';
import { Profiles, listReplayMetas, getReplay, deleteReplay } from '../persistence/store';
import { renderDashboard } from '../telemetry/dashboard';

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
  readonly profiles = new Profiles();
  readonly recorder: Recorder;
  readonly replayPlayer: ReplayPlayer;
  lastReport: ExamReport | null = null;
  /** Most recent recorded drive (for the dashboard / instant replay). */
  lastDrive: ReplayPayload | null = null;

  /** Per-mode tick extensions (lesson runner, examiner, replay). */
  modeTick: ((dt: number) => void) | null = null;
  /** Called when the user quits the current drive from pause. */
  onQuitDrive: (() => void) | null = null;
  /** Called when the user restarts the current drive from pause. */
  onRestartDrive: (() => void) | null = null;
  /** Pause-menu subtitle for the current drive. */
  driveTitle = '';

  constructor(appEl: HTMLElement, uiEl: HTMLElement) {
    this.settings = loadSettings();
    this.engine = new Engine(appEl, uiEl, this.settings.tier === 'auto' ? 'medium' : this.settings.tier);
    this.world = new CityWorld();
    this.engine.setWorld(this.world);
    this.engine.attachMinimap(this.world.net);
    this.traffic = new TrafficManager(this.world);
    this.engine.attachTraffic(this.traffic);
    this.coach = new Coach(this.engine, this.world, this.traffic);
    this.menus = new Menus(uiEl);
    this.lessonRunner = new LessonRunner(this);
    this.examiner = new Examiner(this);
    this.recorder = new Recorder(this);
    this.replayPlayer = new ReplayPlayer(this);
    this.examiner.onReport = (r) => this.showExamReport(r, true);
    // the examiner's pencil scratches when a fault is logged silently
    this.engine.events.on('fault', () => {
      if (this.mode === 'exam') this.engine.audio.click(380, 0.035);
    });

    this.applySettings();

    this.engine.hooks.tick = (dt) => this.tick(dt);
    this.engine.hooks.inputEnabled = () => !this.menus.visible && this.mode !== 'menu' && this.mode !== 'replay';
    this.engine.hooks.onPauseRequest = () => {
      // Esc steps back one screen; on the main menu it does nothing
      if (this.menus.visible) {
        this.menus.back?.();
        return true;
      }
      if (this.mode !== 'menu') this.openPause();
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
    this.engine.camera.showcase = this.mode === 'menu';
    if (this.mode === 'free' || this.mode === 'lesson' || this.mode === 'exam') {
      this.coach.update(dt);
      this.recorder.tick(dt);
    }
    this.modeTick?.(dt);
  }

  /* ---------------- menus ---------------- */

  showMainMenu(): void {
    if (this.recorder.recording) void this.recorder.end(null, null);
    this.mode = 'menu';
    this.modeTick = null;
    this.onQuitDrive = null;
    this.onRestartDrive = null;
    this.engine.hints = null;
    this.engine.hud.setVisible(false);
    this.engine.hud.setObjective('');
    this.engine.setPaused(false);
    this.menus.showMain(
      {
        freeRoam: () => this.withQuickStart(() => this.goFreeRoam()),
        lessons: () => this.openLessons(),
        mockTest: () => this.openExam(),
        replays: () => this.openReplays(),
        dashboard: () => this.openDashboard(),
        settings: () => this.openSettings(() => this.showMainMenu()),
        help: () => this.menus.showQuickStart(() => this.showMainMenu(), 'Got it'),
      },
      this.menuStats(),
      () => this.openProfiles(),
    );
  }

  /** Show the how-to-drive card before the very first drive, then start. */
  withQuickStart(start: () => void): void {
    if (this.menus.quickStartDue) this.menus.showQuickStart(start);
    else start();
  }

  /** Hooked by later systems (examiner/replay/persistence). */
  openLessons: () => void = () => {
    const progress = loadProgress();
    const cards = LESSONS.map((l, i) => ({
      id: l.id,
      title: l.title.replace(/^\d+ · /, ''),
      desc: l.desc,
      num: String(i + 1),
      badge: progress.lessons[l.id]?.completed ? 'done' : undefined,
      done: !!progress.lessons[l.id]?.completed,
    }));
    cards.push({
      id: MOCK_TEST_CARD.id,
      title: MOCK_TEST_CARD.title.replace(/^\d+ · /, ''),
      desc: MOCK_TEST_CARD.desc,
      num: 'G',
      badge: progress.exams.some((e) => e.passed) ? 'passed' : undefined,
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
        if (lesson) this.withQuickStart(() => this.lessonRunner.start(lesson));
      },
      () => this.showMainMenu(),
    );
  };
  openExam: () => void = () => {
    const el = this.menus.showCustom(
      `
      <div class="spread"><h1>Mock G Road Test</h1><button class="btn ghost" id="back">${MENU_ICON.back}Back</button></div>
      <p class="lead">A full DriveTest-style examination. The examiner gives spoken directions and grades
      <b>silently</b> — no coaching, no hints. About 7 km of city streets, the roundabout, the school zone,
      a roadside stop, the hill, parallel parking, a three-point turn, and Highway 401.</p>
      <div class="checklist">
        <div><kbd>M</kbd><span>Mirror check every ~10 s and before braking</span></div>
        <div><kbd>,</kbd><kbd>.</kbd><span>Shoulder check before every lane change and merge</span></div>
        <div><kbd>Q</kbd><kbd>E</kbd><span>Signal about 3 s before turning</span></div>
        <div><kbd>S</kbd><span>Full stops behind the line, smooth braking</span></div>
      </div>
      <p class="dim">Keep a 2–3 s gap and match traffic speed when merging. A collision or dangerous action ends the test.</p>
      <div class="row end" style="margin-top:18px">
        <button class="btn primary big" id="begin" data-autofocus>${MENU_ICON.play}Begin the test</button>
      </div>
    `,
      true,
      () => this.showMainMenu(),
    );
    (el.querySelector('#begin') as HTMLElement).onclick = () => this.withQuickStart(() => this.examiner.start());
    (el.querySelector('#back') as HTMLElement).onclick = () => this.showMainMenu();
  };
  openReplays: () => void = () => {
    void (async () => {
      const metas = await listReplayMetas(this.profiles.active.id);
      if (!metas.length) {
        this.engine.hud.toast('No saved drives yet — every free roam, lesson and test is recorded.', 'info');
        return;
      }
      const rows = metas
        .map(
          (m) => `
        <div class="card replay-card" data-key="${m.key}" tabindex="0">
          <span class="card-num">${m.mode === 'exam' ? MENU_ICON.exam : m.mode === 'lesson' ? MENU_ICON.book : MENU_ICON.car}</span>
          <h3>${m.mode === 'exam' ? 'Mock test' : m.mode === 'lesson' ? 'Lesson' : 'Free roam'}
          ${m.score !== null ? `<span class="pill ${m.passed ? 'pass' : 'fail'}">${m.score}% ${m.passed ? 'pass' : 'fail'}</span>` : ''}</h3>
          <p>${new Date(m.at).toLocaleString()} · ${Math.max(1, Math.round(m.durationS / 60))} min · ${m.faultCount} fault${m.faultCount === 1 ? '' : 's'}</p>
          <button class="icon-btn" data-del="${m.key}" title="Delete this replay" aria-label="Delete this replay">✕</button>
        </div>`,
        )
        .join('');
      const el = this.menus.showCustom(
        `
        <div class="spread"><h1>Replays</h1><button class="btn ghost" id="back">${MENU_ICON.back}Back</button></div>
        <p class="dim">Scrub the timeline, jump to fault markers, orbit the camera. The last ${metas.length} drives are kept per profile.</p>
        <div class="card-grid">${rows}</div>
      `,
        true,
        () => this.showMainMenu(),
      );
      (el.querySelector('#back') as HTMLElement).onclick = () => this.showMainMenu();
      el.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => {
        b.onclick = (ev) => {
          ev.stopPropagation();
          void deleteReplay(b.dataset.del!).then(() => this.openReplays());
        };
      });
      el.querySelectorAll<HTMLElement>('[data-key]').forEach((card) => {
        card.onkeydown = (ev) => {
          if (ev.key === 'Enter') card.click();
        };
        card.onclick = () => {
          void getReplay(card.dataset.key!).then((rec) => {
            if (rec) this.replayPlayer.start(rec.data as ReplayPayload);
          });
        };
      });
    })();
  };

  openDashboard: () => void = () => {
    if (this.lastDrive) {
      renderDashboard(this, this.lastDrive);
      return;
    }
    void (async () => {
      const metas = await listReplayMetas(this.profiles.active.id);
      if (!metas.length) {
        this.engine.hud.toast('Drive first — telemetry is built from your recorded drives.', 'info');
        return;
      }
      const rec = await getReplay(metas[0].key);
      if (rec) renderDashboard(this, rec.data as ReplayPayload);
    })();
  };

  openProfiles: () => void = () => {
    const rows = this.profiles.all
      .map(
        (p) => `
      <div class="setting">
        <div class="s-label">${escapeHtml(p.name)}<span class="hint">since ${new Date(p.createdAt).toLocaleDateString()}</span></div>
        <span class="row">
          ${p.id !== this.profiles.active.id ? `<button class="btn" data-switch="${p.id}">Use</button>` : '<span class="pill pass">active</span>'}
          ${this.profiles.all.length > 1 ? `<button class="btn danger" data-del="${p.id}">Delete</button>` : ''}
        </span>
      </div>`,
      )
      .join('');
    const el = this.menus.showCustom(
      `
      <div class="spread"><h1>Profiles</h1><button class="btn ghost" id="back">${MENU_ICON.back}Back</button></div>
      <p class="dim">Each driver keeps their own lesson progress, test scores and replays.</p>
      ${rows}
      <h2>New profile</h2>
      <div class="row"><input type="text" id="pname" placeholder="Name" maxlength="24"><button class="btn primary" id="add">Create & switch</button></div>
      <h2>Danger zone</h2>
      <div class="row"><button class="btn danger" id="reset">Reset this profile's progress & replays</button></div>
    `,
      false,
      () => this.showMainMenu(),
    );
    (el.querySelector('#back') as HTMLElement).onclick = () => this.showMainMenu();
    el.querySelectorAll<HTMLElement>('[data-switch]').forEach((b) => {
      b.onclick = () => {
        this.profiles.switch(b.dataset.switch!);
        this.showMainMenu();
      };
    });
    el.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => {
      b.onclick = () => void this.profiles.remove(b.dataset.del!).then(() => this.openProfiles());
    });
    (el.querySelector('#add') as HTMLElement).onclick = () => {
      const name = (el.querySelector('#pname') as HTMLInputElement).value;
      this.profiles.create(name || 'Driver');
      this.lastDrive = null;
      this.showMainMenu();
    };
    (el.querySelector('#reset') as HTMLElement).onclick = () => {
      void this.profiles.resetActive().then(() => {
        this.lastDrive = null;
        this.engine.hud.toast('Profile progress and replays cleared.', 'info');
        this.showMainMenu();
      });
    };
  };

  showExamReport(r: ExamReport, save: boolean): void {
    if (save) {
      this.mode = 'menu';
      this.lastReport = r;
      void this.recorder.end(r.overall, r.passed);
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
              `<button type="button" class="card" data-lesson="${rec.lessonId}"><span class="card-num">${i + 1}</span><h3>${rec.title}</h3><p>${rec.reason}</p></button>`,
          )
          .join('')
      : '<p class="dim">Nothing specific — keep your habits sharp and retake any time.</p>';

    const el = this.menus.showCustom(`
      <div class="report-head ${r.passed ? 'pass' : 'fail'}">
        <div class="score-ring" style="--p:${r.overall}"><b>${r.overall}<small>%</small></b></div>
        <div>
          <span class="pill ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'Pass' : 'Fail'}</span>
          <h1>Mock G Road Test</h1>
          <p class="dim">${Math.max(1, Math.round(r.durationS / 60))} min · ${r.distanceKm.toFixed(1)} km · observation score ${r.observationScore}
          ${r.autoFail ? ` · <b class="bad">automatic fail: ${r.autoFail.message}</b>` : ''}
          ${!r.autoFail && r.dangerous.length ? ` · <b class="bad">dangerous action recorded</b>` : ''}</p>
        </div>
      </div>
      <h2>Assessment areas</h2>
      ${catRows}
      <h2>Fault log (${r.faults.length})</h2>
      <ul class="fault-list">${faultRows}</ul>
      <h2>Work on these next</h2>
      <div class="card-grid">${recs}</div>
      <div class="row" style="margin-top:20px">
        <button class="btn primary" id="retake" data-autofocus>Retake the test</button>
        <button class="btn" id="replayBtn">Watch replay</button>
        <button class="btn" id="dash">Telemetry</button>
        <button class="btn ghost" id="menu">Main menu</button>
      </div>
    `, true, () => this.showMainMenu());
    el.querySelectorAll<HTMLElement>('[data-lesson]').forEach((card) => {
      card.onclick = () => {
        const lesson = LESSONS.find((l) => l.id === card.dataset.lesson);
        if (lesson) this.lessonRunner.start(lesson);
      };
    });
    (el.querySelector('#retake') as HTMLElement).onclick = () => this.openExam();
    (el.querySelector('#replayBtn') as HTMLElement).onclick = () => {
      if (this.lastDrive) this.replayPlayer.start(this.lastDrive);
      else this.openReplays();
    };
    (el.querySelector('#dash') as HTMLElement).onclick = () => this.openDashboard();
    (el.querySelector('#menu') as HTMLElement).onclick = () => this.showMainMenu();
  }
  menuStats: () => { profile: string; bestExam: string; lessonsDone: number; lessonsTotal: number } = () => {
    const progress = loadProgress();
    const done = LESSONS.filter((l) => progress.lessons[l.id]?.completed).length;
    const best = progress.exams.length ? Math.max(...progress.exams.map((e) => e.score)) : null;
    return {
      profile: this.profiles.active.name,
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
    this.engine.hints = { coaching: true, since: this.engine.simTime };
    this.engine.hud.setVisible(true);
    this.engine.hud.clearToasts();
    this.engine.hud.setObjective('Free roam', 'Live coaching is on — drive like the examiner is watching', { fadeAfter: 8 });
    this.driveTitle = 'Free roam';
    this.onQuitDrive = null;
    this.onRestartDrive = () => this.goFreeRoam();
    this.recorder.begin('free');
    this.engine.setPaused(false);
  }

  openPause(): void {
    this.engine.setPaused(true);
    this.engine.hud.centerMsg('');
    const restart = this.onRestartDrive;
    this.menus.showPause(
      this.driveTitle,
      () => this.closePause(),
      restart
        ? () => {
            this.menus.hide();
            this.engine.setPaused(false);
            restart();
          }
        : null,
      () => this.openSettings(() => this.openPause()),
      () => this.engine.hud.showHelp(),
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
    e.steerAssist = s.steerAssist;
    e.showHints = s.showHints;
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

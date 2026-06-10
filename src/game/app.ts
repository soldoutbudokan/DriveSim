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
import { loadProgress } from './progress';

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
  openExam: () => void = () => this.engine.hud.toast('Examiner mode is being prepared.', 'info');
  openReplays: () => void = () => this.engine.hud.toast('No replays yet.', 'info');
  openDashboard: () => void = () => this.engine.hud.toast('Drive first — telemetry follows.', 'info');
  openProfiles: () => void = () => {};
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

/**
 * Menu screens: main menu, pause, settings/garage, lesson picker, report
 * card, telemetry dashboard and replay browser. Pure DOM on the UI layer;
 * GameApp supplies callbacks and data.
 */

import { CAR_COLORS, type Settings } from '../game/settings';

export interface MenuActions {
  freeRoam(): void;
  lessons(): void;
  mockTest(): void;
  replays(): void;
  dashboard(): void;
  settings(): void;
  help(): void;
}

export class Menus {
  private root: HTMLElement;
  private el: HTMLElement | null = null;

  constructor(parent: HTMLElement) {
    this.root = parent;
  }

  get visible(): boolean {
    return this.el !== null;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }

  private sheet(html: string, wide = false): HTMLElement {
    this.hide();
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `<div class="sheet panel clickable" ${wide ? 'style="width:min(1060px,94vw)"' : ''}>${html}</div>`;
    this.root.appendChild(overlay);
    this.el = overlay;
    return overlay;
  }

  /* ---------------- main menu ---------------- */

  showMain(actions: MenuActions, stats: { profile: string; bestExam: string; lessonsDone: number; lessonsTotal: number }, onProfile: () => void): void {
    const el = this.sheet(`
      <h1 class="menu-title">Drive<em>Sim</em></h1>
      <p class="menu-sub">Ontario Full G road test trainer — a practice aid, not a substitute for real supervised driving or the official MTO handbook.</p>
      <div class="card-grid">
        <div class="card" data-act="free"><h3>🚗 Free Roam</h3><p>Drive the whole district with live coaching: downtown, residential, the 401 loop, weather and traffic.</p></div>
        <div class="card" data-act="lessons"><h3>📚 Lessons</h3><p>Six-stage curriculum from vehicle basics to highway merging.</p><span class="badge">${stats.lessonsDone}/${stats.lessonsTotal}</span></div>
        <div class="card" data-act="exam"><h3>📋 Mock G Test</h3><p>A scored, routed road test with a DriveTest-style examiner and report card.</p>${stats.bestExam ? `<span class="badge">best ${stats.bestExam}</span>` : ''}</div>
        <div class="card" data-act="replays"><h3>🎬 Replays</h3><p>Review past drives with a scrubbable timeline and fault markers.</p></div>
        <div class="card" data-act="dashboard"><h3>📈 Telemetry</h3><p>Speed traces, braking events, scan habits and what to practise next.</p></div>
        <div class="card" data-act="settings"><h3>🔧 Garage & Settings</h3><p>Graphics, audio, controls, assists, weather, time of day, paint.</p></div>
      </div>
      <div class="spread" style="margin-top:20px">
        <button class="btn ghost" data-act="profile">👤 ${stats.profile}</button>
        <button class="btn ghost" data-act="help">? Controls & objectives</button>
      </div>
    `, true);
    el.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act!;
        if (act === 'free') actions.freeRoam();
        else if (act === 'lessons') actions.lessons();
        else if (act === 'exam') actions.mockTest();
        else if (act === 'replays') actions.replays();
        else if (act === 'dashboard') actions.dashboard();
        else if (act === 'settings') actions.settings();
        else if (act === 'help') actions.help();
        else if (act === 'profile') onProfile();
      };
    });
  }

  /* ---------------- pause ---------------- */

  showPause(onResume: () => void, onRestart: (() => void) | null, onSettings: () => void, onQuit: () => void): void {
    const el = this.sheet(`
      <h1>Paused</h1>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" data-a="resume">Resume (P)</button>
        ${onRestart ? '<button class="btn" data-a="restart">Restart</button>' : ''}
        <button class="btn" data-a="settings">Settings</button>
        <button class="btn danger" data-a="quit">End drive</button>
      </div>
    `);
    el.querySelector<HTMLElement>('[data-a=resume]')!.onclick = onResume;
    const r = el.querySelector<HTMLElement>('[data-a=restart]');
    if (r && onRestart) r.onclick = onRestart;
    el.querySelector<HTMLElement>('[data-a=settings]')!.onclick = onSettings;
    el.querySelector<HTMLElement>('[data-a=quit]')!.onclick = onQuit;
  }

  /* ---------------- settings / garage ---------------- */

  showSettings(s: Settings, onChange: (s: Settings) => void, onBack: () => void): void {
    const colorOpts = CAR_COLORS.map(
      (c) => `<option value="${c.value}" ${c.value === s.carColor ? 'selected' : ''}>${c.name}</option>`,
    ).join('');
    const el = this.sheet(`
      <h1>Garage & Settings</h1>
      <h2>Graphics</h2>
      <div class="setting"><label>Quality tier<span class="hint">auto targets 60 fps</span></label>
        <select id="tier">${['auto', 'low', 'medium', 'high', 'ultra'].map((t) => `<option ${t === s.tier ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="setting"><label>Reduced motion<span class="hint">no camera shake</span></label><input type="checkbox" id="reduced" ${s.reducedMotion ? 'checked' : ''}></div>
      <h2>World</h2>
      <div class="setting"><label>Weather</label>
        <select id="weather">${['clear', 'rain', 'fog', 'snow'].map((w) => `<option ${w === s.weather ? 'selected' : ''}>${w}</option>`).join('')}</select></div>
      <div class="setting"><label>Time of day</label>
        <select id="time">${['day', 'dusk', 'night', 'dawn', 'cycle'].map((t) => `<option ${t === s.time ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="setting"><label>Traffic density</label><input type="range" id="density" min="0.2" max="1.8" step="0.1" value="${s.trafficDensity}"></div>
      <div class="setting"><label>Emergency-vehicle events</label><input type="checkbox" id="emergency" ${s.emergencyEvents ? 'checked' : ''}></div>
      <h2>Car & controls</h2>
      <div class="setting"><label>Paint</label><select id="color">${colorOpts}</select></div>
      <div class="setting"><label>Steering sensitivity</label><input type="range" id="steer" min="0.5" max="1.5" step="0.05" value="${s.steerSensitivity}"></div>
      <div class="setting"><label>ABS</label><input type="checkbox" id="abs" ${s.assists.abs ? 'checked' : ''}></div>
      <div class="setting"><label>Traction control</label><input type="checkbox" id="tc" ${s.assists.tc ? 'checked' : ''}></div>
      <div class="setting"><label>Automatic headlights at night</label><input type="checkbox" id="autohead" ${s.autoHeadlights ? 'checked' : ''}></div>
      <h2>Audio</h2>
      ${(['master', 'engine', 'effects', 'ambient'] as const)
        .map(
          (k) =>
            `<div class="setting"><label style="text-transform:capitalize">${k}</label><input type="range" data-audio="${k}" min="0" max="1" step="0.05" value="${s.audio[k]}"></div>`,
        )
        .join('')}
      <h2>Accessibility</h2>
      <div class="setting"><label>UI scale</label><input type="range" id="uiscale" min="0.85" max="1.35" step="0.05" value="${s.uiScale}"></div>
      <div class="row" style="margin-top:18px"><button class="btn primary" id="back">Done</button></div>
    `);
    const get = <T extends HTMLElement>(id: string): T => el.querySelector(`#${id}`) as T;
    const push = (): void => onChange(s);
    get<HTMLSelectElement>('tier').onchange = (ev) => {
      s.tier = (ev.target as HTMLSelectElement).value as Settings['tier'];
      push();
    };
    get<HTMLInputElement>('reduced').onchange = (ev) => {
      s.reducedMotion = (ev.target as HTMLInputElement).checked;
      push();
    };
    get<HTMLSelectElement>('weather').onchange = (ev) => {
      s.weather = (ev.target as HTMLSelectElement).value as Settings['weather'];
      push();
    };
    get<HTMLSelectElement>('time').onchange = (ev) => {
      s.time = (ev.target as HTMLSelectElement).value as Settings['time'];
      push();
    };
    get<HTMLInputElement>('density').oninput = (ev) => {
      s.trafficDensity = Number((ev.target as HTMLInputElement).value);
      push();
    };
    get<HTMLInputElement>('emergency').onchange = (ev) => {
      s.emergencyEvents = (ev.target as HTMLInputElement).checked;
      push();
    };
    get<HTMLSelectElement>('color').onchange = (ev) => {
      s.carColor = Number((ev.target as HTMLSelectElement).value);
      push();
    };
    get<HTMLInputElement>('steer').oninput = (ev) => {
      s.steerSensitivity = Number((ev.target as HTMLInputElement).value);
      push();
    };
    get<HTMLInputElement>('abs').onchange = (ev) => {
      s.assists.abs = (ev.target as HTMLInputElement).checked;
      push();
    };
    get<HTMLInputElement>('tc').onchange = (ev) => {
      s.assists.tc = (ev.target as HTMLInputElement).checked;
      push();
    };
    get<HTMLInputElement>('autohead').onchange = (ev) => {
      s.autoHeadlights = (ev.target as HTMLInputElement).checked;
      push();
    };
    get<HTMLInputElement>('uiscale').oninput = (ev) => {
      s.uiScale = Number((ev.target as HTMLInputElement).value);
      push();
    };
    el.querySelectorAll<HTMLInputElement>('[data-audio]').forEach((inp) => {
      inp.oninput = () => {
        s.audio[inp.dataset.audio as keyof Settings['audio']] = Number(inp.value);
        push();
      };
    });
    get<HTMLButtonElement>('back').onclick = onBack;
  }

  /* ---------------- generic picker (lessons / replays) ---------------- */

  showCards(
    title: string,
    sub: string,
    cards: Array<{ id: string; title: string; desc: string; badge?: string; done?: boolean }>,
    onPick: (id: string) => void,
    onBack: () => void,
  ): void {
    const el = this.sheet(
      `
      <div class="spread"><h1>${title}</h1><button class="btn ghost" id="back">← Back</button></div>
      <p class="dim">${sub}</p>
      <div class="card-grid">
        ${cards
          .map(
            (c) => `
          <div class="card ${c.done ? 'done' : ''}" data-id="${c.id}">
            <h3>${c.title}</h3><p>${c.desc}</p>
            ${c.badge ? `<span class="badge ${c.done ? '' : 'locked'}">${c.badge}</span>` : ''}
          </div>`,
          )
          .join('')}
      </div>
    `,
      true,
    );
    el.querySelectorAll<HTMLElement>('[data-id]').forEach((card) => {
      card.onclick = () => onPick(card.dataset.id!);
    });
    (el.querySelector('#back') as HTMLElement).onclick = onBack;
  }

  /** Free-form sheet for report card / dashboard (caller builds inner HTML). */
  showCustom(html: string, wide = true): HTMLElement {
    return this.sheet(html, wide);
  }
}

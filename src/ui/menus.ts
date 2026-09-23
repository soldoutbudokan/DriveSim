/**
 * Menu screens: main menu, pause, settings/garage, lesson picker, quick
 * start, plus a generic sheet for the report card, telemetry dashboard and
 * replay browser. Pure DOM on the UI layer; GameApp supplies callbacks and
 * data. Every sheet can declare a `back` action, which Esc triggers.
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

export interface MenuStats {
  profile: string;
  bestExam: string;
  lessonsDone: number;
  lessonsTotal: number;
}

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const MENU_ICON = {
  car: svg('<path d="M5 16.5h14M3.5 16.5V13l2-4.6A2 2 0 0 1 7.3 7h9.4a2 2 0 0 1 1.8 1.4l2 4.6v3.5"/><path d="M3.5 13h17"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/>'),
  book: svg('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5"/><path d="M9 7.5h7M9 11h5"/>'),
  exam: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.8h6V4"/><path d="m8.5 12 2 2 4-4.2M8.5 17.2h7"/>'),
  film: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9.2 5 2.8-5 2.8z"/>'),
  chart: svg('<path d="M4 20V4M4 20h16"/><path d="m7.5 15 3.5-4 3 2.5 5-6.5"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  keys: svg('<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7 14h10"/>'),
  play: svg('<path d="m8 5 11 7-11 7z" fill="currentColor"/>'),
  pause: svg('<path d="M8 5v14M16 5v14" stroke-width="3.2"/>'),
  restart: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  exit: svg('<path d="M15 12H3M7 8l-4 4 4 4"/><path d="M11 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-8"/>'),
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
};

const QUICKSTART_KEY = 'drivesim.quickstart.v1';

export class Menus {
  private root: HTMLElement;
  private el: HTMLElement | null = null;
  /** What Esc does on the current sheet (null = nothing). */
  back: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = parent;
    // arrow keys move between the buttons of the open sheet
    window.addEventListener('keydown', (e) => {
      if (!this.el || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      const items = [...this.el.querySelectorAll<HTMLElement>('[data-nav]')];
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[i < 0 ? 0 : next].focus();
      e.preventDefault();
    });
  }

  get visible(): boolean {
    return this.el !== null;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
    this.back = null;
  }

  private sheet(html: string, opts: { wide?: boolean; kind?: string; back?: () => void } = {}): HTMLElement {
    this.hide();
    const overlay = document.createElement('div');
    overlay.className = `overlay ${opts.kind ?? ''}`;
    overlay.innerHTML = `<div class="sheet glass ${opts.wide ? 'wide' : ''}">${html}</div>`;
    this.root.appendChild(overlay);
    this.el = overlay;
    this.back = opts.back ?? null;
    overlay.querySelectorAll<HTMLElement>('.card, button').forEach((b) => b.setAttribute('data-nav', ''));
    // focus the first primary action so Enter works straight away
    const first = overlay.querySelector<HTMLElement>('[data-autofocus], .btn.primary, .mm-item');
    first?.focus({ preventScroll: true });
    return overlay;
  }

  /* ---------------- main menu ---------------- */

  showMain(actions: MenuActions, stats: MenuStats, onProfile: () => void): void {
    this.hide();
    const overlay = document.createElement('div');
    overlay.className = 'overlay main-menu';
    const lessonPct = Math.round((stats.lessonsDone / Math.max(1, stats.lessonsTotal)) * 100);
    overlay.innerHTML = `
      <div class="mm">
        <div class="mm-brand">
          <div class="logo">Drive<em>Sim</em></div>
          <div class="tag">Ontario Full G road test trainer</div>
        </div>
        <nav class="mm-nav">
          <button class="mm-item primary" data-act="free" data-nav>
            <span class="mi-ic">${MENU_ICON.car}</span>
            <span class="mi-tx"><b>Free Roam</b><small>Drive the district with live coaching</small></span>
          </button>
          <button class="mm-item" data-act="lessons" data-nav>
            <span class="mi-ic">${MENU_ICON.book}</span>
            <span class="mi-tx"><b>Lessons</b><small>Step-by-step, basics to highway</small></span>
            <span class="mi-meta"><span class="ring" style="--p:${lessonPct}"></span>${stats.lessonsDone}/${stats.lessonsTotal}</span>
          </button>
          <button class="mm-item" data-act="exam" data-nav>
            <span class="mi-ic">${MENU_ICON.exam}</span>
            <span class="mi-tx"><b>Mock G Test</b><small>Spoken directions, silent grading</small></span>
            ${stats.bestExam ? `<span class="mi-meta">best <b>${stats.bestExam}</b></span>` : ''}
          </button>
        </nav>
        <div class="mm-row">
          <button class="mm-small" data-act="replays" data-nav>${MENU_ICON.film}Replays</button>
          <button class="mm-small" data-act="dashboard" data-nav>${MENU_ICON.chart}Telemetry</button>
          <button class="mm-small" data-act="settings" data-nav>${MENU_ICON.gear}Settings</button>
        </div>
        <div class="mm-foot">
          <button class="chip" data-act="profile" data-nav>${MENU_ICON.user}<span>${escapeHtml(stats.profile)}</span></button>
          <button class="chip" data-act="help" data-nav>${MENU_ICON.keys}<span>How to drive</span></button>
        </div>
        <p class="mm-note">A practice aid — not a substitute for supervised driving or the official MTO Driver's Handbook.</p>
      </div>
    `;
    this.root.appendChild(overlay);
    this.el = overlay;
    this.back = null;
    overlay.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => {
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
    overlay.querySelector<HTMLElement>('.mm-item.primary')?.focus({ preventScroll: true });
  }

  /* ---------------- pause ---------------- */

  showPause(
    title: string,
    onResume: () => void,
    onRestart: (() => void) | null,
    onSettings: () => void,
    onControls: () => void,
    onQuit: () => void,
  ): void {
    const el = this.sheet(
      `
      <div class="pause-head"><h1>Paused</h1><span class="dim">${escapeHtml(title)}</span></div>
      <div class="pause-list">
        <button class="btn primary big" data-a="resume">${MENU_ICON.play}Resume <kbd>Esc</kbd></button>
        ${onRestart ? `<button class="btn big" data-a="restart">${MENU_ICON.restart}Restart</button>` : ''}
        <button class="btn big" data-a="controls">${MENU_ICON.keys}Controls <kbd>?</kbd></button>
        <button class="btn big" data-a="settings">${MENU_ICON.gear}Settings</button>
        <button class="btn big danger" data-a="quit">${MENU_ICON.exit}End drive</button>
      </div>
    `,
      { kind: 'pause', back: onResume },
    );
    el.querySelector<HTMLElement>('[data-a=resume]')!.onclick = onResume;
    const r = el.querySelector<HTMLElement>('[data-a=restart]');
    if (r && onRestart) r.onclick = onRestart;
    el.querySelector<HTMLElement>('[data-a=controls]')!.onclick = onControls;
    el.querySelector<HTMLElement>('[data-a=settings]')!.onclick = onSettings;
    el.querySelector<HTMLElement>('[data-a=quit]')!.onclick = onQuit;
  }

  /* ---------------- quick start ---------------- */

  /** True until the player has dismissed the quick-start card once. */
  get quickStartDue(): boolean {
    try {
      return localStorage.getItem(QUICKSTART_KEY) !== '1';
    } catch {
      return false;
    }
  }

  showQuickStart(onDone: () => void, doneLabel = "Let's drive"): void {
    const key = (k: string, label: string, cls = ''): string =>
      `<div class="qk ${cls}"><kbd>${k}</kbd><span>${label}</span></div>`;
    const el = this.sheet(
      `
      <h1>How to drive</h1>
      <p class="dim">An automatic, driven the way an Ontario examiner expects. Press <kbd>?</kbd> any time to pin the full controls list.</p>
      <div class="qs-grid">
        <section>
          <h2>Drive</h2>
          <div class="qs-keys wasd">
            ${key('W', 'Go', 'k-w')}
            ${key('A', 'Left', 'k-a')}${key('S', 'Brake', 'k-s')}${key('D', 'Right', 'k-d')}
          </div>
          <div class="qs-keys">
            ${key('X', 'Drive ↔ Reverse')}
            ${key('Space', 'Park (hold when stopped)', 'wide')}
          </div>
        </section>
        <section>
          <h2>Signal & look</h2>
          <div class="qs-keys">
            ${key('Q', 'Left signal')}${key('E', 'Right signal')}
            ${key(',', 'Left shoulder check')}${key('.', 'Right shoulder check')}
            ${key('M', 'Mirror check')}${key('C', 'Camera')}
          </div>
        </section>
      </div>
      <ul class="qs-tips">
        <li><b>Braking:</b> hold <kbd>S</kbd> for a smooth stop. Double-tap and hold <kbd>S</kbd> only in an emergency. Hold <kbd>Shift</kbd> for gentler throttle and brake.</li>
        <li><b>Steering:</b> small taps at speed. Let go of <kbd>A</kbd>/<kbd>D</kbd> and the steering assist lines you up with the lane (turn it off in Settings).</li>
        <li><b>The examiner's habits:</b> mirror every ~10 s, signal before turns and lane changes, and shoulder check before every lane change or merge. Hints appear above the dashboard when you forget.</li>
      </ul>
      <div class="row end"><button class="btn primary big" id="qsGo" data-autofocus>${MENU_ICON.play}${doneLabel}</button></div>
    `,
      { wide: true, kind: 'quickstart', back: () => done() },
    );
    const done = (): void => {
      try {
        localStorage.setItem(QUICKSTART_KEY, '1');
      } catch {
        /* storage unavailable */
      }
      this.hide();
      onDone();
    };
    (el.querySelector('#qsGo') as HTMLElement).onclick = done;
  }

  /* ---------------- settings / garage ---------------- */

  showSettings(s: Settings, onChange: (s: Settings) => void, onBack: () => void): void {
    const seg = (id: string, opts: string[], cur: string, labels?: string[]): string =>
      `<div class="seg" id="${id}" role="radiogroup">${opts
        .map((o, i) => `<button type="button" role="radio" data-v="${o}" class="${o === cur ? 'on' : ''}" aria-checked="${o === cur}">${labels?.[i] ?? o}</button>`)
        .join('')}</div>`;
    const sw = (id: string, on: boolean): string =>
      `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><i></i></label>`;
    const range = (id: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, attr = ''): string =>
      `<div class="range"><input type="range" id="${id}" ${attr} min="${min}" max="${max}" step="${step}" value="${val}"><output>${fmt(val)}</output></div>`;
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    const mult = (v: number): string => `${v.toFixed(2)}×`;
    const row = (label: string, control: string, hint = ''): string =>
      `<div class="setting"><div class="s-label">${label}${hint ? `<span class="hint">${hint}</span>` : ''}</div>${control}</div>`;

    const el = this.sheet(
      `
      <div class="spread"><h1>Garage & Settings</h1><button class="btn ghost" id="back">${MENU_ICON.back}Done</button></div>
      <div class="settings-grid">
        <section>
          <h2>Driving</h2>
          ${row('Steering assist', sw('assist', s.steerAssist), 'Lines the car up with the lane when you let go of the steering keys')}
          ${row('Control hints', sw('hints', s.showHints), 'Key prompts above the dashboard')}
          ${row('Steering sensitivity', range('steer', 0.5, 1.5, 0.05, s.steerSensitivity, mult))}
          ${row('ABS', sw('abs', s.assists.abs))}
          ${row('Traction control', sw('tc', s.assists.tc))}
          ${row('Automatic headlights at night', sw('autohead', s.autoHeadlights))}
          <h2>Car</h2>
          ${row('Paint', `<div class="swatches" id="color">${CAR_COLORS.map(
            (c) => `<button type="button" title="${c.name}" aria-label="${c.name}" data-v="${c.value}" class="${c.value === s.carColor ? 'on' : ''}" style="--c:#${c.value.toString(16).padStart(6, '0')}"></button>`,
          ).join('')}</div>`)}
          <h2>World</h2>
          ${row('Weather', seg('weather', ['clear', 'rain', 'fog', 'snow'], s.weather, ['Clear', 'Rain', 'Fog', 'Snow']))}
          ${row('Time of day', seg('time', ['dawn', 'day', 'dusk', 'night', 'cycle'], s.time, ['Dawn', 'Day', 'Dusk', 'Night', 'Cycle']))}
          ${row('Traffic density', range('density', 0.2, 1.8, 0.1, s.trafficDensity, mult))}
          ${row('Emergency-vehicle events', sw('emergency', s.emergencyEvents))}
        </section>
        <section>
          <h2>Graphics</h2>
          ${row('Quality', seg('tier', ['auto', 'low', 'medium', 'high', 'ultra'], s.tier, ['Auto', 'Low', 'Med', 'High', 'Ultra']), 'Auto starts at Medium and adapts to hold 60 fps')}
          ${row('Reduced motion', sw('reduced', s.reducedMotion), 'No camera shake')}
          <h2>Audio</h2>
          ${(['master', 'engine', 'effects', 'ambient'] as const)
            .map((k) => row(k[0].toUpperCase() + k.slice(1), range(`aud-${k}`, 0, 1, 0.05, s.audio[k], pct, `data-audio="${k}"`)))
            .join('')}
          <h2>Accessibility</h2>
          ${row('Interface scale', range('uiscale', 0.85, 1.35, 0.05, s.uiScale, pct))}
        </section>
      </div>
    `,
      { wide: true, back: onBack },
    );
    const get = <T extends HTMLElement>(id: string): T => el.querySelector(`#${id}`) as T;
    const push = (): void => onChange(s);
    const bindSeg = (id: string, set: (v: string) => void): void => {
      const box = get(id);
      box.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        b.onclick = () => {
          box.querySelectorAll('button').forEach((o) => {
            o.classList.toggle('on', o === b);
            o.setAttribute('aria-checked', String(o === b));
          });
          set(b.dataset.v!);
          push();
        };
      });
    };
    const bindSwitch = (id: string, set: (on: boolean) => void): void => {
      get<HTMLInputElement>(id).onchange = (ev) => {
        set((ev.target as HTMLInputElement).checked);
        push();
      };
    };
    const bindRange = (inp: HTMLInputElement, set: (v: number) => void, fmt: (v: number) => string): void => {
      const out = inp.nextElementSibling as HTMLElement;
      inp.oninput = () => {
        const v = Number(inp.value);
        out.textContent = fmt(v);
        set(v);
        push();
      };
    };
    bindSeg('tier', (v) => (s.tier = v as Settings['tier']));
    bindSeg('weather', (v) => (s.weather = v as Settings['weather']));
    bindSeg('time', (v) => (s.time = v as Settings['time']));
    bindSeg('color', (v) => (s.carColor = Number(v)));
    bindSwitch('assist', (on) => (s.steerAssist = on));
    bindSwitch('hints', (on) => (s.showHints = on));
    bindSwitch('abs', (on) => (s.assists.abs = on));
    bindSwitch('tc', (on) => (s.assists.tc = on));
    bindSwitch('autohead', (on) => (s.autoHeadlights = on));
    bindSwitch('emergency', (on) => (s.emergencyEvents = on));
    bindSwitch('reduced', (on) => (s.reducedMotion = on));
    bindRange(get('steer'), (v) => (s.steerSensitivity = v), mult);
    bindRange(get('density'), (v) => (s.trafficDensity = v), mult);
    bindRange(get('uiscale'), (v) => (s.uiScale = v), pct);
    el.querySelectorAll<HTMLInputElement>('[data-audio]').forEach((inp) => {
      bindRange(inp, (v) => (s.audio[inp.dataset.audio as keyof Settings['audio']] = v), pct);
    });
    get<HTMLButtonElement>('back').onclick = onBack;
  }

  /* ---------------- generic picker (lessons / replays) ---------------- */

  showCards(
    title: string,
    sub: string,
    cards: Array<{ id: string; title: string; desc: string; badge?: string; done?: boolean; num?: string }>,
    onPick: (id: string) => void,
    onBack: () => void,
  ): void {
    const el = this.sheet(
      `
      <div class="spread"><h1>${title}</h1><button class="btn ghost" id="back">${MENU_ICON.back}Back</button></div>
      <p class="dim">${sub}</p>
      <div class="card-grid">
        ${cards
          .map(
            (c) => `
          <button type="button" class="card ${c.done ? 'done' : ''}" data-id="${c.id}">
            ${c.num ? `<span class="card-num">${c.done ? MENU_ICON.check : c.num}</span>` : ''}
            <h3>${c.title}</h3><p>${c.desc}</p>
            ${c.badge ? `<span class="badge ${c.done ? '' : 'locked'}">${c.badge}</span>` : ''}
          </button>`,
          )
          .join('')}
      </div>
    `,
      { wide: true, back: onBack },
    );
    el.querySelectorAll<HTMLElement>('[data-id]').forEach((card) => {
      card.onclick = () => onPick(card.dataset.id!);
    });
    (el.querySelector('#back') as HTMLElement).onclick = onBack;
    el.querySelector<HTMLElement>('.card')?.focus({ preventScroll: true });
  }

  /** Free-form sheet for report card / dashboard (caller builds inner HTML). */
  showCustom(html: string, wide = true, back?: () => void): HTMLElement {
    return this.sheet(html, { wide, back });
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

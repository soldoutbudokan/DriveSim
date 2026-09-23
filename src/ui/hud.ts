/**
 * In-drive HUD: speed gauge, limit sign, gear selector, turn signals and
 * status lamps in a bottom-left dashboard; the mirror-scan meter;
 * contextual control hints; objective banner; coaching toasts; minimap
 * canvas; rear-view mirror frame; controls dock and centre messages.
 * Pure DOM — menus live in ui/menus.ts.
 */

import { HINT_KEYS, pickHints, type Hint, type HintContext } from './hints';

export interface HudState {
  speedKmh: number;
  limitKmh: number;
  rpmFrac: number;
  gear: string;
  signalLeft: boolean;
  signalRight: boolean;
  blinkPhase: boolean;
  headlights: boolean;
  hazards: boolean;
  handbrake: boolean;
  abs: boolean;
  wipers: boolean;
  /** Seconds since last mirror check (drives the scan meter). */
  scanAge: number;
  street: string;
  area: string;
  /** Show gamepad buttons in hints instead of keys. */
  gamepad?: boolean;
}

export type ToastKind = 'info' | 'warn' | 'good' | 'bad';

const HELP_ROWS: Array<[string, string]> = [
  ['W / ↑', 'Accelerate'],
  ['S / ↓', 'Brake — a smooth, firm stop'],
  ['S S', 'Emergency stop (tap, then hold)'],
  ['Shift', 'Gentle throttle and brake'],
  ['A D / ← →', 'Steer'],
  ['X', 'Drive ↔ Reverse (when stopped)'],
  ['Space', 'Handbrake · hold when stopped = Park'],
  ['Q / E', 'Left / right turn signal'],
  [', / .', 'Left / right shoulder check'],
  ['M', 'Mirror check'],
  ['C', 'Cycle camera'],
  ['V', 'Cockpit view'],
  ['L', 'Headlights'],
  ['U', 'Wipers'],
  ['H', 'Horn'],
  ['Tab', 'Hazard lights'],
  ['R', 'Respawn to safe spot'],
  ['P / Esc', 'Pause'],
  ['?', 'Show / hide this panel'],
];

const PAD_ROWS: Array<[string, string]> = [
  ['Left stick', 'Steer'],
  ['RT / LT', 'Accelerate / brake'],
  ['A / Cross', 'Drive ↔ Reverse'],
  ['LB / RB', 'Left / right signal'],
  ['D-pad ◀ ▶', 'Shoulder checks'],
  ['D-pad ▼', 'Handbrake (hold)'],
  ['X / Square', 'Mirror check'],
  ['Y / Triangle', 'Cycle camera'],
  ['B / Circle', 'Horn'],
  ['Start', 'Pause'],
];

const HELP_DOCK_KEY = 'drivesim-helpdock';

/* ---------------- gauge geometry ---------------- */

const GAUGE_MAX = 140;
const G_CX = 80;
const G_CY = 80;
const G_START = 135; // degrees, clockwise from +x (SVG y-down)
const G_SWEEP = 270;

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [G_CX + r * Math.cos(a), G_CY + r * Math.sin(a)];
}

function arcPath(r: number): string {
  const [x0, y0] = polar(r, G_START);
  const [x1, y1] = polar(r, G_START + G_SWEEP);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const R_SPEED = 70;
const R_RPM = 58;
const LEN_SPEED = (R_SPEED * G_SWEEP * Math.PI) / 180;
const LEN_RPM = (R_RPM * G_SWEEP * Math.PI) / 180;

function gaugeTicks(): string {
  let out = '';
  for (let v = 0; v <= GAUGE_MAX; v += 10) {
    const deg = G_START + (v / GAUGE_MAX) * G_SWEEP;
    const major = v % 20 === 0;
    const [x0, y0] = polar(major ? 76 : 77.5, deg);
    const [x1, y1] = polar(80, deg);
    out += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" class="${major ? 'tk major' : 'tk'}"/>`;
  }
  return out;
}

/* ---------------- icons ---------------- */

const ICON = {
  arrowL: '<svg viewBox="0 0 32 32"><path d="M3 16 14 5v7h15v8H14v7z"/></svg>',
  arrowR: '<svg viewBox="0 0 32 32"><path d="M29 16 18 5v7H3v8h15v7z"/></svg>',
  head: '<svg viewBox="0 0 24 24"><path d="M13 5c4.5 0 8 3.1 8 7s-3.5 7-8 7z" fill="currentColor"/><path d="M10 7H3M10 10.3H3M10 13.7H3M10 17H3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  haz: '<svg viewBox="0 0 24 24"><path d="M12 3 22 20H2z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M12 9.5 16.4 17H7.6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  park: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 6.5a10 10 0 0 0 0 11M20 6.5a10 10 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><text x="12" y="15.6" text-anchor="middle" font-size="10" font-weight="800" fill="currentColor">P</text></svg>',
  abs: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/><text x="12" y="14.6" text-anchor="middle" font-size="6.6" font-weight="800" fill="currentColor">ABS</text></svg>',
  wiper: '<svg viewBox="0 0 24 24"><path d="M3 17a12 12 0 0 1 18 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 19 7 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" fill="currentColor"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".18"/><path d="M12 10.5v6M12 7.2v.1" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".18"/><path d="M12 6.8v6.4M12 16.8v.1" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  good: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".18"/><path d="m7.5 12.3 3 3 6-6.3" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bad: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".18"/><path d="m8.5 8.5 7 7m0-7-7 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export class Hud {
  readonly root: HTMLElement;
  readonly minimapCanvas: HTMLCanvasElement;
  readonly mirrorFrame: HTMLElement;

  private dash: HTMLElement;
  private speedEl: HTMLElement;
  private limitEl: HTMLElement;
  private limitWrap: HTMLElement;
  private speedArc: SVGPathElement;
  private rpmArc: SVGPathElement;
  private limitTick: SVGGElement;
  private gearEls: Record<string, HTMLElement> = {};
  private gearNum: HTMLElement;
  private sigL: HTMLElement;
  private sigR: HTMLElement;
  private icons: Record<string, HTMLElement> = {};
  private scanEl: HTMLElement;
  private scanBar: HTMLElement;
  private hintsEl: HTMLElement;
  private hintKey = '';
  private objectiveEl: HTMLElement;
  private objStep: HTMLElement;
  private objMain: HTMLElement;
  private objSub: HTMLElement;
  private objFadeTimer = 0;
  private toastsEl: HTMLElement;
  private centerEl: HTMLElement;
  private centerTimer = 0;
  private helpEl: HTMLElement;
  private uiParent: HTMLElement;
  private locStreet: HTMLElement;
  private locArea: HTMLElement;
  private lastToast = '';
  private lastToastAt = 0;
  private lastLimit = -1;
  private gamepad = false;

  constructor(parent: HTMLElement) {
    this.uiParent = parent;
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div id="locChip" class="glass">${ICON.pin}<b id="locStreet">—</b><span id="locArea"></span></div>
      <div id="objective" class="glass hidden">
        <span class="obj-icon">${ICON.flag}</span>
        <span class="obj-step"></span>
        <div class="obj-text"><div class="main"></div><div class="sub"></div></div>
      </div>
      <div id="bottomLeft">
      <div id="hints"></div>
      <div id="dash" class="glass">
        <div class="sig sig-l" id="sigL">${ICON.arrowL}</div>
        <div class="limit-sign" id="limitSign"><span>MAXIMUM</span><b id="limitVal">50</b></div>
        <div class="gauge">
          <svg viewBox="0 0 160 142" aria-hidden="true">
            <g class="ticks">${gaugeTicks()}</g>
            <path class="track" d="${arcPath(R_SPEED)}"/>
            <path class="fill" id="speedArc" d="${arcPath(R_SPEED)}" stroke-dasharray="${LEN_SPEED.toFixed(1)}" stroke-dashoffset="${LEN_SPEED.toFixed(1)}"/>
            <path class="rpm-track" d="${arcPath(R_RPM)}"/>
            <path class="rpm" id="rpmArc" d="${arcPath(R_RPM)}" stroke-dasharray="${LEN_RPM.toFixed(1)}" stroke-dashoffset="${LEN_RPM.toFixed(1)}"/>
            <g id="limitTick"><line x1="${G_CX + 62}" y1="${G_CY}" x2="${G_CX + 80}" y2="${G_CY}"/></g>
          </svg>
          <div class="readout"><b id="speedVal">0</b><span>km/h</span></div>
        </div>
        <div class="prnd" aria-label="Gear">
          <i data-g="P">P</i><i data-g="R">R</i><i data-g="N">N</i><i data-g="D">D<sub id="gearNum"></sub></i>
        </div>
        <div class="sig sig-r" id="sigR">${ICON.arrowR}</div>
        <div class="dash-foot">
          <div class="icons">
            <span class="ic head" title="Headlights (L)">${ICON.head}</span>
            <span class="ic haz" title="Hazards (Tab)">${ICON.haz}</span>
            <span class="ic hand" title="Handbrake / Park (Space)">${ICON.park}</span>
            <span class="ic abs" title="ABS active">${ICON.abs}</span>
            <span class="ic wiper" title="Wipers (U)">${ICON.wiper}</span>
          </div>
          <div class="scan" id="scanMeter" title="Time since your last mirror check — press M every ~10 s">
            <span>Mirror</span><div class="bar"><i></i></div><kbd>M</kbd>
          </div>
        </div>
      </div>
      </div>
      <div id="minimapWrap"><canvas id="minimap"></canvas></div>
      <div id="mirrorFrame"><span class="tag">REAR VIEW</span></div>
    `;
    parent.appendChild(this.root);

    const q = <T extends Element = HTMLElement>(sel: string): T => this.root.querySelector(sel) as T;
    this.dash = q('#dash');
    this.speedEl = q('#speedVal');
    this.limitEl = q('#limitVal');
    this.limitWrap = q('#limitSign');
    this.speedArc = q<SVGPathElement>('#speedArc');
    this.rpmArc = q<SVGPathElement>('#rpmArc');
    this.limitTick = q<SVGGElement>('#limitTick');
    this.root.querySelectorAll<HTMLElement>('.prnd i').forEach((el) => (this.gearEls[el.dataset.g!] = el));
    this.gearNum = q('#gearNum');
    this.sigL = q('#sigL');
    this.sigR = q('#sigR');
    this.scanEl = q('#scanMeter');
    this.scanBar = q('#scanMeter .bar i');
    this.hintsEl = q('#hints');
    this.objectiveEl = q('#objective');
    this.objStep = q('#objective .obj-step');
    this.objMain = q('#objective .main');
    this.objSub = q('#objective .sub');
    this.locStreet = q('#locStreet');
    this.locArea = q('#locArea');
    this.minimapCanvas = q<HTMLCanvasElement>('#minimap');
    this.mirrorFrame = q('#mirrorFrame');
    const names = ['head', 'haz', 'hand', 'abs', 'wiper'];
    this.root.querySelectorAll<HTMLElement>('.icons .ic').forEach((el, i) => (this.icons[names[i]] = el));

    // Toasts and centre messages live outside the HUD so menus can use them.
    this.toastsEl = document.createElement('div');
    this.toastsEl.id = 'toasts';
    parent.appendChild(this.toastsEl);
    this.centerEl = document.createElement('div');
    this.centerEl.id = 'centerMsg';
    parent.appendChild(this.centerEl);

    // Controls dock: pinned to the right edge so it can stay up while driving.
    this.helpEl = document.createElement('div');
    this.helpEl.id = 'helpDock';
    this.helpEl.className = 'glass';
    this.helpEl.innerHTML = `
      <div class="hd-head">
        <b>Controls</b>
        <span class="hd-hint">toggle with <kbd>?</kbd></span>
        <button class="hd-x" id="helpClose" title="Close (?)" aria-label="Close">✕</button>
      </div>
      <div class="hd-body">
        <div class="hd-sec">Keyboard</div>
        <div class="hd-keys">${HELP_ROWS.map(([k, v]) => `<div><span class="caps">${keycaps(k)}</span><span>${v}</span></div>`).join('')}</div>
        <div class="hd-sec">Gamepad</div>
        <div class="hd-keys">${PAD_ROWS.map(([k, v]) => `<div><span class="caps"><kbd>${k}</kbd></span><span>${v}</span></div>`).join('')}</div>
        <div class="hd-sec">The examiner watches</div>
        <p class="hd-note">Signal ~3 s before turns and lane changes · shoulder check before every lane change and merge ·
        mirror check every ~10 s and before braking · full stops behind the line · 2–3 s following gap ·
        smooth inputs · yield correctly (pedestrians, streetcars with open doors, school buses, emergency vehicles) ·
        keep to the posted limit without crawling.</p>
      </div>`;
    parent.appendChild(this.helpEl);
    (this.helpEl.querySelector('#helpClose') as HTMLElement).onclick = () => this.showHelp(false);
    try {
      if (localStorage.getItem(HELP_DOCK_KEY) === '1') this.showHelp(true);
    } catch {
      /* storage unavailable */
    }
  }

  setVisible(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
    if (!on) {
      this.setHints(null);
      this.mirrorFrame.classList.remove('show');
    }
  }

  update(s: HudState): void {
    this.gamepad = !!s.gamepad;
    const speed = Math.round(s.speedKmh);
    this.speedEl.textContent = String(speed);
    const over = s.speedKmh - s.limitKmh;
    this.dash.classList.toggle('over', over > 3 && over <= 10);
    this.dash.classList.toggle('way-over', over > 10);
    if (s.limitKmh !== this.lastLimit) {
      this.lastLimit = s.limitKmh;
      this.limitEl.textContent = String(s.limitKmh);
      this.limitTick.setAttribute('transform', `rotate(${(G_START + (Math.min(s.limitKmh, GAUGE_MAX) / GAUGE_MAX) * G_SWEEP).toFixed(1)} ${G_CX} ${G_CY})`);
      this.limitWrap.classList.remove('changed');
      void this.limitWrap.offsetWidth; // restart the pulse
      this.limitWrap.classList.add('changed');
    }
    this.speedArc.style.strokeDashoffset = (LEN_SPEED * (1 - Math.min(s.speedKmh, GAUGE_MAX) / GAUGE_MAX)).toFixed(1);
    this.rpmArc.style.strokeDashoffset = (LEN_RPM * (1 - Math.min(1, Math.max(0, s.rpmFrac)))).toFixed(1);

    const mode = s.gear[0];
    for (const g in this.gearEls) this.gearEls[g].classList.toggle('on', g === mode);
    this.gearNum.textContent = mode === 'D' ? s.gear.slice(1) : '';

    this.sigL.classList.toggle('on', (s.signalLeft || s.hazards) && s.blinkPhase);
    this.sigR.classList.toggle('on', (s.signalRight || s.hazards) && s.blinkPhase);
    this.sigL.classList.toggle('armed', s.signalLeft || s.hazards);
    this.sigR.classList.toggle('armed', s.signalRight || s.hazards);
    this.icons.head.classList.toggle('on', s.headlights);
    this.icons.haz.classList.toggle('on', s.hazards);
    this.icons.hand.classList.toggle('on', s.handbrake);
    this.icons.abs.classList.toggle('on', s.abs);
    this.icons.wiper.classList.toggle('on', s.wipers);
    const scanFrac = Math.max(0, 1 - s.scanAge / 12);
    this.scanBar.style.width = `${Math.round(scanFrac * 100)}%`;
    this.scanEl.classList.toggle('stale', s.scanAge > 10);
    this.locStreet.textContent = s.street;
    this.locArea.textContent = s.area;
  }

  /** Update the contextual key hints (null clears them). */
  setHints(ctx: HintContext | null): void {
    const hints = ctx ? pickHints(ctx) : [];
    const key = JSON.stringify(hints) + this.gamepad;
    if (key === this.hintKey) return;
    this.hintKey = key;
    this.hintsEl.innerHTML = hints.map((h) => this.hintHtml(h)).join('');
  }

  private hintHtml(h: Hint): string {
    const caps = h.keys
      .map((k) => (this.gamepad ? HINT_KEYS[k].pad : HINT_KEYS[k].kb).map((c) => `<kbd>${esc(c)}</kbd>`).join(''))
      .join('<i>/</i>');
    return `<span class="khint ${h.tone ?? 'info'}">${caps}<span>${esc(h.text)}</span></span>`;
  }

  /**
   * Objective banner. A leading "3/7 · " step counter is shown as a pill.
   * `fadeAfter` (s) tucks the banner away once the player has read it.
   */
  setObjective(text: string, sub = '', opts: { fadeAfter?: number } = {}): void {
    clearTimeout(this.objFadeTimer);
    if (!text) {
      this.objectiveEl.classList.add('hidden');
      return;
    }
    const m = /^(\d+\/\d+) · (.*)$/.exec(text);
    const main = m ? m[2] : text;
    const step = m ? m[1] : '';
    const changed = this.objMain.textContent !== main;
    this.objectiveEl.classList.remove('hidden', 'faded');
    if (changed) {
      this.objectiveEl.classList.remove('pop');
      void this.objectiveEl.offsetWidth;
      this.objectiveEl.classList.add('pop');
    }
    this.objMain.textContent = main;
    this.objStep.textContent = step;
    this.objStep.style.display = step ? '' : 'none';
    this.objSub.textContent = sub;
    this.objSub.style.display = sub ? '' : 'none';
    if (opts.fadeAfter) {
      this.objFadeTimer = window.setTimeout(() => this.objectiveEl.classList.add('faded'), opts.fadeAfter * 1000);
    }
  }

  toast(text: string, kind: ToastKind = 'info'): void {
    const now = performance.now();
    if (text === this.lastToast && now - this.lastToastAt < 4000) return;
    this.lastToast = text;
    this.lastToastAt = now;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<span class="t-ic">${ICON[kind]}</span><span class="t-tx"></span>`;
    (el.querySelector('.t-tx') as HTMLElement).textContent = text;
    this.toastsEl.appendChild(el);
    while (this.toastsEl.children.length > 4) this.toastsEl.firstChild?.remove();
    setTimeout(() => {
      el.classList.add('fading');
      setTimeout(() => el.remove(), 500);
    }, kind === 'bad' ? 5500 : 4200);
  }

  clearToasts(): void {
    this.toastsEl.innerHTML = '';
  }

  centerMsg(text: string, sub = '', sticky = false): void {
    clearTimeout(this.centerTimer);
    if (!text) {
      this.centerEl.classList.remove('show');
      return;
    }
    this.centerEl.innerHTML = `<div class="cm-main"></div>${sub ? '<div class="cm-sub"></div>' : ''}`;
    (this.centerEl.querySelector('.cm-main') as HTMLElement).textContent = text;
    if (sub) (this.centerEl.querySelector('.cm-sub') as HTMLElement).textContent = sub;
    this.centerEl.classList.remove('show');
    void this.centerEl.offsetWidth;
    this.centerEl.classList.add('show');
    if (!sticky) this.centerTimer = window.setTimeout(() => this.centerEl.classList.remove('show'), 2600);
  }

  showHelp(on?: boolean): boolean {
    const next = on ?? !this.helpVisible;
    this.helpEl.classList.toggle('open', next);
    // shift toasts/minimap out from under the dock
    this.uiParent.classList.toggle('help-open', next);
    try {
      localStorage.setItem(HELP_DOCK_KEY, next ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    return next;
  }

  get helpVisible(): boolean {
    return this.helpEl.classList.contains('open');
  }

  /** Place the rear-view mirror frame over the renderer's scissor viewport. */
  layoutMirror(x: number, y: number, w: number, h: number, show: boolean): void {
    const f = this.mirrorFrame;
    if (f.classList.contains('show') !== show) {
      f.classList.toggle('show', show);
      this.uiParent.classList.toggle('mirror-open', show);
    }
    if (show) {
      // the bezel overlaps the render by its border width to hide the corners
      const b = 7;
      f.style.left = `${x - b}px`;
      f.style.top = `${y - b}px`;
      f.style.width = `${w + b * 2}px`;
      f.style.height = `${h + b * 2}px`;
    }
  }
}

/** "A D / ← →" → <kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd>. */
function keycaps(k: string): string {
  return k
    .split(' / ')
    .map((group) => group.split(' ').map((c) => `<kbd>${esc(c)}</kbd>`).join(''))
    .join('<i>/</i>');
}

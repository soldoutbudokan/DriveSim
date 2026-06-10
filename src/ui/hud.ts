/**
 * In-drive HUD: speed/limit/tach/gear cluster, signal indicators, observation
 * scan meter, objective banner, coaching toasts, minimap canvas, mirror frame,
 * help overlay and centre messages. Pure DOM — menus live in ui/menus.ts.
 */

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
}

const HELP_ROWS: Array<[string, string]> = [
  ['W / ↑', 'Accelerate (in selected gear)'],
  ['S / ↓', 'Brake'],
  ['X', 'Shift Drive ↔ Reverse (when stopped)'],
  ['A D / ← →', 'Steer'],
  ['Shift', 'Gentle / precise throttle'],
  ['Space', 'Handbrake (hold at stop = Park)'],
  ['Q / E', 'Left / right turn signal'],
  [', / .', 'LEFT / RIGHT shoulder check'],
  ['M', 'Mirror check'],
  ['C', 'Cycle camera'],
  ['V', 'Cockpit view'],
  ['L', 'Headlights'],
  ['U', 'Wipers'],
  ['H', 'Horn'],
  ['Tab', 'Hazard lights'],
  ['R', 'Respawn to safe spot'],
  ['P / Esc', 'Pause'],
  ['?', 'This help'],
];

const HELP_DOCK_KEY = 'drivesim-helpdock';

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

export class Hud {
  readonly root: HTMLElement;
  readonly minimapCanvas: HTMLCanvasElement;
  readonly mirrorFrame: HTMLElement;

  private speedEl: HTMLElement;
  private speedWrap: HTMLElement;
  private limitEl: HTMLElement;
  private tachEl: HTMLElement;
  private gearEl: HTMLElement;
  private sigL: HTMLElement;
  private sigR: HTMLElement;
  private icons: Record<string, HTMLElement> = {};
  private scanEl: HTMLElement;
  private scanBar: HTMLElement;
  private objectiveEl: HTMLElement;
  private objMain: HTMLElement;
  private objSub: HTMLElement;
  private toastsEl: HTMLElement;
  private centerEl: HTMLElement;
  private helpEl: HTMLElement;
  private uiParent: HTMLElement;
  private locChip: HTMLElement;
  private lastToast = '';
  private lastToastAt = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div id="locChip" class="panel"><b id="locStreet">—</b> <span id="locArea"></span></div>
      <div id="objective" class="panel hidden"><div class="main"></div><div class="sub"></div></div>
      <div id="toasts"></div>
      <div id="cluster" class="panel">
        <div class="speed"><b id="speedVal">0</b><span>km/h</span></div>
        <div class="limit-sign"><span>MAXIMUM</span><b id="limitVal">50</b></div>
        <div class="col">
          <div class="tach"><i id="tachBar"></i></div>
          <div class="gearline">
            <span class="gear" id="gearVal">P</span>
            <span class="icons">
              <span class="ic head" title="Headlights">⛯</span>
              <span class="ic haz" title="Hazards">▲</span>
              <span class="ic hand" title="Handbrake">(P)</span>
              <span class="ic abs" title="ABS">ABS</span>
              <span class="ic wiper" title="Wipers">≋</span>
            </span>
          </div>
          <div class="sigline"><span class="sig" id="sigL">◀</span><span class="sig" id="sigR">▶</span></div>
          <div class="scan" id="scanMeter" title="Time since your last mirror check"><span>scan</span><div class="bar"><i></i></div></div>
        </div>
      </div>
      <div id="minimapWrap" class="panel"><canvas id="minimap" width="230" height="230"></canvas></div>
      <div id="mirrorFrame"><span class="tag">REAR VIEW</span></div>
      <div id="centerMsg"></div>
    `;
    parent.appendChild(this.root);

    const q = (sel: string): HTMLElement => this.root.querySelector(sel) as HTMLElement;
    this.speedEl = q('#speedVal');
    this.speedWrap = q('.speed');
    this.limitEl = q('#limitVal');
    this.tachEl = q('#tachBar');
    this.gearEl = q('#gearVal');
    this.sigL = q('#sigL');
    this.sigR = q('#sigR');
    this.scanEl = q('#scanMeter');
    this.scanBar = q('#scanMeter .bar i');
    this.objectiveEl = q('#objective');
    this.objMain = q('#objective .main');
    this.objSub = q('#objective .sub');
    this.toastsEl = q('#toasts');
    this.centerEl = q('#centerMsg');
    this.locChip = q('#locChip');
    this.minimapCanvas = q('#minimap') as HTMLCanvasElement;
    this.mirrorFrame = q('#mirrorFrame');
    const iconEls = this.root.querySelectorAll('.icons .ic');
    const names = ['head', 'haz', 'hand', 'abs', 'wiper'];
    iconEls.forEach((el, i) => (this.icons[names[i]] = el as HTMLElement));

    // Controls dock: pinned to the right edge so it can stay up while driving.
    this.uiParent = parent;
    this.helpEl = document.createElement('div');
    this.helpEl.id = 'helpDock';
    this.helpEl.className = 'panel';
    this.helpEl.innerHTML = `
      <div class="hd-head">
        <b>Controls</b>
        <span class="hd-hint">toggles with <kbd>?</kbd></span>
        <button class="hd-x" id="helpClose" title="Close (?)">✕</button>
      </div>
      <div class="hd-body">
        <div class="hd-sec">Keyboard</div>
        <div class="hd-keys">${HELP_ROWS.map(([k, v]) => `<div><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div>
        <div class="hd-sec">Gamepad</div>
        <div class="hd-keys">${PAD_ROWS.map(([k, v]) => `<div><kbd>${k}</kbd><span>${v}</span></div>`).join('')}</div>
        <div class="hd-sec">The examiner watches</div>
        <p class="hd-note">Signal ~3 s before turns and lane changes · shoulder check before EVERY lane change and merge ·
        mirror check every ~10 s and before braking · full stops behind the line · 2–3 s following gap ·
        smooth inputs · yield correctly (pedestrians, streetcars with open doors, school buses, emergency vehicles) ·
        keep to the posted limit without crawling.</p>
      </div>`;
    parent.appendChild(this.helpEl);
    (this.helpEl.querySelector('#helpClose') as HTMLElement).onclick = () => this.showHelp(false);
    if (localStorage.getItem(HELP_DOCK_KEY) === '1') this.showHelp(true);
  }

  setVisible(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }

  update(s: HudState): void {
    this.speedEl.textContent = String(Math.round(s.speedKmh));
    this.speedWrap.classList.toggle('over', s.speedKmh > s.limitKmh + 3);
    this.limitEl.textContent = String(s.limitKmh);
    this.tachEl.style.width = `${Math.round(s.rpmFrac * 100)}%`;
    this.gearEl.textContent = s.gear;
    this.sigL.classList.toggle('on', (s.signalLeft || s.hazards) && s.blinkPhase);
    this.sigR.classList.toggle('on', (s.signalRight || s.hazards) && s.blinkPhase);
    this.icons.head.classList.toggle('on', s.headlights);
    this.icons.haz.classList.toggle('on', s.hazards);
    this.icons.hand.classList.toggle('on', s.handbrake);
    this.icons.abs.classList.toggle('on', s.abs);
    this.icons.wiper.classList.toggle('on', s.wipers);
    const scanFrac = Math.max(0, 1 - s.scanAge / 12);
    this.scanBar.style.width = `${Math.round(scanFrac * 100)}%`;
    this.scanEl.classList.toggle('stale', s.scanAge > 10);
    (this.locChip.querySelector('#locStreet') as HTMLElement).textContent = s.street;
    (this.locChip.querySelector('#locArea') as HTMLElement).textContent = s.area ? `· ${s.area}` : '';
  }

  setObjective(text: string, sub = ''): void {
    if (!text) {
      this.objectiveEl.classList.add('hidden');
      return;
    }
    this.objectiveEl.classList.remove('hidden');
    this.objMain.textContent = text;
    this.objSub.textContent = sub;
    this.objSub.style.display = sub ? '' : 'none';
  }

  toast(text: string, kind: 'info' | 'warn' | 'good' = 'info'): void {
    const now = performance.now();
    if (text === this.lastToast && now - this.lastToastAt < 4000) return;
    this.lastToast = text;
    this.lastToastAt = now;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    this.toastsEl.appendChild(el);
    while (this.toastsEl.children.length > 4) this.toastsEl.firstChild?.remove();
    setTimeout(() => {
      el.classList.add('fading');
      setTimeout(() => el.remove(), 600);
    }, 4200);
  }

  clearToasts(): void {
    this.toastsEl.innerHTML = '';
  }

  centerMsg(text: string, sub = '', sticky = false): void {
    if (!text) {
      this.centerEl.classList.remove('show');
      return;
    }
    this.centerEl.innerHTML = `${text}${sub ? `<span class="sub">${sub}</span>` : ''}`;
    this.centerEl.classList.add('show');
    if (!sticky) setTimeout(() => this.centerEl.classList.remove('show'), 2100);
  }

  showHelp(on?: boolean): boolean {
    const next = on ?? !this.helpVisible;
    this.helpEl.classList.toggle('open', next);
    // shift toasts/minimap out from under the dock
    this.uiParent.classList.toggle('help-open', next);
    localStorage.setItem(HELP_DOCK_KEY, next ? '1' : '0');
    return next;
  }

  get helpVisible(): boolean {
    return this.helpEl.classList.contains('open');
  }

  /** Place the rear-view mirror frame over the renderer's scissor viewport. */
  layoutMirror(x: number, y: number, w: number, h: number, show: boolean): void {
    const f = this.mirrorFrame;
    f.classList.toggle('show', show);
    if (show) {
      f.style.left = `${x}px`;
      f.style.top = `${y}px`;
      f.style.transform = 'none';
      f.style.width = `${w}px`;
      f.style.height = `${h}px`;
    }
  }
}

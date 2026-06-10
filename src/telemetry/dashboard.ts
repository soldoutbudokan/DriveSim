/**
 * Post-drive analytics dashboard rendered from a recorded drive: speed trace
 * vs posted limit, hard-braking/steering events, following-distance
 * distribution, observation habits (mirror cadence, blind-spot compliance),
 * an error heatmap over the district, and adaptive practice recommendations.
 */

import type { GameApp } from '../game/app';
import { SERIES_STRIDE, type ReplayPayload } from '../replay/format';
import { computeReport } from '../scoring/rubric';
import { LESSONS } from '../scenarios/lessons';

interface SeriesView {
  n: number;
  t(i: number): number;
  speed(i: number): number;
  limit(i: number): number;
  gLong(i: number): number;
  gLat(i: number): number;
  gap(i: number): number;
  x(i: number): number;
  z(i: number): number;
}

function view(p: ReplayPayload): SeriesView {
  const s = p.series;
  const n = Math.floor(s.length / SERIES_STRIDE);
  const g = (i: number, o: number): number => s[i * SERIES_STRIDE + o];
  return {
    n,
    t: (i) => g(i, 0),
    speed: (i) => g(i, 1),
    limit: (i) => g(i, 2),
    gLong: (i) => g(i, 3),
    gLat: (i) => g(i, 4),
    gap: (i) => g(i, 5),
    x: (i) => g(i, 6),
    z: (i) => g(i, 7),
  };
}

function lineChart(canvas: HTMLCanvasElement, sv: SeriesView, faults: ReplayPayload['faults']): void {
  const g = canvas.getContext('2d')!;
  const W = (canvas.width = canvas.clientWidth * 2);
  const H = (canvas.height = 320);
  g.clearRect(0, 0, W, H);
  if (sv.n < 2) return;
  const tMax = sv.t(sv.n - 1);
  let vMax = 60;
  for (let i = 0; i < sv.n; i++) vMax = Math.max(vMax, sv.speed(i), sv.limit(i));
  vMax += 10;
  const X = (t: number): number => (t / tMax) * (W - 70) + 50;
  const Y = (v: number): number => H - 30 - (v / vMax) * (H - 50);

  // grid + axis labels
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.font = '20px system-ui';
  g.lineWidth = 1;
  for (let v = 0; v <= vMax; v += 20) {
    g.beginPath();
    g.moveTo(50, Y(v));
    g.lineTo(W - 16, Y(v));
    g.stroke();
    g.fillText(String(v), 8, Y(v) + 6);
  }
  // limit trace (step)
  g.strokeStyle = 'rgba(255,181,71,0.9)';
  g.lineWidth = 2.5;
  g.beginPath();
  for (let i = 0; i < sv.n; i++) {
    const x = X(sv.t(i));
    const y = Y(sv.limit(i));
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke();
  // speed trace
  g.strokeStyle = '#4da3ff';
  g.lineWidth = 3;
  g.beginPath();
  for (let i = 0; i < sv.n; i++) {
    const x = X(sv.t(i));
    const y = Y(sv.speed(i));
    i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.stroke();
  // fault markers
  for (const f of faults) {
    g.fillStyle = f.severity === 'minor' ? 'rgba(255,181,71,0.95)' : 'rgba(255,93,93,0.95)';
    g.beginPath();
    g.arc(X(f.time), 22, 7, 0, Math.PI * 2);
    g.fill();
  }
}

function histogram(canvas: HTMLCanvasElement, sv: SeriesView): void {
  const g = canvas.getContext('2d')!;
  const W = (canvas.width = canvas.clientWidth * 2);
  const H = (canvas.height = 320);
  g.clearRect(0, 0, W, H);
  const bins = new Array(10).fill(0) as number[]; // 0..5s in 0.5 steps
  let total = 0;
  for (let i = 0; i < sv.n; i++) {
    const gap = sv.gap(i);
    if (gap < 0 || sv.speed(i) < 25) continue;
    bins[Math.min(9, Math.floor(gap * 2))]++;
    total++;
  }
  const max = Math.max(...bins, 1);
  const bw = (W - 80) / bins.length;
  g.font = '20px system-ui';
  for (let i = 0; i < bins.length; i++) {
    const h = (bins[i] / max) * (H - 80);
    const x = 50 + i * bw;
    const danger = i < 4; // < 2s
    g.fillStyle = danger ? 'rgba(255,93,93,0.8)' : 'rgba(70,214,140,0.8)';
    g.fillRect(x + 3, H - 40 - h, bw - 6, h);
    g.fillStyle = 'rgba(255,255,255,0.45)';
    if (i % 2 === 0) g.fillText(`${i / 2}s`, x, H - 14);
  }
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.fillText(total ? 'time-gap while following (green = 2s+)' : 'no car-following data this drive', 50, 26);
}

function heatmap(canvas: HTMLCanvasElement, app: GameApp, sv: SeriesView, faults: ReplayPayload['faults']): void {
  const g = canvas.getContext('2d')!;
  const W = (canvas.width = canvas.clientWidth * 2);
  const H = (canvas.height = 360);
  g.clearRect(0, 0, W, H);
  const world = { x0: -980, z0: -760, x1: 980, z1: 860 };
  const sx = W / (world.x1 - world.x0);
  const sz = H / (world.z1 - world.z0);
  const s = Math.min(sx, sz);
  const ox = (W - (world.x1 - world.x0) * s) / 2;
  const oz = (H - (world.z1 - world.z0) * s) / 2;
  const P = (x: number, z: number): [number, number] => [(x - world.x0) * s + ox, (z - world.z0) * s + oz];
  // roads
  g.strokeStyle = 'rgba(120,135,160,0.5)';
  g.lineCap = 'round';
  for (const edge of app.world.net.edges.values()) {
    g.lineWidth = edge.def.kind === 'highway' ? 4 : 2;
    g.beginPath();
    edge.center.forEach((p, i) => {
      const [px, pz] = P(p.x, p.z);
      i === 0 ? g.moveTo(px, pz) : g.lineTo(px, pz);
    });
    g.stroke();
  }
  // drive path
  g.strokeStyle = 'rgba(77,163,255,0.55)';
  g.lineWidth = 2.4;
  g.beginPath();
  for (let i = 0; i < sv.n; i++) {
    const [px, pz] = P(sv.x(i), sv.z(i));
    i === 0 ? g.moveTo(px, pz) : g.lineTo(px, pz);
  }
  g.stroke();
  // hard events
  for (let i = 0; i < sv.n; i++) {
    if (sv.gLong(i) < -0.42 || Math.abs(sv.gLat(i)) > 0.5) {
      const [px, pz] = P(sv.x(i), sv.z(i));
      g.fillStyle = 'rgba(255,160,60,0.5)';
      g.beginPath();
      g.arc(px, pz, 6, 0, Math.PI * 2);
      g.fill();
    }
  }
  // faults
  for (const f of faults) {
    const [px, pz] = P(f.x, f.z);
    g.fillStyle = f.severity === 'minor' ? 'rgba(255,181,71,0.9)' : 'rgba(255,80,60,0.9)';
    g.beginPath();
    g.arc(px, pz, 7, 0, Math.PI * 2);
    g.fill();
  }
}

export function renderDashboard(app: GameApp, payload: ReplayPayload): void {
  const sv = view(payload);
  const m = payload.meta;
  let hardBrakes = 0;
  let hardSteers = 0;
  let overLimitTime = 0;
  for (let i = 0; i < sv.n; i++) {
    if (sv.gLong(i) < -0.42) hardBrakes++;
    if (Math.abs(sv.gLat(i)) > 0.5) hardSteers++;
    if (sv.speed(i) > sv.limit(i) + 5) overLimitTime += 0.2;
  }
  const missedChecks = payload.faults.filter((f) => f.code === 'no-shoulder-check' || f.code === 'merge-no-shoulder-check').length;
  const compliance = m.counters.laneChanges + m.counters.merges > 0
    ? Math.round((1 - missedChecks / Math.max(m.counters.laneChanges + m.counters.merges, 1)) * 100)
    : 100;
  const mirrorPerMin = m.durationS > 30 ? (m.counters.mirrorChecks / (m.durationS / 60)).toFixed(1) : '—';

  const report = computeReport(payload.faults, m.observationScore, m.durationS, 0);
  const recs = report.recommendations.length
    ? report.recommendations
        .map((r, i) => `<div class="card" data-lesson="${r.lessonId}"><h3>${i + 1}. ${r.title}</h3><p>${r.reason}</p></div>`)
        .join('')
    : '<p class="dim">No weak areas detected on this drive — take the mock test.</p>';

  const el = app.menus.showCustom(`
    <div class="spread"><h1>📈 Telemetry — ${m.mode} drive</h1><button class="btn ghost" id="back">← Back</button></div>
    <p class="dim">${new Date(m.at).toLocaleString()} · ${Math.round(m.durationS / 60)} min · weather: ${m.weather} ·
    ${payload.faults.length} faults${m.score !== null ? ` · score ${m.score}%` : ''}</p>
    <div class="statgrid">
      <div class="stat"><b>${hardBrakes}</b><span>hard-brake samples</span></div>
      <div class="stat"><b>${hardSteers}</b><span>hard-steer samples</span></div>
      <div class="stat"><b>${Math.round(overLimitTime)}s</b><span>over the limit</span></div>
      <div class="stat"><b>${mirrorPerMin}</b><span>mirror checks / min</span></div>
      <div class="stat"><b>${compliance}%</b><span>blind-spot compliance</span></div>
      <div class="stat"><b>${Math.round(m.observationScore)}</b><span>observation score</span></div>
    </div>
    <div class="chart"><div class="label">Speed (blue) vs posted limit (amber) — dots are faults</div><canvas id="chSpeed"></canvas></div>
    <div class="chart" style="margin-top:12px"><div class="label">Following-distance distribution</div><canvas id="chGap"></canvas></div>
    <div class="chart" style="margin-top:12px"><div class="label">Drive path · hard events (orange) · faults (red)</div><canvas id="chMap"></canvas></div>
    <h2>Practice these next</h2>
    <div class="card-grid">${recs}</div>
    <div class="row" style="margin-top:18px"><button class="btn primary" id="watch">🎬 Watch this drive</button></div>
  `);
  lineChart(el.querySelector('#chSpeed') as HTMLCanvasElement, sv, payload.faults);
  histogram(el.querySelector('#chGap') as HTMLCanvasElement, sv);
  heatmap(el.querySelector('#chMap') as HTMLCanvasElement, app, sv, payload.faults);
  (el.querySelector('#back') as HTMLElement).onclick = () => app.showMainMenu();
  (el.querySelector('#watch') as HTMLElement).onclick = () => app.replayPlayer.start(payload);
  el.querySelectorAll<HTMLElement>('[data-lesson]').forEach((card) => {
    card.onclick = () => {
      const lesson = LESSONS.find((l) => l.id === card.dataset.lesson);
      if (lesson) app.lessonRunner.start(lesson);
    };
  });
}

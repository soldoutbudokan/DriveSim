/**
 * Minimap: a round, heading-up map. The road network is baked once into
 * world-space Path2D objects; each refresh strokes them through a transform
 * that centres the player (slightly below the middle, so more of the road
 * ahead shows), rotates their heading to "up" and zooms out with speed.
 * Vector drawing keeps it sharp at any zoom, rotation and pixel ratio.
 */

import type { RoadNetwork } from '../world/network';
import type { V2 } from '../core/math';

export interface MinimapMarker {
  x: number;
  z: number;
  color: string;
  /** radius px */
  r?: number;
}

interface HeatDot {
  x: number;
  z: number;
  color: string;
  r: number;
}

const LAKE = { x0: -980, z0: 690, x1: 980, z1: 890 };

export class Minimap {
  /** Metres shown across the map at a standstill (zooms out with speed). */
  zoomMetres = 250;

  private ctx: CanvasRenderingContext2D;
  private streets = new Path2D();
  private arterials = new Path2D();
  private highways = new Path2D();
  private signals: V2[] = [];
  private heat: HeatDot[] = [];
  private zoomSmooth = 250;

  constructor(
    net: RoadNetwork,
    private canvas: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext('2d')!;
    for (const edge of net.edges.values()) {
      const d = edge.def;
      const path = d.kind === 'highway' || d.kind === 'ramp' ? this.highways : d.lanesF + d.lanesB >= 4 ? this.arterials : this.streets;
      edge.center.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.z) : path.lineTo(p.x, p.z)));
    }
    for (const node of net.nodes.values()) {
      if (node.def.control === 'signal') this.signals.push({ x: node.def.x, z: node.def.z });
    }
  }

  /** Add a persistent heat dot (hard braking / fault location). */
  addHeat(x: number, z: number, color = 'rgba(255,80,60,0.4)', r = 5): void {
    this.heat.push({ x, z, color, r });
    if (this.heat.length > 400) this.heat.shift();
  }

  clearHeat(): void {
    this.heat.length = 0;
  }

  update(player: { x: number; z: number; heading: number; speed?: number }, route?: V2[], markers?: MinimapMarker[]): void {
    const { ctx, canvas } = this;
    const cssW = canvas.clientWidth;
    if (!cssW) return; // hidden
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(cssW * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    const w = cssW;
    const r = w / 2;
    const cx = r;
    const cy = w * 0.6;

    const targetZoom = this.zoomMetres * (1 + Math.min(1, (player.speed ?? 0) / 28) * 0.9);
    this.zoomSmooth += (targetZoom - this.zoomSmooth) * 0.12;
    const s = w / this.zoomSmooth; // px per metre
    const m = (pxSize: number): number => pxSize / s; // screen px → metres

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, w);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    ctx.clip();
    const bg = ctx.createRadialGradient(cx, cy, 0, r, r, r * 1.1);
    bg.addColorStop(0, '#1a2436');
    bg.addColorStop(1, '#0c121c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, w);

    // world layer, heading-up
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(player.heading - Math.PI);
    ctx.scale(s, s);
    ctx.translate(-player.x, -player.z);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.fillStyle = '#16304a';
    ctx.fillRect(LAKE.x0, LAKE.z0, LAKE.x1 - LAKE.x0, LAKE.z1 - LAKE.z0);

    // casing then fill gives the roads a crisp edge
    const road = (path: Path2D, width: number, casing: string, fill: string): void => {
      ctx.strokeStyle = casing;
      ctx.lineWidth = width + m(2.5);
      ctx.stroke(path);
      ctx.strokeStyle = fill;
      ctx.lineWidth = width;
      ctx.stroke(path);
    };
    road(this.streets, Math.max(7, m(3)), '#0a0f18', '#3b4a60');
    road(this.arterials, Math.max(11, m(4.2)), '#0a0f18', '#56667e');
    road(this.highways, Math.max(16, m(5.5)), '#0a0f18', '#7d8aa0');

    ctx.fillStyle = '#6fd08c';
    for (const p of this.signals) {
      ctx.beginPath();
      ctx.arc(p.x, p.z, m(2.6), 0, Math.PI * 2);
      ctx.fill();
    }
    for (const h of this.heat) {
      ctx.fillStyle = h.color;
      ctx.beginPath();
      ctx.arc(h.x, h.z, m(h.r * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }

    if (route && route.length > 1) {
      const path = new Path2D();
      route.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.z) : path.lineTo(p.x, p.z)));
      ctx.strokeStyle = 'rgba(77,163,255,0.35)';
      ctx.lineWidth = m(9);
      ctx.stroke(path);
      ctx.strokeStyle = '#7cc0ff';
      ctx.lineWidth = m(3.5);
      ctx.stroke(path);
    }
    ctx.restore();

    // markers (screen space so they stay round and can clamp to the rim)
    const toScreen = (x: number, z: number): [number, number] => {
      const dx = (x - player.x) * s;
      const dz = (z - player.z) * s;
      const a = player.heading - Math.PI;
      return [cx + dx * Math.cos(a) - dz * Math.sin(a), cy + dx * Math.sin(a) + dz * Math.cos(a)];
    };
    const pulse = 1 + 0.25 * Math.sin(performance.now() / 260);
    for (const mk of markers ?? []) {
      let [sx, sy] = toScreen(mk.x, mk.z);
      const ox = sx - r;
      const oy = sy - r;
      const d = Math.hypot(ox, oy);
      const rim = r - 10;
      ctx.fillStyle = mk.color;
      if (d > rim) {
        // off the map: an arrow on the rim pointing to it
        sx = r + (ox / d) * rim;
        sy = r + (oy / d) * rim;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(Math.atan2(oy, ox));
        ctx.beginPath();
        ctx.moveTo(7, 0);
        ctx.lineTo(-5, -6);
        ctx.lineTo(-5, 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        continue;
      }
      const rad = mk.r ?? 4;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(sx, sy, rad * 2 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // player arrow, always pointing up
    ctx.save();
    ctx.translate(cx, cy);
    ctx.shadowColor = 'rgba(77,163,255,0.8)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#4da3ff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(7, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.restore();

    // north marker riding the rim
    const nx = r + -Math.sin(player.heading) * (r - 11);
    const ny = r + Math.cos(player.heading) * (r - 11);
    ctx.fillStyle = 'rgba(8,12,20,0.85)';
    ctx.beginPath();
    ctx.arc(nx, ny, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff6b6b';
    ctx.font = '700 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 0.5);
    ctx.restore();
  }
}

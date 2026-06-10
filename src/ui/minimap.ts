/**
 * Minimap: the road network is pre-rendered once to an offscreen canvas; each
 * frame a north-up window around the player is blitted with the player arrow,
 * optional route polyline, markers and a fault heat overlay.
 */

import type { RoadNetwork } from '../world/network';
import type { V2 } from '../core/math';

const SCALE = 0.42; // px per metre on the static layer
const WORLD = { x0: -980, z0: -760, x1: 980, z1: 860 };

export interface MinimapMarker {
  x: number;
  z: number;
  color: string;
  /** radius px */
  r?: number;
}

export class Minimap {
  private staticLayer: HTMLCanvasElement;
  private heatLayer: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** window size in metres shown across the minimap */
  zoomMetres = 360;

  constructor(
    private net: RoadNetwork,
    private canvas: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.staticLayer = document.createElement('canvas');
    this.staticLayer.width = Math.ceil((WORLD.x1 - WORLD.x0) * SCALE);
    this.staticLayer.height = Math.ceil((WORLD.z1 - WORLD.z0) * SCALE);
    this.heatLayer = document.createElement('canvas');
    this.heatLayer.width = this.staticLayer.width;
    this.heatLayer.height = this.staticLayer.height;
    this.renderStatic();
  }

  worldToStatic(x: number, z: number): [number, number] {
    return [(x - WORLD.x0) * SCALE, (z - WORLD.z0) * SCALE];
  }

  private renderStatic(): void {
    const g = this.staticLayer.getContext('2d')!;
    g.fillStyle = '#10151f';
    g.fillRect(0, 0, this.staticLayer.width, this.staticLayer.height);
    // lake
    g.fillStyle = '#16314a';
    const [lx, lz] = this.worldToStatic(-980, 690);
    g.fillRect(lx, lz, 1960 * SCALE, 200 * SCALE);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const edge of this.net.edges.values()) {
      const d = edge.def;
      const wide = d.kind === 'highway' ? 8 : d.kind === 'ramp' ? 4 : d.lanesF + d.lanesB >= 4 ? 5 : 3;
      g.strokeStyle = d.kind === 'highway' || d.kind === 'ramp' ? '#3d4f66' : '#39414f';
      g.lineWidth = wide * SCALE * 2.2;
      g.beginPath();
      edge.center.forEach((p, i) => {
        const [px, pz] = this.worldToStatic(p.x, p.z);
        i === 0 ? g.moveTo(px, pz) : g.lineTo(px, pz);
      });
      g.stroke();
    }
    // signals as dots
    for (const node of this.net.nodes.values()) {
      if (node.def.control !== 'signal') continue;
      const [px, pz] = this.worldToStatic(node.def.x, node.def.z);
      g.fillStyle = '#67a36b';
      g.beginPath();
      g.arc(px, pz, 2.2, 0, Math.PI * 2);
      g.fill();
    }
  }

  /** Add a persistent heat dot (hard braking / fault location). */
  addHeat(x: number, z: number, color = 'rgba(255,80,60,0.4)', r = 5): void {
    const g = this.heatLayer.getContext('2d')!;
    const [px, pz] = this.worldToStatic(x, z);
    g.fillStyle = color;
    g.beginPath();
    g.arc(px, pz, r, 0, Math.PI * 2);
    g.fill();
  }

  clearHeat(): void {
    const g = this.heatLayer.getContext('2d')!;
    g.clearRect(0, 0, this.heatLayer.width, this.heatLayer.height);
  }

  update(player: { x: number; z: number; heading: number }, route?: V2[], markers?: MinimapMarker[]): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const winPx = this.zoomMetres * SCALE;
    const [cx, cz] = this.worldToStatic(player.x, player.z);
    const sx = cx - winPx / 2;
    const sz = cz - winPx / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.staticLayer, sx, sz, winPx, winPx, 0, 0, w, h);
    ctx.drawImage(this.heatLayer, sx, sz, winPx, winPx, 0, 0, w, h);

    const toMap = (x: number, z: number): [number, number] => {
      const [px, pz] = this.worldToStatic(x, z);
      return [((px - sx) / winPx) * w, ((pz - sz) / winPx) * h];
    };

    if (route && route.length > 1) {
      ctx.strokeStyle = 'rgba(77,163,255,0.95)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      route.forEach((p, i) => {
        const [px, pz] = toMap(p.x, p.z);
        i === 0 ? ctx.moveTo(px, pz) : ctx.lineTo(px, pz);
      });
      ctx.stroke();
    }

    if (markers) {
      for (const m of markers) {
        const [px, pz] = toMap(m.x, m.z);
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.arc(px, pz, m.r ?? 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // player arrow (north-up map; heading 0 = south/+z = down)
    const [px, pz] = toMap(player.x, player.z);
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(Math.PI - player.heading);
    ctx.fillStyle = '#4da3ff';
    ctx.strokeStyle = '#dff0ff';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // north indicator
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '600 10px system-ui';
    ctx.fillText('N', 6, 13);
  }
}

/**
 * Procedural material toolkit. Everything the renderer touches is generated
 * here at runtime on canvases: tileable value-noise fields, normal maps
 * derived from height fields, packed roughness/metalness (ORM-style) maps,
 * and complete texture sets for asphalt, concrete, brick, roof shingles,
 * corrugated steel, curtain-wall and punched-window facades, storefronts,
 * grass, bark, leaf cards, Ontario licence plates and flags. A macro
 * variation shader hook removes the visible tiling on large surfaces.
 */

import * as THREE from 'three';
import { mulberry32 } from '../core/math';

/* ------------------------------------------------------------------ */
/* canvas + texture helpers                                            */
/* ------------------------------------------------------------------ */

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

export interface TexOpts {
  srgb?: boolean;
  repeat?: boolean;
  aniso?: number;
  /** Per-axis repeat counts. */
  rep?: [number, number];
}

export function tex(c: HTMLCanvasElement, o: TexOpts = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = o.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = o.aniso ?? 8;
  if (o.repeat !== false) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  if (o.rep) t.repeat.set(o.rep[0], o.rep[1]);
  return t;
}

/** Data-map texture (normals / ORM): never sRGB. */
export function dataTex(c: HTMLCanvasElement, o: TexOpts = {}): THREE.CanvasTexture {
  return tex(c, { ...o, srgb: false });
}

export interface TextureSet {
  map: THREE.CanvasTexture;
  normal?: THREE.CanvasTexture;
  /** G = roughness, B = metalness. */
  orm?: THREE.CanvasTexture;
  emissive?: THREE.CanvasTexture;
  /** World size (m) covered by one tile. */
  tile: [number, number];
}

/* ------------------------------------------------------------------ */
/* noise                                                               */
/* ------------------------------------------------------------------ */

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Tileable fractal value noise on a w×h grid, values 0..1. */
export function noiseField(w: number, h: number, seed: number, cells: number, octaves = 4, gain = 0.5): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const f = cells * 2 ** o;
    const rng = mulberry32(seed * 131 + o * 7919);
    const lattice = new Float32Array(f * f);
    for (let i = 0; i < f * f; i++) lattice[i] = rng();
    for (let y = 0; y < h; y++) {
      const fy = (y / h) * f;
      const y0 = Math.floor(fy);
      const ty = smooth(fy - y0);
      const y1 = (y0 + 1) % f;
      for (let x = 0; x < w; x++) {
        const fx = (x / w) * f;
        const x0 = Math.floor(fx);
        const tx = smooth(fx - x0);
        const x1 = (x0 + 1) % f;
        const a = lattice[y0 * f + x0];
        const b = lattice[y0 * f + x1];
        const c = lattice[y1 * f + x0];
        const d = lattice[y1 * f + x1];
        const v = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
        out[y * w + x] += v * amp;
      }
    }
    total += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Height field → tangent-space normal map canvas (wraps at the edges). */
export function normalFromHeight(height: Float32Array, w: number, h: number, strength: number): HTMLCanvasElement {
  const [c, g] = canvas(w, h);
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const yu = (y - 1 + h) % h;
    const yd = (y + 1) % h;
    for (let x = 0; x < w; x++) {
      const xl = (x - 1 + w) % w;
      const xr = (x + 1) % w;
      const dx = (height[y * w + xr] - height[y * w + xl]) * strength;
      const dy = (height[yd * w + x] - height[yu * w + x]) * strength;
      let nx = -dx;
      let ny = dy;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Height field from a canvas' luminance (0..1). */
export function heightFromCanvas(c: HTMLCanvasElement): Float32Array {
  const g = c.getContext('2d')!;
  const { data } = g.getImageData(0, 0, c.width, c.height);
  const out = new Float32Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
  return out;
}

/** Pack roughness (G) and metalness (B) fields into one canvas. */
export function ormCanvas(w: number, h: number, rough: Float32Array | number, metal: Float32Array | number): HTMLCanvasElement {
  const [c, g] = canvas(w, h);
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const r = typeof rough === 'number' ? rough : rough[i];
    const m = typeof metal === 'number' ? metal : metal[i];
    d[i * 4] = 255;
    d[i * 4 + 1] = Math.max(0, Math.min(255, r * 255));
    d[i * 4 + 2] = Math.max(0, Math.min(255, m * 255));
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

const rgb = (r: number, g: number, b: number, a = 1): string => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;

/* ------------------------------------------------------------------ */
/* macro variation (anti-tiling)                                       */
/* ------------------------------------------------------------------ */

let macroTex: THREE.DataTexture | null = null;

function macroNoiseTexture(): THREE.DataTexture {
  if (macroTex) return macroTex;
  const n = 256;
  const f = noiseField(n, n, 4242, 4, 5, 0.55);
  const f2 = noiseField(n, n, 9191, 6, 4, 0.5);
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    data[i * 4] = f[i] * 255;
    data[i * 4 + 1] = f2[i] * 255;
    data[i * 4 + 2] = 128;
    data[i * 4 + 3] = 255;
  }
  macroTex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  macroTex.wrapS = THREE.RepeatWrapping;
  macroTex.wrapT = THREE.RepeatWrapping;
  macroTex.minFilter = THREE.LinearMipmapLinearFilter;
  macroTex.magFilter = THREE.LinearFilter;
  macroTex.generateMipmaps = true;
  macroTex.needsUpdate = true;
  return macroTex;
}

export interface MacroOpts {
  /** World metres per noise tile. */
  scale?: number;
  /** Brightness swing ±. */
  strength?: number;
  /** Optional second colour blended in where the second noise channel is high. */
  tint?: THREE.Color;
  tintAmount?: number;
}

/**
 * Multiply the diffuse colour by a world-space low-frequency noise so that
 * repeated tiles stop reading as a grid. Works on instanced meshes too.
 */
export function macroVariation(mat: THREE.MeshStandardMaterial, opts: MacroOpts = {}): void {
  const scale = opts.scale ?? 60;
  const strength = opts.strength ?? 0.18;
  const tint = opts.tint ?? new THREE.Color(0x6b6a4a);
  const tintAmount = opts.tintAmount ?? 0;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMacroTex = { value: macroNoiseTexture() };
    shader.uniforms.uMacroScale = { value: 1 / scale };
    shader.uniforms.uMacroStrength = { value: strength };
    shader.uniforms.uMacroTint = { value: tint };
    shader.uniforms.uMacroTintAmt = { value: tintAmount };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vMacroPos;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 mwp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            mwp = instanceMatrix * mwp;
          #endif
          mwp = modelMatrix * mwp;
          vMacroPos = mwp.xz;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vMacroPos;
        uniform sampler2D uMacroTex;
        uniform float uMacroScale;
        uniform float uMacroStrength;
        uniform vec3 uMacroTint;
        uniform float uMacroTintAmt;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec2 mn = texture2D(uMacroTex, vMacroPos * uMacroScale).rg;
          vec2 mn2 = texture2D(uMacroTex, vMacroPos * uMacroScale * 3.7 + 0.31).rg;
          float lum = mix(1.0 - uMacroStrength, 1.0 + uMacroStrength, mn.r * 0.65 + mn2.r * 0.35);
          diffuseColor.rgb *= lum;
          float tm = smoothstep(0.55, 0.8, mn.g * 0.6 + mn2.g * 0.4) * uMacroTintAmt;
          diffuseColor.rgb = mix(diffuseColor.rgb, uMacroTint, tm);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'macro';
  mat.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* surface sets                                                        */
/* ------------------------------------------------------------------ */

const sharedNoiseCache = new Map<string, Float32Array>();
/** One mid-frequency noise field per size, reused (offset per seed) by every facade. */
function sharedNoise(w: number, h: number): Float32Array {
  const key = `${w}x${h}`;
  let f = sharedNoiseCache.get(key);
  if (!f) {
    f = noiseField(w, h, 7, 8, 3, 0.5);
    sharedNoiseCache.set(key, f);
  }
  return f;
}

const setCache = new Map<string, TextureSet>();

function cached(key: string, build: () => TextureSet): TextureSet {
  const hit = setCache.get(key);
  if (hit) return hit;
  const s = build();
  setCache.set(key, s);
  return s;
}

/** Road asphalt: aggregate grain, repair scars, cracks; normal + roughness. Tile 6 m. */
export function asphaltSet(): TextureSet {
  return cached('asphalt', () => {
    const n = 512;
    const [c, g] = canvas(n, n);
    const rng = mulberry32(7);
    const grain = noiseField(n, n, 3, 64, 3, 0.5);
    const macro = noiseField(n, n, 11, 3, 3, 0.5);
    const img = g.createImageData(n, n);
    const d = img.data;
    const height = new Float32Array(n * n);
    const rough = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) {
      const gr = grain[i];
      const ma = macro[i];
      const v = 46 + gr * 34 + (ma - 0.5) * 22;
      d[i * 4] = v;
      d[i * 4 + 1] = v + 2;
      d[i * 4 + 2] = v + 5;
      d[i * 4 + 3] = 255;
      height[i] = gr * 0.7 + ma * 0.3;
      rough[i] = 0.86 + gr * 0.12;
    }
    g.putImageData(img, 0, 0);
    // sharp aggregate specks
    for (let i = 0; i < 9000; i++) {
      const v = 70 + rng() * 70;
      g.fillStyle = rgb(v, v + 3, v + 8, 0.85);
      g.fillRect(rng() * n, rng() * n, 1 + rng() * 1.6, 1 + rng() * 1.6);
    }
    // a few hairline cracks (also carved into the height field); large-scale
    // patching comes from the macro-variation shader, not the tile
    g.strokeStyle = rgb(22, 23, 26, 0.55);
    g.lineWidth = 1.0;
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      let x = rng() * n;
      let y = rng() * n;
      g.moveTo(x, y);
      for (let k = 0; k < 7; k++) {
        x += (rng() - 0.5) * 60;
        y += rng() * 40;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    const crackH = heightFromCanvas(c);
    for (let i = 0; i < n * n; i++) height[i] = height[i] * 0.6 + crackH[i] * 0.4;
    return {
      map: tex(c),
      normal: dataTex(normalFromHeight(height, n, n, 1.6)),
      orm: dataTex(ormCanvas(n, n, rough, 0)),
      tile: [6, 6],
    };
  });
}

/** Sidewalk concrete: 2 m slabs with joints, broom texture, stains. Tile 2×8 m. */
export function concreteSet(): TextureSet {
  return cached('concrete', () => {
    const w = 256;
    const h = 1024;
    const [c, g] = canvas(w, h);
    const rng = mulberry32(31);
    const grain = noiseField(w, h, 5, 32, 3, 0.5);
    const macro = noiseField(w, h, 17, 2, 3, 0.5);
    const img = g.createImageData(w, h);
    const d = img.data;
    const height = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const v = 150 + grain[i] * 40 + (macro[i] - 0.5) * 30;
      d[i * 4] = v;
      d[i * 4 + 1] = v + 2;
      d[i * 4 + 2] = v + 4;
      d[i * 4 + 3] = 255;
      height[i] = 0.75 + grain[i] * 0.25;
    }
    g.putImageData(img, 0, 0);
    // stains
    for (let i = 0; i < 10; i++) {
      const x = rng() * w;
      const y = rng() * h;
      const r = 20 + rng() * 60;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rgb(90, 88, 84, 0.25));
      grad.addColorStop(1, rgb(0, 0, 0, 0));
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // joints: 4 across the tile height (every 2 m), one centre seam
    const joint = (x: number, y: number, jw: number, jh: number): void => {
      g.fillStyle = rgb(70, 72, 76, 0.9);
      g.fillRect(x, y, jw, jh);
      for (let yy = y; yy < y + jh; yy++) for (let xx = x; xx < x + jw; xx++) height[((yy + h) % h) * w + ((xx + w) % w)] = 0.1;
    };
    for (let j = 0; j < 4; j++) joint(0, j * 256, w, 4);
    joint(126, 0, 3, h);
    return {
      map: tex(c),
      normal: dataTex(normalFromHeight(height, w, h, 2.2)),
      orm: dataTex(ormCanvas(w, h, 0.9, 0)),
      tile: [2, 8],
    };
  });
}

/** Grass: blade noise + patches; lit by macro variation on the material. Tile 4 m. */
export function grassSet(): TextureSet {
  return cached('grass', () => {
    const n = 384;
    const [c, g] = canvas(n, n);
    const rng = mulberry32(13);
    const fine = noiseField(n, n, 21, 48, 4, 0.55);
    const mid = noiseField(n, n, 23, 6, 3, 0.5);
    const img = g.createImageData(n, n);
    const d = img.data;
    const height = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) {
      const k = fine[i];
      const m = mid[i];
      const r = 64 + k * 40 + (m - 0.5) * 30;
      const gg = 96 + k * 50 + (m - 0.5) * 26;
      const b = 34 + k * 20;
      d[i * 4] = r;
      d[i * 4 + 1] = gg;
      d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
      height[i] = k;
    }
    g.putImageData(img, 0, 0);
    for (let i = 0; i < 6000; i++) {
      const k = rng();
      g.fillStyle = rgb(70 + k * 60, 110 + k * 60, 40 + k * 20, 0.6);
      const x = rng() * n;
      const y = rng() * n;
      g.fillRect(x, y, 1, 2 + rng() * 3);
    }
    return {
      map: tex(c),
      normal: dataTex(normalFromHeight(height, n, n, 0.9)),
      orm: dataTex(ormCanvas(n, n, 0.95, 0)),
      tile: [4, 4],
    };
  });
}

/** Running-bond brick. Tile 1.6 × 1.6 m. */
export function brickSet(variant: 'red' | 'brown' | 'buff' | 'painted' = 'red'): TextureSet {
  return cached(`brick-${variant}`, () => {
    const n = 384;
    const [c, g] = canvas(n, n);
    const rng = mulberry32(variant.length * 17 + 3);
    const base: Record<typeof variant, [number, number, number]> = {
      red: [150, 62, 48],
      brown: [110, 70, 52],
      buff: [178, 150, 112],
      painted: [196, 190, 178],
    };
    const [br, bg, bb] = base[variant];
    const mortar = variant === 'painted' ? [200, 196, 186] : [168, 160, 150];
    g.fillStyle = rgb(mortar[0], mortar[1], mortar[2]);
    g.fillRect(0, 0, n, n);
    const height = new Float32Array(n * n).fill(0.15);
    const courses = 24; // 1.6 m / 0.0667 m
    const ch = n / courses;
    const bricksPer = 8; // 0.2 m
    const bw = n / bricksPer;
    const gap = 3;
    for (let r = 0; r < courses; r++) {
      const off = r % 2 === 0 ? 0 : bw / 2;
      for (let b = -1; b <= bricksPer; b++) {
        const x = b * bw + off;
        const y = r * ch;
        const k = rng();
        const shade = 0.82 + k * 0.32;
        const tint = (rng() - 0.5) * 18;
        g.fillStyle = rgb(br * shade + tint, bg * shade + tint * 0.6, bb * shade + tint * 0.3);
        g.fillRect(x + gap / 2, y + gap / 2, bw - gap, ch - gap);
        // per-brick speckle
        for (let s = 0; s < 6; s++) {
          g.fillStyle = rgb(0, 0, 0, 0.12 * rng());
          g.fillRect(x + gap + rng() * (bw - gap * 2), y + gap + rng() * (ch - gap * 2), 3, 2);
        }
        const hv = 0.85 + (rng() - 0.5) * 0.2;
        for (let yy = Math.floor(y + gap / 2); yy < y + ch - gap / 2; yy++) {
          for (let xx = Math.floor(x + gap / 2); xx < x + bw - gap / 2; xx++) {
            height[((yy + n) % n) * n + ((xx + n) % n)] = hv;
          }
        }
      }
    }
    // weathering streaks
    const streak = noiseField(n, n, 77, 8, 3, 0.5);
    const img = g.getImageData(0, 0, n, n);
    for (let i = 0; i < n * n; i++) {
      const s = 0.9 + streak[i] * 0.2;
      img.data[i * 4] *= s;
      img.data[i * 4 + 1] *= s;
      img.data[i * 4 + 2] *= s;
    }
    g.putImageData(img, 0, 0);
    return {
      map: tex(c),
      normal: dataTex(normalFromHeight(height, n, n, 2.4)),
      orm: dataTex(ormCanvas(n, n, 0.88, 0)),
      tile: [1.6, 1.6],
    };
  });
}

/** Asphalt roof shingles. Tile 2 × 2 m. */
export function shingleSet(): TextureSet {
  return cached('shingle', () => {
    const n = 384;
    const [c, g] = canvas(n, n);
    const rng = mulberry32(51);
    const rows = 12;
    const rh = n / rows;
    const tabs = 8;
    const tw = n / tabs;
    const height = new Float32Array(n * n);
    const grain = noiseField(n, n, 9, 40, 3, 0.5);
    for (let r = 0; r < rows; r++) {
      const off = r % 2 === 0 ? 0 : tw / 2;
      for (let t = -1; t <= tabs; t++) {
        const k = rng();
        const v = 58 + k * 30;
        g.fillStyle = rgb(v, v - 4, v - 8);
        g.fillRect(t * tw + off, r * rh, tw - 2, rh);
      }
      g.fillStyle = rgb(28, 26, 24, 0.85);
      g.fillRect(0, r * rh + rh - 3, n, 3);
    }
    const img = g.getImageData(0, 0, n, n);
    for (let y = 0; y < n; y++) {
      const rowT = (y % rh) / rh;
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const s = 0.85 + grain[i] * 0.3;
        img.data[i * 4] *= s;
        img.data[i * 4 + 1] *= s;
        img.data[i * 4 + 2] *= s;
        height[i] = (rowT < 0.92 ? 0.7 : 0.2) + grain[i] * 0.15;
      }
    }
    g.putImageData(img, 0, 0);
    return {
      map: tex(c),
      normal: dataTex(normalFromHeight(height, n, n, 2.0)),
      orm: dataTex(ormCanvas(n, n, 0.92, 0)),
      tile: [2, 2],
    };
  });
}

/** Standing-seam / corrugated steel cladding. Tile 2 × 2 m. */
export function corrugatedSet(color: [number, number, number] = [150, 156, 160]): TextureSet {
  return cached(`corr-${color.join(',')}`, () => {
    const n = 256;
    const [c, g] = canvas(n, n);
    const height = new Float32Array(n * n);
    const rust = noiseField(n, n, 61, 6, 3, 0.5);
    const img = g.createImageData(n, n);
    const ribs = 16;
    for (let y = 0; y < n; y++) {
      for (let x = 0, i = y * n; x < n; x++, i++) {
        const ph = ((x / n) * ribs) % 1;
        const rib = 0.5 + 0.5 * Math.cos(ph * Math.PI * 2);
        const shade = 0.82 + rib * 0.22 - (rust[i] > 0.66 ? (rust[i] - 0.66) * 1.2 : 0);
        img.data[i * 4] = color[0] * shade + (rust[i] > 0.66 ? 40 : 0);
        img.data[i * 4 + 1] = color[1] * shade;
        img.data[i * 4 + 2] = color[2] * shade;
        img.data[i * 4 + 3] = 255;
        height[i] = rib;
      }
    }
    g.putImageData(img, 0, 0);
    const rough = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) rough[i] = 0.45 + rust[i] * 0.3;
    return {
      map: tex(c),
      normal: dataTex(normalFromHeight(height, n, n, 3.0)),
      orm: dataTex(ormCanvas(n, n, rough, 0.6)),
      tile: [2, 2],
    };
  });
}

/* ------------------------------------------------------------------ */
/* facades                                                             */
/* ------------------------------------------------------------------ */

export type FacadeStyle = 'glass' | 'punched' | 'ribbon' | 'condo';

export interface FacadeOpts {
  seed: number;
  style: FacadeStyle;
  /** Wall / spandrel colour. */
  wall: [number, number, number];
  /** Floor height (m) and bay width (m) represented by one texture cell. */
  floorH?: number;
  bayW?: number;
  /** Fraction of windows lit at night. */
  lit?: number;
}

/**
 * Curtain-wall / punched-window facade. The tile spans 4 bays × 4 floors so
 * the lit-window pattern repeats slowly. Includes normal (recessed glass and
 * mullions), packed roughness/metalness (glass is smooth+metallic so it picks
 * up the sky reflection) and an emissive sheet for night.
 */
export function facadeSet(o: FacadeOpts): TextureSet {
  const key = `facade|${o.seed}|${o.style}|${o.wall.join(',')}|${o.lit ?? 0.35}`;
  return cached(key, () => {
    const bays = 4;
    const floors = 4;
    const cellW = 96;
    const cellH = 96;
    const W = cellW * bays;
    const H = cellH * floors;
    const [c, g] = canvas(W, H);
    const [ce, ge] = canvas(W, H);
    const rng = mulberry32(o.seed * 7 + 1);
    const [wr, wg, wb] = o.wall;
    const height = new Float32Array(W * H).fill(1);
    const rough = new Float32Array(W * H).fill(0.75);
    const metal = new Float32Array(W * H).fill(0.05);
    const wallNoise = sharedNoise(W, H);
    const shift = (o.seed * 7919) % (W * H);

    // wall base
    const img = g.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const s = 0.9 + wallNoise[(i + shift) % (W * H)] * 0.2;
      img.data[i * 4] = wr * s;
      img.data[i * 4 + 1] = wg * s;
      img.data[i * 4 + 2] = wb * s;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    ge.fillStyle = '#000';
    ge.fillRect(0, 0, W, H);

    const litFrac = o.lit ?? 0.35;
    const setRect = (x0: number, y0: number, w: number, h: number, hv: number, rv: number, mv: number): void => {
      for (let y = Math.floor(y0); y < y0 + h; y++) {
        for (let x = Math.floor(x0); x < x0 + w; x++) {
          const i = ((y + H) % H) * W + ((x + W) % W);
          height[i] = hv;
          rough[i] = rv;
          metal[i] = mv;
        }
      }
    };
    const glassPane = (x: number, y: number, w: number, h: number, lit: boolean, tone: number): void => {
      // frame
      g.fillStyle = rgb(40, 44, 50);
      g.fillRect(x, y, w, h);
      // glass with vertical gradient (sky reflection hint)
      const grad = g.createLinearGradient(0, y, 0, y + h);
      const base = 60 + tone * 40;
      grad.addColorStop(0, rgb(base + 30, base + 42, base + 60));
      grad.addColorStop(1, rgb(base - 20, base - 12, base + 4));
      g.fillStyle = grad;
      g.fillRect(x + 3, y + 3, w - 6, h - 6);
      // interior hint: blinds / a darker band
      if (rng() < 0.4) {
        g.fillStyle = rgb(20, 24, 30, 0.35);
        g.fillRect(x + 3, y + 3, w - 6, (h - 6) * (0.3 + rng() * 0.5));
      }
      setRect(x, y, w, h, 0.6, 0.55, 0.2); // frame slightly recessed, semi-metallic
      setRect(x + 3, y + 3, w - 6, h - 6, 0.35, 0.12, 0.85); // glass recessed, smooth
      if (lit) {
        const warm = rng() < 0.7;
        ge.fillStyle = warm ? rgb(255, 214, 150) : rgb(200, 220, 255);
        ge.fillRect(x + 4, y + 4, w - 8, h - 8);
        // partially drawn curtains
        if (rng() < 0.5) {
          ge.fillStyle = '#000';
          ge.fillRect(x + 4, y + 4, (w - 8) * rng() * 0.5, h - 8);
        }
      }
    };

    for (let f = 0; f < floors; f++) {
      const y0 = f * cellH;
      const floorLit = rng() < litFrac;
      for (let b = 0; b < bays; b++) {
        const x0 = b * cellW;
        const litHere = o.style === 'glass' ? floorLit && rng() < 0.7 : rng() < litFrac;
        if (o.style === 'glass') {
          // full-height glass with a spandrel band at the floor slab
          glassPane(x0 + 4, y0 + 30, cellW - 8, cellH - 34, litHere, 0.5 + rng() * 0.3);
          g.fillStyle = rgb(wr * 0.6, wg * 0.6, wb * 0.6);
          g.fillRect(x0, y0, cellW, 30);
          setRect(x0, y0, cellW, 30, 0.9, 0.5, 0.3);
          // mullion
          g.fillStyle = rgb(70, 74, 80);
          g.fillRect(x0, y0, 4, cellH);
          setRect(x0, y0, 4, cellH, 1, 0.4, 0.6);
        } else if (o.style === 'ribbon') {
          glassPane(x0 - 2, y0 + 44, cellW + 4, cellH - 70, litHere, 0.4 + rng() * 0.3);
          // slab band shadow line
          g.fillStyle = rgb(0, 0, 0, 0.25);
          g.fillRect(x0, y0 + 40, cellW, 4);
        } else if (o.style === 'condo') {
          // sliding door + window per bay, with a balcony slab line (geometry adds the slab)
          glassPane(x0 + 14, y0 + 20, cellW * 0.42, cellH - 34, litHere, 0.4 + rng() * 0.3);
          glassPane(x0 + 14 + cellW * 0.46, y0 + 20, cellW * 0.36, cellH * 0.55, litHere && rng() < 0.6, 0.4 + rng() * 0.3);
        } else {
          // punched window in masonry with a sill
          const ww = cellW * 0.52;
          const wh = cellH * 0.6;
          const wx = x0 + (cellW - ww) / 2;
          const wy = y0 + cellH * 0.22;
          glassPane(wx, wy, ww, wh, litHere, 0.35 + rng() * 0.3);
          g.fillStyle = rgb(wr * 0.7, wg * 0.7, wb * 0.7);
          g.fillRect(wx - 6, wy + wh, ww + 12, 6); // sill
          setRect(wx - 6, wy + wh, ww + 12, 6, 1.1, 0.7, 0);
          // lintel
          g.fillStyle = rgb(wr * 0.78, wg * 0.78, wb * 0.78);
          g.fillRect(wx - 4, wy - 6, ww + 8, 6);
        }
      }
      // floor line subtle
      g.fillStyle = rgb(0, 0, 0, 0.12);
      g.fillRect(0, y0, W, 2);
    }
    return {
      map: tex(c),
      normal: dataTex(normalFromHeight(height, W, H, 2.2)),
      orm: dataTex(ormCanvas(W, H, rough, metal)),
      emissive: tex(ce),
      tile: [(o.bayW ?? 4.5) * bays, (o.floorH ?? 3.2) * floors],
    };
  });
}

const SHOP_NAMES = [
  'Queen West Café', 'Kensington Vintage', 'Bathurst Bagel', 'Dundas Dry Cleaners', 'Spadina Noodle House',
  'Palmerston Books', 'Harbord Hardware', 'Ossington Optical', 'The Beaver Tap', 'Little Italy Espresso',
  'Danforth Pizza', 'College St Flowers', 'Bloor Bike Shop', 'Queen Convenience', 'King St Pharmacy',
  'Annex Records', 'Toronto Tailors', 'Roncy Bakery', 'Parkdale Thrift', 'Chinatown Grocery',
];

/** Ground-floor storefront band: glass fronts, doors, signboards, awnings. Tile 24 × 4.6 m. */
export function storefrontSet(seed: number): TextureSet {
  return cached(`store-${seed}`, () => {
    const W = 768;
    const H = 160;
    const [c, g] = canvas(W, H);
    const [ce, ge] = canvas(W, H);
    const rng = mulberry32(seed * 13 + 5);
    const height = new Float32Array(W * H).fill(1);
    const rough = new Float32Array(W * H).fill(0.8);
    const metal = new Float32Array(W * H).fill(0);
    const setRect = (x0: number, y0: number, w: number, h: number, hv: number, rv: number, mv: number): void => {
      for (let y = Math.floor(y0); y < y0 + h; y++)
        for (let x = Math.floor(x0); x < x0 + w; x++) {
          const i = ((y + H) % H) * W + ((x + W) % W);
          height[i] = hv;
          rough[i] = rv;
          metal[i] = mv;
        }
    };
    ge.fillStyle = '#000';
    ge.fillRect(0, 0, W, H);
    const shops = 4;
    const sw = W / shops;
    const palette = ['#7a2c1f', '#1f3a5a', '#2e5b3a', '#3a3a3a', '#8a5a1e', '#5a2a5a'];
    for (let s = 0; s < shops; s++) {
      const x0 = s * sw;
      // brick pier between shops
      const pier = 22;
      g.fillStyle = rgb(120, 70, 55);
      g.fillRect(x0, 0, pier, H);
      for (let y = 0; y < H; y += 9) {
        g.fillStyle = rgb(150, 100, 80, 0.5);
        g.fillRect(x0 + (Math.floor(y / 9) % 2 ? 4 : 0), y, pier - 6, 7);
      }
      // signboard
      const sign = palette[Math.floor(rng() * palette.length)];
      g.fillStyle = sign;
      g.fillRect(x0 + pier, 0, sw - pier, 46);
      g.fillStyle = rgb(0, 0, 0, 0.35);
      g.fillRect(x0 + pier, 44, sw - pier, 4);
      g.fillStyle = '#f3ede0';
      g.font = `700 ${22 + Math.floor(rng() * 6)}px Georgia, serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(SHOP_NAMES[(seed * 3 + s * 5) % SHOP_NAMES.length], x0 + pier + (sw - pier) / 2, 23);
      // awning band
      if (rng() < 0.6) {
        const aw = ['#b23a2f', '#2f5f8f', '#2f7a4f', '#7a5a2f'][Math.floor(rng() * 4)];
        g.fillStyle = aw;
        g.fillRect(x0 + pier, 46, sw - pier, 18);
        for (let x = x0 + pier; x < x0 + sw; x += 24) {
          g.fillStyle = rgb(255, 255, 255, 0.25);
          g.fillRect(x, 46, 12, 18);
        }
        setRect(x0 + pier, 46, sw - pier, 18, 1.4, 0.8, 0);
      }
      // storefront glazing
      const gy = 66;
      const gh = H - gy - 14;
      g.fillStyle = rgb(30, 32, 36);
      g.fillRect(x0 + pier, gy, sw - pier, gh + 14);
      const doorW = 52;
      const doorX = x0 + pier + 10 + rng() * (sw - pier - doorW - 20);
      const pane = (px: number, pw: number): void => {
        const grad = g.createLinearGradient(0, gy, 0, gy + gh);
        grad.addColorStop(0, rgb(120, 140, 160));
        grad.addColorStop(0.5, rgb(70, 82, 96));
        grad.addColorStop(1, rgb(40, 46, 54));
        g.fillStyle = grad;
        g.fillRect(px, gy + 4, pw, gh - 4);
        // display hints
        g.fillStyle = rgb(255, 230, 190, 0.18);
        g.fillRect(px + 6, gy + gh * 0.45, pw - 12, gh * 0.35);
        setRect(px, gy + 4, pw, gh - 4, 0.4, 0.1, 0.85);
        ge.fillStyle = rgb(255, 200, 140);
        ge.fillRect(px + 2, gy + 6, pw - 4, gh - 8);
      };
      pane(x0 + pier + 4, doorX - x0 - pier - 8);
      pane(doorX + doorW + 4, x0 + sw - doorX - doorW - 8);
      // door
      g.fillStyle = rgb(60, 48, 40);
      g.fillRect(doorX, gy + 4, doorW, gh + 10);
      g.fillStyle = rgb(90, 110, 130);
      g.fillRect(doorX + 8, gy + 12, doorW - 16, gh * 0.6);
      g.fillStyle = rgb(200, 200, 200);
      g.fillRect(doorX + doorW - 14, gy + gh * 0.55, 4, 12);
      setRect(doorX, gy + 4, doorW, gh + 10, 0.5, 0.6, 0.2);
      // bulkhead below glazing
      g.fillStyle = rgb(70, 62, 56);
      g.fillRect(x0 + pier, H - 12, sw - pier, 12);
    }
    return {
      map: tex(c),
      normal: dataTex(normalFromHeight(height, W, H, 2.0)),
      orm: dataTex(ormCanvas(W, H, rough, metal)),
      emissive: tex(ce),
      tile: [24, 4.6],
    };
  });
}

/* ------------------------------------------------------------------ */
/* vegetation + misc                                                   */
/* ------------------------------------------------------------------ */

/** Leaf-cluster card (RGBA). `kind` picks leaf shape/colour. */
export function leafCardTexture(kind: 'maple' | 'oak' | 'spruce' | 'hedge' = 'maple'): THREE.CanvasTexture {
  const key = `leaf-${kind}`;
  const hit = setCache.get(key);
  if (hit) return hit.map;
  const n = 256;
  const [c, g] = canvas(n, n);
  const rng = mulberry32(kind.length * 31 + 7);
  g.clearRect(0, 0, n, n);
  const count = kind === 'spruce' ? 900 : 170;
  for (let i = 0; i < count; i++) {
    // clustered toward the centre so the card reads as a rounded mass
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * n * 0.46;
    const x = n / 2 + Math.cos(a) * r;
    const y = n / 2 + Math.sin(a) * r * (kind === 'spruce' ? 1.15 : 0.95);
    const k = rng();
    const light = 0.6 + (1 - r / (n * 0.5)) * 0.4 * k; // brighter toward the outside/top
    let col: string;
    if (kind === 'spruce') col = rgb(40 + light * 30, 70 + light * 50, 40 + light * 22);
    else if (kind === 'oak') col = rgb(60 + light * 50, 95 + light * 60, 30 + light * 20);
    else if (kind === 'hedge') col = rgb(45 + light * 40, 90 + light * 60, 35 + light * 20);
    else col = rgb(55 + light * 60, 110 + light * 70, 30 + light * 25);
    g.fillStyle = col;
    g.save();
    g.translate(x, y);
    g.rotate(rng() * Math.PI * 2);
    if (kind === 'spruce') {
      g.fillRect(-1, -6, 2, 12);
    } else {
      const s = 7 + rng() * 8;
      g.beginPath();
      g.ellipse(0, 0, s, s * 0.55, 0, 0, Math.PI * 2);
      g.fill();
      // leaf vein/highlight
      g.fillStyle = rgb(255, 255, 255, 0.12);
      g.fillRect(-s * 0.8, -1, s * 1.6, 1.5);
    }
    g.restore();
  }
  const t = tex(c, { repeat: false });
  setCache.set(key, { map: t, tile: [1, 1] });
  return t;
}

/** Tree bark: vertical fissures. Tile 0.6 × 2 m. */
export function barkSet(): TextureSet {
  return cached('bark', () => {
    const w = 128;
    const h = 512;
    const [c, g] = canvas(w, h);
    const fine = noiseField(w, h, 41, 6, 4, 0.55);
    const img = g.createImageData(w, h);
    const height = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        // stretch vertically: sample noise with x weighted heavier
        const v = fine[i];
        const fiss = Math.pow(v, 2.2);
        const base = 60 + fiss * 70;
        img.data[i * 4] = base;
        img.data[i * 4 + 1] = base * 0.82;
        img.data[i * 4 + 2] = base * 0.62;
        img.data[i * 4 + 3] = 255;
        height[i] = fiss;
      }
    }
    g.putImageData(img, 0, 0);
    return {
      map: tex(c),
      normal: dataTex(normalFromHeight(height, w, h, 2.0)),
      orm: dataTex(ormCanvas(w, h, 0.95, 0)),
      tile: [0.6, 2],
    };
  });
}

/** Ontario licence plate (white, blue lettering). */
export function plateTexture(text: string): THREE.CanvasTexture {
  const key = `plate-${text}`;
  const hit = setCache.get(key);
  if (hit) return hit.map;
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#f4f6f8';
  g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#c9ced4';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 252, 124);
  g.fillStyle = '#1b3f9c';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '700 18px system-ui';
  g.fillText('ONTARIO', 128, 18);
  g.font = '700 58px system-ui';
  g.fillText(text, 128, 66);
  g.font = '600 13px system-ui';
  g.fillText('YOURS TO DISCOVER', 128, 112);
  // crown mark
  g.fillStyle = '#1b3f9c';
  g.beginPath();
  g.moveTo(20, 24);
  g.lineTo(24, 12);
  g.lineTo(28, 20);
  g.lineTo(32, 10);
  g.lineTo(36, 20);
  g.lineTo(40, 12);
  g.lineTo(44, 24);
  g.closePath();
  g.fill();
  const t = tex(c, { repeat: false });
  setCache.set(key, { map: t, tile: [1, 1] });
  return t;
}

export function randomPlate(rng: () => number): string {
  const L = 'ABCDEFGHJKLMNPRSTVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += L[Math.floor(rng() * L.length)];
  s += ' ';
  for (let i = 0; i < 3; i++) s += Math.floor(rng() * 10);
  return s;
}

/** Canadian flag. */
export function flagTexture(kind: 'canada' | 'ontario' = 'canada'): THREE.CanvasTexture {
  const key = `flag-${kind}`;
  const hit = setCache.get(key);
  if (hit) return hit.map;
  const [c, g] = canvas(256, 128);
  if (kind === 'canada') {
    g.fillStyle = '#e4002b';
    g.fillRect(0, 0, 64, 128);
    g.fillRect(192, 0, 64, 128);
    g.fillStyle = '#fff';
    g.fillRect(64, 0, 128, 128);
    g.fillStyle = '#e4002b';
    // simplified maple leaf
    g.beginPath();
    const pts = [
      [128, 20], [136, 40], [150, 34], [146, 56], [166, 50], [156, 68], [174, 74], [144, 86], [148, 100],
      [132, 96], [132, 116], [124, 116], [124, 96], [108, 100], [112, 86], [82, 74], [100, 68], [90, 50],
      [110, 56], [106, 34], [120, 40],
    ];
    pts.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)));
    g.closePath();
    g.fill();
  } else {
    g.fillStyle = '#c8102e';
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#012169';
    g.fillRect(0, 0, 128, 64);
    g.strokeStyle = '#fff';
    g.lineWidth = 8;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(128, 64);
    g.moveTo(128, 0);
    g.lineTo(0, 64);
    g.stroke();
    g.strokeStyle = '#c8102e';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(64, 0);
    g.lineTo(64, 64);
    g.moveTo(0, 32);
    g.lineTo(128, 32);
    g.stroke();
    g.fillStyle = '#ffd200';
    g.beginPath();
    g.arc(200, 76, 26, 0, Math.PI * 2);
    g.fill();
  }
  const t = tex(c, { repeat: false });
  setCache.set(key, { map: t, tile: [1, 1] });
  return t;
}

/** Ripple normal map for water. Tile 12 m. */
export function waterNormal(): THREE.CanvasTexture {
  const key = 'water-n';
  const hit = setCache.get(key);
  if (hit) return hit.map;
  const n = 256;
  const f = noiseField(n, n, 88, 8, 4, 0.55);
  const f2 = noiseField(n, n, 89, 12, 3, 0.5);
  const h = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) h[i] = f[i] * 0.6 + f2[i] * 0.4;
  const t = dataTex(normalFromHeight(h, n, n, 1.3));
  setCache.set(key, { map: t, tile: [12, 12] });
  return t;
}

/** Tactile warning plate (yellow domes) for curb ramps. */
export function tactileTexture(): THREE.CanvasTexture {
  const key = 'tactile';
  const hit = setCache.get(key);
  if (hit) return hit.map;
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#d9a41f';
  g.fillRect(0, 0, 128, 128);
  for (let y = 8; y < 128; y += 16) {
    for (let x = 8; x < 128; x += 16) {
      g.fillStyle = '#b3841a';
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#e9b943';
      g.beginPath();
      g.arc(x - 1, y - 1, 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = tex(c);
  setCache.set(key, { map: t, tile: [0.6, 0.6] });
  return t;
}

/* ------------------------------------------------------------------ */
/* material builders                                                   */
/* ------------------------------------------------------------------ */

export interface SurfaceMatOpts {
  color?: number;
  emissive?: number;
  emissiveIntensity?: number;
  normalScale?: number;
  side?: THREE.Side;
  /** Override repeat (tiles across the geometry's 0..1 UV span). */
  rep?: [number, number];
  macro?: MacroOpts | false;
  roughness?: number;
  metalness?: number;
  physical?: boolean;
}

/**
 * Build a MeshStandardMaterial from a texture set. Geometry UVs are expected
 * in metres (1 UV unit = 1 m) unless `rep` is given, in which case UVs are
 * 0..1 and the repeat is applied to the textures.
 */
export function surfaceMaterial(set: TextureSet, o: SurfaceMatOpts = {}): THREE.MeshStandardMaterial {
  const cloneRep = (t: THREE.CanvasTexture | undefined): THREE.CanvasTexture | undefined => {
    if (!t) return undefined;
    const r = o.rep ?? [1 / set.tile[0], 1 / set.tile[1]];
    if (t.repeat.x === r[0] && t.repeat.y === r[1]) return t;
    const tt = t.clone();
    tt.repeat.set(r[0], r[1]);
    tt.needsUpdate = true;
    return tt;
  };
  const mat = o.physical
    ? new THREE.MeshPhysicalMaterial({ color: o.color ?? 0xffffff })
    : new THREE.MeshStandardMaterial({ color: o.color ?? 0xffffff });
  mat.map = cloneRep(set.map) ?? null;
  if (set.normal) {
    mat.normalMap = cloneRep(set.normal) ?? null;
    mat.normalScale.set(o.normalScale ?? 1, o.normalScale ?? 1);
  }
  if (set.orm) {
    const orm = cloneRep(set.orm)!;
    mat.roughnessMap = orm;
    mat.metalnessMap = orm;
    mat.roughness = o.roughness ?? 1;
    mat.metalness = o.metalness ?? 1;
  } else {
    mat.roughness = o.roughness ?? 0.85;
    mat.metalness = o.metalness ?? 0;
  }
  if (set.emissive) {
    mat.emissiveMap = cloneRep(set.emissive) ?? null;
    mat.emissive = new THREE.Color(o.emissive ?? 0xffffff);
    mat.emissiveIntensity = o.emissiveIntensity ?? 0;
  }
  if (o.side !== undefined) mat.side = o.side;
  if (o.macro) macroVariation(mat, o.macro);
  return mat;
}

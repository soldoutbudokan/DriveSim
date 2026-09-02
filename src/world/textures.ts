/**
 * Sign faces generated on canvases at runtime — Ontario-style signage
 * (MAXIMUM speed tabs, octagon STOP, school zones, green highway guides,
 * PXO, HOV, transit stops) and street-name blades. Surface texture sets
 * (asphalt, brick, facades…) live in materials.ts.
 */

import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function tex(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export type SignKind =
  | 'stop'
  | 'yield'
  | 'max'
  | 'school'
  | 'schoolMax'
  | 'construction'
  | 'constructionMax'
  | 'pxo'
  | 'guide401'
  | 'exit'
  | 'hov'
  | 'roundabout'
  | 'playground'
  | 'merge'
  | 'hill'
  | 'noParking'
  | 'deadEnd'
  | 'streetcarStop'
  | 'busStop'
  | 'driveTest';

const signCache = new Map<string, THREE.CanvasTexture>();

/** Ontario-style sign faces. Sized 256×256 (square) or 256×320 (tab signs). */
export function signTexture(kind: SignKind, text = ''): THREE.CanvasTexture {
  const key = `${kind}|${text}`;
  const hit = signCache.get(key);
  if (hit) return hit;

  const tall = kind === 'max' || kind === 'schoolMax' || kind === 'constructionMax';
  const [c, g] = canvas(256, tall ? 320 : 256);
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  const rounded = (x: number, y: number, w: number, h: number, r: number): void => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };

  switch (kind) {
    case 'stop': {
      g.fillStyle = '#b91c1c';
      g.beginPath();
      const r = 122;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const x = 128 + r * Math.cos(a);
        const y = 128 + r * Math.sin(a);
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = 10;
      g.stroke();
      g.fillStyle = '#fff';
      g.font = '800 78px system-ui';
      g.fillText('STOP', 128, 132);
      break;
    }
    case 'yield': {
      g.fillStyle = '#fff';
      g.beginPath();
      g.moveTo(10, 16);
      g.lineTo(246, 16);
      g.lineTo(128, 240);
      g.closePath();
      g.fill();
      g.strokeStyle = '#b91c1c';
      g.lineWidth = 30;
      g.stroke();
      break;
    }
    case 'max':
    case 'schoolMax':
    case 'constructionMax': {
      if (kind === 'constructionMax') {
        g.fillStyle = '#f97316';
        rounded(4, 4, 248, 312, 14);
        g.fill();
      }
      g.fillStyle = '#fff';
      rounded(12, 12, 232, 296, 10);
      g.fill();
      g.strokeStyle = '#111';
      g.lineWidth = 8;
      rounded(20, 20, 216, 280, 8);
      g.stroke();
      g.fillStyle = '#111';
      g.font = '700 44px system-ui';
      g.fillText('MAXIMUM', 128, 84);
      g.font = '800 130px system-ui';
      g.fillText(text || '50', 128, 200);
      if (kind === 'schoolMax') {
        g.font = '700 30px system-ui';
        g.fillText('WHEN CHILDREN', 128, 272);
        g.fillText('PRESENT', 128, 298);
      }
      break;
    }
    case 'school': {
      g.fillStyle = '#c6f211';
      g.beginPath();
      g.moveTo(128, 8);
      g.lineTo(244, 96);
      g.lineTo(244, 244);
      g.lineTo(12, 244);
      g.lineTo(12, 96);
      g.closePath();
      g.fill();
      g.strokeStyle = '#111';
      g.lineWidth = 8;
      g.stroke();
      g.fillStyle = '#111';
      // two walking figures
      for (const dx of [-26, 22]) {
        g.beginPath();
        g.arc(128 + dx, 96, 14, 0, Math.PI * 2);
        g.fill();
        g.fillRect(128 + dx - 9, 112, 18, 52);
        g.fillRect(128 + dx - 13, 164, 10, 48);
        g.fillRect(128 + dx + 4, 164, 10, 48);
      }
      break;
    }
    case 'construction': {
      g.translate(128, 128);
      g.rotate(Math.PI / 4);
      g.fillStyle = '#f97316';
      g.fillRect(-86, -86, 172, 172);
      g.strokeStyle = '#111';
      g.lineWidth = 8;
      g.strokeRect(-86, -86, 172, 172);
      g.rotate(-Math.PI / 4);
      g.fillStyle = '#111';
      // digging figure
      g.beginPath();
      g.arc(-14, -40, 13, 0, Math.PI * 2);
      g.fill();
      g.save();
      g.translate(-10, -10);
      g.rotate(0.5);
      g.fillRect(-8, -16, 16, 52);
      g.restore();
      g.save();
      g.rotate(-0.8);
      g.fillRect(-6, 10, 70, 9);
      g.restore();
      g.fillRect(-50, 42, 100, 9);
      break;
    }
    case 'pxo': {
      g.fillStyle = '#fff';
      rounded(4, 4, 248, 248, 10);
      g.fill();
      g.strokeStyle = '#111';
      g.lineWidth = 6;
      rounded(10, 10, 236, 236, 8);
      g.stroke();
      g.fillStyle = '#111';
      g.font = '800 34px system-ui';
      g.fillText('STOP FOR', 128, 50);
      g.fillText('PEDESTRIANS', 128, 88);
      g.beginPath();
      g.arc(128, 130, 16, 0, Math.PI * 2);
      g.fill();
      g.fillRect(116, 148, 24, 56);
      g.fillRect(108, 200, 14, 40);
      g.fillRect(134, 200, 14, 40);
      break;
    }
    case 'guide401': {
      g.fillStyle = '#047840';
      rounded(2, 28, 252, 200, 12);
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = 4;
      rounded(8, 34, 240, 188, 10);
      g.stroke();
      // crown shield
      g.fillStyle = '#fff';
      g.beginPath();
      g.moveTo(128, 52);
      g.quadraticCurveTo(168, 56, 172, 64);
      g.quadraticCurveTo(172, 118, 128, 132);
      g.quadraticCurveTo(84, 118, 84, 64);
      g.quadraticCurveTo(88, 56, 128, 52);
      g.fill();
      g.fillStyle = '#047840';
      g.font = '800 44px system-ui';
      g.fillText('401', 128, 92);
      g.fillStyle = '#fff';
      g.font = '700 40px system-ui';
      g.fillText(text || 'EAST', 128, 168);
      g.font = '700 30px system-ui';
      g.fillText('→', 128, 204);
      break;
    }
    case 'exit': {
      g.fillStyle = '#047840';
      rounded(2, 60, 252, 136, 10);
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = 4;
      rounded(8, 66, 240, 124, 8);
      g.stroke();
      g.fillStyle = '#fff';
      g.font = '800 46px system-ui';
      g.fillText(text || 'EXIT', 128, 106);
      g.font = '700 34px system-ui';
      g.fillText('McCaul Ave', 128, 156);
      break;
    }
    case 'hov': {
      g.fillStyle = '#fff';
      rounded(4, 4, 248, 248, 10);
      g.fill();
      g.strokeStyle = '#111';
      g.lineWidth = 6;
      rounded(10, 10, 236, 236, 8);
      g.stroke();
      g.strokeStyle = '#111';
      g.lineWidth = 9;
      g.beginPath();
      g.moveTo(128, 36);
      g.lineTo(176, 110);
      g.lineTo(128, 184);
      g.lineTo(80, 110);
      g.closePath();
      g.stroke();
      g.fillStyle = '#111';
      g.font = '800 30px system-ui';
      g.fillText('HOV 2+', 128, 222);
      break;
    }
    case 'roundabout': {
      g.fillStyle = '#fde047';
      g.translate(128, 128);
      g.rotate(Math.PI / 4);
      g.fillRect(-86, -86, 172, 172);
      g.strokeStyle = '#111';
      g.lineWidth = 8;
      g.strokeRect(-86, -86, 172, 172);
      g.rotate(-Math.PI / 4);
      g.strokeStyle = '#111';
      g.lineWidth = 10;
      g.beginPath();
      g.arc(0, 0, 46, 0.4, Math.PI * 2 - 0.6);
      g.stroke();
      g.beginPath();
      g.moveTo(52, -28);
      g.lineTo(30, -52);
      g.lineTo(62, -56);
      g.closePath();
      g.fill();
      break;
    }
    case 'playground': {
      g.fillStyle = '#fde047';
      g.translate(128, 128);
      g.rotate(Math.PI / 4);
      g.fillRect(-86, -86, 172, 172);
      g.strokeStyle = '#111';
      g.lineWidth = 8;
      g.strokeRect(-86, -86, 172, 172);
      g.rotate(-Math.PI / 4);
      g.fillStyle = '#111';
      g.font = '800 26px system-ui';
      g.fillText('PLAYGROUND', 0, 60);
      g.beginPath();
      g.arc(-20, -40, 12, 0, Math.PI * 2);
      g.fill();
      g.save();
      g.rotate(-0.5);
      g.fillRect(-26, -30, 9, 48);
      g.restore();
      g.fillRect(8, -52, 8, 76);
      g.fillRect(-44, 18, 60, 8);
      break;
    }
    case 'merge': {
      g.fillStyle = '#fde047';
      g.translate(128, 128);
      g.rotate(Math.PI / 4);
      g.fillRect(-86, -86, 172, 172);
      g.strokeStyle = '#111';
      g.lineWidth = 8;
      g.strokeRect(-86, -86, 172, 172);
      g.rotate(-Math.PI / 4);
      g.strokeStyle = '#111';
      g.lineWidth = 12;
      g.beginPath();
      g.moveTo(-6, 70);
      g.lineTo(-6, -60);
      g.moveTo(46, 70);
      g.quadraticCurveTo(40, 10, -2, -16);
      g.stroke();
      g.fillStyle = '#111';
      g.beginPath();
      g.moveTo(-6, -76);
      g.lineTo(-22, -44);
      g.lineTo(10, -44);
      g.closePath();
      g.fill();
      break;
    }
    case 'hill': {
      g.fillStyle = '#fde047';
      g.translate(128, 128);
      g.rotate(Math.PI / 4);
      g.fillRect(-86, -86, 172, 172);
      g.strokeStyle = '#111';
      g.lineWidth = 8;
      g.strokeRect(-86, -86, 172, 172);
      g.rotate(-Math.PI / 4);
      g.fillStyle = '#111';
      g.beginPath();
      g.moveTo(-70, 50);
      g.lineTo(70, 50);
      g.lineTo(70, -30);
      g.closePath();
      g.fill();
      g.font = '800 36px system-ui';
      g.fillText(text || '8%', -24, 22);
      break;
    }
    case 'noParking': {
      g.fillStyle = '#fff';
      rounded(4, 4, 248, 248, 10);
      g.fill();
      g.strokeStyle = '#111';
      g.lineWidth = 5;
      rounded(8, 8, 240, 240, 8);
      g.stroke();
      g.font = '800 120px system-ui';
      g.fillStyle = '#111';
      g.fillText('P', 128, 124);
      g.strokeStyle = '#b91c1c';
      g.lineWidth = 16;
      g.beginPath();
      g.arc(128, 120, 84, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(70, 62);
      g.lineTo(188, 180);
      g.stroke();
      break;
    }
    case 'deadEnd': {
      g.fillStyle = '#fde047';
      g.translate(128, 128);
      g.rotate(Math.PI / 4);
      g.fillRect(-86, -86, 172, 172);
      g.strokeStyle = '#111';
      g.lineWidth = 8;
      g.strokeRect(-86, -86, 172, 172);
      g.rotate(-Math.PI / 4);
      g.fillStyle = '#111';
      g.font = '800 34px system-ui';
      g.fillText('NO EXIT', 0, 4);
      break;
    }
    case 'streetcarStop': {
      g.fillStyle = '#fff';
      rounded(4, 4, 248, 248, 10);
      g.fill();
      g.strokeStyle = '#b91c1c';
      g.lineWidth = 8;
      rounded(10, 10, 236, 236, 8);
      g.stroke();
      g.fillStyle = '#b91c1c';
      g.font = '800 36px system-ui';
      g.fillText('501', 128, 60);
      g.fillStyle = '#111';
      g.fillRect(58, 90, 140, 70);
      g.fillStyle = '#fff';
      g.fillRect(66, 98, 124, 34);
      g.fillStyle = '#111';
      g.font = '700 28px system-ui';
      g.fillText('STREETCAR', 128, 196);
      g.fillText('STOP', 128, 226);
      break;
    }
    case 'busStop': {
      g.fillStyle = '#fff';
      rounded(4, 4, 248, 248, 10);
      g.fill();
      g.strokeStyle = '#111';
      g.lineWidth = 6;
      rounded(10, 10, 236, 236, 8);
      g.stroke();
      g.fillStyle = '#eab308';
      g.fillRect(58, 60, 140, 90);
      g.fillStyle = '#111';
      g.font = '700 30px system-ui';
      g.fillText('SCHOOL', 128, 190);
      g.fillText('BUS STOP', 128, 224);
      break;
    }
    case 'driveTest': {
      g.fillStyle = '#0c4a9e';
      rounded(2, 40, 252, 176, 12);
      g.fill();
      g.fillStyle = '#fff';
      g.font = '800 52px system-ui';
      g.fillText('DriveTest', 128, 108);
      g.font = '600 30px system-ui';
      g.fillText('Road Test Centre', 128, 168);
      break;
    }
  }

  const t = tex(c);
  signCache.set(key, t);
  return t;
}

/** Street-name blade. */
export function streetBladeTexture(name: string): THREE.CanvasTexture {
  const key = `blade|${name}`;
  const hit = signCache.get(key);
  if (hit) return hit;
  const [c, g] = canvas(512, 96);
  g.fillStyle = '#0d4f8b';
  g.fillRect(0, 0, 512, 96);
  g.strokeStyle = '#fff';
  g.lineWidth = 5;
  g.strokeRect(6, 6, 500, 84);
  g.fillStyle = '#fff';
  g.font = '700 52px system-ui';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(name, 256, 52);
  const t = tex(c);
  signCache.set(key, t);
  return t;
}

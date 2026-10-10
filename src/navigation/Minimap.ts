// The navigator's tablet screen: a heading-up road map rendered to a canvas
// texture, with the route, turn markers, current instruction and progress.

import * as THREE from 'three';
import { canvasTexture } from '../rendering/materials';
import type { NavInstruction } from '../shared/stage/pacenotes';
import type { CornerSeverity, StageData } from '../shared/types';

const W = 512;
const H = 384;
const CAR_Y = 268;

export interface MinimapState {
  x: number;
  z: number;
  heading: number;
  speed: number;
  idx: number;
  ins: NavInstruction | null;
  timeMs: number;
  checkpointsHit: number;
  checkpointsTotal: number;
  wrongWay: boolean;
  flash: { text: string; color: string; until: number } | null;
  banner: string | null;
  now: number;
}

export const SEVERITY_COLOR: Record<CornerSeverity, string> = {
  keep: '#5fb4ff',
  easy: '#7ed957',
  medium: '#ffd23f',
  hard: '#ff8a2a',
  hairpin: '#ff3b30',
};

const SEVERITY_ANGLE: Record<CornerSeverity, number> = {
  keep: 0.35,
  easy: 0.75,
  medium: 1.45,
  hard: 2.1,
  hairpin: 3.1,
};

export function drawTurnArrow(g: CanvasRenderingContext2D, x: number, y: number, size: number, dir: number, severity: CornerSeverity, color: string) {
  const total = SEVERITY_ANGLE[severity] * dir;
  const steps = 18;
  let hx = 0;
  let hy = -1;
  let px = x;
  let py = y + size * 0.5;
  const seg = (size * 1.25) / steps;
  g.save();
  g.strokeStyle = color;
  g.lineWidth = size * 0.17;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(px, py);
  let ang = -Math.PI / 2;
  for (let i = 0; i < steps; i++) {
    if (i > steps * 0.35) ang += total / (steps * 0.65);
    hx = Math.cos(ang);
    hy = Math.sin(ang);
    px += hx * seg * (severity === 'hairpin' ? 0.8 : 1);
    py += hy * seg * (severity === 'hairpin' ? 0.8 : 1);
    g.lineTo(px, py);
  }
  g.stroke();
  // arrowhead
  const ah = size * 0.36;
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(px + hx * ah * 0.7, py + hy * ah * 0.7);
  g.lineTo(px - hy * ah * 0.6, py + hx * ah * 0.6);
  g.lineTo(px + hy * ah * 0.6, py - hx * ah * 0.6);
  g.closePath();
  g.fill();
  g.restore();
}

export class Minimap {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private zoom = 1.4;

  constructor(private stage: StageData) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = canvasTexture(this.canvas);
  }

  draw(s: MinimapState) {
    const g = this.g;
    const st = this.stage;
    const targetZoom = Math.max(0.85, Math.min(1.8, 1.9 - s.speed / 26));
    this.zoom += (targetZoom - this.zoom) * 0.1;
    const ppm = this.zoom;

    // background
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#173322');
    bg.addColorStop(1, '#0d1f15');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    g.save();
    g.translate(W / 2, CAR_Y);
    g.rotate(-s.heading);
    g.scale(ppm, ppm);
    g.translate(-s.x, -s.z);

    // faint world grid
    g.strokeStyle = 'rgba(120,180,130,0.08)';
    g.lineWidth = 1 / ppm;
    const grid = 50;
    const gx0 = Math.floor((s.x - 400) / grid) * grid;
    const gz0 = Math.floor((s.z - 400) / grid) * grid;
    g.beginPath();
    for (let x = gx0; x < s.x + 400; x += grid) {
      g.moveTo(x, s.z - 400);
      g.lineTo(x, s.z + 400);
    }
    for (let z = gz0; z < s.z + 400; z += grid) {
      g.moveTo(s.x - 400, z);
      g.lineTo(s.x + 400, z);
    }
    g.stroke();

    const idx = Math.max(0, Math.floor(s.idx));
    const viewR = 360 / ppm;
    const from = 0;
    const to = st.count - 1;
    const path = (a: number, b: number) => {
      g.beginPath();
      let started = false;
      for (let i = a; i <= b; i++) {
        const dx = st.xs[i] - s.x;
        const dz = st.zs[i] - s.z;
        const near = dx * dx + dz * dz < viewR * viewR * 2;
        if (!near) {
          started = false;
          continue;
        }
        if (!started) {
          g.moveTo(st.xs[i], st.zs[i]);
          started = true;
        } else g.lineTo(st.xs[i], st.zs[i]);
      }
    };
    g.lineCap = 'round';
    g.lineJoin = 'round';
    path(from, to);
    g.strokeStyle = '#06100a';
    g.lineWidth = 15 / ppm;
    g.stroke();
    g.strokeStyle = '#8f8266';
    g.lineWidth = 10 / ppm;
    g.stroke();
    path(from, idx);
    g.strokeStyle = '#5c5446';
    g.lineWidth = 10 / ppm;
    g.stroke();
    const ahead = Math.min(st.finishIdx, idx + 380);
    path(idx, ahead);
    g.strokeStyle = '#ffb347';
    g.lineWidth = 4.5 / ppm;
    g.stroke();

    // puddles
    g.fillStyle = '#5a4127';
    for (const p of st.puddles) {
      if (p.idx < idx - 10 || p.idx > ahead) continue;
      g.beginPath();
      g.arc(p.x, p.z, Math.max(p.r, 3 / ppm), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // screen-space markers
    const toScreen = (wx: number, wz: number): [number, number] => {
      const dx = (wx - s.x) * ppm;
      const dz = (wz - s.z) * ppm;
      const c = Math.cos(-s.heading);
      const sn = Math.sin(-s.heading);
      return [W / 2 + dx * c - dz * sn, CAR_Y + dx * sn + dz * c];
    };
    const onScreen = (p: [number, number]) => p[0] > -20 && p[0] < W + 20 && p[1] > 70 && p[1] < H - 30;
    for (const c of st.corners) {
      if (c.exitIdx < idx || c.apexIdx > ahead) continue;
      const p = toScreen(st.xs[c.apexIdx], st.zs[c.apexIdx]);
      if (!onScreen(p)) continue;
      const col = SEVERITY_COLOR[c.severity];
      g.fillStyle = 'rgba(0,0,0,0.65)';
      g.beginPath();
      g.arc(p[0], p[1], 13, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = col;
      g.lineWidth = 2.5;
      g.stroke();
      drawTurnArrow(g, p[0], p[1] + 1, 15, c.dir, c.severity, col);
    }
    for (const cp of st.checkpoints) {
      if (cp.idx < idx - 5 || cp.idx > ahead) continue;
      const p = toScreen(st.xs[cp.idx], st.zs[cp.idx]);
      if (!onScreen(p)) continue;
      g.fillStyle = '#e8742b';
      g.fillRect(p[0] - 1, p[1] - 16, 3, 18);
      g.beginPath();
      g.moveTo(p[0] + 2, p[1] - 16);
      g.lineTo(p[0] + 14, p[1] - 11);
      g.lineTo(p[0] + 2, p[1] - 6);
      g.fill();
    }
    for (const j of st.jumps) {
      if (j.idx < idx - 5 || j.idx > ahead) continue;
      const p = toScreen(st.xs[j.idx], st.zs[j.idx]);
      if (!onScreen(p)) continue;
      g.fillStyle = '#ffe14d';
      g.beginPath();
      g.moveTo(p[0], p[1] - 10);
      g.lineTo(p[0] + 9, p[1] + 6);
      g.lineTo(p[0] - 9, p[1] + 6);
      g.closePath();
      g.fill();
      g.fillStyle = '#000';
      g.font = 'bold 10px Arial';
      g.textAlign = 'center';
      g.fillText('!', p[0], p[1] + 4);
    }
    {
      const p = toScreen(st.xs[st.finishIdx], st.zs[st.finishIdx]);
      if (onScreen(p)) {
        for (let a = 0; a < 3; a++)
          for (let b = 0; b < 3; b++) {
            g.fillStyle = (a + b) % 2 ? '#111' : '#fff';
            g.fillRect(p[0] - 9 + a * 6, p[1] - 9 + b * 6, 6, 6);
          }
      }
    }

    // the car
    g.save();
    g.translate(W / 2, CAR_Y);
    g.fillStyle = '#ff6a2b';
    g.strokeStyle = '#fff';
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(0, -14);
    g.lineTo(10, 11);
    g.lineTo(0, 5);
    g.lineTo(-10, 11);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();

    this.drawHud(s);
    // glare
    const glare = g.createLinearGradient(0, 0, W, H);
    glare.addColorStop(0, 'rgba(255,255,255,0.07)');
    glare.addColorStop(0.45, 'rgba(255,255,255,0.0)');
    glare.addColorStop(0.5, 'rgba(255,255,255,0.05)');
    glare.addColorStop(0.56, 'rgba(255,255,255,0.0)');
    g.fillStyle = glare;
    g.fillRect(0, 0, W, H);
    this.texture.needsUpdate = true;
  }

  private drawHud(s: MinimapState) {
    const g = this.g;
    const st = this.stage;
    // top instruction panel
    g.fillStyle = 'rgba(8,12,10,0.88)';
    g.fillRect(0, 0, W, 86);
    g.fillStyle = '#e8742b';
    g.fillRect(0, 84, W, 3);
    const ins = s.ins;
    if (s.banner) {
      g.fillStyle = '#fff';
      g.font = 'bold 34px Arial';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s.banner, W / 2, 44);
    } else if (ins) {
      const col = ins.corner ? SEVERITY_COLOR[ins.corner.severity] : '#ffffff';
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(8, 8, 70, 70);
      if (ins.corner) drawTurnArrow(g, 43, 45, 34, ins.corner.dir, ins.corner.severity, col);
      else {
        // straight / finish arrow
        g.strokeStyle = '#fff';
        g.lineWidth = 6;
        g.beginPath();
        g.moveTo(43, 66);
        g.lineTo(43, 22);
        g.stroke();
        g.fillStyle = '#fff';
        g.beginPath();
        g.moveTo(43, 14);
        g.lineTo(54, 30);
        g.lineTo(32, 30);
        g.fill();
      }
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.fillStyle = col;
      g.font = 'bold 32px Arial';
      g.fillText(ins.text, 90, 42);
      g.fillStyle = '#fff';
      g.font = 'bold 26px Arial';
      const dist = ins.distance <= 0 ? 'NOW!' : `${Math.max(0, Math.round(ins.distance / 5) * 5)} m`;
      g.fillText(dist, 90, 74);
      if (ins.straightFor) {
        g.fillStyle = '#9fd3a8';
        g.font = 'bold 15px Arial';
        g.fillText(`STRAIGHT FOR ${ins.straightFor}`, 200, 72);
      }
      if (ins.then) {
        g.textAlign = 'right';
        g.fillStyle = '#c9c9c9';
        g.font = 'bold 15px Arial';
        g.fillText(ins.then, W - 12, 26);
      }
      // warning pills
      let pillY = 44;
      const pill = (text: string, bgc: string, blink: boolean) => {
        if (blink && Math.floor(s.now / 220) % 2 === 0) return;
        g.textAlign = 'right';
        g.font = 'bold 18px Arial';
        const w = g.measureText(text).width + 18;
        g.fillStyle = bgc;
        g.fillRect(W - 10 - w, pillY - 14, w, 26);
        g.fillStyle = '#fff';
        g.fillText(text, W - 19, pillY + 6);
        pillY += 30;
      };
      if (ins.brakeNow) pill('BRAKE NOW!', '#d6281e', true);
      if (ins.jumpAhead !== null) pill(`JUMP ${Math.round(ins.jumpAhead / 10) * 10}m`, '#b8860b', false);
    }

    // status icons
    g.fillStyle = '#9adf9a';
    for (let i = 0; i < 4; i++) g.fillRect(W - 60 + i * 5, 80 - 4 - i * 2, 3, 4 + i * 2);

    // bottom progress bar
    g.fillStyle = 'rgba(8,12,10,0.88)';
    g.fillRect(0, H - 40, W, 40);
    const barX = 12;
    const barW = W - 200;
    const p = Math.max(0, Math.min(1, (s.idx - st.startIdx) / (st.finishIdx - st.startIdx)));
    g.fillStyle = '#333';
    g.fillRect(barX, H - 24, barW, 8);
    g.fillStyle = '#ffb347';
    g.fillRect(barX, H - 24, barW * p, 8);
    for (const cp of st.checkpoints) {
      const cx = barX + (barW * (cp.idx - st.startIdx)) / (st.finishIdx - st.startIdx);
      g.fillStyle = '#e8742b';
      g.fillRect(cx - 1, H - 30, 3, 20);
    }
    g.fillStyle = '#fff';
    g.fillRect(barX + barW * p - 2, H - 32, 4, 24);
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.font = 'bold 17px Arial';
    g.fillStyle = '#fff';
    const t = Math.max(0, s.timeMs) / 1000;
    const mm = Math.floor(t / 60);
    const ss = (t % 60).toFixed(1).padStart(4, '0');
    g.fillText(`${mm}:${ss}`, W - 104, H - 20);
    g.fillStyle = '#ffb347';
    g.fillText(`CP ${s.checkpointsHit}/${s.checkpointsTotal}`, W - 12, H - 20);
    g.fillStyle = '#9fd3a8';
    g.textAlign = 'left';
    g.font = 'bold 13px Arial';
    g.fillText(`${Math.round(s.speed * 3.6)} km/h`, barX + barW + 8, H - 20);

    if (s.wrongWay && Math.floor(s.now / 300) % 2 === 0) {
      g.fillStyle = 'rgba(214,40,30,0.85)';
      g.fillRect(0, 150, W, 60);
      g.fillStyle = '#fff';
      g.font = 'bold 40px Arial';
      g.textAlign = 'center';
      g.fillText('WRONG WAY!', W / 2, 180);
    } else if (s.flash && s.now < s.flash.until) {
      g.fillStyle = s.flash.color;
      g.fillRect(0, 150, W, 60);
      g.fillStyle = '#fff';
      g.font = 'bold 36px Arial';
      g.textAlign = 'center';
      g.fillText(s.flash.text, W / 2, 180);
    }
  }

  dispose() {
    this.texture.dispose();
  }
}

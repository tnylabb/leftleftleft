// Analogue instrument cluster drawn on a canvas texture.

import * as THREE from 'three';
import { canvasTexture } from '../rendering/materials';

export interface GaugeState {
  speedKmh: number;
  rpm: number;
  gear: number;
  handbrake: boolean;
  doorOpen: boolean;
  wipers: boolean;
  shifting: boolean;
}

export class Gauges {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private acc = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 320;
    this.canvas.height = 140;
    this.g = this.canvas.getContext('2d')!;
    this.texture = canvasTexture(this.canvas);
    this.draw({ speedKmh: 0, rpm: 900, gear: 1, handbrake: true, doorOpen: false, wipers: false, shifting: false });
  }

  update(dt: number, s: GaugeState) {
    this.acc += dt;
    if (this.acc < 1 / 24) return;
    this.acc = 0;
    this.draw(s);
  }

  private dial(cx: number, cy: number, r: number, frac: number, ticks: number, labels: string[], redFrom: number) {
    const g = this.g;
    g.fillStyle = '#121212';
    g.beginPath();
    g.arc(cx, cy, r + 6, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#5a5a5a';
    g.lineWidth = 3;
    g.stroke();
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    for (let i = 0; i <= ticks; i++) {
      const t = i / ticks;
      const a = a0 + (a1 - a0) * t;
      g.strokeStyle = t >= redFrom ? '#e0412c' : '#e8e2d0';
      g.lineWidth = i % 2 === 0 ? 3 : 1.5;
      const r0 = i % 2 === 0 ? r - 12 : r - 7;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.stroke();
    }
    g.fillStyle = '#d8d2c0';
    g.font = 'bold 11px Arial';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    labels.forEach((l, i) => {
      const a = a0 + ((a1 - a0) * i) / (labels.length - 1);
      g.fillText(l, cx + Math.cos(a) * (r - 22), cy + Math.sin(a) * (r - 22));
    });
    const a = a0 + (a1 - a0) * Math.max(0, Math.min(1.02, frac));
    g.strokeStyle = '#ff7a2f';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx - Math.cos(a) * 8, cy - Math.sin(a) * 8);
    g.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
    g.stroke();
    g.fillStyle = '#333';
    g.beginPath();
    g.arc(cx, cy, 7, 0, Math.PI * 2);
    g.fill();
  }

  private draw(s: GaugeState) {
    const g = this.g;
    g.fillStyle = '#0b0b0c';
    g.fillRect(0, 0, 320, 140);
    this.dial(80, 72, 58, s.speedKmh / 180, 18, ['0', '40', '80', '120', '160'], 2);
    this.dial(240, 72, 58, s.rpm / 8000, 16, ['0', '2', '4', '6', '8'], 0.82);
    // gear indicator
    g.fillStyle = '#1d1d1d';
    g.fillRect(140, 46, 40, 44);
    g.fillStyle = s.shifting ? '#777' : '#ffb347';
    g.font = 'bold 30px Arial';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s.gear === -1 ? 'R' : s.gear === 0 ? 'N' : String(s.gear), 160, 69);
    // warning lights
    const light = (x: number, on: boolean, color: string, label: string) => {
      g.fillStyle = on ? color : '#262626';
      g.beginPath();
      g.arc(x, 122, 7, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = on ? '#fff' : '#555';
      g.font = 'bold 8px Arial';
      g.fillText(label, x, 122);
    };
    light(136, s.handbrake, '#e0412c', 'P');
    light(160, s.doorOpen, '#e0a12c', 'D');
    light(184, s.wipers, '#3aa0e0', 'W');
    g.fillStyle = '#d8d2c0';
    g.font = 'bold 13px Arial';
    g.fillText(String(Math.round(s.speedKmh)), 80, 108);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}

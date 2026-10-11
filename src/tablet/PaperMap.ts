// Backup paper rally map from the glovebox. Its print is generated from the
// real stage: north-up route, numbered corners by severity, checkpoints, start,
// finish, jumps, puddles and hay bales, over simple contour shading. Unlike the
// tablet it shows no position - the navigator has to orient it and follow along.

import * as THREE from 'three';
import { canvasTexture } from '../rendering/materials';
import { setLayer } from '../rendering/geometry';
import { LAYER } from '../rendering/layers';
import { createTerrainBase } from '../shared/stage/terrainBase';
import type { CornerSeverity, StageData } from '../shared/types';
import { MAP_SPEC } from './cabinObjects';

const SEV_COLOR: Record<CornerSeverity, string> = {
  keep: '#2f6fb3',
  easy: '#2f8f46',
  medium: '#c79a12',
  hard: '#d4621f',
  hairpin: '#c2261b',
};
const SEV_CODE: Record<CornerSeverity, string> = { keep: 'K', easy: 'E', medium: '', hard: 'H', hairpin: 'U' };

function drawMap(stage: StageData): HTMLCanvasElement {
  const W = 1024;
  const H = 717;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  // paper
  g.fillStyle = '#efe5cc';
  g.fillRect(0, 0, W, H);

  // fit the route north-up (world -Z = up)
  const b = stage.bounds;
  const margin = 70;
  const sx = (W - margin * 2) / Math.max(1, b.maxX - b.minX);
  const sz = (H - margin * 2 - 40) / Math.max(1, b.maxZ - b.minZ);
  const s = Math.min(sx, sz);
  const ox = (W - (b.maxX - b.minX) * s) / 2;
  const oz = 40 + (H - 40 - (b.maxZ - b.minZ) * s) / 2;
  const px = (x: number) => ox + (x - b.minX) * s;
  const pz = (z: number) => oz + (z - b.minZ) * s;

  // contour shading from the same terrain the stage is built on
  const base = createTerrainBase(stage.params.seed);
  const cell = 12;
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const band = (i: number, j: number) => {
    const wx = b.minX + (i * cell - ox) / s;
    const wz = b.minZ + (j * cell - oz) / s;
    return Math.floor(base(wx, wz) / 4);
  };
  const bands: number[][] = [];
  for (let j = 0; j <= rows; j++) {
    bands.push([]);
    for (let i = 0; i <= cols; i++) bands[j].push(band(i, j));
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const v = bands[j][i];
      const t = Math.max(0, Math.min(1, (v + 6) / 12));
      g.fillStyle = `rgb(${Math.round(214 + t * 22)},${Math.round(224 - t * 18)},${Math.round(180 - t * 30)})`;
      g.fillRect(i * cell, j * cell, cell + 1, cell + 1);
    }
  }
  g.strokeStyle = 'rgba(140,110,70,0.45)';
  g.lineWidth = 1;
  g.beginPath();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (bands[j][i] !== bands[j][i + 1]) {
        g.moveTo((i + 1) * cell, j * cell);
        g.lineTo((i + 1) * cell, (j + 1) * cell);
      }
      if (bands[j][i] !== bands[j + 1][i]) {
        g.moveTo(i * cell, (j + 1) * cell);
        g.lineTo((i + 1) * cell, (j + 1) * cell);
      }
    }
  }
  g.stroke();

  // the route
  const path = () => {
    g.beginPath();
    g.moveTo(px(stage.xs[0]), pz(stage.zs[0]));
    for (let i = 1; i < stage.count; i++) g.lineTo(px(stage.xs[i]), pz(stage.zs[i]));
  };
  g.lineCap = 'round';
  g.lineJoin = 'round';
  path();
  g.strokeStyle = '#fbf6e8';
  g.lineWidth = 9;
  g.stroke();
  path();
  g.strokeStyle = '#5a3d22';
  g.lineWidth = 4;
  g.stroke();

  // landmarks: puddles and hay bales
  for (const p of stage.puddles) {
    g.fillStyle = '#6b5130';
    g.beginPath();
    g.arc(px(p.x), pz(p.z), 4, 0, Math.PI * 2);
    g.fill();
  }
  for (const bale of stage.bales) {
    g.fillStyle = '#d8a93a';
    g.fillRect(px(bale.x) - 3, pz(bale.z) - 3, 6, 6);
  }
  // jumps
  for (const j of stage.jumps) {
    const x = px(stage.xs[j.idx]);
    const y = pz(stage.zs[j.idx]);
    g.fillStyle = '#1b1b1b';
    g.beginPath();
    g.moveTo(x, y - 9);
    g.lineTo(x + 8, y + 5);
    g.lineTo(x - 8, y + 5);
    g.closePath();
    g.fill();
    g.font = 'bold 11px Arial';
    g.fillText('JUMP', x + 9, y - 2);
  }
  // corners: numbered in order, coloured and coded by severity, offset outwards
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let n = 0;
  for (const corner of stage.corners) {
    if (corner.severity === 'keep') continue;
    n++;
    const i = corner.apexIdx;
    const h = stage.headings[i];
    const off = -corner.dir * 16; // outside of the bend
    const x = px(stage.xs[i] + Math.cos(h) * off / s);
    const y = pz(stage.zs[i] + Math.sin(h) * off / s);
    g.fillStyle = SEV_COLOR[corner.severity];
    g.beginPath();
    g.arc(x, y, 10, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 11px Arial';
    g.fillText(String(n), x, y + 0.5);
    g.fillStyle = SEV_COLOR[corner.severity];
    g.font = 'bold 10px Arial';
    g.fillText(`${SEV_CODE[corner.severity]}${corner.dir < 0 ? 'L' : 'R'}`, x, y + 17);
  }
  // checkpoints
  for (const cp of stage.checkpoints) {
    const x = px(stage.xs[cp.idx]);
    const y = pz(stage.zs[cp.idx]);
    g.fillStyle = '#c2261b';
    g.fillRect(x - 1, y - 20, 3, 20);
    g.beginPath();
    g.moveTo(x + 2, y - 20);
    g.lineTo(x + 16, y - 15);
    g.lineTo(x + 2, y - 10);
    g.fill();
    g.fillStyle = '#1b1b1b';
    g.font = 'bold 12px Arial';
    g.fillText(`CP${cp.index + 1}`, x + 14, y + 6);
  }
  // start / finish
  const sx0 = px(stage.xs[stage.startIdx]);
  const sz0 = pz(stage.zs[stage.startIdx]);
  g.fillStyle = '#2f8f46';
  g.beginPath();
  g.arc(sx0, sz0, 12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 13px Arial';
  g.fillText('S', sx0, sz0 + 1);
  const fx = px(stage.xs[stage.finishIdx]);
  const fz = pz(stage.zs[stage.finishIdx]);
  for (let a = 0; a < 4; a++)
    for (let k = 0; k < 4; k++) {
      g.fillStyle = (a + k) % 2 ? '#111' : '#fff';
      g.fillRect(fx - 12 + a * 6, fz - 12 + k * 6, 6, 6);
    }

  // title, north arrow, scale, legend
  g.fillStyle = 'rgba(27,27,27,0.9)';
  g.fillRect(0, 0, W, 34);
  g.fillStyle = '#f2c230';
  g.font = 'italic 900 22px "Arial Black", Arial';
  g.textAlign = 'left';
  g.fillText('RALLY STAGE MAP', 14, 18);
  g.fillStyle = '#efe5cc';
  g.font = 'bold 14px Arial';
  g.fillText(`STAGE ${stage.params.seed} · ${(stage.totalLength / 1000).toFixed(1)} KM · ${stage.params.night ? 'NIGHT' : 'DAY'}`, 250, 18);
  g.save();
  g.translate(W - 46, 80);
  g.fillStyle = '#1b1b1b';
  g.beginPath();
  g.moveTo(0, -24);
  g.lineTo(10, 10);
  g.lineTo(0, 3);
  g.lineTo(-10, 10);
  g.closePath();
  g.fill();
  g.font = 'bold 16px Arial';
  g.textAlign = 'center';
  g.fillText('N', 0, 26);
  g.restore();
  const meters = 100;
  g.fillStyle = '#1b1b1b';
  g.fillRect(20, H - 26, meters * s, 5);
  g.font = 'bold 12px Arial';
  g.textAlign = 'left';
  g.fillText(`${meters} m`, 24 + meters * s, H - 22);
  const legend: [string, string][] = [['U', 'hairpin'], ['H', 'hard'], ['', 'medium'], ['E', 'easy']];
  let lx = W - 380;
  for (const [code, name] of legend) {
    const sev = (Object.keys(SEV_CODE) as CornerSeverity[]).find((k) => SEV_CODE[k] === code && k !== 'keep') ?? 'medium';
    g.fillStyle = SEV_COLOR[sev];
    g.beginPath();
    g.arc(lx, H - 22, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1b1b1b';
    g.fillText(`${code || '·'} ${name}`, lx + 10, H - 22);
    lx += 90;
  }
  // fold creases
  g.strokeStyle = 'rgba(90,70,40,0.25)';
  g.lineWidth = 2;
  for (const t of [0.25, 0.5, 0.75]) {
    g.beginPath();
    g.moveTo(W * t, 34);
    g.lineTo(W * t, H);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(0, H / 2);
  g.lineTo(W, H / 2);
  g.stroke();
  return c;
}

function drawCover(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 372;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e8742b';
  g.fillRect(0, 0, 256, 372);
  g.fillStyle = '#1b1b1b';
  for (let y = 0; y < 372; y += 46) g.fillRect(0, y, 256, 8);
  g.fillStyle = '#efe5cc';
  g.fillRect(24, 120, 208, 130);
  g.fillStyle = '#1b1b1b';
  g.font = 'italic 900 34px "Arial Black", Arial';
  g.textAlign = 'center';
  g.fillText('RALLY', 128, 170);
  g.fillText('MAP', 128, 212);
  g.font = 'bold 14px Arial';
  g.fillText('ROUTE BOOK · DO NOT LOSE', 128, 238);
  return c;
}

export class PaperMap {
  readonly group = new THREE.Group();
  private sheet: THREE.Group;
  private booklet: THREE.Mesh;
  private textures: THREE.Texture[] = [];
  private materials: THREE.Material[] = [];
  /** 0 = folded, 1 = fully open. */
  fold = 0;
  private target = 0;

  constructor(stage: StageData) {
    const mapTex = canvasTexture(drawMap(stage));
    const coverTex = canvasTexture(drawCover());
    this.textures.push(mapTex, coverTex);
    const o = MAP_SPEC.open;
    // open sheet: accordion panels with low-poly creases
    const front = new THREE.PlaneGeometry(o.hx * 2, o.hz * 2, 4, 2);
    front.rotateX(-Math.PI / 2);
    const pos = front.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const col = Math.round(((pos.getX(i) + o.hx) / (o.hx * 2)) * 4);
      const row = Math.round(((pos.getZ(i) + o.hz) / (o.hz * 2)) * 2);
      pos.setY(i, (col % 2 === 0 ? 0.004 : -0.004) + (row === 1 ? 0.003 : 0));
    }
    front.computeVertexNormals();
    const paper = new THREE.MeshLambertMaterial({ map: mapTex, flatShading: true });
    const back = new THREE.MeshLambertMaterial({ color: 0xe6dbbf, flatShading: true, side: THREE.BackSide });
    this.materials.push(paper, back);
    this.sheet = new THREE.Group();
    this.sheet.add(new THREE.Mesh(front, paper), new THREE.Mesh(front, back));
    this.group.add(this.sheet);
    // folded booklet
    const f = MAP_SPEC.folded;
    const coverMat = new THREE.MeshLambertMaterial({ map: coverTex });
    const edge = new THREE.MeshLambertMaterial({ color: 0xe6dbbf });
    this.materials.push(coverMat, edge);
    this.booklet = new THREE.Mesh(new THREE.BoxGeometry(f.hx * 2, f.hy * 2, f.hz * 2), [edge, edge, coverMat, coverMat, edge, edge]);
    this.group.add(this.booklet);
    setLayer(this.group, LAYER.COCKPIT);
    this.group.traverse((m) => {
      if ((m as THREE.Mesh).isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    this.apply();
  }

  setOpen(open: boolean) {
    this.target = open ? 1 : 0;
  }

  get opening(): boolean {
    return this.target === 1;
  }

  /** Animates folding; returns the current fold amount. `fold` can also be set directly (remote). */
  update(dt: number): number {
    const step = dt * 2.6;
    this.fold += Math.max(-step, Math.min(step, this.target - this.fold));
    this.apply();
    return this.fold;
  }

  setFold(f: number) {
    this.fold = f;
    this.target = f > 0.5 ? 1 : 0;
    this.apply();
  }

  private apply() {
    const t = this.fold;
    const open = t > 0.12;
    this.sheet.visible = open;
    this.booklet.visible = !open;
    if (open) {
      const e = t * t * (3 - 2 * t);
      this.sheet.scale.set(0.33 + 0.67 * e, 1, 0.69 + 0.31 * e);
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
  }
}

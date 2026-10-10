// Mud on the windscreen: procedural splats painted into a canvas texture,
// cleared by the animated wipers (inside their arcs) and by hand-wiping.

import * as THREE from 'three';
import { canvasTexture } from '../rendering/materials';
import { Rng } from '../shared/rng';
import type { MudFx } from '../shared/types';
import { LAYOUT } from './layout';

const W = 512;
const H = 300;

interface Wiper {
  px: number;
  py: number;
  len: number;
  angle: number;
  prevAngle: number;
  arm: THREE.Mesh;
}

export interface WindshieldEvents {
  wiperEnd(): void;
}

export class Windshield {
  readonly mesh: THREE.Mesh;
  readonly group = new THREE.Group();
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  private dirty = true;
  private uploadTimer = 0;
  private wipers: Wiper[] = [];
  private phase = 0;
  private running = false;
  private stopping = false;
  /** Fraction of the glass covered by mud (measured from the canvas). */
  coverage = 0;

  constructor(private events: WindshieldEvents) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = canvasTexture(this.canvas);
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;

    // subdivided trapezoid matching the windshield glass, nudged outwards
    const w = LAYOUT.windshield;
    const normal = new THREE.Vector3().subVectors(w.br, w.bl).cross(new THREE.Vector3().subVectors(w.tl, w.bl)).normalize();
    const out = normal.clone().multiplyScalar(-0.006);
    const geo = new THREE.PlaneGeometry(1, 1, 6, 6);
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      this.uvToLocal(uv.getX(i), uv.getY(i), p).add(out);
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    geo.computeVertexNormals();
    this.mesh = new THREE.Mesh(
      geo,
      // unlit: the glass faces down/inwards, so lit shading would turn the mud black
      new THREE.MeshBasicMaterial({ map: this.texture, color: 0xc8c0b4, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);

    const armMat = new THREE.MeshLambertMaterial({ color: 0x151515, flatShading: true });
    for (const [px, len] of [[0.17, 0.43], [0.58, 0.43]] as const) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.014, 1, 0.012).translate(0, 0.5, 0), armMat);
      arm.renderOrder = 3;
      this.group.add(arm);
      this.wipers.push({ px: px * W, py: H - 6, len: len * W, angle: 0.07, prevAngle: 0.07, arm });
    }
    this.clear();
  }

  /** Bilinear map from windshield UV to car-local position. */
  uvToLocal(u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
    const w = LAYOUT.windshield;
    const bottom = new THREE.Vector3().lerpVectors(w.bl, w.br, u);
    const top = new THREE.Vector3().lerpVectors(w.tl, w.tr, u);
    return out.lerpVectors(bottom, top, v);
  }

  clear() {
    this.g.clearRect(0, 0, W, H);
    this.coverage = 0;
    this.dirty = true;
  }

  /** Deterministic splat so both players see the same mud. */
  splat(fx: MudFx) {
    const rng = new Rng(fx.seed);
    const g = this.g;
    g.globalCompositeOperation = 'source-over';
    const blob = (x: number, y: number, r: number, color: string) => {
      g.fillStyle = color;
      g.beginPath();
      const n = 9;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rr = r * (0.65 + rng.next() * 0.55);
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr * 0.8;
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.closePath();
      g.fill();
    };
    const mud = () => `rgba(${70 + rng.int(-12, 18)},${52 + rng.int(-10, 12)},${32 + rng.int(-8, 8)},${(0.86 + rng.next() * 0.12).toFixed(2)})`;
    if (fx.kind === 'dirt') {
      const n = 16 + Math.floor(fx.amount * 60);
      for (let i = 0; i < n; i++) blob(rng.range(0, W), rng.range(H * 0.3, H), rng.range(2, 7), mud());
    } else {
      const n = 3 + Math.floor(fx.amount * (fx.kind === 'puddle' ? 8 : 5));
      for (let i = 0; i < n; i++) {
        const x = rng.range(-20, W + 20);
        const y = fx.kind === 'puddle' ? rng.range(H * 0.25, H + 10) : rng.range(-10, H + 10);
        const r = rng.range(36, 82) * (0.6 + fx.amount * 0.6);
        for (let k = 0; k < 5; k++) blob(x + rng.range(-r, r) * 0.6, y + rng.range(-r, r) * 0.5, r * rng.range(0.35, 0.8), mud());
        // airflow pushes streaks up the glass
        for (let k = 0; k < 3; k++) {
          const sx = x + rng.range(-r, r) * 0.6;
          g.fillStyle = mud();
          g.beginPath();
          g.ellipse(sx, y - r * 0.9, rng.range(3, 8), r * rng.range(0.5, 1.1), 0, 0, Math.PI * 2);
          g.fill();
        }
        // a few lighter dried specks
        for (let k = 0; k < 6; k++) blob(x + rng.range(-r, r), y + rng.range(-r, r) * 0.6, rng.range(2, 6), 'rgba(140,112,78,0.9)');
      }
    }
    this.dirty = true;
  }

  /** Hand-wipe at a UV position (driver cloth). */
  wipeAt(u: number, v: number, strength = 0.4) {
    const g = this.g;
    g.globalCompositeOperation = 'destination-out';
    const x = u * W;
    const y = (1 - v) * H;
    const grad = g.createRadialGradient(x, y, 6, x, y, 46);
    grad.addColorStop(0, `rgba(0,0,0,${strength})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - 50, y - 50, 100, 100);
    g.globalCompositeOperation = 'source-over';
    this.dirty = true;
  }

  setWipers(on: boolean) {
    if (on) {
      this.running = true;
      this.stopping = false;
    } else if (this.running) this.stopping = true;
  }

  get wipersActive(): boolean {
    return this.running;
  }

  update(dt: number) {
    if (this.running) {
      const prev = this.phase;
      this.phase += dt / 1.15;
      if (Math.floor(this.phase * 2) !== Math.floor(prev * 2)) this.events.wiperEnd();
      if (this.stopping && Math.floor(this.phase) !== Math.floor(prev)) {
        this.running = false;
        this.stopping = false;
        this.phase = 0;
      }
    }
    const t = this.running ? (1 - Math.cos(this.phase * Math.PI * 2)) / 2 : 0;
    const g = this.g;
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (const w of this.wipers) {
      w.prevAngle = w.angle;
      w.angle = 0.07 + t * 2.45;
      if (Math.abs(w.angle - w.prevAngle) > 1e-4) {
        // clear a wedge between the previous and current blade positions
        g.globalCompositeOperation = 'destination-out';
        g.fillStyle = 'rgba(0,0,0,0.75)';
        g.beginPath();
        const a0 = -Math.max(w.angle, w.prevAngle) - 0.02;
        const a1 = -Math.min(w.angle, w.prevAngle) + 0.02;
        g.arc(w.px, w.py, w.len, a0, a1);
        g.arc(w.px, w.py, w.len * 0.16, a1, a0, true);
        g.closePath();
        g.fill();
        g.globalCompositeOperation = 'source-over';
        this.dirty = true;
      }
      // place the blade in 3D on the glass
      const tipX = w.px + Math.cos(w.angle) * w.len;
      const tipY = w.py - Math.sin(w.angle) * w.len;
      this.uvToLocal(w.px / W, 1 - w.py / H, p);
      this.uvToLocal(tipX / W, 1 - tipY / H, q);
      const out = new THREE.Vector3(0, 0.77, -0.64).multiplyScalar(0.012);
      p.add(out);
      q.add(out);
      w.arm.position.copy(p);
      w.arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), q.clone().sub(p).normalize());
      w.arm.scale.set(1, p.distanceTo(q), 1);
    }
    this.uploadTimer -= dt;
    if (this.dirty && this.uploadTimer <= 0) {
      this.texture.needsUpdate = true;
      this.dirty = false;
      this.uploadTimer = 1 / 30;
      this.coverageDirty = true;
    }
    this.measureTimer -= dt;
    if (this.coverageDirty && this.measureTimer <= 0) this.measureCoverage();
  }

  private measureTimer = 0;
  private coverageDirty = false;
  private probe: CanvasRenderingContext2D | null = null;

  /** Measures how much of the glass is covered (downsampled alpha), at most twice a second. */
  private measureCoverage() {
    this.measureTimer = 0.5;
    this.coverageDirty = false;
    if (!this.probe) {
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 19;
      this.probe = c.getContext('2d', { willReadFrequently: true });
      if (!this.probe) return;
    }
    const p = this.probe;
    p.clearRect(0, 0, 32, 19);
    p.drawImage(this.canvas, 0, 0, 32, 19);
    const d = p.getImageData(0, 0, 32, 19).data;
    let covered = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 110) covered++;
    this.coverage = covered / (32 * 19);
  }

  dispose() {
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    for (const w of this.wipers) w.arm.geometry.dispose();
    this.texture.dispose();
  }
}

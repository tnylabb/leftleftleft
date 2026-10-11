// Gravel road ribbon (render mesh + identical trimesh collider) with camber,
// crown, bumps, potholes, wheel tracks and mud puddles.

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { vertexColored } from '../rendering/materials';
import { ROAD_HALF_WIDTH } from '../shared/constants';
import { clamp } from '../shared/math';
import { Noise2D, Rng, hash2 } from '../shared/rng';
import type { StageData } from '../shared/types';

const HW = ROAD_HALF_WIDTH;
const COLS = 9;
/** Lateral positions of the ribbon's vertex columns for a road half width `hw`. */
const laterals = (hw: number) => [-(hw + 0.7), -hw, -hw * 0.55, -0.95, 0, 0.95, hw * 0.55, hw, hw + 0.7];

const C = {
  gravelA: new THREE.Color(0x9e8866),
  gravelB: new THREE.Color(0x8b7556),
  track: new THREE.Color(0x76624a),
  ridge: new THREE.Color(0xab9776),
  verge: new THREE.Color(0x6f6c42),
};

export class Road {
  readonly group = new THREE.Group();
  private collider: RAPIER.Collider | null = null;
  readonly puddleMeshes: THREE.Mesh[] = [];
  private noise: Noise2D;
  private potholes: { i: number; l: number; r: number; d: number }[] = [];

  constructor(
    private stage: StageData,
    private physics: PhysicsWorld | null,
  ) {
    this.noise = new Noise2D(hash2(stage.params.seed, 555));
    const rng = new Rng(hash2(stage.params.seed, 556));
    for (let i = 40; i < stage.count - 20; i++) {
      if (rng.chance(0.035) && !stage.jumps.some((j) => Math.abs(j.idx - i) < 10)) {
        this.potholes.push({ i, l: rng.range(-HW + 0.6, HW - 0.6), r: rng.range(0.4, 0.8), d: rng.range(0.05, 0.09) });
      }
    }
    this.build();
    this.buildPuddles();
  }

  /** Road surface height offset (camber, crown, bumps, potholes) relative to the centreline. */
  private surfaceOffset(i: number, l: number): number {
    const s = this.stage;
    const k = s.curvature[i];
    const bank = clamp(-k * 2.4, -0.055, 0.055);
    const hw = s.halfWidths[i];
    let y = bank * l - 0.05 * (l / hw) * (l / hw);
    y += this.noise.noise(i * 0.42, l * 0.9) * 0.03 + this.noise.noise(i * 1.7 + 50, l * 2.3) * 0.012;
    for (const p of this.potholes) {
      const di = (i - p.i) * 2;
      if (Math.abs(di) > 2) continue;
      const d = Math.hypot(di, l - p.l);
      if (d < p.r) y -= p.d * (1 - d / p.r);
    }
    return y;
  }

  private build() {
    const s = this.stage;
    const cols = COLS;
    const verts = new Float32Array(s.count * cols * 3);
    for (let i = 0; i < s.count; i++) {
      const h = s.headings[i];
      const rx = Math.cos(h);
      const rz = Math.sin(h);
      const lats = laterals(s.halfWidths[i]);
      for (let c = 0; c < cols; c++) {
        const l = lats[c];
        const outer = c === 0 || c === cols - 1;
        const y = s.ys[i] + (outer ? -0.42 : this.surfaceOffset(i, l));
        const k = (i * cols + c) * 3;
        verts[k] = s.xs[i] + rx * l;
        verts[k + 1] = y;
        verts[k + 2] = s.zs[i] + rz * l;
      }
    }
    const indices: number[] = [];
    for (let i = 0; i < s.count - 1; i++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = i * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        // the road runs along -Z for heading 0 with lateral +X: (a, b, d) faces up
        indices.push(a, b, d, b, e, d);
      }
    }

    const pos: number[] = [];
    const col: number[] = [];
    const rng = new Rng(hash2(s.params.seed, 557));
    const tmp = new THREE.Color();
    for (let t = 0; t < indices.length; t += 3) {
      const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
      const ci = Math.floor(ia / cols);
      const cc = Math.min(ia % cols, ib % cols, ic % cols);
      const hw = s.halfWidths[ci];
      const lats = laterals(hw);
      const lMid = (lats[cc] + lats[Math.min(cols - 1, cc + 1)]) / 2;
      const al = Math.abs(lMid);
      if (al > hw) tmp.copy(C.verge);
      else if (al > 0.55 && al < 1.5) tmp.copy(C.track);
      else if (al < 0.5) tmp.copy(C.ridge);
      else tmp.copy(C.gravelA).lerp(C.gravelB, (this.noise.noise(ci * 0.1, lMid) + 1) / 2);
      tmp.multiplyScalar(0.94 + rng.next() * 0.1);
      for (const k of [ia, ib, ic]) {
        pos.push(verts[k * 3], verts[k * 3 + 1], verts[k * 3 + 2]);
        col.push(tmp.r, tmp.g, tmp.b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    // split into a few meshes for frustum culling
    const mesh = new THREE.Mesh(geo, vertexColored());
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);

    if (this.physics) {
      const desc = RAPIER.ColliderDesc.trimesh(verts, new Uint32Array(indices), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
        .setFriction(0.8)
        .setRestitution(0.02);
      this.collider = this.physics.addStatic(desc, 'road');
    }
  }

  private buildPuddles() {
    const mat = new THREE.MeshLambertMaterial({ color: 0x4a3a28, flatShading: true });
    const shine = new THREE.MeshBasicMaterial({ color: 0x8fa3a8, transparent: true, opacity: 0.35 });
    for (const p of this.stage.puddles) {
      const geo = new THREE.CircleGeometry(p.r, 9);
      geo.rotateX(-Math.PI / 2);
      const pa = geo.getAttribute('position');
      const rng = new Rng(Math.round(p.x * 100 + p.z));
      for (let v = 1; v < pa.count; v++) {
        const f = 0.75 + rng.next() * 0.45;
        pa.setX(v, pa.getX(v) * f);
        pa.setZ(v, pa.getZ(v) * f);
      }
      const m = new THREE.Mesh(geo, mat);
      const lat = this.lateralOf(p.idx, p.x, p.z);
      m.position.set(p.x, this.stage.ys[p.idx] + this.surfaceOffset(p.idx, lat) + 0.035, p.z);
      m.rotation.y = rng.next() * 3;
      m.receiveShadow = true;
      const s = new THREE.Mesh(new THREE.CircleGeometry(p.r * 0.45, 6).rotateX(-Math.PI / 2), shine);
      s.position.set(p.r * 0.2, 0.005, -p.r * 0.15);
      m.add(s);
      this.group.add(m);
      this.puddleMeshes.push(m);
    }
  }

  private lateralOf(i: number, x: number, z: number): number {
    const h = this.stage.headings[i];
    return (x - this.stage.xs[i]) * Math.cos(h) + (z - this.stage.zs[i]) * Math.sin(h);
  }

  /** Returns the index of the puddle covering (x, z) or -1. */
  puddleAt = (x: number, z: number): number => {
    const ps = this.stage.puddles;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz < p.r * p.r * 0.85) return i;
    }
    return -1;
  };

  /** Road surface height at a sample/lateral position (for placing props). */
  surfaceY(i: number, l: number): number {
    const hw = this.stage.halfWidths[i];
    return this.stage.ys[i] + this.surfaceOffset(i, clamp(l, -hw, hw));
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    if (this.physics && this.collider) this.physics.world.removeCollider(this.collider, false);
  }
}

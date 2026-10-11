// Chunked low-poly terrain: high-resolution chunks with trimesh colliders along
// the road corridor, cheap merged low-resolution tiles further away.

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Quality } from '../core/Settings';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { vertexColored } from '../rendering/materials';
import { ROAD_HALF_WIDTH } from '../shared/constants';
import { Noise2D, hash2, Rng } from '../shared/rng';
import type { TerrainField } from './TerrainField';

const CHUNK = 64;
const NEAR_DIST = 110;
const FAR_DIST = 360;
const FAR_RES = 8;
const HW = ROAD_HALF_WIDTH;

const COL = {
  grassA: new THREE.Color(0x6aa043),
  grassB: new THREE.Color(0x4f8a35),
  meadow: new THREE.Color(0x93b14d),
  ditch: new THREE.Color(0x56622f),
  mud: new THREE.Color(0x6b5638),
  edge: new THREE.Color(0x8a7656),
  dirt: new THREE.Color(0x7d6a4c),
  rock: new THREE.Color(0x7f7c72),
  // mountain palette
  alpine: new THREE.Color(0x8fa24c),
  alpineDry: new THREE.Color(0xa9a35a),
  scree: new THREE.Color(0x9a948a),
  cliff: new THREE.Color(0x6e6a64),
  cliffDark: new THREE.Color(0x57534f),
  snow: new THREE.Color(0xeef2f4),
};

export interface TerrainBuildProgress {
  (fraction: number): Promise<void> | void;
}

export class Terrain {
  readonly group = new THREE.Group();
  private colliders: RAPIER.Collider[] = [];
  private colorNoise: Noise2D;
  private tmpColor = new THREE.Color();

  constructor(
    private field: TerrainField,
    private physics: PhysicsWorld | null,
    private quality: Quality,
  ) {
    this.colorNoise = new Noise2D(hash2(field.stage.params.seed, 991));
    this.group.name = 'terrain';
  }

  /** Coarse distance from a point to the road centreline. */
  private roadDistance(x: number, z: number): number {
    const s = this.field.stage;
    let best = Infinity;
    for (let i = 0; i < s.count; i += 3) {
      const dx = s.xs[i] - x;
      const dz = s.zs[i] - z;
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  async build(progress?: TerrainBuildProgress) {
    const b = this.field.stage.bounds;
    const x0 = Math.floor((b.minX - FAR_DIST) / CHUNK);
    const x1 = Math.ceil((b.maxX + FAR_DIST) / CHUNK);
    const z0 = Math.floor((b.minZ - FAR_DIST) / CHUNK);
    const z1 = Math.ceil((b.maxZ + FAR_DIST) / CHUNK);
    const near: [number, number][] = [];
    const far = new Map<string, [number, number][]>();
    const halfDiag = CHUNK * 0.71;
    for (let cx = x0; cx < x1; cx++) {
      for (let cz = z0; cz < z1; cz++) {
        const d = this.roadDistance((cx + 0.5) * CHUNK, (cz + 0.5) * CHUNK);
        if (d <= NEAR_DIST + halfDiag) near.push([cx, cz]);
        else if (d <= FAR_DIST + halfDiag) {
          const key = `${Math.floor(cx / 4)},${Math.floor(cz / 4)}`;
          let list = far.get(key);
          if (!list) far.set(key, (list = []));
          list.push([cx, cz]);
        }
      }
    }
    // the mountain needs finer triangles for its cuts and drops at the road edge
    const res = (this.quality === 'high' ? 32 : this.quality === 'medium' ? 26 : 20) + (this.field.mountain ? 6 : 0);
    const total = near.length + far.size;
    let done = 0;
    for (const [cx, cz] of near) {
      this.buildNearChunk(cx, cz, res);
      if (++done % 8 === 0) await progress?.(done / total);
    }
    for (const list of far.values()) {
      this.buildFarTile(list);
      if (++done % 8 === 0) await progress?.(done / total);
    }
  }

  private faceColor(cx: number, cy: number, cz: number, ny: number, rng: Rng): THREE.Color {
    if (this.field.mountain) return this.mountainColor(cx, cy, cz, ny, rng);
    const q = this.field.queryRoad(cx, cz);
    const c = this.tmpColor;
    const n = this.colorNoise.fbm(cx / 90, cz / 90, 2);
    if (q.dist < HW + 0.45) c.copy(COL.edge);
    else if (q.dist < HW + 3.7) {
      c.copy(COL.ditch).lerp(COL.mud, Math.max(0, n + 0.3));
      if (cy < q.roadY - 0.6) c.lerp(COL.mud, 0.5);
    } else if (ny < 0.72) c.copy(COL.dirt).lerp(COL.rock, Math.max(0, Math.min(1, (0.72 - ny) * 3)));
    else {
      c.copy(COL.grassB).lerp(COL.grassA, Math.min(1, Math.max(0, n * 1.4 + 0.5)));
      const m = this.colorNoise.noise(cx / 40 + 13, cz / 40 - 7);
      if (m > 0.35) c.lerp(COL.meadow, Math.min(1, (m - 0.35) * 2));
    }
    const shade = 0.93 + rng.next() * 0.12;
    return c.multiplyScalar(shade);
  }

  /** Mountain: bare rock on cuts and steep faces, alpine grass and scree, snow high up. */
  private mountainColor(cx: number, cy: number, cz: number, ny: number, rng: Rng): THREE.Color {
    const q = this.field.queryRoad(cx, cz);
    const c = this.tmpColor;
    const n = this.colorNoise.fbm(cx / 70, cz / 70, 2);
    const hw = q.dist < Infinity ? this.field.halfWidthAt(q.idx) : HW;
    const snowLine = this.field.stage.ys[0] + 95 + n * 25;
    if (q.dist < hw + 0.45) c.copy(COL.edge);
    else if (ny < 0.62) c.copy(COL.cliffDark).lerp(COL.cliff, Math.max(0, n + 0.5));
    else if (ny < 0.8 || (q.dist < hw + 3.2 && cy > q.roadY + 0.6)) c.copy(COL.cliff).lerp(COL.scree, Math.max(0, Math.min(1, n + 0.4)));
    else {
      c.copy(COL.alpine).lerp(COL.alpineDry, Math.min(1, Math.max(0, n * 1.3 + 0.45)));
      if (this.colorNoise.noise(cx / 30 + 13, cz / 30 - 7) > 0.45) c.lerp(COL.scree, 0.65);
    }
    if (cy > snowLine && ny > 0.55) c.lerp(COL.snow, Math.min(1, (cy - snowLine) / 30 + 0.4));
    const shade = 0.93 + rng.next() * 0.12;
    return c.multiplyScalar(shade);
  }

  private buildNearChunk(cx: number, cz: number, res: number) {
    const size = CHUNK / res;
    const ox = cx * CHUNK;
    const oz = cz * CHUNK;
    const n = res + 1;
    const rng = new Rng(hash2(cx * 7919 + 13, cz * 104729 + 7));
    const vx = new Float32Array(n * n);
    const vy = new Float32Array(n * n);
    const vz = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const edge = i === 0 || j === 0 || i === res || j === res;
        const jx = edge ? 0 : (rng.next() - 0.5) * size * 0.55;
        const jz = edge ? 0 : (rng.next() - 0.5) * size * 0.55;
        const x = ox + i * size + jx;
        const z = oz + j * size + jz;
        const k = j * n + i;
        vx[k] = x;
        vz[k] = z;
        vy[k] = this.field.heightAt(x, z);
      }
    }
    const indices: number[] = [];
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        if ((i + j) % 2 === 0) indices.push(a, c, b, b, c, d);
        else indices.push(a, c, d, a, d, b);
      }
    }
    const mesh = this.meshFromGrid(vx, vy, vz, indices, rng, n, res, true);
    this.group.add(mesh);

    if (this.physics) {
      const verts = new Float32Array(n * n * 3);
      for (let k = 0; k < n * n; k++) {
        verts[k * 3] = vx[k];
        verts[k * 3 + 1] = vy[k];
        verts[k * 3 + 2] = vz[k];
      }
      const desc = RAPIER.ColliderDesc.trimesh(verts, new Uint32Array(indices), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
        .setFriction(0.8)
        .setRestitution(0.05);
      this.colliders.push(this.physics.addStatic(desc, 'grass'));
    }
  }

  private buildFarTile(list: [number, number][]) {
    const pos: number[] = [];
    const col: number[] = [];
    const rng = new Rng(hash2(list[0][0] * 31, list[0][1] * 17));
    const res = CHUNK / FAR_RES;
    for (const [cx, cz] of list) {
      const ox = cx * CHUNK;
      const oz = cz * CHUNK;
      const n = res + 1;
      const h = new Float32Array(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = this.field.heightAt(ox + i * FAR_RES, oz + j * FAR_RES);
      for (let j = 0; j < res; j++) {
        for (let i = 0; i < res; i++) {
          const ax = ox + i * FAR_RES, az = oz + j * FAR_RES;
          const p00 = [ax, h[j * n + i], az];
          const p10 = [ax + FAR_RES, h[j * n + i + 1], az];
          const p01 = [ax, h[(j + 1) * n + i], az + FAR_RES];
          const p11 = [ax + FAR_RES, h[(j + 1) * n + i + 1], az + FAR_RES];
          const tris = (i + j) % 2 === 0 ? [[p00, p01, p10], [p10, p01, p11]] : [[p00, p01, p11], [p00, p11, p10]];
          for (const t of tris) {
            const cyy = (t[0][1] + t[1][1] + t[2][1]) / 3;
            const c = this.faceColor((t[0][0] + t[1][0] + t[2][0]) / 3, cyy, (t[0][2] + t[1][2] + t[2][2]) / 3, 0.9, rng);
            for (const p of t) {
              pos.push(p[0], p[1], p[2]);
              col.push(c.r, c.g, c.b);
            }
          }
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, vertexColored());
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
  }

  private meshFromGrid(
    vx: Float32Array, vy: Float32Array, vz: Float32Array,
    indices: number[], rng: Rng, n: number, res: number, skirts: boolean,
  ): THREE.Mesh {
    const pos: number[] = [];
    const col: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
      a.set(vx[i0], vy[i0], vz[i0]);
      b.set(vx[i1], vy[i1], vz[i1]);
      c.set(vx[i2], vy[i2], vz[i2]);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      const ny = ab.cross(ac).normalize().y;
      const color = this.faceColor((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3, Math.abs(ny), rng);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      for (let k = 0; k < 3; k++) col.push(color.r, color.g, color.b);
    }
    if (skirts) {
      // hang a short vertical skirt from every edge to hide T-junction cracks
      const edgeColor = COL.ditch;
      const addEdge = (k0: number, k1: number) => {
        const x0 = vx[k0], y0 = vy[k0], z0 = vz[k0];
        const x1 = vx[k1], y1 = vy[k1], z1 = vz[k1];
        pos.push(x0, y0, z0, x1, y1, z1, x1, y1 - 2, z1, x0, y0, z0, x1, y1 - 2, z1, x0, y0 - 2, z0);
        for (let k = 0; k < 6; k++) col.push(edgeColor.r, edgeColor.g, edgeColor.b);
      };
      for (let i = 0; i < res; i++) {
        addEdge(i, i + 1);
        addEdge(res * n + i + 1, res * n + i);
        addEdge((i + 1) * n, i * n);
        addEdge(i * n + res, (i + 1) * n + res);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, vertexColored({ side: THREE.DoubleSide }));
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  dispose() {
    this.group.removeFromParent();
    for (const m of this.group.children) (m as THREE.Mesh).geometry.dispose();
    if (this.physics) for (const c of this.colliders) this.physics.world.removeCollider(c, false);
    this.colliders = [];
  }
}

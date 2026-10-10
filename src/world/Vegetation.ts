// Instanced low-poly vegetation: conifers, broadleaf trees, bushes, tall grass,
// rocks and roadside marker posts. Instances are grouped per 64 m chunk so the
// renderer can frustum-cull them; trees and rocks near the road get colliders.

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Quality } from '../core/Settings';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { GeoBuilder, mat } from '../rendering/geometry';
import { vertexColored } from '../rendering/materials';
import { ROAD_HALF_WIDTH } from '../shared/constants';
import { Noise2D, Rng, hash2 } from '../shared/rng';
import type { TerrainField } from './TerrainField';

const HW = ROAD_HALF_WIDTH;
const CHUNK = 128; // instancing batch size (frustum-culled per batch)

type Kind = 'conifer' | 'broadleaf' | 'bush' | 'grass' | 'rock' | 'post';

function buildGeometries(): Record<Kind, THREE.BufferGeometry> {
  const conifer = new GeoBuilder()
    .add(new THREE.CylinderGeometry(0.13, 0.2, 1.6, 5), 0x5b4130, mat(0, 0.8, 0), { shade: 0.1 })
    .add(new THREE.ConeGeometry(1.55, 2.3, 7), 0x2f6b35, mat(0, 2.1, 0), { shade: 0.16, jitter: 0.22, seed: 1 })
    .add(new THREE.ConeGeometry(1.15, 2.0, 6), 0x377a3a, mat(0, 3.3, 0, 0, 0.4, 0), { shade: 0.16, jitter: 0.18, seed: 2 })
    .add(new THREE.ConeGeometry(0.72, 1.7, 6), 0x41853f, mat(0, 4.4, 0, 0, 0.9, 0), { shade: 0.16, jitter: 0.12, seed: 3 })
    .build();
  const broadleaf = new GeoBuilder()
    .add(new THREE.CylinderGeometry(0.15, 0.24, 2.4, 5), 0x6a4c35, mat(0, 1.2, 0), { shade: 0.1 })
    .add(new THREE.IcosahedronGeometry(1.7, 0), 0x4e8d3a, mat(0, 3.4, 0, 0, 0, 0, 1, 0.85, 1), { shade: 0.2, jitter: 0.5, seed: 4 })
    .add(new THREE.IcosahedronGeometry(1.15, 0), 0x5b9a3e, mat(0.8, 3.9, 0.4), { shade: 0.2, jitter: 0.35, seed: 5 })
    .add(new THREE.IcosahedronGeometry(1.0, 0), 0x46813a, mat(-0.7, 3.0, -0.5), { shade: 0.2, jitter: 0.3, seed: 6 })
    .build();
  const bush = new GeoBuilder()
    .add(new THREE.IcosahedronGeometry(0.9, 0), 0x4a8636, mat(0, 0.45, 0, 0, 0, 0, 1.2, 0.75, 1), { shade: 0.22, jitter: 0.3, seed: 7 })
    .add(new THREE.IcosahedronGeometry(0.6, 0), 0x5a983e, mat(0.55, 0.55, 0.2), { shade: 0.2, jitter: 0.2, seed: 8 })
    .build();
  const gb = new GeoBuilder();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const h = 0.55 + (i % 3) * 0.15;
    const r = 0.18;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const px = -Math.sin(a) * 0.06, pz = Math.cos(a) * 0.06;
    const tip = new THREE.Vector3(Math.cos(a) * (r + 0.22), h, Math.sin(a) * (r + 0.22));
    gb.addTri(new THREE.Vector3(bx - px, 0, bz - pz), new THREE.Vector3(bx + px, 0, bz + pz), tip, i % 2 ? 0x86b24f : 0x9bbd5c);
  }
  const grass = gb.build();
  const rock = new GeoBuilder()
    .add(new THREE.DodecahedronGeometry(1, 0), 0x86837a, mat(0, 0, 0, 0, 0, 0, 1.2, 0.8, 1), { shade: 0.2, jitter: 0.35, seed: 9 })
    .build();
  const post = new GeoBuilder()
    .add(new THREE.BoxGeometry(0.09, 1.0, 0.09), 0xe8e4da, mat(0, 0.5, 0))
    .add(new THREE.BoxGeometry(0.095, 0.16, 0.095), 0xd23a2a, mat(0, 0.86, 0))
    .build();
  return { conifer, broadleaf, bush, grass, rock, post };
}

interface ChunkBucket {
  [kind: string]: { m: THREE.Matrix4; c: THREE.Color }[];
}

export class Vegetation {
  readonly group = new THREE.Group();
  private geos = buildGeometries();
  private colliders: RAPIER.Collider[] = [];
  private bushGrid = new Map<number, { x: number; z: number; r: number }[]>();

  constructor(
    private field: TerrainField,
    private physics: PhysicsWorld | null,
    private quality: Quality,
  ) {
    this.group.name = 'vegetation';
  }

  private bushKey(x: number, z: number) {
    return (Math.floor(x / 8) + 8192) * 16384 + (Math.floor(z / 8) + 8192);
  }

  /** Number of bushes overlapping a circle (used for driving-through-bush drag). */
  bushesAt(x: number, z: number, radius: number): number {
    let n = 0;
    const cx = Math.floor(x / 8), cz = Math.floor(z / 8);
    for (let gx = cx - 1; gx <= cx + 1; gx++)
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const list = this.bushGrid.get((gx + 8192) * 16384 + (gz + 8192));
        if (!list) continue;
        for (const b of list) if (Math.hypot(b.x - x, b.z - z) < b.r + radius) n++;
      }
    return n;
  }

  async build(progress?: (f: number) => Promise<void> | void) {
    const s = this.field.stage;
    const seed = s.params.seed;
    const forest = new Noise2D(hash2(seed, 31337));
    const kindNoise = new Noise2D(hash2(seed, 31338));
    const density = this.quality === 'high' ? 1 : this.quality === 'medium' ? 0.8 : 0.55;
    const buckets = new Map<string, ChunkBucket>();
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();
    const push = (kind: Kind, x: number, y: number, z: number, scale: number, yaw: number, tilt: number, color: THREE.Color) => {
      const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = {}));
      (b[kind] ??= []).push({
        m: (() => {
          dummy.position.set(x, y, z);
          dummy.rotation.set(tilt, yaw, tilt * 0.6);
          dummy.scale.setScalar(scale);
          dummy.updateMatrix();
          return dummy.matrix.clone();
        })(),
        c: color.clone(),
      });
    };

    // candidate area: sample along the road in a band, plus a sparse outer belt
    const visited = new Set<number>();
    const cell = 3.6 / Math.sqrt(density);
    const bandOuter = 150;
    const total = s.count;
    for (let i = 0; i < s.count; i += 6) {
      const cx0 = Math.floor((s.xs[i] - bandOuter) / cell);
      const cx1 = Math.floor((s.xs[i] + bandOuter) / cell);
      const cz0 = Math.floor((s.zs[i] - bandOuter) / cell);
      const cz1 = Math.floor((s.zs[i] + bandOuter) / cell);
      for (let gx = cx0; gx <= cx1; gx++) {
        for (let gz = cz0; gz <= cz1; gz++) {
          const key = (gx + 32768) * 65536 + (gz + 32768);
          if (visited.has(key)) continue;
          visited.add(key);
          const r = new Rng(hash2(seed ^ key, 77));
          const x = (gx + r.next()) * cell;
          const z = (gz + r.next()) * cell;
          const dRoad = Math.hypot(x - s.xs[i], z - s.zs[i]);
          if (dRoad > bandOuter) {
            visited.delete(key); // may still be inside the band of another sample
            continue;
          }
          const q = this.field.queryRoad(x, z);
          const d = q.dist;
          if (d < HW + 1.0) continue;
          const f = Math.min(1, Math.max(0.06, 0.55 + forest.fbm(x / 140, z / 140, 2) * 1.1));
          const roll = r.next();
          const y = this.field.heightAt(x, z);
          const conifer = kindNoise.noise(x / 160, z / 160) + (r.next() - 0.5) * 0.6 > -0.1;
          const yaw = r.next() * Math.PI * 2;
          if (d < HW + 3.2) {
            if (roll < 0.7) {
              push('grass', x, y - 0.05, z, 0.9 + r.next() * 0.7, yaw, 0, tint.set(0xffffff).multiplyScalar(0.85 + r.next() * 0.3));
              if (r.chance(0.5)) push('grass', x + 0.6, this.field.heightAt(x + 0.6, z + 0.4) - 0.05, z + 0.4, 0.8 + r.next() * 0.6, yaw + 1, 0, tint);
            } else if (roll < 0.84 && d > HW + 1.7) this.addBush(push, x, y, z, r, tint);
            continue;
          }
          if (d < HW + 9) {
            if (roll < 0.3) this.addBush(push, x, y, z, r, tint);
            else if (roll < 0.3 + 0.22 * f + 0.06) this.addTree(push, conifer, x, y, z, r, tint, d);
            else if (roll < 0.82) push('grass', x, y - 0.05, z, 0.9 + r.next() * 0.8, yaw, 0, tint.set(0xffffff).multiplyScalar(0.85 + r.next() * 0.3));
            else if (roll < 0.86 && d > HW + 2.5) this.addRock(push, x, y, z, r, tint, true);
            continue;
          }
          if (roll < 0.36 * f + 0.05) this.addTree(push, conifer, x, y, z, r, tint, d);
          else if (roll < 0.36 * f + 0.17) this.addBush(push, x, y, z, r, tint);
          else if (roll < 0.36 * f + 0.17 + 0.3 * (1 - f) && d < 70) push('grass', x, y - 0.05, z, 0.9 + r.next() * 0.9, yaw, 0, tint.set(0xffffff).multiplyScalar(0.85 + r.next() * 0.3));
          else if (roll > 0.985) this.addRock(push, x, y, z, r, tint, d < 40);
        }
      }
      if (i % 120 === 0) await progress?.(i / total);
    }

    // sparse outer forest (no colliders) for the horizon
    const outerCell = 11;
    const outerVisited = new Set<number>();
    for (let i = 0; i < s.count; i += 10) {
      for (let k = 0; k < 26; k++) {
        const a = (k / 26) * Math.PI * 2;
        const rad = 160 + (k % 4) * 45;
        const gx = Math.floor((s.xs[i] + Math.cos(a) * rad) / outerCell);
        const gz = Math.floor((s.zs[i] + Math.sin(a) * rad) / outerCell);
        const key = (gx + 32768) * 65536 + (gz + 32768);
        if (outerVisited.has(key) || visited.has(key)) continue;
        outerVisited.add(key);
        const r = new Rng(hash2(seed ^ key, 99));
        const x = (gx + r.next()) * outerCell;
        const z = (gz + r.next()) * outerCell;
        if (this.field.queryRoad(x, z).dist < 140) continue;
        const f = Math.min(1, Math.max(0.1, 0.55 + forest.fbm(x / 140, z / 140, 2) * 1.1));
        if (r.next() > f * 0.9) continue;
        const conifer = kindNoise.noise(x / 160, z / 160) > -0.1;
        this.addTree(push, conifer, x, this.field.heightAt(x, z), z, r, tint, 999);
      }
    }

    // marker posts along the road
    for (let i = s.startIdx + 10; i < s.finishIdx; i += 15) {
      const h = s.headings[i];
      for (const side of [-1, 1]) {
        const l = side * (HW + 0.95);
        const x = s.xs[i] + Math.cos(h) * l;
        const z = s.zs[i] + Math.sin(h) * l;
        push('post', x, this.field.heightAt(x, z) - 0.1, z, 1, -h, 0, tint.set(0xffffff));
      }
    }

    this.instantiate(buckets);
  }

  private addTree(
    push: (k: Kind, x: number, y: number, z: number, s: number, yaw: number, tilt: number, c: THREE.Color) => void,
    conifer: boolean, x: number, y: number, z: number, r: Rng, tint: THREE.Color, d: number,
  ) {
    const scale = conifer ? 0.85 + r.next() * 0.8 : 0.8 + r.next() * 0.6;
    tint.setRGB(1, 1, 1).multiplyScalar(0.8 + r.next() * 0.35);
    if (r.chance(0.2)) tint.lerp(new THREE.Color(0xd8e07a), 0.25);
    push(conifer ? 'conifer' : 'broadleaf', x, y - 0.2, z, scale, r.next() * Math.PI * 2, (r.next() - 0.5) * 0.08, tint);
    if (this.physics && d < 120) {
      const radius = (conifer ? 0.2 : 0.24) * scale;
      const desc = RAPIER.ColliderDesc.cylinder(1.6, radius).setTranslation(x, y + 1.4, z).setFriction(0.5).setRestitution(0.1);
      this.colliders.push(this.physics.addStatic(desc, 'tree'));
    }
  }

  private addBush(
    push: (k: Kind, x: number, y: number, z: number, s: number, yaw: number, tilt: number, c: THREE.Color) => void,
    x: number, y: number, z: number, r: Rng, tint: THREE.Color,
  ) {
    const scale = 0.7 + r.next() * 0.9;
    tint.setRGB(1, 1, 1).multiplyScalar(0.8 + r.next() * 0.35);
    push('bush', x, y - 0.1, z, scale, r.next() * Math.PI * 2, 0, tint);
    const k = this.bushKey(x, z);
    let list = this.bushGrid.get(k);
    if (!list) this.bushGrid.set(k, (list = []));
    list.push({ x, z, r: 0.85 * scale });
  }

  private addRock(
    push: (k: Kind, x: number, y: number, z: number, s: number, yaw: number, tilt: number, c: THREE.Color) => void,
    x: number, y: number, z: number, r: Rng, tint: THREE.Color, collide: boolean,
  ) {
    const scale = 0.5 + r.next() * 0.9;
    tint.setRGB(1, 1, 1).multiplyScalar(0.85 + r.next() * 0.25);
    push('rock', x, y - 0.25 * scale, z, scale, r.next() * Math.PI * 2, r.next() * 0.4, tint);
    if (this.physics && collide) {
      const desc = RAPIER.ColliderDesc.ball(0.85 * scale).setTranslation(x, y - 0.25 * scale, z).setFriction(0.6).setRestitution(0.15);
      this.colliders.push(this.physics.addStatic(desc, 'rock'));
    }
  }

  private instantiate(buckets: Map<string, ChunkBucket>) {
    const shadowKinds: Kind[] = ['conifer', 'broadleaf', 'bush', 'rock'];
    const grassMat = vertexColored({ side: THREE.DoubleSide });
    for (const bucket of buckets.values()) {
      for (const kind of Object.keys(bucket) as Kind[]) {
        const list = bucket[kind];
        if (!list.length) continue;
        const mesh = new THREE.InstancedMesh(this.geos[kind], kind === 'grass' ? grassMat : vertexColored(), list.length);
        for (let i = 0; i < list.length; i++) {
          mesh.setMatrixAt(i, list[i].m);
          mesh.setColorAt(i, list[i].c);
        }
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        mesh.castShadow = shadowKinds.includes(kind) && this.quality !== 'low';
        mesh.receiveShadow = kind !== 'grass';
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
      }
    }
  }

  dispose() {
    this.group.removeFromParent();
    for (const g of Object.values(this.geos)) g.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh) m.dispose();
    });
    if (this.physics) for (const c of this.colliders) this.physics.world.removeCollider(c, false);
    this.colliders = [];
    this.bushGrid.clear();
  }
}

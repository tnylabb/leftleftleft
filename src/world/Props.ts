// Stage props: start / checkpoint / finish gates (with colliders) and dynamic
// hay bales that the driver's client simulates and streams to the navigator.

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { GeoBuilder, mat } from '../rendering/geometry';
import { canvasTexture, lambert, PALETTE, vertexColored } from '../rendering/materials';
import { ROAD_HALF_WIDTH } from '../shared/constants';
import { MAX_PROPS_PER_MSG, PROP_STRIDE } from '../shared/snapshot';
import type { StageData } from '../shared/types';
import type { Road } from './Road';
import type { TerrainField } from './TerrainField';

const HW = ROAD_HALF_WIDTH;

interface Bale {
  id: number;
  body: RAPIER.RigidBody | null;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  target: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  moving: boolean;
}

function bannerTexture(text: string, kind: 'start' | 'checkpoint' | 'finish'): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const g = c.getContext('2d')!;
  if (kind === 'finish') {
    for (let x = 0; x < 512; x += 24) for (let y = 0; y < 96; y += 24) {
      g.fillStyle = ((x + y) / 24) % 2 ? '#111' : '#f4f4f0';
      g.fillRect(x, y, 24, 24);
    }
    g.fillStyle = 'rgba(232,116,43,0.92)';
    g.fillRect(70, 14, 372, 68);
  } else {
    g.fillStyle = kind === 'start' ? '#2f8f46' : '#e8742b';
    g.fillRect(0, 0, 512, 96);
    g.fillStyle = '#1b1b1b';
    for (let x = -40; x < 560; x += 40) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 18, 0);
      g.lineTo(x - 2, 12);
      g.lineTo(x - 20, 12);
      g.fill();
      g.beginPath();
      g.moveTo(x, 84);
      g.lineTo(x + 18, 84);
      g.lineTo(x - 2, 96);
      g.lineTo(x - 20, 96);
      g.fill();
    }
  }
  g.fillStyle = '#fff';
  g.font = 'italic 900 52px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.strokeStyle = '#1b1b1b';
  g.lineWidth = 6;
  g.strokeText(text, 256, 50);
  g.fillText(text, 256, 50);
  return canvasTexture(c);
}

export class Props {
  readonly group = new THREE.Group();
  readonly bales: Bale[] = [];
  private baleMesh: THREE.InstancedMesh;
  private colliders: RAPIER.Collider[] = [];
  private textures: THREE.Texture[] = [];
  private dummy = new THREE.Object3D();

  constructor(
    private stage: StageData,
    private field: TerrainField,
    private road: Road,
    private physics: PhysicsWorld | null,
  ) {
    const s = stage;
    this.addGate(s.startIdx + 3, 'START', 'start');
    for (const cp of s.checkpoints) this.addGate(cp.idx, `CHECKPOINT ${cp.index + 1}`, 'checkpoint');
    this.addGate(s.finishIdx, 'FINISH', 'finish');
    this.addLine(s.startIdx + 3);
    this.addLine(s.finishIdx);

    // hay bales
    const geo = new GeoBuilder()
      .add(new THREE.CylinderGeometry(0.6, 0.6, 1.2, 9), PALETTE.hay, undefined, { shade: 0.18, jitter: 0.04, seed: 11 })
      .add(new THREE.CylinderGeometry(0.61, 0.61, 0.08, 9), 0xb8913c, mat(0, 0.3, 0))
      .add(new THREE.CylinderGeometry(0.61, 0.61, 0.08, 9), 0xb8913c, mat(0, -0.3, 0))
      .build();
    this.baleMesh = new THREE.InstancedMesh(geo, vertexColored(), Math.max(1, s.bales.length));
    this.baleMesh.castShadow = true;
    this.baleMesh.receiveShadow = true;
    this.baleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.baleMesh.count = s.bales.length;
    this.baleMesh.frustumCulled = false;
    this.group.add(this.baleMesh);
    const lieDown = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    for (const b of s.bales) {
      const y = this.field.heightAt(b.x, b.z) + 0.62;
      const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 - b.heading).multiply(lieDown);
      const pos = new THREE.Vector3(b.x, y, b.z);
      let body: RAPIER.RigidBody | null = null;
      if (physics) {
        const res = physics.addBody(
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(pos.x, pos.y, pos.z)
            .setRotation(quat)
            .setLinearDamping(0.25)
            .setAngularDamping(0.6),
          [RAPIER.ColliderDesc.cylinder(0.6, 0.6).setDensity(190).setFriction(0.9).setRestitution(0.15)],
          'bale',
        );
        body = res.body;
        body.sleep();
      }
      this.bales.push({
        id: b.id,
        body,
        pos,
        quat,
        prevPos: pos.clone(),
        prevQuat: quat.clone(),
        target: pos.clone(),
        targetQuat: quat.clone(),
        moving: false,
      });
    }
    this.updateMeshes(1);
  }

  private addGate(idx: number, text: string, kind: 'start' | 'checkpoint' | 'finish') {
    const s = this.stage;
    const i = Math.max(0, Math.min(s.count - 1, idx));
    const h = s.headings[i];
    const rx = Math.cos(h), rz = Math.sin(h);
    const span = HW + 1.6;
    const roadY = s.ys[i];
    const gate = new THREE.Group();
    const postMat = lambert(kind === 'finish' ? 0x1b1b1b : 0xe9e4d8);
    for (const side of [-1, 1]) {
      const x = s.xs[i] + rx * span * side;
      const z = s.zs[i] + rz * span * side;
      const gy = this.field.heightAt(x, z);
      const top = roadY + 4.6;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.28, top - gy + 0.3, 0.28), postMat);
      post.position.set(x, (top + gy - 0.3) / 2, z);
      post.rotation.y = -h;
      post.castShadow = true;
      gate.add(post);
      // tyre stack at the base
      for (let k = 0; k < 3; k++) {
        const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.14, 5, 8), lambert(PALETTE.tyre));
        tyre.rotation.x = Math.PI / 2;
        tyre.position.set(x, gy + 0.12 + k * 0.26, z);
        tyre.castShadow = true;
        gate.add(tyre);
      }
      if (this.physics) {
        const desc = RAPIER.ColliderDesc.cylinder(0.6, 0.5).setTranslation(x, gy + 0.6, z);
        this.colliders.push(this.physics.addStatic(desc, 'prop'));
        const pd = RAPIER.ColliderDesc.cuboid(0.14, (top - gy) / 2, 0.14).setTranslation(x, (top + gy) / 2, z);
        this.colliders.push(this.physics.addStatic(pd, 'prop'));
      }
    }
    const tex = bannerTexture(text, kind);
    this.textures.push(tex);
    const bannerMat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(span * 2, 1.0), bannerMat);
    banner.position.set(s.xs[i], roadY + 4.1, s.zs[i]);
    banner.rotation.y = -h;
    banner.castShadow = true;
    gate.add(banner);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.3, 0.16, 0.16), postMat);
    beam.position.set(s.xs[i], roadY + 4.68, s.zs[i]);
    beam.rotation.y = -h;
    gate.add(beam);
    this.group.add(gate);
  }

  private addLine(idx: number) {
    const s = this.stage;
    const h = s.headings[idx];
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 0.45), lambert(0xf0eee6));
    line.rotation.order = 'YXZ';
    line.rotation.set(-Math.PI / 2, -h, 0);
    line.position.set(s.xs[idx], this.road.surfaceY(idx, 0) + 0.06, s.zs[idx]);
    line.receiveShadow = true;
    this.group.add(line);
  }

  /** Driver side: snapshot bodies after a physics step. */
  afterPhysicsStep() {
    for (const b of this.bales) {
      if (!b.body) continue;
      b.prevPos.copy(b.pos);
      b.prevQuat.copy(b.quat);
      const t = b.body.translation();
      const r = b.body.rotation();
      b.pos.set(t.x, t.y, t.z);
      b.quat.set(r.x, r.y, r.z, r.w);
      b.moving = !b.body.isSleeping();
    }
  }

  /** Packs moving bales for the network: [count, (id, px,py,pz, qx,qy,qz,qw)*]. */
  packMoving(force = false): Float32Array | null {
    const moving = this.bales.filter((b) => b.moving || force).slice(0, MAX_PROPS_PER_MSG);
    if (!moving.length) return null;
    const out = new Float32Array(1 + moving.length * PROP_STRIDE);
    out[0] = moving.length;
    moving.forEach((b, k) => {
      const o = 1 + k * PROP_STRIDE;
      out.set([b.id, b.pos.x, b.pos.y, b.pos.z, b.quat.x, b.quat.y, b.quat.z, b.quat.w], o);
    });
    return out;
  }

  /** Navigator side: apply streamed bale transforms. */
  applyRemote(buf: Float32Array) {
    const n = buf[0] | 0;
    for (let k = 0; k < n; k++) {
      const o = 1 + k * PROP_STRIDE;
      const b = this.bales[buf[o] | 0];
      if (!b) continue;
      b.target.set(buf[o + 1], buf[o + 2], buf[o + 3]);
      b.targetQuat.set(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]).normalize();
    }
  }

  updateMeshes(alpha: number, dt = 0) {
    const d = this.dummy;
    for (let i = 0; i < this.bales.length; i++) {
      const b = this.bales[i];
      if (b.body) {
        d.position.lerpVectors(b.prevPos, b.pos, alpha);
        d.quaternion.slerpQuaternions(b.prevQuat, b.quat, alpha);
      } else {
        const k = dt > 0 ? 1 - Math.exp(-dt * 12) : 1;
        b.pos.lerp(b.target, k);
        b.quat.slerp(b.targetQuat, k);
        d.position.copy(b.pos);
        d.quaternion.copy(b.quat);
      }
      d.scale.setScalar(1);
      d.updateMatrix();
      this.baleMesh.setMatrixAt(i, d.matrix);
    }
    this.baleMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    for (const t of this.textures) t.dispose();
    if (this.physics) {
      for (const c of this.colliders) this.physics.world.removeCollider(c, false);
      for (const b of this.bales) if (b.body) this.physics.world.removeRigidBody(b.body);
    }
  }
}

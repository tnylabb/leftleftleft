// Livestock and farm traffic on the stage: flocks of sheep that graze, scatter
// when the car comes (sometimes straight across the road) and tumble when hit;
// stubborn cows that stand on the road until you honk; a tractor that trundles
// along ahead of you. The driver's client simulates them (Rapier bodies + a
// little AI) and streams their poses with the props; everyone else
// interpolates. Both sides animate legs / wheels and raise the sound cues.

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { GeoBuilder, mat } from '../rendering/geometry';
import { vertexColored } from '../rendering/materials';
import { ROAD_HALF_WIDTH } from '../shared/constants';
import { clamp, damp, wrapAngle } from '../shared/math';
import { PROP_STRIDE } from '../shared/snapshot';
import { ANIMAL_ID_BASE } from '../shared/stage/animals';
import type { AnimalKind, AnimalSpawn, StageData } from '../shared/types';
import type { Road } from './Road';
import type { TerrainField } from './TerrainField';

export type AnimalVoice = 'baa' | 'moo' | 'baaHit' | 'mooHit' | 'putt';
export interface AnimalSound {
  voice: AnimalVoice;
  x: number;
  y: number;
  z: number;
}
export interface AnimalMarker {
  x: number;
  z: number;
  kind: AnimalKind;
  /** On (or right at the edge of) the road. */
  onRoad: boolean;
  /** Nearest road sample. */
  idx: number;
}
export interface CarNearby {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  horn: boolean;
}

type State = 'graze' | 'flee' | 'tumble' | 'stand' | 'amble' | 'park' | 'drive' | 'pullover';

interface Spec {
  half: [number, number, number];
  /** Collider centre above the feet. */
  lift: number;
  density: number;
}
const SPEC: Record<AnimalKind, Spec> = {
  sheep: { half: [0.26, 0.32, 0.5], lift: 0.4, density: 150 },
  cow: { half: [0.4, 0.62, 1.0], lift: 0.78, density: 260 },
  tractor: { half: [1.0, 1.2, 1.95], lift: 1.25, density: 1 },
};
const TRACTOR_SPEED = 5.5;
/** How far the tractor drives before it pulls over (samples). */
const TRACTOR_RUN = 320;
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

interface Animal {
  spawn: AnimalSpawn;
  kind: AnimalKind;
  body: RAPIER.RigidBody | null;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  target: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  // AI (driver side)
  state: State;
  timer: number;
  home: THREE.Vector3;
  dir: THREE.Vector2;
  speed: number;
  yaw: number;
  cmd: THREE.Vector2;
  scaredOnce: boolean;
  // tractor
  s: number;
  lateral: number;
  // rendering
  root: THREE.Group;
  legs: THREE.Object3D[];
  wheels: THREE.Object3D[];
  shownPos: THREE.Vector3;
  shownSpeed: number;
  phase: number;
  idx: number;
  tilted: boolean;
  voiceIn: number;
}

// --- models (feet at y = 0, forward = -Z) ------------------------------------------

function googlyEyes(b: GeoBuilder, x: number, y: number, z: number, r: number) {
  for (const s of [-1, 1]) {
    b.add(new THREE.IcosahedronGeometry(r, 1), 0xf6f3ea, mat(x * s, y, z));
    b.add(new THREE.IcosahedronGeometry(r * 0.45, 0), 0x111111, mat(x * s, y, z - r * 0.8));
  }
}

function sheepModel(): { body: THREE.BufferGeometry; leg: THREE.BufferGeometry } {
  const b = new GeoBuilder();
  const fleece = 0xf0ebdf;
  for (const [x, y, z, r] of [
    [0, 0.62, 0.22, 0.3], [0, 0.62, -0.18, 0.3], [0.13, 0.7, 0.02, 0.27], [-0.13, 0.7, 0.04, 0.27],
    [0, 0.78, 0.0, 0.25], [0.12, 0.56, 0.3, 0.2], [-0.12, 0.58, -0.3, 0.2], [0, 0.66, 0.42, 0.18],
  ])
    b.add(new THREE.IcosahedronGeometry(r, 0), fleece, mat(x, y, z), { shade: 0.14, jitter: 0.04, seed: Math.round(x * 100 + z * 10) });
  // black face, ears, a fleece tuft on top, googly eyes
  b.add(new THREE.IcosahedronGeometry(0.15, 0), 0x1d1d1f, mat(0, 0.74, -0.52, 0.3, 0, 0, 0.85, 1, 1.35), { shade: 0.08 });
  for (const s of [-1, 1]) b.add(new THREE.BoxGeometry(0.16, 0.035, 0.07), 0x1d1d1f, mat(0.15 * s, 0.8, -0.44, 0, 0, -0.35 * s));
  b.add(new THREE.IcosahedronGeometry(0.1, 0), fleece, mat(0, 0.88, -0.45), { shade: 0.1 });
  googlyEyes(b, 0.06, 0.8, -0.63, 0.04);
  b.add(new THREE.IcosahedronGeometry(0.06, 0), fleece, mat(0, 0.66, 0.56), { shade: 0.1 }); // tail
  const leg = new GeoBuilder().add(new THREE.BoxGeometry(0.07, 0.4, 0.07), 0x1d1d1f, mat(0, -0.2, 0)).build();
  return { body: b.build(), leg };
}

function cowModel(): { body: THREE.BufferGeometry; leg: THREE.BufferGeometry } {
  const b = new GeoBuilder();
  const hide = 0xf2eee4;
  const spot = 0x232325;
  b.add(new THREE.BoxGeometry(0.8, 0.72, 1.85), hide, mat(0, 1.08, 0.05), { shade: 0.06 });
  // patches
  for (const [x, y, z, w, h, d] of [
    [0.405, 1.16, 0.3, 0.02, 0.4, 0.6], [-0.405, 1.0, -0.2, 0.02, 0.36, 0.5], [0.405, 0.95, -0.55, 0.02, 0.3, 0.3],
    [0, 1.445, 0.45, 0.5, 0.02, 0.5], [-0.405, 1.25, 0.6, 0.02, 0.26, 0.3], [0.1, 1.445, -0.4, 0.4, 0.02, 0.3],
  ])
    b.add(new THREE.BoxGeometry(w, h, d), spot, mat(x, y, z));
  // head with a pink muzzle, horns, ears, googly eyes, a cow bell
  b.add(new THREE.BoxGeometry(0.46, 0.5, 0.56), hide, mat(0, 1.3, -1.08, 0.25, 0, 0), { shade: 0.06 });
  b.add(new THREE.BoxGeometry(0.42, 0.26, 0.2), 0xe8a7a0, mat(0, 1.12, -1.36, 0.25, 0, 0));
  for (const s of [-1, 1]) {
    b.add(new THREE.BoxGeometry(0.035, 0.04, 0.035), 0x5a2a22, mat(0.09 * s, 1.14, -1.465, 0.25, 0, 0));
    b.add(new THREE.ConeGeometry(0.045, 0.2, 5), 0xe9e1c8, mat(0.2 * s, 1.6, -1.0, 0, 0, -0.7 * s));
    b.add(new THREE.BoxGeometry(0.2, 0.06, 0.12), spot, mat(0.3 * s, 1.44, -0.98, 0, 0, -0.4 * s));
  }
  googlyEyes(b, 0.12, 1.43, -1.3, 0.06);
  b.add(new THREE.CylinderGeometry(0.07, 0.09, 0.14, 7), 0xd9a92e, mat(0, 0.86, -0.92));
  b.add(new THREE.BoxGeometry(0.26, 0.14, 0.22), 0xe8a7a0, mat(0, 0.66, 0.35)); // udder
  b.add(new THREE.BoxGeometry(0.05, 0.6, 0.05), hide, mat(0, 1.05, 0.98, -0.25, 0, 0)); // tail
  b.add(new THREE.IcosahedronGeometry(0.06, 0), spot, mat(0, 0.76, 1.05));
  const leg = new GeoBuilder()
    .add(new THREE.BoxGeometry(0.16, 0.66, 0.16), hide, mat(0, -0.33, 0))
    .add(new THREE.BoxGeometry(0.17, 0.08, 0.17), spot, mat(0, -0.68, 0))
    .build();
  return { body: b.build(), leg };
}

function tractorModel(): { body: THREE.BufferGeometry; big: THREE.BufferGeometry; small: THREE.BufferGeometry } {
  const b = new GeoBuilder();
  const green = 0x2f7d32;
  const sh = { shade: 0.06 };
  b.add(new THREE.BoxGeometry(0.9, 0.75, 1.7), green, mat(0, 1.05, -0.75), sh); // bonnet
  b.add(new THREE.BoxGeometry(0.92, 0.2, 0.06), 0x1d1d1f, mat(0, 0.95, -1.61)); // grille
  for (let k = 0; k < 3; k++) b.add(new THREE.BoxGeometry(0.8, 0.03, 0.02), 0x5a5a56, mat(0, 0.86 + k * 0.08, -1.63));
  for (const s of [-1, 1]) b.add(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 8), 0xfff2c4, mat(0.3 * s, 1.28, -1.61, Math.PI / 2, 0, 0));
  b.add(new THREE.BoxGeometry(1.3, 0.2, 1.1), 0x3a3a38, mat(0, 0.75, 0.55), sh); // chassis under the cab
  b.add(new THREE.BoxGeometry(0.9, 0.06, 0.8), green, mat(0, 0.92, 0.55));
  // fenders over the big wheels
  for (const s of [-1, 1]) b.add(new THREE.BoxGeometry(0.5, 0.06, 1.3), green, mat(0.85 * s, 1.6, 0.7), sh);
  // cab: posts, roof, seat, steering wheel
  for (const [x, z] of [[-0.55, 0.15], [0.55, 0.15], [-0.55, 1.1], [0.55, 1.1]]) b.add(new THREE.BoxGeometry(0.07, 1.35, 0.07), 0x1d1d1f, mat(x, 1.6, z));
  b.add(new THREE.BoxGeometry(1.3, 0.08, 1.2), green, mat(0, 2.3, 0.62), sh);
  b.add(new THREE.BoxGeometry(0.5, 0.1, 0.45), 0x1d1d1f, mat(0, 1.15, 0.8));
  b.add(new THREE.BoxGeometry(0.5, 0.5, 0.08), 0x1d1d1f, mat(0, 1.4, 1.03));
  b.add(new THREE.TorusGeometry(0.17, 0.025, 4, 10), 0x1d1d1f, mat(0, 1.6, 0.3, -1.0, 0, 0));
  // exhaust stack, roof beacon housing
  b.add(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6), 0x3a3a38, mat(0.32, 1.85, -0.9));
  b.add(new THREE.CylinderGeometry(0.11, 0.12, 0.05, 8), 0x1d1d1f, mat(0, 2.36, 0.62));
  // the farmer: blue overalls, flat cap, googly eyes
  b.add(new THREE.BoxGeometry(0.4, 0.5, 0.26), 0x2b4f91, mat(0, 1.45, 0.75), sh);
  b.add(new THREE.IcosahedronGeometry(0.15, 1), 0xd9a27a, mat(0, 1.85, 0.72, 0, 0, 0, 0.95, 1.1, 1), { shade: 0.08 });
  b.add(new THREE.BoxGeometry(0.32, 0.07, 0.36), 0x6b5a3a, mat(0, 1.98, 0.68, -0.08, 0, 0));
  googlyEyes(b, 0.05, 1.87, 0.57, 0.035);
  const big = new GeoBuilder()
    .add(new THREE.CylinderGeometry(0.78, 0.78, 0.45, 12), 0x1b1b1b, mat(0, 0, 0, 0, 0, Math.PI / 2), { shade: 0.16 })
    .add(new THREE.CylinderGeometry(0.42, 0.42, 0.46, 10), 0xd9a92e, mat(0, 0, 0, 0, 0, Math.PI / 2));
  for (let k = 0; k < 8; k++) big.add(new THREE.BoxGeometry(0.47, 0.1, 0.08), 0x2a2a2a, mat(0, 0, 0, (k / 8) * Math.PI * 2, 0, 0, 1, 1, 1).multiply(mat(0, 0.78, 0)));
  const small = new GeoBuilder()
    .add(new THREE.CylinderGeometry(0.42, 0.42, 0.28, 10), 0x1b1b1b, mat(0, 0, 0, 0, 0, Math.PI / 2), { shade: 0.16 })
    .add(new THREE.CylinderGeometry(0.22, 0.22, 0.29, 8), 0xd9a92e, mat(0, 0, 0, 0, 0, Math.PI / 2));
  return { body: b.build(), big: big.build(), small: small.build() };
}

export class Animals {
  readonly group = new THREE.Group();
  readonly list: Animal[] = [];
  /** Sound cues raised since the last `drainSounds()`. */
  private sounds: AnimalSound[] = [];
  private geos: THREE.BufferGeometry[] = [];
  private beacon = new THREE.MeshBasicMaterial({ color: 0xff8a1a });
  private byId = new Map<number, Animal>();

  constructor(
    private stage: StageData,
    private field: TerrainField,
    private road: Road,
    private physics: PhysicsWorld | null,
  ) {
    const sheep = sheepModel();
    const cow = cowModel();
    const tractor = tractorModel();
    this.geos.push(sheep.body, sheep.leg, cow.body, cow.leg, tractor.body, tractor.big, tractor.small);
    const material = vertexColored();
    for (const sp of stage.animals) {
      const root = new THREE.Group();
      const legs: THREE.Object3D[] = [];
      const wheels: THREE.Object3D[] = [];
      const mesh = (g: THREE.BufferGeometry, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
        const m = new THREE.Mesh(g, material);
        m.position.set(x, y, z);
        m.castShadow = true;
        m.receiveShadow = true;
        parent.add(m);
        return m;
      };
      if (sp.kind === 'sheep') {
        mesh(sheep.body, root);
        for (const [x, z] of [[-0.14, -0.3], [0.14, -0.3], [-0.14, 0.3], [0.14, 0.3]]) legs.push(mesh(sheep.leg, root, x, 0.42, z));
      } else if (sp.kind === 'cow') {
        mesh(cow.body, root);
        for (const [x, z] of [[-0.26, -0.68], [0.26, -0.68], [-0.26, 0.7], [0.26, 0.7]]) legs.push(mesh(cow.leg, root, x, 0.74, z));
      } else {
        mesh(tractor.body, root);
        for (const s of [-1, 1]) wheels.push(mesh(tractor.big, root, 0.88 * s, 0.78, 0.7));
        for (const s of [-1, 1]) wheels.push(mesh(tractor.small, root, 0.62 * s, 0.42, -1.2));
        const lamp = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), this.beacon);
        lamp.position.set(0, 2.45, 0.62);
        root.add(lamp);
        this.geos.push(lamp.geometry);
      }
      const ground = sp.kind === 'tractor' ? this.road.surfaceY(sp.idx, ROAD_HALF_WIDTH * 0.45) : this.field.heightAt(sp.x, sp.z);
      const pos = new THREE.Vector3(sp.x, ground + 0.02, sp.z);
      const yaw = -sp.heading;
      const quat = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
      let body: RAPIER.RigidBody | null = null;
      if (physics) {
        const spec = SPEC[sp.kind];
        const collider = RAPIER.ColliderDesc.cuboid(...spec.half)
          .setTranslation(0, spec.lift, sp.kind === 'tractor' ? -0.2 : 0)
          .setFriction(sp.kind === 'tractor' ? 0.8 : 0.3)
          .setRestitution(0.25);
        if (sp.kind === 'tractor') {
          body = physics.addBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z).setRotation(quat), [collider], 'animal').body;
        } else {
          collider.setDensity(spec.density);
          body = physics.addBody(
            RAPIER.RigidBodyDesc.dynamic()
              .setTranslation(pos.x, pos.y, pos.z)
              .setRotation(quat)
              .enabledRotations(false, true, false)
              .setLinearDamping(0.4)
              .setAngularDamping(1.5),
            [collider],
            'animal',
          ).body;
          body.sleep();
        }
      }
      root.position.copy(pos);
      root.quaternion.copy(quat);
      this.group.add(root);
      const a: Animal = {
        spawn: sp,
        kind: sp.kind,
        body,
        pos,
        quat,
        prevPos: pos.clone(),
        prevQuat: quat.clone(),
        target: pos.clone(),
        targetQuat: quat.clone(),
        state: sp.kind === 'sheep' ? 'graze' : sp.kind === 'cow' ? 'stand' : 'park',
        timer: Math.random() * 3,
        home: pos.clone(),
        dir: new THREE.Vector2(),
        speed: 0,
        yaw,
        cmd: new THREE.Vector2(),
        scaredOnce: false,
        s: sp.idx,
        lateral: ROAD_HALF_WIDTH * 0.45,
        root,
        legs,
        wheels,
        shownPos: pos.clone(),
        shownSpeed: 0,
        phase: Math.random() * 6,
        idx: sp.idx,
        tilted: false,
        voiceIn: 2 + Math.random() * 6,
      };
      this.list.push(a);
      this.byId.set(sp.id, a);
    }
  }

  // ================================================================ driver side ==
  /** AI: decide where everyone wants to go and drive the bodies (before the physics step). */
  beforePhysicsStep(dt: number, car: CarNearby) {
    const carSpeed = Math.hypot(car.vel.x, car.vel.z);
    for (const a of this.list) {
      const body = a.body;
      if (!body) continue;
      const dx = a.pos.x - car.pos.x;
      const dz = a.pos.z - car.pos.z;
      const dist = Math.hypot(dx, dz);
      if (a.kind === 'tractor') {
        this.driveTractor(a, dt, car, dist);
        continue;
      }
      if (dist > 240 && a.state !== 'tumble') {
        // far away: asleep where they stand (so nobody slides down a hillside before you arrive)
        if (!body.isSleeping()) {
          a.cmd.set(0, 0);
          body.setLinvel({ x: 0, y: 0, z: 0 }, false);
          body.sleep();
        }
        continue;
      }
      a.timer -= dt;
      if (a.state === 'tumble') {
        const v = body.linvel();
        if (a.timer <= 0 && Math.hypot(v.x, v.y, v.z) < 0.8) this.getUp(a, car);
        continue;
      }
      if (a.kind === 'sheep') this.thinkSheep(a, dist, dx, dz, car, carSpeed);
      else this.thinkCow(a, dist, car);
      // steer the body: smooth acceleration towards the wished velocity, face where it goes
      // (the commanded velocity is kept separately, so ground friction doesn't eat it)
      const k = damp(a.kind === 'sheep' ? 6 : 3, dt);
      a.cmd.x += (a.dir.x * a.speed - a.cmd.x) * k;
      a.cmd.y += (a.dir.y * a.speed - a.cmd.y) * k;
      body.setLinvel({ x: a.cmd.x, y: body.linvel().y, z: a.cmd.y }, true);
      if (a.speed > 0.15) {
        const wantYaw = Math.atan2(-a.dir.x, -a.dir.y);
        const diff = wrapAngle(wantYaw - a.yaw);
        body.setAngvel({ x: 0, y: clamp(diff * 5, -4, 4), z: 0 }, true);
      } else body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  private thinkSheep(a: Animal, dist: number, dx: number, dz: number, car: CarNearby, carSpeed: number) {
    const scared = (dist < 24 && carSpeed > 2.5) || (car.horn && dist < 40);
    if (scared && a.state !== 'flee') {
      a.state = 'flee';
      a.timer = 2.5 + Math.random() * 2;
      // run away from the car's path... or, in a panic, straight across it
      let fx = car.vel.x;
      let fz = car.vel.z;
      const fl = Math.hypot(fx, fz);
      if (fl < 0.5) {
        fx = dx;
        fz = dz;
      }
      const n = Math.hypot(fx, fz) || 1;
      fx /= n;
      fz /= n;
      let side = Math.sign(fx * dz - fz * dx) || 1;
      if (Math.random() < 0.28) side = -side;
      const px = -fz * side;
      const pz = fx * side;
      a.dir.set(px * 0.85 + fx * 0.5, pz * 0.85 + fz * 0.5).normalize();
      a.speed = 4.2 + Math.random() * 1.2;
      return;
    }
    if (a.state === 'flee') {
      if (a.timer > 0 || scared) return;
      a.state = 'graze';
      a.home.copy(a.pos);
      a.timer = 0;
    }
    if (a.timer <= 0) {
      a.timer = 1 + Math.random() * 3;
      const away = Math.hypot(a.pos.x - a.home.x, a.pos.z - a.home.z);
      if (Math.random() < 0.45 && away < 6) a.speed = 0;
      else {
        const ang = away > 6 ? Math.atan2(a.home.z - a.pos.z, a.home.x - a.pos.x) + (Math.random() - 0.5) : Math.random() * Math.PI * 2;
        a.dir.set(Math.cos(ang), Math.sin(ang));
        a.speed = 0.35 + Math.random() * 0.35;
      }
    }
  }

  private thinkCow(a: Animal, dist: number, car: CarNearby) {
    if (car.horn && dist < 32 && a.state !== 'amble') {
      // a honk: moves off the road (slowly, and only for a bit)
      const q = this.field.queryRoad(a.pos.x, a.pos.z);
      const h = this.stage.headings[Math.max(0, Math.min(this.stage.count - 1, Math.round(q.idx)))];
      const side = Math.sign(q.lateral) || (Math.random() < 0.5 ? -1 : 1);
      a.dir.set(Math.cos(h) * side, Math.sin(h) * side);
      a.speed = 1.2;
      a.state = 'amble';
      a.timer = 4.5;
      return;
    }
    if (a.timer > 0) return;
    if (a.state === 'amble') {
      a.state = 'stand';
      a.home.copy(a.pos);
    }
    a.timer = 2 + Math.random() * 4;
    const away = Math.hypot(a.pos.x - a.home.x, a.pos.z - a.home.z);
    if (Math.random() < 0.7 && away < 3) a.speed = 0;
    else {
      const ang = away >= 3 ? Math.atan2(a.home.z - a.pos.z, a.home.x - a.pos.x) : Math.random() * Math.PI * 2;
      a.dir.set(Math.cos(ang), Math.sin(ang));
      a.speed = 0.3;
    }
  }

  private driveTractor(a: Animal, dt: number, car: CarNearby, dist: number) {
    const st = this.stage;
    if (a.state === 'park') {
      // starts off once the car is coming up behind it
      const q = this.field.queryRoad(car.pos.x, car.pos.z);
      if (dist < 140 && q.idx < a.s - 4 && a.s < a.spawn.idx + TRACTOR_RUN) a.state = 'drive';
      return;
    }
    a.s += (TRACTOR_SPEED * dt) / 2; // road samples are 2 m apart
    if (a.state === 'drive' && a.s > a.spawn.idx + TRACTOR_RUN) a.state = 'pullover';
    if (a.state === 'pullover') {
      a.lateral = Math.min(ROAD_HALF_WIDTH + 2.2, a.lateral + dt * 0.8);
      if (a.lateral >= ROAD_HALF_WIDTH + 2.2) a.state = 'park';
    }
    const i = Math.min(st.count - 2, Math.floor(a.s));
    const f = a.s - i;
    const h = st.headings[i] + wrapAngle(st.headings[i + 1] - st.headings[i]) * f;
    const x = st.xs[i] + (st.xs[i + 1] - st.xs[i]) * f + Math.cos(h) * a.lateral;
    const z = st.zs[i] + (st.zs[i + 1] - st.zs[i]) * f + Math.sin(h) * a.lateral;
    const y = a.lateral > ROAD_HALF_WIDTH ? this.field.heightAt(x, z) : this.road.surfaceY(i, a.lateral) * (1 - f) + this.road.surfaceY(i + 1, a.lateral) * f;
    a.yaw = -h;
    a.body!.setNextKinematicTranslation({ x, y: y + 0.02, z });
    a.body!.setNextKinematicRotation(_q.setFromAxisAngle(UP, a.yaw));
  }

  private tumble(a: Animal, car: CarNearby) {
    const body = a.body!;
    a.state = 'tumble';
    a.timer = a.kind === 'sheep' ? 2.2 : 3;
    a.cmd.set(0, 0);
    body.setEnabledRotations(true, true, true, true);
    const m = body.mass();
    const away = _v.set(a.pos.x - car.pos.x, 0, a.pos.z - car.pos.z).normalize();
    body.applyImpulse({ x: away.x * m * 1.5, y: m * (a.kind === 'sheep' ? 3.2 : 1.5), z: away.z * m * 1.5 }, true);
    body.applyTorqueImpulse({ x: (Math.random() - 0.5) * m * 0.8, y: (Math.random() - 0.5) * m * 0.5, z: (Math.random() - 0.5) * m * 0.8 }, true);
  }

  private getUp(a: Animal, car: CarNearby) {
    const body = a.body!;
    const fwd = _v.set(0, 0, -1).applyQuaternion(a.quat);
    a.yaw = Math.atan2(-fwd.x, -fwd.z);
    body.setRotation(_q.setFromAxisAngle(UP, a.yaw), true);
    const t = body.translation();
    body.setTranslation({ x: t.x, y: Math.max(t.y, this.field.heightAt(t.x, t.z)) + 0.1, z: t.z }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.setEnabledRotations(false, true, false, true);
    a.home.copy(a.pos);
    a.cmd.set(0, 0);
    if (a.kind === 'sheep') {
      // shake it off and get out of here
      a.state = 'flee';
      a.timer = 2;
      const ax = a.pos.x - car.pos.x;
      const az = a.pos.z - car.pos.z;
      a.dir.set(ax, az).normalize();
      a.speed = 4;
    } else {
      a.state = 'stand';
      a.timer = 3;
      a.speed = 0;
    }
  }

  /** After the physics step: read the bodies back, notice who got hit. */
  afterPhysicsStep(car: CarNearby) {
    for (const a of this.list) {
      const body = a.body;
      if (!body) continue;
      a.prevPos.copy(a.pos);
      a.prevQuat.copy(a.quat);
      const t = body.translation();
      const r = body.rotation();
      a.pos.set(t.x, t.y, t.z);
      a.quat.set(r.x, r.y, r.z, r.w);
      if (a.kind === 'tractor') continue;
      if (a.state !== 'tumble') {
        const fwd = _v.set(0, 0, -1).applyQuaternion(a.quat);
        a.yaw = Math.atan2(-fwd.x, -fwd.z);
        // knocked by the car: much faster than it was told to go
        const lv = body.linvel();
        const kick = Math.hypot(lv.x - a.cmd.x, lv.z - a.cmd.y) + Math.max(0, lv.y - 0.5);
        const near = Math.hypot(a.pos.x - car.pos.x, a.pos.z - car.pos.z) < 5;
        if (near && kick > (a.kind === 'sheep' ? 1.8 : 4)) this.tumble(a, car);
      }
      // fell off the mountain: stop simulating it
      if (a.pos.y < this.field.heightAt(a.pos.x, a.pos.z) - 30) {
        body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        body.sleep();
      }
    }
  }

  /** Packs the animals near the car for the network: [count, (id, px,py,pz, qx,qy,qz,qw)*]. */
  packNear(carPos: THREE.Vector3, max: number): Float32Array | null {
    if (max <= 0) return null;
    const near = this.list
      .map((a) => ({ a, d: Math.hypot(a.pos.x - carPos.x, a.pos.z - carPos.z) }))
      .filter((e) => e.d < 170)
      .sort((p, q) => p.d - q.d)
      .slice(0, max);
    if (!near.length) return null;
    const out = new Float32Array(1 + near.length * PROP_STRIDE);
    out[0] = near.length;
    near.forEach(({ a }, k) => out.set([a.spawn.id, a.pos.x, a.pos.y, a.pos.z, a.quat.x, a.quat.y, a.quat.z, a.quat.w], 1 + k * PROP_STRIDE));
    return out;
  }

  // ================================================================ remote side ==
  /** Applies streamed animal poses (ids from ANIMAL_ID_BASE; other ids are hay bales). */
  applyRemote(buf: Float32Array) {
    const n = buf[0] | 0;
    for (let k = 0; k < n; k++) {
      const o = 1 + k * PROP_STRIDE;
      const id = buf[o] | 0;
      if (id < ANIMAL_ID_BASE) continue;
      const a = this.byId.get(id);
      if (!a) continue;
      a.target.set(buf[o + 1], buf[o + 2], buf[o + 3]);
      a.targetQuat.set(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]).normalize();
    }
  }

  // ================================================================ both sides ==
  /** Interpolates, animates legs / wheels / the beacon, raises the sound cues. */
  updateMeshes(alpha: number, dt: number, carPos: THREE.Vector3) {
    this.beacon.color.setHex(Math.sin(performance.now() / 110) > 0 ? 0xffa21a : 0x5a2a00);
    for (const a of this.list) {
      const root = a.root;
      if (a.body) {
        root.position.lerpVectors(a.prevPos, a.pos, alpha);
        root.quaternion.slerpQuaternions(a.prevQuat, a.quat, alpha);
      } else {
        const k = dt > 0 ? damp(10, dt) : 1;
        a.pos.lerp(a.target, k);
        a.quat.slerp(a.targetQuat, k);
        root.position.copy(a.pos);
        root.quaternion.copy(a.quat);
      }
      // speed from what is shown (works the same on both sides)
      const moved = dt > 0 ? Math.hypot(root.position.x - a.shownPos.x, root.position.z - a.shownPos.z) / dt : 0;
      a.shownPos.copy(root.position);
      a.shownSpeed += (Math.min(moved, 12) - a.shownSpeed) * damp(8, dt);
      const up = _v.set(0, 1, 0).applyQuaternion(root.quaternion);
      const tilted = up.y < 0.55;
      const dist = Math.hypot(root.position.x - carPos.x, root.position.z - carPos.z);
      if (a.kind === 'tractor') {
        for (let w = 0; w < a.wheels.length; w++) a.wheels[w].rotation.x -= (a.shownSpeed * dt) / (w < 2 ? 0.78 : 0.42);
        a.voiceIn -= dt;
        if (a.shownSpeed > 0.5 && dist < 90 && a.voiceIn <= 0) {
          a.voiceIn = 0.11;
          this.sounds.push({ voice: 'putt', x: root.position.x, y: root.position.y + 1, z: root.position.z });
        }
        continue;
      }
      // legs: a trot that speeds up with the animal
      a.phase += dt * (a.kind === 'sheep' ? 5 + a.shownSpeed * 3 : 3 + a.shownSpeed * 3);
      const amp = tilted ? 0.9 : Math.min(1, a.shownSpeed / 1.2) * (a.kind === 'sheep' ? 0.7 : 0.45);
      a.legs.forEach((l, i) => (l.rotation.x = Math.sin(a.phase + (i === 0 || i === 3 ? 0 : Math.PI)) * amp));
      if (a.kind === 'sheep' && a.shownSpeed > 2) root.position.y += Math.abs(Math.sin(a.phase)) * 0.08; // bouncing gallop
      // voices: knocked over, scattering, mooing at the car
      if (tilted && !a.tilted) this.sounds.push({ voice: a.kind === 'sheep' ? 'baaHit' : 'mooHit', x: root.position.x, y: root.position.y, z: root.position.z });
      a.tilted = tilted;
      a.voiceIn -= dt;
      if (a.voiceIn <= 0 && dist < 45) {
        const running = a.shownSpeed > 2.2;
        if (a.kind === 'sheep' ? running || Math.random() < 0.25 : dist < 35) {
          this.sounds.push({ voice: a.kind === 'sheep' ? 'baa' : 'moo', x: root.position.x, y: root.position.y, z: root.position.z });
        }
        a.voiceIn = a.kind === 'sheep' ? 1.5 + Math.random() * 4 : 5 + Math.random() * 6;
      }
      // nearest road sample (local search, for the tablet and the co-driver)
      a.idx = this.trackIdx(a.idx, root.position.x, root.position.z);
    }
  }

  private trackIdx(idx: number, x: number, z: number): number {
    const st = this.stage;
    let best = idx;
    let bestD = Infinity;
    for (let i = Math.max(0, idx - 8); i <= Math.min(st.count - 1, idx + 8); i++) {
      const d = (st.xs[i] - x) ** 2 + (st.zs[i] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // lost track (e.g. knocked a long way): look it up properly
    if (bestD > 30 * 30) {
      const q = this.field.queryRoad(x, z);
      if (Number.isFinite(q.dist)) best = Math.round(q.idx);
    }
    return best;
  }

  drainSounds(): AnimalSound[] {
    const s = this.sounds;
    this.sounds = [];
    return s;
  }

  /** Where everyone is (for the tablet map and the AI co-driver). */
  markers(out: AnimalMarker[] = []): AnimalMarker[] {
    out.length = 0;
    const st = this.stage;
    for (const a of this.list) {
      const p = a.root.position;
      const i = a.idx;
      const lat = Math.hypot(p.x - st.xs[i], p.z - st.zs[i]);
      out.push({ x: p.x, z: p.z, kind: a.kind, onRoad: lat < st.halfWidths[i] + (a.kind === 'cow' ? 1.6 : 1), idx: i });
    }
    return out;
  }

  /** Who is on the road between two road samples (the nearest first), or null. */
  onRoadAhead(from: number, to: number): AnimalKind | null {
    let best: Animal | null = null;
    const st = this.stage;
    for (const a of this.list) {
      if (a.idx < from || a.idx > to) continue;
      const p = a.root.position;
      if (Math.hypot(p.x - st.xs[a.idx], p.z - st.zs[a.idx]) > st.halfWidths[a.idx] + 1) continue;
      if (!best || a.idx < best.idx) best = a;
    }
    return best?.kind ?? null;
  }

  dispose() {
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
    this.beacon.dispose();
    if (this.physics) for (const a of this.list) if (a.body) this.physics.world.removeRigidBody(a.body);
    this.list.length = 0;
  }
}

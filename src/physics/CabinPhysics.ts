// Cabin physics in the car's local frame. Effective gravity is
// (world gravity - car acceleration) rotated into the car frame, so cornering,
// braking, bumps, jumps (weightless!) and crashes throw loose objects around
// without them ever tunnelling through a fast-moving car.
//
// The navigator has two "hands": the main slot (tablet, paper map or a small
// object, held with both hands or the left hand alone) and the torch slot
// (the flashlight, always in the right hand).

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { LAYOUT } from '../cockpit/layout';
import { CABIN_BODY, CABIN_BOUNDS, FIXED_DT } from '../shared/constants';
import { clamp } from '../shared/math';
import {
  FLASHLIGHT_HOLDER,
  FLASHLIGHT_SPEC,
  GLOVEBOX_OPENING,
  LOOSE_OBJECTS,
  MAP_SPEC,
  TABLET_SPEC,
} from '../tablet/cabinObjects';

export type DropReason = 'impact' | 'gforce' | 'snag' | 'released';

export interface CabinCallbacks {
  contact(index: number, strength: number): void;
  /** An object fell out of the navigator's hands (not called for deliberate releases). */
  dropped(index: number, reason: DropReason): void;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _axis = new THREE.Vector3();
const TABLET_START_QUAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);

interface HandSlot {
  index: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  grip: number;
  errorTime: number;
}

export class CabinPhysics {
  readonly world: RAPIER.World;
  private events: RAPIER.EventQueue;
  /** index 0 = tablet, 1..4 loose objects, 5 flashlight, 6 paper map */
  readonly bodies: RAPIER.RigidBody[] = [];
  private colliders: RAPIER.Collider[] = [];
  private colliderIndex = new Map<number, number>();
  readonly prevPos: THREE.Vector3[] = [];
  readonly prevQuat: THREE.Quaternion[] = [];
  readonly currPos: THREE.Vector3[] = [];
  readonly currQuat: THREE.Quaternion[] = [];
  private main: HandSlot = { index: -1, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), grip: 100, errorTime: 0 };
  private torch: HandSlot = { index: -1, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), grip: 100, errorTime: 0 };
  /** The main object is held by the left hand only (right hand busy). */
  oneHanded = false;
  /** Extra grip drain multiplier for awkward objects (an open map at speed). */
  awkwardness = 1;
  flashlightStowed = true;
  mapStowed = true;
  mapOpen = false;
  private lastContact: number[] = [];
  private time = 0;
  private regrabBlockedUntil = 0;
  readonly gravity = new THREE.Vector3(0, -9.81, 0);

  constructor(private cb: CabinCallbacks) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
    this.events = new RAPIER.EventQueue(true);
    this.buildStatic();
    this.buildDynamic();
  }

  /** Main-hand object index (-1 = none). Kept as `held` for existing callers. */
  get held(): number {
    return this.main.index;
  }

  get grip(): number {
    return this.main.grip;
  }

  get torchHeld(): boolean {
    return this.torch.index >= 0;
  }

  private addBox(hx: number, hy: number, hz: number, x: number, y: number, z: number, rx = 0, friction = 0.7) {
    const d = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setFriction(friction).setRestitution(0.2);
    if (rx) d.setRotation(_q.setFromAxisAngle(_axis.set(1, 0, 0), rx));
    this.world.createCollider(d);
  }

  private buildStatic() {
    const L = LAYOUT;
    const b = CABIN_BOUNDS;
    // shell
    this.addBox(0.8, 0.06, 1.5, 0, L.floorY - 0.06, 0.3);
    this.addBox(0.8, 0.06, 1.5, 0, L.roofY + 0.06, 0.4);
    this.addBox(0.08, 0.8, 1.5, -(L.sideX + 0.08), 0.3, 0.3);
    this.addBox(0.08, 0.8, 1.5, L.sideX + 0.08, 0.3, 0.3);
    this.addBox(0.8, 0.8, 0.08, 0, 0.2, b.minZ - 0.06);
    this.addBox(0.8, 0.8, 0.08, 0, 0.3, L.rearWallZ + 0.08);
    // dashboard shelf and face
    this.addBox(0.75, 0.05, 0.22, 0, L.dash.topY - 0.05, -0.81, 0.06, 0.55);
    this.addBox(0.75, 0.17, 0.05, 0, 0.16, -0.64, -0.25);
    // windshield as a slanted slab
    const w = L.windshield;
    const centre = new THREE.Vector3().add(w.bl).add(w.br).add(w.tl).add(w.tr).multiplyScalar(0.25);
    const n = new THREE.Vector3().subVectors(w.br, w.bl).cross(new THREE.Vector3().subVectors(w.tl, w.bl)).normalize();
    const slab = RAPIER.ColliderDesc.cuboid(0.72, 0.03, 0.42)
      .setTranslation(centre.x - n.x * 0.03, centre.y - n.y * 0.03, centre.z - n.z * 0.03)
      .setRotation(_q.setFromUnitVectors(_axis.set(0, 1, 0), n))
      .setFriction(0.3);
    this.world.createCollider(slab);
    // seats + occupants' laps and torsos
    for (const s of [-1, 1]) {
      const x = L.seatX * s;
      this.addBox(0.25, 0.07, 0.26, x, L.seatCushionY - 0.07, 0.24);
      this.addBox(0.25, 0.33, 0.06, x, 0.36, 0.6, 0.18);
      this.addBox(0.2, 0.075, 0.24, x, 0.075, 0.1); // thighs
      this.addBox(0.2, 0.26, 0.11, x, 0.42, 0.42, 0.16); // torso
    }
    // console, rear seat, parcel shelf
    this.addBox(0.1, 0.1, 0.45, 0, L.floorY + 0.1, -0.12);
    this.addBox(0.66, 0.08, 0.25, 0, -0.05, 1.0);
    this.addBox(0.66, 0.25, 0.06, 0, 0.25, 1.3, 0.25);
    this.addBox(0.68, 0.015, 0.15, 0, 0.44, 1.52);
    // steering wheel disc
    const wheel = RAPIER.ColliderDesc.cylinder(0.025, L.wheelRadius + 0.02)
      .setTranslation(L.wheelCenter.x, L.wheelCenter.y, L.wheelCenter.z)
      .setRotation(_q.setFromAxisAngle(_axis.set(1, 0, 0), Math.PI / 2 - L.wheelTilt));
    this.world.createCollider(wheel);
  }

  private buildDynamic() {
    const t = TABLET_SPEC;
    this.addDynamic(
      RAPIER.ColliderDesc.cuboid(t.hx, t.hy, t.hz).setMass(t.mass).setFriction(0.55).setRestitution(0.22),
      LAYOUT.navLap.clone(),
      TABLET_START_QUAT.clone(),
    );
    for (const o of LOOSE_OBJECTS) {
      const desc =
        o.shape === 'box'
          ? RAPIER.ColliderDesc.cuboid(o.size[0], o.size[1], o.size[2])
          : RAPIER.ColliderDesc.cylinder(o.size[1], o.size[0]);
      desc.setMass(o.mass).setFriction(0.6).setRestitution(o.name === 'water bottle' ? 0.35 : 0.2);
      this.addDynamic(desc, o.start.clone(), new THREE.Quaternion());
    }
    // flashlight: cylinder along local Z
    const f = FLASHLIGHT_SPEC;
    this.addDynamic(
      RAPIER.ColliderDesc.cylinder(f.halfLength, f.radius)
        .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2))
        .setMass(f.mass)
        .setFriction(0.6)
        .setRestitution(0.25),
      FLASHLIGHT_HOLDER.pos.clone(),
      FLASHLIGHT_HOLDER.quat.clone(),
    );
    // paper map (starts folded, inside the glovebox)
    const m = MAP_SPEC.folded;
    this.addDynamic(
      RAPIER.ColliderDesc.cuboid(m.hx, m.hy, m.hz).setMass(MAP_SPEC.mass).setFriction(0.8).setRestitution(0.05),
      GLOVEBOX_OPENING.clone(),
      new THREE.Quaternion(),
    );
    this.stowFlashlight();
    this.stowMap();
  }

  private addDynamic(desc: RAPIER.ColliderDesc, pos: THREE.Vector3, quat: THREE.Quaternion) {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation(quat)
        .setCcdEnabled(true)
        .setCanSleep(false)
        .setLinearDamping(0.15)
        .setAngularDamping(0.4),
    );
    desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(6);
    const c = this.world.createCollider(desc, body);
    const index = this.bodies.length;
    this.colliderIndex.set(c.handle, index);
    this.colliders.push(c);
    this.bodies.push(body);
    this.prevPos.push(pos.clone());
    this.currPos.push(pos.clone());
    this.prevQuat.push(quat.clone());
    this.currQuat.push(quat.clone());
    this.lastContact.push(0);
  }

  private place(i: number, pos: THREE.Vector3, quat: THREE.Quaternion) {
    const b = this.bodies[i];
    b.setTranslation(pos, true);
    b.setRotation(quat, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevPos[i].copy(pos);
    this.currPos[i].copy(pos);
    this.prevQuat[i].copy(quat);
    this.currQuat[i].copy(quat);
  }

  // --- flashlight holder ------------------------------------------------------------

  /** Clips the flashlight into its dashboard holder (kinematic: it rides with the car). */
  stowFlashlight() {
    const i = CABIN_BODY.flashlight;
    if (this.torch.index === i) this.torch.index = -1;
    this.bodies[i].setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.place(i, FLASHLIGHT_HOLDER.pos, FLASHLIGHT_HOLDER.quat);
    this.flashlightStowed = true;
  }

  private unstowFlashlight() {
    if (!this.flashlightStowed) return;
    this.bodies[CABIN_BODY.flashlight].setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.flashlightStowed = false;
  }

  // --- glovebox map ------------------------------------------------------------------

  /** The map lives in the closed glovebox: no simulation, no collisions. */
  stowMap() {
    const i = CABIN_BODY.map;
    if (this.main.index === i) this.main.index = -1;
    this.setMapOpen(false);
    this.place(i, GLOVEBOX_OPENING.clone().add(new THREE.Vector3(0, 0, -0.12)), new THREE.Quaternion());
    this.bodies[i].setEnabled(false);
    this.mapStowed = true;
  }

  private unstowMap() {
    if (!this.mapStowed) return;
    const i = CABIN_BODY.map;
    this.bodies[i].setEnabled(true);
    this.place(i, GLOVEBOX_OPENING, new THREE.Quaternion());
    this.mapStowed = false;
  }

  /** Opens / folds the paper map: the physical collider changes size too. */
  setMapOpen(open: boolean) {
    if (this.mapOpen === open) return;
    this.mapOpen = open;
    const s = open ? MAP_SPEC.open : MAP_SPEC.folded;
    this.colliders[CABIN_BODY.map].setShape(new RAPIER.Cuboid(s.hx, s.hy, s.hz));
    this.colliders[CABIN_BODY.map].setMass(MAP_SPEC.mass);
  }

  /** Puts everything back to its start position (new stage / reset). */
  reset() {
    this.releaseAll();
    const starts = [LAYOUT.navLap, ...LOOSE_OBJECTS.map((o) => o.start)];
    for (let i = 0; i < starts.length; i++) this.place(i, starts[i], i === 0 ? TABLET_START_QUAT : new THREE.Quaternion());
    this.stowFlashlight();
    this.stowMap();
    this.main.grip = 100;
  }

  canGrab(): boolean {
    return this.time >= this.regrabBlockedUntil;
  }

  /** Takes an object into the right slot (flashlight -> torch hand, everything else -> main). */
  grab(index: number): boolean {
    if (index < 0 || index >= this.bodies.length || !this.canGrab()) return false;
    if (index === CABIN_BODY.flashlight) {
      this.unstowFlashlight();
      this.torch.index = index;
      this.torch.grip = 100;
      this.torch.errorTime = 0;
      this.bodies[index].setGravityScale(0, true);
      return true;
    }
    if (index === CABIN_BODY.map) this.unstowMap();
    if (this.main.index >= 0) this.release('released', false);
    this.main.index = index;
    this.main.grip = 100;
    this.main.errorTime = 0;
    this.bodies[index].setGravityScale(0, true);
    return true;
  }

  /** Releases the main-hand object. */
  release(reason: DropReason, notify = true) {
    this.releaseSlot(this.main, reason, notify);
  }

  releaseTorch(reason: DropReason, notify = true) {
    this.releaseSlot(this.torch, reason, notify);
  }

  releaseAll() {
    this.releaseSlot(this.main, 'released', false);
    this.releaseSlot(this.torch, 'released', false);
  }

  private releaseSlot(slot: HandSlot, reason: DropReason, notify: boolean) {
    if (slot.index < 0) return;
    const i = slot.index;
    this.bodies[i].setGravityScale(1, true);
    slot.index = -1;
    if (reason !== 'released') this.regrabBlockedUntil = this.time + 0.6;
    if (notify && reason !== 'released') this.cb.dropped(i, reason);
  }

  setHoldTarget(pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.main.pos.copy(pos);
    this.main.quat.copy(quat);
  }

  setTorchTarget(pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.torch.pos.copy(pos);
    this.torch.quat.copy(quat);
  }

  /** Impact shock: `dir` points (car-local) towards where the car was hit. */
  shock(dir: THREE.Vector3, strength: number) {
    const s = Math.min(strength, 16);
    this.bodies.forEach((b, i) => {
      if (i === this.main.index || i === this.torch.index || !b.isDynamic() || !b.isEnabled()) return;
      const lv = b.linvel();
      const k = s * (0.7 + Math.random() * 0.4);
      b.setLinvel({ x: lv.x + dir.x * k, y: lv.y + dir.y * k + s * 0.15, z: lv.z + dir.z * k }, true);
      const av = b.angvel();
      b.setAngvel({ x: av.x + (Math.random() - 0.5) * s * 3, y: av.y + (Math.random() - 0.5) * s * 3, z: av.z + (Math.random() - 0.5) * s * 3 }, true);
    });
    const knock = (slot: HandSlot, factor: number, release: () => void) => {
      if (slot.index < 0) return;
      slot.grip -= s * 17 * factor;
      if (s > 6.5 / factor || slot.grip <= 0) {
        const b = this.bodies[slot.index];
        release();
        const k = s * 0.8;
        const lv = b.linvel();
        b.setLinvel({ x: lv.x + dir.x * k, y: lv.y + dir.y * k + 0.5, z: lv.z + dir.z * k }, true);
      }
    };
    knock(this.main, this.oneHanded ? 1.6 : 1, () => this.release('impact'));
    knock(this.torch, 0.6, () => this.releaseTorch('impact'));
  }

  private driveSlot(slot: HandSlot, gravity: THREE.Vector3, dt: number, maxV: number) {
    const b = this.bodies[slot.index];
    const p = b.translation();
    _v.set(slot.pos.x - p.x, slot.pos.y - p.y, slot.pos.z - p.z);
    const err = _v.length();
    // hands sway with the g-forces while holding
    _v.addScaledVector(gravity, 0.0015).add(new THREE.Vector3(0, 9.81 * 0.0015, 0));
    const lv = _v.multiplyScalar(14);
    if (lv.length() > maxV) lv.setLength(maxV);
    b.setLinvel(lv, true);
    const r = b.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _q2.copy(slot.quat).multiply(_q.invert());
    if (_q2.w < 0) _q2.set(-_q2.x, -_q2.y, -_q2.z, -_q2.w);
    const angle = 2 * Math.acos(clamp(_q2.w, -1, 1));
    const sinHalf = Math.sqrt(Math.max(1e-9, 1 - _q2.w * _q2.w));
    _axis.set(_q2.x / sinHalf, _q2.y / sinHalf, _q2.z / sinHalf);
    const w = Math.min(angle * 12, 12);
    b.setAngvel(angle > 1e-4 ? { x: _axis.x * w, y: _axis.y * w, z: _axis.z * w } : { x: 0, y: 0, z: 0 }, true);
    slot.errorTime = err > 0.22 ? slot.errorTime + dt : 0;
  }

  /** Steps the cabin with the effective gravity (car-local, m/s^2). */
  step(dt: number, gravity: THREE.Vector3) {
    this.time += dt;
    this.gravity.copy(gravity);
    this.world.gravity = { x: gravity.x, y: gravity.y, z: gravity.z };

    const horiz = Math.hypot(gravity.x, gravity.z);
    const vert = Math.abs(gravity.y + 9.81);
    const drain = Math.max(0, horiz - 4.6) * 7 + Math.max(0, vert - 6.5) * 5;
    if (this.main.index >= 0) {
      // grip drains under sustained g-forces; one hand and awkward objects drain faster
      const k = (this.oneHanded ? 1.7 : 1) * this.awkwardness;
      const d = drain * k + (this.awkwardness > 1 ? (this.awkwardness - 1) * 4 : 0);
      this.main.grip = clamp(this.main.grip - d * dt + (d === 0 ? 28 * dt : 0), 0, 100);
      if (this.main.grip <= 0) this.release('gforce');
    }
    if (this.main.index >= 0) {
      this.driveSlot(this.main, gravity, dt, 3.2);
      if (this.main.errorTime > 0.45) this.release('snag');
    }
    if (this.torch.index >= 0) {
      this.driveSlot(this.torch, gravity, dt, 4);
      if (this.torch.errorTime > 0.6) this.releaseTorch('snag');
    }

    for (let i = 0; i < this.bodies.length; i++) {
      this.prevPos[i].copy(this.currPos[i]);
      this.prevQuat[i].copy(this.currQuat[i]);
    }
    this.world.step(this.events);
    this.events.drainContactForceEvents((e) => {
      const i1 = this.colliderIndex.get(e.collider1());
      const i2 = this.colliderIndex.get(e.collider2());
      const idx = i1 ?? i2;
      if (idx === undefined) return;
      const strength = e.totalForceMagnitude();
      if (this.time - this.lastContact[idx] > 0.09 && strength > 12) {
        this.lastContact[idx] = this.time;
        this.cb.contact(idx, Math.min(1, strength / 160));
      }
    });
    this.events.drainCollisionEvents(() => undefined);
    const b = CABIN_BOUNDS;
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      if (!body.isEnabled()) continue;
      const t = body.translation();
      // safety net: anything that escaped the cabin goes back into the footwell
      if (t.x < b.minX - 0.2 || t.x > b.maxX + 0.2 || t.y < b.minY - 0.2 || t.y > b.maxY + 0.2 || t.z < b.minZ - 0.2 || t.z > b.maxZ + 0.2) {
        body.setTranslation({ x: 0.4, y: 0.0, z: -0.4 }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        if (i === this.main.index) this.release('snag');
        if (i === this.torch.index) this.releaseTorch('snag');
      }
      const r = body.rotation();
      const tt = body.translation();
      this.currPos[i].set(tt.x, tt.y, tt.z);
      this.currQuat[i].set(r.x, r.y, r.z, r.w);
    }
  }

  /** Ray pick in car-local space; returns the body index or -1. */
  pick(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { index: number; distance: number } | null {
    const ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    const hit = this.world.castRay(ray, maxDist, true, RAPIER.QueryFilterFlags.EXCLUDE_FIXED);
    if (!hit) return null;
    const index = this.colliderIndex.get(hit.collider.handle);
    if (index === undefined) return null;
    return { index, distance: hit.timeOfImpact };
  }

  /** Distance along a ray to the cabin's fixed geometry (dash, glass, seats...). */
  castStatic(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    const ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z });
    const hit = this.world.castRay(ray, maxDist, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
    return hit ? hit.timeOfImpact : maxDist;
  }

  interpolate(i: number, alpha: number, pos: THREE.Vector3, quat: THREE.Quaternion) {
    pos.lerpVectors(this.prevPos[i], this.currPos[i], alpha);
    quat.slerpQuaternions(this.prevQuat[i], this.currQuat[i], alpha);
  }

  dispose() {
    this.events.free();
    this.world.free();
  }
}

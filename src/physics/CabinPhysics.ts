// Cabin physics in the car's local frame. Effective gravity is
// (world gravity - car acceleration) rotated into the car frame, so cornering,
// braking, bumps, jumps (weightless!) and crashes throw loose objects around
// without them ever tunnelling through a fast-moving car.

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { LAYOUT } from '../cockpit/layout';
import { CABIN_BOUNDS, FIXED_DT } from '../shared/constants';
import { clamp } from '../shared/math';
import { LOOSE_OBJECTS, TABLET_SPEC } from '../tablet/cabinObjects';

export type DropReason = 'impact' | 'gforce' | 'snag' | 'released';

export interface CabinCallbacks {
  contact(index: number, strength: number): void;
  dropped(reason: DropReason): void;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _axis = new THREE.Vector3();

export class CabinPhysics {
  readonly world: RAPIER.World;
  private events: RAPIER.EventQueue;
  /** index 0 = tablet, 1.. = loose objects */
  readonly bodies: RAPIER.RigidBody[] = [];
  private colliderIndex = new Map<number, number>();
  readonly prevPos: THREE.Vector3[] = [];
  readonly prevQuat: THREE.Quaternion[] = [];
  readonly currPos: THREE.Vector3[] = [];
  readonly currQuat: THREE.Quaternion[] = [];
  held = -1;
  readonly holdPos = new THREE.Vector3();
  readonly holdQuat = new THREE.Quaternion();
  grip = 100;
  private holdErrorTime = 0;
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
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5),
    );
    for (const o of LOOSE_OBJECTS) {
      const desc =
        o.shape === 'box'
          ? RAPIER.ColliderDesc.cuboid(o.size[0], o.size[1], o.size[2])
          : RAPIER.ColliderDesc.cylinder(o.size[1], o.size[0]);
      desc.setMass(o.mass).setFriction(0.6).setRestitution(o.name === 'water bottle' ? 0.35 : 0.2);
      this.addDynamic(desc, o.start.clone(), new THREE.Quaternion());
    }
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
    this.bodies.push(body);
    this.prevPos.push(pos.clone());
    this.currPos.push(pos.clone());
    this.prevQuat.push(quat.clone());
    this.currQuat.push(quat.clone());
    this.lastContact.push(0);
  }

  /** Puts everything back to its start position (new stage / reset). */
  reset() {
    this.release('released', false);
    const starts = [LAYOUT.navLap, ...LOOSE_OBJECTS.map((o) => o.start)];
    this.bodies.forEach((b, i) => {
      const p = starts[i];
      const q = i === 0 ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5) : new THREE.Quaternion();
      b.setTranslation(p, true);
      b.setRotation(q, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.prevPos[i].copy(p);
      this.currPos[i].copy(p);
      this.prevQuat[i].copy(q);
      this.currQuat[i].copy(q);
    });
    this.grip = 100;
  }

  canGrab(): boolean {
    return this.time >= this.regrabBlockedUntil;
  }

  grab(index: number): boolean {
    if (index < 0 || index >= this.bodies.length || !this.canGrab()) return false;
    if (this.held >= 0) this.release('released', false);
    this.held = index;
    this.grip = 100;
    this.holdErrorTime = 0;
    this.bodies[index].setGravityScale(0, true);
    return true;
  }

  release(reason: DropReason, notify = true) {
    if (this.held < 0) return;
    const b = this.bodies[this.held];
    b.setGravityScale(1, true);
    const wasTablet = this.held === 0;
    this.held = -1;
    if (reason !== 'released') this.regrabBlockedUntil = this.time + 0.6;
    if (notify && wasTablet) this.cb.dropped(reason);
  }

  setHoldTarget(pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.holdPos.copy(pos);
    this.holdQuat.copy(quat);
  }

  /** Impact shock: `dir` points (car-local) towards where the car was hit. */
  shock(dir: THREE.Vector3, strength: number) {
    const s = Math.min(strength, 16);
    this.bodies.forEach((b, i) => {
      if (i === this.held) return;
      const lv = b.linvel();
      const k = s * (0.7 + Math.random() * 0.4);
      b.setLinvel({ x: lv.x + dir.x * k, y: lv.y + dir.y * k + s * 0.15, z: lv.z + dir.z * k }, true);
      const av = b.angvel();
      b.setAngvel({ x: av.x + (Math.random() - 0.5) * s * 3, y: av.y + (Math.random() - 0.5) * s * 3, z: av.z + (Math.random() - 0.5) * s * 3 }, true);
    });
    if (this.held >= 0) {
      this.grip -= s * 17;
      if (s > 6.5 || this.grip <= 0) {
        const b = this.bodies[this.held];
        this.release('impact');
        const k = s * 0.8;
        const lv = b.linvel();
        b.setLinvel({ x: lv.x + dir.x * k, y: lv.y + dir.y * k + 0.5, z: lv.z + dir.z * k }, true);
      }
    }
  }

  /** Steps the cabin with the effective gravity (car-local, m/s^2). */
  step(dt: number, gravity: THREE.Vector3) {
    this.time += dt;
    this.gravity.copy(gravity);
    this.world.gravity = { x: gravity.x, y: gravity.y, z: gravity.z };

    if (this.held >= 0) {
      // grip drains under sustained g-forces
      const horiz = Math.hypot(gravity.x, gravity.z);
      const vert = Math.abs(gravity.y + 9.81);
      const drain = Math.max(0, horiz - 4.6) * 7 + Math.max(0, vert - 6.5) * 5;
      this.grip = clamp(this.grip - drain * dt + (drain === 0 ? 28 * dt : 0), 0, 100);
      if (this.grip <= 0) this.release('gforce');
    }
    if (this.held >= 0) {
      const b = this.bodies[this.held];
      const p = b.translation();
      _v.set(this.holdPos.x - p.x, this.holdPos.y - p.y, this.holdPos.z - p.z);
      const err = _v.length();
      // hands sway with the g-forces while holding
      _v.addScaledVector(gravity, 0.0015).add(new THREE.Vector3(0, 9.81 * 0.0015, 0));
      const lv = _v.multiplyScalar(14);
      const maxV = 3.2;
      if (lv.length() > maxV) lv.setLength(maxV);
      b.setLinvel(lv, true);
      const r = b.rotation();
      _q.set(r.x, r.y, r.z, r.w);
      _q2.copy(this.holdQuat).multiply(_q.invert());
      if (_q2.w < 0) _q2.set(-_q2.x, -_q2.y, -_q2.z, -_q2.w);
      const angle = 2 * Math.acos(clamp(_q2.w, -1, 1));
      const sinHalf = Math.sqrt(Math.max(1e-9, 1 - _q2.w * _q2.w));
      _axis.set(_q2.x / sinHalf, _q2.y / sinHalf, _q2.z / sinHalf);
      const w = Math.min(angle * 12, 12);
      b.setAngvel(angle > 1e-4 ? { x: _axis.x * w, y: _axis.y * w, z: _axis.z * w } : { x: 0, y: 0, z: 0 }, true);
      this.holdErrorTime = err > 0.22 ? this.holdErrorTime + dt : 0;
      if (this.holdErrorTime > 0.45) this.release('snag');
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
      const t = body.translation();
      // safety net: anything that escaped the cabin goes back into the footwell
      if (t.x < b.minX - 0.2 || t.x > b.maxX + 0.2 || t.y < b.minY - 0.2 || t.y > b.maxY + 0.2 || t.z < b.minZ - 0.2 || t.z > b.maxZ + 0.2) {
        body.setTranslation({ x: 0.4, y: 0.0, z: -0.4 }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        if (i === this.held) this.release('snag');
      }
      const r = body.rotation();
      this.currPos[i].set(body.translation().x, body.translation().y, body.translation().z);
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

  interpolate(i: number, alpha: number, pos: THREE.Vector3, quat: THREE.Quaternion) {
    pos.lerpVectors(this.prevPos[i], this.currPos[i], alpha);
    quat.slerpQuaternions(this.prevQuat[i], this.currQuat[i], alpha);
  }

  dispose() {
    this.events.free();
    this.world.free();
  }
}

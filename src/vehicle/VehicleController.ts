// Arcade raycast vehicle on a Rapier rigid body: per-wheel spring/damper
// suspension, slip-angle tyre model with a friction circle, weight transfer,
// FWD drivetrain, handbrake, surface-dependent grip, impacts and landings.

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { PhysicsWorld, Surface } from '../physics/PhysicsWorld';
import { clamp, lerp } from '../shared/math';
import type { ImpactFx, Pose } from '../shared/types';
import { CAR_SPEC, SURFACE_GRIP, type SurfaceKind } from './carSpec';
import { Drivetrain } from './Drivetrain';

export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number; // -1 left .. +1 right
  handbrake: boolean;
  shiftUp: boolean;
  shiftDown: boolean;
  manual: boolean;
  /** 1 = both hands on the wheel, lower when a hand is busy (wiping, doors...). */
  steerAuthority: number;
}

export interface WheelState {
  grounded: boolean;
  compression: number;
  prevCompression: number;
  contact: THREE.Vector3;
  normal: THREE.Vector3;
  surface: SurfaceKind;
  hit: Surface | null;
  load: number;
  slipLat: number;
  spinning: boolean;
  spin: number; // visual rotation angle
  puddle: number;
}

export interface VehicleImpact {
  strength: number;
  /** Car-local unit vector pointing towards where the car was hit. */
  dir: THREE.Vector3;
  kind: ImpactFx['kind'];
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _r = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _mount = new THREE.Vector3();
const _wf = new THREE.Vector3();
const _ws = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _com = new THREE.Vector3();
const _f = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _steerQ = new THREE.Quaternion();

function tyreCurve(slip: number, peak: number, slide: number): number {
  const a = Math.abs(slip);
  if (a <= peak) return slip / peak;
  const t = Math.min(1, (a - peak) / (peak * 1.7));
  return Math.sign(slip) * (1 - (1 - slide) * t);
}

export class VehicleController {
  readonly body: RAPIER.RigidBody;
  readonly colliders: RAPIER.Collider[];
  readonly wheels: WheelState[];
  readonly drivetrain = new Drivetrain();
  steerAngle = 0;
  /** Filtered car-local acceleration (m/s^2), excludes gravity. */
  readonly accelLocal = new THREE.Vector3();
  readonly impacts: VehicleImpact[] = [];
  airTime = 0;
  slipAmount = 0;
  roughness = 0;
  surfaceAvg = 0;
  wheelspin = false;
  handbrake = false;
  frozen = false;
  /** Yaw torque from open doors / other effects (N*m), set by the game each step. */
  extraYawTorque = 0;
  /** Extra linear drag (bushes, open doors), N per m/s. */
  extraDrag = 0;
  puddleHit = -1;

  readonly prevPos = new THREE.Vector3();
  readonly prevQuat = new THREE.Quaternion();
  readonly currPos = new THREE.Vector3();
  readonly currQuat = new THREE.Quaternion();

  private prevVel = new THREE.Vector3();
  private airMinVy = 0;
  private wasAirborne = false;
  private lastImpactAt = -1;
  private time = 0;
  private stepImpact: VehicleImpact | null = null;
  private chassisHandles = new Set<number>();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(
    private physics: PhysicsWorld,
    pose: Pose,
    private puddleAt: (x: number, z: number) => number,
  ) {
    const s = CAR_SPEC;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pose.x, pose.y, pose.z)
      .setRotation({ x: pose.qx, y: pose.qy, z: pose.qz, w: pose.qw })
      .setAdditionalMassProperties(s.mass, s.centerOfMass, s.inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setCcdEnabled(true)
      .setAngularDamping(0.35)
      .setLinearDamping(0.02)
      .setCanSleep(false);
    const colliders = s.hulls.map(([hx, hy, hz, cx, cy, cz]) =>
      RAPIER.ColliderDesc.roundCuboid(hx - 0.08, hy - 0.08, hz - 0.08, 0.08)
        .setTranslation(cx, cy, cz)
        .setDensity(0)
        .setFriction(0.45)
        .setRestitution(0.12)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(16000),
    );
    const res = physics.addBody(desc, colliders, 'car');
    this.body = res.body;
    this.colliders = res.colliders;
    for (const c of this.colliders) this.chassisHandles.add(c.handle);
    this.wheels = s.wheels.map(() => ({
      grounded: false,
      compression: 0,
      prevCompression: 0,
      contact: new THREE.Vector3(),
      normal: new THREE.Vector3(0, 1, 0),
      surface: 'road' as SurfaceKind,
      hit: null,
      load: 0,
      slipLat: 0,
      spinning: false,
      spin: 0,
      puddle: -1,
    }));
    this.snapshotPose();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  get speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  get forwardSpeed(): number {
    const v = this.body.linvel();
    const q = this.body.rotation();
    _fwd.set(0, 0, -1).applyQuaternion(_q.set(q.x, q.y, q.z, q.w));
    return v.x * _fwd.x + v.y * _fwd.y + v.z * _fwd.z;
  }

  setPose(p: Pose, linvel?: { x: number; y: number; z: number }, angvel?: { x: number; y: number; z: number }) {
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.body.setRotation({ x: p.qx, y: p.qy, z: p.qz, w: p.qw }, true);
    this.body.setLinvel(linvel ?? { x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel(angvel ?? { x: 0, y: 0, z: 0 }, true);
    this.prevVel.set(linvel?.x ?? 0, linvel?.y ?? 0, linvel?.z ?? 0);
    this.accelLocal.set(0, 0, 0);
    for (const w of this.wheels) {
      w.compression = w.prevCompression = 0.08;
      w.grounded = false;
    }
    this.airTime = 0;
    this.wasAirborne = false;
    this.steerAngle = 0;
    this.snapshotPose();
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }

  private snapshotPose() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
  }

  /** Applies suspension, tyre, drivetrain and drag forces. Call before the world step. */
  preStep(input: DriveInput, dt: number) {
    const s = CAR_SPEC;
    const b = this.body;
    this.time += dt;
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.puddleHit = -1;

    const t = b.translation();
    const rq = b.rotation();
    const lv = b.linvel();
    const av = b.angvel();
    _q.set(rq.x, rq.y, rq.z, rq.w);
    _v.set(lv.x, lv.y, lv.z);
    _w.set(av.x, av.y, av.z);
    const com = b.worldCom();
    _com.set(com.x, com.y, com.z);
    _right.set(1, 0, 0).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    const speedFwd = _v.dot(_fwd);
    const speed = _v.length();

    // --- steering (speed sensitive, rate limited) -------------------------------
    const auth = clamp(input.steerAuthority, 0.2, 1);
    const sf = Math.pow(clamp(Math.abs(speedFwd) / 30, 0, 1), 0.8);
    const maxSteer = lerp(s.maxSteerLow, s.maxSteerHigh, sf) * auth;
    const target = this.frozen ? input.steer * s.maxSteerLow : input.steer * maxSteer;
    const towardsCentre = Math.abs(target) < Math.abs(this.steerAngle) || Math.sign(target) !== Math.sign(this.steerAngle);
    const rate = (towardsCentre ? s.steerSpeedOut : s.steerSpeedIn) * (0.55 + 0.45 * auth);
    const ds = clamp(target - this.steerAngle, -rate * dt, rate * dt);
    this.steerAngle += ds;

    // --- drivetrain ------------------------------------------------------------------
    const frontGrounded = this.wheels[0].grounded || this.wheels[1].grounded;
    const slipping = this.wheelspin || !frontGrounded;
    const dtIn = {
      throttle: this.frozen ? input.throttle : input.throttle,
      brake: input.brake,
      shiftUp: input.shiftUp,
      shiftDown: input.shiftDown,
      manual: input.manual,
    };
    let driveForce = this.drivetrain.update(dt, dtIn, speedFwd, slipping);
    let brake = this.drivetrain.brake;
    this.handbrake = input.handbrake;
    if (this.frozen) {
      driveForce = 0;
      brake = 1;
      this.handbrake = true;
    }

    // --- suspension raycasts -----------------------------------------------------
    const maxLen = s.restLength + s.wheelRadius;
    let groundedCount = 0;
    let rough = 0;
    for (let i = 0; i < 4; i++) {
      const ws = s.wheels[i];
      const w = this.wheels[i];
      _mount.set(ws.x, s.mountY, ws.z).applyQuaternion(_q).add(_pt.set(t.x, t.y, t.z));
      this.ray.origin = { x: _mount.x, y: _mount.y, z: _mount.z };
      this.ray.dir = { x: -_up.x, y: -_up.y, z: -_up.z };
      const hit = this.physics.world.castRayAndGetNormal(this.ray, maxLen, true, undefined, undefined, undefined, b);
      w.prevCompression = w.compression;
      if (hit) {
        const d = hit.timeOfImpact;
        w.grounded = true;
        w.compression = clamp(maxLen - d, 0, s.restLength);
        w.contact.copy(_mount).addScaledVector(_up, -d);
        w.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        w.hit = this.physics.surfaceOf(hit.collider.handle);
        w.surface = w.hit === 'road' ? 'road' : 'grass';
        w.puddle = w.hit === 'road' ? this.puddleAt(w.contact.x, w.contact.z) : -1;
        if (w.puddle >= 0) {
          w.surface = 'mud';
          this.puddleHit = w.puddle;
        }
        groundedCount++;
      } else {
        w.grounded = false;
        w.compression = Math.max(0, w.compression - dt * 2);
        w.hit = null;
        w.puddle = -1;
      }
      const cv = (w.compression - w.prevCompression) / dt;
      rough += Math.abs(cv);
      if (w.grounded) {
        let f = s.spring * w.compression + (cv > 0 ? s.damperBump : s.damperRebound) * cv;
        if (w.compression > s.bumpStopStart) f += (w.compression - s.bumpStopStart) * 260000;
        w.load = Math.max(0, f);
      } else w.load = 0;
    }
    this.roughness += (clamp(rough / 2.4, 0, 1) - this.roughness) * clamp(dt * 6, 0, 1);

    // --- anti-roll bars --------------------------------------------------------------
    for (const [l, r, k] of [[0, 1, s.antiRollFront], [2, 3, s.antiRollRear]] as const) {
      const wl = this.wheels[l];
      const wr = this.wheels[r];
      if (wl.grounded && wr.grounded) {
        const f = (wl.compression - wr.compression) * k;
        wl.load = Math.max(0, wl.load + f);
        wr.load = Math.max(0, wr.load - f);
      }
    }

    // --- apply suspension + tyre forces --------------------------------------------
    const cornerMass = s.mass / 4;
    let slip = 0;
    let spin = false;
    let surf = 0;
    for (let i = 0; i < 4; i++) {
      const ws = s.wheels[i];
      const w = this.wheels[i];
      w.spinning = false;
      w.slipLat = 0;
      if (!w.grounded) {
        const omega = ws.front ? (this.drivetrain.throttle * 40) : 0;
        w.spin += (speedFwd / s.wheelRadius + omega) * dt;
        continue;
      }
      _mount.set(ws.x, s.mountY, ws.z).applyQuaternion(_q).add(_pt.set(t.x, t.y, t.z));
      // suspension
      _f.copy(_up).multiplyScalar(w.load * dt);
      b.applyImpulseAtPoint(_f, _mount, true);

      // tyre frame
      if (ws.front) {
        _steerQ.setFromAxisAngle(_up, -this.steerAngle);
        _wf.copy(_fwd).applyQuaternion(_steerQ);
      } else _wf.copy(_fwd);
      const n = w.normal;
      _wf.addScaledVector(n, -_wf.dot(n)).normalize();
      _ws.crossVectors(_wf, n).normalize();
      _r.subVectors(w.contact, _com);
      _vc.crossVectors(_w, _r).add(_v);
      const vLong = _vc.dot(_wf);
      const vLat = _vc.dot(_ws);

      const grip = SURFACE_GRIP[w.surface];
      const N = Math.min(w.load, 9000);
      const mu = grip.mu * (ws.front ? 1.0 : 0.96);
      const maxF = mu * N;
      surf += w.surface === 'road' ? 0 : w.surface === 'grass' ? 1 : 2;

      // longitudinal
      let fLong = 0;
      if (ws.front) fLong += driveForce * 0.5;
      const cancel = (Math.abs(vLong) * cornerMass) / dt;
      if (brake > 0) {
        const bf = brake * (ws.front ? s.brakeFront : s.brakeRear);
        fLong -= Math.sign(vLong) * Math.min(bf, cancel);
      }
      const locked = !ws.front && this.handbrake;
      if (locked) fLong -= Math.sign(vLong) * Math.min(maxF * 0.85, cancel);
      fLong -= vLong * (14 + grip.drag * 0.25);
      if (Math.abs(fLong) > maxF) {
        if (ws.front && Math.abs(driveForce) > 1) {
          w.spinning = true;
          spin = true;
        }
        fLong = Math.sign(fLong) * maxF * 0.9;
      }

      // lateral
      const slipAngle = Math.atan2(vLat, Math.max(Math.abs(vLong), 2.6));
      const peak = ws.front ? 0.135 : 0.115;
      let latMu = mu * (locked ? 0.42 : 1) * (w.spinning ? 0.7 : 1);
      if (this.frozen) latMu = mu * 2;
      let fLat = -tyreCurve(slipAngle, peak, grip.slide) * latMu * N;
      const remaining = Math.sqrt(Math.max(0, maxF * maxF - fLong * fLong));
      const latLimit = Math.max(remaining, maxF * 0.3);
      fLat = clamp(fLat, -latLimit, latLimit);
      w.slipLat = Math.abs(vLat);
      slip += Math.abs(vLat) * 0.6 + (w.spinning ? 4 : 0) + (locked ? Math.abs(vLong) * 0.4 : 0);

      _f.copy(_wf).multiplyScalar(fLong * dt).addScaledVector(_ws, fLat * dt);
      _pt.copy(w.contact).addScaledVector(_up, s.tyreForceLift);
      b.applyImpulseAtPoint(_f, _pt, true);

      const omega = w.spinning ? 45 : locked ? 0 : vLong / s.wheelRadius;
      w.spin += omega * dt;
    }
    this.wheelspin = spin;
    this.slipAmount += (clamp(slip / 18, 0, 1) - this.slipAmount) * clamp(dt * 10, 0, 1);
    this.surfaceAvg = groundedCount ? surf / groundedCount : this.surfaceAvg;

    // --- aerodynamic + extra drag, yaw effects -------------------------------------
    const dragK = s.dragQuadratic * speed + s.dragLinear + this.extraDrag;
    _f.copy(_v).multiplyScalar(-dragK * dt);
    b.applyImpulse(_f, true);
    if (this.extraYawTorque !== 0) {
      _f.copy(_up).multiplyScalar(this.extraYawTorque * dt);
      b.applyTorqueImpulse(_f, true);
    }

    // --- air behaviour ------------------------------------------------------------------
    if (groundedCount === 0) {
      this.airTime += dt;
      this.airMinVy = Math.min(this.airMinVy, _v.y);
      // gentle pitch/roll stabilisation so jumps land wheels-down more often
      const k = 1 - clamp(dt * 0.9, 0, 1);
      _f.copy(_w).multiplyScalar(k);
      _f.y = _w.y;
      b.setAngvel(_f, true);
    }
  }

  /** Collects collision impacts / landings and updates acceleration. Call after the world step. */
  postStep(dt: number) {
    const s = CAR_SPEC;
    this.stepImpact = null;
    const rq = this.body.rotation();
    _q.set(rq.x, rq.y, rq.z, rq.w);
    this.physics.events.drainContactForceEvents((e) => {
      const h1 = e.collider1();
      const h2 = e.collider2();
      const mine1 = this.chassisHandles.has(h1);
      const mine2 = this.chassisHandles.has(h2);
      if (mine1 === mine2) return;
      const other = mine1 ? h2 : h1;
      const strength = (e.totalForceMagnitude() * dt) / s.mass;
      if (!this.stepImpact || strength > this.stepImpact.strength) {
        const d = e.maxForceDirection();
        // force on the car pushes it away from the obstacle; the hit side is the opposite
        const sign = mine1 ? -1 : 1;
        const dir = new THREE.Vector3(d.x * sign, d.y * sign, d.z * sign).applyQuaternion(_q.clone().invert());
        const surf = this.physics.surfaceOf(other);
        const kind: ImpactFx['kind'] =
          surf === 'tree' ? 'tree' : surf === 'rock' ? 'rock' : surf === 'bale' ? 'bale' : surf === 'road' || surf === 'grass' ? 'terrain' : 'other';
        this.stepImpact = { strength, dir: dir.normalize(), kind };
      }
    });
    this.physics.events.drainCollisionEvents(() => undefined);

    // (cast: TS cannot see the assignment made inside the drain callback)
    const hit = this.stepImpact as VehicleImpact | null;
    if (hit && hit.strength > 1.1 && this.time - this.lastImpactAt > 0.12) {
      this.lastImpactAt = this.time;
      this.impacts.push(hit);
    }

    // landing after a jump
    const grounded = this.wheels.filter((w) => w.grounded).length;
    if (grounded === 0) this.wasAirborne = this.airTime > 0.3;
    else {
      if (this.wasAirborne && grounded >= 2) {
        const strength = Math.max(0, -this.airMinVy) * 0.75;
        if (strength > 1.4) this.impacts.push({ strength, dir: new THREE.Vector3(0, -1, 0), kind: 'landing' });
      }
      this.wasAirborne = false;
      this.airTime = 0;
      this.airMinVy = 0;
    }

    // filtered acceleration in the car frame
    const lv = this.body.linvel();
    _v.set(lv.x, lv.y, lv.z);
    const a = _f.subVectors(_v, this.prevVel).multiplyScalar(1 / dt);
    this.prevVel.copy(_v);
    a.applyQuaternion(_q.clone().invert());
    const len = a.length();
    if (len > 32) a.multiplyScalar(32 / len);
    this.accelLocal.lerp(a, 1 - Math.exp(-dt / 0.05));
    this.snapshotPose();
  }

  interpolate(alpha: number, pos: THREE.Vector3, quat: THREE.Quaternion) {
    pos.lerpVectors(this.prevPos, this.currPos, alpha);
    quat.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
  }

  dispose() {
    this.physics.world.removeRigidBody(this.body);
  }
}

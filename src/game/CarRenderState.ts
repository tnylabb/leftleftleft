// The car state used for rendering/audio/cabin effects, filled either from the
// local vehicle simulation (driver) or from interpolated snapshots (navigator).

import * as THREE from 'three';
import { CAR, CAR_FLAG } from '../shared/snapshot';
import { CAR_SPEC } from '../vehicle/carSpec';
import type { VehicleController } from '../vehicle/VehicleController';

export class CarRenderState {
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly vel = new THREE.Vector3();
  readonly angVel = new THREE.Vector3();
  readonly accelLocal = new THREE.Vector3();
  steer = 0;
  rpm = 900;
  gear = 1;
  throttle = 0;
  brake = 0;
  flags = 0;
  headYaw = 0;
  headPitch = 0;
  slip = 0;
  surface = 0;
  rough = 0;
  wipeU = 0.5;
  wipeV = 0.5;
  readonly compression = [0.09, 0.09, 0.09, 0.09];
  readonly spin = [0, 0, 0, 0];
  limiter = false;
  /** Driver on foot (world space), from the car snapshot. */
  readonly footPos = new THREE.Vector3();
  footYaw = 0;
  footPitch = 0;
  footGrip = -1;
  footWalk = 0;
  valid = false;

  get speed(): number {
    return this.vel.length();
  }

  has(flag: number): boolean {
    return (this.flags & flag) !== 0;
  }

  /** Forward heading in the road convention (0 = -Z, positive turns right). */
  get heading(): number {
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
    return Math.atan2(f.x, -f.z);
  }

  fromVehicle(v: VehicleController, alpha: number) {
    v.interpolate(alpha, this.pos, this.quat);
    const lv = v.body.linvel();
    const av = v.body.angvel();
    this.vel.set(lv.x, lv.y, lv.z);
    this.angVel.set(av.x, av.y, av.z);
    this.accelLocal.copy(v.accelLocal);
    this.steer = v.steerAngle;
    this.rpm = v.drivetrain.rpm;
    this.gear = v.drivetrain.gear;
    this.throttle = v.drivetrain.throttle;
    this.brake = v.drivetrain.brake;
    this.slip = v.slipAmount;
    this.surface = v.surfaceAvg;
    this.rough = v.roughness;
    this.limiter = v.drivetrain.limiter;
    let flags = 0;
    if (v.handbrake) flags |= CAR_FLAG.handbrake;
    if (v.wheelspin) flags |= CAR_FLAG.wheelspin;
    if (v.drivetrain.shiftTimer > 0) flags |= CAR_FLAG.shifting;
    if (v.wheels.every((w) => !w.grounded)) flags |= CAR_FLAG.airborne;
    this.flags = (this.flags & (CAR_FLAG.horn | CAR_FLAG.wiping | CAR_FLAG.closingDoor | CAR_FLAG.driverOut)) | flags;
    for (let i = 0; i < 4; i++) {
      this.compression[i] = v.wheels[i].compression;
      this.spin[i] = v.wheels[i].spin;
    }
    this.valid = true;
  }

  fromSnapshot(b: Float32Array, dt: number) {
    this.pos.set(b[CAR.px], b[CAR.py], b[CAR.pz]);
    this.quat.set(b[CAR.qx], b[CAR.qy], b[CAR.qz], b[CAR.qw]).normalize();
    this.vel.set(b[CAR.vx], b[CAR.vy], b[CAR.vz]);
    this.angVel.set(b[CAR.wx], b[CAR.wy], b[CAR.wz]);
    this.accelLocal.set(b[CAR.ax], b[CAR.ay], b[CAR.az]);
    this.steer = b[CAR.steer];
    this.rpm = b[CAR.rpm];
    this.gear = Math.round(b[CAR.gear]);
    this.throttle = b[CAR.throttle];
    this.brake = b[CAR.brake];
    this.flags = b[CAR.flags] | 0;
    this.headYaw = b[CAR.headYaw];
    this.headPitch = b[CAR.headPitch];
    this.slip = b[CAR.slip];
    this.surface = b[CAR.surface];
    this.rough = b[CAR.rough];
    this.wipeU = b[CAR.wipeU];
    this.wipeV = b[CAR.wipeV];
    this.limiter = this.rpm > 7350 && this.throttle > 0.5;
    this.footPos.set(b[CAR.footX], b[CAR.footY], b[CAR.footZ]);
    this.footYaw = b[CAR.footYaw];
    this.footPitch = b[CAR.footPitch];
    this.footGrip = Math.round(b[CAR.footGrip]);
    this.footWalk = b[CAR.footWalk];
    // approximate wheel visuals for the remote car
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat);
    const vf = this.vel.dot(fwd);
    for (let i = 0; i < 4; i++) {
      this.spin[i] += (vf / CAR_SPEC.wheelRadius) * dt;
      this.compression[i] = 0.09 + Math.max(-0.05, Math.min(0.05, -this.accelLocal.y * 0.004));
    }
    this.valid = true;
  }

  toSnapshot(out: Float32Array, time: number, seq: number) {
    out[CAR.time] = time;
    out[CAR.px] = this.pos.x;
    out[CAR.py] = this.pos.y;
    out[CAR.pz] = this.pos.z;
    out[CAR.qx] = this.quat.x;
    out[CAR.qy] = this.quat.y;
    out[CAR.qz] = this.quat.z;
    out[CAR.qw] = this.quat.w;
    out[CAR.vx] = this.vel.x;
    out[CAR.vy] = this.vel.y;
    out[CAR.vz] = this.vel.z;
    out[CAR.wx] = this.angVel.x;
    out[CAR.wy] = this.angVel.y;
    out[CAR.wz] = this.angVel.z;
    out[CAR.ax] = this.accelLocal.x;
    out[CAR.ay] = this.accelLocal.y;
    out[CAR.az] = this.accelLocal.z;
    out[CAR.steer] = this.steer;
    out[CAR.rpm] = this.rpm;
    out[CAR.gear] = this.gear;
    out[CAR.throttle] = this.throttle;
    out[CAR.brake] = this.brake;
    out[CAR.flags] = this.flags;
    out[CAR.headYaw] = this.headYaw;
    out[CAR.headPitch] = this.headPitch;
    out[CAR.slip] = this.slip;
    out[CAR.surface] = this.surface;
    out[CAR.rough] = this.rough;
    out[CAR.wipeU] = this.wipeU;
    out[CAR.wipeV] = this.wipeV;
    out[CAR.seq] = seq;
    out[CAR.footX] = this.footPos.x;
    out[CAR.footY] = this.footPos.y;
    out[CAR.footZ] = this.footPos.z;
    out[CAR.footYaw] = this.footYaw;
    out[CAR.footPitch] = this.footPitch;
    out[CAR.footGrip] = this.footGrip;
    out[CAR.footWalk] = this.footWalk;
  }
}

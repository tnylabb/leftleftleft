// Spring-damper model of an occupant's body/head moving inside the cabin:
// leaning in corners, pushed back when accelerating, nodding when braking,
// bouncing over bumps and jolting on impacts. No random camera shake.

import * as THREE from 'three';
import { clamp } from '../shared/math';

export class CabinMotion {
  readonly offset = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private target = new THREE.Vector3();
  roll = 0;
  pitch = 0;
  yaw = 0;
  private rollVel = 0;
  private pitchVel = 0;
  private yawVel = 0;
  intensity = 1;

  constructor(private stiffness = 120, private damping = 0.42) {}

  update(dt: number, accel: THREE.Vector3) {
    const s = this.intensity;
    this.target.set(
      clamp(-accel.x * 0.0042, -0.075, 0.075) * s,
      clamp(-accel.y * 0.0032, -0.05, 0.05) * s,
      clamp(-accel.z * 0.0036, -0.06, 0.06) * s,
    );
    const k = this.stiffness;
    const c = 2 * this.damping * Math.sqrt(k);
    // semi-implicit Euler, sub-stepped for stability with large frame times
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    const rollT = clamp(accel.x * 0.006, -0.09, 0.09) * s;
    const pitchT = clamp(-accel.z * 0.004, -0.06, 0.05) * s;
    for (let i = 0; i < steps; i++) {
      this.vel.x += (k * (this.target.x - this.offset.x) - c * this.vel.x) * h;
      this.vel.y += (k * (this.target.y - this.offset.y) - c * this.vel.y) * h;
      this.vel.z += (k * (this.target.z - this.offset.z) - c * this.vel.z) * h;
      this.offset.addScaledVector(this.vel, h);
      const kr = k * 0.8;
      const cr = 2 * 0.5 * Math.sqrt(kr);
      this.rollVel += (kr * (rollT - this.roll) - cr * this.rollVel) * h;
      this.pitchVel += (kr * (pitchT - this.pitch) - cr * this.pitchVel) * h;
      this.yawVel += (kr * (0 - this.yaw) - cr * this.yawVel) * h;
      this.roll += this.rollVel * h;
      this.pitch += this.pitchVel * h;
      this.yaw += this.yawVel * h;
    }
    this.offset.x = clamp(this.offset.x, -0.12, 0.12);
    this.offset.y = clamp(this.offset.y, -0.1, 0.08);
    this.offset.z = clamp(this.offset.z, -0.12, 0.1);
  }

  /** Sharp jolt: `dir` is the car-local direction towards the impact. */
  shock(dir: THREE.Vector3, strength: number) {
    const s = Math.min(strength, 14) * this.intensity;
    this.vel.addScaledVector(dir, s * 0.07);
    this.vel.y += s * 0.012 * (dir.y < -0.5 ? -1 : 0.4);
    this.rollVel += dir.x * s * 0.16;
    this.pitchVel += dir.z * s * 0.12 + (dir.y < -0.5 ? -s * 0.08 : 0);
    this.yawVel += -dir.x * s * 0.07;
  }

  reset() {
    this.offset.set(0, 0, 0);
    this.vel.set(0, 0, 0);
    this.roll = this.pitch = this.yaw = 0;
    this.rollVel = this.pitchVel = this.yawVel = 0;
  }
}

// Hinged door simulation. Latched doors only rattle; unlatched doors swing on
// their hinge under cabin g-forces and airflow, bouncing off the hinge limits.

import { clamp } from '../shared/math';
import type { DoorSide } from '../shared/types';
import type { DoorRig } from '../vehicle/CarModel';
import type * as THREE from 'three';

const MAX_ANGLE = 1.12;
const INERTIA = 14;
const MASS_ARM = 0.65 * 24; // half door length * door mass

export interface DoorEvents {
  bang(side: DoorSide, strength: number): void;
  rattle(side: DoorSide, strength: number): void;
  slam(side: DoorSide): void;
}

export class DoorSim {
  angle = 0;
  vel = 0;
  latched = true;
  closing = false;
  private rattleTimer = 0;
  private rattleOffset = 0;

  constructor(
    readonly side: DoorSide,
    private rig: DoorRig,
    private events: DoorEvents,
  ) {}

  setOpen(open: boolean) {
    if (open && this.latched) {
      this.latched = false;
      this.closing = false;
      this.vel = 3.2; // pops open
    } else if (!open && !this.latched) {
      this.closing = true;
    }
  }

  update(dt: number, accel: THREE.Vector3, speed: number, roughness: number) {
    const s = this.side === 'left' ? -1 : 1;
    if (this.latched) {
      // rattle: small visual jitter + occasional sound on rough ground
      this.rattleTimer -= dt;
      if (roughness > 0.35 && this.rattleTimer <= 0) {
        this.rattleTimer = 0.08 + Math.random() * 0.25 / (roughness + 0.2);
        this.rattleOffset = (Math.random() - 0.5) * 0.012 * roughness;
        if (roughness > 0.5) this.events.rattle(this.side, roughness);
      }
      this.rattleOffset *= Math.exp(-dt * 30);
      this.angle = 0;
      this.vel = 0;
    } else if (this.closing) {
      this.vel = 0;
      this.angle -= dt * 3.5;
      if (this.angle <= 0) {
        this.angle = 0;
        this.latched = true;
        this.closing = false;
        this.events.slam(this.side);
      }
    } else {
      const a = this.angle;
      // fictitious forces in the car frame (see notes in the design): lateral
      // acceleration swings the door outward, braking swings it forward/open
      const lateral = -accel.x * s * Math.cos(a);
      const longitudinal = accel.z * Math.sin(a);
      const wind = -0.32 * speed * speed * Math.sin(a) * Math.cos(a) - 0.02 * speed * speed * Math.sign(a);
      const bump = (Math.random() - 0.5) * roughness * 160;
      const torque = (lateral + longitudinal) * MASS_ARM + wind + bump - this.vel * 9;
      this.vel += (torque / INERTIA) * dt;
      this.angle += this.vel * dt;
      if (this.angle > MAX_ANGLE) {
        if (this.vel > 1) this.events.bang(this.side, clamp(this.vel / 6, 0.2, 1));
        this.angle = MAX_ANGLE;
        this.vel = -this.vel * 0.3;
      } else if (this.angle < 0.02) {
        if (this.vel < -1) this.events.bang(this.side, clamp(-this.vel / 6, 0.2, 1) * 0.7);
        this.angle = 0.02;
        this.vel = Math.abs(this.vel) * 0.35;
      }
    }
    this.rig.pivot.rotation.y = s * (this.angle + this.rattleOffset);
  }
}

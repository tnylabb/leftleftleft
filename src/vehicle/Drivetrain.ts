// Front-engine, front-wheel-drive hatchback drivetrain: engine torque curve,
// five-speed gearbox with automatic (or manual) shifting and reverse logic.

import { clamp, lerp } from '../shared/math';

export const WHEEL_RADIUS = 0.3;
const RATIOS: Record<number, number> = { [-1]: -3.3, 0: 0, 1: 3.45, 2: 2.1, 3: 1.46, 4: 1.12, 5: 0.9 };
const FINAL = 4.05;
const IDLE = 900;
const REDLINE = 7000;
const EFFICIENCY = 0.86;

export interface DrivetrainInput {
  throttle: number;
  brake: number;
  shiftUp: boolean;
  shiftDown: boolean;
  manual: boolean;
}

export class Drivetrain {
  gear = 1;
  rpm = IDLE;
  shiftTimer = 0;
  /** Time spent near standstill holding brake (used to engage reverse). */
  private reverseHold = 0;
  /** Effective pedal values after reverse logic. */
  throttle = 0;
  brake = 0;
  driveForce = 0;
  limiter = false;

  reset() {
    this.gear = 1;
    this.rpm = IDLE;
    this.shiftTimer = 0;
    this.reverseHold = 0;
    this.driveForce = 0;
  }

  torque(rpm: number): number {
    const x = (rpm - 4300) / 5200;
    return clamp(152 * (1 - x * x), 70, 152);
  }

  /**
   * @param speedFwd  forward speed of the driven wheels (m/s)
   * @param slipping  driven wheels spinning or airborne
   */
  update(dt: number, inp: DrivetrainInput, speedFwd: number, slipping: boolean): number {
    let throttle = inp.throttle;
    let brake = inp.brake;

    // --- direction / reverse handling (arcade style) ------------------------------
    if (this.gear === -1) {
      if (inp.throttle > 0.1 && speedFwd > -1.0) this.gear = 1; // W pulls back into first
      else {
        throttle = inp.brake; // S drives backwards
        brake = inp.throttle; // W brakes while rolling backwards
      }
    } else if (inp.brake > 0.1 && inp.throttle < 0.1 && speedFwd < 0.6) {
      this.reverseHold += dt;
      if (this.reverseHold > 0.22) {
        this.gear = -1;
        this.shiftTimer = 0.15;
        this.reverseHold = 0;
      }
    } else this.reverseHold = 0;

    // --- shifting (downshifts use wheel-linked rpm so wheelspin can't hold a high gear)
    const wheelRpm = (Math.abs(speedFwd) / WHEEL_RADIUS) * (60 / (Math.PI * 2));
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    if (inp.manual) {
      if (inp.shiftUp && this.gear < 5 && this.gear !== -1) this.shift(this.gear + 1);
      if (inp.shiftDown && this.gear > 1) this.shift(this.gear - 1);
    } else if (this.gear >= 1 && this.shiftTimer <= 0) {
      const linkedNow = wheelRpm * (RATIOS[this.gear] ?? 0) * FINAL;
      if (this.rpm > 6450 && linkedNow > 6000 && this.gear < 5 && !slipping) this.shift(this.gear + 1);
      else if (linkedNow < 2650 && this.gear > 1) this.shift(this.gear - 1);
    }

    // --- rpm -------------------------------------------------------------------------
    const ratio = RATIOS[this.gear] ?? 0;
    const linked = wheelRpm * Math.abs(ratio) * FINAL;
    let target: number;
    if (this.shiftTimer > 0 || ratio === 0) target = lerp(IDLE + 400, REDLINE * 0.8, throttle * 0.6);
    else if (slipping) target = Math.max(linked, IDLE + throttle * (REDLINE - IDLE) * 0.95);
    else target = Math.max(linked, IDLE + throttle * 2600 * clamp(1 - wheelRpm / 400, 0, 1)); // clutch slip at launch
    const rate = target > this.rpm ? 9 : 6;
    this.rpm += (target - this.rpm) * clamp(rate * dt, 0, 1);
    this.rpm = clamp(this.rpm, IDLE * 0.9, REDLINE + 150);
    this.limiter = this.rpm > REDLINE - 30 && throttle > 0.5;

    // --- force at the wheels ---------------------------------------------------------
    let force = 0;
    if (this.shiftTimer <= 0 && ratio !== 0) {
      const tq = this.limiter ? 0 : this.torque(this.rpm) * throttle;
      force = (tq * ratio * FINAL * EFFICIENCY) / WHEEL_RADIUS;
      if (throttle < 0.05 && this.rpm > 1400) {
        // engine braking
        force -= Math.sign(speedFwd) * 260 * (this.rpm / REDLINE) * Math.min(1, Math.abs(speedFwd));
      }
    }
    if (this.gear === -1 && speedFwd < -7) force = Math.max(force, 0); // reverse speed limit
    this.throttle = throttle;
    this.brake = brake;
    this.driveForce = force;
    return force;
  }

  private shift(g: number) {
    if (g === this.gear) return;
    this.gear = g;
    this.shiftTimer = 0.2;
  }
}

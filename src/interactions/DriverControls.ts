// Driver input: keyboard / gamepad driving with smoothing, cockpit actions and
// head look (mouse with pointer lock, or a glance key in split screen).
// All keys come from core/Bindings so the Tab overlay always matches.

import { DRIVER_KEYS, type BindMode, type DriverKeys } from '../core/Bindings';
import type { Input } from '../core/Input';
import type { Settings } from '../core/Settings';
import { clamp } from '../shared/math';
import type { DriveInput } from '../vehicle/VehicleController';

/** Seconds R must be held for the emergency reset. */
export const RESET_HOLD_SECONDS = 1.2;

export class DriverControls {
  readonly keys: DriverKeys;
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = false;
  lookYaw = 0;
  lookPitch = 0;
  wiping = false;
  horn = false;
  /** One-frame action flags (consumed by the game). */
  wiperCycle = false;
  exitEnter = false;
  requestReset = false;
  closeDoor = false;
  /** 0..1 progress of holding the reset key. */
  resetHold = 0;
  private resetFired = false;
  private idleLook = 0;

  constructor(
    private input: Input,
    private settings: Settings,
    mode: BindMode,
  ) {
    this.keys = DRIVER_KEYS[mode];
  }

  private down(k: { codes: string[] } | null): boolean {
    return !!k && this.input.anyDown(...k.codes);
  }

  private pressed(k: { codes: string[] } | null): boolean {
    return !!k && this.input.anyPressed(...k.codes);
  }

  /** Actions available both in the car and on foot (exit/enter, reset). */
  private commonActions(dt: number) {
    const k = this.keys;
    if (this.pressed(k.exitEnter)) this.exitEnter = true;
    // emergency reset needs a deliberate hold
    if (this.down(k.reset) || this.input.gamepad()?.reset) {
      this.resetHold = Math.min(1, this.resetHold + dt / RESET_HOLD_SECONDS);
      if (this.resetHold >= 1 && !this.resetFired) {
        this.resetFired = true;
        this.requestReset = true;
      }
    } else {
      this.resetHold = 0;
      this.resetFired = false;
    }
  }

  /** In-car update. `onFoot` = the driver is outside (only exit/enter + reset apply here). */
  update(dt: number, enabled: boolean, mouseLook: boolean, onFoot = false) {
    const i = this.input;
    const k = this.keys;
    this.wiperCycle = this.requestReset = this.closeDoor = this.exitEnter = false;
    if (!enabled || onFoot) {
      this.throttle = this.brake = 0;
      this.steer *= 0.8;
      this.handbrake = false;
      this.wiping = false;
      this.horn = false;
      if (enabled) this.commonActions(dt);
      else this.resetHold = 0;
      return;
    }
    let targetSteer = (this.down(k.right) ? 1 : 0) - (this.down(k.left) ? 1 : 0);
    let targetThrottle = this.down(k.throttle) ? 1 : 0;
    let targetBrake = this.down(k.brake) ? 1 : 0;
    let hb = this.down(k.handbrake);
    const gp = i.gamepad();
    if (gp) {
      if (Math.abs(gp.steer) > 0.01) targetSteer = gp.steer;
      targetThrottle = Math.max(targetThrottle, gp.throttle);
      targetBrake = Math.max(targetBrake, gp.brake);
      hb = hb || gp.handbrake;
      this.lookYaw = clamp(this.lookYaw - gp.lookX * dt * 2.5, -1.9, 1.9);
    }
    const steerRate = Math.sign(targetSteer) !== Math.sign(this.steer) || targetSteer === 0 ? 9 : 6;
    this.steer += clamp(targetSteer - this.steer, -steerRate * dt, steerRate * dt);
    this.throttle += clamp(targetThrottle - this.throttle, -dt * 8, dt * 6);
    this.brake += clamp(targetBrake - this.brake, -dt * 10, dt * 8);
    this.handbrake = hb;
    this.horn = this.down(k.horn);
    this.wiping = this.down(k.handWipe);
    // one wiper sweep per press: holding V never repeats
    if (this.pressed(k.wipers)) this.wiperCycle = true;
    if (this.pressed(k.closeDoor)) this.closeDoor = true;
    this.commonActions(dt);

    // head look
    const sens = 0.0022 * this.settings.data.mouseSensitivity;
    let moved = false;
    if (mouseLook && i.pointerLocked && (i.mouseDX || i.mouseDY)) {
      this.lookYaw = clamp(this.lookYaw - i.mouseDX * sens, -1.9, 1.9);
      this.lookPitch = clamp(this.lookPitch - i.mouseDY * sens * (this.settings.data.invertY ? -1 : 1), -0.9, 0.6);
      moved = true;
    }
    if (this.down(k.glance)) {
      // glance over at the navigator's tablet
      this.lookYaw += (-1.1 - this.lookYaw) * clamp(dt * 8, 0, 1); // negative yaw = look right
      this.lookPitch += (-0.25 - this.lookPitch) * clamp(dt * 8, 0, 1);
      moved = true;
    }
    if (moved) this.idleLook = 0;
    else this.idleLook += dt;
    if (this.settings.data.recenterView && this.idleLook > (k.glance ? 0.05 : 1.4)) {
      const r = clamp(dt * 3, 0, 1);
      this.lookYaw += (0 - this.lookYaw) * r;
      this.lookPitch += (0 - this.lookPitch) * r;
    }
  }

  driveInput(steerAuthority: number): DriveInput {
    return {
      throttle: this.throttle,
      brake: this.brake,
      steer: this.steer,
      handbrake: this.handbrake,
      neutral: false,
      steerAuthority,
    };
  }
}

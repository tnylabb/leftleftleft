// Driver input: keyboard / gamepad driving with smoothing, cockpit actions and
// head look (mouse with pointer lock, or glance keys in split screen).

import type { Input } from '../core/Input';
import type { Settings } from '../core/Settings';
import { clamp } from '../shared/math';
import type { DriveInput } from '../vehicle/VehicleController';

export class DriverControls {
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = false;
  lookYaw = 0;
  lookPitch = 0;
  wiping = false;
  horn = false;
  shiftUp = false;
  shiftDown = false;
  /** One-frame action flags (consumed by the game). */
  toggleWipers = false;
  requestReset = false;
  closeDoor = false;
  private idleLook = 0;

  constructor(
    private input: Input,
    private settings: Settings,
    private split: boolean,
  ) {}

  update(dt: number, enabled: boolean, mouseLook: boolean) {
    const i = this.input;
    this.toggleWipers = this.requestReset = this.closeDoor = this.shiftUp = this.shiftDown = false;
    if (!enabled) {
      this.throttle = this.brake = 0;
      this.steer *= 0.8;
      this.handbrake = false;
      this.wiping = false;
      this.horn = false;
      return;
    }
    const left = this.split ? i.isDown('KeyA') : i.anyDown('KeyA', 'ArrowLeft');
    const right = this.split ? i.isDown('KeyD') : i.anyDown('KeyD', 'ArrowRight');
    const up = this.split ? i.isDown('KeyW') : i.anyDown('KeyW', 'ArrowUp');
    const down = this.split ? i.isDown('KeyS') : i.anyDown('KeyS', 'ArrowDown');
    let targetSteer = (right ? 1 : 0) - (left ? 1 : 0);
    let targetThrottle = up ? 1 : 0;
    let targetBrake = down ? 1 : 0;
    let hb = i.isDown('Space');
    const gp = i.gamepad();
    if (gp) {
      if (Math.abs(gp.steer) > 0.01) targetSteer = gp.steer;
      targetThrottle = Math.max(targetThrottle, gp.throttle);
      targetBrake = Math.max(targetBrake, gp.brake);
      hb = hb || gp.handbrake;
      if (gp.reset) this.requestReset = true;
      this.lookYaw = clamp(this.lookYaw - gp.lookX * dt * 2.5, -1.9, 1.9);
    }
    const steerRate = Math.sign(targetSteer) !== Math.sign(this.steer) || targetSteer === 0 ? 9 : 6;
    this.steer += clamp(targetSteer - this.steer, -steerRate * dt, steerRate * dt);
    this.throttle += clamp(targetThrottle - this.throttle, -dt * 8, dt * 6);
    this.brake += clamp(targetBrake - this.brake, -dt * 10, dt * 8);
    this.handbrake = hb;
    this.horn = i.isDown('KeyH');
    this.wiping = i.isDown('KeyC');
    if (i.wasPressed('KeyV')) this.toggleWipers = true;
    if (i.wasPressed('KeyR')) this.requestReset = true;
    if (i.wasPressed('KeyG')) this.closeDoor = true;
    if (this.settings.data.manualGearbox) {
      if (i.anyPressed('ShiftLeft', 'KeyE') && !this.split) this.shiftUp = true;
      if (i.anyPressed('ControlLeft', 'KeyQ') && !this.split) this.shiftDown = true;
      if (this.split && i.wasPressed('ShiftLeft')) this.shiftUp = true;
      if (this.split && i.wasPressed('ControlLeft')) this.shiftDown = true;
    }

    // head look
    const sens = 0.0022 * this.settings.data.mouseSensitivity;
    let moved = false;
    if (mouseLook && i.pointerLocked && (i.mouseDX || i.mouseDY)) {
      this.lookYaw = clamp(this.lookYaw - i.mouseDX * sens, -1.9, 1.9);
      this.lookPitch = clamp(this.lookPitch - i.mouseDY * sens * (this.settings.data.invertY ? -1 : 1), -0.9, 0.6);
      moved = true;
    }
    if (this.split) {
      // glance keys so the driver can look at the tablet / side windows
      const glance = (i.isDown('KeyQ') ? 1.1 : 0) - (i.isDown('KeyE') ? 1.1 : 0);
      if (glance) {
        this.lookYaw += (glance - this.lookYaw) * clamp(dt * 8, 0, 1);
        this.lookPitch += (-0.25 - this.lookPitch) * clamp(dt * 8, 0, 1);
        moved = true;
      }
    }
    if (moved) this.idleLook = 0;
    else this.idleLook += dt;
    if (this.settings.data.recenterView && this.idleLook > (this.split ? 0.05 : 1.4)) {
      const k = clamp(dt * 3, 0, 1);
      this.lookYaw += (0 - this.lookYaw) * k;
      this.lookPitch += (0 - this.lookPitch) * k;
    }
  }

  driveInput(steerAuthority: number, manual: boolean): DriveInput {
    return {
      throttle: this.throttle,
      brake: this.brake,
      steer: this.steer,
      handbrake: this.handbrake,
      shiftUp: this.shiftUp,
      shiftDown: this.shiftDown,
      manual,
      steerAuthority,
    };
  }
}

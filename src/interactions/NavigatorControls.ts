// Navigator input: mouse-driven grabbing / holding / rotating of the physical
// tablet (and loose objects), head look, leaning to reach, door and callouts.

import * as THREE from 'three';
import type { Input } from '../core/Input';
import type { Settings } from '../core/Settings';
import type { CabinPhysics } from '../physics/CabinPhysics';
import { clamp } from '../shared/math';
import type { CalloutId } from '../shared/types';
import { NAV_HOTKEYS } from '../navigation/Callouts';

export interface NavContext {
  camera: THREE.PerspectiveCamera;
  rect: { x: number; y: number; w: number; h: number };
  carRoot: THREE.Object3D;
  eyeLocal: THREE.Vector3;
  shoulderLocal: THREE.Vector3;
  cabin: CabinPhysics;
  doorHandle: THREE.Object3D | null;
  enabled: boolean;
  lastDirectional: 'left' | 'right';
}

export interface NavActions {
  callout: CalloutId | null;
  readNote: boolean;
  closeDoor: boolean;
  grabbed: number;
  released: boolean;
  cantReach: boolean;
}

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _inv = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _carQ = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _n = new THREE.Vector3();
const _x = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class NavigatorControls {
  lookYaw = 0.1;
  lookPitch = -0.55;
  holdDist = 0.44;
  yawOff = 0;
  pitchOff = 0;
  lean = 0;
  hover = -1;
  hoverReachable = false;
  hoverDoor = false;
  readonly originLocal = new THREE.Vector3();
  readonly dirLocal = new THREE.Vector3();
  readonly reachTarget = new THREE.Vector3();
  reaching = false;
  mouseInView = false;
  private looking = false;
  private tmpPos = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();
  readonly actions: NavActions = { callout: null, readNote: false, closeDoor: false, grabbed: -1, released: false, cantReach: false };

  constructor(
    private input: Input,
    private settings: Settings,
    private split: boolean,
    private canvas: HTMLCanvasElement,
  ) {}

  reach(): number {
    return 0.92 + this.lean * 0.42;
  }

  update(dt: number, ctx: NavContext) {
    const i = this.input;
    const a = this.actions;
    a.callout = null;
    a.readNote = a.closeDoor = a.released = a.cantReach = false;
    a.grabbed = -1;
    const cabin = ctx.cabin;

    // cursor in this viewport
    const r = this.canvas.getBoundingClientRect();
    const left = r.left + ctx.rect.x * r.width;
    const top = r.top + (1 - ctx.rect.y - ctx.rect.h) * r.height;
    const w = ctx.rect.w * r.width;
    const h = ctx.rect.h * r.height;
    _ndc.set(((i.mouseX - left) / w) * 2 - 1, -(((i.mouseY - top) / h) * 2 - 1));
    this.mouseInView = i.mouseSeen && Math.abs(_ndc.x) <= 1 && Math.abs(_ndc.y) <= 1;
    if (!this.mouseInView) _ndc.set(0.1, -0.35);

    if (!ctx.enabled) {
      this.lean = Math.max(0, this.lean - dt * 3);
      return;
    }

    // head look while RMB is held
    const sens = 0.0026 * this.settings.data.mouseSensitivity;
    if (i.mouseDown('right') && (this.mouseInView || this.looking)) {
      this.looking = true;
      this.lookYaw = clamp(this.lookYaw - i.mouseDX * sens, -2.0, 1.5);
      this.lookPitch = clamp(this.lookPitch - i.mouseDY * sens * (this.settings.data.invertY ? -1 : 1), -1.15, 0.7);
    } else this.looking = false;

    // tablet rotation: keys or middle-mouse drag
    const kl = this.split ? 'ArrowLeft' : 'KeyQ';
    const kr = this.split ? 'ArrowRight' : 'KeyE';
    const ku = this.split ? 'ArrowUp' : 'KeyZ';
    const kd = this.split ? 'ArrowDown' : 'KeyX';
    this.yawOff = clamp(this.yawOff + ((i.isDown(kl) ? 1 : 0) - (i.isDown(kr) ? 1 : 0)) * dt * 1.9, -1.5, 1.5);
    this.pitchOff = clamp(this.pitchOff + ((i.isDown(ku) ? 1 : 0) - (i.isDown(kd) ? 1 : 0)) * dt * 1.7, -1.3, 1.3);
    if (i.mouseDown('middle')) {
      this.yawOff = clamp(this.yawOff - i.mouseDX * 0.006, -1.5, 1.5);
      this.pitchOff = clamp(this.pitchOff - i.mouseDY * 0.006, -1.3, 1.3);
    }
    if (i.wheel && this.mouseInView) this.holdDist = clamp(this.holdDist + i.wheel * 0.035, 0.24, 0.8);

    // ray in car-local space
    ctx.camera.updateMatrixWorld();
    _ray.setFromCamera(_ndc, ctx.camera);
    _inv.copy(ctx.carRoot.matrixWorld).invert();
    this.originLocal.copy(_ray.ray.origin).applyMatrix4(_inv);
    ctx.carRoot.getWorldQuaternion(_carQ);
    this.dirLocal.copy(_ray.ray.direction).applyQuaternion(_carQ.clone().invert()).normalize();

    const hit = cabin.pick(this.originLocal, this.dirLocal, 1.7);
    this.hover = hit && hit.index !== cabin.held ? hit.index : -1;
    this.hoverReachable = false;
    if (hit) {
      const p = this.originLocal.clone().addScaledVector(this.dirLocal, hit.distance);
      this.hoverReachable = p.distanceTo(ctx.shoulderLocal) <= this.reach();
    }
    this.hoverDoor = false;
    if (ctx.doorHandle) {
      const hits = _ray.intersectObject(ctx.doorHandle, false);
      this.hoverDoor = hits.length > 0 && hits[0].distance < 1.2;
    }

    // grab / release
    if (i.mousePressed('left') && this.mouseInView) {
      if (cabin.held >= 0) {
        cabin.release('released');
        a.released = true;
      } else if (this.hoverDoor) a.closeDoor = true;
      else if (this.hover >= 0) {
        if (this.hoverReachable && cabin.grab(this.hover)) {
          a.grabbed = this.hover;
          this.holdDist = clamp(hit!.distance, 0.3, 0.62);
          this.yawOff = this.pitchOff = 0;
        } else a.cantReach = true;
      }
    }
    // F: pick up the tablet without aiming (lean further while held)
    const tabletPos = cabin.currPos[0];
    const tabletDist = tabletPos.distanceTo(ctx.shoulderLocal);
    this.reaching = false;
    if (i.isDown('KeyF') && cabin.held !== 0) {
      this.reaching = true;
      this.reachTarget.copy(tabletPos);
      this.lean = Math.min(1, this.lean + dt * 2.2);
      if (tabletDist <= this.reach() && cabin.grab(0)) {
        a.grabbed = 0;
        this.holdDist = 0.44;
        this.yawOff = this.pitchOff = 0;
      } else if (i.wasPressed('KeyF') && tabletDist > 0.92 + 0.42) a.cantReach = true;
    } else this.lean = Math.max(0, this.lean - dt * 2.5);
    if (cabin.held >= 0 && i.wasPressed('KeyF') && !a.grabbed) {
      /* F while holding does nothing (use click to drop) */
    }
    if (i.wasPressed('KeyG')) a.closeDoor = true;

    // callouts
    for (const hk of NAV_HOTKEYS) {
      if (i.wasPressed(hk.code)) {
        a.callout = hk.id === 'other' ? (ctx.lastDirectional === 'left' ? 'otherLeft' : 'otherRight') : hk.id;
      }
    }
    if (i.wasPressed(this.split ? 'Enter' : 'Space')) a.readNote = true;
  }

  /** Target pose (car-local) for the held object: follows the cursor ray. */
  holdPose(ctx: NavContext, outPos: THREE.Vector3, outQuat: THREE.Quaternion) {
    outPos.copy(ctx.eyeLocal).addScaledVector(this.dirLocal, this.holdDist);
    const toShoulder = outPos.clone().sub(ctx.shoulderLocal);
    const maxR = this.reach() * 0.95;
    if (toShoulder.length() > maxR) outPos.copy(ctx.shoulderLocal).addScaledVector(toShoulder.normalize(), maxR);
    // camera up / right in car-local space
    ctx.carRoot.getWorldQuaternion(_carQ);
    ctx.camera.getWorldQuaternion(_q);
    _q.premultiply(_carQ.invert());
    _up.set(0, 1, 0).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    // screen faces the eye, then user yaw/tilt
    _n.copy(this.dirLocal).negate();
    _n.applyAxisAngle(_up, this.yawOff).applyAxisAngle(_right, this.pitchOff).normalize();
    const u = _up.clone().addScaledVector(_n, -_up.dot(_n)).normalize();
    _x.crossVectors(u, _n).normalize();
    _m.makeBasis(_x, _n, u.clone().negate());
    outQuat.setFromRotationMatrix(_m);
    this.tmpPos.copy(outPos);
    this.tmpQuat.copy(outQuat);
  }
}

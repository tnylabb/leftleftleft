// Navigator input (in the car): mouse-driven grabbing / holding / rotating of
// the physical tablet, paper map and loose objects; the dashboard flashlight;
// pointing; head look; leaning to reach; door; callouts. Keys from core/Bindings.

import * as THREE from 'three';
import { NAV_KEYS, type BindMode, type NavKeys } from '../core/Bindings';
import type { Input } from '../core/Input';
import type { Settings } from '../core/Settings';
import type { CabinPhysics } from '../physics/CabinPhysics';
import { CABIN_BODY } from '../shared/constants';
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
  /** Car-local points the eyes converge on when the gaze passes over them (the driver's head). */
  focusPoints: THREE.Vector3[];
}

export interface NavActions {
  callout: CalloutId | null;
  readNote: boolean;
  closeDoor: boolean;
  grabbed: number;
  released: boolean;
  cantReach: boolean;
  handsFull: boolean;
  torchTaken: boolean;
  torchReturned: boolean;
  torchToggle: boolean;
  mapTaken: boolean;
  mapFold: boolean;
  exitEnter: boolean;
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
  readonly keys: NavKeys;
  lookYaw = 0.1;
  lookPitch = -0.55;
  holdDist = 0.44;
  yawOff = 0;
  pitchOff = 0;
  /** In-plane rotation of the paper map (the map is north-up, the car is not). */
  spinOff = 0;
  lean = 0;
  hover = -1;
  hoverReachable = false;
  hoverDoor = false;
  pointing = false;
  readonly originLocal = new THREE.Vector3();
  readonly dirLocal = new THREE.Vector3();
  readonly reachTarget = new THREE.Vector3();
  reaching = false;
  mouseInView = false;
  private looking = false;
  readonly actions: NavActions = {
    callout: null, readNote: false, closeDoor: false, grabbed: -1, released: false, cantReach: false, handsFull: false,
    torchTaken: false, torchReturned: false, torchToggle: false, mapTaken: false, mapFold: false, exitEnter: false,
  };

  constructor(
    private input: Input,
    private settings: Settings,
    mode: BindMode,
    private canvas: HTMLCanvasElement,
  ) {
    this.keys = NAV_KEYS[mode];
  }

  reach(): number {
    return 0.92 + this.lean * 0.42;
  }

  private down(k: { codes: string[] } | null): boolean {
    return !!k && this.input.anyDown(...k.codes);
  }

  private pressed(k: { codes: string[] } | null): boolean {
    return !!k && this.input.anyPressed(...k.codes);
  }

  private resetActions() {
    const a = this.actions;
    a.callout = null;
    a.readNote = a.closeDoor = a.released = a.cantReach = a.handsFull = false;
    a.torchTaken = a.torchReturned = a.torchToggle = a.mapTaken = a.mapFold = a.exitEnter = false;
    a.grabbed = -1;
  }

  /** On foot only exit/enter is read here (movement is handled by the on-foot controller). */
  updateOnFoot() {
    this.resetActions();
    this.pointing = false;
    this.lean = 0;
    if (this.pressed(this.keys.exitEnter)) this.actions.exitEnter = true;
  }

  update(dt: number, ctx: NavContext) {
    const i = this.input;
    const a = this.actions;
    const k = this.keys;
    this.resetActions();
    const cabin = ctx.cabin;

    // cursor in this viewport
    const r = this.canvas.getBoundingClientRect();
    const left = r.left + ctx.rect.x * r.width;
    const top = r.top + (1 - ctx.rect.y - ctx.rect.h) * r.height;
    const w = ctx.rect.w * r.width;
    const h = ctx.rect.h * r.height;
    _ndc.set(((i.mouseX - left) / w) * 2 - 1, -(((i.mouseY - top) / h) * 2 - 1));
    this.mouseInView = i.mouseSeen && !i.pointerLocked && Math.abs(_ndc.x) <= 1 && Math.abs(_ndc.y) <= 1;
    if (!this.mouseInView) _ndc.set(0.1, -0.35);

    if (!ctx.enabled) {
      this.lean = Math.max(0, this.lean - dt * 3);
      this.pointing = false;
      return;
    }

    // head look while RMB is held
    const sens = 0.0026 * this.settings.data.mouseSensitivity;
    if (i.mouseDown('right') && (this.mouseInView || this.looking)) {
      this.looking = true;
      this.lookYaw = clamp(this.lookYaw - i.mouseDX * sens, -2.0, 1.5);
      this.lookPitch = clamp(this.lookPitch - i.mouseDY * sens * (this.settings.data.invertY ? -1 : 1), -1.15, 0.7);
    } else this.looking = false;

    // rotate the held object: the map spins in its own plane, everything else turns
    const isMap = cabin.held === CABIN_BODY.map;
    const turn = ((this.down(k.turnLeft) ? 1 : 0) - (this.down(k.turnRight) ? 1 : 0)) * dt;
    if (isMap) this.spinOff = (this.spinOff + turn * 2.2) % (Math.PI * 2);
    else this.yawOff = clamp(this.yawOff + turn * 1.9, -1.5, 1.5);
    this.pitchOff = clamp(this.pitchOff + ((this.down(k.tiltUp) ? 1 : 0) - (this.down(k.tiltDown) ? 1 : 0)) * dt * 1.7, -1.3, 1.3);
    if (i.mouseDown('middle')) {
      if (isMap) this.spinOff -= i.mouseDX * 0.008;
      else this.yawOff = clamp(this.yawOff - i.mouseDX * 0.006, -1.5, 1.5);
      this.pitchOff = clamp(this.pitchOff - i.mouseDY * 0.006, -1.3, 1.3);
    }
    if (i.wheel && this.mouseInView) this.holdDist = clamp(this.holdDist + i.wheel * 0.035, 0.24, 0.8);

    // pointing: hold the key, aim by looking
    this.pointing = this.down(k.point);

    // ray in car-local space
    ctx.camera.updateMatrixWorld();
    _ray.setFromCamera(_ndc, ctx.camera);
    _inv.copy(ctx.carRoot.matrixWorld).invert();
    this.originLocal.copy(_ray.ray.origin).applyMatrix4(_inv);
    ctx.carRoot.getWorldQuaternion(_carQ);
    this.dirLocal.copy(_ray.ray.direction).applyQuaternion(_carQ.clone().invert()).normalize();

    const hit = cabin.pick(this.originLocal, this.dirLocal, 1.7);
    this.hover = hit && hit.index !== cabin.held && !(hit.index === CABIN_BODY.flashlight && cabin.torchHeld) ? hit.index : -1;
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
    const reachable = (index: number) => cabin.currPos[index].distanceTo(ctx.shoulderLocal) <= this.reach();

    // left click: grab / release (not while pointing - the right hand is busy)
    if (i.mousePressed('left') && this.mouseInView && !this.pointing) {
      if (cabin.held >= 0) {
        cabin.release('released');
        a.released = true;
      } else if (this.hoverDoor) a.closeDoor = true;
      else if (this.hover === CABIN_BODY.flashlight) {
        if (this.hoverReachable && cabin.grab(CABIN_BODY.flashlight)) a.torchTaken = true;
        else a.cantReach = true;
      } else if (this.hover >= 0) {
        if (this.hoverReachable && cabin.grab(this.hover)) {
          a.grabbed = this.hover;
          this.holdDist = clamp(hit!.distance, 0.3, 0.62);
          this.yawOff = this.pitchOff = 0;
        } else a.cantReach = true;
      }
    }

    // tablet pickup without aiming (hold to lean further)
    const tabletPos = cabin.currPos[CABIN_BODY.tablet];
    const tabletDist = tabletPos.distanceTo(ctx.shoulderLocal);
    this.reaching = false;
    if (this.down(k.tabletPickup) && cabin.held !== CABIN_BODY.tablet) {
      if (cabin.held >= 0) {
        if (this.pressed(k.tabletPickup)) a.handsFull = true;
      } else {
        this.reaching = true;
        this.reachTarget.copy(tabletPos);
        this.lean = Math.min(1, this.lean + dt * 2.2);
        if (tabletDist <= this.reach() && cabin.grab(CABIN_BODY.tablet)) {
          a.grabbed = CABIN_BODY.tablet;
          this.holdDist = 0.44;
          this.yawOff = this.pitchOff = 0;
        } else if (this.pressed(k.tabletPickup) && tabletDist > 0.92 + 0.42) a.cantReach = true;
      }
    } else this.lean = Math.max(0, this.lean - dt * 2.5);

    // flashlight: take from / return to the dashboard holder
    if (this.pressed(k.flashlight)) {
      if (cabin.torchHeld) {
        cabin.stowFlashlight();
        a.torchReturned = true;
      } else if (cabin.flashlightStowed || reachable(CABIN_BODY.flashlight)) {
        if (cabin.grab(CABIN_BODY.flashlight)) a.torchTaken = true;
      } else a.cantReach = true;
    }
    if (this.pressed(k.flashlightToggle) && (cabin.torchHeld || cabin.flashlightStowed || reachable(CABIN_BODY.flashlight))) {
      a.torchToggle = true;
    }

    // paper map: take it from the glovebox, then fold / unfold it
    if (this.pressed(k.map)) {
      if (cabin.held === CABIN_BODY.map) a.mapFold = true;
      else if (cabin.held >= 0) a.handsFull = true;
      else if (cabin.mapStowed || reachable(CABIN_BODY.map)) {
        if (cabin.grab(CABIN_BODY.map)) {
          a.mapTaken = true;
          a.grabbed = CABIN_BODY.map;
          this.holdDist = 0.4;
          this.yawOff = this.pitchOff = 0;
        }
      } else a.cantReach = true;
    }

    if (this.pressed(k.closeDoor)) a.closeDoor = true;
    if (this.pressed(k.exitEnter)) a.exitEnter = true;

    // callouts
    for (const hk of NAV_HOTKEYS) {
      if (i.wasPressed(hk.code)) {
        a.callout = hk.id === 'other' ? (ctx.lastDirectional === 'left' ? 'otherLeft' : 'otherRight') : hk.id;
      }
    }
    if (this.pressed(k.readNote)) a.readNote = true;
  }

  /** Camera up/right/forward in car-local space. */
  private cameraAxes(ctx: NavContext) {
    ctx.carRoot.getWorldQuaternion(_carQ);
    ctx.camera.getWorldQuaternion(_q);
    _q.premultiply(_carQ.invert());
    _up.set(0, 1, 0).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    return { up: _up.clone(), right: _right.clone(), forward: new THREE.Vector3(0, 0, -1).applyQuaternion(_q) };
  }

  /** Target pose (car-local) for the main-hand object: follows the cursor ray. */
  holdPose(ctx: NavContext, outPos: THREE.Vector3, outQuat: THREE.Quaternion, oneHanded = false) {
    outPos.copy(ctx.eyeLocal).addScaledVector(this.dirLocal, this.holdDist);
    const axes = this.cameraAxes(ctx);
    // held in the left hand only: shift towards the left hand
    if (oneHanded) outPos.addScaledVector(axes.right, -0.06);
    const toShoulder = outPos.clone().sub(ctx.shoulderLocal);
    const maxR = this.reach() * 0.95;
    if (toShoulder.length() > maxR) outPos.copy(ctx.shoulderLocal).addScaledVector(toShoulder.normalize(), maxR);
    // screen / paper faces the eye, then user yaw/tilt (+ in-plane spin for the map)
    _n.copy(this.dirLocal).negate();
    _n.applyAxisAngle(axes.up, this.yawOff).applyAxisAngle(axes.right, this.pitchOff).normalize();
    const u = axes.up.clone().addScaledVector(_n, -axes.up.dot(_n)).normalize();
    _x.crossVectors(u, _n).normalize();
    _m.makeBasis(_x, _n, u.clone().negate());
    outQuat.setFromRotationMatrix(_m);
    if (ctx.cabin.held === CABIN_BODY.map && this.spinOff) {
      outQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.spinOff));
    }
  }

  /** Where the pointing hand goes: along the look direction, stopped short of the dash / glass. */
  pointTarget(ctx: NavContext, out: THREE.Vector3): THREE.Vector3 {
    const dir = this.cameraAxes(ctx).forward;
    const free = ctx.cabin.castStatic(ctx.shoulderLocal, dir, 0.75);
    const len = clamp(free - 0.08, 0.28, 0.6);
    return out.copy(ctx.shoulderLocal).addScaledVector(dir, len);
  }

  /**
   * Flashlight pose (car-local) in the right hand. Pointing: the beam follows the
   * pointing arm. Otherwise the hand rests low and aims at what the cursor
   * points at - e.g. the tablet held in the other hand.
   */
  torchPose(ctx: NavContext, mainTarget: THREE.Vector3 | null, outPos: THREE.Vector3, outQuat: THREE.Quaternion) {
    const axes = this.cameraAxes(ctx);
    let aimAt: THREE.Vector3;
    if (this.pointing) {
      this.pointTarget(ctx, outPos);
      aimAt = outPos.clone().addScaledVector(axes.forward, 2);
    } else {
      outPos.copy(ctx.eyeLocal).addScaledVector(axes.forward, 0.3).addScaledVector(axes.right, 0.15).addScaledVector(axes.up, -0.17);
      aimAt = mainTarget ? mainTarget.clone() : ctx.eyeLocal.clone().addScaledVector(this.dirLocal, 2.5);
      if (!mainTarget) {
        // the beam converges on whatever the navigator is looking at up close
        for (const f of ctx.focusPoints) {
          const rel = f.clone().sub(ctx.eyeLocal);
          const along = rel.dot(this.dirLocal);
          if (along > 0.2 && rel.addScaledVector(this.dirLocal, -along).length() < 0.22) {
            aimAt = f.clone();
            break;
          }
        }
      }
    }
    const dir = aimAt.sub(outPos).normalize();
    // flashlight local -Z points along `dir`
    _m.lookAt(new THREE.Vector3(0, 0, 0), dir, axes.up);
    outQuat.setFromRotationMatrix(_m);
  }
}

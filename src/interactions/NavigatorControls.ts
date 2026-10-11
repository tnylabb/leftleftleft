// Navigator input (in the car): free mouse look (pointer lock, like the
// driver), grabbing / holding / rotating the physical tablet and loose objects
// with a centre crosshair, the head lamp, pointing, leaning to reach, door,
// callouts. Without pointer lock the old cursor mode still works (hold right
// mouse to look). Keys from core/Bindings.

import * as THREE from 'three';
import { NAV_KEYS, type BindMode, type NavKeys } from '../core/Bindings';
import type { Input } from '../core/Input';
import type { Settings } from '../core/Settings';
import type { CabinPhysics } from '../physics/CabinPhysics';
import { CABIN_BODY } from '../shared/constants';
import { clamp } from '../shared/math';
import type { AnimalKind, CalloutId } from '../shared/types';
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
  /** What is on the road ahead (for the animal callout key). */
  animalAhead: AnimalKind | null;
}

export interface NavActions {
  callout: CalloutId | null;
  readNote: boolean;
  closeDoor: boolean;
  grabbed: number;
  released: boolean;
  cantReach: boolean;
  handsFull: boolean;
  headlampToggle: boolean;
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
  lean = 0;
  /** Interacting through the centre crosshair (mouse captured) rather than a free cursor. */
  crosshair = false;
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
    headlampToggle: false, exitEnter: false,
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
    a.headlampToggle = a.exitEnter = false;
    a.grabbed = -1;
  }

  /** On foot only exit/enter and the head lamp are read here (movement is the on-foot controller's). */
  updateOnFoot() {
    this.resetActions();
    this.pointing = false;
    this.lean = 0;
    if (this.pressed(this.keys.exitEnter)) this.actions.exitEnter = true;
    if (this.pressed(this.keys.headlamp)) this.actions.headlampToggle = true;
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
    this.crosshair = i.pointerLocked;
    if (this.crosshair) {
      // mouse captured: interact with whatever is under the centre crosshair
      _ndc.set(0, 0);
      this.mouseInView = true;
    } else {
      _ndc.set(((i.mouseX - left) / w) * 2 - 1, -(((i.mouseY - top) / h) * 2 - 1));
      this.mouseInView = i.mouseSeen && Math.abs(_ndc.x) <= 1 && Math.abs(_ndc.y) <= 1;
      if (!this.mouseInView) _ndc.set(0.1, -0.35);
    }

    if (!ctx.enabled) {
      this.lean = Math.max(0, this.lean - dt * 3);
      this.pointing = false;
      return;
    }

    // head look: free mouse look while captured (middle-drag rotates the held
    // object instead); without capture, look while the right button is held
    const sens = 0.0024 * this.settings.data.mouseSensitivity;
    const rotating = i.mouseDown('middle');
    const look = this.crosshair ? !rotating : i.mouseDown('right') && (this.mouseInView || this.looking);
    this.looking = look && !this.crosshair;
    if (look) {
      this.lookYaw = clamp(this.lookYaw - i.mouseDX * sens, -2.0, 1.9);
      this.lookPitch = clamp(this.lookPitch - i.mouseDY * sens * (this.settings.data.invertY ? -1 : 1), -1.2, 0.75);
    }

    // rotate the held object
    const turn = ((this.down(k.turnLeft) ? 1 : 0) - (this.down(k.turnRight) ? 1 : 0)) * dt;
    this.yawOff = clamp(this.yawOff + turn * 1.9, -1.5, 1.5);
    this.pitchOff = clamp(this.pitchOff + ((this.down(k.tiltUp) ? 1 : 0) - (this.down(k.tiltDown) ? 1 : 0)) * dt * 1.7, -1.3, 1.3);
    if (rotating) {
      this.yawOff = clamp(this.yawOff - i.mouseDX * 0.006, -1.5, 1.5);
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
    // left click: grab / release (not while pointing - the right hand is busy)
    if (i.mousePressed('left') && this.mouseInView && !this.pointing) {
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

    if (this.pressed(k.headlamp)) a.headlampToggle = true;
    if (this.pressed(k.closeDoor)) a.closeDoor = true;
    if (this.pressed(k.exitEnter)) a.exitEnter = true;

    // callouts
    for (const hk of NAV_HOTKEYS) {
      if (i.wasPressed(hk.code)) {
        a.callout = hk.id === 'other' ? (ctx.lastDirectional === 'left' ? 'otherLeft' : 'otherRight') : hk.id === 'animal' ? ctx.animalAhead ?? 'cow' : hk.id;
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
    // screen faces the eye, then user yaw / tilt
    _n.copy(this.dirLocal).negate();
    _n.applyAxisAngle(axes.up, this.yawOff).applyAxisAngle(axes.right, this.pitchOff).normalize();
    const u = axes.up.clone().addScaledVector(_n, -axes.up.dot(_n)).normalize();
    _x.crossVectors(u, _n).normalize();
    _m.makeBasis(_x, _n, u.clone().negate());
    outQuat.setFromRotationMatrix(_m);
  }

  /** Where the pointing hand goes: along the look direction, stopped short of the dash / glass. */
  pointTarget(ctx: NavContext, out: THREE.Vector3): THREE.Vector3 {
    const dir = this.cameraAxes(ctx).forward;
    const free = ctx.cabin.castStatic(ctx.shoulderLocal, dir, 0.75);
    const len = clamp(free - 0.08, 0.28, 0.6);
    return out.copy(ctx.shoulderLocal).addScaledVector(dir, len);
  }

}

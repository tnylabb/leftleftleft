// First-person camera rig for a seat: eye position + spring body sway + head look.

import * as THREE from 'three';
import { CabinMotion } from '../cockpit/CabinMotion';
import { LAYOUT } from '../cockpit/layout';
import { LAYER } from '../rendering/layers';
import type { Role } from '../shared/types';

export class SeatView {
  readonly rig = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  readonly motion: CabinMotion;
  readonly eyeLocal = new THREE.Vector3();
  private base: THREE.Vector3;
  lean = 0;

  constructor(
    readonly role: Role,
    parent: THREE.Object3D,
    fov: number,
  ) {
    this.base = role === 'driver' ? LAYOUT.driverEye.clone() : LAYOUT.navEye.clone();
    // far plane just past the fog end: anything further is invisible anyway
    this.camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.035, 580);
    this.camera.layers.enable(LAYER.COCKPIT);
    this.camera.layers.enable(role === 'driver' ? LAYER.NAV_BODY : LAYER.DRIVER_BODY);
    this.rig.add(this.camera);
    parent.add(this.rig);
    this.motion = new CabinMotion(role === 'driver' ? 130 : 105, role === 'driver' ? 0.45 : 0.38);
  }

  setFov(fov: number) {
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  update(dt: number, accelLocal: THREE.Vector3, yaw: number, pitch: number) {
    this.motion.update(dt, accelLocal);
    // leaning over towards the driver's side / footwell to reach things
    const leanOffset = new THREE.Vector3(-0.22, -0.12, -0.12).multiplyScalar(this.lean);
    this.eyeLocal.copy(this.base).add(this.motion.offset).add(leanOffset);
    this.rig.position.copy(this.eyeLocal);
    const m = this.motion;
    this.camera.rotation.set(pitch + m.pitch, yaw + m.yaw, m.roll, 'YXZ');
  }
}

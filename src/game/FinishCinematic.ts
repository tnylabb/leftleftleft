// Cinematic stage finish: the camera eases out of the occupant's eye to a low
// chase angle beside the car and slowly swings around it while the car rolls
// to a stop. Purely visual: the physics timestep is never changed.

import * as THREE from 'three';

const PULLBACK_SECONDS = 2.6;
export const CINEMATIC_SECONDS = 4.2;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class FinishCinematic {
  readonly camera: THREE.PerspectiveCamera;
  private t = 0;
  private startPos = new THREE.Vector3();
  private startQuat = new THREE.Quaternion();
  private startFov: number;
  private side: number;
  /** Spring-arm length (0..1 of the full distance), shortened when something blocks the shot. */
  private arm = 1;

  constructor(from: THREE.PerspectiveCamera) {
    from.updateMatrixWorld();
    from.getWorldPosition(this.startPos);
    from.getWorldQuaternion(this.startQuat);
    this.startFov = from.fov;
    this.camera = new THREE.PerspectiveCamera(from.fov, from.aspect, 0.05, 580);
    this.camera.layers.enableAll();
    this.camera.position.copy(this.startPos);
    this.camera.quaternion.copy(this.startQuat);
    this.side = Math.random() < 0.5 ? -1 : 1;
  }

  get elapsed(): number {
    return this.t;
  }

  get done(): boolean {
    return this.t >= CINEMATIC_SECONDS;
  }

  /**
   * Advances the shot; `carPos`/`carQuat` are the (still moving) car's pose.
   * `clearance(from, to)` returns the unobstructed fraction of that segment (trees, hills).
   */
  update(dt: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion, clearance?: (from: THREE.Vector3, to: THREE.Vector3) => number) {
    this.t += dt;
    // the destination keeps orbiting slowly behind the car, staying near the road
    const orbit = this.side * (0.45 + this.t * 0.12);
    const offset = new THREE.Vector3(Math.sin(orbit) * 6.2, 1.8 + this.t * 0.2, Math.cos(orbit) * 6.2).applyQuaternion(carQuat);
    const look = carPos.clone().add(new THREE.Vector3(0, 0.55, 0));
    let destPos = carPos.clone().add(offset);
    if (clearance) {
      // spring arm: pull in quickly when the view would be blocked, ease back out
      const free = Math.max(0.3, clearance(look, destPos));
      this.arm += (free - this.arm) * Math.min(1, dt * (free < this.arm ? 12 : 2));
      destPos = look.clone().lerp(destPos, this.arm);
    }
    const destQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(destPos, look, new THREE.Vector3(0, 1, 0)));
    const k = ease(Math.min(1, this.t / PULLBACK_SECONDS));
    this.camera.position.lerpVectors(this.startPos, destPos, k);
    this.camera.quaternion.slerpQuaternions(this.startQuat, destQuat, k);
    const fov = this.startFov + (48 - this.startFov) * k;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** The start of the pullback follows the car (the occupant's eye moves with it). */
  trackStart(eyeWorld: THREE.Vector3) {
    if (this.t < PULLBACK_SECONDS) this.startPos.copy(eyeWorld);
  }
}

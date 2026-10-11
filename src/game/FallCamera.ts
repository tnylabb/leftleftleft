// Third-person view while the car goes over an edge: the camera eases out of
// the occupant's eyes to a spot above and uphill of the car (roughly where it
// left the road) and follows the tumble from there. It never rolls with the
// car, so the crash stays readable. Purely visual: physics is untouched.

import * as THREE from 'three';

const EASE_SECONDS = 0.7;
const PATCH = [[0, 0], [2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5], [1.8, 1.8], [-1.8, 1.8], [1.8, -1.8], [-1.8, -1.8]];
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class FallCamera {
  readonly camera: THREE.PerspectiveCamera;
  private t = 0;
  private startPos = new THREE.Vector3();
  private startQuat = new THREE.Quaternion();
  private startFov: number;
  /** Where the car went over (the camera stays on that side of it). */
  private anchor = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private arm = 1;

  constructor(from: THREE.PerspectiveCamera, carPos: THREE.Vector3, edge: THREE.Vector3) {
    from.updateMatrixWorld();
    from.getWorldPosition(this.startPos);
    from.getWorldQuaternion(this.startQuat);
    this.startFov = from.fov;
    this.camera = new THREE.PerspectiveCamera(from.fov, from.aspect, 0.05, 900);
    this.camera.layers.enableAll();
    this.camera.position.copy(this.startPos);
    this.camera.quaternion.copy(this.startQuat);
    this.anchor.copy(edge);
    this.pos.copy(this.startPos);
    this.look.copy(carPos);
  }

  get elapsed(): number {
    return this.t;
  }

  /**
   * @param groundY terrain height under a point (keeps the camera above ground)
   * @param clearance unobstructed fraction of a camera segment (trees, terrain)
   */
  update(
    dt: number,
    carPos: THREE.Vector3,
    groundY: (x: number, z: number) => number,
    clearance: (from: THREE.Vector3, to: THREE.Vector3) => number,
  ) {
    this.t += dt;
    // uphill of the car, back towards the edge it went over, a little higher as it falls further
    const away = new THREE.Vector3(this.anchor.x - carPos.x, 0, this.anchor.z - carPos.z);
    const horiz = away.length();
    if (horiz < 1e-3) away.set(0, 0, 1);
    else away.multiplyScalar(1 / horiz);
    const drop = Math.max(0, this.anchor.y - carPos.y);
    const dist = Math.min(15, 8 + drop * 0.12);
    const desired = carPos.clone().addScaledVector(away, dist);
    desired.y = Math.max(carPos.y + 4 + drop * 0.08, groundY(desired.x, desired.z) + 1.5);
    // spring arm: pull in when trees or the hillside would hide the car
    const target = carPos.clone().add(new THREE.Vector3(0, 0.6, 0));
    const free = Math.max(0.35, clearance(target, desired));
    this.arm += (free - this.arm) * Math.min(1, dt * (free < this.arm ? 10 : 2));
    desired.lerpVectors(target, desired, this.arm);
    desired.y = Math.max(desired.y, groundY(desired.x, desired.z) + 1.2);
    // smooth follow (no shaking, no rolling with the car), always well clear of the
    // faceted hillside: the highest ground in a small patch around the camera
    this.pos.lerp(desired, 1 - Math.exp(-dt * 3.2));
    let floor = -Infinity;
    for (const [ox, oz] of PATCH) floor = Math.max(floor, groundY(this.pos.x + ox, this.pos.z + oz));
    this.pos.y = Math.max(this.pos.y, floor + 1.8);
    this.look.lerp(target, 1 - Math.exp(-dt * 7));
    const lookQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(this.pos, this.look, new THREE.Vector3(0, 1, 0)));
    // ease out of the occupant's eyes
    const k = ease(Math.min(1, this.t / EASE_SECONDS));
    this.camera.position.lerpVectors(this.startPos, this.pos, k);
    this.camera.quaternion.slerpQuaternions(this.startQuat, lookQuat, k);
    const fov = this.startFov + (58 - this.startFov) * k;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** The start of the ease follows the car (the occupant's eye moves with it). */
  trackStart(eyeWorld: THREE.Vector3, eyeQuat: THREE.Quaternion) {
    if (this.t < EASE_SECONDS) {
      this.startPos.copy(eyeWorld);
      this.startQuat.copy(eyeQuat);
    }
  }
}

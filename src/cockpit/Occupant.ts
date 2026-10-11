// Driver / navigator bodies: helmeted head + torso (hidden from their own
// camera) and two-bone IK arms with chunky polygonal hands (always visible).

import * as THREE from 'three';
import { CrewHead, seatedTorso, suitOf } from '../rendering/crew';
import { GeoBuilder, mat, placeBetween, setLayer } from '../rendering/geometry';
import { LAYER } from '../rendering/layers';
import { lambert, vertexColored } from '../rendering/materials';
import { SKINS, type PlayerStyle } from '../shared/style';
import { LAYOUT } from './layout';

const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _m = new THREE.Matrix4();

function limbGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.5, 0.42, 1, 6);
  g.translate(0, 0.5, 0);
  return g;
}

/** Fist with the index finger extended along +Z (the pointing direction). */
function pointingHandGeometry(glove: number, cuff: number): THREE.BufferGeometry {
  return new GeoBuilder()
    .add(new THREE.BoxGeometry(0.08, 0.04, 0.085), glove, mat(0, -0.004, 0.042), { shade: 0.1 })
    .add(new THREE.BoxGeometry(0.07, 0.04, 0.035), glove, mat(0.004, -0.02, 0.085, 0.6, 0, 0), { shade: 0.1 })
    .add(new THREE.BoxGeometry(0.019, 0.019, 0.085), glove, mat(-0.026, 0.004, 0.12), { shade: 0.1 })
    .add(new THREE.BoxGeometry(0.024, 0.026, 0.05), glove, mat(0.044, 0.004, 0.05, 0, -0.4, 0.3), { shade: 0.1 })
    .add(new THREE.BoxGeometry(0.075, 0.05, 0.03), cuff, mat(0, 0, -0.005))
    .build();
}

function handGeometry(glove: number, cuff: number): THREE.BufferGeometry {
  return new GeoBuilder()
    .add(new THREE.BoxGeometry(0.085, 0.032, 0.09), glove, mat(0, 0, 0.045), { shade: 0.1 })
    .add(new THREE.BoxGeometry(0.082, 0.036, 0.055), glove, mat(0, -0.02, 0.1, 0.9, 0, 0), { shade: 0.1 })
    .add(new THREE.BoxGeometry(0.026, 0.028, 0.06), glove, mat(0.05, -0.012, 0.035, 0, -0.5, 0.4), { shade: 0.1 })
    .add(new THREE.BoxGeometry(0.075, 0.05, 0.03), cuff, mat(0, 0, -0.005))
    .build();
}

export class Arm {
  readonly upper: THREE.Mesh;
  readonly fore: THREE.Mesh;
  readonly elbowJoint: THREE.Mesh;
  readonly hand: THREE.Mesh;
  readonly pointHand: THREE.Mesh;
  private pointing = false;
  readonly wrist = new THREE.Vector3();
  readonly elbow = new THREE.Vector3();

  constructor(parent: THREE.Object3D, sleeve: number, glove: number, cuff: number, mirror: boolean) {
    const limb = limbGeometry();
    this.upper = new THREE.Mesh(limb, lambert(sleeve));
    this.fore = new THREE.Mesh(limb, lambert(sleeve));
    this.elbowJoint = new THREE.Mesh(new THREE.IcosahedronGeometry(0.045, 0), lambert(sleeve));
    const hg = handGeometry(glove, cuff);
    if (mirror) hg.scale(-1, 1, 1);
    this.hand = new THREE.Mesh(hg, vertexColored({ side: THREE.DoubleSide }));
    const pg = pointingHandGeometry(glove, cuff);
    if (mirror) pg.scale(-1, 1, 1);
    this.pointHand = new THREE.Mesh(pg, vertexColored({ side: THREE.DoubleSide }));
    this.pointHand.visible = false;
    parent.add(this.upper, this.fore, this.elbowJoint, this.hand, this.pointHand);
  }

  /**
   * Solves a two-bone IK chain from `shoulder` to `target`, bending towards `pole`.
   * `handUp` is the direction the back of the hand should face.
   */
  /** Swaps the gripping hand for the index-finger pointing hand. */
  setPointing(on: boolean) {
    if (on === this.pointing) return;
    this.pointing = on;
    this.hand.visible = !on;
    this.pointHand.visible = on;
  }

  setVisible(v: boolean) {
    this.upper.visible = this.fore.visible = this.elbowJoint.visible = v;
    this.hand.visible = v && !this.pointing;
    this.pointHand.visible = v && this.pointing;
  }

  solve(shoulder: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3, handUp: THREE.Vector3) {
    const a = LAYOUT.upperArm;
    const b = LAYOUT.foreArm;
    _dir.subVectors(target, shoulder);
    let d = _dir.length();
    if (d < 1e-5) {
      _dir.set(0, -1, 0);
      d = 1e-5;
    }
    _dir.multiplyScalar(1 / d);
    d = Math.min(Math.max(d, Math.abs(a - b) + 0.02), a + b - 0.005);
    const x = (a * a - b * b + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, a * a - x * x));
    _pole.subVectors(pole, shoulder);
    _pole.addScaledVector(_dir, -_pole.dot(_dir));
    if (_pole.lengthSq() < 1e-8) _pole.set(0, -1, 0);
    _pole.normalize();
    this.elbow.copy(shoulder).addScaledVector(_dir, x).addScaledVector(_pole, h);
    this.wrist.copy(shoulder).addScaledVector(_dir, d);
    placeBetween(this.upper, shoulder, this.elbow, 0.105);
    placeBetween(this.fore, this.elbow, this.wrist, 0.085);
    this.elbowJoint.position.copy(this.elbow);
    // hand: fingers continue along the forearm, back of the hand towards handUp
    _tmp.subVectors(this.wrist, this.elbow).normalize();
    _m.lookAt(_tmp.clone().add(this.wrist), this.wrist, handUp);
    this.hand.quaternion.setFromRotationMatrix(_m);
    this.hand.position.copy(this.wrist);
    this.pointHand.quaternion.copy(this.hand.quaternion);
    this.pointHand.position.copy(this.wrist);
  }
}

export class Occupant {
  readonly group = new THREE.Group();
  readonly body = new THREE.Group();
  readonly head = new THREE.Group();
  /** Face, helmet and googly eyes. */
  readonly face: CrewHead;
  readonly left: Arm;
  readonly right: Arm;
  readonly shoulderL = new THREE.Vector3();
  readonly shoulderR = new THREE.Vector3();
  private baseShoulderL: THREE.Vector3;
  private baseShoulderR: THREE.Vector3;
  private eye: THREE.Vector3;

  constructor(readonly kind: 'driver' | 'navigator', style: PlayerStyle) {
    const driver = kind === 'driver';
    const s = suitOf(style);
    const suit = s.base;
    // drivers wear gloves; co-drivers keep bare hands for the tablet
    const glove = driver ? s.trim : SKINS[style.skin];
    const cuff = s.accent;
    this.eye = driver ? LAYOUT.driverEye.clone() : LAYOUT.navEye.clone();
    this.baseShoulderL = (driver ? LAYOUT.driverShoulderL : LAYOUT.navShoulderL).clone();
    this.baseShoulderR = (driver ? LAYOUT.driverShoulderR : LAYOUT.navShoulderR).clone();
    const x = this.eye.x;

    // torso
    const torso = new THREE.Mesh(seatedTorso(style), vertexColored());
    torso.position.set(x, 0.18, 0.4);
    torso.rotation.x = 0.16;
    this.body.add(torso);

    // head with helmet + visor, pivoting at the neck
    this.head.position.set(x, this.eye.y - 0.06, this.eye.z + 0.1);
    this.face = new CrewHead(style);
    this.face.group.position.y = 0.06;
    this.face.group.scale.setScalar(1.15);
    this.head.add(this.face.group);
    this.body.add(this.head);
    setLayer(this.body, driver ? LAYER.DRIVER_BODY : LAYER.NAV_BODY);
    this.group.add(this.body);

    const armsGroup = new THREE.Group();
    this.left = new Arm(armsGroup, suit, glove, cuff, false);
    this.right = new Arm(armsGroup, suit, glove, cuff, true);
    setLayer(armsGroup, LAYER.COCKPIT);
    this.group.add(armsGroup);
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  /** Applies body sway (car-local offset) and head look angles. */
  pose(sway: THREE.Vector3, headYaw: number, headPitch: number) {
    this.body.position.copy(sway);
    this.head.rotation.set(headPitch, headYaw, 0, 'YXZ');
    this.shoulderL.copy(this.baseShoulderL).add(sway);
    this.shoulderR.copy(this.baseShoulderR).add(sway);
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
}

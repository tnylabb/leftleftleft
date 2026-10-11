// A player outside the car: first-person walking with collision against the
// car body, trees and boulders, terrain following, and gripping a tow hook.
// While gripping, the player is tethered to the hook and walking away from it
// turns into a pull force on the car (applied by the vehicle simulation).

import * as THREE from 'three';
import { Arm } from '../cockpit/Occupant';
import { GeoBuilder, mat, setLayer } from '../rendering/geometry';
import { LAYER } from '../rendering/layers';
import { PALETTE, vertexColored } from '../rendering/materials';
import { CAR_HOOKS, GRIP_REACH, PULL_FORCE_MAX } from '../shared/constants';
import { clamp } from '../shared/math';
import type { Role } from '../shared/types';

export const EYE_HEIGHT = 1.62;
const RADIUS = 0.3;
/** Car body footprint for walking collision (car-local half extents + centre). */
const CAR_BOX = { hx: 0.86, hz: 2.0, cz: -0.08 };

export interface FootIntent {
  forward: number; // -1..1
  strafe: number; // -1..1
  turn: number; // -1..1 keyboard turning (split screen driver)
  run: boolean;
  grip: boolean;
  lookDX: number;
  lookDY: number;
}

export interface FootEnv {
  groundY(x: number, z: number): number;
  carPos: THREE.Vector3;
  carQuat: THREE.Quaternion;
  obstacles(x: number, z: number, radius: number, out: { x: number; z: number; r: number }[]): { x: number; z: number; r: number }[];
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _inv = new THREE.Quaternion();
const _obst: { x: number; z: number; r: number }[] = [];

export function hookWorld(i: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion, out = new THREE.Vector3()) {
  const h = CAR_HOOKS[i];
  return out.set(h.x, h.y, h.z).applyQuaternion(carQuat).add(carPos);
}

export class FootController {
  readonly pos = new THREE.Vector3();
  yaw = 0;
  pitch = -0.1;
  readonly vel = new THREE.Vector3();
  grip = -1;
  /** World-space force this player currently pulls the car with (N). */
  readonly pull = new THREE.Vector3();
  walkPhase = 0;
  tension = 0;
  /** Tension smoothed for the HUD (the rope goes slack each time the car catches up). */
  tensionShown = 0;

  /** Places the player (e.g. stepping out of the car next to their door). */
  place(p: THREE.Vector3, yaw: number) {
    this.pos.copy(p);
    this.yaw = yaw;
    this.pitch = -0.1;
    this.vel.set(0, 0, 0);
    this.grip = -1;
    this.pull.set(0, 0, 0);
  }

  get eye(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
  }

  update(dt: number, intent: FootIntent, env: FootEnv, sensitivity: number) {
    // look
    this.yaw -= intent.lookDX * 0.0022 * sensitivity;
    this.pitch = clamp(this.pitch - intent.lookDY * 0.0022 * sensitivity, -1.3, 1.2);
    this.yaw += intent.turn * 2.4 * dt;

    // grip a tow hook when close enough, release when the button is let go
    if (!intent.grip) this.grip = -1;
    else if (this.grip < 0) {
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < CAR_HOOKS.length; i++) {
        const h = hookWorld(i, env.carPos, env.carQuat, _v);
        const d = Math.hypot(h.x - this.pos.x, h.z - this.pos.z);
        if (d < GRIP_REACH && Math.abs(h.y - (this.pos.y + 0.6)) < 1.4 && d < bestD) {
          best = i;
          bestD = d;
        }
      }
      this.grip = best;
    }

    // movement intent (world, horizontal)
    const fwd = _v.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = _w.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3().addScaledVector(fwd, intent.forward).addScaledVector(right, intent.strafe);
    const intentMag = Math.min(1, wish.length());
    if (intentMag > 1e-3) wish.normalize();
    const speed = this.grip >= 0 ? 1.1 : intent.run ? 4.2 : 2.3;
    const target = wish.clone().multiplyScalar(speed * intentMag);
    this.vel.lerp(target, 1 - Math.exp(-dt * 10));
    this.pos.addScaledVector(this.vel, dt);

    // collide with the car body (oriented box in its local XZ plane)
    _inv.copy(env.carQuat).invert();
    const local = this.pos.clone().sub(env.carPos).applyQuaternion(_inv);
    const ex = CAR_BOX.hx + RADIUS;
    const ez = CAR_BOX.hz + RADIUS;
    const lz = local.z - CAR_BOX.cz;
    if (Math.abs(local.x) < ex && Math.abs(lz) < ez && local.y > -1.2 && local.y < 1.4) {
      const px = ex - Math.abs(local.x);
      const pz = ez - Math.abs(lz);
      if (px < pz) local.x = Math.sign(local.x || 1) * ex;
      else local.z = CAR_BOX.cz + Math.sign(lz || 1) * ez;
      this.pos.copy(local.applyQuaternion(env.carQuat).add(env.carPos));
    }
    // trees and boulders
    for (const o of env.obstacles(this.pos.x, this.pos.z, RADIUS + 0.2, _obst)) {
      const dx = this.pos.x - o.x;
      const dz = this.pos.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + RADIUS;
      if (d < min && d > 1e-4) {
        this.pos.x = o.x + (dx / d) * min;
        this.pos.z = o.z + (dz / d) * min;
      }
    }

    // tether + pull: the arm is taut at GRIP_REACH; walking away pulls the car
    this.pull.set(0, 0, 0);
    this.tension = 0;
    if (this.grip >= 0) {
      const hook = hookWorld(this.grip, env.carPos, env.carQuat, new THREE.Vector3());
      const r = new THREE.Vector3(this.pos.x - hook.x, 0, this.pos.z - hook.z);
      const d = r.length();
      if (d > 1e-4) r.multiplyScalar(1 / d);
      if (d > GRIP_REACH) {
        this.pos.x = hook.x + r.x * GRIP_REACH;
        this.pos.z = hook.z + r.z * GRIP_REACH;
      }
      if (d > GRIP_REACH * 0.8 && intentMag > 0.05) {
        // force along the direction the player walks, scaled by how much that is away from the hook
        this.tension = clamp(wish.dot(r), 0, 1) * intentMag;
        this.pull.copy(wish).multiplyScalar(PULL_FORCE_MAX * this.tension);
        // hands are higher than the hook: pulling also lifts the bumper a little
        this.pull.y = PULL_FORCE_MAX * 0.12 * this.tension;
      }
    }

    // stand on the ground
    const g = env.groundY(this.pos.x, this.pos.z);
    this.pos.y += (g - this.pos.y) * clamp(dt * 14, 0, 1);
    if (Math.abs(g - this.pos.y) > 1.5) this.pos.y = g;
    this.walkPhase += this.vel.length() * dt * 2.8;
    this.tensionShown = this.grip >= 0 ? Math.max(this.tension, this.tensionShown - dt * 0.8) : 0;
  }
}

/** Low-poly person standing next to the car (rendered for the other player). */
export class FootAvatar {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private legL: THREE.Mesh;
  private legR: THREE.Mesh;
  private head = new THREE.Group();
  readonly left: Arm;
  readonly right: Arm;

  constructor(role: Role) {
    const driver = role === 'driver';
    const suit = driver ? PALETTE.driverSuit : PALETTE.navSuit;
    const glove = driver ? PALETTE.glove : PALETTE.skin;
    const helmet = driver ? PALETTE.helmetDriver : PALETTE.helmetNav;
    const torso = new GeoBuilder()
      .add(new THREE.BoxGeometry(0.44, 0.58, 0.24), suit, mat(0, 1.22, 0), { shade: 0.08 })
      .add(new THREE.BoxGeometry(0.46, 0.1, 0.26), suit, mat(0, 1.47, 0), { shade: 0.08 })
      .add(new THREE.BoxGeometry(0.4, 0.14, 0.24), 0x1b1b1b, mat(0, 0.92, 0))
      .add(new THREE.CylinderGeometry(0.05, 0.06, 0.12, 6), suit, mat(0, 1.55, 0))
      .build();
    this.body.add(new THREE.Mesh(torso, vertexColored()));
    const legGeo = new GeoBuilder()
      .add(new THREE.BoxGeometry(0.16, 0.86, 0.18), suit, mat(0, -0.43, 0), { shade: 0.08 })
      .add(new THREE.BoxGeometry(0.17, 0.1, 0.28), 0x1b1b1b, mat(0, -0.86, -0.05))
      .build();
    this.legL = new THREE.Mesh(legGeo, vertexColored());
    this.legR = new THREE.Mesh(legGeo, vertexColored());
    this.legL.position.set(-0.11, 0.88, 0);
    this.legR.position.set(0.11, 0.88, 0);
    this.body.add(this.legL, this.legR);
    const hb = new GeoBuilder()
      .add(new THREE.IcosahedronGeometry(0.15, 1), helmet, mat(0, 0, 0, 0, 0, 0, 1, 1.05, 1.12), { shade: 0.08 })
      .add(new THREE.BoxGeometry(0.2, 0.07, 0.04), 0x1b2a33, mat(0, 0, -0.15));
    this.head.add(new THREE.Mesh(hb.build(), vertexColored()));
    this.head.position.set(0, 1.66, 0);
    this.body.add(this.head);
    setLayer(this.body, driver ? LAYER.DRIVER_BODY : LAYER.NAV_BODY);
    this.root.add(this.body);
    const arms = new THREE.Group();
    this.left = new Arm(arms, suit, glove, suit, false);
    this.right = new Arm(arms, suit, glove, suit, true);
    // arms are visible to everyone, including the player's own first-person view
    this.root.add(arms);
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.root.visible = false;
  }

  /** Poses the avatar in world space. `hook` = world position of the gripped hook (or null). */
  pose(pos: THREE.Vector3, yaw: number, pitch: number, walk: number, hook: THREE.Vector3 | null) {
    this.root.visible = true;
    this.body.position.copy(pos);
    this.body.rotation.set(0, yaw, 0);
    const swing = Math.sin(walk) * 0.45;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.head.rotation.set(clamp(pitch, -0.8, 0.6), 0, 0);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const sL = new THREE.Vector3(-0.27, 1.45, 0).applyQuaternion(q).add(pos);
    const sR = new THREE.Vector3(0.27, 1.45, 0).applyQuaternion(q).add(pos);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    let tL: THREE.Vector3;
    let tR: THREE.Vector3;
    if (hook) {
      tL = hook.clone().addScaledVector(side, -0.07);
      tR = hook.clone().addScaledVector(side, 0.07);
    } else {
      tL = sL.clone().add(new THREE.Vector3(0, -0.58, 0)).addScaledVector(fwd, -Math.sin(walk) * 0.18);
      tR = sR.clone().add(new THREE.Vector3(0, -0.58, 0)).addScaledVector(fwd, Math.sin(walk) * 0.18);
    }
    const up = new THREE.Vector3(0, 1, 0);
    this.left.solve(sL, tL, sL.clone().addScaledVector(side, -0.4).add(new THREE.Vector3(0, -0.3, 0)), up);
    this.right.solve(sR, tR, sR.clone().addScaledVector(side, 0.4).add(new THREE.Vector3(0, -0.3, 0)), up);
  }

  hide() {
    this.root.visible = false;
  }

  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
}

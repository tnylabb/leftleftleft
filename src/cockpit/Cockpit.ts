// First-person hatchback interior: angular dashboard, gauges, steering wheel,
// gear stick, handbrake, pedals, seats, pillars, roll cage, mirrors and trinkets.

import * as THREE from 'three';
import { GeoBuilder, mat, setLayer } from '../rendering/geometry';
import { LAYER } from '../rendering/layers';
import { lambert, PALETTE, vertexColored } from '../rendering/materials';
import { clamp } from '../shared/math';
import { Gauges, type GaugeState } from './Gauges';
import { LAYOUT } from './layout';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const GEAR_POS: Record<number, [number, number]> = {
  1: [-1, -1], 2: [-1, 1], 3: [0, -1], 4: [0, 1], 5: [1, -1], [-1]: [1, 1], 0: [0, 0],
};

export interface CockpitState {
  steer: number; // front wheel angle (rad)
  gear: number;
  shifting: boolean;
  handbrake: number; // 0..1
  throttle: number;
  brake: number;
  speed: number; // m/s
  rpm: number;
  accelLocal: THREE.Vector3;
  doorOpen: boolean;
  wipers: boolean;
}

export class Cockpit {
  readonly group = new THREE.Group();
  readonly gauges = new Gauges();
  readonly wheelTilt = new THREE.Group();
  readonly wheelSpin = new THREE.Group();
  readonly gearLever = new THREE.Group();
  readonly handbrake = new THREE.Group();
  readonly pedals: THREE.Object3D[] = [];
  readonly mirrorRear: THREE.Mesh;
  readonly mirrorLeft: THREE.Mesh;
  readonly mirrorRight: THREE.Mesh;
  private freshener = new THREE.Group();
  private freshAngle = new THREE.Vector2();
  private freshVel = new THREE.Vector2();
  private gearVis = new THREE.Vector2();
  private hbVis = 0;
  wheelVisualAngle = 0;

  constructor() {
    this.group.name = 'cockpit';
    this.buildShell();
    this.buildDash();
    this.buildControls();
    this.buildSeats();
    const mirrors = this.buildMirrors();
    this.mirrorRear = mirrors.rear;
    this.mirrorLeft = mirrors.left;
    this.mirrorRight = mirrors.right;
    setLayer(this.group, LAYER.COCKPIT);
    // side mirror glass is outside the car but should still be hidden from the mirror camera
    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.receiveShadow = true;
        o.castShadow = o.userData.noShadow ? false : true;
      }
    });
  }

  private buildShell() {
    const b = new GeoBuilder();
    const I = PALETTE.interior;
    const ID = PALETTE.interiorDark;
    const sh = { shade: 0.08 };
    // floor + transmission tunnel
    b.add(new THREE.BoxGeometry(1.5, 0.04, 2.6), PALETTE.carpet, mat(0, LAYOUT.floorY - 0.02, 0.3), sh);
    b.add(new THREE.BoxGeometry(0.22, 0.14, 1.5), PALETTE.carpet, mat(0, LAYOUT.floorY + 0.06, -0.2), sh);
    // firewall / footwell front
    b.add(new THREE.BoxGeometry(1.5, 0.4, 0.04), PALETTE.carpet, mat(0, -0.05, -0.98, -0.5, 0, 0), sh);
    // headliner (faces down, so build a thin box)
    b.add(new THREE.BoxGeometry(1.3, 0.02, 1.86), 0xcfc6b2, mat(0, LAYOUT.roofY, 0.5), sh);
    // inner A-pillars along the windshield edges
    const w = LAYOUT.windshield;
    for (const [bot, top] of [[w.bl, w.tl], [w.br, w.tr]] as const) {
      const mid = bot.clone().add(top).multiplyScalar(0.5);
      const len = bot.distanceTo(top);
      const pillar = new THREE.Object3D();
      pillar.position.copy(mid);
      pillar.quaternion.setFromUnitVectors(V(0, 1, 0), top.clone().sub(bot).normalize());
      pillar.updateMatrix();
      b.add(new THREE.BoxGeometry(0.09, len, 0.07), I, pillar.matrix, sh);
    }
    // header rail above the windshield
    b.add(new THREE.BoxGeometry(1.26, 0.07, 0.08), I, mat(0, 0.84, -0.42), sh);
    // B-pillars, rear quarter trims, C-pillars
    for (const s of [-1, 1]) {
      b.add(new THREE.BoxGeometry(0.06, 0.6, 0.12), ID, mat(0.72 * s, 0.6, 0.7, 0, 0, 0.2 * s), sh);
      b.add(new THREE.BoxGeometry(0.04, 0.58, 0.9), I, mat(0.75 * s, 0.06, 1.15), sh);
      b.add(new THREE.BoxGeometry(0.05, 0.55, 0.16), I, mat(0.7 * s, 0.62, 1.4, 0, 0, 0.22 * s), sh);
      // sun visors
      b.add(new THREE.BoxGeometry(0.34, 0.02, 0.15), 0xbdb39c, mat(0.36 * s, 0.82, -0.36, -0.15, 0, 0), sh);
    }
    // rear seat + parcel shelf + rear wall
    b.add(new THREE.BoxGeometry(1.3, 0.16, 0.5), PALETTE.seat, mat(0, -0.05, 1.0), sh);
    b.add(new THREE.BoxGeometry(1.3, 0.5, 0.12), PALETTE.seat, mat(0, 0.25, 1.3, 0.25, 0, 0), sh);
    b.add(new THREE.BoxGeometry(1.36, 0.03, 0.3), PALETTE.plastic, mat(0, 0.44, 1.52), sh);
    // roll cage (rally!)
    const tube = 0xa6a29a;
    const cyl = (a: THREE.Vector3, c: THREE.Vector3, r = 0.022) => {
      const o = new THREE.Object3D();
      o.position.copy(a).add(c).multiplyScalar(0.5);
      o.quaternion.setFromUnitVectors(V(0, 1, 0), c.clone().sub(a).normalize());
      o.updateMatrix();
      b.add(new THREE.CylinderGeometry(r, r, a.distanceTo(c), 6), tube, o.matrix);
    };
    cyl(V(-0.62, LAYOUT.floorY, 0.68), V(-0.6, 0.8, 0.66));
    cyl(V(0.62, LAYOUT.floorY, 0.68), V(0.6, 0.8, 0.66));
    cyl(V(-0.6, 0.8, 0.66), V(0.6, 0.8, 0.66));
    cyl(V(-0.6, 0.8, 0.66), V(-0.58, 0.8, -0.38));
    cyl(V(0.6, 0.8, 0.66), V(0.58, 0.8, -0.38));
    cyl(V(-0.6, 0.8, 0.66), V(0.58, LAYOUT.floorY + 0.05, 1.3));
    const mesh = new THREE.Mesh(b.build(), vertexColored());
    this.group.add(mesh);
  }

  private buildDash() {
    const b = new GeoBuilder();
    const I = PALETTE.interior;
    const P = PALETTE.plastic;
    const sh = { shade: 0.07 };
    const d = LAYOUT.dash;
    // top shelf (orange-red, faded) sloping slightly towards the windshield
    b.add(new THREE.BoxGeometry(1.48, 0.06, d.backZ - d.frontZ), I, mat(0, d.topY - 0.03, (d.backZ + d.frontZ) / 2, 0.06, 0, 0), sh);
    // angular dash face
    b.add(new THREE.BoxGeometry(1.48, 0.26, 0.08), P, mat(0, 0.2, -0.63, -0.25, 0, 0), sh);
    b.add(new THREE.BoxGeometry(1.48, 0.2, 0.1), P, mat(0, -0.02, -0.72, 0.35, 0, 0), sh);
    // instrument binnacle
    b.add(new THREE.BoxGeometry(0.46, 0.05, 0.2), P, mat(-0.36, 0.44, -0.63, -0.15, 0, 0), sh);
    b.add(new THREE.BoxGeometry(0.04, 0.12, 0.18), P, mat(-0.58, 0.39, -0.64), sh);
    b.add(new THREE.BoxGeometry(0.04, 0.12, 0.18), P, mat(-0.14, 0.39, -0.64), sh);
    // centre stack: radio + vents + heater knobs
    b.add(new THREE.BoxGeometry(0.3, 0.26, 0.12), PALETTE.plasticLight, mat(0, 0.17, -0.63, -0.2, 0, 0), sh);
    b.add(new THREE.BoxGeometry(0.22, 0.05, 0.02), 0x111111, mat(0, 0.2, -0.565, -0.2, 0, 0));
    b.add(new THREE.BoxGeometry(0.2, 0.025, 0.02), 0x3d6a3a, mat(0, 0.25, -0.575, -0.2, 0, 0));
    for (const x of [-0.08, 0, 0.08]) b.add(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 6), 0x111111, mat(x, 0.1, -0.555, Math.PI / 2 - 0.2, 0, 0));
    for (const x of [-0.62, 0.2, 0.62]) {
      b.add(new THREE.BoxGeometry(0.12, 0.06, 0.03), 0x101010, mat(x, 0.29, -0.6));
      for (let k = 0; k < 3; k++) b.add(new THREE.BoxGeometry(0.11, 0.006, 0.02), 0x2a2a2a, mat(x, 0.272 + k * 0.018, -0.585));
    }
    // glovebox
    b.add(new THREE.BoxGeometry(0.42, 0.14, 0.04), I, mat(0.38, 0.12, -0.6, -0.25, 0, 0), sh);
    b.add(new THREE.BoxGeometry(0.08, 0.02, 0.02), PALETTE.chrome, mat(0.38, 0.18, -0.58, -0.25, 0, 0));
    // centre console
    b.add(new THREE.BoxGeometry(0.2, 0.2, 0.9), P, mat(0, LAYOUT.floorY + 0.1, -0.12), sh);
    b.add(new THREE.BoxGeometry(0.16, 0.012, 0.3), 0x0e0e0e, mat(0, LAYOUT.floorY + 0.205, -0.3));
    // steering column shroud
    const col = new THREE.Object3D();
    const c0 = V(-0.36, 0.16, -0.64);
    const c1 = LAYOUT.wheelCenter.clone().add(V(0, -0.04, -0.05));
    col.position.copy(c0).add(c1).multiplyScalar(0.5);
    col.quaternion.setFromUnitVectors(V(0, 1, 0), c1.clone().sub(c0).normalize());
    col.updateMatrix();
    b.add(new THREE.BoxGeometry(0.09, c0.distanceTo(c1), 0.1), P, col.matrix, sh);
    // indicator stalks
    b.add(new THREE.BoxGeometry(0.16, 0.015, 0.015), P, mat(-0.24, 0.27, -0.42, 0, 0, -0.2));
    b.add(new THREE.BoxGeometry(0.16, 0.015, 0.015), P, mat(-0.48, 0.27, -0.42, 0, 0, 0.2));
    // dashboard sticker: stage plate
    b.add(new THREE.BoxGeometry(0.16, 0.004, 0.08), 0xf2c230, mat(0.42, d.topY + 0.004, -0.78));
    this.group.add(new THREE.Mesh(b.build(), vertexColored()));

    // gauge face
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.16), new THREE.MeshBasicMaterial({ map: this.gauges.texture, toneMapped: false }));
    face.position.copy(LAYOUT.cluster);
    face.rotation.x = -0.12;
    face.userData.noShadow = true;
    this.group.add(face);
  }

  private buildControls() {
    const P = PALETTE.plastic;
    // steering wheel
    this.wheelTilt.position.copy(LAYOUT.wheelCenter);
    this.wheelTilt.rotation.x = -LAYOUT.wheelTilt;
    this.wheelTilt.add(this.wheelSpin);
    const r = LAYOUT.wheelRadius;
    const wb = new GeoBuilder()
      .add(new THREE.TorusGeometry(r, 0.024, 5, 16), 0x161616, undefined, { shade: 0.1 })
      .add(new THREE.CylinderGeometry(0.06, 0.07, 0.06, 8), 0x1c1c1c, mat(0, 0, 0.01, Math.PI / 2, 0, 0))
      .add(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 8), PALETTE.tabletBumper, mat(0, 0, 0.045, Math.PI / 2, 0, 0))
      .add(new THREE.BoxGeometry(r * 2 - 0.04, 0.03, 0.02), 0x2a2a2a, mat(0, -0.01, 0.005))
      .add(new THREE.BoxGeometry(0.035, r, 0.02), 0x2a2a2a, mat(0, -r / 2, 0.005))
      .add(new THREE.BoxGeometry(0.03, 0.025, 0.03), 0xffffff, mat(0, r, 0)); // top-centre marker
    this.wheelSpin.add(new THREE.Mesh(wb.build(), vertexColored()));
    this.group.add(this.wheelTilt);

    // gear lever with rubber boot
    this.gearLever.position.copy(LAYOUT.gearBase);
    const boot = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.06, 6), lambert(0x111111));
    boot.position.set(0, 0.0, 0);
    boot.position.copy(LAYOUT.gearBase).add(V(0, 0.01, 0));
    this.group.add(boot);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.012, 0.2, 5), lambert(0x2b2b2b));
    stick.position.y = 0.1;
    const knob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 0), lambert(0x101010));
    knob.position.y = 0.21;
    this.gearLever.add(stick, knob);
    this.group.add(this.gearLever);

    // handbrake lever pointing back between the seats
    this.handbrake.position.copy(LAYOUT.handbrakeBase);
    const hb = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, 0.26), lambert(P));
    hb.position.set(0, 0.02, 0.12);
    const btn = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), lambert(PALETTE.chrome));
    btn.position.set(0, 0.03, 0.25);
    this.handbrake.add(hb, btn);
    this.group.add(this.handbrake);

    // pedals
    for (const [x, w] of [[-0.54, 0.06], [-0.4, 0.07], [-0.27, 0.05]] as const) {
      const p = new THREE.Group();
      p.position.set(x, 0.0, -0.74);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.16, 0.015), lambert(0x333333));
      arm.position.y = -0.08;
      const pad = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, 0.015), lambert(0x222222));
      pad.position.set(0, -0.17, 0.01);
      p.add(arm, pad);
      this.group.add(p);
      this.pedals.push(p);
    }
  }

  private buildSeats() {
    for (const s of [-1, 1]) {
      const b = new GeoBuilder();
      const x = LAYOUT.seatX * s;
      const sh = { shade: 0.08 };
      b.add(new THREE.BoxGeometry(0.5, 0.14, 0.5), PALETTE.seat, mat(x, LAYOUT.seatCushionY - 0.07, (LAYOUT.seatFrontZ + LAYOUT.seatBackZ) / 2 + 0.02, 0.08, 0, 0), sh);
      // bucket bolsters
      b.add(new THREE.BoxGeometry(0.08, 0.12, 0.48), PALETTE.seat, mat(x - 0.22, LAYOUT.seatCushionY + 0.02, 0.25), sh);
      b.add(new THREE.BoxGeometry(0.08, 0.12, 0.48), PALETTE.seat, mat(x + 0.22, LAYOUT.seatCushionY + 0.02, 0.25), sh);
      // backrest + side wings + headrest
      b.add(new THREE.BoxGeometry(0.5, 0.66, 0.12), PALETTE.seat, mat(x, 0.36, 0.6, 0.18, 0, 0), sh);
      b.add(new THREE.BoxGeometry(0.06, 0.5, 0.2), PALETTE.seat, mat(x - 0.24, 0.32, 0.54, 0.18, 0, 0), sh);
      b.add(new THREE.BoxGeometry(0.06, 0.5, 0.2), PALETTE.seat, mat(x + 0.24, 0.32, 0.54, 0.18, 0, 0), sh);
      b.add(new THREE.BoxGeometry(0.06, 0.6, 0.125), PALETTE.seatStripe, mat(x, 0.36, 0.6, 0.18, 0, 0));
      b.add(new THREE.BoxGeometry(0.26, 0.16, 0.1), PALETTE.seat, mat(x, 0.78, 0.72, 0.18, 0, 0), sh);
      // seat base frame
      b.add(new THREE.BoxGeometry(0.4, 0.14, 0.4), 0x2a2a2a, mat(x, LAYOUT.floorY + 0.07, 0.25));
      this.group.add(new THREE.Mesh(b.build(), vertexColored()));
    }
  }

  private buildMirrors() {
    const make = (w: number, h: number, u0: number, u1: number) => {
      const g = new THREE.PlaneGeometry(w, h);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        uv.setX(i, uv.getX(i) < 0.5 ? u0 : u1);
        uv.setY(i, uv.getY(i) < 0.5 ? 0.08 : 0.92);
      }
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xd8e2e8 }));
      m.userData.noShadow = true;
      return m;
    };
    // rear view: centre of the backwards image, mirrored horizontally
    const rear = make(0.24, 0.07, 0.66, 0.34);
    rear.position.copy(LAYOUT.mirror).add(V(0, 0, 0.016));
    rear.rotation.set(-0.05, -0.25, 0);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.085, 0.03), lambert(0x161616));
    housing.position.copy(LAYOUT.mirror);
    housing.rotation.copy(rear.rotation);
    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.07, 0.02), lambert(0x161616));
    stem.position.copy(LAYOUT.mirror).add(V(0, 0.06, -0.02));
    this.group.add(rear, housing, stem);
    // pine air freshener on a string
    this.freshener.position.copy(LAYOUT.mirror).add(V(0.03, -0.045, 0.01));
    const string = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.08, 0.002), lambert(0xeeeeee));
    string.position.y = -0.04;
    const tree = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.08, 4), lambert(0x2f9a3e));
    tree.position.y = -0.11;
    this.freshener.add(string, tree);
    this.group.add(this.freshener);
    // side mirrors (outside the car, facing backwards)
    const left = make(0.13, 0.085, 1.0, 0.72);
    left.position.set(-0.88, 0.42, -0.555);
    left.rotation.y = 0.25;
    const right = make(0.13, 0.085, 0.28, 0.0);
    right.position.set(0.88, 0.42, -0.555);
    right.rotation.y = -0.25;
    this.group.add(left, right);
    return { rear, left, right };
  }

  setMirrorTexture(tex: THREE.Texture) {
    for (const m of [this.mirrorRear, this.mirrorLeft, this.mirrorRight]) {
      const material = m.material as THREE.MeshBasicMaterial;
      material.map = tex;
      material.needsUpdate = true;
    }
  }

  /** Car-local positions of the wheel grips at "ten to two". */
  gripPoints(left: THREE.Vector3, right: THREE.Vector3) {
    const r = LAYOUT.wheelRadius;
    this.wheelTilt.updateMatrix();
    this.wheelSpin.updateMatrix();
    const m = new THREE.Matrix4().multiplyMatrices(this.wheelTilt.matrix, this.wheelSpin.matrix);
    const a = (20 * Math.PI) / 180;
    left.set(-Math.cos(a) * r, Math.sin(a) * r, 0.01).applyMatrix4(m);
    right.set(Math.cos(a) * r, Math.sin(a) * r, 0.01).applyMatrix4(m);
  }

  handbrakeGrip(out: THREE.Vector3): THREE.Vector3 {
    this.handbrake.updateMatrix();
    return out.set(0, 0.04, 0.2).applyMatrix4(this.handbrake.matrix);
  }

  /** Wheel axis direction (towards the driver) in car-local space. */
  wheelAxis(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this.wheelTilt.quaternion);
  }

  update(dt: number, s: CockpitState) {
    // steering wheel: visual ratio, clamped so the hands stay believable
    const target = clamp(s.steer * 4.2, -2.4, 2.4);
    this.wheelVisualAngle += (target - this.wheelVisualAngle) * clamp(dt * 25, 0, 1);
    this.wheelSpin.rotation.z = -this.wheelVisualAngle;

    const gp = GEAR_POS[s.gear] ?? [0, 0];
    const tgt = s.shifting ? [gp[0], 0] : gp;
    this.gearVis.x += (tgt[0] - this.gearVis.x) * clamp(dt * 14, 0, 1);
    this.gearVis.y += (tgt[1] - this.gearVis.y) * clamp(dt * 14, 0, 1);
    this.gearLever.rotation.set(this.gearVis.y * 0.26, 0, -this.gearVis.x * 0.24);

    this.hbVis += (s.handbrake - this.hbVis) * clamp(dt * 18, 0, 1);
    this.handbrake.rotation.x = -0.15 - this.hbVis * 0.45;

    this.pedals[1].rotation.x = s.brake * 0.35;
    this.pedals[2].rotation.x = s.throttle * 0.4;
    this.pedals[0].rotation.x = s.shifting ? 0.4 : 0;

    // air freshener pendulum (spring-damper driven by cabin acceleration)
    const k = 60;
    const c = 1.6;
    this.freshVel.x += (-k * this.freshAngle.x - c * this.freshVel.x + s.accelLocal.z * 2.2) * dt;
    this.freshVel.y += (-k * this.freshAngle.y - c * this.freshVel.y - s.accelLocal.x * 2.2) * dt;
    this.freshAngle.x = clamp(this.freshAngle.x + this.freshVel.x * dt, -1.2, 1.2);
    this.freshAngle.y = clamp(this.freshAngle.y + this.freshVel.y * dt, -1.2, 1.2);
    this.freshener.rotation.set(this.freshAngle.x, 0, this.freshAngle.y);

    const gs: GaugeState = {
      speedKmh: s.speed * 3.6,
      rpm: s.rpm,
      gear: s.gear,
      handbrake: s.handbrake > 0.5,
      doorOpen: s.doorOpen,
      wipers: s.wipers,
      shifting: s.shifting,
    };
    this.gauges.update(dt, gs);
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.gauges.dispose();
  }
}

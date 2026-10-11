// Low-poly exterior of the faded orange-red hatchback: body shell, glass,
// wheels and hinged doors (door groups are animated by the Doors system).

import * as THREE from 'three';
import { LAYOUT } from '../cockpit/layout';
import { GeoBuilder, mat } from '../rendering/geometry';
import { glassMaterial, lambert, PALETTE, vertexColored } from '../rendering/materials';
import { CAR_SPEC } from './carSpec';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export interface DoorRig {
  pivot: THREE.Group;
  side: 'left' | 'right';
  handle: THREE.Object3D;
}

export class CarModel {
  readonly root = new THREE.Group();
  readonly wheels: THREE.Group[] = [];
  readonly doors: { left: DoorRig; right: DoorRig };
  private brakeLights: THREE.MeshLambertMaterial;

  constructor() {
    this.root.name = 'car';
    const paint = PALETTE.paint;
    const dark = PALETTE.plastic;
    const b = new GeoBuilder();
    const W = 0.8;
    const sh = { shade: 0.06 };

    // Shell quads are oriented away from a "spine" inside the car so they are
    // back-face culled (invisible) when seen from the cockpit.
    const q = (a: THREE.Vector3, bb: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, col: number) => {
      const mz = (a.z + bb.z + c.z + d.z) / 4;
      b.addQuadOut(a, bb, c, d, col, V(0, 0.25, Math.min(1.2, Math.max(-1.0, mz))));
    };
    // hood (slopes down to the nose), cowl, nose
    q(V(-0.74, 0.28, -1.9), V(0.74, 0.28, -1.9), V(0.76, 0.37, -1.02), V(-0.76, 0.37, -1.02), paint);
    q(V(-0.76, 0.37, -1.02), V(0.76, 0.37, -1.02), V(0.72, 0.38, -0.98), V(-0.72, 0.38, -0.98), dark);
    q(V(-0.78, 0.0, -1.95), V(0.78, 0.0, -1.95), V(0.74, 0.28, -1.9), V(-0.74, 0.28, -1.9), dark);
    for (const s of [-1, 1]) {
      const x = W * s;
      // front fender, its top edge, rear quarter
      q(V(x, -0.22, -1.92), V(x, -0.22, LAYOUT.doorHingeZ), V(x, 0.36, LAYOUT.doorHingeZ), V(x, 0.27, -1.92), paint);
      q(V(x, 0.27, -1.92), V(x, 0.36, LAYOUT.doorHingeZ), V(0.74 * s, 0.37, -1.02), V(0.74 * s, 0.28, -1.9), paint);
      q(V(x, -0.22, LAYOUT.doorRearZ), V(x, -0.22, 1.72), V(x, 0.38, 1.7), V(x, 0.37, LAYOUT.doorRearZ), paint);
      // A-, B- and C-pillars
      q(V(0.72 * s, 0.38, -0.98), V(0.75 * s, 0.37, -0.64), V(0.64 * s, 0.88, -0.4), V(0.61 * s, 0.87, -0.43), paint);
      q(V(0.78 * s, 0.37, 0.62), V(0.78 * s, 0.37, 0.74), V(0.66 * s, 0.9, 0.74), V(0.66 * s, 0.9, 0.62), dark);
      q(V(0.78 * s, 0.38, 1.36), V(0.78 * s, 0.38, 1.7), V(0.66 * s, 0.9, 1.42), V(0.66 * s, 0.9, 1.3), paint);
      // roof gutter
      q(V(0.66 * s, 0.9, 1.42), V(0.64 * s, 0.88, -0.4), V(0.7 * s, 0.86, -0.4), V(0.72 * s, 0.87, 1.42), paint);
    }
    // roof
    q(V(-0.66, 0.9, 1.42), V(0.66, 0.9, 1.42), V(0.64, 0.88, -0.4), V(-0.64, 0.88, -0.4), paint);
    // rear hatch: lower lip + top strip around the glass, tail panel
    q(V(-0.78, 0.38, 1.72), V(0.78, 0.38, 1.72), V(0.76, 0.45, 1.69), V(-0.76, 0.45, 1.69), paint);
    q(V(-0.62, 0.85, 1.45), V(0.62, 0.85, 1.45), V(0.66, 0.9, 1.42), V(-0.66, 0.9, 1.42), paint);
    q(V(-0.8, -0.22, 1.74), V(-0.8, 0.38, 1.72), V(0.8, 0.38, 1.72), V(0.8, -0.22, 1.74), paint);
    // underside (dark)
    b.addQuadOut(V(-W, -0.22, -1.92), V(-W, -0.22, 1.72), V(W, -0.22, 1.72), V(W, -0.22, -1.92), dark, V(0, 0.3, 0));
    // bumpers, arches, mud flaps
    b.add(new THREE.BoxGeometry(1.66, 0.22, 0.14), dark, mat(0, -0.12, -1.96), sh);
    b.add(new THREE.BoxGeometry(1.66, 0.22, 0.14), dark, mat(0, -0.12, 1.79), sh);
    for (const ws of CAR_SPEC.wheels) {
      const x = Math.sign(ws.x) * 0.81;
      b.add(new THREE.BoxGeometry(0.06, 0.12, 0.86), dark, mat(x, 0.14, ws.z));
      b.add(new THREE.BoxGeometry(0.2, 0.26, 0.02), 0x111111, mat(ws.x, -0.32, ws.z + 0.4));
    }
    // lights
    b.add(new THREE.BoxGeometry(0.34, 0.12, 0.04), 0xfff4c8, mat(-0.48, 0.1, -1.93));
    b.add(new THREE.BoxGeometry(0.34, 0.12, 0.04), 0xfff4c8, mat(0.48, 0.1, -1.93));
    b.add(new THREE.BoxGeometry(0.26, 0.08, 0.04), 0xf0f0f0, mat(0, 0.1, -1.94));
    // rally spot lights on the bumper
    for (const x of [-0.3, 0.3]) b.add(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 8), 0xf7f1d5, mat(x, -0.02, -2.02, Math.PI / 2, 0, 0));
    // roof vent + antenna
    b.add(new THREE.BoxGeometry(0.4, 0.04, 0.3), dark, mat(0, 0.92, 0.3));
    b.add(new THREE.CylinderGeometry(0.008, 0.008, 0.7, 3), dark, mat(0.5, 1.2, 1.3, 0.3, 0, 0));
    // side mirrors housings
    for (const s of [-1, 1]) {
      b.add(new THREE.BoxGeometry(0.16, 0.11, 0.08), dark, mat(0.88 * s, 0.42, -0.6));
      b.add(new THREE.BoxGeometry(0.1, 0.04, 0.05), dark, mat(0.8 * s, 0.4, -0.58));
    }
    const shell = new THREE.Mesh(b.build(), vertexColored());
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.root.add(shell);

    // tail lights (separate material so they can glow when braking)
    this.brakeLights = new THREE.MeshLambertMaterial({ color: 0x8a1a12, emissive: 0x000000, flatShading: true });
    for (const x of [-0.6, 0.6]) {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.04), this.brakeLights);
      tl.position.set(x, 0.2, 1.745);
      this.root.add(tl);
    }

    // glass: windshield, rear side windows, hatch
    const glass = glassMaterial();
    const gb = new THREE.BufferGeometry();
    const w = LAYOUT.windshield;
    gb.setFromPoints([w.bl, w.br, w.tr, w.bl, w.tr, w.tl]);
    gb.computeVertexNormals();
    this.root.add(new THREE.Mesh(gb, glass));
    for (const s of [-1, 1]) {
      const g = new THREE.BufferGeometry().setFromPoints([
        V(0.79 * s, 0.39, 0.76), V(0.79 * s, 0.39, 1.34), V(0.67 * s, 0.86, 1.3),
        V(0.79 * s, 0.39, 0.76), V(0.67 * s, 0.86, 1.3), V(0.67 * s, 0.86, 0.76),
      ]);
      g.computeVertexNormals();
      this.root.add(new THREE.Mesh(g, glass));
    }
    const hg = new THREE.BufferGeometry().setFromPoints([
      V(-0.7, 0.44, 1.69), V(0.7, 0.44, 1.69), V(0.6, 0.86, 1.45),
      V(-0.7, 0.44, 1.69), V(0.6, 0.86, 1.45), V(-0.6, 0.86, 1.45),
    ]);
    hg.computeVertexNormals();
    this.root.add(new THREE.Mesh(hg, glass));

    // wheels
    const wheelGeo = new GeoBuilder()
      .add(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 10), PALETTE.tyre, mat(0, 0, 0, 0, 0, Math.PI / 2), { shade: 0.1 })
      .add(new THREE.CylinderGeometry(0.17, 0.17, 0.21, 6), PALETTE.rim, mat(0, 0, 0, 0, 0, Math.PI / 2))
      .add(new THREE.BoxGeometry(0.22, 0.05, 0.3), 0x5a5a5a, mat(0, 0, 0))
      .build();
    for (const ws of CAR_SPEC.wheels) {
      const g = new THREE.Group();
      g.position.set(ws.x, CAR_SPEC.mountY - CAR_SPEC.restLength + 0.1, ws.z);
      const spin = new THREE.Mesh(wheelGeo, vertexColored());
      spin.castShadow = true;
      spin.name = 'spin';
      g.add(spin);
      this.root.add(g);
      this.wheels.push(g);
    }

    this.doors = { left: this.buildDoor('left'), right: this.buildDoor('right') };

    // headlights + rally spot lights (always present so the light count is fixed;
    // switched on for night stages)
    for (const [x, angle, reach] of [[-0.48, 0.42, 70], [0.48, 0.42, 70], [0, 0.22, 110]] as const) {
      const l = new THREE.SpotLight(0xfff2d8, 0, reach, angle, 0.55, 1.15);
      l.position.set(x, 0.1, -1.98);
      l.target.position.set(x * 1.4, -1.6, -24);
      this.root.add(l, l.target);
      this.headlights.push(l);
    }
  }

  readonly headlights: THREE.SpotLight[] = [];

  setHeadlights(on: boolean) {
    this.headlights.forEach((l, i) => (l.intensity = on ? (i === 2 ? 140 : 90) : 0));
  }

  private buildDoor(side: 'left' | 'right'): DoorRig {
    const s = side === 'left' ? -1 : 1;
    const pivot = new THREE.Group();
    pivot.position.set(0.8 * s, 0, LAYOUT.doorHingeZ);
    const L = LAYOUT.doorRearZ - LAYOUT.doorHingeZ;
    const b = new GeoBuilder();
    // outer skin
    b.add(new THREE.BoxGeometry(0.05, 0.6, L), PALETTE.paint, mat(-0.0 * s, 0.07, L / 2), { shade: 0.04 });
    // inner door card
    b.add(new THREE.BoxGeometry(0.03, 0.56, L - 0.06), PALETTE.interior, mat(-0.05 * s, 0.07, L / 2), { shade: 0.05 });
    // armrest + pocket
    b.add(new THREE.BoxGeometry(0.07, 0.05, 0.42), PALETTE.plasticLight, mat(-0.09 * s, 0.17, L * 0.55));
    b.add(new THREE.BoxGeometry(0.06, 0.12, 0.5), PALETTE.plastic, mat(-0.08 * s, -0.12, L * 0.45));
    // window frame (top rail + rear upright + front upright, leaning inwards)
    b.add(new THREE.BoxGeometry(0.04, 0.05, L * 0.98), PALETTE.plastic, mat(-0.12 * s, 0.85, L / 2));
    b.add(new THREE.BoxGeometry(0.04, 0.5, 0.05), PALETTE.plastic, mat(-0.07 * s, 0.6, L - 0.03, 0, 0, 0.2 * s));
    b.add(new THREE.BoxGeometry(0.04, 0.55, 0.05), PALETTE.plastic, mat(-0.07 * s, 0.6, 0.04, 0, 0, 0.2 * s));
    const mesh = new THREE.Mesh(b.build(), vertexColored());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    pivot.add(mesh);
    const glass = new THREE.BufferGeometry().setFromPoints([
      V(-0.02 * s, 0.38, 0.04), V(-0.02 * s, 0.38, L - 0.05), V(-0.12 * s, 0.84, L - 0.05),
      V(-0.02 * s, 0.38, 0.04), V(-0.12 * s, 0.84, L - 0.05), V(-0.12 * s, 0.84, 0.06),
    ]);
    glass.computeVertexNormals();
    pivot.add(new THREE.Mesh(glass, glassMaterial()));
    // interior door handle (lever) - players grab this to close the door
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.035, 0.12), lambert(PALETTE.chrome));
    handle.position.set(-0.075 * s, 0.24, 0.22);
    handle.name = `doorHandle-${side}`;
    pivot.add(handle);
    this.root.add(pivot);
    return { pivot, side, handle };
  }

  /** Visual wheel state: compression (m), spin angle, steer angle (front). */
  updateWheels(compressions: number[], spins: number[], steer: number) {
    for (let i = 0; i < 4; i++) {
      const ws = CAR_SPEC.wheels[i];
      const g = this.wheels[i];
      g.position.y = CAR_SPEC.mountY - CAR_SPEC.restLength + compressions[i];
      g.rotation.y = ws.front ? -steer : 0;
      const spin = g.children[0];
      spin.rotation.x = -spins[i];
    }
  }

  setBrakeLights(on: boolean) {
    this.brakeLights.emissive.setHex(on ? 0xff2a18 : 0x000000);
  }

  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.brakeLights.dispose();
  }
}

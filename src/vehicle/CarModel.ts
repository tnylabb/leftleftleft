// Low-poly exterior of the rally hatchback: body shell in the crew's livery
// (stripes, door number plates, windscreen banner), flared arches, light pod,
// rear wing, sump guard, tow straps, glass, wheels and hinged doors (door
// groups are animated by the Doors system).

import * as THREE from 'three';
import { LAYOUT } from '../cockpit/layout';
import { GeoBuilder, mat } from '../rendering/geometry';
import { canvasTexture, glassMaterial, lambert, PALETTE, vertexColored } from '../rendering/materials';
import { CAR_HOOKS } from '../shared/constants';
import { LIVERIES, type LiveryLook } from '../shared/style';
import { CAR_SPEC } from './carSpec';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const shade = (c: number, k: number) => new THREE.Color(c).multiplyScalar(k).getHex();

export interface DoorRig {
  pivot: THREE.Group;
  side: 'left' | 'right';
  handle: THREE.Object3D;
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** Door number plate: "LEFT! LEFT! LEFT!" header and a big 3. */
function doorPlateTexture(l: LiveryLook): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 160;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f1e8';
  g.beginPath();
  g.roundRect(6, 6, 244, 148, 22);
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = '#1d1d1f';
  g.stroke();
  g.fillStyle = '#e8742b';
  g.fillRect(14, 16, 228, 34);
  g.fillStyle = '#1d1d1f';
  g.font = 'italic 900 24px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('LEFT! LEFT! LEFT!', 128, 34);
  g.fillStyle = hex(l.number === 0xd9a92e ? 0x1d1d1f : l.number);
  g.font = 'italic 900 104px "Arial Black", Impact, sans-serif';
  g.fillText('3', 128, 104);
  return canvasTexture(c);
}

/** Sun strip across the top of the windscreen. */
function sunStripTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#16181c';
  g.fillRect(0, 0, 512, 64);
  g.fillStyle = '#e8742b';
  g.fillRect(0, 54, 512, 10);
  g.font = 'italic 900 40px "Arial Black", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#f4f1e8';
  g.fillText('LEFT! LEFT! LEFT!', 256, 29);
  return canvasTexture(c);
}

export class CarModel {
  readonly root = new THREE.Group();
  readonly wheels: THREE.Group[] = [];
  readonly doors: { left: DoorRig; right: DoorRig };
  readonly livery: LiveryLook;
  private brakeLights: THREE.MeshLambertMaterial;
  private lamps: THREE.MeshLambertMaterial;
  private decals: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];

  constructor(livery: LiveryLook = LIVERIES[0]) {
    this.root.name = 'car';
    this.livery = livery;
    const paint = livery.body;
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
      // livery: a wide stripe and a pinstripe along the flanks
      const xs = (W + 0.004) * s;
      for (const [z0, z1] of [[-1.9, LAYOUT.doorHingeZ], [LAYOUT.doorRearZ, 1.7]]) {
        q(V(xs, 0.02, z0), V(xs, 0.02, z1), V(xs, 0.13, z1), V(xs, 0.13, z0), livery.stripeA);
        q(V(xs, 0.155, z0), V(xs, 0.155, z1), V(xs, 0.19, z1), V(xs, 0.19, z0), livery.stripeB);
      }
    }
    // roof
    q(V(-0.66, 0.9, 1.42), V(0.66, 0.9, 1.42), V(0.64, 0.88, -0.4), V(-0.64, 0.88, -0.4), paint);
    // twin stripes over the bonnet and the roof
    for (const s of [-1, 1]) {
      const x0 = 0.1 * s;
      const x1 = 0.24 * s;
      q(V(x0, 0.286, -1.9), V(x1, 0.286, -1.9), V(x1, 0.376, -1.02), V(x0, 0.376, -1.02), livery.stripeA);
      q(V(x0, 0.906, 1.42), V(x1, 0.906, 1.42), V(x1, 0.886, -0.4), V(x0, 0.886, -0.4), livery.stripeA);
      q(V(0.26 * s, 0.287, -1.9), V(0.29 * s, 0.287, -1.9), V(0.29 * s, 0.377, -1.02), V(0.26 * s, 0.377, -1.02), livery.stripeB);
    }
    // rear hatch: lower lip + top strip around the glass, tail panel
    q(V(-0.78, 0.38, 1.72), V(0.78, 0.38, 1.72), V(0.76, 0.45, 1.69), V(-0.76, 0.45, 1.69), paint);
    q(V(-0.62, 0.85, 1.45), V(0.62, 0.85, 1.45), V(0.66, 0.9, 1.42), V(-0.66, 0.9, 1.42), paint);
    q(V(-0.8, -0.22, 1.74), V(-0.8, 0.38, 1.72), V(0.8, 0.38, 1.72), V(0.8, -0.22, 1.74), paint);
    q(V(-0.8, 0.02, 1.744), V(-0.8, 0.13, 1.744), V(0.8, 0.13, 1.744), V(0.8, 0.02, 1.744), livery.stripeA);
    // underside (dark)
    b.addQuadOut(V(-W, -0.22, -1.92), V(-W, -0.22, 1.72), V(W, -0.22, 1.72), V(W, -0.22, -1.92), dark, V(0, 0.3, 0));
    // bumpers, sump guard, side skirts
    b.add(new THREE.BoxGeometry(1.66, 0.22, 0.14), dark, mat(0, -0.12, -1.96), sh);
    b.add(new THREE.BoxGeometry(1.66, 0.22, 0.14), dark, mat(0, -0.12, 1.79), sh);
    b.add(new THREE.BoxGeometry(1.3, 0.025, 0.7), 0x9a9a96, mat(0, -0.25, -1.62, -0.06, 0, 0), sh);
    for (let k = -2; k <= 2; k++) b.add(new THREE.BoxGeometry(0.035, 0.012, 0.6), 0x7a7a76, mat(k * 0.24, -0.235, -1.62, -0.06, 0, 0));
    for (const s of [-1, 1]) b.add(new THREE.BoxGeometry(0.05, 0.1, 1.5), dark, mat(0.81 * s, -0.19, -0.04), sh);
    // flared wheel arches, mud flaps
    for (const ws of CAR_SPEC.wheels) {
      const s = Math.sign(ws.x);
      b.add(new THREE.BoxGeometry(0.06, 0.12, 0.86), dark, mat(0.8 * s, 0.12, ws.z));
      b.add(new THREE.BoxGeometry(0.09, 0.08, 0.84), paint, mat(0.835 * s, 0.215, ws.z), sh);
      for (const e of [-1, 1]) b.add(new THREE.BoxGeometry(0.09, 0.3, 0.09), paint, mat(0.835 * s, 0.06, ws.z + e * 0.44, e * 0.42, 0, 0), sh);
      if (!ws.front) {
        b.add(new THREE.BoxGeometry(0.28, 0.32, 0.02), livery.stripeA, mat(ws.x, -0.32, ws.z + 0.42));
        b.add(new THREE.BoxGeometry(0.2, 0.04, 0.025), livery.stripeB, mat(ws.x, -0.24, ws.z + 0.42));
      } else b.add(new THREE.BoxGeometry(0.2, 0.26, 0.02), 0x111111, mat(ws.x, -0.32, ws.z + 0.4));
    }
    // tail light housings, headlight bezels (the pod covers most of them)
    b.add(new THREE.BoxGeometry(0.34, 0.12, 0.04), 0xfff4c8, mat(-0.48, 0.1, -1.93));
    b.add(new THREE.BoxGeometry(0.34, 0.12, 0.04), 0xfff4c8, mat(0.48, 0.1, -1.93));
    b.add(new THREE.BoxGeometry(0.26, 0.08, 0.04), 0xf0f0f0, mat(0, 0.1, -1.94));
    // light pod: four big rally lamps on a black frame in front of the grille
    b.add(new THREE.BoxGeometry(1.18, 0.05, 0.1), 0x1d1d1f, mat(0, 0.03, -2.0));
    for (const x of [-0.43, -0.145, 0.145, 0.43]) {
      b.add(new THREE.CylinderGeometry(0.105, 0.11, 0.09, 10), 0x1d1d1f, mat(x, 0.15, -2.02, Math.PI / 2, 0, 0));
      b.add(new THREE.TorusGeometry(0.098, 0.012, 4, 12), livery.accent, mat(x, 0.15, -2.066));
    }
    // small spot lights on the bumper
    for (const x of [-0.62, 0.62]) b.add(new THREE.CylinderGeometry(0.06, 0.06, 0.06, 8), 0x1d1d1f, mat(x, -0.08, -2.04, Math.PI / 2, 0, 0));
    // red tow straps at the tow hooks
    for (const h of CAR_HOOKS) {
      const e = Math.sign(h.z);
      b.add(new THREE.TorusGeometry(0.06, 0.016, 4, 8), 0xc8372d, mat(h.x, h.y - 0.02, h.z - e * 0.02, 0, Math.PI / 2, 0));
    }
    // rear wing: end plates in the accent colour
    b.add(new THREE.BoxGeometry(1.42, 0.035, 0.3), paint, mat(0, 1.04, 1.56, 0.12, 0, 0), sh);
    b.add(new THREE.BoxGeometry(1.42, 0.02, 0.06), livery.stripeA, mat(0, 1.06, 1.42, 0.12, 0, 0));
    for (const s of [-1, 1]) {
      b.add(new THREE.BoxGeometry(0.03, 0.16, 0.36), livery.accent, mat(0.71 * s, 1.02, 1.56));
      b.add(new THREE.BoxGeometry(0.04, 0.16, 0.05), dark, mat(0.45 * s, 0.96, 1.48, -0.25, 0, 0));
    }
    // bonnet vents, roof scoop, antenna, exhaust
    for (const s of [-1, 1]) b.add(new THREE.BoxGeometry(0.22, 0.012, 0.1), 0x16161a, mat(0.45 * s, 0.33, -1.25, 0.1, 0, 0));
    b.add(new THREE.BoxGeometry(0.4, 0.05, 0.3), dark, mat(0, 0.925, 0.3));
    b.add(new THREE.BoxGeometry(0.36, 0.045, 0.02), 0x0b0b0c, mat(0, 0.93, 0.145));
    b.add(new THREE.CylinderGeometry(0.008, 0.008, 0.7, 3), dark, mat(0.5, 1.2, 1.3, 0.3, 0, 0));
    b.add(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 8), 0x8a8a86, mat(0.5, -0.17, 1.82, Math.PI / 2, 0, 0));
    b.add(new THREE.CylinderGeometry(0.032, 0.032, 0.03, 8), 0x0b0b0c, mat(0.5, -0.17, 1.935, Math.PI / 2, 0, 0));
    // side mirror housings in the body colour
    for (const s of [-1, 1]) {
      b.add(new THREE.BoxGeometry(0.16, 0.11, 0.08), paint, mat(0.88 * s, 0.42, -0.6), sh);
      b.add(new THREE.BoxGeometry(0.1, 0.04, 0.05), dark, mat(0.8 * s, 0.4, -0.58));
    }
    const shell = new THREE.Mesh(b.build(), vertexColored());
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.root.add(shell);

    // lamp lenses (glow when the headlights are on)
    this.lamps = new THREE.MeshLambertMaterial({ color: 0xfff4c8, emissive: 0x000000, flatShading: true });
    const lensGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.02, 10).rotateX(Math.PI / 2);
    for (const [x, y, z, r] of [[-0.43, 0.15, -2.06, 1], [-0.145, 0.15, -2.06, 1], [0.145, 0.15, -2.06, 1], [0.43, 0.15, -2.06, 1], [-0.62, -0.08, -2.07, 0.55], [0.62, -0.08, -2.07, 0.55]]) {
      const lens = new THREE.Mesh(lensGeo, this.lamps);
      lens.position.set(x, y, z);
      lens.scale.set(r, r, 1);
      this.root.add(lens);
    }

    // tail lights (separate material so they can glow when braking)
    this.brakeLights = new THREE.MeshLambertMaterial({ color: 0x8a1a12, emissive: 0x000000, flatShading: true });
    for (const x of [-0.6, 0.6]) {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.14, 0.04), this.brakeLights);
      tl.position.set(x, 0.24, 1.745);
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

    // sun strip on the outside of the windscreen (culled from the inside, so it doesn't block the view)
    {
      const tex = sunStripTexture();
      this.textures.push(tex);
      const m = new THREE.MeshLambertMaterial({ map: tex });
      this.decals.push(m);
      const out = new THREE.Vector3().subVectors(w.br, w.bl).cross(new THREE.Vector3().subVectors(w.tl, w.bl)).normalize().multiplyScalar(-0.004);
      const at = (l: THREE.Vector3, r: THREE.Vector3, t: number) => l.clone().lerp(r, t).add(out);
      const A = at(w.bl, w.tl, 0.84);
      const B = at(w.br, w.tr, 0.84);
      const C = at(w.br, w.tr, 0.99);
      const D = at(w.bl, w.tl, 0.99);
      const g = new THREE.BufferGeometry().setFromPoints([A, C, B, A, D, C]);
      g.setAttribute('uv', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1], 2));
      g.computeVertexNormals();
      this.root.add(new THREE.Mesh(g, m));
    }

    // wheels: chunky tyres and multi-spoke rims in the livery's accent colour
    const rim = livery.accent;
    const wb = new GeoBuilder()
      .add(new THREE.CylinderGeometry(0.3, 0.3, 0.2, 12), PALETTE.tyre, mat(0, 0, 0, 0, 0, Math.PI / 2), { shade: 0.12 })
      .add(new THREE.CylinderGeometry(0.31, 0.31, 0.14, 12), 0x232323, mat(0, 0, 0, 0, 0, Math.PI / 2), { shade: 0.2, seed: 4 })
      .add(new THREE.CylinderGeometry(0.19, 0.19, 0.205, 10), shade(rim, 0.7), mat(0, 0, 0, 0, 0, Math.PI / 2))
      .add(new THREE.CylinderGeometry(0.05, 0.05, 0.215, 6), 0x2a2a2a, mat(0, 0, 0, 0, 0, Math.PI / 2));
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      for (const sx of [-1, 1]) wb.add(new THREE.BoxGeometry(0.012, 0.36, 0.04), rim, mat(0.104 * sx, 0, 0, a, 0, 0));
    }
    const wheelGeo = wb.build();
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

    const plate = doorPlateTexture(livery);
    this.textures.push(plate);
    const plateMat = new THREE.MeshLambertMaterial({ map: plate, alphaTest: 0.5 });
    this.decals.push(plateMat);
    this.doors = { left: this.buildDoor('left', plateMat), right: this.buildDoor('right', plateMat) };

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
    this.lamps.emissive.setHex(on ? 0xfff0c0 : 0x000000);
  }

  private buildDoor(side: 'left' | 'right', plate: THREE.Material): DoorRig {
    const s = side === 'left' ? -1 : 1;
    const l = this.livery;
    const pivot = new THREE.Group();
    pivot.position.set(0.8 * s, 0, LAYOUT.doorHingeZ);
    const L = LAYOUT.doorRearZ - LAYOUT.doorHingeZ;
    const b = new GeoBuilder();
    // outer skin with the livery stripes
    b.add(new THREE.BoxGeometry(0.05, 0.6, L), l.body, mat(-0.0 * s, 0.07, L / 2), { shade: 0.04 });
    b.add(new THREE.BoxGeometry(0.004, 0.11, L - 0.01), l.stripeA, mat(0.027 * s, 0.075, L / 2));
    b.add(new THREE.BoxGeometry(0.004, 0.035, L - 0.01), l.stripeB, mat(0.027 * s, 0.1725, L / 2));
    // inner door card: bare painted metal, a red pull strap
    b.add(new THREE.BoxGeometry(0.03, 0.56, L - 0.06), shade(l.body, 0.8), mat(-0.05 * s, 0.07, L / 2), { shade: 0.05 });
    b.add(new THREE.BoxGeometry(0.012, 0.04, 0.2), 0xc8372d, mat(-0.072 * s, 0.31, L * 0.42));
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
    // number plate on the outside
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.31), plate);
    p.position.set(0.0302 * s, 0.13, L * 0.52);
    p.rotation.y = (s * Math.PI) / 2;
    pivot.add(p);
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
    this.lamps.dispose();
    for (const m of this.decals) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}

// The crew's look: faceted heads with big googly eyes in open-face rally
// helmets (intercom mic included) and race suits with side panels, patches,
// belts and racing boots. Shared by the seated occupants, the on-foot avatars
// and the 3D lobby.

import * as THREE from 'three';
import { clamp } from '../shared/math';
import { HELMETS, SKINS, SUITS, type PlayerStyle, type SuitLook } from '../shared/style';
import { GeoBuilder, mat } from './geometry';
import { lambert, vertexColored } from './materials';

const HAIR = 0x3a2a1e;
const LIPS = 0x5a2a22;
const shade = (c: number, k: number) => new THREE.Color(c).multiplyScalar(k).getHex();

// face ellipsoid (head-local, centred at y = FACE_Y)
const FA = 0.1086;
const FB = 0.139;
const FC = 0.1156;
const FACE_Y = -0.01;
/** z of the face surface at (x, y), pushed out a little so features sit on the facets. */
function faceZ(x: number, y: number, out = 0.006): number {
  const k = 1 - (x / FA) ** 2 - ((y - FACE_Y) / FB) ** 2;
  return -FC * Math.sqrt(Math.max(0.05, k)) - out;
}

function sphereBand(r: number, phiC: number, phiW: number, theta0: number, theta1: number, wSeg = 10, hSeg = 6) {
  return new THREE.SphereGeometry(r, wSeg, hSeg, phiC - phiW / 2, phiW, theta0, theta1 - theta0);
}

/** A cylinder from a to b (for the mic boom). */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number): [THREE.BufferGeometry, THREE.Matrix4] {
  const o = new THREE.Object3D();
  o.position.copy(a).add(b).multiplyScalar(0.5);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  o.updateMatrix();
  return [new THREE.CylinderGeometry(r, r, a.distanceTo(b), 5), o.matrix];
}

/** Head, helmet and face. The group's origin is the centre of the head, -Z is forward. */
export class CrewHead {
  readonly group = new THREE.Group();
  private eyes: THREE.Group[] = [];
  private pupils: THREE.Mesh[] = [];
  private blinkIn = 1.5 + Math.random() * 3;
  private blinkT = 0;
  private fear = 0;
  private look = new THREE.Vector2();
  private lookTarget = new THREE.Vector2();
  private lookTimer = 0;

  constructor(style: PlayerStyle) {
    const helmet = HELMETS[style.helmet] ?? HELMETS[0];
    const skin = SKINS[style.skin] ?? SKINS[1];
    const face = style.face;
    const b = new GeoBuilder();

    // face and neck
    b.add(new THREE.IcosahedronGeometry(0.118, 1), skin, mat(0, FACE_Y, 0, 0, 0, 0, 0.92, 1.18, 0.98), { shade: 0.1, seed: 3 });
    b.add(new THREE.CylinderGeometry(0.05, 0.056, 0.12, 7), skin, mat(0, -0.15, 0.015), { shade: 0.06 });
    // nose, mouth (a nervous half grin)
    b.add(new THREE.BoxGeometry(0.028, 0.05, 0.034), shade(skin, 0.92), mat(0, -0.012, faceZ(0, -0.012, -0.004), 0.32, 0, 0));
    b.add(new THREE.BoxGeometry(0.07, 0.011, 0.012), LIPS, mat(-0.004, -0.07, faceZ(0, -0.07), 0, 0, 0.07));
    b.add(new THREE.BoxGeometry(0.022, 0.009, 0.012), LIPS, mat(0.038, -0.064, faceZ(0.038, -0.064), 0, 0, 0.6));
    // brows (worried) or one heroic monobrow
    if (face === 4) b.add(new THREE.BoxGeometry(0.13, 0.018, 0.016), HAIR, mat(0, 0.078, faceZ(0, 0.078, 0.004), -0.15, 0, 0));
    else
      for (const s of [-1, 1])
        b.add(new THREE.BoxGeometry(0.05, 0.012, 0.014), HAIR, mat(0.05 * s, 0.078, faceZ(0.05, 0.078, 0.004), -0.15, 0, -0.28 * s));
    if (face === 1) {
      // droopy moustache
      b.add(new THREE.BoxGeometry(0.08, 0.02, 0.02), HAIR, mat(0, -0.046, faceZ(0, -0.046, 0.012)));
      for (const s of [-1, 1]) b.add(new THREE.BoxGeometry(0.018, 0.04, 0.018), HAIR, mat(0.044 * s, -0.064, faceZ(0.044, -0.064, 0.008), 0, 0, 0.25 * s));
    } else if (face === 3) {
      // chin beard
      b.add(new THREE.IcosahedronGeometry(0.07, 1), HAIR, mat(0, -0.105, -0.058, 0, 0, 0, 1.3, 0.75, 0.95), { shade: 0.12, seed: 9 });
    }

    // open-face helmet: shell with the face opening, a forehead piece over it,
    // a centre stripe, a little peak and intercom ear cups
    const hs = mat(0, 0.02, 0.012, 0, 0, 0, 1, 1.08, 1.1);
    const front = (3 * Math.PI) / 2; // phi pointing at -Z
    const open = 1.95;
    b.add(sphereBand(0.15, Math.PI / 2, Math.PI * 2 - open, 0, Math.PI * 0.64, 12, 8), helmet.base, hs, { shade: 0.06, seed: 5 });
    b.add(sphereBand(0.15, front, open, 0, Math.PI * 0.3, 6, 3), helmet.base, hs, { shade: 0.06, seed: 6 });
    const ss = mat(0, 0.02, 0.012, 0, 0, 0, 1.012, 1.092, 1.112);
    b.add(sphereBand(0.15, Math.PI / 2, 0.36, 0, Math.PI * 0.64, 2, 8), helmet.stripe, ss);
    b.add(sphereBand(0.15, front, 0.36, 0, Math.PI * 0.3, 2, 3), helmet.stripe, ss);
    b.add(new THREE.BoxGeometry(0.2, 0.012, 0.07), shade(helmet.base, 0.75), mat(0, 0.118, -0.165, -0.22, 0, 0));
    for (const s of [-1, 1]) b.add(new THREE.CylinderGeometry(0.04, 0.04, 0.02, 8), 0x1d1d1f, mat(0.158 * s, -0.02, 0.0, 0, 0, Math.PI / 2));
    // intercom mic on a boom from the left ear cup to the mouth
    const [boom, bm] = rod(new THREE.Vector3(-0.16, -0.035, -0.03), new THREE.Vector3(-0.045, -0.078, faceZ(-0.045, -0.078, 0.025)), 0.006);
    b.add(boom, 0x1d1d1f, bm);
    b.add(new THREE.IcosahedronGeometry(0.017, 0), 0x1d1d1f, mat(-0.04, -0.078, faceZ(-0.04, -0.078, 0.03)));
    this.group.add(new THREE.Mesh(b.build(), vertexColored({ side: THREE.DoubleSide })));

    // googly eyes (separate so they can blink, dart about and pop wide open)
    const white = lambert(0xf6f3ea);
    const black = lambert(0x111111);
    const eyeGeo = new THREE.IcosahedronGeometry(0.04, 1);
    const pupilGeo = new THREE.IcosahedronGeometry(0.017, 1);
    for (const s of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(0.046 * s, 0.028, faceZ(0.046, 0.028, -0.014));
      const ball = new THREE.Mesh(eyeGeo, white);
      ball.scale.set(1, 1.15, 0.82);
      const pupil = new THREE.Mesh(pupilGeo, black);
      pupil.position.set(0, 0, -0.03);
      pupil.scale.set(1, 1, 0.6);
      eye.add(ball, pupil);
      this.group.add(eye);
      this.eyes.push(eye);
      this.pupils.push(pupil);
    }
    if (face === 2) {
      // shades: the eyes are still in there, somewhere
      const g = new GeoBuilder()
        .add(new THREE.BoxGeometry(0.075, 0.048, 0.012), 0x141414, mat(-0.046, 0.03, -0.128))
        .add(new THREE.BoxGeometry(0.075, 0.048, 0.012), 0x141414, mat(0.046, 0.03, -0.128))
        .add(new THREE.BoxGeometry(0.2, 0.012, 0.012), 0x2a2a2a, mat(0, 0.052, -0.126))
        .build();
      this.group.add(new THREE.Mesh(g, vertexColored()));
    }
  }

  /** Something scary happened (0..1): the eyes pop wide open for a moment. */
  startle(k: number) {
    this.fear = Math.max(this.fear, clamp(k, 0, 1));
  }

  /** Blinks, darting looks and fear. `gaze` (-1..1, head space) holds the look steady. */
  update(dt: number, gaze?: { x: number; y: number }) {
    this.fear = Math.max(0, this.fear - dt * 0.7);
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) {
      this.blinkT = 0.14;
      this.blinkIn = 2 + Math.random() * 4;
    }
    this.blinkT = Math.max(0, this.blinkT - dt);
    if (gaze) this.lookTarget.set(gaze.x, gaze.y);
    else {
      this.lookTimer -= dt;
      if (this.lookTimer <= 0) {
        this.lookTimer = 0.6 + Math.random() * 2.2;
        this.lookTarget.set((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.8);
      }
    }
    this.look.lerp(this.lookTarget, 1 - Math.exp(-dt * 18));
    const wide = 1 + this.fear * 0.45;
    const lid = this.blinkT > 0 ? 0.12 : 1;
    for (let i = 0; i < 2; i++) {
      this.eyes[i].scale.set(wide, wide * lid, wide);
      const p = this.pupils[i];
      p.position.set(this.look.x * 0.019, this.look.y * 0.017, -0.03 + Math.hypot(this.look.x, this.look.y) * 0.006);
      p.scale.setScalar(1 - this.fear * 0.35).setZ(0.6);
    }
  }

  dispose() {
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
}

export function suitOf(style: PlayerStyle): SuitLook {
  return SUITS[style.suit] ?? SUITS[0];
}

/** Standing torso (feet at y = 0) for the on-foot / lobby avatar: chest, shoulders, waist. */
export function standingTorso(style: PlayerStyle): THREE.BufferGeometry {
  const s = suitOf(style);
  const sh = { shade: 0.06 };
  const oval = (rTop: number, rBot: number, h: number, y: number, col: number, depth = 0.56) =>
    [new THREE.CylinderGeometry(rTop, rBot, h, 8), col, mat(0, y, 0, 0, Math.PI / 8, 0, 1, 1, depth)] as const;
  return new GeoBuilder()
    .add(...oval(0.25, 0.21, 0.34, 1.33, s.base), sh) // chest
    .add(...oval(0.205, 0.2, 0.26, 1.04, s.base), sh) // belly
    .add(...oval(0.212, 0.2, 0.15, 0.9, s.base), sh) // hips
    .add(...oval(0.254, 0.249, 0.05, 1.39, s.accent, 0.565)) // chest band
    .add(...oval(0.214, 0.214, 0.055, 0.96, s.trim, 0.61)) // belt
    // shoulder pads, collar
    .add(new THREE.IcosahedronGeometry(0.095, 0), s.base, mat(-0.245, 1.46, 0, 0, 0, 0, 1, 0.8, 1), sh)
    .add(new THREE.IcosahedronGeometry(0.095, 0), s.base, mat(0.245, 1.46, 0, 0, 0, 0, 1, 0.8, 1), sh)
    .add(new THREE.CylinderGeometry(0.075, 0.1, 0.07, 8), s.accent, mat(0, 1.52, 0))
    // side stripes, zip, patches, buckle
    .add(new THREE.BoxGeometry(0.02, 0.52, 0.06), s.accent, mat(-0.222, 1.17, 0, 0, 0, 0.1))
    .add(new THREE.BoxGeometry(0.02, 0.52, 0.06), s.accent, mat(0.222, 1.17, 0, 0, 0, -0.1))
    .add(new THREE.BoxGeometry(0.012, 0.5, 0.01), s.trim, mat(0, 1.17, -0.124))
    .add(new THREE.BoxGeometry(0.11, 0.05, 0.01), 0xf4f1e8, mat(0.1, 1.28, -0.13))
    .add(new THREE.BoxGeometry(0.06, 0.04, 0.01), 0xe8742b, mat(-0.1, 1.3, -0.13))
    .add(new THREE.BoxGeometry(0.09, 0.03, 0.01), 0xf2c230, mat(-0.09, 1.12, -0.118))
    .add(new THREE.BoxGeometry(0.06, 0.05, 0.01), 0xb8b8b8, mat(0, 0.96, -0.13))
    .build();
}

/** One leg (hip at the origin, foot at y = -0.86); `side` -1 left, +1 right. */
export function standingLeg(style: PlayerStyle, side: -1 | 1): THREE.BufferGeometry {
  const s = suitOf(style);
  const sh = { shade: 0.06 };
  return new GeoBuilder()
    .add(new THREE.CylinderGeometry(0.1, 0.085, 0.46, 7), s.base, mat(0, -0.22, 0), sh) // thigh
    .add(new THREE.IcosahedronGeometry(0.085, 0), s.base, mat(0, -0.46, -0.005), sh) // knee
    .add(new THREE.CylinderGeometry(0.08, 0.07, 0.34, 7), s.base, mat(0, -0.63, 0), sh) // shin
    .add(new THREE.BoxGeometry(0.014, 0.44, 0.04), s.accent, mat(0.092 * side, -0.22, 0))
    .add(new THREE.BoxGeometry(0.014, 0.32, 0.04), s.accent, mat(0.075 * side, -0.63, 0))
    // racing boots: black with a white sole and a trim stripe
    .add(new THREE.BoxGeometry(0.17, 0.14, 0.3), 0x1d1d1f, mat(0, -0.8, -0.05))
    .add(new THREE.BoxGeometry(0.175, 0.025, 0.31), 0xe9e4d8, mat(0, -0.875, -0.05))
    .add(new THREE.BoxGeometry(0.176, 0.02, 0.22), s.trim === 0x1d1d1f ? s.accent : s.trim, mat(0, -0.78, -0.06))
    .build();
}

/** Seated torso with harness and HANS collar (car-local, see Occupant). */
export function seatedTorso(style: PlayerStyle): THREE.BufferGeometry {
  const s = suitOf(style);
  const sh = { shade: 0.06 };
  const harness = 0xc23b2c;
  return new GeoBuilder()
    .add(new THREE.BoxGeometry(0.42, 0.5, 0.22), s.base, mat(0, 0.0, 0), sh)
    .add(new THREE.BoxGeometry(0.44, 0.1, 0.24), s.base, mat(0, 0.22, 0.0), sh)
    .add(new THREE.BoxGeometry(0.432, 0.36, 0.12), s.accent, mat(0, -0.02, 0.0))
    .add(new THREE.BoxGeometry(0.426, 0.05, 0.226), s.accent, mat(0, 0.13, 0))
    .add(new THREE.BoxGeometry(0.11, 0.045, 0.01), 0xf4f1e8, mat(0.1, 0.06, -0.113))
    .add(new THREE.BoxGeometry(0.06, 0.04, 0.01), 0xe8742b, mat(-0.1, 0.08, -0.113))
    // harness straps + buckle
    .add(new THREE.BoxGeometry(0.06, 0.5, 0.012), harness, mat(-0.11, 0.0, -0.116))
    .add(new THREE.BoxGeometry(0.06, 0.5, 0.012), harness, mat(0.11, 0.0, -0.116))
    .add(new THREE.BoxGeometry(0.42, 0.05, 0.012), harness, mat(0, -0.2, -0.118))
    .add(new THREE.BoxGeometry(0.08, 0.08, 0.02), 0xb8b8b8, mat(0, -0.17, -0.122))
    // HANS collar over the shoulders
    .add(new THREE.BoxGeometry(0.26, 0.07, 0.1), 0x1d1d1f, mat(0, 0.29, 0.08))
    .add(new THREE.BoxGeometry(0.05, 0.035, 0.2), 0x1d1d1f, mat(-0.1, 0.27, -0.01))
    .add(new THREE.BoxGeometry(0.05, 0.035, 0.2), 0x1d1d1f, mat(0.1, 0.27, -0.01))
    // thighs
    .add(new THREE.BoxGeometry(0.4, 0.2, 0.36), s.base, mat(0, -0.3, -0.12), sh)
    .add(new THREE.BoxGeometry(0.4, 0.14, 0.4), s.base, mat(0, -0.2, -0.38), sh)
    .add(new THREE.BoxGeometry(0.404, 0.03, 0.4), s.accent, mat(0, -0.2, -0.38))
    .build();
}

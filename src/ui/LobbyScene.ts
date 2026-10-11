// The 3D "service park" behind the main menu and the lobby: the rally car on a
// gravel pad, with each player's character standing at their door - name tag,
// their own helmet / suit / face, idling, waving once ready - and a ghost where
// a co-driver is still missing. The car wears the driver's livery. The camera
// slowly sways around the scene, or moves in close while you change your look.
// The sky, light and scenery follow the chosen stage (countryside / mountain,
// day / night).

import * as THREE from 'three';
import { Cockpit } from '../cockpit/Cockpit';
import { FootAvatar } from '../game/OnFoot';
import { GeoBuilder, mat } from '../rendering/geometry';
import { vertexColored } from '../rendering/materials';
import type { Renderer } from '../rendering/Renderer';
import { Sky } from '../rendering/Sky';
import { clamp } from '../shared/math';
import { Noise2D, Rng } from '../shared/rng';
import { encodeStyle, LIVERIES, type PlayerStyle } from '../shared/style';
import type { Role, StageMap } from '../shared/types';
import { CarModel } from '../vehicle/CarModel';

export interface LobbySlot {
  name: string;
  role: Role | null;
  ready: boolean;
  me: boolean;
  connected: boolean;
  style: PlayerStyle;
  /** Main menu: just the name plate, no role / ready state. */
  menu?: boolean;
}

/** The car's nose points (roughly) at the camera. */
const CAR_YAW = -2.75;
/** Where each role stands (car-local): in front of the car at its own corner (car forward = -Z). */
const SPOT: Record<Role, THREE.Vector3> = { driver: new THREE.Vector3(-1.55, 0, -3.15), navigator: new THREE.Vector3(1.55, 0, -3.15) };
const CAM_TARGET = new THREE.Vector3(0.6, 1.55, 1.4);

interface SlotView {
  key: string;
  avatar: FootAvatar | null;
  ghost: THREE.Group | null;
  tag: THREE.Sprite;
  tagKey: string;
  ring: THREE.Mesh | null;
  phase: number;
  data: LobbySlot | null;
  side: Role;
  /** 1 -> 0: a little show-off twirl after a new look. */
  spin: number;
}

export class LobbyScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 1200);
  private env = new THREE.Group();
  private sky: Sky | null = null;
  private car: CarModel;
  private lookKey = '';
  private night = false;
  private slots: SlotView[] = [];
  private t = 0;
  private lamps: THREE.PointLight[] = [];
  private carYaw = CAR_YAW;
  private livery = 0;
  private cockpit: Cockpit;
  /** 0 = wide shot of the park, 1 = close-up of you (changing your look). */
  private focus = 0;
  private focusTarget = 0;

  constructor(private renderer: Renderer) {
    this.camera.layers.enableAll();
    this.car = new CarModel();
    this.cockpit = new Cockpit();
    this.placeCar();
    this.scene.add(this.env);
    this.setLook('countryside', false);
  }

  private placeCar() {
    this.car.root.add(this.cockpit.group);
    this.car.root.position.set(0, 0.5, 0);
    this.car.root.rotation.y = this.carYaw;
    this.car.updateWheels([0.09, 0.09, 0.09, 0.09], [0, 0, 0, 0], 0.18);
    this.car.setHeadlights(this.night);
    this.car.root.traverse((o) => o.layers.enableAll());
    this.scene.add(this.car.root);
  }

  /** Repaints the car (index into LIVERIES). */
  setLivery(index: number) {
    if (index === this.livery || !LIVERIES[index]) return;
    this.livery = index;
    this.car.dispose();
    this.cockpit.dispose();
    this.car = new CarModel(LIVERIES[index]);
    this.cockpit = new Cockpit(LIVERIES[index]);
    this.placeCar();
  }

  /** Close-up of your own character (while you pick a look) or the wide shot. */
  setFocus(on: boolean) {
    this.focusTarget = on ? 1 : 0;
  }

  /** Rebuilds the sky and scenery when the stage choice changes. */
  setLook(map: StageMap, night: boolean) {
    const key = `${map}|${night}`;
    if (key === this.lookKey) return;
    this.lookKey = key;
    this.night = night;
    const mountain = map === 'mountain';
    this.sky?.dispose();
    this.env.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.env.clear();
    this.lamps = [];
    this.sky = new Sky(this.scene, this.renderer.shadowMapSize, night, mountain);
    this.sky.update(new THREE.Vector3(0, 0, 0));
    this.car.setHeadlights(night);
    this.buildGround(mountain);
    this.buildProps(mountain);
    // floodlights over the service park (warm pools of light at night)
    for (const [x, z] of [[-6.5, -4.5], [6, -5.5]]) {
      const pole = new THREE.Mesh(
        new GeoBuilder()
          .add(new THREE.CylinderGeometry(0.07, 0.09, 6, 6), 0x3a3a38, mat(0, 3, 0))
          .add(new THREE.BoxGeometry(0.7, 0.18, 0.35), 0x2a2a28, mat(0, 6, 0))
          .build(),
        vertexColored(),
      );
      pole.position.set(x, 0, z);
      pole.castShadow = true;
      this.env.add(pole);
      const lamp = new THREE.PointLight(0xffd9a0, night ? 38 : 0, 22, 1.6);
      lamp.position.set(x, 5.8, z);
      lamp.layers.enableAll();
      this.env.add(lamp);
      this.lamps.push(lamp);
    }
    // at night: a soft fill from the camera's side so the crew aren't silhouettes
    const fill = new THREE.PointLight(0xffe2b8, night ? 30 : 0, 26, 1.4);
    fill.position.set(3, 4.5, 10);
    this.env.add(fill);
    this.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) o.layers.enableAll();
    });
  }

  private buildGround(mountain: boolean) {
    const noise = new Noise2D(911);
    const size = 260;
    const seg = 64;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg).toNonIndexed();
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const height = (x: number, z: number) => {
      const r = Math.hypot(x, z);
      if (r < 11) return 0;
      const rise = mountain ? Math.pow((r - 11) / 40, 1.6) * 26 : Math.pow((r - 11) / 60, 1.4) * 7;
      return rise + noise.fbm(x / 30, z / 30, 3) * (mountain ? 5 : 1.6) * Math.min(1, (r - 11) / 10);
    };
    for (let i = 0; i < pos.count; i++) pos.setY(i, height(pos.getX(i), pos.getZ(i)));
    const colors: number[] = [];
    const c = new THREE.Color();
    const rng = new Rng(17);
    const gravelA = new THREE.Color(0x9e8866);
    const gravelB = new THREE.Color(0x8b7556);
    const grass = new THREE.Color(mountain ? 0x93a24e : 0x5f9a3e);
    const grass2 = new THREE.Color(mountain ? 0xa8a35c : 0x4f8a35);
    const rock = new THREE.Color(0x7a766f);
    for (let i = 0; i < pos.count; i += 3) {
      const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
      const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      const r = Math.hypot(cx, cz);
      if (r < 10.5) c.copy(gravelA).lerp(gravelB, rng.next());
      else if (mountain && r > 28 && noise.noise(cx / 18, cz / 18) > 0.1) c.copy(rock);
      else c.copy(grass).lerp(grass2, rng.next());
      c.multiplyScalar(0.92 + rng.next() * 0.12);
      for (let k = 0; k < 3; k++) colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, vertexColored());
    ground.receiveShadow = true;
    this.env.add(ground);
    // tyre tracks on the gravel
    const track = new GeoBuilder();
    for (const off of [-0.75, 0.75]) {
      for (let a = -1.2; a < 1.2; a += 0.12) {
        const r = 7 + off;
        const p0 = new THREE.Vector3(Math.cos(a) * r, 0.012, Math.sin(a) * r + 1);
        const p1 = new THREE.Vector3(Math.cos(a + 0.12) * r, 0.012, Math.sin(a + 0.12) * r + 1);
        const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(0.16);
        track.addQuad(p0.clone().sub(n), p1.clone().sub(n), p1.clone().add(n), p0.clone().add(n), 0x6f5c44);
      }
    }
    const tracks = new THREE.Mesh(track.build(), vertexColored({ side: THREE.DoubleSide }));
    tracks.receiveShadow = true;
    this.env.add(tracks);
  }

  private buildProps(mountain: boolean) {
    const rng = new Rng(mountain ? 5 : 3);
    // hay bales and a tyre stack round the edge of the pad
    const bale = new GeoBuilder().add(new THREE.CylinderGeometry(0.62, 0.62, 1.3, 9), 0xd8b04f, mat(0, 0.62, 0, 0, 0, Math.PI / 2), { shade: 0.12 }).build();
    for (const [x, z, yaw] of [[-5.6, 2.6, 0.3], [-4.4, 3.6, 1.1], [7.4, 5.2, -0.4], [-6.6, -1.2, 1.5]]) {
      const m = new THREE.Mesh(bale, vertexColored());
      m.position.set(x, 0, z);
      m.rotation.y = yaw;
      m.castShadow = true;
      m.receiveShadow = true;
      this.env.add(m);
    }
    const tyres = new GeoBuilder();
    for (let i = 0; i < 4; i++) tyres.add(new THREE.TorusGeometry(0.34, 0.14, 6, 10), 0x1d1d1c, mat(0, 0.14 + i * 0.27, 0, Math.PI / 2, 0, 0), { shade: 0.1 });
    const stack = new THREE.Mesh(tyres.build(), vertexColored());
    stack.position.set(4.6, 0, -2.4);
    stack.castShadow = true;
    this.env.add(stack);
    // start banner behind the car
    const arch = new GeoBuilder()
      .add(new THREE.BoxGeometry(0.22, 4.4, 0.22), 0x2a2a28, mat(-4.2, 2.2, 0))
      .add(new THREE.BoxGeometry(0.22, 4.4, 0.22), 0x2a2a28, mat(4.2, 2.2, 0))
      .build();
    const archMesh = new THREE.Mesh(arch, vertexColored());
    archMesh.castShadow = true;
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(8.2, 1.15), new THREE.MeshLambertMaterial({ map: bannerTexture(), side: THREE.DoubleSide }));
    banner.position.set(0, 3.9, 0);
    banner.castShadow = true;
    const archGroup = new THREE.Group();
    archGroup.add(archMesh, banner);
    archGroup.position.set(1.5, 0, -6.5);
    archGroup.rotation.y = 0.25;
    this.env.add(archGroup);
    // trees (and on the mountain, boulders) around the park
    const tree = new GeoBuilder()
      .add(new THREE.CylinderGeometry(0.15, 0.22, 1.6, 5), 0x5b4130, mat(0, 0.8, 0), { shade: 0.1 })
      .add(new THREE.ConeGeometry(1.55, 2.3, 7), 0x2f6b35, mat(0, 2.1, 0), { shade: 0.16, jitter: 0.22, seed: 1 })
      .add(new THREE.ConeGeometry(1.15, 2.0, 6), 0x377a3a, mat(0, 3.3, 0, 0, 0.4, 0), { shade: 0.16, jitter: 0.18, seed: 2 })
      .add(new THREE.ConeGeometry(0.72, 1.7, 6), 0x41853f, mat(0, 4.4, 0, 0, 0.9, 0), { shade: 0.16, jitter: 0.12, seed: 3 })
      .build();
    const boulder = new GeoBuilder().add(new THREE.DodecahedronGeometry(1, 0), 0x86837a, mat(0, 0, 0, 0, 0, 0, 1.2, 0.8, 1), { shade: 0.2, jitter: 0.35, seed: 9 }).build();
    const n = mountain ? 26 : 60;
    for (let i = 0; i < n; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = 14 + rng.next() * 45;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (z > 6 && Math.abs(x) < 14) continue; // keep the view towards the camera clear
      const rise = mountain ? Math.pow(Math.max(0, r - 11) / 40, 1.6) * 26 : Math.pow(Math.max(0, r - 11) / 60, 1.4) * 7;
      const m = new THREE.Mesh(mountain && rng.chance(0.45) ? boulder : tree, vertexColored());
      m.position.set(x, rise - 0.2, z);
      m.scale.setScalar(0.8 + rng.next() * 0.8);
      m.rotation.y = rng.next() * 6;
      m.castShadow = true;
      this.env.add(m);
    }
  }

  /** Players to show: slot 0 and 1 (null = empty seat -> ghost). In the main menu pass just yourself. */
  setSlots(players: (LobbySlot | null)[]) {
    while (this.slots.length < players.length) {
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(document.createElement('canvas')), depthTest: false, transparent: true }));
      tag.renderOrder = 10;
      tag.layers.enableAll();
      this.scene.add(tag);
      this.slots.push({ key: '', avatar: null, ghost: null, tag, tagKey: '', ring: null, phase: this.slots.length * 2.1, data: null, side: 'driver', spin: 0 });
    }
    while (this.slots.length > players.length) this.disposeSlot(this.slots.pop()!);
    const taken = new Set(players.filter((p): p is LobbySlot => !!p?.role).map((p) => p.role!));
    players.forEach((p, i) => {
      const sv = this.slots[i];
      sv.data = p;
      // stand at your role's door; without a role, the free side (slot order)
      const pref: Role = i === 0 ? 'driver' : 'navigator';
      sv.side = p?.role ?? (taken.has(pref) ? (pref === 'driver' ? 'navigator' : 'driver') : pref);
      const key = p ? `p|${p.role ?? 'none'}|${encodeStyle(p.style)}` : 'ghost';
      if (key !== sv.key) {
        // same player, new look: show it off
        if (p && sv.key.startsWith(`p|${p.role ?? 'none'}|`)) sv.spin = 1;
        sv.key = key;
        sv.avatar?.dispose();
        sv.avatar = null;
        if (sv.ghost) {
          sv.ghost.removeFromParent();
          sv.ghost.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
          sv.ghost = null;
        }
        if (p) {
          sv.avatar = new FootAvatar(p.style, p.role);
          sv.avatar.root.traverse((o) => o.layers.enableAll());
          this.scene.add(sv.avatar.root);
        } else {
          sv.ghost = ghostFigure();
          this.scene.add(sv.ghost);
        }
      }
      if (p?.me && !sv.ring) {
        sv.ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.64, 36).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xe8742b, transparent: true, opacity: 0.85, depthWrite: false }));
        sv.ring.layers.enableAll();
        this.scene.add(sv.ring);
      } else if (!p?.me && sv.ring) {
        sv.ring.removeFromParent();
        sv.ring.geometry.dispose();
        sv.ring = null;
      }
      const tagKey = p ? `${p.name}|${p.role}|${p.ready}|${p.me}|${p.connected}|${p.menu}` : 'ghost';
      if (tagKey !== sv.tagKey) {
        sv.tagKey = tagKey;
        drawTag(sv.tag, p);
      }
    });
  }

  private disposeSlot(sv: SlotView) {
    sv.avatar?.dispose();
    sv.ghost?.removeFromParent();
    sv.ring?.removeFromParent();
    sv.tag.removeFromParent();
    sv.tag.material.map?.dispose();
    sv.tag.material.dispose();
  }

  private spotOf(sv: SlotView): THREE.Vector3 {
    const carQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.carYaw);
    return SPOT[sv.side].clone().applyQuaternion(carQ).add(this.car.root.position.clone().setY(0));
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t;
    // camera: from the front-left of the car, slowly swaying round it ...
    const ang = 0.35 + Math.sin(t * 0.07) * 0.32;
    const wideCam = new THREE.Vector3(Math.sin(ang) * 9.6, 2.5 + Math.sin(t * 0.11) * 0.25, Math.cos(ang) * 9.6);
    const camPos = wideCam.clone();
    const target = CAM_TARGET.clone();
    // ... or close in on you, a little to the side so the car shows behind
    this.focus += (this.focusTarget - this.focus) * Math.min(1, dt * 3.2);
    const mine = this.slots.find((sv) => sv.data?.me);
    if (mine && this.focus > 0.001) {
      const spot = this.spotOf(mine);
      const dir = new THREE.Vector3(wideCam.x - spot.x, 0, wideCam.z - spot.z).normalize();
      const sideways = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(mine.side === 'driver' ? -0.9 : 0.9);
      const close = spot.clone().addScaledVector(dir, 3.3).add(sideways).add(new THREE.Vector3(0, 1.45 + Math.sin(t * 0.4) * 0.05, 0));
      const k = this.focus * this.focus * (3 - 2 * this.focus);
      camPos.lerp(close, k);
      target.lerp(spot.clone().add(new THREE.Vector3(0, 1.08, 0)), k);
    }
    this.camera.position.copy(camPos);
    this.camera.lookAt(target);
    for (const sv of this.slots) {
      const spot = this.spotOf(sv);
      const toCam = camPos.clone().sub(spot);
      const facing = Math.atan2(-toCam.x, -toCam.z); // face the camera
      // mostly towards the camera, turned a little towards each other; a twirl after a new look
      sv.spin = Math.max(0, sv.spin - dt * 1.3);
      const twirl = sv.spin > 0 ? (1 - sv.spin) ** 0.6 * Math.PI * 2 : 0;
      const yaw = facing + (sv.side === 'driver' ? 0.28 : -0.28) * (sv.data?.me ? 1 - this.focus : 1) + twirl;
      const p = sv.data;
      if (sv.avatar && p) {
        const ph = t + sv.phase;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        const side = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
        const bob = Math.sin(ph * 1.7) * 0.012;
        const shoulderL = new THREE.Vector3(-0.27, 1.45 + bob, 0).applyQuaternion(q).add(spot);
        const shoulderR = new THREE.Vector3(0.27, 1.45 + bob, 0).applyQuaternion(q).add(spot);
        // left hand on the hip
        const hip = shoulderL.clone().add(new THREE.Vector3(0, -0.5, 0)).addScaledVector(side, -0.1).addScaledVector(fwd, 0.08);
        let handR: THREE.Vector3 | null = null;
        let headYaw = Math.sin(ph * 0.45) * 0.4;
        let headPitch = Math.sin(ph * 0.3) * 0.08;
        if (!p.connected) {
          headPitch = -0.55;
          headYaw = 0;
        } else if (p.ready) {
          // waving above the head
          handR = shoulderR.clone().add(new THREE.Vector3(0, 0.62, 0)).addScaledVector(side, 0.18 + Math.sin(ph * 7) * 0.16).addScaledVector(fwd, 0.05);
          headYaw = 0;
          headPitch = 0.12;
        } else if (Math.sin(ph * 0.21) > 0.75) {
          // now and then: a glance at the watch
          handR = shoulderR.clone().add(new THREE.Vector3(0, -0.25, 0)).addScaledVector(fwd, 0.32).addScaledVector(side, -0.18);
          headPitch = -0.45;
          headYaw = -0.25;
        }
        if (p.me && this.focus > 0.5 && !p.ready) {
          // posing for the camera: both hands on the hips, looking straight at you
          headYaw = Math.sin(ph * 0.5) * 0.12;
          headPitch = 0.05;
          handR = shoulderR.clone().add(new THREE.Vector3(0, -0.5, 0)).addScaledVector(side, 0.1).addScaledVector(fwd, 0.08);
        }
        sv.avatar.poseFree(spot, yaw, headYaw, headPitch, p.connected ? hip : null, handR, bob);
        // eyes: dart about, or hold the camera's gaze in the close-up
        sv.avatar.face.update(dt, p.me && this.focus > 0.5 ? { x: clamp(-headYaw * 1.6, -1, 1), y: clamp(-headPitch, -1, 1) } : undefined);
        if (sv.spin > 0.9) sv.avatar.face.startle(0.8);
      }
      if (sv.ghost) {
        sv.ghost.position.copy(spot);
        sv.ghost.rotation.y = yaw;
        const op = 0.3 + 0.12 * Math.sin(t * 2.2);
        sv.ghost.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
          if (m) m.opacity = op;
        });
      }
      if (sv.ring) {
        sv.ring.position.copy(spot).add(new THREE.Vector3(0, 0.02, 0));
        sv.ring.scale.setScalar(1 + Math.sin(t * 3) * 0.06);
        (sv.ring.material as THREE.MeshBasicMaterial).opacity = 0.6 + Math.sin(t * 3) * 0.25;
      }
      sv.tag.position.copy(spot).add(new THREE.Vector3(0, 2.16 + Math.sin(t * 1.3 + sv.phase) * 0.03, 0));
      sv.tag.visible = this.focus < 0.4;
    }
    // flickery floodlights at night
    for (const l of this.lamps) l.intensity = this.night ? 36 + Math.sin(t * 13 + l.position.x) * 0.6 : 0;
  }

  /**
   * `shiftX`: fraction of the screen width to push the scene left (panel on the right);
   * `shiftY`: fraction of the height to push it up (narrow screens: panel below).
   */
  render(shiftX: number, shiftY = 0) {
    const w = this.renderer.width;
    const h = this.renderer.height;
    // portrait screens: keep the crew and the car in frame by widening the view
    const aspect = w / Math.max(1, h);
    const fov = aspect >= 1.2 ? 40 : Math.min(78, (2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(24)) / aspect) * 180) / Math.PI);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    if (shiftX > 0 || shiftY > 0) this.camera.setViewOffset(w, h, w * shiftX, h * shiftY, w, h);
    else this.camera.clearViewOffset();
    this.renderer.render(this.scene, [{ camera: this.camera, x: 0, y: 0, w: 1, h: 1 }]);
  }

  dispose() {
    for (const sv of this.slots) this.disposeSlot(sv);
    this.slots = [];
    this.sky?.dispose();
    this.car.dispose();
    this.cockpit.dispose();
    this.scene.clear();
  }
}

/** A see-through silhouette standing where your co-driver will be. */
function ghostFigure(): THREE.Group {
  const g = new THREE.Group();
  const m = new THREE.MeshBasicMaterial({ color: 0xf4efe2, transparent: true, opacity: 0.15, depthWrite: false });
  const add = (geo: THREE.BufferGeometry, x: number, y: number) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, 0);
    mesh.layers.enableAll();
    g.add(mesh);
  };
  add(new THREE.BoxGeometry(0.44, 0.66, 0.24), 0, 1.22);
  add(new THREE.IcosahedronGeometry(0.16, 1), 0, 1.68);
  add(new THREE.BoxGeometry(0.16, 0.88, 0.18), -0.11, 0.44);
  add(new THREE.BoxGeometry(0.16, 0.88, 0.18), 0.11, 0.44);
  add(new THREE.BoxGeometry(0.12, 0.6, 0.12), -0.32, 1.2);
  add(new THREE.BoxGeometry(0.12, 0.6, 0.12), 0.32, 1.2);
  g.layers.enableAll();
  return g;
}

/** Floating name tag: name, role chip and ready state. */
function drawTag(sprite: THREE.Sprite, p: LobbySlot | null) {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 176;
  const g = cv.getContext('2d')!;
  const font = "'Arial Black', 'Arial Bold', Impact, sans-serif";
  g.save();
  g.transform(1, 0, -0.14, 1, 14, 0); // rally skew
  g.fillStyle = 'rgba(16,16,14,0.88)';
  g.fillRect(20, 10, 470, 104);
  g.fillStyle = p ? (p.role === 'driver' ? '#3a7fd0' : p.role === 'navigator' ? '#2f8f46' : '#e8742b') : '#77746c';
  g.fillRect(20, 10, 12, 104);
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  if (!p) {
    g.fillStyle = '#d9d1bd';
    g.font = `30px ${font}`;
    g.fillText('WAITING FOR', 48, 44);
    g.fillText('CO-DRIVER…', 48, 84);
  } else {
    g.fillStyle = '#f4efe2';
    let size = 44;
    g.font = `${size}px ${font}`;
    while (g.measureText(p.name).width > 400 && size > 22) g.font = `${(size -= 2)}px ${font}`;
    g.fillText(p.name, 48, 48);
    g.font = `22px ${font}`;
    g.fillStyle = '#d9d1bd';
    const role = p.role ? p.role.toUpperCase() : 'PICK A ROLE';
    g.fillText(p.menu ? 'THAT IS YOU' : p.me ? `YOU · ${role}` : role, 48, 92);
  }
  g.restore();
  if (p && !p.menu) {
    // ready chip below the plate
    const label = !p.connected ? 'RECONNECTING…' : p.ready ? 'READY!' : 'NOT READY';
    g.font = `24px ${font}`;
    const w = g.measureText(label).width + 30;
    g.save();
    g.transform(1, 0, -0.14, 1, 14, 0);
    g.fillStyle = !p.connected ? '#f2c230' : p.ready ? '#5cbf6b' : '#444441';
    g.fillRect(60, 124, w, 40);
    g.fillStyle = p.ready || !p.connected ? '#151513' : '#f4efe2';
    g.fillText(label, 75, 145);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  sprite.material.map?.dispose();
  sprite.material.map = tex;
  sprite.material.needsUpdate = true;
  sprite.scale.set(2.3, 2.3 * (176 / 512), 1);
}

function bannerTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 1024;
  cv.height = 144;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#151513';
  g.fillRect(0, 0, 1024, 144);
  for (let x = -40; x < 1024; x += 56) {
    g.fillStyle = '#e8742b';
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 26, 0);
    g.lineTo(x + 6, 14);
    g.lineTo(x - 20, 14);
    g.fill();
    g.beginPath();
    g.moveTo(x, 130);
    g.lineTo(x + 26, 130);
    g.lineTo(x + 6, 144);
    g.lineTo(x - 20, 144);
    g.fill();
  }
  g.font = "86px 'Arial Black', 'Arial Bold', Impact, sans-serif";
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  g.transform(1, 0, -0.18, 1, 12, 0);
  g.fillStyle = '#e8742b';
  g.fillText('LEFT!', 300, 76);
  g.fillStyle = '#f2c230';
  g.fillText('LEFT!', 560, 76);
  g.fillStyle = '#f4efe2';
  g.fillText('LEFT!', 820, 76);
  g.restore();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

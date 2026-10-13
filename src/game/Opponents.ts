// The other crews' cars in the versus modes. Each one is driven by its own
// player (their own physics on their own computer); we get their validated car
// states from the server (~15 Hz) and interpolate them like the navigator does
// for their own car. Rally "ghost" rules: no collisions, and a car is hidden
// while it is right on top of you (you all start on the same line). A name
// tag in the crew's colour floats above each car.

import * as THREE from 'three';
import { Occupant } from '../cockpit/Occupant';
import { setLayer } from '../rendering/geometry';
import { LAYER } from '../rendering/layers';
import { interpolateCar, SnapshotBuffer } from '../multiplayer/SnapshotBuffer';
import { CAR } from '../shared/snapshot';
import { LIVERIES, type PlayerStyle } from '../shared/style';
import { CarModel } from '../vehicle/CarModel';

export interface OpponentInfo {
  team: number;
  /** Crew names, driver first. */
  names: string[];
  driver: PlayerStyle;
  navigator: PlayerStyle;
  color: string;
}

interface OppCar {
  info: OpponentInfo;
  car: CarModel;
  buf: SnapshotBuffer;
  sample: Float32Array;
  spin: number;
  tag: THREE.Sprite;
  crew: Occupant[];
  seen: boolean;
}

/** Hidden when closer than this to the camera (overlapping at the start, passing through). */
const HIDE_WITHIN = 6;

export class Opponents {
  readonly group = new THREE.Group();
  private cars = new Map<number, OppCar>();

  constructor(infos: OpponentInfo[], night: boolean) {
    for (const info of infos) {
      const car = new CarModel(LIVERIES[info.driver.livery] ?? LIVERIES[0], { lights: false });
      car.setHeadlights(night);
      // their crew, sitting in the car (heads and bodies only)
      const crew = [new Occupant('driver', info.driver), new Occupant('navigator', info.navigator)];
      for (const o of crew) {
        o.pose(new THREE.Vector3(), 0, 0);
        o.left.setVisible(false);
        o.right.setVisible(false);
        car.root.add(o.group);
      }
      // everything on the world layer (the body layers hide *your own* crew from your cameras)
      setLayer(car.root, LAYER.WORLD);
      car.root.visible = false;
      this.group.add(car.root);
      const tag = makeTag(info);
      tag.visible = false;
      this.group.add(tag);
      this.cars.set(info.team, { info, car, buf: new SnapshotBuffer(CAR.LENGTH, interpolateCar, 0.15), sample: new Float32Array(CAR.LENGTH), spin: 0, tag, crew, seen: false });
    }
  }

  push(team: number, buf: Float32Array) {
    const o = this.cars.get(team);
    if (o) o.buf.push(buf, performance.now() / 1000);
  }

  /** Where the others are (for the tablet). */
  positions(): { team: number; x: number; z: number; color: string }[] {
    const out: { team: number; x: number; z: number; color: string }[] = [];
    for (const o of this.cars.values()) if (o.seen) out.push({ team: o.info.team, x: o.car.root.position.x, z: o.car.root.position.z, color: o.info.color });
    return out;
  }

  update(dt: number, camPos: THREE.Vector3) {
    const now = performance.now() / 1000;
    for (const o of this.cars.values()) {
      if (!o.buf.sample(now, o.sample)) continue;
      o.seen = true;
      const s = o.sample;
      const root = o.car.root;
      root.position.set(s[CAR.px], s[CAR.py], s[CAR.pz]);
      root.quaternion.set(s[CAR.qx], s[CAR.qy], s[CAR.qz], s[CAR.qw]).normalize();
      const speed = Math.hypot(s[CAR.vx], s[CAR.vz]);
      o.spin += (speed / 0.3) * dt;
      o.car.updateWheels([0.09, 0.09, 0.09, 0.09], [o.spin, o.spin, o.spin, o.spin], s[CAR.steer]);
      o.car.setBrakeLights(s[CAR.brake] > 0.1);
      const near = root.position.distanceTo(camPos) < HIDE_WITHIN;
      root.visible = !near;
      o.tag.visible = !near;
      o.tag.position.copy(root.position).add(new THREE.Vector3(0, 2.3, 0));
    }
  }

  dispose() {
    for (const o of this.cars.values()) {
      o.car.dispose();
      for (const c of o.crew) c.dispose();
      o.tag.material.map?.dispose();
      o.tag.material.dispose();
    }
    this.cars.clear();
    this.group.removeFromParent();
  }
}

function makeTag(info: OpponentInfo): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 96;
  const g = cv.getContext('2d')!;
  g.fillStyle = 'rgba(16,16,14,0.85)';
  g.fillRect(8, 8, 496, 80);
  g.fillStyle = info.color;
  g.fillRect(8, 8, 14, 80);
  g.fillStyle = '#f4efe2';
  g.font = "bold 40px 'Arial Black', 'Arial Bold', Impact, sans-serif";
  g.textBaseline = 'middle';
  let label = info.names.join(' + ');
  while (g.measureText(label).width > 460 && label.length > 4) label = label.slice(0, -2) + '…';
  g.fillText(label, 36, 50);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sprite.scale.set(3.2, 0.6, 1);
  sprite.layers.enableAll();
  return sprite;
}

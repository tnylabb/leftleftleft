// The navigator's head lamp: strapped to the forehead, with a real spotlight
// that follows the wearer's head / view direction, in the car and on foot.
// The beam lights whatever it actually points at - the tablet, the cabin, the
// road - and can blind the driver.

import * as THREE from 'three';
import { GeoBuilder, mat, setLayer } from '../rendering/geometry';
import { LAYER } from '../rendering/layers';
import { vertexColored } from '../rendering/materials';

const CONE = 0.52; // spotlight half angle (rad): a wide, soft-edged beam
const PENUMBRA = 0.9; // fraction of the cone that fades out towards the edge
const RANGE = 14;
/** Lamp position relative to the wearer's eye (eye frame: -Z forward, +Y up). */
const LAMP_OFFSET = new THREE.Vector3(0, 0.085, -0.11);

export class Headlamp {
  /** World-space group; posed every frame from the wearer's eye. */
  readonly group = new THREE.Group();
  readonly light: THREE.SpotLight;
  private lens: THREE.MeshLambertMaterial;
  private cone: THREE.Mesh;
  private coneMat: THREE.MeshBasicMaterial;
  private lamp: THREE.Group;
  on = false;

  constructor(private night: boolean) {
    // elastic strap + lamp housing on the forehead (seen by the other player only)
    this.lamp = new THREE.Group();
    const b = new GeoBuilder()
      .add(new THREE.BoxGeometry(0.07, 0.042, 0.034), 0x2a2d31, mat(0, 0, 0.012), { shade: 0.08 })
      .add(new THREE.BoxGeometry(0.2, 0.024, 0.012), 0xe8742b, mat(0, 0, 0.03))
      .add(new THREE.BoxGeometry(0.012, 0.024, 0.2), 0xe8742b, mat(-0.1, 0, 0.13))
      .add(new THREE.BoxGeometry(0.012, 0.024, 0.2), 0xe8742b, mat(0.1, 0, 0.13));
    this.lamp.add(new THREE.Mesh(b.build(), vertexColored()));
    this.lens = new THREE.MeshLambertMaterial({ color: 0xd9e6ee, emissive: 0x000000 });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.016, 10), this.lens);
    lens.position.z = -0.0055;
    lens.rotation.y = Math.PI;
    this.lamp.add(lens);
    this.lamp.position.copy(LAMP_OFFSET).add(new THREE.Vector3(0, 0, 0.04));
    this.group.add(this.lamp);

    // real spotlight just in front of the face, aimed along the view (-Z)
    this.light = new THREE.SpotLight(0xfff1d6, 0, RANGE, CONE, PENUMBRA, 1.3);
    this.light.position.copy(LAMP_OFFSET);
    // tipped down ~8 degrees so the beam meets the line of sight at reading distance
    this.light.target.position.copy(LAMP_OFFSET).add(new THREE.Vector3(0, -0.14, -1));
    this.light.layers.enableAll();
    if (night) {
      // shadows only at night (fixed per stage so shaders never recompile mid-run)
      this.light.castShadow = true;
      this.light.shadow.mapSize.set(512, 512);
      this.light.shadow.camera.near = 0.05;
      this.light.shadow.camera.far = RANGE;
      this.light.shadow.bias = -0.0005;
      this.light.shadow.normalBias = 0.01;
    }
    this.group.add(this.light, this.light.target);

    // faint visible beam (stylised volumetric look) - only the other player sees it
    const coneLen = 2.6;
    const coneGeo = new THREE.ConeGeometry(Math.tan(CONE) * coneLen, coneLen, 12, 1, true);
    coneGeo.rotateX(Math.PI / 2);
    coneGeo.translate(0, 0, -coneLen / 2);
    coneGeo.rotateX(-Math.atan(0.14)); // same downward tip as the light
    coneGeo.translate(LAMP_OFFSET.x, LAMP_OFFSET.y, LAMP_OFFSET.z);
    this.coneMat = new THREE.MeshBasicMaterial({
      color: 0xfff1c8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.cone = new THREE.Mesh(coneGeo, this.coneMat);
    this.cone.renderOrder = 4;
    this.group.add(this.cone);
    setLayer(this.lamp, LAYER.NAV_BODY);
    this.cone.layers.set(LAYER.NAV_BODY);
    this.lamp.traverse((o) => (o.castShadow = false));
    this.setOn(false);
  }

  setOn(on: boolean) {
    this.on = on;
    this.light.intensity = on ? (this.night ? 7 : 4) : 0;
    this.lens.emissive.setHex(on ? 0xfff3d0 : 0x000000);
    this.coneMat.opacity = on ? (this.night ? 0.055 : 0.018) : 0;
    this.cone.visible = on;
  }

  /** Places the lamp on the wearer's head from their eye pose (world space). */
  setPose(eyePos: THREE.Vector3, eyeQuat: THREE.Quaternion, visible = true) {
    this.group.position.copy(eyePos);
    this.group.quaternion.copy(eyeQuat);
    this.group.updateMatrixWorld(true);
    this.lamp.visible = visible;
  }

  /** World-space beam origin and direction. */
  beam(outPos: THREE.Vector3, outDir: THREE.Vector3) {
    this.light.getWorldPosition(outPos);
    const t = this.light.target.getWorldPosition(new THREE.Vector3());
    outDir.subVectors(t, outPos).normalize();
  }

  /**
   * How strongly the beam lights a surface at `point` (world) with `normal`:
   * cone falloff x distance falloff x facing. 0 when off.
   */
  illuminationAt(point: THREE.Vector3, normal?: THREE.Vector3): number {
    if (!this.on) return 0;
    const o = new THREE.Vector3();
    const d = new THREE.Vector3();
    this.beam(o, d);
    const to = point.clone().sub(o);
    const dist = to.length();
    if (dist > RANGE || dist < 1e-4) return 0;
    to.multiplyScalar(1 / dist);
    const cosA = to.dot(d);
    const cosOuter = Math.cos(CONE);
    if (cosA < cosOuter) return 0;
    // soft edge: brightest in the middle, fading smoothly across the outer part of the cone
    const t = Math.min(1, (cosA - cosOuter) / (1 - cosOuter) / PENUMBRA);
    const cone = t * t * (3 - 2 * t);
    const falloff = 1 / (1 + dist * dist * 0.6);
    const facing = normal ? Math.max(0, -to.dot(normal)) : 1;
    return cone * falloff * facing;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.lens.dispose();
    this.coneMat.dispose();
    this.light.shadow.map?.dispose();
  }
}

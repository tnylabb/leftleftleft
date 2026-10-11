// The navigator's flashlight: a physical object (its pose comes from the cabin
// physics) with a real spotlight attached at the lens, so the beam lights
// whatever it actually points at - the tablet, the paper map, the cabin.

import * as THREE from 'three';
import { GeoBuilder, mat, setLayer } from '../rendering/geometry';
import { LAYER } from '../rendering/layers';
import { lambert, vertexColored } from '../rendering/materials';
import { FLASHLIGHT_HOLDER, FLASHLIGHT_SPEC } from '../tablet/cabinObjects';

const CONE = 0.36; // spotlight half angle (rad)
const RANGE = 9;

export class Flashlight {
  readonly group = new THREE.Group();
  readonly holder: THREE.Mesh;
  readonly light: THREE.SpotLight;
  private lens: THREE.MeshLambertMaterial;
  private cone: THREE.Mesh;
  private coneMat: THREE.MeshBasicMaterial;
  on = false;

  constructor(private night: boolean) {
    const f = FLASHLIGHT_SPEC;
    const L = f.halfLength;
    // body along Z, lens at -Z
    const b = new GeoBuilder()
      .add(new THREE.CylinderGeometry(f.radius * 0.9, f.radius * 0.9, L * 1.5, 8), 0x2a2d31, mat(0, 0, L * 0.2, Math.PI / 2, 0, 0), { shade: 0.08 })
      .add(new THREE.CylinderGeometry(f.radius * 1.35, f.radius, L * 0.5, 8), 0xe8742b, mat(0, 0, -L * 0.75, Math.PI / 2, 0, 0), { shade: 0.06 })
      .add(new THREE.BoxGeometry(0.014, 0.008, 0.03), 0x111111, mat(0, f.radius * 0.95, -L * 0.1))
      .add(new THREE.CylinderGeometry(f.radius * 0.95, f.radius * 0.95, 0.02, 8), 0x111111, mat(0, 0, L * 0.98, Math.PI / 2, 0, 0));
    const body = new THREE.Mesh(b.build(), vertexColored());
    body.castShadow = true;
    this.group.add(body);
    this.lens = new THREE.MeshLambertMaterial({ color: 0xd9e6ee, emissive: 0x000000 });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(f.radius * 1.25, 10), this.lens);
    lens.position.z = -L - 0.001;
    lens.rotation.y = Math.PI;
    this.group.add(lens);

    // real spotlight at the lens, aimed along -Z
    this.light = new THREE.SpotLight(0xfff1d6, 0, RANGE, CONE, 0.45, 1.4);
    this.light.position.set(0, 0, -L);
    this.light.target.position.set(0, 0, -L - 1);
    if (night) {
      // shadows only at night (fixed per stage so shaders never recompile mid-run)
      this.light.castShadow = true;
      this.light.shadow.mapSize.set(512, 512);
      this.light.shadow.camera.near = 0.04;
      this.light.shadow.camera.far = RANGE;
      this.light.shadow.bias = -0.0005;
      this.light.shadow.normalBias = 0.01;
    }
    this.group.add(this.light, this.light.target);

    // faint visible beam cone (stylised volumetric look)
    const coneLen = 2.4;
    const coneGeo = new THREE.ConeGeometry(Math.tan(CONE) * coneLen, coneLen, 12, 1, true);
    coneGeo.rotateX(Math.PI / 2);
    coneGeo.translate(0, 0, -L - coneLen / 2);
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
    setLayer(this.group, LAYER.COCKPIT);

    // the dashboard clip it lives in
    this.holder = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.03, 0.16), lambert(0x161616));
    this.holder.position.copy(FLASHLIGHT_HOLDER.pos).add(new THREE.Vector3(0, -0.028, 0));
    this.holder.quaternion.copy(FLASHLIGHT_HOLDER.quat); // long side along the stowed flashlight
    this.holder.layers.set(LAYER.COCKPIT);
    this.holder.castShadow = true;
    this.setOn(false);
  }

  setOn(on: boolean) {
    this.on = on;
    this.light.intensity = on ? (this.night ? 7 : 4) : 0;
    this.lens.emissive.setHex(on ? 0xfff3d0 : 0x000000);
    this.coneMat.opacity = on ? (this.night ? 0.07 : 0.025) : 0;
    this.cone.visible = on;
  }

  /** World-space beam origin and direction. */
  beam(outPos: THREE.Vector3, outDir: THREE.Vector3) {
    this.light.getWorldPosition(outPos);
    const q = this.group.getWorldQuaternion(new THREE.Quaternion());
    outDir.set(0, 0, -1).applyQuaternion(q).normalize();
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
    const cone = Math.min(1, (cosA - cosOuter) / (1 - cosOuter) / 0.55);
    const falloff = 1 / (1 + dist * dist * 0.6);
    const facing = normal ? Math.max(0, -to.dot(normal)) : 1;
    return cone * falloff * facing;
  }

  dispose() {
    this.group.removeFromParent();
    this.holder.removeFromParent();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.holder.geometry.dispose();
    this.lens.dispose();
    this.coneMat.dispose();
    this.light.shadow.map?.dispose();
  }
}

// Physical rugged navigation tablet (case, bumpers, screen with the live
// minimap texture) and meshes for the loose cabin objects.

import * as THREE from 'three';
import { GeoBuilder, mat, setLayer } from '../rendering/geometry';
import { LAYER } from '../rendering/layers';
import { PALETTE, vertexColored } from '../rendering/materials';
import { LOOSE_OBJECTS, TABLET_SPEC } from './cabinObjects';

export class TabletModel {
  readonly group = new THREE.Group();
  readonly screen: THREE.Mesh;

  constructor(screenTexture: THREE.Texture) {
    const t = TABLET_SPEC;
    const b = new GeoBuilder()
      .add(new THREE.BoxGeometry(t.hx * 2, t.hy * 2, t.hz * 2), PALETTE.tabletCase, undefined, { shade: 0.05 })
      // orange rubber corner bumpers
      .add(new THREE.BoxGeometry(0.045, t.hy * 2 + 0.006, 0.045), PALETTE.tabletBumper, mat(-t.hx + 0.016, 0, -t.hz + 0.016))
      .add(new THREE.BoxGeometry(0.045, t.hy * 2 + 0.006, 0.045), PALETTE.tabletBumper, mat(t.hx - 0.016, 0, -t.hz + 0.016))
      .add(new THREE.BoxGeometry(0.045, t.hy * 2 + 0.006, 0.045), PALETTE.tabletBumper, mat(-t.hx + 0.016, 0, t.hz - 0.016))
      .add(new THREE.BoxGeometry(0.045, t.hy * 2 + 0.006, 0.045), PALETTE.tabletBumper, mat(t.hx - 0.016, 0, t.hz - 0.016))
      // hand strap on the back
      .add(new THREE.BoxGeometry(0.16, 0.012, 0.035), 0x111111, mat(0, -t.hy - 0.004, 0.0))
      // camera bump + button
      .add(new THREE.BoxGeometry(0.02, 0.004, 0.02), 0x111111, mat(t.hx - 0.04, -t.hy - 0.002, -t.hz + 0.04))
      .add(new THREE.BoxGeometry(0.03, 0.006, 0.006), 0x444444, mat(0.05, 0, -t.hz - 0.002));
    const body = new THREE.Mesh(b.build(), vertexColored());
    this.group.add(body);
    const screenGeo = new THREE.PlaneGeometry(t.hx * 2 - 0.022, t.hz * 2 - 0.02);
    screenGeo.rotateX(-Math.PI / 2); // face +Y, top edge towards -Z
    this.screen = new THREE.Mesh(screenGeo, new THREE.MeshBasicMaterial({ map: screenTexture, toneMapped: false }));
    this.screen.position.y = t.hy + 0.0012;
    this.group.add(this.screen);
    setLayer(this.group, LAYER.COCKPIT);
    body.castShadow = true;
    body.receiveShadow = true;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    (this.screen.material as THREE.Material).dispose();
  }
}

export function buildLooseObjectMeshes(): THREE.Mesh[] {
  return LOOSE_OBJECTS.map((o) => {
    const b = new GeoBuilder();
    if (o.shape === 'cylinder') {
      const [r, hh] = o.size;
      b.add(new THREE.CylinderGeometry(r, r, hh * 2, 8), o.color, undefined, { shade: 0.08 });
      if (o.name === 'water bottle') {
        b.add(new THREE.CylinderGeometry(r * 0.45, r * 0.8, 0.04, 8), o.color, mat(0, hh + 0.02, 0));
        b.add(new THREE.CylinderGeometry(r * 0.42, r * 0.42, 0.025, 8), o.accent, mat(0, hh + 0.05, 0));
        b.add(new THREE.CylinderGeometry(r * 1.01, r * 1.01, hh * 0.6, 8), o.accent, mat(0, 0, 0));
      } else {
        b.add(new THREE.CylinderGeometry(r * 1.05, r * 1.05, 0.012, 8), o.accent, mat(0, hh, 0));
        b.add(new THREE.CylinderGeometry(r * 1.02, r * 1.02, hh * 0.5, 8), 0x8a5a32, mat(0, -hh * 0.1, 0));
      }
    } else {
      const [hx, hy, hz] = o.size;
      b.add(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), o.color, undefined, { shade: 0.08, jitter: o.name === 'snack bag' ? 0.01 : 0 });
      b.add(new THREE.BoxGeometry(hx * 1.6, hy * 2.05, hz * 0.4), o.accent, mat(0, 0, -hz * 0.3));
    }
    const m = new THREE.Mesh(b.build(), vertexColored());
    m.castShadow = true;
    m.receiveShadow = true;
    m.layers.set(LAYER.COCKPIT);
    m.name = o.name;
    return m;
  });
}

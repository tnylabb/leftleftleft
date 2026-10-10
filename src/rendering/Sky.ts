// Sky dome, sun, ambient light, fog, clouds and distant hills.

import * as THREE from 'three';
import { Rng } from '../shared/rng';
import { GeoBuilder, mat } from './geometry';

export const FOG_COLOR = new THREE.Color(0xc9dce3);

export class Sky {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private follow = new THREE.Group();
  private sunDir = new THREE.Vector3(-0.55, 0.62, 0.42).normalize();

  constructor(scene: THREE.Scene, shadowMapSize: number) {
    scene.background = FOG_COLOR.clone();
    scene.fog = new THREE.Fog(FOG_COLOR.clone(), 80, 440);

    this.hemi = new THREE.HemisphereLight(0xdff1ff, 0x7a7158, 1.35);
    this.group.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff0d6, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    const cam = this.sun.shadow.camera;
    cam.left = -48;
    cam.right = 48;
    cam.top = 48;
    cam.bottom = -48;
    cam.near = 1;
    cam.far = 320;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.group.add(this.sun, this.sun.target);

    this.follow.add(this.buildDome(), this.buildHills(), this.buildClouds());
    this.group.add(this.follow);
    scene.add(this.group);
  }

  private buildDome(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(540, 18, 12);
    const pos = geo.getAttribute('position');
    const colors: number[] = [];
    const zenith = new THREE.Color(0x6fa6d6);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 540;
      const t = Math.min(1, Math.max(0, y * 2.2));
      c.copy(FOG_COLOR).lerp(zenith, t);
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    m.renderOrder = -10;
    m.frustumCulled = false;
    return m;
  }

  private buildHills(): THREE.Mesh {
    const rng = new Rng(99);
    const b = new GeoBuilder();
    const near = new THREE.Color(0x7d9a7a).lerp(FOG_COLOR, 0.45);
    const far = new THREE.Color(0x8fa9b0).lerp(FOG_COLOR, 0.55);
    const ring = (radius: number, height: number, color: THREE.Color, n: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const h = height * (0.35 + rng.next() * 0.9);
        pts.push(new THREE.Vector3(Math.cos(a) * radius, h, Math.sin(a) * radius));
      }
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const c = pts[i + 1];
        const a0 = new THREE.Vector3(a.x, -40, a.z);
        const c0 = new THREE.Vector3(c.x, -40, c.z);
        const shade = color.clone().multiplyScalar(0.92 + rng.next() * 0.14);
        b.addQuad(a0, c0, c, a, shade);
      }
    };
    ring(510, 75, far, 48);
    ring(470, 45, near, 64);
    const m = new THREE.Mesh(b.build(), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide, depthWrite: false }));
    m.renderOrder = -9;
    m.frustumCulled = false;
    return m;
  }

  private buildClouds(): THREE.Mesh {
    const rng = new Rng(7);
    const b = new GeoBuilder();
    for (let i = 0; i < 22; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = rng.range(150, 440);
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const cy = rng.range(120, 200);
      const puffs = rng.int(3, 6);
      for (let p = 0; p < puffs; p++) {
        const s = rng.range(18, 42);
        b.add(new THREE.IcosahedronGeometry(1, 0), 0xffffff, mat(cx + rng.range(-40, 40), cy + rng.range(-6, 8), cz + rng.range(-25, 25), 0, rng.next() * 3, 0, s * 1.6, s * 0.55, s), { shade: 0.12, seed: i * 10 + p });
      }
    }
    const m = new THREE.Mesh(b.build(), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: 0.92, depthWrite: false }));
    m.renderOrder = -8;
    m.frustumCulled = false;
    return m;
  }

  /** Keeps the sky and shadow frustum centred on the focus point (the car). */
  update(focus: THREE.Vector3) {
    this.follow.position.set(focus.x, 0, focus.z);
    // snap to shadow texel size to avoid shimmering
    const texel = 96 / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + this.sunDir.x * 160, focus.y + this.sunDir.y * 160, fz + this.sunDir.z * 160);
    this.sun.target.updateMatrixWorld();
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.sun.shadow.map?.dispose();
  }
}

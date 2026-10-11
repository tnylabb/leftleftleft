// Sky dome, sun (or moon), ambient light, fog, clouds, stars and distant hills.

import * as THREE from 'three';
import { Rng } from '../shared/rng';
import { GeoBuilder, mat } from './geometry';

export const FOG_COLOR = new THREE.Color(0xc9dce3);
const NIGHT_FOG = new THREE.Color(0x0c1424);

export class Sky {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fogColor: THREE.Color;
  private follow = new THREE.Group();
  private sunDir = new THREE.Vector3(-0.55, 0.62, 0.42).normalize();

  constructor(scene: THREE.Scene, shadowMapSize: number, readonly night = false) {
    this.fogColor = (night ? NIGHT_FOG : FOG_COLOR).clone();
    scene.background = this.fogColor.clone();
    // less forward visibility than before; at night the headlights are what you get
    scene.fog = night ? new THREE.Fog(this.fogColor.clone(), 18, 230) : new THREE.Fog(this.fogColor.clone(), 60, 380);

    this.hemi = night ? new THREE.HemisphereLight(0x3d4f7a, 0x12120e, 0.42) : new THREE.HemisphereLight(0xdff1ff, 0x7a7158, 1.35);
    this.group.add(this.hemi);

    // the sun by day, a pale moon by night (both cast shadows)
    this.sun = night ? new THREE.DirectionalLight(0x9db4ff, 0.42) : new THREE.DirectionalLight(0xfff0d6, 2.6);
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
    if (night) this.follow.add(this.buildStars());
    this.group.add(this.follow);
    scene.add(this.group);
  }

  private buildDome(): THREE.Mesh {
    const geo = new THREE.SphereGeometry(540, 18, 12);
    const pos = geo.getAttribute('position');
    const colors: number[] = [];
    const zenith = new THREE.Color(this.night ? 0x03060d : 0x6fa6d6);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 540;
      const t = Math.min(1, Math.max(0, y * 2.2));
      c.copy(this.fogColor).lerp(zenith, t);
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    m.renderOrder = -10;
    m.frustumCulled = false;
    return m;
  }

  private buildStars(): THREE.Points {
    const rng = new Rng(4242);
    const pts: number[] = [];
    for (let i = 0; i < 900; i++) {
      const a = rng.next() * Math.PI * 2;
      const e = 0.08 + rng.next() * 1.3; // elevation
      const r = 520;
      pts.push(Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const s = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, fog: false, depthWrite: false }));
    s.renderOrder = -9.5;
    s.frustumCulled = false;
    return s;
  }

  private buildHills(): THREE.Mesh {
    const rng = new Rng(99);
    const b = new GeoBuilder();
    const near = new THREE.Color(this.night ? 0x0f1a14 : 0x7d9a7a).lerp(this.fogColor, 0.45);
    const far = new THREE.Color(this.night ? 0x111a26 : 0x8fa9b0).lerp(this.fogColor, 0.55);
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
    const color = this.night ? 0x1b2333 : 0xffffff;
    for (let i = 0; i < 22; i++) {
      const a = rng.next() * Math.PI * 2;
      const r = rng.range(150, 440);
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      const cy = rng.range(120, 200);
      const puffs = rng.int(3, 6);
      for (let p = 0; p < puffs; p++) {
        const s = rng.range(18, 42);
        b.add(new THREE.IcosahedronGeometry(1, 0), color, mat(cx + rng.range(-40, 40), cy + rng.range(-6, 8), cz + rng.range(-25, 25), 0, rng.next() * 3, 0, s * 1.6, s * 0.55, s), { shade: 0.12, seed: i * 10 + p });
      }
    }
    const m = new THREE.Mesh(b.build(), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: this.night ? 0.8 : 0.92, depthWrite: false }));
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

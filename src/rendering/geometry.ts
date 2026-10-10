// Helpers for building flat-shaded, vertex-coloured low-poly meshes.

import * as THREE from 'three';
import { Rng } from '../shared/rng';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const _v = new THREE.Vector3();

export function mat(
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
): THREE.Matrix4 {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** Accumulates triangles with per-vertex colours into one non-indexed geometry. */
export class GeoBuilder {
  private pos: number[] = [];
  private col: number[] = [];

  /**
   * Adds a geometry. `shade` randomly varies brightness per face (0 = none),
   * `jitter` displaces vertices consistently (shared corners move together).
   */
  add(
    geo: THREE.BufferGeometry,
    color: THREE.ColorRepresentation,
    matrix?: THREE.Matrix4,
    opts: { shade?: number; jitter?: number; seed?: number } = {},
  ): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.getAttribute('position');
    _c.set(color);
    const rng = new Rng(opts.seed ?? 1234);
    const jit = opts.jitter ?? 0;
    for (let i = 0; i < p.count; i += 3) {
      const f = opts.shade ? 1 + (rng.next() - 0.5) * opts.shade : 1;
      for (let k = 0; k < 3; k++) {
        _v.fromBufferAttribute(p, i + k);
        if (jit) {
          const h = Math.sin(_v.x * 127.1 + _v.y * 311.7 + _v.z * 74.7) * 43758.5453;
          const h2 = Math.sin(_v.x * 269.5 + _v.y * 183.3 + _v.z * 246.1) * 43758.5453;
          const h3 = Math.sin(_v.x * 113.5 + _v.y * 271.9 + _v.z * 124.6) * 43758.5453;
          _v.x += (h - Math.floor(h) - 0.5) * jit;
          _v.y += (h2 - Math.floor(h2) - 0.5) * jit;
          _v.z += (h3 - Math.floor(h3) - 0.5) * jit;
        }
        if (matrix) _v.applyMatrix4(matrix);
        this.pos.push(_v.x, _v.y, _v.z);
        this.col.push(_c.r * f, _c.g * f, _c.b * f);
      }
    }
    if (g !== geo) g.dispose();
    return this;
  }

  addTri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.ColorRepresentation): this {
    _c.set(color);
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let k = 0; k < 3; k++) this.col.push(_c.r, _c.g, _c.b);
    return this;
  }

  addQuad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.ColorRepresentation): this {
    this.addTri(a, b, c, color);
    this.addTri(a, c, d, color);
    return this;
  }

  /** Adds a quad whose front face points away from `inside` (winding fixed automatically). */
  addQuadOut(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.ColorRepresentation, inside: THREE.Vector3): this {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    const m = new THREE.Vector3().add(a).add(b).add(c).add(d).multiplyScalar(0.25).sub(inside);
    return n.dot(m) >= 0 ? this.addQuad(a, b, c, d, color) : this.addQuad(d, c, b, a, color);
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/** Places an object whose geometry spans y=0..1 between points a and b. */
export function placeBetween(obj: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3, thickness = 1) {
  _v.subVectors(b, a);
  const len = _v.length();
  obj.position.copy(a);
  if (len > 1e-6) obj.quaternion.setFromUnitVectors(UP, _v.multiplyScalar(1 / len));
  obj.scale.set(thickness, Math.max(len, 1e-4), thickness);
}

/** Simple box helper returning a mesh (for cockpit parts). */
export function box(
  w: number, h: number, d: number,
  material: THREE.Material,
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  return m;
}

export function setShadows(obj: THREE.Object3D, cast: boolean, receive: boolean) {
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
}

export function setLayer(obj: THREE.Object3D, layer: number) {
  obj.traverse((o) => o.layers.set(layer));
}

export function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
  });
}

export { _m as tmpMatrix };

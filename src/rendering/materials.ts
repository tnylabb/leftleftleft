// Shared low-poly material palette. Materials are cached and reused.

import * as THREE from 'three';

export const PALETTE = {
  paint: 0xc4553a, // faded orange-red body
  paintDark: 0xa2432c,
  interior: 0xb24a30, // interior door cards / dash top
  interiorDark: 0x7e3523,
  plastic: 0x1e1e20,
  plasticLight: 0x2f2f33,
  seat: 0x3a3a40,
  seatStripe: 0xd6763a,
  carpet: 0x232325,
  chrome: 0xb8b8b8,
  glass: 0x9ec8dc,
  skin: 0xd9a27a,
  glove: 0x232325,
  driverSuit: 0x2b4f91,
  navSuit: 0x3d7a3a,
  helmetDriver: 0xe9e4d8,
  helmetNav: 0xf2c230,
  tabletCase: 0x242426,
  tabletBumper: 0xe8742b,
  tyre: 0x1b1b1b,
  rim: 0x9a9a9a,
  hay: 0xd8b04f,
  wood: 0x7a5434,
  bark: 0x5b4130,
};

const cache = new Map<string, THREE.Material>();

export function lambert(color: number, opts: { flat?: boolean; side?: THREE.Side; emissive?: number } = {}): THREE.MeshLambertMaterial {
  const key = `l:${color}:${opts.flat ?? true}:${opts.side ?? 0}:${opts.emissive ?? 0}`;
  let m = cache.get(key) as THREE.MeshLambertMaterial | undefined;
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color,
      flatShading: opts.flat ?? true,
      side: opts.side ?? THREE.FrontSide,
      emissive: opts.emissive ?? 0x000000,
    });
    cache.set(key, m);
  }
  return m;
}

export function vertexColored(opts: { side?: THREE.Side } = {}): THREE.MeshLambertMaterial {
  const key = `vc:${opts.side ?? 0}`;
  let m = cache.get(key) as THREE.MeshLambertMaterial | undefined;
  if (!m) {
    m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: opts.side ?? THREE.FrontSide });
    cache.set(key, m);
  }
  return m;
}

export function basic(color: number, opts: { transparent?: boolean; opacity?: number; side?: THREE.Side; fog?: boolean } = {}): THREE.MeshBasicMaterial {
  const key = `b:${color}:${opts.transparent ?? false}:${opts.opacity ?? 1}:${opts.side ?? 0}:${opts.fog ?? true}`;
  let m = cache.get(key) as THREE.MeshBasicMaterial | undefined;
  if (!m) {
    m = new THREE.MeshBasicMaterial({
      color,
      transparent: opts.transparent ?? false,
      opacity: opts.opacity ?? 1,
      side: opts.side ?? THREE.FrontSide,
      fog: opts.fog ?? true,
    });
    cache.set(key, m);
  }
  return m;
}

export function glassMaterial(): THREE.MeshLambertMaterial {
  const key = 'glass';
  let m = cache.get(key) as THREE.MeshLambertMaterial | undefined;
  if (!m) {
    m = new THREE.MeshLambertMaterial({
      color: PALETTE.glass,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    cache.set(key, m);
  }
  return m;
}

/** Creates a canvas texture with sensible defaults for in-world screens and signs. */
export function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

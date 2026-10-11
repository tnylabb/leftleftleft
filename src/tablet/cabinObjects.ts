// Shapes and start positions of the tablet and the loose cabin objects (car-local frame).

import * as THREE from 'three';
import { CABIN_BODY, CABIN_BODY_COUNT, LOOSE_OBJECT_COUNT } from '../shared/constants';

export const TABLET_SPEC = { hx: 0.13, hy: 0.011, hz: 0.094, mass: 0.65 };

export interface LooseSpec {
  name: string;
  shape: 'box' | 'cylinder';
  /** box: half extents; cylinder: [radius, halfHeight] */
  size: [number, number, number];
  mass: number;
  start: THREE.Vector3;
  color: number;
  accent: number;
}

export const LOOSE_OBJECTS: LooseSpec[] = [
  { name: 'water bottle', shape: 'cylinder', size: [0.034, 0.11, 0], mass: 0.5, start: new THREE.Vector3(0.48, -0.08, -0.42), color: 0x8fd0f0, accent: 0x2a6fc0 },
  { name: 'coffee cup', shape: 'cylinder', size: [0.042, 0.055, 0], mass: 0.25, start: new THREE.Vector3(0.22, 0.42, -0.86), color: 0xf2efe6, accent: 0x6b3f22 },
  { name: 'pace note book', shape: 'box', size: [0.075, 0.009, 0.105], mass: 0.3, start: new THREE.Vector3(0.52, 0.36, -0.86), color: 0xe8742b, accent: 0xf4f0e0 },
  { name: 'snack bag', shape: 'box', size: [0.07, 0.025, 0.1], mass: 0.15, start: new THREE.Vector3(-0.1, 0.06, 0.98), color: 0xf2c230, accent: 0xd23a2a },
];

export const CABIN_OBJECT_NAMES = ['TABLET', ...LOOSE_OBJECTS.map((o) => o.name.toUpperCase())];

if (LOOSE_OBJECTS.length !== LOOSE_OBJECT_COUNT) throw new Error('LOOSE_OBJECT_COUNT mismatch');
if (CABIN_BODY.tablet !== 0 || CABIN_BODY_COUNT !== LOOSE_OBJECT_COUNT + 1) throw new Error('CABIN_BODY index mismatch');

// Compact binary layouts for high-frequency state messages.
// All snapshots are Float32Arrays sent as raw ArrayBuffers over Socket.IO.

import { LOOSE_OBJECT_COUNT } from './constants';

/** Car snapshot (driver -> server -> navigator). */
export const CAR = {
  time: 0,
  px: 1, py: 2, pz: 3,
  qx: 4, qy: 5, qz: 6, qw: 7,
  vx: 8, vy: 9, vz: 10,
  wx: 11, wy: 12, wz: 13,
  ax: 14, ay: 15, az: 16, // filtered car-local acceleration (m/s^2)
  steer: 17, // front wheel angle (rad)
  rpm: 18,
  gear: 19, // -1 reverse, 0 neutral, 1..5
  throttle: 20,
  brake: 21,
  flags: 22,
  headYaw: 23,
  headPitch: 24,
  slip: 25, // tyre scrub 0..1
  surface: 26, // 0 road, 1 grass, 2 mud (average)
  rough: 27, // suspension activity 0..1
  wipeU: 28,
  wipeV: 29,
  seq: 30,
  LENGTH: 31,
} as const;

export const CAR_FLAG = {
  handbrake: 1,
  horn: 2,
  wiping: 4,
  closingDoor: 8,
  airborne: 16,
  wheelspin: 32,
  shifting: 64,
  wipers: 128,
} as const;

/** Cabin snapshot (navigator -> server -> driver). Poses are in the car-local frame. */
export const CABIN = {
  time: 0,
  flags: 1,
  headYaw: 2,
  headPitch: 3,
  tablet: 4, // 7 floats: px py pz qx qy qz qw
  objects: 11, // LOOSE_OBJECT_COUNT * 7 floats
  reachX: 11 + LOOSE_OBJECT_COUNT * 7,
  reachY: 12 + LOOSE_OBJECT_COUNT * 7,
  reachZ: 13 + LOOSE_OBJECT_COUNT * 7,
  heldObject: 14 + LOOSE_OBJECT_COUNT * 7, // -1 none, 0 tablet, 1.. loose objects
  LENGTH: 15 + LOOSE_OBJECT_COUNT * 7,
} as const;

export const CABIN_FLAG = {
  tabletHeld: 1,
  reaching: 2,
  closingDoor: 4,
} as const;

/** Props snapshot: [count, (id, px,py,pz, qx,qy,qz,qw) * count] */
export const PROP_STRIDE = 8;
export const MAX_PROPS_PER_MSG = 48;

export function toArrayBuffer(arr: Float32Array): ArrayBuffer {
  if (arr.byteOffset === 0 && arr.byteLength === arr.buffer.byteLength) return arr.buffer as ArrayBuffer;
  return arr.slice().buffer as ArrayBuffer;
}

/** Converts a received binary payload (ArrayBuffer, Buffer, typed array) into a Float32Array copy. */
export function readFloat32(data: unknown, expectedLength?: number): Float32Array | null {
  let bytes: Uint8Array | null = null;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (!bytes || bytes.byteLength % 4 !== 0 || bytes.byteLength === 0 || bytes.byteLength > 8192) return null;
  const out = new Float32Array(bytes.byteLength / 4);
  new Uint8Array(out.buffer).set(bytes);
  if (expectedLength !== undefined && out.length !== expectedLength) return null;
  return out;
}

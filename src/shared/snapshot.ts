// Compact binary layouts for high-frequency state messages.
// All snapshots are Float32Arrays sent as raw ArrayBuffers over Socket.IO.

import { CABIN_BODY_COUNT } from './constants';

/** Car snapshot (driver -> server -> navigator). Also carries the driver's on-foot state. */
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
  // driver on foot (world space)
  footX: 31, footY: 32, footZ: 33,
  footYaw: 34, footPitch: 35,
  footGrip: 36, // tow hook index or -1
  footWalk: 37, // walk cycle phase (for the avatar's legs)
  LENGTH: 38,
} as const;

export const CAR_FLAG = {
  handbrake: 1,
  horn: 2,
  wiping: 4,
  closingDoor: 8,
  airborne: 16,
  wheelspin: 32,
  shifting: 64,
  driverOut: 128,
} as const;

/**
 * Cabin snapshot (navigator -> server -> driver). Body poses are in the
 * car-local frame; the navigator's on-foot state and pull force are world space.
 */
export const CABIN = {
  time: 0,
  flags: 1,
  headYaw: 2,
  headPitch: 3,
  tablet: 4, // 7 floats: px py pz qx qy qz qw
  objects: 11, // (CABIN_BODY_COUNT - 1) * 7 floats: bodies 1..N
  reachX: 11 + (CABIN_BODY_COUNT - 1) * 7,
  reachY: 12 + (CABIN_BODY_COUNT - 1) * 7,
  reachZ: 13 + (CABIN_BODY_COUNT - 1) * 7,
  heldObject: 14 + (CABIN_BODY_COUNT - 1) * 7, // main-hand object: -1 none, 0 tablet, 1.. bodies
  footX: 15 + (CABIN_BODY_COUNT - 1) * 7,
  footY: 16 + (CABIN_BODY_COUNT - 1) * 7,
  footZ: 17 + (CABIN_BODY_COUNT - 1) * 7,
  footYaw: 18 + (CABIN_BODY_COUNT - 1) * 7,
  footPitch: 19 + (CABIN_BODY_COUNT - 1) * 7,
  footGrip: 20 + (CABIN_BODY_COUNT - 1) * 7,
  pullX: 21 + (CABIN_BODY_COUNT - 1) * 7, // world-space pull force on the car (N)
  pullY: 22 + (CABIN_BODY_COUNT - 1) * 7,
  pullZ: 23 + (CABIN_BODY_COUNT - 1) * 7,
  mapFold: 24 + (CABIN_BODY_COUNT - 1) * 7, // 0 folded .. 1 unfolded
  footWalk: 25 + (CABIN_BODY_COUNT - 1) * 7,
  LENGTH: 26 + (CABIN_BODY_COUNT - 1) * 7,
} as const;

export const CABIN_FLAG = {
  tabletHeld: 1,
  reaching: 2,
  closingDoor: 4,
  navOut: 8,
  pointing: 16,
  flashlightOn: 32,
  flashlightHeld: 64,
  flashlightStowed: 128,
  mapStowed: 256,
  mapHeld: 512,
} as const;

/** Offset of a cabin body's pose block (index 0 = tablet). */
export const cabinPoseOffset = (index: number) => (index === 0 ? CABIN.tablet : CABIN.objects + (index - 1) * 7);

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

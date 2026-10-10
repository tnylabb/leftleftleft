// Interior layout of the hatchback in the car-local frame (-Z forward, +X right, +Y up).
// Shared by the cockpit visuals and the cabin physics colliders so they match.

import * as THREE from 'three';
import { DRIVER_EYE, NAVIGATOR_EYE } from '../shared/constants';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export const LAYOUT = {
  floorY: -0.22,
  roofY: 0.86,
  sideX: 0.74,
  beltY: 0.34,
  dash: { topY: 0.33, frontZ: -1.0, backZ: -0.6 },
  windshield: {
    bl: v(-0.69, 0.37, -1.0),
    br: v(0.69, 0.37, -1.0),
    tl: v(-0.61, 0.85, -0.42),
    tr: v(0.61, 0.85, -0.42),
  },
  doorHingeZ: -0.64,
  doorRearZ: 0.66,
  seatX: 0.36,
  seatCushionY: 0.0,
  seatFrontZ: -0.06,
  seatBackZ: 0.5,
  rearSeatZ0: 0.78,
  rearSeatZ1: 1.25,
  rearWallZ: 1.58,
  wheelCenter: v(-0.36, 0.29, -0.31),
  wheelRadius: 0.19,
  wheelTilt: 0.5, // radians the wheel face leans back from vertical
  cluster: v(-0.36, 0.385, -0.66),
  gearBase: v(0.0, 0.02, -0.33),
  handbrakeBase: v(0.0, -0.02, 0.06),
  mirror: v(0.0, 0.76, -0.47),
  driverEye: v(DRIVER_EYE.x, DRIVER_EYE.y, DRIVER_EYE.z),
  navEye: v(NAVIGATOR_EYE.x, NAVIGATOR_EYE.y, NAVIGATOR_EYE.z),
  driverShoulderL: v(-0.57, 0.37, 0.29),
  driverShoulderR: v(-0.15, 0.37, 0.29),
  navShoulderL: v(0.15, 0.35, 0.29),
  navShoulderR: v(0.57, 0.35, 0.29),
  upperArm: 0.31,
  foreArm: 0.31,
  /** Passenger's lap, where the tablet starts. */
  navLap: v(0.36, 0.17, -0.02),
};

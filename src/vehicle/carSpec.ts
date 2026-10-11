// Physical description of the hatchback (car-local frame: -Z forward, +X right, +Y up).

export interface WheelSpec {
  x: number;
  z: number;
  front: boolean;
  left: boolean;
}

export const CAR_SPEC = {
  mass: 980,
  centerOfMass: { x: 0, y: -0.14, z: -0.2 },
  inertia: { x: 1150, y: 1250, z: 400 },
  wheels: [
    { x: -0.7, z: -1.2, front: true, left: true },
    { x: 0.7, z: -1.2, front: true, left: false },
    { x: -0.7, z: 1.12, front: false, left: true },
    { x: 0.7, z: 1.12, front: false, left: false },
  ] as WheelSpec[],
  mountY: -0.05,
  restLength: 0.3,
  wheelRadius: 0.3,
  spring: 26000,
  damperBump: 2100,
  damperRebound: 2800,
  bumpStopStart: 0.24,
  antiRollFront: 9500,
  antiRollRear: 7000,
  maxSteerLow: 0.6,
  maxSteerHigh: 0.12,
  steerSpeedIn: 2.5,
  steerSpeedOut: 4.0,
  /** Extra steering lock: +steerBoostTop at top speed, +steerBoostLow more at a standstill. */
  steerBoostLow: 0.2,
  steerBoostTop: 0.08,
  /** Distance between the axles (m), for the turn-in assist. */
  wheelbase: 2.32,
  /** Turn-in assist: yaw torque per rad/s of missing yaw rate, and its cap (N*m). */
  turnAssist: 3200,
  turnAssistMax: 2400,
  brakeFront: 3700,
  brakeRear: 2400,
  dragQuadratic: 0.82,
  /** Share of drive torque sent to the front axle (AWD rally hatch). */
  frontDriveSplit: 0.42,
  dragLinear: 8,
  /** Tyre force application point is raised to reduce rollovers. */
  tyreForceLift: 0.17,
  /** Chassis collision shapes: [hx, hy, hz, cx, cy, cz]. */
  hulls: [
    [0.8, 0.27, 1.88, 0, 0.02, -0.08],
    [0.68, 0.27, 0.98, 0, 0.55, 0.22],
  ],
} as const;

export type SurfaceKind = 'road' | 'grass' | 'mud';

export const SURFACE_GRIP: Record<SurfaceKind, { mu: number; slide: number; drag: number }> = {
  road: { mu: 1.06, slide: 0.72, drag: 0 }, // loose gravel
  grass: { mu: 0.78, slide: 0.66, drag: 120 },
  mud: { mu: 0.5, slide: 0.55, drag: 900 },
};

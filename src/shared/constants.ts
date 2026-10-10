// Gameplay, physics and networking constants shared by client and server.

export const GAME_TITLE = 'LEFT! LEFT! LEFT!';
export const GAME_TAGLINE = 'DRIVE BLIND. NAVIGATE LOUD. SURVIVE THE CABIN.';

export const PHYSICS_HZ = 60;
export const FIXED_DT = 1 / PHYSICS_HZ;
export const MAX_STEPS_PER_FRAME = 5;

/** Driver -> server car snapshots per second. */
export const CAR_SEND_HZ = 30;
/** Navigator -> server cabin snapshots per second. */
export const CABIN_SEND_HZ = 20;
export const PROP_SEND_HZ = 10;
export const STATS_BROADCAST_MS = 500;

export const ROAD_HALF_WIDTH = 3.1;
export const ROAD_SAMPLE_SPACING = 2; // metres between stored road samples

export const COUNTDOWN_MS = 3500;
export const LOAD_TIMEOUT_MS = 45000;
export const ROOM_CODE_LENGTH = 4;
export const MAX_NAME_LENGTH = 16;

// --- Validation limits (server authority) -----------------------------------
export const MAX_CAR_SPEED = 70; // m/s, comfortably above the car's real top speed
export const MAX_TELEPORT_SLACK = 6; // metres of allowed jitter between snapshots
export const RESET_COOLDOWN_MS = 2500;
export const CALLOUT_COOLDOWN_MS = 450;
export const MISSED_CHECKPOINT_PENALTY_MS = 10000;

// --- Race tracking -------------------------------------------------------------
export const CHECKPOINT_LATERAL_TOLERANCE = 16;
export const MISSED_TURN_DISTANCE = 11;
export const WRONG_WAY_SECONDS = 1.6;

// --- Cabin (car-local frame: -Z forward, +X right, +Y up) ----------------------
export const CABIN_BOUNDS = {
  minX: -0.8,
  maxX: 0.8,
  minY: -0.35,
  maxY: 0.95,
  minZ: -1.1,
  maxZ: 1.7,
};

export const DRIVER_EYE = { x: -0.36, y: 0.62, z: 0.2 };
export const NAVIGATOR_EYE = { x: 0.36, y: 0.58, z: 0.2 };

export const LOOSE_OBJECT_COUNT = 4; // excluding the tablet

export type StageLength = 'short' | 'medium' | 'long';
export const STAGE_LENGTHS: Record<StageLength, number> = {
  short: 1300,
  medium: 2300,
  long: 3600,
};

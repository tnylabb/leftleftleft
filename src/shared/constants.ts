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

/** Half width of the gravel road (a narrow single-track stage road). */
export const ROAD_HALF_WIDTH = 2.55;
export const ROAD_SAMPLE_SPACING = 2; // metres between stored road samples

export const COUNTDOWN_MS = 3500;
export const LOAD_TIMEOUT_MS = 45000;
export const ROOM_CODE_LENGTH = 4;
export const MAX_NAME_LENGTH = 16;

// --- Validation limits (server authority) -----------------------------------
export const MAX_CAR_SPEED = 70; // m/s, comfortably above the car's real top speed
export const MAX_TELEPORT_SLACK = 6; // metres of allowed jitter between snapshots
export const RESET_COOLDOWN_MS = 2500;
export const RESET_PENALTY_MS = 5000; // emergency resets are a last resort
export const CALLOUT_COOLDOWN_MS = 450;
export const WIPER_COOLDOWN_MS = 250;
export const MISSED_CHECKPOINT_PENALTY_MS = 10000;

// --- Race tracking -------------------------------------------------------------
export const CHECKPOINT_LATERAL_TOLERANCE = 16;
export const MISSED_TURN_DISTANCE = 11;
export const WRONG_WAY_SECONDS = 1.6;
/** Seconds of "trying but not moving" before the car counts as genuinely stuck. */
export const STUCK_SECONDS = 4;

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

export const LOOSE_OBJECT_COUNT = 4; // small loose objects (bottle, cup, notes, snacks)
/** Physics body indices in the cabin world. */
export const CABIN_BODY = { tablet: 0 } as const;
export const CABIN_BODY_COUNT = 5; // tablet + loose objects

// --- On foot / vehicle recovery (car-local positions) ---------------------------
/** Tow hooks the players can grip to pull the car: front and rear. */
export const CAR_HOOKS = [
  { x: 0, y: -0.12, z: -2.06 },
  { x: 0, y: -0.12, z: 1.9 },
] as const;
/** Where each player stands after getting out (next to their door). */
export const DOOR_EXIT = {
  driver: { x: -1.45, y: 0, z: -0.05 },
  navigator: { x: 1.45, y: 0, z: -0.05 },
} as const;
export const EXIT_MAX_SPEED = 1.2; // m/s: the car must be (almost) stopped to get out
export const ENTER_RADIUS = 2.2; // m from the door to get back in
export const FOOT_MAX_DISTANCE = 45; // m a player on foot may wander from the car
export const PULL_FORCE_MAX = 1500; // N one player can pull with
export const GRIP_REACH = 1.15; // m from the hook to the player's centre to grip / stay tethered

export type StageLength = 'short' | 'medium' | 'long';
export const STAGE_LENGTHS: Record<StageLength, number> = {
  short: 1300,
  medium: 2300,
  long: 3600,
};

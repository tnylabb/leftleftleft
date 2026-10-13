// Shared difficulty code: one setting, the same on every map and for every
// player in a room. It shapes the road (width, corner mix, blind crests),
// what the driver can see (fog / sight distance), how early navigation
// information arrives (tablet preview, AI navigator lead), the environment
// (puddles, livestock) and how forgiving the car is. Each map applies it to
// its own terrain (the mountain is already narrow and exposed, so its road
// narrows less but its drops get steeper).
//
// RALLY_STANDARD reproduces the classic stages exactly (same seed = same road).

export type Difficulty = 'standard' | 'hard' | 'expert';
export const DIFFICULTIES: Difficulty[] = ['standard', 'hard', 'expert'];

export function isDifficulty(v: unknown): v is Difficulty {
  return v === 'standard' || v === 'hard' || v === 'expert';
}

/** Handling help for the difficulty (see vehicle/assists). */
export interface HandlingSpec {
  grip: number;
  brake: number;
  abs: number;
  stability: number;
  steerHigh: number;
  topSpeed: number;
  cornerBrake: number;
  keepRoad: number;
}

export interface DifficultySpec {
  code: 'RALLY_STANDARD' | 'RALLY_HARD' | 'RALLY_EXPERT';
  label: string;
  blurb: string;
  // --- road -----------------------------------------------------------------------
  /** Road half width multiplier (countryside). */
  roadWidth: number;
  /** Road half width multiplier on the mountain (already narrow ledges). */
  roadWidthMountain: number;
  /** Segment mix (countryside): weights of straight / keep / easy / medium / hard / hairpin / chicane. */
  segments: [number, number, number, number, number, number, number];
  /** Blind-crest probability multiplier before tight corners. */
  crests: number;
  /** Extra mountain exposure (sheer drops) 0..1 added to the generated value. */
  exposure: number;
  // --- visibility ---------------------------------------------------------------------
  /** Fog distance multiplier (driver sight distance). */
  sight: number;
  // --- navigation -----------------------------------------------------------------------
  /** Route preview on the tablet (road samples ahead, 2 m each). */
  tabletAhead: number;
  /** The tablet's next-instruction banner appears only within this distance (m). */
  tabletCallRange: number;
  /** AI navigator call distance multiplier (earlier = easier). */
  noteLead: number;
  // --- environment ------------------------------------------------------------------------
  puddles: number;
  animals: number;
  // --- the car ------------------------------------------------------------------------------
  handling: HandlingSpec;
}

export const DIFFICULTY: Record<Difficulty, DifficultySpec> = {
  standard: {
    code: 'RALLY_STANDARD',
    label: 'STANDARD',
    blurb: 'Balanced: wider roads, early warnings, a forgiving car.',
    roadWidth: 1,
    roadWidthMountain: 1,
    segments: [18, 6, 12, 20, 22, 10, 12],
    crests: 1,
    exposure: 0,
    sight: 1,
    tabletAhead: 380,
    tabletCallRange: 420,
    noteLead: 1,
    puddles: 1,
    animals: 1,
    handling: { grip: 1.1, brake: 1.3, abs: 0.8, stability: 0.7, steerHigh: 0.88, topSpeed: Infinity, cornerBrake: 0.45, keepRoad: 0.2 },
  },
  hard: {
    code: 'RALLY_HARD',
    label: 'HARD',
    blurb: 'Narrower roads, more hairpins and blind crests, later warnings, less help.',
    roadWidth: 0.88,
    roadWidthMountain: 0.94,
    segments: [14, 5, 9, 20, 26, 13, 15],
    crests: 1.5,
    exposure: 0.12,
    sight: 0.72,
    tabletAhead: 260,
    tabletCallRange: 260,
    noteLead: 0.85,
    puddles: 1.4,
    animals: 1.3,
    handling: { grip: 1.03, brake: 1.15, abs: 0.85, stability: 0.35, steerHigh: 0.95, topSpeed: Infinity, cornerBrake: 0, keepRoad: 0 },
  },
  expert: {
    code: 'RALLY_EXPERT',
    label: 'EXPERT',
    blurb: 'Very narrow roads, short sight, late information. Only the navigator can save you.',
    roadWidth: 0.78,
    roadWidthMountain: 0.88,
    segments: [10, 4, 6, 18, 30, 16, 18],
    crests: 2,
    exposure: 0.22,
    sight: 0.5,
    tabletAhead: 170,
    tabletCallRange: 160,
    noteLead: 0.7,
    puddles: 1.8,
    animals: 1.6,
    handling: { grip: 1, brake: 1, abs: 0, stability: 0, steerHigh: 1, topSpeed: Infinity, cornerBrake: 0, keepRoad: 0 },
  },
};

export function difficultyOf(params: { difficulty?: Difficulty }): DifficultySpec {
  return DIFFICULTY[params.difficulty ?? 'standard'] ?? DIFFICULTY.standard;
}

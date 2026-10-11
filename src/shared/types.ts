import type { StageLength } from './constants';

export type Role = 'driver' | 'navigator';
export type DoorSide = 'left' | 'right';

export type RoomPhase = 'lobby' | 'loading' | 'countdown' | 'racing' | 'finished';

/** Which landscape the stage is generated in. */
export type StageMap = 'countryside' | 'mountain';
export const STAGE_MAPS: StageMap[] = ['countryside', 'mountain'];

export interface StageParams {
  seed: number;
  length: StageLength;
  /** Night stage: dark, headlights, the tablet needs the head lamp to be read. */
  night: boolean;
  map: StageMap;
}

export type CornerSeverity = 'keep' | 'easy' | 'medium' | 'hard' | 'hairpin';

export interface Corner {
  id: number;
  dir: 1 | -1; // +1 right, -1 left
  severity: CornerSeverity;
  entryIdx: number;
  apexIdx: number;
  exitIdx: number;
  angle: number; // total heading change (radians, absolute)
  minRadius: number;
  /** Comfortable target speed for this corner, m/s. */
  targetSpeed: number;
  /** The next corner follows almost immediately ("into"). */
  into: boolean;
}

export interface Jump {
  idx: number;
  height: number;
}

export interface Puddle {
  x: number;
  z: number;
  r: number;
  idx: number;
}

export interface HayBale {
  id: number;
  x: number;
  y: number;
  z: number;
  heading: number;
}

export interface Checkpoint {
  index: number; // ordinal (0-based)
  idx: number; // road sample index
}

export interface StageData {
  params: StageParams;
  /** Road centreline samples, spaced ROAD_SAMPLE_SPACING apart. */
  xs: Float64Array;
  ys: Float64Array;
  zs: Float64Array;
  headings: Float64Array;
  curvature: Float64Array;
  count: number;
  totalLength: number;
  startIdx: number;
  finishIdx: number;
  corners: Corner[];
  jumps: Jump[];
  puddles: Puddle[];
  bales: HayBale[];
  checkpoints: Checkpoint[];
  /** Road half width per sample (narrow mountain ledges, wider hairpins / run-offs). */
  halfWidths: Float64Array;
  /**
   * Per sample, 0..1: how abruptly the ground falls away on the downhill side
   * (mountain: 1 = sheer drop right at the road edge). 0 on the countryside map.
   */
  exposure: Float64Array;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  hash: number;
}

export interface RaceStats {
  timeMs: number;
  progress: number; // 0..1
  distanceDriven: number;
  checkpointsHit: number;
  checkpointsTotal: number;
  missedCheckpoints: number;
  crashes: number;
  missedTurns: number;
  tabletDrops: number;
  resets: number;
  penaltiesMs: number;
  topSpeed: number;
  wrongWay: boolean;
}

export interface RaceResults extends RaceStats {
  finalTimeMs: number;
  avgSpeed: number;
  stageLength: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'D';
  title: string;
  seed: number;
}

export type RaceEvent =
  | { type: 'checkpoint'; index: number; total: number; splitMs: number }
  | { type: 'missedCheckpoint'; index: number; penaltyMs: number }
  | { type: 'missedTurn'; cornerId: number }
  | { type: 'wrongWay'; active: boolean }
  | { type: 'crash'; strength: number }
  | { type: 'finish'; timeMs: number }
  | { type: 'stuck'; flipped: boolean }
  /** The car fell off the road / out of the map and is being put back at the last checkpoint. */
  | { type: 'fellOff' };

/** Which occupants are sitting in the car (false = out on foot). */
export interface SeatStates {
  driver: boolean;
  navigator: boolean;
}

export interface DoorStates {
  left: boolean; // true = open (unlatched)
  right: boolean;
}

export interface ImpactFx {
  strength: number; // delta-v in m/s
  /** Car-local direction of the shock (unit vector). */
  dx: number;
  dy: number;
  dz: number;
  kind: 'tree' | 'rock' | 'terrain' | 'bale' | 'landing' | 'other';
}

export interface MudFx {
  seed: number;
  amount: number; // 0..1
  kind: 'puddle' | 'dirt' | 'impact';
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export type CalloutId =
  | 'left'
  | 'left3'
  | 'right'
  | 'right3'
  | 'otherLeft'
  | 'otherRight'
  | 'brake'
  | 'straight'
  | 'missed'
  | 'accelerating'
  | 'jump'
  | 'wrongWay'
  | 'dropped'
  | 'nice'
  | 'ouch'
  | 'note';

export interface CalloutMsg {
  id: CalloutId;
  /** Free text for pace-note reads (validated / truncated by the server). */
  text?: string;
  auto: boolean;
  from: Role | 'system';
}

export interface PlayerInfo {
  id: string;
  name: string;
  role: Role | null;
  ready: boolean;
  connected: boolean;
  loaded: boolean;
  isHost: boolean;
}

export interface RoomSnapshot {
  code: string;
  phase: RoomPhase;
  players: PlayerInfo[];
  stage: StageParams;
  countdownEndsAt: number | null; // server time ms
  raceStartedAt: number | null;
  pausedForDisconnect: boolean;
  restartVotes: Record<string, 'retry' | 'new'>;
}

// Authoritative race progress: checkpoints, missed turns, wrong way, finish.
// Runs on the server (online) or inside the LocalSession (offline modes).

import {
  CHECKPOINT_LATERAL_TOLERANCE,
  MISSED_CHECKPOINT_PENALTY_MS,
  MISSED_TURN_DISTANCE,
  ROAD_HALF_WIDTH,
  WRONG_WAY_SECONDS,
} from '../constants';
import type { RaceEvent, StageData } from '../types';
import { RoadLocator, type RoadLocation } from './RoadLocator';

export class RaceTracker {
  readonly locator: RoadLocator;
  readonly loc: RoadLocation = { idx: 0, lateral: 0, distance: 0, roadY: 0, heading: 0 };
  private prevIdx: number;
  maxIdx: number;
  nextCheckpoint = 0;
  checkpointsHit = 0;
  missedCheckpoints = 0;
  missedTurns = 0;
  penaltiesMs = 0;
  distanceDriven = 0;
  topSpeed = 0;
  wrongWay = false;
  finished = false;
  private wrongTimer = 0;
  private rightTimer = 0;
  private flaggedCorners = new Set<number>();
  private lastX: number | null = null;
  private lastZ = 0;

  constructor(private stage: StageData) {
    this.locator = new RoadLocator(stage);
    this.prevIdx = stage.startIdx;
    this.maxIdx = stage.startIdx;
  }

  get progress(): number {
    const s = this.stage;
    return Math.max(0, Math.min(1, (this.maxIdx - s.startIdx) / (s.finishIdx - s.startIdx)));
  }

  /** Call after a server-approved reset so the teleport doesn't count as driving. */
  teleported(x: number, z: number, idx: number) {
    this.lastX = x;
    this.lastZ = z;
    this.locator.reset(idx);
    this.prevIdx = idx;
  }

  update(x: number, z: number, vx: number, vz: number, dt: number, raceTimeMs: number): RaceEvent[] {
    const events: RaceEvent[] = [];
    if (this.finished) return events;
    const s = this.stage;
    const loc = this.locator.locate(x, z, this.loc);
    const speed = Math.hypot(vx, vz);
    this.topSpeed = Math.max(this.topSpeed, speed);
    if (this.lastX !== null) {
      const step = Math.hypot(x - this.lastX, z - this.lastZ);
      if (step < 10) this.distanceDriven += step;
    }
    this.lastX = x;
    this.lastZ = z;

    const idx = loc.idx;
    const continuous = Math.abs(idx - this.prevIdx) <= 12;
    const onLine = Math.abs(loc.lateral) <= CHECKPOINT_LATERAL_TOLERANCE;

    // --- checkpoints ---------------------------------------------------------
    while (this.nextCheckpoint < s.checkpoints.length) {
      const cp = s.checkpoints[this.nextCheckpoint];
      if (idx < cp.idx) break;
      if (this.prevIdx < cp.idx && continuous && onLine) {
        this.checkpointsHit++;
        events.push({ type: 'checkpoint', index: cp.index, total: s.checkpoints.length, splitMs: raceTimeMs });
      } else {
        this.missedCheckpoints++;
        this.penaltiesMs += MISSED_CHECKPOINT_PENALTY_MS;
        events.push({ type: 'missedCheckpoint', index: cp.index, penaltyMs: MISSED_CHECKPOINT_PENALTY_MS });
      }
      this.nextCheckpoint++;
    }

    // --- missed turns ---------------------------------------------------------
    if (Math.abs(loc.lateral) > MISSED_TURN_DISTANCE + ROAD_HALF_WIDTH * 0.5) {
      for (const c of s.corners) {
        if (c.severity === 'keep') continue;
        if (idx >= c.entryIdx - 4 && idx <= c.exitIdx + 10 && !this.flaggedCorners.has(c.id)) {
          this.flaggedCorners.add(c.id);
          this.missedTurns++;
          events.push({ type: 'missedTurn', cornerId: c.id });
          break;
        }
      }
    }

    // --- wrong way -------------------------------------------------------------
    const h = loc.heading;
    const along = vx * Math.sin(h) + vz * -Math.cos(h);
    if (along < -2 && loc.distance < 25) {
      this.wrongTimer += dt;
      this.rightTimer = 0;
      if (!this.wrongWay && this.wrongTimer > WRONG_WAY_SECONDS) {
        this.wrongWay = true;
        events.push({ type: 'wrongWay', active: true });
      }
    } else if (along > 1) {
      this.rightTimer += dt;
      this.wrongTimer = 0;
      if (this.wrongWay && this.rightTimer > 0.5) {
        this.wrongWay = false;
        events.push({ type: 'wrongWay', active: false });
      }
    }

    // --- finish ---------------------------------------------------------------
    if (this.prevIdx < s.finishIdx && idx >= s.finishIdx && continuous && onLine) {
      this.finished = true;
      this.maxIdx = s.finishIdx;
      events.push({ type: 'finish', timeMs: raceTimeMs });
    }

    if (continuous) this.maxIdx = Math.max(this.maxIdx, Math.min(idx, s.finishIdx));
    this.prevIdx = idx;
    return events;
  }
}

// Turn analysis: derives corners and navigation instructions from the real
// generated road curvature (never from random messages).

import { ROAD_SAMPLE_SPACING } from '../constants';
import { clamp } from '../math';
import type { Corner, CornerSeverity, StageData } from '../types';

const K_ON = 1 / 230; // curvature above which the road counts as turning

export function analyseCorners(curvature: Float64Array, count: number): Corner[] {
  // Smooth curvature a little so tiny wiggles don't split corners.
  const k = new Float64Array(count);
  const R = 3;
  for (let i = 0; i < count; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - R); j <= Math.min(count - 1, i + R); j++) {
      sum += curvature[j];
      n++;
    }
    k[i] = sum / n;
  }

  const corners: Corner[] = [];
  let i = 0;
  while (i < count) {
    if (Math.abs(k[i]) < K_ON) {
      i++;
      continue;
    }
    const sign = Math.sign(k[i]);
    const entry = i;
    let exit = i;
    let gap = 0;
    let angle = 0;
    let maxK = 0;
    let apex = i;
    while (i < count) {
      const ki = k[i] * sign;
      if (ki >= K_ON) {
        gap = 0;
        exit = i;
        angle += ki * ROAD_SAMPLE_SPACING;
        if (ki > maxK) {
          maxK = ki;
          apex = i;
        }
      } else if (ki > -K_ON * 0.5 && gap < 3) {
        gap++;
      } else break;
      i++;
    }
    i = exit + 1;
    if (angle < (8 * Math.PI) / 180) continue;
    const minRadius = 1 / Math.max(maxK, 1e-6);
    const deg = (angle * 180) / Math.PI;
    let severity: CornerSeverity;
    if (deg >= 125 || minRadius < 13.5) severity = 'hairpin';
    else if (minRadius < 27 || (minRadius < 42 && deg > 100)) severity = 'hard';
    else if (minRadius < 58) severity = 'medium';
    else if (deg < 24 && minRadius > 105) severity = 'keep';
    else severity = 'easy';
    const targetSpeed = clamp(Math.sqrt(0.82 * 9.81 * minRadius), 7, 38);
    corners.push({
      id: corners.length,
      dir: sign > 0 ? 1 : -1,
      severity,
      entryIdx: entry,
      apexIdx: apex,
      exitIdx: exit,
      angle,
      minRadius,
      targetSpeed,
      into: false,
    });
  }
  for (let c = 0; c < corners.length - 1; c++) {
    const gapM = (corners[c + 1].entryIdx - corners[c].exitIdx) * ROAD_SAMPLE_SPACING;
    corners[c].into = gapM < 26;
  }
  return corners;
}

export const SEVERITY_WORD: Record<CornerSeverity, string> = {
  keep: 'KEEP',
  easy: 'EASY',
  medium: '',
  hard: 'HARD',
  hairpin: 'HAIRPIN',
};

export function cornerText(c: Corner): string {
  const dir = c.dir > 0 ? 'RIGHT' : 'LEFT';
  const w = SEVERITY_WORD[c.severity];
  return w ? `${w} ${dir}` : dir;
}

export function brakingDistance(speed: number, target: number, decel = 6.5): number {
  if (speed <= target) return 0;
  return (speed * speed - target * target) / (2 * decel);
}

export interface NavInstruction {
  kind: 'corner' | 'straight' | 'finish';
  text: string;
  /** Metres until the instruction applies (corner entry). Negative = inside it now. */
  distance: number;
  corner: Corner | null;
  then: string | null;
  brakeNow: boolean;
  jumpAhead: number | null; // metres to next jump
  straightFor: number | null;
}

/** Computes the navigator's current instruction for a car at road index `idx` (fractional ok). */
export function computeInstruction(stage: StageData, idx: number, speed: number): NavInstruction {
  const d = ROAD_SAMPLE_SPACING;
  let next: Corner | null = null;
  let nextIdx = -1;
  for (let i = 0; i < stage.corners.length; i++) {
    const c = stage.corners[i];
    if (c.exitIdx <= idx) continue;
    if (c.severity === 'keep') {
      // a gentle bend is only worth calling if no real corner follows right after it
      const real = stage.corners.slice(i + 1).find((o) => o.severity !== 'keep');
      if (real && (real.entryIdx - c.entryIdx) * d < 50) continue;
    }
    next = c;
    nextIdx = i;
    break;
  }
  let jumpAhead: number | null = null;
  for (const j of stage.jumps) {
    const dist = (j.idx - idx) * d;
    if (dist > -4 && dist < 130) {
      jumpAhead = Math.max(0, dist);
      break;
    }
  }
  const toFinish = (stage.finishIdx - idx) * d;
  if (!next || (next.entryIdx - idx) * d > toFinish) {
    return {
      kind: 'finish',
      text: 'FINISH',
      distance: toFinish,
      corner: null,
      then: null,
      brakeNow: false,
      jumpAhead,
      straightFor: toFinish > 60 ? Math.floor(toFinish / 50) * 50 : null,
    };
  }
  const dist = (next.entryIdx - idx) * d;
  let then: string | null = null;
  const after = stage.corners.slice(nextIdx + 1).find((c) => c.severity !== 'keep');
  if (after) {
    const gap = (after.entryIdx - next.exitIdx) * d;
    if (gap < 70) then = (gap < 26 ? 'INTO ' : 'THEN ') + cornerText(after);
  }
  const brakeNow = dist > -6 && speed > next.targetSpeed + 2.5 && dist < brakingDistance(speed, next.targetSpeed) + 12;
  // keep-notes inside the straight are folded into the straight distance
  const prevCorner = nextIdx > 0 ? stage.corners[nextIdx - 1] : null;
  const straightLen = prevCorner ? (next.entryIdx - Math.max(prevCorner.exitIdx, idx)) * d : dist;
  return {
    kind: 'corner',
    text: cornerText(next),
    distance: dist,
    corner: next,
    then,
    brakeNow,
    jumpAhead,
    straightFor: straightLen >= 90 && dist > 60 ? Math.floor(dist / 50) * 50 : null,
  };
}

/** Pace note spoken by the AI co-driver / the "read note" key, e.g. "HARD LEFT 80, INTO EASY RIGHT". */
export function spokenNote(ins: NavInstruction): string {
  if (ins.kind === 'finish') return ins.distance > 80 ? `FLAT OUT ${Math.round(ins.distance / 10) * 10} TO FINISH` : 'FINISH! GO GO GO!';
  let txt = ins.text;
  if (ins.distance > 25) txt += ` ${Math.round(ins.distance / 10) * 10}`;
  if (ins.then) txt += `, ${ins.then}`;
  if (ins.jumpAhead !== null && ins.jumpAhead < ins.distance) txt = `JUMP! THEN ${txt}`;
  return txt;
}

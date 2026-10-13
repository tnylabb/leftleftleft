// Driving help: grip, brakes with ABS, stability control, calmer steering at
// speed and - since the driver can't see the map - help braking for corners
// and staying on the road. How much of it you get is part of the shared
// difficulty (see shared/difficulty: RALLY_STANDARD helps most, RALLY_EXPERT
// gives you the raw car).

import { DIFFICULTY, type HandlingSpec } from '../shared/difficulty';

export type DrivingAssist = HandlingSpec;

/** The raw car: no help at all. */
export const NO_ASSIST: DrivingAssist = DIFFICULTY.expert.handling;

interface AssistRoad {
  count: number;
  halfWidths: Float64Array;
  corners: { severity: string; entryIdx: number; exitIdx: number; targetSpeed: number }[];
}

/**
 * The help the car gives a blind driver (EASY / NORMAL): brakes for a corner
 * it is far too fast for and nudges the steering back from the road edge.
 * `loc` = where the car is on the road; `speed` = forward speed (m/s).
 * Changes `inp` in place.
 */
export function applyAssistInput(
  a: DrivingAssist,
  road: AssistRoad,
  loc: { idx: number; lateral: number; distance: number },
  speed: number,
  inp: { throttle: number; brake: number; steer: number; handbrake: boolean },
  sampleSpacing: number,
) {
  if (a.cornerBrake <= 0 && a.keepRoad <= 0) return;
  const i = Math.max(0, Math.min(road.count - 1, Math.round(loc.idx)));
  const hw = road.halfWidths[i];
  if (loc.distance > hw + 4) return; // properly off the road: no ghost steering
  if (a.cornerBrake > 0 && speed > 6 && !inp.handbrake) {
    let allowed = Infinity;
    for (const c of road.corners) {
      if (c.severity === 'keep' || c.exitIdx < loc.idx) continue;
      const d = Math.max(0, (c.entryIdx - loc.idx) * sampleSpacing);
      if (d > 170) continue;
      const vt = c.targetSpeed * Math.sqrt(a.grip) * 1.06;
      allowed = Math.min(allowed, Math.sqrt(vt * vt + 2 * 6.5 * d));
    }
    const over = speed - allowed;
    if (over > 0) {
      const k = Math.min(1, over / 4) * a.cornerBrake;
      inp.throttle *= 1 - k;
      inp.brake = Math.max(inp.brake, k);
    }
  }
  if (a.keepRoad > 0 && speed > 4) {
    const edge = Math.abs(loc.lateral) - (hw - 1.1);
    if (edge > 0) inp.steer = Math.max(-1, Math.min(1, inp.steer - Math.sign(loc.lateral) * Math.min(1, edge / 1.2) * a.keepRoad));
  }
}

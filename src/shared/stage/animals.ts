// Where the livestock and the farm traffic are on a stage: flocks of sheep
// grazing by the road (a few always on it), stubborn cows standing on the road
// just after blind corners, and a slow tractor on a long countryside stretch.
// Deterministic per seed, with its own random stream so adding animals never
// changes the road itself.

import { ROAD_HALF_WIDTH } from '../constants';
import { clamp } from '../math';
import { Rng, hash2 } from '../rng';
import type { AnimalSpawn, Checkpoint, Corner, Jump, StageParams } from '../types';

/** Network ids of animals start here (hay bales use 0..). */
export const ANIMAL_ID_BASE = 1000;

interface Road {
  xs: Float64Array;
  zs: Float64Array;
  headings: Float64Array;
  curvature: Float64Array;
  count: number;
  startIdx: number;
  finishIdx: number;
  corners: Corner[];
  jumps: Jump[];
  checkpoints: Checkpoint[];
}

export function placeAnimals(params: StageParams, r: Road): AnimalSpawn[] {
  const rng = new Rng(hash2(params.seed, 0xa11e));
  const mountain = params.map === 'mountain';
  const out: AnimalSpawn[] = [];
  const used: number[] = [];
  const free = (i: number) =>
    i > r.startIdx + 70 &&
    i < r.finishIdx - 45 &&
    !r.checkpoints.some((c) => Math.abs(c.idx - i) < 14) &&
    !r.jumps.some((j) => Math.abs(j.idx - i) < 24) &&
    !used.some((u) => Math.abs(u - i) < 70);
  const at = (i: number, lateral: number) => {
    const h = r.headings[i];
    return { x: r.xs[i] + Math.cos(h) * lateral, z: r.zs[i] + Math.sin(h) * lateral };
  };
  const add = (kind: AnimalSpawn['kind'], i: number, lateral: number, heading: number, flock: number) => {
    const p = at(i, lateral);
    out.push({ id: ANIMAL_ID_BASE + out.length, kind, x: p.x, z: p.z, idx: i, heading, flock });
  };
  const len = params.length === 'short' ? 0 : params.length === 'medium' ? 1 : 2;

  // flocks of sheep: grazing beside the road, a couple of them always on it
  const flocks = (mountain ? 1 : 2) + len;
  for (let f = 0, tries = 0; f < flocks && tries < 80; tries++) {
    const i = rng.int(r.startIdx + 70, r.finishIdx - 45);
    if (!free(i)) continue;
    used.push(i);
    const side = rng.sign();
    const home = side * (ROAD_HALF_WIDTH + (mountain ? rng.range(1.5, 3) : rng.range(3, 7)));
    const n = rng.int(4, 7);
    for (let k = 0; k < n; k++) {
      const onRoad = k < (rng.chance(0.7) ? 2 : 1);
      const di = clamp(i + rng.int(-4, 4), 0, r.count - 1);
      const lateral = onRoad ? rng.range(-1.6, 1.6) : home + rng.range(-2.5, 2.5);
      add('sheep', di, lateral, rng.range(0, Math.PI * 2), f);
    }
    f++;
  }

  // cows: standing on the road just after a corner, so they appear late
  const cows = 1 + len;
  const corners = r.corners.filter((c) => c.severity === 'medium' || c.severity === 'hard');
  for (let c = 0, tries = 0; c < cows && tries < 60 && corners.length; tries++) {
    const corner = corners[rng.int(0, corners.length - 1)];
    const i = clamp(corner.exitIdx + rng.int(3, 10), 0, r.count - 1);
    if (!free(i)) continue;
    used.push(i);
    add('cow', i, rng.range(-1.1, 1.1), rng.range(0, Math.PI * 2), -1);
    c++;
  }

  // one tractor on a long, gentle countryside stretch (it trundles ahead of you)
  if (!mountain && len > 0) {
    for (let tries = 0; tries < 80; tries++) {
      const i = rng.int(r.startIdx + 90, r.finishIdx - 160);
      if (!free(i)) continue;
      let gentle = true;
      for (let j = i; j < i + 55 && gentle; j++) if (Math.abs(r.curvature[j]) > 1 / 32) gentle = false;
      if (!gentle) continue;
      used.push(i);
      add('tractor', i, ROAD_HALF_WIDTH * 0.45, r.headings[i], -1);
      break;
    }
  }
  return out;
}

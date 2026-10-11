import { STAGE_LENGTHS } from '../constants';
import { Noise2D, hash2 } from '../rng';
import type { StageParams } from '../types';

export type HeightFn = (x: number, z: number) => number;

/**
 * Base terrain (before the road is carved in). Shared so the server derives
 * exactly the same road elevation profile as every client.
 */
export function createTerrainBase(params: Pick<StageParams, 'seed' | 'length' | 'map'>): HeightFn {
  if (params.map === 'mountain') return createMountainBase(params.seed, STAGE_LENGTHS[params.length] ?? STAGE_LENGTHS.medium);
  const n = new Noise2D(hash2(params.seed, 77));
  return (x: number, z: number) =>
    24 * n.fbm(x / 300, z / 300, 4) + 5 * n.noise(x / 70 + 31.7, z / 70 - 12.3);
}

/** Mountain map: which way is uphill (+1 = towards +X, -1 = towards -X). */
export function mountainUphill(seed: number): number {
  return hash2(seed, 5) & 1 ? 1 : -1;
}

/** Height of the road start on the mountain (it winds its way down from here). */
export function mountainTop(target: number): number {
  return 40 + target * 0.085;
}

const TERRACE = 44; // metres between benches down the fall line
const softplus = (v: number, k: number) => (v > 30 * k ? v : k * Math.log1p(Math.exp(v / k)));

/**
 * One big mountainside: a steep slope (about 25-40 degrees on average, varying
 * along the mountain) with spurs and gullies running down the fall line and
 * rocky lumps, a valley floor far below the stage and a summit ridge far above.
 * Down the fall line it is terraced: steep rocky bands alternate with gentler
 * benches, so a car going over the edge may come to rest on a ledge - or not.
 */
function createMountainBase(seed: number, target: number): HeightFn {
  const n = new Noise2D(hash2(seed, 177));
  const up = mountainUphill(seed);
  const top = mountainTop(target);
  const floor = top - target * 0.085 - 70;
  const cap = top + 260;
  return (x: number, z: number) => {
    const u0 = x * up;
    // smooth staircase along the fall line (slope varies between 0.4x and 1.6x)
    const u = u0 - (TERRACE / (2 * Math.PI)) * 0.6 * Math.sin((2 * Math.PI * u0) / TERRACE + n.noise(z / 160, 3.7) * 1.5);
    // gentler shoulders and sheer faces along the mountain
    const steep = 0.66 * (1 + 0.38 * n.noise(z / 240 + 11.3, u / 420 - 3.1));
    const spurs = 17 * n.fbm(u / 170 + 7.7, z / 92, 3);
    const lumps = 3 * n.noise(x / 21 + 1.3, z / 21 - 4.2);
    let h = top + steep * u + spurs + lumps;
    h = floor + softplus(h - floor, 9);
    h = cap - softplus(cap - h, 14);
    return h;
  };
}

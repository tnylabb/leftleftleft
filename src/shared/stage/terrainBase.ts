import { Noise2D, hash2 } from '../rng';

export type HeightFn = (x: number, z: number) => number;

/**
 * Base rolling-hill terrain (before the road is carved in). Shared so the
 * server derives exactly the same road elevation profile as every client.
 */
export function createTerrainBase(seed: number): HeightFn {
  const n = new Noise2D(hash2(seed, 77));
  return (x: number, z: number) =>
    17 * n.fbm(x / 330, z / 330, 4) + 3.2 * n.noise(x / 72 + 31.7, z / 72 - 12.3);
}

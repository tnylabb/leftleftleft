import { Noise2D, hash2 } from '../rng';

export type HeightFn = (x: number, z: number) => number;

/**
 * Base rolling-hill terrain (before the road is carved in). Shared so the
 * server derives exactly the same road elevation profile as every client.
 */
export function createTerrainBase(seed: number): HeightFn {
  const n = new Noise2D(hash2(seed, 77));
  return (x: number, z: number) =>
    24 * n.fbm(x / 300, z / 300, 4) + 5 * n.noise(x / 70 + 31.7, z / 70 - 12.3);
}

// Deterministic seeded random numbers and gradient noise.
// Everything here uses only integer / basic float arithmetic so results are
// identical on the Node server and in every browser.

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  /** mulberry32 */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(lo: number, hiInclusive: number): number {
    return lo + Math.floor(this.next() * (hiInclusive - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length) % items.length];
  }
  weighted<T extends string>(table: Record<T, number>): T {
    const keys = Object.keys(table) as T[];
    let total = 0;
    for (const k of keys) total += table[k];
    let r = this.next() * total;
    for (const k of keys) {
      r -= table[k];
      if (r <= 0) return k;
    }
    return keys[keys.length - 1];
  }
  fork(salt: number): Rng {
    return new Rng(hash2(this.s, salt));
  }
}

export function hash2(a: number, b: number): number {
  let h = Math.imul(a ^ 0x85ebca6b, 0xc2b2ae35) ^ Math.imul(b + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Seeded 2D gradient (Perlin style) noise in roughly [-1, 1]. */
export class Noise2D {
  private perm = new Uint8Array(512);
  private gx = new Float64Array(256);
  private gz = new Float64Array(256);

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    // 16 fixed unit gradient directions (avoid Math.cos/sin for cross-platform determinism)
    const dirs = [
      [1, 0], [0.92388, 0.38268], [0.70711, 0.70711], [0.38268, 0.92388],
      [0, 1], [-0.38268, 0.92388], [-0.70711, 0.70711], [-0.92388, 0.38268],
      [-1, 0], [-0.92388, -0.38268], [-0.70711, -0.70711], [-0.38268, -0.92388],
      [0, -1], [0.38268, -0.92388], [0.70711, -0.70711], [0.92388, -0.38268],
    ];
    for (let i = 0; i < 256; i++) {
      const d = dirs[Math.floor(rng.next() * 16) % 16];
      this.gx[i] = d[0];
      this.gz[i] = d[1];
    }
  }

  private grad(ix: number, iz: number, dx: number, dz: number): number {
    const h = this.perm[(ix & 255) + this.perm[iz & 255]];
    return this.gx[h] * dx + this.gz[h] * dz;
  }

  noise(x: number, z: number): number {
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const fx = x - x0;
    const fz = z - z0;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const n00 = this.grad(x0, z0, fx, fz);
    const n10 = this.grad(x0 + 1, z0, fx - 1, fz);
    const n01 = this.grad(x0, z0 + 1, fx, fz - 1);
    const n11 = this.grad(x0 + 1, z0 + 1, fx - 1, fz - 1);
    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * 1.41;
  }

  fbm(x: number, z: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.noise(x * freq + o * 17.31, z * freq - o * 9.17) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

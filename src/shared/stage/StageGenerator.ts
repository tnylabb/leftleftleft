// Deterministic procedural rally stage generation.
// The same seed produces the same stage on the server and on every client.

import { ROAD_HALF_WIDTH, ROAD_SAMPLE_SPACING, STAGE_LENGTHS } from '../constants';
import { clamp, wrapAngle } from '../math';
import { Noise2D, Rng, hash2 } from '../rng';
import type { Checkpoint, HayBale, Jump, Puddle, StageData, StageParams } from '../types';
import { placeAnimals } from './animals';
import { analyseCorners } from './pacenotes';
import { createTerrainBase, type HeightFn } from './terrainBase';

type SegmentKind = 'straight' | 'keep' | 'easy' | 'medium' | 'hard' | 'hairpin' | 'chicane';

const SEGMENT_WEIGHTS: Record<SegmentKind, number> = {
  straight: 18,
  keep: 6,
  easy: 12,
  medium: 20,
  hard: 22,
  hairpin: 10,
  chicane: 12,
};

const CORNER_PARAMS: Record<Exclude<SegmentKind, 'straight' | 'chicane'>, { r: [number, number]; a: [number, number] }> = {
  keep: { r: [150, 260], a: [10, 20] },
  easy: { r: [70, 130], a: [25, 55] },
  medium: { r: [28, 50], a: [45, 100] },
  hard: { r: [13, 24], a: [65, 115] },
  hairpin: { r: [9.5, 11.5], a: [145, 170] },
};

const DEG = Math.PI / 180;
const MIN_SEPARATION = 27; // metres between non-adjacent parts of the road
/** Switchback legs on the mountain sit closer together: the slope separates them vertically too. */
const MOUNTAIN_SEPARATION = 18;
const SEPARATION_EXCLUDE = 82; // arc length that is never checked against itself
const CELL = 30;

/** 1m-resolution path builder with a spatial hash for self-intersection checks. */
class PathBuilder {
  xs: number[] = [0];
  zs: number[] = [0];
  hs: number[] = [0];
  ks: number[] = [0];
  private grid = new Map<number, number[]>();

  constructor(private minSeparation = MIN_SEPARATION) {
    this.addToGrid(0);
  }

  get length(): number {
    return this.xs.length - 1;
  }

  private key(x: number, z: number): number {
    return (Math.floor(x / CELL) + 4096) * 8192 + (Math.floor(z / CELL) + 4096);
  }

  private addToGrid(i: number) {
    const k = this.key(this.xs[i], this.zs[i]);
    let list = this.grid.get(k);
    if (!list) this.grid.set(k, (list = []));
    list.push(i);
  }

  private tooClose(x: number, z: number, maxIndex: number): boolean {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const r2 = this.minSeparation * this.minSeparation;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const list = this.grid.get((gx + 4096) * 8192 + (gz + 4096));
        if (!list) continue;
        for (const i of list) {
          if (i >= maxIndex) continue;
          const dx = this.xs[i] - x;
          const dz = this.zs[i] - z;
          if (dx * dx + dz * dz < r2) return true;
        }
      }
    }
    return false;
  }

  /** Integrates a curvature profile (1 entry per metre). Commits only if it does not collide. */
  tryAppend(profile: number[]): boolean {
    const n0 = this.xs.length;
    let x = this.xs[n0 - 1];
    let z = this.zs[n0 - 1];
    let h = this.hs[n0 - 1];
    const nx: number[] = [];
    const nz: number[] = [];
    const nh: number[] = [];
    for (let j = 0; j < profile.length; j++) {
      const k = profile[j];
      const hm = h + k * 0.5;
      x += Math.sin(hm);
      z -= Math.cos(hm);
      h += k;
      if (this.tooClose(x, z, n0 + j - SEPARATION_EXCLUDE)) return false;
      nx.push(x);
      nz.push(z);
      nh.push(h);
    }
    for (let j = 0; j < profile.length; j++) {
      this.xs.push(nx[j]);
      this.zs.push(nz[j]);
      this.hs.push(nh[j]);
      this.ks.push(profile[j]);
      this.addToGrid(this.xs.length - 1);
    }
    return true;
  }
}

function cornerProfile(radius: number, angle: number, dir: number): number[] {
  let lt = clamp(radius * 0.55, 5, 18);
  let arc = angle * radius - lt;
  if (arc < 2) {
    lt = angle * radius * 0.8;
    arc = angle * radius * 0.2;
  }
  const out: number[] = [];
  const nT = Math.max(1, Math.round(lt));
  const nA = Math.max(1, Math.round(arc));
  // scale so the integrated heading change is exactly `angle`
  const raw = nT + nA;
  const kk = (dir * angle) / raw;
  for (let i = 0; i < nT; i++) out.push(kk * ((i + 0.5) / nT));
  for (let i = 0; i < nA; i++) out.push(kk);
  for (let i = 0; i < nT; i++) out.push(kk * (1 - (i + 0.5) / nT));
  return out;
}

function straightProfile(len: number): number[] {
  return new Array(Math.max(1, Math.round(len))).fill(0);
}

function buildPath(seed: number, target: number): PathBuilder {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rng = new Rng(hash2(seed, attempt));
    const path = new PathBuilder();
    path.tryAppend(straightProfile(55));
    let pref = 0;
    let failures = 0;
    let lastWasHairpin = false;
    while (path.length < target - 70 && failures < 10) {
      pref = clamp(pref + rng.range(-0.25, 0.25), -1.0, 1.0);
      const heading = path.hs[path.hs.length - 1];
      const dev = wrapAngle(heading - pref);
      let kind = rng.weighted(SEGMENT_WEIGHTS);
      if (kind === 'hairpin' && (Math.abs(dev) > 0.8 || lastWasHairpin)) kind = 'hard';
      // choose turn direction: forced back towards the preferred heading when far off
      const towards = dev > 0 ? -1 : 1;
      const pTowards = Math.abs(dev) > 0.9 ? 1 : 0.5 + (0.5 * Math.abs(dev)) / 0.9;
      let dir = rng.next() < pTowards ? towards : -towards;

      let ok = false;
      for (let t = 0; t < 6 && !ok; t++) {
        let profile: number[];
        if (kind === 'straight') {
          profile = straightProfile(rng.chance(0.7) ? rng.range(18, 55) : rng.range(55, 120));
        } else if (kind === 'chicane') {
          const r1 = rng.range(20, 45);
          const a1 = rng.range(35, 70) * DEG;
          const r2 = rng.range(20, 45);
          const a2 = a1 * rng.range(0.8, 1.2);
          profile = [
            ...cornerProfile(r1, a1, dir),
            ...straightProfile(rng.range(4, 14)),
            ...cornerProfile(r2, a2, -dir),
          ];
        } else {
          const p = CORNER_PARAMS[kind];
          let ang = rng.range(p.a[0], p.a[1]) * DEG;
          if (dir === towards && kind !== 'hairpin') ang = Math.min(ang, Math.abs(dev) + 70 * DEG);
          profile = cornerProfile(rng.range(p.r[0], p.r[1]), ang, dir);
          if (kind === 'hairpin') profile.push(...straightProfile(rng.range(18, 30)));
        }
        ok = path.tryAppend(profile);
        if (!ok) {
          // alternatives: flip direction, then soften, then straight
          if (t === 0) dir = -dir;
          else if (t === 1) kind = kind === 'hairpin' ? 'hard' : kind === 'hard' ? 'medium' : 'easy';
          else if (t === 2) {
            kind = 'straight';
          } else {
            dir = -dir;
            kind = rng.pick(['easy', 'medium', 'hard'] as const);
          }
        }
      }
      if (ok) {
        failures = 0;
        lastWasHairpin = kind === 'hairpin';
      } else failures++;
    }
    if (path.length >= target * 0.72) {
      // closing straight: approach to the finish line plus a run-off to roll to a stop
      if (!path.tryAppend(straightProfile(120)) && !path.tryAppend(straightProfile(70))) path.tryAppend(straightProfile(30));
      return path;
    }
  }
  // Extremely unlikely: fall back to a gentle S curve.
  const path = new PathBuilder();
  path.tryAppend(straightProfile(60));
  while (path.length < target) {
    path.tryAppend(cornerProfile(80, 40 * DEG, 1));
    path.tryAppend(cornerProfile(80, 40 * DEG, -1));
  }
  return path;
}

/**
 * Mountain road: traced along the contours of the mountainside with a slight
 * downhill bias, so it winds in and out of the gullies and around the spurs
 * (blind corners), and switches back with tight downhill hairpins. The
 * self-intersection check keeps every leg clear of the one above.
 */
function buildMountainPath(seed: number, target: number, M: HeightFn): PathBuilder | null {
  const grad = (x: number, z: number) => {
    const e = 7; // wide enough to follow spurs and gullies, not every rocky lump
    return { gx: (M(x + e, z) - M(x - e, z)) / (2 * e), gz: (M(x, z + e) - M(x, z - e)) / (2 * e) };
  };
  for (let attempt = 0; attempt < 30; attempt++) {
    const rng = new Rng(hash2(seed, 900 + attempt));
    const path = new PathBuilder(MOUNTAIN_SEPARATION);
    if (!path.tryAppend(straightProfile(40))) continue;
    let failed = false;
    while (path.length < target - 140 && !failed) {
      // one leg across the mountainside
      const legLen = rng.range(170, 400);
      const grade = rng.chance(0.25) ? rng.range(0.09, 0.115) : rng.range(0.045, 0.08);
      const wander = rng.range(0, Math.PI * 2);
      let traced = 0;
      let bias = 0;
      while (traced < legLen && path.length < target - 140) {
        let ok = false;
        for (let tries = 0; tries < 4 && !ok; tries++) {
          const n0 = path.xs.length - 1;
          let x = path.xs[n0];
          let z = path.zs[n0];
          let h = path.hs[n0];
          const profile: number[] = [];
          for (let m = 0; m < 10; m++) {
            const { gx, gz } = grad(x, z);
            const g = Math.hypot(gx, gz) || 1e-6;
            // contour direction closest to where we're heading, tipped downhill
            let cx = -gz / g;
            let cz = gx / g;
            const dx = Math.sin(h);
            const dz = -Math.cos(h);
            if (cx * dx + cz * dz < 0) {
              cx = -cx;
              cz = -cz;
            }
            const a = Math.min(0.6, Math.asin(Math.min(0.95, grade / g)) + bias);
            const wx = cx * Math.cos(a) - (gx / g) * Math.sin(a);
            const wz = cz * Math.cos(a) - (gz / g) * Math.sin(a);
            const desired = Math.atan2(wx, -wz) + 0.12 * Math.sin((traced + m) / 41 + wander);
            const err = wrapAngle(desired - h);
            const k = clamp(err * 0.2, -1 / 15, 1 / 15);
            profile.push(k);
            const hm = h + k * 0.5;
            x += Math.sin(hm);
            z -= Math.cos(hm);
            h += k;
          }
          ok = path.tryAppend(profile);
          if (!ok) bias += 0.12; // too close to the leg above: drop away a little faster
        }
        if (!ok) break; // end the leg early: hairpin now
        traced += 10;
        bias = Math.max(0, bias - 0.02);
      }
      if (path.length >= target - 140) break;
      // switchback: turn towards the valley
      const n0 = path.xs.length - 1;
      const { gx, gz } = grad(path.xs[n0], path.zs[n0]);
      const hd = path.hs[n0];
      const dir = Math.cos(hd) * -gx + Math.sin(hd) * -gz > 0 ? 1 : -1;
      let ok = false;
      for (const r of [rng.range(9.5, 11.5), 12.5, 14]) {
        const profile = [...cornerProfile(r, rng.range(168, 186) * DEG, dir), ...straightProfile(rng.range(10, 18))];
        if (path.tryAppend(profile)) {
          ok = true;
          break;
        }
      }
      if (!ok) failed = true;
    }
    if (failed || path.length < target * 0.72) continue;
    // closing straight: approach to the finish line plus a run-off to roll to a stop
    if (!path.tryAppend(straightProfile(120)) && !path.tryAppend(straightProfile(70))) path.tryAppend(straightProfile(30));
    return path;
  }
  return null;
}

function boxSmooth(src: Float64Array<ArrayBuffer>, radius: number, passes: number): Float64Array<ArrayBuffer> {
  let a = src;
  const n = a.length;
  for (let p = 0; p < passes; p++) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
        s += a[j];
        c++;
      }
      out[i] = s / c;
    }
    a = out;
  }
  return a;
}

export function generateStage(params: StageParams): StageData {
  const seed = params.seed >>> 0;
  const target = STAGE_LENGTHS[params.length] ?? STAGE_LENGTHS.medium;
  const mountain = params.map === 'mountain';
  const base = createTerrainBase({ seed, length: params.length, map: mountain ? 'mountain' : 'countryside' });
  const path = (mountain && buildMountainPath(seed, target, base)) || buildPath(seed, target);
  const rng = new Rng(hash2(seed, 0xbeef));

  // --- resample to ROAD_SAMPLE_SPACING ---------------------------------------
  const step = ROAD_SAMPLE_SPACING;
  const count = Math.floor(path.length / step) + 1;
  const xs = new Float64Array(count);
  const zs = new Float64Array(count);
  const headings = new Float64Array(count);
  const curvature = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const j = i * step;
    xs[i] = path.xs[j];
    zs[i] = path.zs[j];
    headings[i] = path.hs[j];
    // average curvature over the sample span
    let k = 0;
    let c = 0;
    for (let m = Math.max(1, j - 1); m <= Math.min(path.ks.length - 1, j + 1); m++) {
      k += path.ks[m];
      c++;
    }
    curvature[i] = c ? k / c : 0;
  }

  // --- elevation ---------------------------------------------------------------
  let ys = new Float64Array(count);
  for (let i = 0; i < count; i++) ys[i] = base(xs[i], zs[i]);
  ys = boxSmooth(ys, mountain ? 10 : 12, 2);
  // mountain roads may be steeper (descents up to ~13 %)
  const maxStep = (mountain ? 0.13 : 0.11) * step;
  for (let i = 1; i < count; i++) ys[i] = clamp(ys[i], ys[i - 1] - maxStep, ys[i - 1] + maxStep);
  for (let i = count - 2; i >= 0; i--) ys[i] = clamp(ys[i], ys[i + 1] - maxStep, ys[i + 1] + maxStep);
  ys = boxSmooth(ys, 4, 1);
  // flatten the start and finish areas
  for (let i = 0; i < Math.min(count, 30); i++) ys[i] = ys[30] ?? ys[i];

  const corners = analyseCorners(curvature, count);
  const startIdx = 10;
  // leave as much of the closing straight as possible after the finish line (run-off)
  let straight = 0;
  for (let i = count - 1; i > 0 && Math.abs(curvature[i]) < 1e-4; i--) straight++;
  const finishIdx = count - clamp(straight - 12, 16, 46);

  // --- checkpoints -------------------------------------------------------------
  const cpCount = params.length === 'short' ? 2 : params.length === 'medium' ? 3 : 5;
  const checkpoints: Checkpoint[] = [];
  for (let c = 0; c < cpCount; c++) {
    const ideal = Math.round(startIdx + ((finishIdx - startIdx) * (c + 1)) / (cpCount + 1));
    let best = ideal;
    let bestK = Infinity;
    for (let i = ideal - 15; i <= ideal + 15; i++) {
      if (i <= startIdx + 20 || i >= finishIdx - 20) continue;
      const k = Math.abs(curvature[i]);
      if (k < bestK) {
        bestK = k;
        best = i;
      }
    }
    checkpoints.push({ index: c, idx: best });
  }
  const nearCheckpoint = (i: number, r: number) => checkpoints.some((c) => Math.abs(c.idx - i) < r);

  // --- jumps ---------------------------------------------------------------------
  const jumps: Jump[] = [];
  // no ramps on the mountain: the crests and drops do that job
  const wantJumps = mountain ? 0 : params.length === 'short' ? 2 : params.length === 'medium' ? 3 : 4;
  const candidates: number[] = [];
  for (let i = 80; i < finishIdx - 60; i++) {
    let straight = true;
    for (let j = i - 16; j <= i + 12 && straight; j++) if (Math.abs(curvature[j]) > 1 / 240) straight = false;
    if (straight && !nearCheckpoint(i, 25)) candidates.push(i);
  }
  for (let tries = 0; tries < 60 && jumps.length < wantJumps && candidates.length; tries++) {
    const i = candidates[rng.int(0, candidates.length - 1)];
    if (jumps.some((j) => Math.abs(j.idx - i) < 100)) continue;
    jumps.push({ idx: i, height: rng.range(1.0, 1.55) });
  }
  jumps.sort((a, b) => a.idx - b.idx);
  for (const j of jumps) {
    const up = 7; // samples of ramp (14 m)
    const down = 6;
    for (let s = -up; s <= down; s++) {
      const i = j.idx + s;
      if (i < 0 || i >= count) continue;
      let h: number;
      if (s <= 0) {
        const t = (s + up) / up;
        h = j.height * t * t;
      } else {
        const t = s / down;
        h = j.height * (1 - t * t * (3 - 2 * t));
      }
      ys[i] += h;
    }
  }

  // --- blind crests: a hump just before some tight corners hides the turn ---------
  // The driver crests the rise and only then sees the road bend away.
  for (const c of corners) {
    if (mountain) break; // mountain corners are blind because of the rock and terrain instead
    const p = c.severity === 'hard' || c.severity === 'hairpin' ? 0.45 : c.severity === 'medium' ? 0.25 : 0;
    if (!rng.chance(p)) continue;
    const centre = c.entryIdx - rng.int(10, 16);
    const half = 11; // samples (22 m) each side
    if (centre - half < startIdx + 25 || centre + half > finishIdx - 12) continue;
    if (jumps.some((j) => Math.abs(j.idx - centre) < 24) || nearCheckpoint(centre, 14)) continue;
    const height = rng.range(1.4, 2.3);
    for (let s = -half; s <= half; s++) ys[centre + s] += height * (0.5 + 0.5 * Math.cos((Math.PI * s) / half));
  }

  // --- puddles ---------------------------------------------------------------
  const puddles: Puddle[] = [];
  const wantPuddles = mountain ? (params.length === 'long' ? 3 : 2) : params.length === 'short' ? 3 : params.length === 'medium' ? 5 : 8;
  for (let tries = 0; tries < 80 && puddles.length < wantPuddles; tries++) {
    const i = rng.int(40, finishIdx - 20);
    if (nearCheckpoint(i, 8) || jumps.some((j) => Math.abs(j.idx - i) < 14)) continue;
    if (puddles.some((p) => Math.abs(p.idx - i) < 40)) continue;
    const off = rng.range(-1.3, 1.3);
    const h = headings[i];
    puddles.push({
      x: xs[i] + Math.cos(h) * off,
      z: zs[i] + Math.sin(h) * off,
      r: rng.range(1.5, 2.4),
      idx: i,
    });
  }
  puddles.sort((a, b) => a.idx - b.idx);

  // --- hay bales on the outside of tight corners ----------------------------------
  const bales: HayBale[] = [];
  for (const c of corners) {
    if (mountain || bales.length >= 44) break; // nothing to stop them rolling down the mountain
    if (!(c.severity === 'hard' || c.severity === 'hairpin' || (c.severity === 'medium' && rng.chance(0.35)))) continue;
    const n = c.severity === 'hairpin' ? 4 : rng.int(2, 3);
    for (let b = 0; b < n; b++) {
      const i = clamp(c.apexIdx + Math.round((b - (n - 1) / 2) * 1.6), 0, count - 1);
      const h = headings[i];
      const off = -c.dir * (ROAD_HALF_WIDTH + rng.range(2.4, 3.3)); // outside of the corner
      bales.push({
        id: bales.length,
        x: xs[i] + Math.cos(h) * off,
        y: ys[i],
        z: zs[i] + Math.sin(h) * off,
        heading: h + rng.range(-0.3, 0.3),
      });
    }
  }

  // --- road width and exposure (mountain) ------------------------------------------
  const halfWidths = new Float64Array(count).fill(ROAD_HALF_WIDTH);
  const exposure = new Float64Array(count);
  if (mountain) {
    const wn = new Noise2D(hash2(seed, 4242));
    const nearHairpin = (i: number) => corners.some((c) => c.severity === 'hairpin' && i >= c.entryIdx - 8 && i <= c.exitIdx + 8);
    for (let i = 0; i < count; i++) {
      // exposed stretches (sheer drop at the edge) alternate with safer, wider verges
      let e = clamp(0.55 + 0.9 * wn.noise(i / 46 + 3.3, 0.7), 0, 1);
      // narrow ledges where it is most exposed
      let w = ROAD_HALF_WIDTH * (1 - 0.2 * clamp((wn.noise(i / 63 - 8.1, 5.2) - 0.15) * 2.5, 0, 1));
      if (e < 0.25) w = Math.max(w, ROAD_HALF_WIDTH * 1.12); // a wider recovery area
      if (nearHairpin(i)) {
        w = ROAD_HALF_WIDTH * 1.2;
        e = Math.min(e, 0.45);
      }
      if (i < startIdx + 25 || i > finishIdx - 10 || nearCheckpoint(i, 10)) {
        w = Math.max(w, ROAD_HALF_WIDTH);
        e = Math.min(e, 0.3);
      }
      halfWidths[i] = w;
      exposure[i] = e;
    }
    const hw = boxSmooth(halfWidths, 6, 2);
    const ex = boxSmooth(exposure, 4, 1);
    halfWidths.set(hw);
    exposure.set(ex);
  }

  // --- livestock and farm traffic (own random stream) -------------------------------
  const animals = placeAnimals(params, { xs, zs, headings, curvature, count, startIdx, finishIdx, corners, jumps, checkpoints });

  // --- bounds & hash -------------------------------------------------------------
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, xs[i]);
    maxX = Math.max(maxX, xs[i]);
    minZ = Math.min(minZ, zs[i]);
    maxZ = Math.max(maxZ, zs[i]);
  }
  let hash = hash2(seed, count);
  for (let i = 0; i < count; i += 7) {
    hash = hash2(hash, Math.round(xs[i] * 10));
    hash = hash2(hash, Math.round(ys[i] * 10));
    hash = hash2(hash, Math.round(zs[i] * 10));
  }
  hash = hash2(hash, corners.length * 1000 + jumps.length * 100 + puddles.length * 10 + checkpoints.length);
  hash = hash2(hash, params.night ? 0x4e1 : 0xda7);
  hash = hash2(hash, mountain ? 0x3170 : 0xc0);

  return {
    params: { seed, length: params.length, night: !!params.night, map: mountain ? 'mountain' : 'countryside' },
    xs,
    ys,
    zs,
    headings,
    curvature,
    count,
    totalLength: (count - 1) * step,
    startIdx,
    finishIdx,
    corners,
    jumps,
    puddles,
    bales,
    animals,
    checkpoints,
    halfWidths,
    exposure,
    bounds: { minX, maxX, minZ, maxZ },
    hash,
  };
}

/** Road-space helpers ---------------------------------------------------------- */

export function roadRight(stage: StageData, i: number): { x: number; z: number } {
  const h = stage.headings[i];
  return { x: Math.cos(h), z: Math.sin(h) };
}

export function roadDir(stage: StageData, i: number): { x: number; z: number } {
  const h = stage.headings[i];
  return { x: Math.sin(h), z: -Math.cos(h) };
}

/** Spawn pose of the car at the start line (identical on server and clients). */
export function stageStartPose(stage: StageData): import('../types').Pose {
  const i = stage.startIdx;
  const h = stage.headings[i];
  return { x: stage.xs[i], y: stage.ys[i] + 0.75, z: stage.zs[i], qx: 0, qy: Math.sin(-h / 2), qz: 0, qw: Math.cos(-h / 2) };
}

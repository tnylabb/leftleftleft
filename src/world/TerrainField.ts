// Terrain height function: base terrain blended with the road corridor
// (flattened road bed, drainage ditches, embankments). On the mountain map the
// corridor is narrow: a steep cut into the rock uphill and, depending on how
// exposed the section is, a verge or a sheer drop right at the road edge.

import { ROAD_HALF_WIDTH } from '../shared/constants';
import { createTerrainBase, type HeightFn } from '../shared/stage/terrainBase';
import type { StageData } from '../shared/types';
import { smoothstep } from '../shared/math';

const CELL = 32; // must exceed the road influence radius (HW + 26)
const HW = ROAD_HALF_WIDTH;
const INFLUENCE2 = (HW + 27) * (HW + 27);

export interface RoadQuery {
  dist: number;
  idx: number;
  lateral: number;
  roadY: number;
}

export class TerrainField {
  readonly base: HeightFn;
  readonly mountain: boolean;
  private grid = new Map<number, number[]>();

  constructor(readonly stage: StageData) {
    this.base = createTerrainBase(stage.params);
    this.mountain = stage.params.map === 'mountain';
    for (let i = 0; i < stage.count - 1; i++) {
      // register each segment in every cell its midpoint and endpoints touch
      const pts = [
        [stage.xs[i], stage.zs[i]],
        [(stage.xs[i] + stage.xs[i + 1]) / 2, (stage.zs[i] + stage.zs[i + 1]) / 2],
      ];
      for (const [x, z] of pts) {
        const k = this.key(Math.floor(x / CELL), Math.floor(z / CELL));
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        if (list[list.length - 1] !== i) list.push(i);
      }
    }
  }

  private key(cx: number, cz: number): number {
    return (cx + 8192) * 16384 + (cz + 8192);
  }

  /** Ditch / road-bed profile relative to the road surface (`hw` = road half width there). */
  static profile(d: number, hw = HW): number {
    if (d < hw + 0.3) return -0.32;
    if (d < hw + 3.6) {
      const t = (d - hw - 0.3) / 3.3;
      return -0.32 - 0.5 * Math.sin(Math.PI * t);
    }
    if (d < hw + 6) return -0.32 * (1 - (d - hw - 3.6) / 2.4);
    return 0;
  }

  /** Nearest road point within ~CELL*1.5 metres (dist = Infinity when far away). */
  queryRoad(x: number, z: number, out: RoadQuery = { dist: Infinity, idx: 0, lateral: 0, roadY: 0 }): RoadQuery {
    const s = this.stage;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    out.dist = Infinity;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const list = this.grid.get(this.key(gx, gz));
        if (!list) continue;
        for (const i of list) {
          const ax = s.xs[i], az = s.zs[i];
          const abx = s.xs[i + 1] - ax, abz = s.zs[i + 1] - az;
          const len2 = abx * abx + abz * abz;
          let t = ((x - ax) * abx + (z - az) * abz) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = x - (ax + abx * t);
          const dz = z - (az + abz * t);
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d < out.dist) {
            out.dist = d;
            out.idx = i + t;
            out.lateral = (dx * -abz + dz * abx) / Math.sqrt(len2);
            out.roadY = s.ys[i] + (s.ys[i + 1] - s.ys[i]) * t;
          }
        }
      }
    }
    return out;
  }

  /** Road half width at a fractional sample index. */
  halfWidthAt(idx: number): number {
    const s = this.stage;
    const i = Math.max(0, Math.min(s.count - 1, Math.floor(idx)));
    return s.halfWidths[i];
  }

  /** Final terrain height (smoothly blended between overlapping road legs). */
  heightAt(x: number, z: number): number {
    const s = this.stage;
    const base = this.base(x, z);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let wSum = 0;
    let tSum = 0;
    let dMin = Infinity;
    let iMin = 0;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const list = this.grid.get(this.key(gx, gz));
        if (!list) continue;
        for (const i of list) {
          const ax = s.xs[i], az = s.zs[i];
          const abx = s.xs[i + 1] - ax, abz = s.zs[i + 1] - az;
          const len2 = abx * abx + abz * abz;
          let t = ((x - ax) * abx + (z - az) * abz) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = x - (ax + abx * t);
          const dz = z - (az + abz * t);
          const d2 = dx * dx + dz * dz;
          if (d2 > INFLUENCE2) continue;
          const d = Math.sqrt(d2);
          const roadY = s.ys[i] + (s.ys[i + 1] - s.ys[i]) * t;
          const e = (d + 0.5) * (d + 0.5);
          const w = 1 / (e * e);
          wSum += w;
          const hw = s.halfWidths[i];
          tSum += w * (roadY + (this.mountain ? (d < hw + 0.4 ? -0.3 : -0.3 * Math.max(0, 1 - (d - hw - 0.4) / 0.8)) : TerrainField.profile(d, hw)));
          if (d < dMin) {
            dMin = d;
            iMin = i;
          }
        }
      }
    }
    if (wSum === 0) return base;
    const target = tSum / wSum;
    if (!this.mountain) {
      const alpha = 1 - smoothstep(HW + 6, HW + 26, dMin);
      return base + (target - base) * alpha;
    }
    // mountain: a steep cut into the hill above the road, and below it a verge
    // or (on exposed sections) the ground falling away right at the edge
    const hw = s.halfWidths[iMin];
    const width = base > target ? 2.4 : 2.2 + (1 - s.exposure[iMin]) * 12;
    const alpha = 1 - smoothstep(hw + 0.5, hw + 0.5 + width, dMin);
    return base + (target - base) * alpha;
  }
}

// Finds where a world position lies relative to the road centreline.

import type { StageData } from '../types';

export interface RoadLocation {
  /** Fractional sample index along the road. */
  idx: number;
  /** Signed lateral offset (positive = right of the centreline). */
  lateral: number;
  distance: number;
  roadY: number;
  heading: number;
}

export class RoadLocator {
  idx: number;
  constructor(private stage: StageData, startIdx = stage.startIdx) {
    this.idx = startIdx;
  }

  reset(idx: number) {
    this.idx = idx;
  }

  private bestInRange(x: number, z: number, from: number, to: number, out: RoadLocation): number {
    const s = this.stage;
    let best = Infinity;
    const lo = Math.max(0, Math.floor(from));
    const hi = Math.min(s.count - 2, Math.ceil(to));
    for (let i = lo; i <= hi; i++) {
      const ax = s.xs[i], az = s.zs[i];
      const bx = s.xs[i + 1], bz = s.zs[i + 1];
      const abx = bx - ax, abz = bz - az;
      const len2 = abx * abx + abz * abz || 1e-9;
      let t = ((x - ax) * abx + (z - az) * abz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + abx * t;
      const pz = az + abz * t;
      const dx = x - px, dz = z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        const len = Math.sqrt(len2);
        // right vector of the segment = (dirZ*-1, dirX)... dir=(abx,abz)/len -> right=( -abz, abx )/len
        const lateral = (dx * -abz + dz * abx) / len;
        out.idx = i + t;
        out.lateral = lateral;
        out.distance = Math.sqrt(d2);
        out.roadY = s.ys[i] + (s.ys[i + 1] - s.ys[i]) * t;
        out.heading = s.headings[i];
      }
    }
    return best;
  }

  /** Tracks progress with a local window; falls back to a wider search when lost. */
  locate(x: number, z: number, out: RoadLocation = { idx: 0, lateral: 0, distance: 0, roadY: 0, heading: 0 }): RoadLocation {
    this.bestInRange(x, z, this.idx - 15, this.idx + 45, out);
    if (out.distance > 22) {
      const wide: RoadLocation = { ...out };
      this.bestInRange(x, z, this.idx - 300, this.idx + 300, wide);
      if (wide.distance < out.distance - 4) Object.assign(out, wide);
    }
    if (out.distance > 120) {
      const all: RoadLocation = { ...out };
      this.bestInRange(x, z, 0, this.stage.count, all);
      if (all.distance < out.distance) Object.assign(out, all);
    }
    this.idx = out.idx;
    return out;
  }
}

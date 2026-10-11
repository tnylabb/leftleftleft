// Jitter buffer + interpolation for remote state snapshots. Each snapshot
// carries the sender's simulation time; we estimate the clock offset from the
// fastest recent packets and render slightly in the past.

import { CAR } from '../shared/snapshot';

interface Entry {
  t: number;
  data: Float32Array;
}

export type InterpFn = (a: Float32Array, b: Float32Array, alpha: number, dt: number, out: Float32Array) => void;

export class SnapshotBuffer {
  private entries: Entry[] = [];
  private offsets: { at: number; o: number }[] = [];
  private lastT = -Infinity;
  delay: number;

  constructor(
    private length: number,
    private interp: InterpFn,
    delay = 0.1,
  ) {
    this.delay = delay;
  }

  clear() {
    this.entries = [];
    this.offsets = [];
    this.lastT = -Infinity;
  }

  get size(): number {
    return this.entries.length;
  }

  latest(): Float32Array | null {
    return this.entries.length ? this.entries[this.entries.length - 1].data : null;
  }

  push(data: Float32Array, nowSec: number) {
    if (data.length !== this.length) return;
    const t = data[0];
    if (t < this.lastT - 1) this.clear(); // sender restarted its clock
    if (t <= this.lastT) return;
    this.lastT = t;
    this.entries.push({ t, data });
    if (this.entries.length > 40) this.entries.shift();
    this.offsets.push({ at: nowSec, o: nowSec - t });
    while (this.offsets.length && nowSec - this.offsets[0].at > 2.5) this.offsets.shift();
  }

  /** Samples the interpolated state for local time `nowSec`. Returns false when empty. */
  sample(nowSec: number, out: Float32Array): boolean {
    const n = this.entries.length;
    if (!n) return false;
    let offset = Infinity;
    for (const o of this.offsets) offset = Math.min(offset, o.o);
    const rt = nowSec - offset - this.delay;
    if (n === 1 || rt <= this.entries[0].t) {
      out.set(this.entries[rt <= this.entries[0].t ? 0 : n - 1].data);
      return true;
    }
    for (let i = n - 1; i > 0; i--) {
      const a = this.entries[i - 1];
      const b = this.entries[i];
      if (rt >= a.t && rt <= b.t) {
        const dt = b.t - a.t;
        this.interp(a.data, b.data, dt > 0 ? (rt - a.t) / dt : 1, dt, out);
        return true;
      }
    }
    // extrapolate from the newest (bounded)
    const last = this.entries[n - 1];
    const prev = this.entries[n - 2];
    const ahead = Math.min(rt - last.t, 0.25);
    this.interp(prev.data, last.data, 1 + ahead / Math.max(1e-3, last.t - prev.t), last.t - prev.t, out);
    return true;
  }
}

function hermite(p0: number, v0: number, p1: number, v1: number, t: number, dt: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * dt * v0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * dt * v1;
}

function slerpInto(a: Float32Array, b: Float32Array, o: number, t: number, out: Float32Array) {
  let bx = b[o], by = b[o + 1], bz = b[o + 2], bw = b[o + 3];
  const ax = a[o], ay = a[o + 1], az = a[o + 2], aw = a[o + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  let k0: number, k1: number;
  if (cos > 0.9995) {
    k0 = 1 - t;
    k1 = t;
  } else {
    const th = Math.acos(Math.min(1, cos));
    const s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s;
    k1 = Math.sin(t * th) / s;
  }
  let x = ax * k0 + bx * k1, y = ay * k0 + by * k1, z = az * k0 + bz * k1, w = aw * k0 + bw * k1;
  const l = Math.hypot(x, y, z, w) || 1;
  x /= l; y /= l; z /= l; w /= l;
  out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
}

/** Car snapshot interpolation: Hermite position, slerp rotation, lerp the rest. */
export const interpolateCar: InterpFn = (a, b, alpha, dt, out) => {
  const t = Math.max(0, alpha);
  const tc = Math.min(1, t);
  for (let i = 0; i < CAR.LENGTH; i++) out[i] = a[i] + (b[i] - a[i]) * tc;
  if (t <= 1) {
    out[CAR.px] = hermite(a[CAR.px], a[CAR.vx], b[CAR.px], b[CAR.vx], t, dt);
    out[CAR.py] = hermite(a[CAR.py], a[CAR.vy], b[CAR.py], b[CAR.vy], t, dt);
    out[CAR.pz] = hermite(a[CAR.pz], a[CAR.vz], b[CAR.pz], b[CAR.vz], t, dt);
  } else {
    const ex = (t - 1) * dt;
    out[CAR.px] = b[CAR.px] + b[CAR.vx] * ex;
    out[CAR.py] = b[CAR.py] + b[CAR.vy] * ex;
    out[CAR.pz] = b[CAR.pz] + b[CAR.vz] * ex;
  }
  slerpInto(a, b, CAR.qx, tc, out);
  // discrete fields come from the newer snapshot
  out[CAR.gear] = b[CAR.gear];
  out[CAR.flags] = b[CAR.flags];
  out[CAR.seq] = b[CAR.seq];
  out[CAR.footGrip] = b[CAR.footGrip];
};

/** Generic pose-array interpolation: [time, ..., (px,py,pz,qx,qy,qz,qw) blocks at given offsets]. */
export function makePoseInterp(poseOffsets: number[], discrete: number[]): InterpFn {
  return (a, b, alpha, _dt, out) => {
    const t = Math.min(1, Math.max(0, alpha));
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
    for (const o of poseOffsets) slerpInto(a, b, o + 3, t, out);
    for (const d of discrete) out[d] = b[d];
  };
}

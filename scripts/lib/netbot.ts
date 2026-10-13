// Test helpers for driving the real server with Socket.IO clients: connect,
// join rooms, and a scripted car that drives the actual stage centreline at a
// chosen speed, sending genuine car-state snapshots (so checkpoints, the
// finish and the race clock all happen for real).

import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, JoinAck, ServerToClientEvents } from '../../src/shared/protocol';
import { CAR, toArrayBuffer } from '../../src/shared/snapshot';
import { generateStage, stageStartPose } from '../../src/shared/stage/StageGenerator';
import type { RoomSnapshot, StageData, StageParams } from '../../src/shared/types';

export type S = Socket<ServerToClientEvents, ClientToServerEvents>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function connect(url: string): Promise<S> {
  return new Promise((resolve, reject) => {
    const s: S = io(url, { transports: ['websocket'], reconnection: false, forceNew: true });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

export function once<K extends keyof ServerToClientEvents>(s: S, ev: K, ms = 8000): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${String(ev)}`)), ms);
    (s as unknown as { once: (e: string, f: (p: unknown) => void) => void }).once(ev as string, (p: unknown) => {
      clearTimeout(t);
      resolve(p as never);
    });
  });
}

/** Resolves when `pred` holds for a received event (or rejects after `ms`). */
export function until<K extends keyof ServerToClientEvents>(s: S, ev: K, pred: (p: Parameters<ServerToClientEvents[K]>[0]) => boolean, ms = 10000): Promise<Parameters<ServerToClientEvents[K]>[0]> {
  return new Promise((resolve, reject) => {
    const f = (p: never) => {
      if (pred(p)) {
        clearTimeout(t);
        (s as unknown as { off: (e: string, f: unknown) => void }).off(ev as string, f);
        resolve(p);
      }
    };
    const t = setTimeout(() => {
      (s as unknown as { off: (e: string, f: unknown) => void }).off(ev as string, f);
      reject(new Error(`timeout waiting for ${String(ev)}`));
    }, ms);
    (s as unknown as { on: (e: string, f: unknown) => void }).on(ev as string, f);
  });
}

export const ack = <T>(fn: (cb: (r: T) => void) => void): Promise<T> => new Promise((r) => fn(r));

/** A player: socket + the latest room snapshot it has seen. */
export class Player {
  room: RoomSnapshot | null = null;
  playerId = '';
  constructor(readonly s: S, readonly name: string) {
    s.on('room:state', (r) => (this.room = r));
  }
  static async make(url: string, name: string) {
    return new Player(await connect(url), name);
  }
  async create(extra: Record<string, unknown> = {}): Promise<JoinAck> {
    const r = await ack<JoinAck>((cb) => this.s.emit('room:create', { name: this.name, ...extra } as { name: string }, cb));
    this.playerId = r.playerId ?? '';
    if (r.room) this.room = r.room;
    return r;
  }
  async join(code: string, extra: Record<string, unknown> = {}): Promise<JoinAck> {
    const r = await ack<JoinAck>((cb) => this.s.emit('room:join', { code, name: this.name, ...extra } as { code: string; name: string }, cb));
    this.playerId = r.playerId ?? '';
    if (r.room) this.room = r.room;
    return r;
  }
  get me() {
    return this.room?.players.find((p) => p.id === this.playerId) ?? null;
  }
  close() {
    this.s.disconnect();
  }
}

/** Waits for game:load on every player, then reports everyone loaded. Returns the stage. */
export async function loadAll(players: Player[], trigger: () => void): Promise<StageData> {
  const loads = players.map((p) => once(p.s, 'game:load', 10000));
  trigger();
  const params = (await Promise.all(loads))[0] as StageParams;
  const stage = generateStage(params);
  for (const p of players) p.s.emit('game:loaded', { hash: stage.hash });
  return stage;
}

/**
 * A scripted car on the real road: holds the start pose through the countdown,
 * then follows the centreline at `speed` m/s (0 = stays put), sending 30 Hz car
 * states. Stops at the finish (and rolls a little further) or when told to.
 */
export class ScriptedCar {
  private dist = 0;
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private t0 = Date.now();
  private going = false;
  sent = 0;

  constructor(private driver: S, private stage: StageData, public speed: number) {}

  start() {
    const st = this.stage;
    const pose = stageStartPose(st);
    let last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      const buf = new Float32Array(CAR.LENGTH);
      buf[CAR.time] = (now - this.t0) / 1000;
      buf[CAR.seq] = this.seq++;
      buf[CAR.gear] = 2;
      buf[CAR.footGrip] = -1;
      if (!this.going) {
        buf[CAR.px] = pose.x;
        buf[CAR.py] = pose.y;
        buf[CAR.pz] = pose.z;
        buf[CAR.qy] = pose.qy;
        buf[CAR.qw] = pose.qw;
      } else {
        const v = this.speed;
        this.dist = Math.min(this.dist + v * dt, (st.count - 2 - st.startIdx) * 2);
        const fi = st.startIdx + this.dist / 2;
        const i = Math.min(st.count - 2, Math.floor(fi));
        const f = fi - i;
        const h = st.headings[i];
        buf[CAR.px] = st.xs[i] + (st.xs[i + 1] - st.xs[i]) * f;
        buf[CAR.py] = st.ys[i] + (st.ys[i + 1] - st.ys[i]) * f + 0.75;
        buf[CAR.pz] = st.zs[i] + (st.zs[i + 1] - st.zs[i]) * f;
        buf[CAR.qy] = Math.sin(-h / 2);
        buf[CAR.qw] = Math.cos(-h / 2);
        buf[CAR.vx] = Math.sin(h) * v;
        buf[CAR.vz] = -Math.cos(h) * v;
        buf[CAR.throttle] = v > 0 ? 0.8 : 0;
      }
      this.sent++;
      this.driver.emit('car:state', toArrayBuffer(buf));
    }, 33);
  }

  go() {
    this.going = true;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

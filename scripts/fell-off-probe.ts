// Checks the "fell off -> back to the last checkpoint" rule on a running server:
// starts a race with two clients, then the driver reports the car off the road
// and well below it. Expects a 'fellOff' race event and a reset onto the road.
// Run: npx tsx scripts/fell-off-probe.ts [url]

import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, JoinAck, ServerToClientEvents } from '../src/shared/protocol';
import { CAR, toArrayBuffer } from '../src/shared/snapshot';
import { generateStage, stageStartPose } from '../src/shared/stage/StageGenerator';

type S = Socket<ServerToClientEvents, ClientToServerEvents>;
const url = process.argv[2] ?? `http://localhost:${process.env.GAME_PORT ?? 3001}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const connect = (): Promise<S> =>
  new Promise((resolve, reject) => {
    const s: S = io(url, { transports: ['websocket'], reconnection: false, timeout: 60000 });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const ack = <T>(fn: (cb: (r: T) => void) => void): Promise<T> => new Promise((r) => fn(r));

const driver = await connect();
const nav = await connect();
const created = await ack<JoinAck>((cb) => driver.emit('room:create', { name: 'probe' }, cb));
await ack<JoinAck>((cb) => nav.emit('room:join', { code: created.code!, name: 'probe2' }, cb));
driver.emit('lobby:stage', { length: 'short', seed: 4242, night: false, map: 'mountain' });
await sleep(400);
const load = new Promise<Parameters<ServerToClientEvents['game:load']>[0]>((r) => driver.once('game:load', r));
driver.emit('lobby:ready', { ready: true });
nav.emit('lobby:ready', { ready: true });
const params = await load;
const stage = generateStage(params);
driver.emit('game:loaded', { hash: stage.hash });
nav.emit('game:loaded', { hash: stage.hash });
await new Promise((r) => driver.once('game:go', r));

const events: string[] = [];
let teleport: { x: number; y: number; z: number } | null = null;
driver.on('race:event', (e) => events.push(e.type));
driver.on('car:teleport', (p) => (teleport = p));
const start = stageStartPose(stage);
const buf = new Float32Array(CAR.LENGTH);
const h = stage.headings[stage.startIdx];
let time = 0;
const send = (x: number, y: number, z: number) => {
  time += 1 / 30;
  buf[CAR.time] = time;
  buf[CAR.px] = x;
  buf[CAR.py] = y;
  buf[CAR.pz] = z;
  buf[CAR.qx] = start.qx;
  buf[CAR.qy] = start.qy;
  buf[CAR.qz] = start.qz;
  buf[CAR.qw] = start.qw;
  buf[CAR.gear] = 1;
  buf[CAR.footGrip] = -1;
  driver.emit('car:state', toArrayBuffer(buf));
};
// slide off the side of the road and down 6 m over ~1 s, then lie there
const t0 = Date.now();
for (let i = 0; i <= 30; i++) {
  const f = i / 30;
  send(start.x + Math.cos(h) * 8 * f, start.y - 6 * f, start.z + Math.sin(h) * 8 * f);
  await sleep(33);
}
while (!teleport && Date.now() - t0 < 6000) {
  send(start.x + Math.cos(h) * 8, start.y - 6, start.z + Math.sin(h) * 8);
  await sleep(33);
}
const took = ((Date.now() - t0) / 1000).toFixed(1);
const tp = teleport as { x: number; y: number; z: number } | null;
console.log(`race events: ${events.join(', ') || '(none)'}`);
console.log(tp ? `reset after ${took} s to (${tp.x.toFixed(1)}, ${tp.y.toFixed(1)}, ${tp.z.toFixed(1)}); start line (${start.x.toFixed(1)}, ${start.y.toFixed(1)}, ${start.z.toFixed(1)})` : `no reset within ${took} s`);
const ok = events.includes('fellOff') && !!tp && Math.hypot(tp.x - start.x, tp.z - start.z) < 3;
console.log(ok ? 'FELL-OFF RESET WORKS' : 'FELL-OFF RESET NOT SEEN');
driver.disconnect();
nav.disconnect();
process.exit(ok ? 0 : 1);

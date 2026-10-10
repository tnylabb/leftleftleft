// End-to-end multiplayer protocol test against a running server.
// Start the server first (npm run dev or npm start), then: npx tsx scripts/net-test.ts [url]
// Simulates a driver and a navigator: lobby, ready, load, countdown, car-state
// relay, validation, callouts, reset, disconnect + reconnect with the seat token.

import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, JoinAck, ServerToClientEvents } from '../src/shared/protocol';
import { CAR, readFloat32, toArrayBuffer } from '../src/shared/snapshot';
import { generateStage, stageStartPose } from '../src/shared/stage/StageGenerator';
import type { RoomSnapshot } from '../src/shared/types';

type S = Socket<ServerToClientEvents, ClientToServerEvents>;
const url = process.argv[2] ?? `http://localhost:${process.env.GAME_PORT ?? 3001}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const connect = (): Promise<S> =>
  new Promise((resolve, reject) => {
    const s: S = io(url, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
const once = <K extends keyof ServerToClientEvents>(s: S, ev: K, ms = 6000): Promise<Parameters<ServerToClientEvents[K]>[0]> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${String(ev)}`)), ms);
    (s as unknown as { once: (e: string, f: (p: unknown) => void) => void }).once(ev as string, (p: unknown) => {
      clearTimeout(t);
      resolve(p as never);
    });
  });
const ack = <T>(fn: (cb: (r: T) => void) => void): Promise<T> => new Promise((r) => fn(r));

const driver = await connect();
const nav = await connect();
const created = await ack<JoinAck>((cb) => driver.emit('room:create', { name: 'Driver<script>' }, cb));
check(created.ok && !!created.code, `room created: ${created.code}`);
check(!created.room?.players[0].name.includes('<'), 'player names are sanitised');
const bad = await ack<JoinAck>((cb) => nav.emit('room:join', { code: 'ZZZZ', name: 'x' }, cb));
check(!bad.ok, `joining a missing room fails ("${bad.error}")`);
const joined = await ack<JoinAck>((cb) => nav.emit('room:join', { code: created.code!, name: 'Navi' }, cb));
check(joined.ok, 'navigator joined');
const third = await connect();
const full = await ack<JoinAck>((cb) => third.emit('room:join', { code: created.code!, name: 'Third' }, cb));
check(!full.ok, `third player rejected ("${full.error}")`);
third.disconnect();

let room: RoomSnapshot = joined.room!;
driver.on('room:state', (r) => (room = r));
check(room.players.find((p) => p.id === created.playerId)?.role === 'driver', 'creator auto-assigned driver');
check(room.players.find((p) => p.id === joined.playerId)?.role === 'navigator', 'joiner auto-assigned navigator');
nav.emit('lobby:role', { role: 'driver' });
await sleep(150);
check(room.players.find((p) => p.id === joined.playerId)?.role === 'navigator', 'cannot take a role that is already taken');
nav.emit('lobby:stage', { length: 'long' });
await sleep(150);
check(room.stage.length === 'medium', 'only the host can change the stage');
driver.emit('lobby:stage', { length: 'short', seed: 4242 });
await sleep(150);
check(room.stage.length === 'short' && room.stage.seed === 4242, 'host sets stage length + seed');

const loadD = once(driver, 'game:load');
const loadN = once(nav, 'game:load');
driver.emit('lobby:ready', { ready: true });
nav.emit('lobby:ready', { ready: true });
const params = await loadD;
await loadN;
check(params.seed === 4242 && params.length === 'short', 'both receive game:load with the stage params');
const stage = generateStage(params);
const countdown = once(driver, 'game:countdown');
driver.emit('game:loaded', { hash: stage.hash });
nav.emit('game:loaded', { hash: stage.hash });
const cd = await countdown;
check(cd.endsAt > Date.now(), 'countdown starts after both loaded');

// car state relay
const start = stageStartPose(stage);
const buf = new Float32Array(CAR.LENGTH);
const setPos = (x: number, y: number, z: number, t: number) => {
  buf[CAR.time] = t;
  buf[CAR.px] = x;
  buf[CAR.py] = y;
  buf[CAR.pz] = z;
  buf[CAR.qx] = start.qx;
  buf[CAR.qy] = start.qy;
  buf[CAR.qz] = start.qz;
  buf[CAR.qw] = start.qw;
  buf[CAR.gear] = 1;
};
let relayed = 0;
let lastRelayX = 0;
nav.on('car:state', (b) => {
  const f = readFloat32(b);
  if (f) {
    relayed++;
    lastRelayX = f[CAR.px];
  }
});
setPos(start.x, start.y, start.z, 0.1);
driver.emit('car:state', toArrayBuffer(buf));
await sleep(200);
check(relayed === 1, 'driver car state relayed to the navigator');
nav.emit('car:state', toArrayBuffer(buf));
await sleep(150);
check(relayed === 1, 'navigator cannot send car states (role validation)');
await once(driver, 'game:go', 6000);
check(true, 'game:go received');

const teleportJump = new Float32Array(buf);
teleportJump[CAR.px] = start.x + 500;
teleportJump[CAR.time] = 0.2;
const corrections = once(driver, 'car:correction', 3000).catch(() => null);
for (let i = 0; i < 3; i++) driver.emit('car:state', toArrayBuffer(teleportJump));
await sleep(300);
check(lastRelayX !== start.x + 500, 'teleporting car states are rejected');
check((await corrections) !== null, 'driver receives a correction after repeated invalid states');

// callouts + auto validation
const callout = once(driver, 'callout');
nav.emit('callout', { id: 'left3' });
const c = await callout;
check(c.id === 'left3' && c.from === 'navigator', 'navigator callout delivered to the driver');
let fakeSeen = false;
nav.on('callout', (m) => {
  if (m.id === 'brake' && !m.auto) fakeSeen = true;
});
driver.emit('callout', { id: 'brake' });
await sleep(600);
check(!fakeSeen, 'driver cannot send navigator callouts');

// reset
const tele = once(driver, 'car:teleport');
driver.emit('car:reset');
const pose = await tele;
check(Math.abs(pose.x - start.x) < 30, 'reset teleports the car back onto the road');

// doors via impact
let doors: { left: boolean; right: boolean } | null = null;
driver.on('doors:state', (d) => (doors = d));
setPos(pose.x, pose.y, pose.z, 1);
buf[CAR.vz] = -18;
driver.emit('car:state', toArrayBuffer(buf));
await sleep(100);
for (let i = 0; i < 6; i++) {
  driver.emit('event:impact', { strength: 12, dx: 1, dy: 0, dz: 0, kind: 'tree' });
  await sleep(160);
}
check(doors !== null, `big side impacts can pop a door open (${JSON.stringify(doors)})`);

// disconnect + reconnect
const paused = once(driver, 'game:paused');
nav.disconnect();
const p = await paused;
check(p.paused, `driver sees the pause when the navigator drops ("${p.reason}")`);
const nav2 = await connect();
const reload = once(nav2, 'game:load');
const re = await ack<JoinAck>((cb) => nav2.emit('room:join', { code: created.code!, name: 'Navi', playerId: joined.playerId, token: joined.token }, cb));
check(re.ok && re.playerId === joined.playerId, 'navigator rejoins the same seat with the token');
await reload;
const resumed = once(driver, 'game:paused');
nav2.emit('game:loaded', { hash: stage.hash });
const r2 = await resumed;
check(!r2.paused, 'stage resumes after the navigator reloaded');
const wrongToken = await ack<JoinAck>((cb) => third.connect() && third.emit('room:join', { code: created.code!, name: 'x', playerId: joined.playerId, token: 'nope' }, cb)).catch(() => ({ ok: false }) as JoinAck);
check(!wrongToken.ok, 'a wrong seat token cannot hijack a seat');

driver.disconnect();
nav2.disconnect();
third.disconnect();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);

// End-to-end multiplayer protocol test against a running server.
// Start the server first (npm run dev or npm start), then: npx tsx scripts/net-test.ts [url]
// Simulates a driver and a navigator: lobby, ready, load, countdown, car-state
// relay, validation, callouts, reset, manual wipers, getting out / pulling /
// getting back in, disconnect + reconnect with the seat token.

import { io, type Socket } from 'socket.io-client';
import * as THREE from 'three';
import type { ClientToServerEvents, JoinAck, ServerToClientEvents } from '../src/shared/protocol';
import { CAR_HOOKS, DOOR_EXIT, PULL_FORCE_MAX } from '../src/shared/constants';
import { CABIN, CABIN_FLAG, CAR, CAR_FLAG, readFloat32, toArrayBuffer } from '../src/shared/snapshot';
import { generateStage, stageStartPose } from '../src/shared/stage/StageGenerator';
import type { RoomSnapshot } from '../src/shared/types';

type S = Socket<ServerToClientEvents, ClientToServerEvents>;
const url = process.argv[2] ?? `http://localhost:${process.env.GAME_PORT ?? 3001}`;
// extra wait per step for remote servers: NET_TEST_LATENCY_MS=400 npx tsx scripts/net-test.ts <url>
const LATENCY = Number(process.env.NET_TEST_LATENCY_MS ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms + LATENCY));
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
// rooms hold up to four (for the versus modes); in co-op a third player waits without a seat
const thirdSeat = full.room?.players.find((p) => p.id === full.playerId);
check(full.ok && thirdSeat?.team === null && thirdSeat?.role === null, 'a third player in a co-op room waits without a seat');
third.emit('room:leave');
await sleep(150);
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
// personal style: valid looks are shared, nonsense is ignored
nav.emit('lobby:style', { style: { helmet: 7, suit: 2, skin: 4, face: 3, livery: 5 } });
await sleep(150);
const navStyle = () => room.players.find((p) => p.id === joined.playerId)?.style;
check(navStyle()?.helmet === 7 && navStyle()?.livery === 5, 'a player\'s look is shared with the room');
nav.emit('lobby:style', { style: { helmet: 99, suit: 2, skin: 4, face: 3, livery: 5 } } as never);
await sleep(150);
check(navStyle()?.helmet === 7, 'an invalid look is ignored');

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

// props (hay bales + animals) stream from the driver to the navigator
let propsSeen: Float32Array | null = null;
nav.on('props:state', (b) => (propsSeen = readFloat32(b)));
const herd = new Float32Array([1, 1000, start.x + 3, start.y, start.z - 20, 0, 0, 0, 1]);
driver.emit('props:state', toArrayBuffer(herd));
await sleep(250);
const seen = propsSeen as Float32Array | null;
check(!!seen && seen[1] === 1000 && Math.abs(seen[4] - (start.z - 20)) < 0.01, 'animal poses relayed to the navigator');
const animalCall = once(driver, 'callout');
nav.emit('callout', { id: 'cow' });
check((await animalCall).id === 'cow', 'the navigator can shout COW!');
await sleep(1300); // callouts are spaced out

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

// manual wipers: one cycle per press, relayed to both players, driver only, debounced
let wipeD = 0;
let wipeN = 0;
driver.on('wipers:cycle', () => wipeD++);
nav.on('wipers:cycle', () => wipeN++);
driver.emit('wipers:cycle');
driver.emit('wipers:cycle'); // inside the cooldown: ignored
nav.emit('wipers:cycle'); // the navigator can't flick the stalk
await sleep(350);
check(wipeD === 1 && wipeN === 1, `one wiper cycle per press, shown to both players (driver ${wipeD}, navigator ${wipeN})`);
driver.emit('wipers:cycle');
await sleep(250);
check(wipeD === 2 && wipeN === 2, 'pressing again runs another cycle');

// getting out, pulling on the tow hooks, getting back in
const carQ = new THREE.Quaternion(pose.qx, pose.qy, pose.qz, pose.qw);
const carP = new THREE.Vector3(pose.x, pose.y, pose.z);
const local = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z).applyQuaternion(carQ).add(carP);
let seats = { driver: true, navigator: true };
let seatEvents = 0;
nav.on('seats:state', (s) => {
  seats = s;
  seatEvents++;
});
let relayedCar: Float32Array | null = null;
nav.on('car:state', (b) => (relayedCar = readFloat32(b)));
setPos(pose.x, pose.y, pose.z, 0.5);
buf[CAR.vz] = -10;
driver.emit('car:state', toArrayBuffer(buf));
await sleep(120);
driver.emit('player:exit');
await sleep(250);
check(seatEvents === 0 && seats.driver, 'cannot get out while the car is moving');
buf[CAR.vz] = 0;
buf[CAR.time] = 0.7;
driver.emit('car:state', toArrayBuffer(buf));
await sleep(120);
driver.emit('player:exit');
nav.emit('player:exit');
await sleep(300);
check(!seats.driver && !seats.navigator, 'both players get out once the car has stopped');

// driver on foot: server forces the "driver out" flag and drops a grip on a hook they aren't next to
buf[CAR.time] = 0.8;
buf[CAR.flags] = 0;
const far = local({ x: 0, y: 0, z: 30 });
buf[CAR.footX] = far.x;
buf[CAR.footY] = far.y;
buf[CAR.footZ] = far.z;
buf[CAR.footGrip] = 1;
driver.emit('car:state', toArrayBuffer(buf));
await sleep(150);
const rc = relayedCar as Float32Array | null;
check(!!rc && (rc[CAR.flags] & CAR_FLAG.driverOut) !== 0, 'relayed car state marks the driver as out (server-owned seats)');
check(!!rc && rc[CAR.footGrip] === -1, 'a tow-hook grip from 30 m away is rejected');

// navigator on foot pulling: force clamped to a human-sized pull, only next to a hook
const cabin = new Float32Array(CABIN.LENGTH);
const rear = local(CAR_HOOKS[1]);
const sendCabin = async (fx: number, fz: number, pull: number) => {
  cabin[CABIN.time] += 0.05;
  cabin[CABIN.footX] = fx;
  cabin[CABIN.footY] = rear.y;
  cabin[CABIN.footZ] = fz;
  cabin[CABIN.footGrip] = 1;
  cabin[CABIN.pullZ] = pull;
  cabin[CABIN.heldObject] = -1;
  const got = once(driver, 'cabin:state', 2000).then((b) => readFloat32(b)).catch(() => null);
  nav.emit('cabin:state', toArrayBuffer(cabin));
  return got;
};
const near = await sendCabin(rear.x + 0.3, rear.z + 0.5, 5000);
check(!!near && near[CABIN.footGrip] === 1 && Math.abs(near[CABIN.pullZ] - PULL_FORCE_MAX) < 1, `pull at the rear hook is clamped to ${PULL_FORCE_MAX} N (got ${near?.[CABIN.pullZ]})`);
check(!!near && (near[CABIN.flags] & CABIN_FLAG.navOut) !== 0, 'relayed cabin state marks the navigator as out');
await sleep(120);
const away = await sendCabin(rear.x + 12, rear.z + 12, 1200);
check(!!away && away[CABIN.footGrip] === -1 && away[CABIN.pullZ] === 0, 'no pull force when not standing at a hook');

// back in: only at your own door
const doorN = local(DOOR_EXIT.navigator);
nav.emit('player:enter', { x: doorN.x + 15, y: doorN.y, z: doorN.z });
await sleep(250);
check(!seats.navigator, 'cannot get in from 15 m away');
nav.emit('player:enter', { x: doorN.x, y: doorN.y, z: doorN.z });
const doorD = local(DOOR_EXIT.driver);
driver.emit('player:enter', { x: doorD.x, y: doorD.y, z: doorD.z });
await sleep(300);
check(seats.navigator && seats.driver, 'both climb back in at their own doors');

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

// End-to-end test of the room game modes against a running server
// (start one with a short finish window, e.g.
//   GAME_PORT=3101 FINISH_WINDOW_MS=6000 npx tsx server/index.ts
// then: npx tsx scripts/modes-test.ts http://localhost:3101).
// Scripted cars drive the real stage, so checkpoints, finish order, DNFs and
// results are produced by the server's referees, not faked.

import type { Standings } from '../src/shared/modes';
import type { RaceResults } from '../src/shared/types';
import { loadAll, once, Player, ScriptedCar, sleep, until } from './lib/netbot';

const url = process.argv[2] ?? 'http://localhost:3101';
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};
const seat = (p: Player) => `${p.me?.team ?? '-'}/${p.me?.role ?? '-'}`;

async function room(n: number, names: string[]) {
  const ps = await Promise.all(names.slice(0, n).map((nm) => Player.make(url, nm)));
  const c = await ps[0].create();
  for (const p of ps.slice(1)) await p.join(c.code!);
  await sleep(200);
  return { ps, code: c.code! };
}

// ------------------------------------------------------------------ lobby rules --
{
  const { ps, code } = await room(4, ['Host', 'Bea', 'Cid', 'Dot']);
  const fifth = await Player.make(url, 'Eve');
  const full = await fifth.join(code);
  check(!full.ok && /4 players/.test(full.error ?? ''), `a fifth player is turned away ("${full.error}")`);
  fifth.close();
  check(ps[0].room?.mode === 'coop', 'rooms start in co-op');
  check(ps.filter((p) => p.me?.team === 0).length === 2 && ps.filter((p) => p.me?.team === null).length === 2, `co-op seats two, the others wait (${ps.map(seat).join(' ')})`);
  ps[1].s.emit('lobby:mode', { mode: '2v2' });
  await sleep(150);
  check(ps[0].room?.mode === 'coop', 'only the host can change the mode');
  ps[0].s.emit('lobby:mode', { mode: '2v2' });
  await sleep(200);
  const teams = [0, 1].map((t) => ps.filter((p) => p.me?.team === t));
  check(teams[0].length === 2 && teams[1].length === 2, `2v2 makes two crews of two (${ps.map(seat).join(' ')})`);
  check(teams.every((t) => t.map((p) => p.me!.role).sort().join() === 'driver,navigator'), 'each crew gets a driver and a navigator');
  // move a player: the full crew is refused
  const mover = teams[0][1];
  mover.s.emit('lobby:team', { team: 1 });
  await sleep(150);
  check(mover.me?.team === 0, 'cannot join a crew that is already full');
  // readiness: 3 of 4 ready doesn't start
  for (const p of ps.slice(0, 3)) p.s.emit('lobby:ready', { ready: true });
  await sleep(200);
  check(ps[0].room?.phase === 'lobby', 'three of four ready: still in the lobby');
  ps[0].s.emit('lobby:mode', { mode: '1v1v1' });
  await sleep(200);
  check(ps.filter((p) => p.me?.team !== null).length === 3 && ps.every((p) => !p.me?.ready), `1v1v1 seats three drivers, readiness reset (${ps.map(seat).join(' ')})`);
  check(ps.filter((p) => p.me?.team !== null).every((p) => p.me?.role === 'driver'), 'in 1v1v1 everybody seated drives');
  ps[0].s.emit('lobby:mode', { mode: '1v1v1v1' });
  await sleep(200);
  check(new Set(ps.map((p) => p.me?.team)).size === 4, `1v1v1v1: four cars (${ps.map(seat).join(' ')})`);
  // someone leaves the lobby: seats are re-dealt
  ps[3].s.emit('room:leave');
  await sleep(200);
  check(ps[0].room!.players.length === 3, 'a player leaving the lobby is removed');
  for (const p of ps) p.close();
}

// ------------------------------------------------------------------ 1v1 race ------
{
  const { ps, code } = await room(2, ['Ann', 'Ben']);
  void code;
  const [a, b] = ps;
  a.s.emit('lobby:mode', { mode: '1v1' });
  a.s.emit('lobby:stage', { length: 'short', seed: 4242 });
  await sleep(200);
  check(a.me?.team === 0 && b.me?.team === 1 && a.me?.role === 'driver' && b.me?.role === 'driver', `1v1: two cars, two drivers (${ps.map(seat).join(' ')})`);
  const stage = await loadAll(ps, () => {
    a.s.emit('lobby:ready', { ready: true });
    b.s.emit('lobby:ready', { ready: true });
  });
  await once(a.s, 'game:countdown');
  const carA = new ScriptedCar(a.s, stage, 62);
  const carB = new ScriptedCar(b.s, stage, 48);
  // what does B receive? (its own crew's states must not leak, the other car arrives as race:car)
  let bGotCarState = 0;
  let bOpponent = 0;
  b.s.on('car:state', () => bGotCarState++);
  b.s.on('race:car', (p) => {
    if (p.team === 0) bOpponent++;
  });
  // the AI navigator: tablet grabs from the driver's client count for the passenger seat
  const owner = until(a.s, 'tablet:owner', (p) => p.holder === 'navigator', 3000).then(() => true, () => false);
  a.s.emit('tablet:grab', { held: true });
  carA.start();
  carB.start();
  await once(a.s, 'game:go', 8000);
  carA.go();
  carB.go();
  check(await owner, 'AI-navigator car: the driver\'s client can hold the tablet for the passenger');
  const live = await until(b.s, 'race:standings', (s) => s.entries.some((e) => e.progress > 0.05), 15000);
  check(live.entries.length === 2 && live.entries[0].team === 0, `live standings: the faster car leads (P1 team ${live.entries[0].team}, ${(live.entries[0].progress * 100).toFixed(0)}%)`);
  check(bOpponent > 10 && bGotCarState === 0, `B sees A's car (${bOpponent} race:car) but not A's crew messages (${bGotCarState} car:state)`);
  const aRes = (await once(a.s, 'game:results', 120000)) as RaceResults;
  check(!aRes.dnf && aRes.finalTimeMs > 0, `A finishes (${(aRes.finalTimeMs / 1000).toFixed(1)} s)`);
  const final = (await until(b.s, 'race:standings', (s) => s.final, 120000)) as Standings;
  const bRes = (await once(b.s, 'game:results', 1000).catch(() => null)) as RaceResults | null;
  check(final.entries.map((e) => e.team).join() === '0,1' && final.entries.every((e) => e.finished), `final classification: A first, B second, both finished (${final.entries.map((e) => `P${e.position} ${e.names[0]} ${(e.timeMs / 1000).toFixed(1)}s`).join(', ')})`);
  void bRes;
  check(a.room?.phase === 'finished' || (await until(a.s, 'room:state', (r) => r.phase === 'finished', 3000).then(() => true, () => false)), 'the room is finished once both cars are home');
  carA.stop();
  carB.stop();
  for (const p of ps) p.close();
}

// ------------------------------------------------------------------ 2v2 race ------
{
  const { ps } = await room(4, ['Dri0', 'Nav0', 'Dri1', 'Nav1']);
  ps[0].s.emit('lobby:mode', { mode: '2v2' });
  ps[0].s.emit('lobby:stage', { length: 'short', seed: 777 });
  await sleep(250);
  const drivers = [0, 1].map((t) => ps.find((p) => p.me?.team === t && p.me.role === 'driver')!);
  const navs = [0, 1].map((t) => ps.find((p) => p.me?.team === t && p.me.role === 'navigator')!);
  check(!!drivers[0] && !!drivers[1] && !!navs[0] && !!navs[1], `2v2 crews seated (${ps.map((p) => `${p.name}:${seat(p)}`).join(' ')})`);
  const stage = await loadAll(ps, () => ps.forEach((p) => p.s.emit('lobby:ready', { ready: true })));
  await once(ps[0].s, 'game:countdown');
  const cars = [new ScriptedCar(drivers[0].s, stage, 52), new ScriptedCar(drivers[1].s, stage, 60)];
  let nav0Own = 0;
  let nav0Other = 0;
  let nav1FromTeam0 = 0;
  navs[0].s.on('car:state', () => nav0Own++);
  navs[0].s.on('race:car', (p) => p.team === 1 && nav0Other++);
  navs[1].s.on('race:car', (p) => p.team === 0 && nav1FromTeam0++);
  // callouts stay inside the crew
  let leaked = false;
  drivers[1].s.on('callout', (m) => {
    if (m.id === 'left3' && !m.auto) leaked = true;
  });
  const heard = until(drivers[0].s, 'callout', (m) => m.id === 'left3', 4000).then(() => true, () => false);
  cars.forEach((c) => c.start());
  await once(ps[0].s, 'game:go', 8000);
  cars.forEach((c) => c.go());
  navs[0].s.emit('callout', { id: 'left3' });
  check(await heard, "a navigator's callout reaches their own driver");
  await sleep(1500);
  check(!leaked, "...and not the other crew's driver");
  check(nav0Own > 20 && nav0Other > 10 && nav1FromTeam0 > 10, `navigators get their own car (${nav0Own}) and see the other car (${nav0Other}/${nav1FromTeam0})`);
  const final = (await until(ps[0].s, 'race:standings', (s) => s.final, 150000)) as Standings;
  check(final.entries[0].team === 1 && final.entries[1].team === 0 && final.entries.every((e) => e.finished), `2v2 result: the faster crew wins (${final.entries.map((e) => `P${e.position} ${e.names.join('+')}`).join(', ')})`);
  cars.forEach((c) => c.stop());
  for (const p of ps) p.close();
}

// ------------------------------------------- 1v1v1v1: a car that never arrives -----
{
  const { ps } = await room(4, ['W', 'X', 'Y', 'Z']);
  ps[0].s.emit('lobby:mode', { mode: '1v1v1v1' });
  ps[0].s.emit('lobby:stage', { length: 'short', seed: 99 });
  await sleep(250);
  const stage = await loadAll(ps, () => ps.forEach((p) => p.s.emit('lobby:ready', { ready: true })));
  await once(ps[0].s, 'game:countdown');
  const speeds = [64, 57, 52, 0]; // Z stays on the line
  const cars = ps.map((p, i) => new ScriptedCar(p.s, stage, speeds[i]));
  cars.forEach((c) => c.start());
  await once(ps[0].s, 'game:go', 8000);
  cars.forEach((c) => c.go());
  const zRes = once(ps[3].s, 'game:results', 200000) as Promise<RaceResults>;
  const final = (await until(ps[0].s, 'race:standings', (s) => s.final, 200000)) as Standings;
  const order = final.entries.map((e) => e.names[0]).join('');
  check(order === 'WXYZ', `four cars classified in order W, X, Y, Z (${final.entries.map((e) => `P${e.position} ${e.names[0]}${e.dnf ? ' DNF' : ''}`).join(', ')})`);
  check(final.entries[3].dnf && !final.entries[3].finished, 'the car that never moved is DNF once the finish window closes');
  check(!!(await zRes).dnf, 'the DNF crew gets its own (DNF) results');
  cars.forEach((c) => c.stop());
  for (const p of ps) p.close();
}

// --------------------------------------------- 1v1v1: somebody quits mid-race ------
{
  const { ps } = await room(3, ['Pia', 'Quin', 'Rex']);
  ps[0].s.emit('lobby:mode', { mode: '1v1v1' });
  ps[0].s.emit('lobby:stage', { length: 'short', seed: 31337 });
  await sleep(250);
  const stage = await loadAll(ps, () => ps.forEach((p) => p.s.emit('lobby:ready', { ready: true })));
  await once(ps[0].s, 'game:countdown');
  const cars = ps.map((p, i) => new ScriptedCar(p.s, stage, [60, 55, 50][i]));
  cars.forEach((c) => c.start());
  await once(ps[0].s, 'game:go', 8000);
  cars.forEach((c) => c.go());
  await sleep(3000);
  cars[1].stop();
  ps[1].s.emit('room:leave');
  const after = await until(ps[0].s, 'race:standings', (s) => s.entries.some((e) => e.dnf), 5000).catch(() => null);
  check(!!after && after.entries.find((e) => e.dnf)?.names[0] === 'Quin', 'a player who quits is DNF and the race goes on');
  const final = (await until(ps[0].s, 'race:standings', (s) => s.final, 150000)) as Standings;
  check(final.entries.map((e) => e.names[0]).join() === 'Pia,Rex,Quin', `remaining cars finish (${final.entries.map((e) => `P${e.position} ${e.names[0]}${e.dnf ? ' DNF' : ''}`).join(', ')})`);
  cars.forEach((c) => c.stop());
  for (const p of ps) p.close();
}

console.log(failures ? `${failures} MODE CHECK(S) FAILED` : 'ALL MODE CHECKS PASSED');
process.exit(failures ? 1 : 0);

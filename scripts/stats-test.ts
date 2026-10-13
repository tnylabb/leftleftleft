// Player statistics, end to end: starts the real server (embedded Postgres in
// a temp folder), plays real races with scripted cars, reads the profiles over
// HTTP, kills and restarts the server, and checks:
//  - stats survive a server restart (hard kill)
//  - "Balint" / "balint" / "  BALINT " are one profile
//  - a race is recorded exactly once (also when recorded twice on purpose)
//  - co-op races count as races, not as wins or losses
//  - name protection: recovery code shown once, stored hashed, required to
//    collect stats under a protected name and to rotate the code
//  - invalid requests are refused; there is no way to post results
// Run: npx tsx scripts/stats-test.ts
// (STATS_TEST_DATABASE_URL=postgres://... runs the same test against a real Postgres server.)

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StatsStore, type ProfileStats } from '../server/stats/StatsStore';
import type { RaceSummary } from '../server/rooms/Room';
import { loadAll, once, Player, ScriptedCar, sleep, until } from './lib/netbot';

const PORT = 3102;
const url = `http://localhost:${PORT}`;
const dbDir = mkdtempSync(path.join(tmpdir(), 'lll-stats-'));
const pgUrl = process.env.STATS_TEST_DATABASE_URL ?? '';
console.log(pgUrl ? 'database: Postgres over the network (pg driver)' : 'database: embedded Postgres (PGlite) in a temp folder');
let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

let server: ChildProcess | null = null;
async function startServer() {
  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, GAME_PORT: String(PORT), STATS_DB_DIR: dbDir, FINISH_WINDOW_MS: '5000', DATABASE_URL: pgUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout!.on('data', (d) => (log += d));
  server.stderr!.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`server did not start:\n${log}`);
}
async function killServer() {
  if (!server) return;
  const done = new Promise((r) => server!.once('exit', r));
  server.kill('SIGKILL'); // a crash, not a polite shutdown
  await done;
  server = null;
}

const profile = async (name: string): Promise<{ status: number; body: { exists?: boolean; profile?: ProfileStats; error?: string } }> => {
  const r = await fetch(`${url}/api/profile?name=${encodeURIComponent(name)}`);
  return { status: r.status, body: await r.json() };
};
const post = async (p: string, body: unknown) => {
  const r = await fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let json: Record<string, unknown> = {};
  try {
    json = await r.json();
  } catch {
    /* not json */
  }
  return { status: r.status, body: json };
};

/** Plays one race to the end. speeds[i] = player i's car (0 = navigator / no car). */
async function race(mode: 'coop' | '1v1', names: string[], speeds: number[], codes: (string | undefined)[] = []) {
  const ps = await Promise.all(names.map((n) => Player.make(url, n)));
  const c = await ps[0].create(codes[0] ? { profileCode: codes[0] } : {});
  for (let i = 1; i < ps.length; i++) await ps[i].join(c.code!, codes[i] ? { profileCode: codes[i] } : {});
  ps[0].s.emit('lobby:mode', { mode });
  ps[0].s.emit('lobby:stage', { length: 'short', seed: 2024 });
  await sleep(250);
  const stage = await loadAll(ps, () => ps.forEach((p) => p.s.emit('lobby:ready', { ready: true })));
  await once(ps[0].s, 'game:countdown');
  const cars = ps.map((p, i) => (p.me?.role === 'driver' ? new ScriptedCar(p.s, stage, speeds[i]) : null));
  cars.forEach((car) => car?.start());
  await once(ps[0].s, 'game:go', 8000);
  cars.forEach((car) => car?.go());
  await until(ps[0].s, 'room:state', (r) => r.phase === 'finished', 120000);
  cars.forEach((car) => car?.stop());
  await sleep(600); // the server writes the result
  for (const p of ps) p.close();
}

try {
  await startServer();

  // --- a 1v1 race between Balint and Zoe ---------------------------------------------
  await race('1v1', ['Balint', '  zoe   '], [62, 50]);
  const a = await profile('BALINT');
  const b = await profile('balint');
  const c = await profile('  Balint ');
  check(a.status === 200 && !!a.body.profile, 'the winner has a profile after the race');
  check(JSON.stringify(a.body) === JSON.stringify(b.body) && JSON.stringify(b.body) === JSON.stringify(c.body), '"BALINT", "balint" and "  Balint " load the same profile');
  const bt = a.body.profile!.totals;
  check(bt.races === 1 && bt.completed === 1 && bt.wins === 1 && bt.losses === 0, `Balint: 1 race, 1 win (${JSON.stringify(bt)})`);
  const z = (await profile('ZOE')).body.profile!;
  check(z.name === 'zoe' && z.totals.wins === 0 && z.totals.losses === 1 && z.totals.races === 1, `zoe: 1 race, 1 loss, name kept as typed ("${z.name}")`);
  check(bt.bestMs !== null && bt.bestMs! > 0 && bt.distanceKm > 0.5 && bt.preferredRole === 'driver', `times and distance recorded (best ${(bt.bestMs! / 1000).toFixed(1)} s, ${bt.distanceKm.toFixed(2)} km)`);
  check(a.body.profile!.byStage.length === 1 && a.body.profile!.byStage[0].difficulty === 'standard', 'performance by map / difficulty is listed');
  check(!JSON.stringify(a.body).includes('hash'), 'the public profile has no secret fields');
  const none = await profile('Nobody Here');
  check(none.status === 404 && none.body.exists === false, 'an unknown name has no profile (404)');

  // --- persistence across a crash + restart -------------------------------------------
  await killServer();
  await startServer();
  const after = (await profile('Balint')).body.profile!;
  check(after.totals.races === 1 && after.totals.wins === 1, 'statistics survive the server being killed and restarted');

  // --- co-op: a race, not a win or a loss ----------------------------------------------
  await race('coop', ['balint', 'Zoe'], [60, 0]);
  const co = (await profile('Balint')).body.profile!;
  const zc = (await profile('zoe')).body.profile!;
  check(co.totals.races === 2 && co.totals.wins === 1 && co.totals.losses === 0, `co-op counts as a race for Balint (races ${co.totals.races}, wins ${co.totals.wins})`);
  check(zc.totals.races === 2 && zc.byRole.some((r) => r.role === 'navigator' && r.races === 1), "co-op navigator's race is stored under the navigator role");
  check(co.recent[0].mode === 'coop' && co.recent[0].crew.toLowerCase().includes('zoe'), `recent results show the crew ("${co.recent[0].crew}")`);

  // --- name protection ---------------------------------------------------------------------
  const p1 = await post('/api/profile/protect', { name: 'balint' });
  const code = String(p1.body.code ?? '');
  check(p1.status === 200 && /^LLL-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), `protecting a name returns a recovery code (${code})`);
  const p2 = await post('/api/profile/protect', { name: 'BALINT' });
  check(p2.status === 403, 'someone else cannot re-protect (take over) a protected name');
  const v1 = await post('/api/profile/verify', { name: 'Balint', code: 'LLL-AAAA-BBBB' });
  const v2 = await post('/api/profile/verify', { name: 'Balint', code: code.toLowerCase() });
  check(v1.body.ok === false && v2.body.ok === true, 'a wrong code is refused, the right one accepted (any case)');
  // an impostor races as "Balint" without the code: nothing is added to Balint
  await race('1v1', ['Balint', 'Zoe'], [64, 50]);
  const imp = (await profile('balint')).body.profile!;
  check(imp.totals.races === 2 && imp.protected, `a protected profile ignores races without its code (still ${imp.totals.races} races)`);
  // with the code it counts
  await race('1v1', ['Balint', 'Zoe'], [64, 50], [code]);
  const own = (await profile('balint')).body.profile!;
  check(own.totals.races === 3 && own.totals.wins === 2, `with the recovery code the race counts (races ${own.totals.races}, wins ${own.totals.wins})`);
  const rot = await post('/api/profile/protect', { name: 'Balint', code });
  check(rot.status === 200 && rot.body.code !== code, 'the owner can rotate the code');

  // --- invalid requests ---------------------------------------------------------------------
  check((await fetch(`${url}/api/profile`)).status === 400, 'profile without a name: 400');
  check((await post('/api/profile/protect', { name: 'x'.repeat(200) })).status === 400, 'oversized name: 400');
  check((await post('/api/profile/protect', { name: 42 })).status === 400, 'non-string name: 400');
  const fake = await post('/api/results', { name: 'Balint', wins: 999 });
  check(fake.status === 404 && (await profile('balint')).body.profile!.totals.wins === 2, 'there is no endpoint to post results (fake wins go nowhere)');
  await killServer();

  // --- exactly once: the same race recorded twice ----------------------------------------
  process.env.STATS_DB_DIR = dbDir;
  process.env.DATABASE_URL = pgUrl;
  const store = await StatsStore.open();
  const summary: RaceSummary = {
    raceId: 'test-race-1',
    mode: '1v1',
    stage: { seed: 1, length: 'short', night: false, map: 'mountain', difficulty: 'hard' },
    teams: [0, 1].map((t) => ({
      team: t,
      position: t + 1,
      finished: true,
      results: { timeMs: 90000 + t, finalTimeMs: 90000 + t, progress: 1, distanceDriven: 1500, checkpointsHit: 2, checkpointsTotal: 2, missedCheckpoints: 0, crashes: 1, missedTurns: 0, tabletDrops: 0, resets: 0, penaltiesMs: 0, topSpeed: 30, wrongWay: false, avgSpeed: 16, stageLength: 1500, grade: 'B', title: '', seed: 1 },
      members: [{ name: t ? 'Mia' : 'Noor', role: 'driver' as const, profileCode: null }],
    })),
  };
  const first = await store.recordRace(summary);
  const again = await store.recordRace(summary);
  check(first.recorded === 2 && again.recorded === 0, `recording the same race twice adds it once (${first.recorded}, then ${again.recorded})`);
  const mia = (await store.profile('MIA'))!;
  check(mia.totals.races === 1 && mia.byStage[0].map === 'mountain' && mia.byStage[0].difficulty === 'hard', 'per-map / per-difficulty stats from a mountain HARD race');
  await store.close();
} finally {
  await killServer();
  rmSync(dbDir, { recursive: true, force: true });
}
console.log(failures ? `${failures} STATS CHECK(S) FAILED` : 'ALL STATS CHECKS PASSED');
process.exit(failures ? 1 : 0);

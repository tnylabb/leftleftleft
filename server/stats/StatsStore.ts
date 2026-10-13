// Player profiles and race statistics, kept in Postgres.
//
// Storage: DATABASE_URL (any hosted Postgres, e.g. Neon / Supabase / Render)
// when set; otherwise an embedded Postgres (PGlite) in a local folder
// (STATS_DB_DIR, default ./.data/stats) - fine for development and for hosts
// with a persistent disk. Nothing lives only in memory.
//
// Identity is the player's name, matched case-insensitively with whitespace
// normalised. That is a convenience, not authentication: anyone can type the
// same name. A player can protect their name with a recovery code (stored
// only as a salted scrypt hash); a protected profile only collects results
// from players who present the code, and the code moves the profile to
// another browser.
//
// Results are written by the server only, from its own race referees, when a
// race reaches a valid end - there is no endpoint for clients to submit
// results. Every (race, profile) pair is stored once (unique constraint), so a
// finish that fires twice can't count twice.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { RaceSummary } from '../rooms/Room';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
  readonly kind: 'postgres' | 'pglite';
}

export async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import('pg');
    const noVerify = process.env.DATABASE_SSL === 'no-verify';
    const pool = new pg.Pool({ connectionString: url, max: 4, ssl: noVerify ? { rejectUnauthorized: false } : undefined });
    return {
      kind: 'postgres',
      query: async (sql, params) => pool.query(sql, params as unknown[]) as never,
      close: () => pool.end(),
    };
  }
  // Render (free plan) has no persistent disk and only 512 MB: an embedded database there would
  // be wiped on every deploy and its first start alone needs ~350 MB. Stats stay off until
  // DATABASE_URL is set (or STATS_DB_DIR points at a persistent disk).
  if (process.env.RENDER && !process.env.STATS_DB_DIR) {
    throw new Error('DATABASE_URL is not set - player statistics are off (set it to a Postgres connection string)');
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.STATS_DB_DIR || path.resolve(process.cwd(), '.data', 'stats');
  mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir);
  return {
    kind: 'pglite',
    query: async (sql, params) => db.query(sql, params as unknown[]) as never,
    close: () => db.close(),
  };
}

const SCHEMA = [
  `create table if not exists profiles (
     id serial primary key,
     name_key text not null unique,
     display_name text not null,
     code_hash text,
     created_at timestamptz not null default now(),
     last_seen timestamptz not null default now()
   )`,
  `create table if not exists race_entries (
     id serial primary key,
     race_id text not null,
     profile_id integer not null references profiles(id) on delete cascade,
     mode text not null,
     map text not null,
     difficulty text not null,
     length text not null,
     night boolean not null,
     role text not null,
     team integer not null,
     teams integer not null,
     position integer not null,
     crew text not null,
     finished boolean not null,
     won boolean,
     time_ms integer,
     crashes integer not null,
     missed_turns integer not null,
     resets integer not null,
     distance real not null,
     created_at timestamptz not null default now(),
     unique (race_id, profile_id)
   )`,
  `create index if not exists race_entries_profile on race_entries (profile_id, created_at desc)`,
];

/** "  BaLint   Kovacs " -> display "BaLint Kovacs", key "balint kovacs". */
export function normalizeName(raw: string): { display: string; key: string } | null {
  const display = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!display) return null;
  return { display, key: display.toLocaleLowerCase('en') };
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(): string {
  const b = randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return `LLL-${s.slice(0, 4)}-${s.slice(4)}`;
}
function hashCode(code: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(code.toUpperCase(), salt, 32).toString('hex')}`;
}
function codeMatches(code: string | null | undefined, stored: string): boolean {
  if (!code) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = scryptSync(code.trim().toUpperCase(), Buffer.from(salt, 'hex'), 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ProfileRow {
  id: number;
  name_key: string;
  display_name: string;
  code_hash: string | null;
}

export interface ProfileStats {
  name: string;
  protected: boolean;
  totals: {
    races: number;
    completed: number;
    wins: number;
    losses: number;
    versusRaces: number;
    winRate: number | null;
    crashes: number;
    missedTurns: number;
    bestMs: number | null;
    avgMs: number | null;
    distanceKm: number;
    recoveries: number;
    preferredRole: 'driver' | 'navigator' | null;
  };
  byRole: { role: string; races: number; completed: number; wins: number; bestMs: number | null; avgMs: number | null }[];
  byStage: { map: string; difficulty: string; length: string; races: number; completed: number; wins: number; bestMs: number | null }[];
  recent: { at: string; mode: string; map: string; difficulty: string; length: string; role: string; crew: string; position: number; teams: number; finished: boolean; won: boolean | null; timeMs: number | null }[];
}

export class StatsStore {
  private constructor(private db: Db) {}

  static async open(): Promise<StatsStore> {
    const db = await openDb();
    for (const sql of SCHEMA) await db.query(sql);
    return new StatsStore(db);
  }

  get kind() {
    return this.db.kind;
  }

  close() {
    return this.db.close();
  }

  private async find(key: string): Promise<ProfileRow | null> {
    const r = await this.db.query<ProfileRow>('select id, name_key, display_name, code_hash from profiles where name_key = $1', [key]);
    return r.rows[0] ?? null;
  }

  /** Existing profile (never overwritten) or a new one. */
  private async findOrCreate(name: string): Promise<ProfileRow | null> {
    const n = normalizeName(name);
    if (!n) return null;
    await this.db.query('insert into profiles (name_key, display_name) values ($1, $2) on conflict (name_key) do nothing', [n.key, n.display]);
    await this.db.query('update profiles set last_seen = now() where name_key = $1', [n.key]);
    return this.find(n.key);
  }

  /**
   * Records a finished race for every human in it. Protected profiles only
   * count when the player presented the right recovery code. Safe to call
   * twice for the same race (nothing is added the second time).
   */
  async recordRace(s: RaceSummary): Promise<{ recorded: number; skipped: number }> {
    let recorded = 0;
    let skipped = 0;
    const versus = s.teams.length > 1;
    for (const t of s.teams) {
      const crew = t.members.map((m) => m.name).join(' + ');
      for (const m of t.members) {
        const p = await this.findOrCreate(m.name);
        if (!p || (p.code_hash && !codeMatches(m.profileCode, p.code_hash))) {
          skipped++;
          continue;
        }
        const r = t.results;
        const res = await this.db.query(
          `insert into race_entries
             (race_id, profile_id, mode, map, difficulty, length, night, role, team, teams, position, crew,
              finished, won, time_ms, crashes, missed_turns, resets, distance)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           on conflict (race_id, profile_id) do nothing
           returning id`,
          [
            s.raceId, p.id, s.mode, s.stage.map, s.stage.difficulty ?? 'standard', s.stage.length, !!s.stage.night,
            m.role, t.team, s.teams.length, t.position, crew,
            t.finished, versus ? t.finished && t.position === 1 : null,
            t.finished ? Math.round(r.finalTimeMs) : null,
            r.crashes | 0, r.missedTurns | 0, r.resets | 0, Math.max(0, r.distanceDriven || 0),
          ],
        );
        if (res.rows.length) recorded++;
        else skipped++;
      }
    }
    return { recorded, skipped };
  }

  /** Public statistics for a name (null = no such profile). Never includes the recovery code. */
  async profile(name: string): Promise<ProfileStats | null> {
    const n = normalizeName(name);
    if (!n) return null;
    const p = await this.find(n.key);
    if (!p) return null;
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const t = (
      await this.db.query<Record<string, unknown>>(
        `select count(*)::int races,
                count(*) filter (where finished)::int completed,
                count(*) filter (where won is true)::int wins,
                count(*) filter (where won is false)::int losses,
                count(*) filter (where won is not null)::int versus_races,
                coalesce(sum(crashes), 0)::int crashes,
                coalesce(sum(missed_turns), 0)::int missed_turns,
                min(time_ms) filter (where finished) best_ms,
                avg(time_ms) filter (where finished)::float8 avg_ms,
                coalesce(sum(distance), 0)::float8 distance,
                coalesce(sum(resets), 0)::int recoveries,
                count(*) filter (where role = 'driver')::int driver_races,
                count(*) filter (where role = 'navigator')::int nav_races
           from race_entries where profile_id = $1`,
        [p.id],
      )
    ).rows[0];
    const byRole = (
      await this.db.query<Record<string, unknown>>(
        `select role, count(*)::int races, count(*) filter (where finished)::int completed,
                count(*) filter (where won is true)::int wins,
                min(time_ms) filter (where finished) best_ms, avg(time_ms) filter (where finished)::float8 avg_ms
           from race_entries where profile_id = $1 group by role order by role`,
        [p.id],
      )
    ).rows;
    const byStage = (
      await this.db.query<Record<string, unknown>>(
        `select map, difficulty, length, count(*)::int races, count(*) filter (where finished)::int completed,
                count(*) filter (where won is true)::int wins, min(time_ms) filter (where finished) best_ms
           from race_entries where profile_id = $1 group by map, difficulty, length order by map, difficulty, length`,
        [p.id],
      )
    ).rows;
    const recent = (
      await this.db.query<Record<string, unknown>>(
        `select created_at, mode, map, difficulty, length, role, crew, position, teams, finished, won, time_ms
           from race_entries where profile_id = $1 order by created_at desc, id desc limit 10`,
        [p.id],
      )
    ).rows;
    const versusRaces = Number(t.versus_races);
    const driver = Number(t.driver_races);
    const nav = Number(t.nav_races);
    return {
      name: p.display_name,
      protected: !!p.code_hash,
      totals: {
        races: Number(t.races),
        completed: Number(t.completed),
        wins: Number(t.wins),
        losses: Number(t.losses),
        versusRaces,
        winRate: versusRaces ? Number(t.wins) / versusRaces : null,
        crashes: Number(t.crashes),
        missedTurns: Number(t.missed_turns),
        bestMs: num(t.best_ms),
        avgMs: num(t.avg_ms),
        distanceKm: Number(t.distance) / 1000,
        recoveries: Number(t.recoveries),
        preferredRole: driver + nav === 0 ? null : driver >= nav ? 'driver' : 'navigator',
      },
      byRole: byRole.map((r) => ({ role: String(r.role), races: Number(r.races), completed: Number(r.completed), wins: Number(r.wins), bestMs: num(r.best_ms), avgMs: num(r.avg_ms) })),
      byStage: byStage.map((r) => ({ map: String(r.map), difficulty: String(r.difficulty), length: String(r.length), races: Number(r.races), completed: Number(r.completed), wins: Number(r.wins), bestMs: num(r.best_ms) })),
      recent: recent.map((r) => ({
        at: new Date(r.created_at as string).toISOString(),
        mode: String(r.mode),
        map: String(r.map),
        difficulty: String(r.difficulty),
        length: String(r.length),
        role: String(r.role),
        crew: String(r.crew),
        position: Number(r.position),
        teams: Number(r.teams),
        finished: !!r.finished,
        won: r.won === null ? null : !!r.won,
        timeMs: num(r.time_ms),
      })),
    };
  }

  /**
   * Protects a name with a recovery code (creating the profile if needed).
   * Unprotected: returns a new code. Protected: only with the current code
   * (then a fresh code replaces it). The code is shown once and only stored hashed.
   */
  async protect(name: string, currentCode?: string): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
    const p = await this.findOrCreate(name);
    if (!p) return { ok: false, error: 'Enter a name first' };
    if (p.code_hash && !codeMatches(currentCode, p.code_hash)) return { ok: false, error: 'This name is already protected - enter its recovery code' };
    const code = newCode();
    await this.db.query('update profiles set code_hash = $2 where id = $1', [p.id, hashCode(code)]);
    return { ok: true, code };
  }

  /** Does this recovery code unlock this name? (Unprotected names need none.) */
  async verify(name: string, code?: string): Promise<{ exists: boolean; protected: boolean; ok: boolean }> {
    const n = normalizeName(name);
    if (!n) return { exists: false, protected: false, ok: false };
    const p = await this.find(n.key);
    if (!p) return { exists: false, protected: false, ok: true };
    if (!p.code_hash) return { exists: true, protected: false, ok: true };
    return { exists: true, protected: true, ok: codeMatches(code, p.code_hash) };
  }
}

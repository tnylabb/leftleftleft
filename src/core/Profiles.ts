// Client side of player profiles: talks to the server's /api/profile
// endpoints and remembers recovery codes for protected names in this browser.
// Stats are recorded by the server from online races only; this module can
// only read them (there is no way to submit results).

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

const KEY = 'lll.profileCodes.v1';
const nameKey = (name: string) => name.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');

export function apiBase(): string {
  return ((import.meta.env.VITE_SERVER_URL as string | undefined) || '').replace(/\/+$/, '');
}

function readCodes(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** The recovery code saved in this browser for a name (if any). */
export function savedCode(name: string): string | null {
  return readCodes()[nameKey(name)] ?? null;
}

export function saveCode(name: string, code: string | null) {
  const all = readCodes();
  if (code) all[nameKey(name)] = code;
  else delete all[nameKey(name)];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
}

export async function fetchProfile(name: string): Promise<{ ok: true; profile: ProfileStats | null } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${apiBase()}/api/profile?name=${encodeURIComponent(name)}`, { cache: 'no-store' });
    if (r.status === 404) return { ok: true, profile: null };
    const body = (await r.json()) as { profile?: ProfileStats; error?: string };
    if (!r.ok || !body.profile) return { ok: false, error: body.error ?? `Server error (${r.status})` };
    return { ok: true, profile: body.profile };
  } catch {
    return { ok: false, error: 'Could not reach the game server' };
  }
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const r = await fetch(`${apiBase()}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { status: 0, body: { error: 'Could not reach the game server' } };
  }
}

/** Protect (or, with the current code, re-key) a name. Returns the new code. */
export async function protectName(name: string, current?: string): Promise<{ code: string } | { error: string }> {
  const r = await post('/api/profile/protect', { name, code: current });
  if (r.status === 200 && typeof r.body.code === 'string') {
    saveCode(name, r.body.code);
    return { code: r.body.code };
  }
  return { error: String(r.body.error ?? 'Could not protect the name') };
}

/** Checks a recovery code and saves it in this browser when it is right. */
export async function unlockName(name: string, code: string): Promise<boolean> {
  const r = await post('/api/profile/verify', { name, code });
  if (r.body.ok === true && r.body.protected === true) {
    saveCode(name, code.trim().toUpperCase());
    return true;
  }
  return false;
}

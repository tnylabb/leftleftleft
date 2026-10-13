// Room game modes. CO-OP is the original two-player game (one car, driver +
// navigator). The versus modes put several cars on the same stage at once:
// in 1v1 / 1v1v1 / 1v1v1v1 every player drives their own car with an AI
// navigator holding the tablet; in 2v2 two crews (driver + human navigator)
// race each other. Cars don't collide (rally "ghost" rules); positions are
// decided by stage time including penalties.

import type { Role } from './types';

export type RoomMode = 'coop' | '1v1' | '1v1v1' | '1v1v1v1' | '2v2';
export const ROOM_MODES: RoomMode[] = ['coop', '1v1', '1v1v1', '1v1v1v1', '2v2'];

export interface ModeSpec {
  label: string;
  blurb: string;
  /** Players needed to start. */
  players: number;
  /** Cars (teams) on the stage. */
  teams: number;
  /** People per car: 1 = driver + AI navigator, 2 = driver + human navigator. */
  crew: 1 | 2;
  /** Several cars racing for positions. */
  versus: boolean;
}

export const MODE_SPEC: Record<RoomMode, ModeSpec> = {
  coop: { label: 'CO-OP', blurb: 'One car: a driver and a navigator together.', players: 2, teams: 1, crew: 2, versus: false },
  '1v1': { label: '1 v 1', blurb: 'Two cars. Each driver gets an AI navigator.', players: 2, teams: 2, crew: 1, versus: true },
  '1v1v1': { label: '1 v 1 v 1', blurb: 'Three cars, three drivers, three AI navigators.', players: 3, teams: 3, crew: 1, versus: true },
  '1v1v1v1': { label: '1 v 1 v 1 v 1', blurb: 'Four cars, every driver for themselves.', players: 4, teams: 4, crew: 1, versus: true },
  '2v2': { label: '2 v 2', blurb: 'Two crews: driver + navigator against driver + navigator.', players: 4, teams: 2, crew: 2, versus: true },
};

export const MAX_ROOM_PLAYERS = 4;

export function isRoomMode(v: unknown): v is RoomMode {
  return typeof v === 'string' && (ROOM_MODES as string[]).includes(v);
}

/** Modes on offer for this many players in the room (1 = still waiting: the two-player modes). */
export function modesFor(players: number): RoomMode[] {
  const n = Math.max(2, Math.min(MAX_ROOM_PLAYERS, players));
  return ROOM_MODES.filter((m) => MODE_SPEC[m].players === n);
}

/**
 * The mode to switch to when the player count changes: the host's choice when it
 * still fits, else the one closest to it (same crew size: co-op grows into 2v2,
 * 1v1 into 1v1v1 and 1v1v1v1).
 */
export function fitMode(preferred: RoomMode, players: number): RoomMode {
  const fits = modesFor(players);
  if (fits.includes(preferred)) return preferred;
  return fits.find((m) => MODE_SPEC[m].crew === MODE_SPEC[preferred].crew) ?? fits[0];
}

/** Team colours (name tags, standings, map markers). */
export const TEAM_COLORS = ['#e8742b', '#3a7fd0', '#5cbf6b', '#d6c13a'];
export const TEAM_NAMES = ['ORANGE', 'BLUE', 'GREEN', 'YELLOW'];

/** One line of the live / final race standings. */
export interface StandingEntry {
  team: number;
  /** Crew names (driver first). */
  names: string[];
  /** 0..1 along the stage. */
  progress: number;
  finished: boolean;
  /** Didn't finish (left the race or ran out of time after the winner). */
  dnf: boolean;
  /** Final time incl. penalties when finished, else the running stage time. */
  timeMs: number;
  penaltiesMs: number;
  crashes: number;
  missedTurns: number;
  /** 1-based. */
  position: number;
}

export interface Standings {
  mode: RoomMode;
  final: boolean;
  /** When the remaining cars are timed out (server ms), once the first car is home. */
  closesAt: number | null;
  entries: StandingEntry[];
}

/** Orders cars: finished by time, then still running by progress, then DNFs. */
export function rankStandings(entries: Omit<StandingEntry, 'position'>[]): StandingEntry[] {
  const sorted = [...entries].sort((a, b) => {
    const ra = a.dnf ? 2 : a.finished ? 0 : 1;
    const rb = b.dnf ? 2 : b.finished ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (ra === 0) return a.timeMs - b.timeMs;
    return b.progress - a.progress;
  });
  return sorted.map((e, i) => ({ ...e, position: i + 1 }));
}

/** Roles a team needs. */
export function crewRoles(mode: RoomMode): Role[] {
  return MODE_SPEC[mode].crew === 2 ? ['driver', 'navigator'] : ['driver'];
}

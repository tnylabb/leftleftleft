import { randomBytes, randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { GameAuthority, type AuthorityOutput } from '../../src/shared/authority/GameAuthority';
import { COUNTDOWN_MS, LOAD_TIMEOUT_MS, type StageLength } from '../../src/shared/constants';
import type { Difficulty } from '../../src/shared/difficulty';
import { MAX_ROOM_PLAYERS, MODE_SPEC, rankStandings, type RoomMode, type StandingEntry, type Standings } from '../../src/shared/modes';
import type { ClientToServerEvents, ImpactReport, MudReport, ServerToClientEvents } from '../../src/shared/protocol';
import { toArrayBuffer } from '../../src/shared/snapshot';
import { generateStage } from '../../src/shared/stage/StageGenerator';
import { DEFAULT_STYLE, sameStyle, type PlayerStyle } from '../../src/shared/style';
import type { CalloutId, DoorSide, PlayerInfo, RaceResults, Role, RoomPhase, RoomSnapshot, StageData, StageMap, StageParams } from '../../src/shared/types';
import type { GameServer } from './RoomManager';

export type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export interface PlayerSlot {
  id: string;
  token: string;
  name: string;
  role: Role | null;
  /** Car / crew number (null = no seat in the current mode). */
  team: number | null;
  ready: boolean;
  socket: GameSocket | null;
  loaded: boolean;
  isHost: boolean;
  style: PlayerStyle;
  voice: boolean;
  graceTimer: NodeJS.Timeout | null;
  /** Recovery code presented for a protected stats profile (see StatsStore). */
  profileCode: string | null;
}

/** One car on the stage: its crew and its own referee. */
interface TeamRun {
  id: number;
  channel: string;
  authority: GameAuthority;
  members: { slot: PlayerSlot; role: Role }[];
  /** No human navigator: the driver's client runs the AI navigator and the cabin. */
  aiNav: boolean;
  result: RaceResults | null;
  dnf: boolean;
  relayCount: number;
}

/** Everything the stats store needs when a race reaches a valid end. */
export interface RaceSummary {
  raceId: string;
  mode: RoomMode;
  stage: StageParams;
  teams: {
    team: number;
    position: number;
    finished: boolean;
    results: RaceResults;
    members: { name: string; role: Role; profileCode: string | null }[];
  }[];
}

const randomSeed = () => (Math.random() * 0xffffffff) >>> 0;
/** Versus: once the first car is home, the others get this long to finish. */
export const FINISH_WINDOW_MS = Number(process.env.FINISH_WINDOW_MS ?? 60000);

export class Room {
  readonly players: PlayerSlot[] = [];
  mode: RoomMode = 'coop';
  phase: RoomPhase = 'lobby';
  stage: StageParams = { seed: randomSeed(), length: 'medium', night: false, map: 'countryside', difficulty: 'standard' };
  private stageData: StageData | null = null;
  private teams: TeamRun[] = [];
  private raceId = '';
  private raceRecorded = false;
  private countdownEndsAt: number | null = null;
  private raceStartedAt: number | null = null;
  private closesAt: number | null = null;
  private restartVotes: Record<string, 'retry' | 'new'> = {};
  private timers: NodeJS.Timeout[] = [];
  private tickTimer: NodeJS.Timeout | null = null;
  private loadTimer: NodeJS.Timeout | null = null;
  private lastStandingsAt = 0;
  /** Called once per race that reaches a valid end (stats). */
  onRaceComplete: ((summary: RaceSummary) => void) | null = null;

  constructor(
    readonly code: string,
    private io: GameServer,
    private graceMs: number,
    private onEmpty: () => void,
  ) {}

  get isEmpty(): boolean {
    return this.players.length === 0;
  }

  private get spec() {
    return MODE_SPEC[this.mode];
  }

  private get channel() {
    return this.io.to(this.code);
  }

  private teamChannel(team: number) {
    return `${this.code}#${team}`;
  }

  // --- membership ------------------------------------------------------------

  addPlayer(name: string, profileCode: string | null = null): PlayerSlot | null {
    if (this.players.length >= MAX_ROOM_PLAYERS || this.phase !== 'lobby') return null;
    const slot: PlayerSlot = {
      id: randomUUID(),
      token: randomBytes(16).toString('hex'),
      name,
      role: null,
      team: null,
      ready: false,
      socket: null,
      loaded: false,
      isHost: this.players.length === 0,
      style: { ...DEFAULT_STYLE },
      voice: false,
      graceTimer: null,
      profileCode,
    };
    this.players.push(slot);
    this.normalizeSeats();
    return slot;
  }

  findForReconnect(playerId: string, token: string): PlayerSlot | null {
    const slot = this.players.find((p) => p.id === playerId);
    if (!slot || slot.token !== token) return null;
    return slot;
  }

  attach(slot: PlayerSlot, socket: GameSocket) {
    const wasDisconnected = !slot.socket || slot.socket.id !== socket.id;
    if (slot.socket && slot.socket.id !== socket.id) {
      slot.socket.emit('room:kicked', 'Signed in from another tab');
      slot.socket.leave(this.code);
      for (const t of this.teams) slot.socket.leave(t.channel);
      slot.socket.data.roomCode = null;
    }
    if (slot.graceTimer) {
      clearTimeout(slot.graceTimer);
      slot.graceTimer = null;
    }
    slot.socket = socket;
    socket.data.roomCode = this.code;
    socket.data.playerId = slot.id;
    socket.join(this.code);
    const run = this.runOf(slot);
    if (this.phase !== 'lobby' && run) socket.join(run.channel);
    if (wasDisconnected && this.phase !== 'lobby') slot.loaded = false;
    this.broadcastState();
    this.notifyVoicePeers();
  }

  /** Call after the join ack: a (re)connecting player rebuilds the running stage. */
  resyncAfterJoin(slot: PlayerSlot) {
    if (this.phase === 'lobby' || slot.loaded || !slot.socket) return;
    slot.socket.emit('game:load', { ...this.stage });
  }

  detach(slot: PlayerSlot, voluntary: boolean) {
    if (slot.socket) {
      slot.socket.leave(this.code);
      for (const t of this.teams) slot.socket.leave(t.channel);
      slot.socket.data.roomCode = null;
    }
    slot.socket = null;
    slot.voice = false;
    if (voluntary) {
      this.removePlayer(slot);
      return;
    }
    if (this.phase === 'countdown' || this.phase === 'racing') {
      for (const t of this.teams) t.authority.pause();
      this.channel.emit('game:paused', { paused: true, reason: `${slot.name} disconnected - waiting for them to reconnect` });
    }
    slot.graceTimer = setTimeout(() => this.removePlayer(slot), this.graceMs);
    this.broadcastState();
    this.notifyVoicePeers();
  }

  private removePlayer(slot: PlayerSlot) {
    if (slot.graceTimer) clearTimeout(slot.graceTimer);
    const idx = this.players.indexOf(slot);
    if (idx >= 0) this.players.splice(idx, 1);
    if (this.players.length === 0) {
      this.onEmpty();
      return;
    }
    if (!this.players.some((p) => p.isHost)) this.players[0].isHost = true;
    if (this.phase === 'lobby') {
      this.normalizeSeats();
      this.broadcastState();
    } else if (!this.spec.versus || this.phase === 'loading') {
      this.toLobby(`${slot.name} left the session`);
    } else {
      // versus: their car is out of the race, everybody else carries on
      const run = this.runOf(slot);
      if (run && !run.result && !run.dnf) {
        run.dnf = true;
        run.authority.pause();
        for (const m of run.members) if (m.slot !== slot) m.slot.socket?.emit('game:results', { ...run.authority.results(), dnf: true });
      }
      this.channel.emit('hint', { text: `${slot.name} left the race` });
      this.resumeIfComplete();
      this.checkRaceOver();
      this.broadcastState();
    }
    this.notifyVoicePeers();
  }

  // --- lobby ---------------------------------------------------------------------

  /**
   * Seats everyone for the current mode: co-op = one car, roles driver /
   * navigator; 1v1 / 1v1v1 / 1v1v1v1 = one car each (driver + AI navigator),
   * in joining order; 2v2 = two crews of driver + navigator. Players beyond
   * the mode's count wait without a seat (and the race can't start).
   */
  private normalizeSeats() {
    const spec = this.spec;
    if (spec.crew === 1) {
      this.players.forEach((p, i) => {
        p.team = i < spec.teams ? i : null;
        p.role = p.team === null ? null : 'driver';
      });
      return;
    }
    const count = (t: number) => this.players.filter((o) => o.team === t).length;
    for (const p of this.players) if (p.team !== null && p.team >= spec.teams) p.team = null;
    // at most two per crew (the later ones lose their seat)
    for (let t = 0; t < spec.teams; t++) this.players.filter((o) => o.team === t).slice(2).forEach((o) => (o.team = null));
    for (const p of this.players) {
      if (p.team !== null) continue;
      let best: number | null = null;
      for (let t = 0; t < spec.teams; t++) if (count(t) < 2 && (best === null || count(t) < count(best))) best = t;
      p.team = best;
    }
    // roles: players keep what they picked (two of the same is allowed in the lobby, the race
    // just can't start until one of them switches); newcomers get the free one
    for (const p of this.players) if (p.team === null) p.role = null;
    for (const p of this.players) {
      if (p.team === null || p.role) continue;
      const taken = this.players.filter((o) => o !== p && o.team === p.team).map((o) => o.role);
      p.role = !taken.includes('driver') ? 'driver' : !taken.includes('navigator') ? 'navigator' : null;
    }
  }

  setMode(slot: PlayerSlot, mode: RoomMode) {
    if (this.phase !== 'lobby' || !slot.isHost || mode === this.mode) return;
    const from = MODE_SPEC[this.mode];
    this.mode = mode;
    for (const p of this.players) {
      p.ready = false;
      // coming from the one-car-each modes, crews are picked afresh
      if (from.crew === 1) p.team = null;
    }
    this.normalizeSeats();
    this.broadcastState();
    this.notifyVoicePeers();
  }

  setTeam(slot: PlayerSlot, team: number) {
    if (this.phase !== 'lobby' || this.mode !== '2v2' || !Number.isInteger(team) || team < 0 || team >= this.spec.teams) return;
    if (slot.team === team || this.players.filter((p) => p.team === team).length >= 2) return;
    slot.team = team;
    slot.role = null;
    slot.ready = false;
    this.normalizeSeats();
    this.broadcastState();
    this.notifyVoicePeers();
  }

  setRole(slot: PlayerSlot, role: Role | null) {
    // switching is always allowed, even to a role a crew mate already has: canStart
    // waits until every crew has one driver and one navigator
    if (this.phase !== 'lobby' || this.spec.crew === 1 || slot.team === null) return;
    slot.role = role;
    slot.ready = false;
    this.broadcastState();
  }

  /** New look (lobby only: the car and crew are built when the stage loads). */
  setStyle(slot: PlayerSlot, style: PlayerStyle) {
    if (this.phase !== 'lobby' || sameStyle(slot.style, style)) return;
    slot.style = style;
    this.broadcastState();
  }

  /** Everyone seated with a complete crew, ready and connected. */
  get canStart(): boolean {
    const spec = this.spec;
    if (this.players.length !== spec.players) return false;
    if (!this.players.every((p) => p.ready && p.socket && p.team !== null && p.role)) return false;
    for (let t = 0; t < spec.teams; t++) {
      const roles = this.players.filter((p) => p.team === t).map((p) => p.role);
      if (!roles.includes('driver')) return false;
      if (spec.crew === 2 && !roles.includes('navigator')) return false;
    }
    return true;
  }

  setReady(slot: PlayerSlot, ready: boolean) {
    if (this.phase !== 'lobby') return;
    slot.ready = !!ready && slot.role !== null && slot.team !== null;
    this.broadcastState();
    if (this.canStart) this.startLoading();
  }

  setStage(slot: PlayerSlot, length: StageLength, seed?: number, night?: boolean, map?: StageMap, difficulty?: Difficulty) {
    if (this.phase !== 'lobby' || !slot.isHost) return;
    this.stage = {
      length,
      seed: typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : randomSeed(),
      night: typeof night === 'boolean' ? night : this.stage.night,
      map: map ?? this.stage.map,
      difficulty: difficulty ?? this.stage.difficulty ?? 'standard',
    };
    for (const p of this.players) p.ready = false;
    this.broadcastState();
  }

  // --- game flow ------------------------------------------------------------------

  private startLoading() {
    this.clearTimers();
    this.leaveTeamChannels();
    this.phase = 'loading';
    this.stageData = generateStage(this.stage);
    this.raceId = randomUUID();
    this.raceRecorded = false;
    this.closesAt = null;
    this.teams = [];
    for (let t = 0; t < this.spec.teams; t++) {
      const members = this.players
        .filter((p) => p.team === t && p.role)
        .map((p) => ({ slot: p, role: p.role! }))
        .sort((a, b) => (a.role === 'driver' ? 0 : 1) - (b.role === 'driver' ? 0 : 1));
      const run: TeamRun = { id: t, channel: this.teamChannel(t), authority: null as unknown as GameAuthority, members, aiNav: this.spec.crew === 1, result: null, dnf: false, relayCount: 0 };
      run.authority = new GameAuthority(this.stageData, this.makeOutput(run), () => Date.now());
      this.teams.push(run);
      for (const m of members) m.slot.socket?.join(run.channel);
    }
    this.countdownEndsAt = null;
    this.raceStartedAt = null;
    this.restartVotes = {};
    for (const p of this.players) p.loaded = false;
    this.channel.emit('game:load', { ...this.stage });
    this.broadcastState();
    this.loadTimer = setTimeout(() => {
      if (this.phase === 'loading') this.toLobby('Loading timed out');
    }, LOAD_TIMEOUT_MS);
  }

  private runOf(slot: PlayerSlot): TeamRun | null {
    return this.teams.find((t) => t.members.some((m) => m.slot === slot)) ?? null;
  }

  /** Players whose car is still in the race. */
  private get racers(): PlayerSlot[] {
    return this.teams.filter((t) => !t.dnf).flatMap((t) => t.members.map((m) => m.slot)).filter((p) => this.players.includes(p));
  }

  onLoaded(slot: PlayerSlot, hash: number) {
    if (!this.stageData || this.phase === 'lobby') return;
    if ((hash >>> 0) !== this.stageData.hash) {
      slot.socket?.emit('hint', { text: 'Stage checksum mismatch - please reload the page (different game version?)' });
      this.toLobby('Stage desync detected');
      return;
    }
    slot.loaded = true;
    this.broadcastState();
    if (!this.racers.every((p) => p.loaded && p.socket)) return;
    if (this.phase === 'loading') {
      if (this.loadTimer) clearTimeout(this.loadTimer);
      this.startCountdown();
    } else {
      this.resyncPlayer(slot);
      this.resumeIfComplete();
    }
  }

  private startCountdown() {
    this.phase = 'countdown';
    this.countdownEndsAt = Date.now() + COUNTDOWN_MS;
    this.channel.emit('game:countdown', { endsAt: this.countdownEndsAt });
    this.broadcastState();
    this.timers.push(setTimeout(() => this.go(), COUNTDOWN_MS));
  }

  private go() {
    if (this.phase !== 'countdown' || !this.teams.length) return;
    if (this.racers.some((p) => !p.socket)) {
      // someone dropped during the countdown - try again once they're back
      this.timers.push(setTimeout(() => this.go(), 500));
      return;
    }
    this.phase = 'racing';
    this.raceStartedAt = Date.now();
    for (const t of this.teams) t.authority.start(this.raceStartedAt);
    this.channel.emit('game:go', { startedAt: this.raceStartedAt });
    this.broadcastState();
    this.tickTimer = setInterval(() => this.tick(), 100);
  }

  private tick() {
    for (const t of this.teams) if (!t.dnf) t.authority.tick();
    const now = Date.now();
    if (this.spec.versus && this.phase === 'racing' && now - this.lastStandingsAt >= 500) {
      this.lastStandingsAt = now;
      this.channel.emit('race:standings', this.standings(false));
    }
  }

  private resyncPlayer(slot: PlayerSlot) {
    const run = this.runOf(slot);
    if (!run || !slot.socket) return;
    const a = run.authority;
    const s = slot.socket;
    if (this.phase === 'countdown' && this.countdownEndsAt) s.emit('game:countdown', { endsAt: this.countdownEndsAt });
    if ((this.phase === 'racing' || this.phase === 'finished') && this.raceStartedAt) s.emit('game:go', { startedAt: this.raceStartedAt });
    const last = a.lastCarState;
    const role = run.members.find((m) => m.slot === slot)?.role;
    if (last) s.emit(role === 'driver' ? 'car:correction' : 'car:state', toArrayBuffer(last.slice()));
    s.emit('doors:state', a.doorStates);
    s.emit('seats:state', a.seatStates);
    s.emit('tablet:owner', { holder: a.holder });
    s.emit('race:stats', a.stats());
    if (run.result) s.emit('game:results', run.result);
    if (this.spec.versus) s.emit('race:standings', this.standings(this.phase === 'finished'));
  }

  private resumeIfComplete() {
    if (this.racers.every((p) => p.socket && p.loaded) && this.teams.some((t) => t.authority.paused && !t.dnf)) {
      for (const t of this.teams) if (!t.dnf) t.authority.resume();
      this.channel.emit('game:paused', { paused: false, reason: '' });
    }
  }

  /** A crew crossed the line. */
  private teamFinished(run: TeamRun, results: RaceResults) {
    if (run.result || run.dnf) return;
    run.result = results;
    this.io.to(run.channel).emit('game:results', results);
    if (!this.spec.versus) {
      this.finishRace();
      return;
    }
    if (this.closesAt === null) {
      // the first car is home: everybody else has a minute
      this.closesAt = Date.now() + FINISH_WINDOW_MS;
      this.timers.push(setTimeout(() => this.finishRace(), FINISH_WINDOW_MS));
    }
    this.channel.emit('race:standings', this.standings(false));
    this.checkRaceOver();
  }

  private checkRaceOver() {
    if ((this.phase === 'racing' || this.phase === 'countdown') && this.teams.length && this.teams.every((t) => t.result || t.dnf)) this.finishRace();
  }

  /** The race is over for everybody (all home, or the finish window closed). */
  private finishRace() {
    if (this.phase === 'finished' || this.phase === 'lobby' || this.phase === 'loading') return;
    for (const t of this.teams) {
      if (t.result || t.dnf) continue;
      t.dnf = true;
      t.authority.pause();
      this.io.to(t.channel).emit('game:results', { ...t.authority.results(), dnf: true });
    }
    this.phase = 'finished';
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.restartVotes = {};
    if (this.spec.versus) this.channel.emit('race:standings', this.standings(true));
    this.broadcastState();
    this.recordRace();
  }

  private standings(final: boolean): Standings {
    const entries: Omit<StandingEntry, 'position'>[] = this.teams.map((t) => {
      const st = t.authority.stats();
      return {
        team: t.id,
        names: t.members.map((m) => m.slot.name),
        progress: t.result ? 1 : st.progress,
        finished: !!t.result,
        dnf: t.dnf && !t.result,
        timeMs: t.result ? t.result.finalTimeMs : st.timeMs,
        penaltiesMs: st.penaltiesMs,
        crashes: st.crashes,
        missedTurns: st.missedTurns,
      };
    });
    return { mode: this.mode, final, closesAt: this.closesAt, entries: rankStandings(entries) };
  }

  /** Hands the result to the stats store - exactly once per race. */
  private recordRace() {
    if (this.raceRecorded || !this.onRaceComplete) return;
    this.raceRecorded = true;
    const ranked = this.standings(true).entries;
    const summary: RaceSummary = {
      raceId: this.raceId,
      mode: this.mode,
      stage: { ...this.stage },
      teams: this.teams.map((t) => ({
        team: t.id,
        position: ranked.find((r) => r.team === t.id)!.position,
        finished: !!t.result,
        results: t.result ?? { ...t.authority.results(), dnf: true },
        members: t.members.map((m) => ({ name: m.slot.name, role: m.role, profileCode: m.slot.profileCode })),
      })),
    };
    try {
      this.onRaceComplete(summary);
    } catch (err) {
      console.error('[room] recording the race failed', err);
    }
  }

  restartVote(slot: PlayerSlot, mode: 'retry' | 'new') {
    if (this.phase !== 'finished' && this.phase !== 'racing') return;
    this.restartVotes[slot.id] = mode === 'retry' ? 'retry' : 'new';
    this.broadcastState();
    const voters = this.players.filter((p) => this.restartVotes[p.id]);
    if (voters.length !== this.players.length) return;
    const anyNew = Object.values(this.restartVotes).includes('new');
    if (anyNew) this.stage = { ...this.stage, seed: randomSeed() };
    if (this.players.length !== this.spec.players) {
      this.toLobby('Not enough players for another race in this mode');
      return;
    }
    for (const p of this.players) p.ready = true;
    this.normalizeSeats();
    if (this.canStart) this.startLoading();
    else this.toLobby();
  }

  toLobby(reason?: string) {
    this.clearTimers();
    this.leaveTeamChannels();
    this.phase = 'lobby';
    this.teams = [];
    this.stageData = null;
    this.countdownEndsAt = null;
    this.raceStartedAt = null;
    this.closesAt = null;
    this.restartVotes = {};
    for (const p of this.players) {
      p.ready = false;
      p.loaded = false;
    }
    this.normalizeSeats();
    if (reason) this.channel.emit('hint', { text: reason });
    this.broadcastState();
  }

  private leaveTeamChannels() {
    for (const t of this.teams) for (const p of this.players) p.socket?.leave(t.channel);
  }

  // --- gameplay messages (validated by the crew's authority) -------------------------

  /** The player's car and role while a stage runs (null otherwise / out of the race). */
  private seat(slot: PlayerSlot): { run: TeamRun; role: Role } | null {
    if (this.phase !== 'countdown' && this.phase !== 'racing' && this.phase !== 'finished') return null;
    const run = this.runOf(slot);
    if (!run || run.dnf) return null;
    return { run, role: run.members.find((m) => m.slot === slot)!.role };
  }

  /** Cabin / tablet actions: with an AI navigator, the driver's client speaks for the passenger seat. */
  private cabinRole(s: { run: TeamRun; role: Role }): Role {
    return s.run.aiNav ? 'navigator' : s.role;
  }

  carState(slot: PlayerSlot, buf: Float32Array) {
    const s = this.seat(slot);
    if (!s || s.role !== 'driver' || s.run.authority.paused) return;
    const accepted = s.run.authority.acceptCarState(buf);
    if (!accepted) return;
    slot.socket?.to(s.run.channel).volatile.emit('car:state', toArrayBuffer(accepted));
    // the other crews see this car too (every other state: ~15 Hz)
    if (this.spec.versus && ++s.run.relayCount % 2 === 0) {
      this.io.to(this.code).except(s.run.channel).volatile.emit('race:car', { team: s.run.id, buf: toArrayBuffer(accepted.slice()) });
    }
  }

  cabinState(slot: PlayerSlot, buf: Float32Array) {
    const s = this.seat(slot);
    if (!s) return;
    const accepted = s.run.authority.acceptCabinState(this.cabinRole(s), buf);
    if (accepted) slot.socket?.to(s.run.channel).volatile.emit('cabin:state', toArrayBuffer(accepted));
  }

  propsState(slot: PlayerSlot, buf: Float32Array) {
    const s = this.seat(slot);
    if (s?.role !== 'driver') return;
    // reliable (10 Hz): volatile relays get dropped while the 30 Hz car state is being written
    slot.socket?.to(s.run.channel).emit('props:state', toArrayBuffer(buf));
  }

  impact(slot: PlayerSlot, r: ImpactReport) {
    const s = this.seat(slot);
    if (s) s.run.authority.reportImpact(s.role, r);
  }

  mud(slot: PlayerSlot, r: MudReport) {
    const s = this.seat(slot);
    if (s) s.run.authority.reportMud(s.role, r);
  }

  wipe(slot: PlayerSlot, u: number, v: number) {
    const s = this.seat(slot);
    if (s?.role !== 'driver') return;
    slot.socket?.to(s.run.channel).emit('fx:wipe', { u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) });
  }

  tabletDrop(slot: PlayerSlot) {
    const s = this.seat(slot);
    if (s) s.run.authority.reportTabletDrop(this.cabinRole(s));
  }

  closeDoor(slot: PlayerSlot, side: DoorSide) {
    const s = this.seat(slot);
    if (!s) return;
    // with an AI navigator the passenger closes their own door (the driver's client does it for them)
    s.run.authority.closeDoor(s.run.aiNav && side === 'right' ? 'navigator' : s.role, side);
  }

  wiperCycle(slot: PlayerSlot) {
    const s = this.seat(slot);
    if (s) s.run.authority.wiperCycle(s.role);
  }

  exitCar(slot: PlayerSlot) {
    const s = this.seat(slot);
    if (s) s.run.authority.exitCar(s.role);
  }

  enterCar(slot: PlayerSlot, pos: { x: number; y: number; z: number }) {
    const s = this.seat(slot);
    if (s) s.run.authority.enterCar(s.role, pos);
  }

  tabletGrab(slot: PlayerSlot, held: boolean) {
    const s = this.seat(slot);
    if (s) s.run.authority.tabletGrab(this.cabinRole(s), held);
  }

  callout(slot: PlayerSlot, id: CalloutId, text?: string) {
    const s = this.seat(slot);
    if (s) s.run.authority.callout(this.cabinRole(s), id, text);
  }

  reset(slot: PlayerSlot) {
    const s = this.seat(slot);
    if (s && this.phase !== 'finished' && !s.run.result) s.run.authority.requestReset(s.role);
  }

  // --- voice signalling (crew mates only) ------------------------------------------------

  private crewMate(slot: PlayerSlot): PlayerSlot | null {
    if (slot.team === null || this.spec.crew === 1) return null;
    return this.players.find((p) => p !== slot && p.team === slot.team) ?? null;
  }

  setVoice(slot: PlayerSlot, enabled: boolean) {
    slot.voice = !!enabled;
    this.notifyVoicePeers();
  }

  relayVoice(slot: PlayerSlot, data: unknown) {
    const other = this.crewMate(slot);
    if (!other?.socket || !other.voice || !slot.voice) return;
    other.socket.emit('voice:signal', { from: slot.id, data });
  }

  private notifyVoicePeers() {
    for (const p of this.players) {
      const other = this.crewMate(p);
      p.socket?.emit('voice:peer', { peerId: other && other.socket && other.voice ? other.id : null, enabled: p.voice });
    }
  }

  // --- output -------------------------------------------------------------------

  private makeOutput(run: TeamRun): AuthorityOutput {
    const ch = () => this.io.to(run.channel);
    const driverSocket = () => run.members.find((m) => m.role === 'driver')?.slot.socket ?? null;
    return {
      raceEvent: (e) => ch().emit('race:event', e),
      stats: (s) => ch().emit('race:stats', s),
      impact: (fx) => ch().emit('fx:impact', fx),
      mud: (fx) => ch().emit('fx:mud', fx),
      doors: (d) => ch().emit('doors:state', d),
      wiperCycle: () => ch().emit('wipers:cycle'),
      seats: (seats) => ch().emit('seats:state', seats),
      callout: (msg) => ch().emit('callout', msg),
      teleport: (p) => ch().emit('car:teleport', p),
      correction: (buf) => driverSocket()?.emit('car:correction', toArrayBuffer(buf)),
      finished: (results) => this.teamFinished(run, results),
      hint: (text) => ch().emit('hint', { text }),
      tabletOwner: (holder) => ch().emit('tablet:owner', { holder }),
    };
  }

  snapshot(): RoomSnapshot {
    const players: PlayerInfo[] = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      team: p.team,
      ready: p.ready,
      connected: !!p.socket,
      loaded: p.loaded,
      isHost: p.isHost,
      style: { ...p.style },
    }));
    return {
      code: this.code,
      mode: this.mode,
      phase: this.phase,
      players,
      stage: this.stage,
      countdownEndsAt: this.countdownEndsAt,
      raceStartedAt: this.raceStartedAt,
      pausedForDisconnect: this.teams.some((t) => t.authority.paused && !t.dnf),
      restartVotes: { ...this.restartVotes },
    };
  }

  broadcastState() {
    this.channel.emit('room:state', this.snapshot());
  }

  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = null;
  }

  dispose() {
    this.clearTimers();
    for (const p of this.players) if (p.graceTimer) clearTimeout(p.graceTimer);
  }
}

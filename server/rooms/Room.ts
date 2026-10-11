import { randomBytes, randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { GameAuthority, type AuthorityOutput } from '../../src/shared/authority/GameAuthority';
import { COUNTDOWN_MS, LOAD_TIMEOUT_MS, type StageLength } from '../../src/shared/constants';
import type { ClientToServerEvents, ImpactReport, MudReport, ServerToClientEvents } from '../../src/shared/protocol';
import { toArrayBuffer } from '../../src/shared/snapshot';
import { generateStage } from '../../src/shared/stage/StageGenerator';
import type { CalloutId, DoorSide, PlayerInfo, Role, RoomPhase, RoomSnapshot, StageData, StageMap, StageParams } from '../../src/shared/types';
import type { GameServer } from './RoomManager';

export type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export interface PlayerSlot {
  id: string;
  token: string;
  name: string;
  role: Role | null;
  ready: boolean;
  socket: GameSocket | null;
  loaded: boolean;
  isHost: boolean;
  voice: boolean;
  graceTimer: NodeJS.Timeout | null;
}

const randomSeed = () => (Math.random() * 0xffffffff) >>> 0;

export class Room {
  readonly players: PlayerSlot[] = [];
  phase: RoomPhase = 'lobby';
  stage: StageParams = { seed: randomSeed(), length: 'medium', night: false, map: 'countryside' };
  private stageData: StageData | null = null;
  private authority: GameAuthority | null = null;
  private countdownEndsAt: number | null = null;
  private raceStartedAt: number | null = null;
  private restartVotes: Record<string, 'retry' | 'new'> = {};
  private timers: NodeJS.Timeout[] = [];
  private tickTimer: NodeJS.Timeout | null = null;
  private loadTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly code: string,
    private io: GameServer,
    private graceMs: number,
    private onEmpty: () => void,
  ) {}

  get isEmpty(): boolean {
    return this.players.length === 0;
  }

  private get channel() {
    return this.io.to(this.code);
  }

  // --- membership ------------------------------------------------------------

  addPlayer(name: string): PlayerSlot | null {
    if (this.players.length >= 2) return null;
    const slot: PlayerSlot = {
      id: randomUUID(),
      token: randomBytes(16).toString('hex'),
      name,
      role: null,
      ready: false,
      socket: null,
      loaded: false,
      isHost: this.players.length === 0,
      voice: false,
      graceTimer: null,
    };
    // auto-assign the free role to make the lobby quicker
    const taken = this.players.map((p) => p.role);
    if (!taken.includes('driver')) slot.role = 'driver';
    else if (!taken.includes('navigator')) slot.role = 'navigator';
    this.players.push(slot);
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
      slot.socket.data.roomCode = null;
    }
    slot.socket = null;
    slot.voice = false;
    if (voluntary) {
      this.removePlayer(slot);
      return;
    }
    if (this.phase === 'countdown' || this.phase === 'racing') {
      this.authority?.pause();
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
    if (this.phase !== 'lobby') {
      this.toLobby(`${slot.name} left the session`);
    } else {
      this.broadcastState();
    }
    this.notifyVoicePeers();
  }

  // --- lobby ---------------------------------------------------------------------

  setRole(slot: PlayerSlot, role: Role | null) {
    if (this.phase !== 'lobby') return;
    if (role && this.players.some((p) => p !== slot && p.role === role)) return;
    slot.role = role;
    slot.ready = false;
    this.broadcastState();
  }

  setReady(slot: PlayerSlot, ready: boolean) {
    if (this.phase !== 'lobby') return;
    slot.ready = !!ready && slot.role !== null;
    this.broadcastState();
    const roles = new Set(this.players.map((p) => p.role));
    if (this.players.length === 2 && this.players.every((p) => p.ready && p.socket) && roles.has('driver') && roles.has('navigator')) {
      this.startLoading();
    }
  }

  setStage(slot: PlayerSlot, length: StageLength, seed?: number, night?: boolean, map?: StageMap) {
    if (this.phase !== 'lobby' || !slot.isHost) return;
    this.stage = {
      length,
      seed: typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : randomSeed(),
      night: typeof night === 'boolean' ? night : this.stage.night,
      map: map ?? this.stage.map,
    };
    for (const p of this.players) p.ready = false;
    this.broadcastState();
  }

  // --- game flow ------------------------------------------------------------------

  private startLoading() {
    this.clearTimers();
    this.phase = 'loading';
    this.stageData = generateStage(this.stage);
    this.authority = new GameAuthority(this.stageData, this.makeOutput(), () => Date.now());
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

  onLoaded(slot: PlayerSlot, hash: number) {
    if (!this.stageData || this.phase === 'lobby') return;
    if ((hash >>> 0) !== this.stageData.hash) {
      slot.socket?.emit('hint', { text: 'Stage checksum mismatch - please reload the page (different game version?)' });
      this.toLobby('Stage desync detected');
      return;
    }
    slot.loaded = true;
    this.broadcastState();
    const allLoaded = this.players.length === 2 && this.players.every((p) => p.loaded && p.socket);
    if (!allLoaded) return;
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
    if (this.phase !== 'countdown' || !this.authority) return;
    if (this.players.some((p) => !p.socket)) {
      // someone dropped during the countdown - try again once they're back
      this.timers.push(setTimeout(() => this.go(), 500));
      return;
    }
    this.phase = 'racing';
    this.raceStartedAt = Date.now();
    this.authority.start(this.raceStartedAt);
    this.channel.emit('game:go', { startedAt: this.raceStartedAt });
    this.broadcastState();
    this.tickTimer = setInterval(() => this.authority?.tick(), 100);
  }

  private resyncPlayer(slot: PlayerSlot) {
    const a = this.authority;
    if (!a || !slot.socket) return;
    const s = slot.socket;
    if (this.phase === 'countdown' && this.countdownEndsAt) s.emit('game:countdown', { endsAt: this.countdownEndsAt });
    if ((this.phase === 'racing' || this.phase === 'finished') && this.raceStartedAt) s.emit('game:go', { startedAt: this.raceStartedAt });
    const last = a.lastCarState;
    if (last) s.emit(slot.role === 'driver' ? 'car:correction' : 'car:state', toArrayBuffer(last.slice()));
    s.emit('doors:state', a.doorStates);
    s.emit('seats:state', a.seatStates);
    s.emit('tablet:owner', { holder: a.holder });
    s.emit('race:stats', a.stats());
    if (this.phase === 'finished') s.emit('game:results', a.results());
  }

  private resumeIfComplete() {
    if (this.players.length === 2 && this.players.every((p) => p.socket && p.loaded) && this.authority?.paused) {
      this.authority.resume();
      this.channel.emit('game:paused', { paused: false, reason: '' });
    }
  }

  restartVote(slot: PlayerSlot, mode: 'retry' | 'new') {
    if (this.phase !== 'finished' && this.phase !== 'racing') return;
    this.restartVotes[slot.id] = mode === 'retry' ? 'retry' : 'new';
    this.broadcastState();
    const voters = this.players.filter((p) => this.restartVotes[p.id]);
    if (voters.length === this.players.length && this.players.length === 2) {
      const anyNew = Object.values(this.restartVotes).includes('new');
      if (anyNew) this.stage = { ...this.stage, seed: randomSeed() };
      this.startLoading();
    }
  }

  toLobby(reason?: string) {
    this.clearTimers();
    this.phase = 'lobby';
    this.authority = null;
    this.stageData = null;
    this.countdownEndsAt = null;
    this.raceStartedAt = null;
    this.restartVotes = {};
    for (const p of this.players) {
      p.ready = false;
      p.loaded = false;
    }
    if (reason) this.channel.emit('hint', { text: reason });
    this.broadcastState();
  }

  // --- gameplay messages (validated by the authority) -----------------------------

  private roleOf(slot: PlayerSlot): Role | null {
    return this.phase === 'countdown' || this.phase === 'racing' || this.phase === 'finished' ? slot.role : null;
  }

  carState(slot: PlayerSlot, buf: Float32Array) {
    const a = this.authority;
    if (!a || this.roleOf(slot) !== 'driver' || a.paused) return;
    const accepted = a.acceptCarState(buf);
    if (accepted) slot.socket?.to(this.code).volatile.emit('car:state', toArrayBuffer(accepted));
  }

  cabinState(slot: PlayerSlot, buf: Float32Array) {
    const a = this.authority;
    const role = this.roleOf(slot);
    if (!a || !role) return;
    const accepted = a.acceptCabinState(role, buf);
    if (accepted) slot.socket?.to(this.code).volatile.emit('cabin:state', toArrayBuffer(accepted));
  }

  propsState(slot: PlayerSlot, buf: Float32Array) {
    if (this.roleOf(slot) !== 'driver') return;
    slot.socket?.to(this.code).volatile.emit('props:state', toArrayBuffer(buf));
  }

  impact(slot: PlayerSlot, r: ImpactReport) {
    const role = this.roleOf(slot);
    if (role) this.authority?.reportImpact(role, r);
  }

  mud(slot: PlayerSlot, r: MudReport) {
    const role = this.roleOf(slot);
    if (role) this.authority?.reportMud(role, r);
  }

  wipe(slot: PlayerSlot, u: number, v: number) {
    if (this.roleOf(slot) !== 'driver') return;
    slot.socket?.to(this.code).emit('fx:wipe', { u: Math.min(1, Math.max(0, u)), v: Math.min(1, Math.max(0, v)) });
  }

  tabletDrop(slot: PlayerSlot) {
    const role = this.roleOf(slot);
    if (role) this.authority?.reportTabletDrop(role);
  }

  closeDoor(slot: PlayerSlot, side: DoorSide) {
    const role = this.roleOf(slot);
    if (role) this.authority?.closeDoor(role, side);
  }

  wiperCycle(slot: PlayerSlot) {
    const role = this.roleOf(slot);
    if (role) this.authority?.wiperCycle(role);
  }

  exitCar(slot: PlayerSlot) {
    const role = this.roleOf(slot);
    if (role) this.authority?.exitCar(role);
  }

  enterCar(slot: PlayerSlot, pos: { x: number; y: number; z: number }) {
    const role = this.roleOf(slot);
    if (role) this.authority?.enterCar(role, pos);
  }

  tabletGrab(slot: PlayerSlot, held: boolean) {
    const role = this.roleOf(slot);
    if (role) this.authority?.tabletGrab(role, held);
  }

  callout(slot: PlayerSlot, id: CalloutId, text?: string) {
    const role = this.roleOf(slot);
    if (role) this.authority?.callout(role, id, text);
  }

  reset(slot: PlayerSlot) {
    const role = this.roleOf(slot);
    if (role && this.phase !== 'finished') this.authority?.requestReset(role);
  }

  // --- voice signalling -------------------------------------------------------------

  setVoice(slot: PlayerSlot, enabled: boolean) {
    slot.voice = !!enabled;
    this.notifyVoicePeers();
  }

  relayVoice(slot: PlayerSlot, data: unknown) {
    const other = this.players.find((p) => p !== slot);
    if (!other?.socket || !other.voice || !slot.voice) return;
    other.socket.emit('voice:signal', { from: slot.id, data });
  }

  private notifyVoicePeers() {
    for (const p of this.players) {
      const other = this.players.find((o) => o !== p);
      p.socket?.emit('voice:peer', { peerId: other && other.socket && other.voice ? other.id : null, enabled: p.voice });
    }
  }

  // --- output -------------------------------------------------------------------

  private makeOutput(): AuthorityOutput {
    const ch = () => this.channel;
    const driverSocket = () => this.players.find((p) => p.role === 'driver')?.socket ?? null;
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
      finished: (results) => {
        this.phase = 'finished';
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.tickTimer = null;
        this.restartVotes = {};
        ch().emit('game:results', results);
        this.broadcastState();
      },
      hint: (text) => ch().emit('hint', { text }),
      tabletOwner: (holder) => ch().emit('tablet:owner', { holder }),
    };
  }

  snapshot(): RoomSnapshot {
    const players: PlayerInfo[] = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      ready: p.ready,
      connected: !!p.socket,
      loaded: p.loaded,
      isHost: p.isHost,
    }));
    return {
      code: this.code,
      phase: this.phase,
      players,
      stage: this.stage,
      countdownEndsAt: this.countdownEndsAt,
      raceStartedAt: this.raceStartedAt,
      pausedForDisconnect: !!this.authority?.paused,
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

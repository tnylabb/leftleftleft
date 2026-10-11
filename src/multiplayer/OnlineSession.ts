// Socket.IO client session: lobby (create / join / roles / ready), clock
// sync, reconnection with a saved seat token, and gameplay messaging.

import { io, type Socket } from 'socket.io-client';
import type { StageLength } from '../shared/constants';
import type { ClientToServerEvents, ImpactReport, JoinAck, MudReport, ServerToClientEvents } from '../shared/protocol';
import { readFloat32, toArrayBuffer } from '../shared/snapshot';
import type { PlayerStyle } from '../shared/style';
import type { CalloutId, DoorSide, Role, RoomSnapshot, StageMap, StageParams } from '../shared/types';
import { GameSession, type ConnectionStatus } from './Session';

const SEAT_KEY = 'lll.seat';

interface Seat {
  code: string;
  playerId: string;
  token: string;
}

export class OnlineSession extends GameSession {
  readonly kind = 'online' as const;
  private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  status: ConnectionStatus = 'connecting';
  room: RoomSnapshot | null = null;
  playerId: string | null = null;
  private seat: Seat | null = null;
  private offset = 0; // server ms - local ms
  private bestRtt = Infinity;
  private syncTimer: number | null = null;
  rtt = 0;
  private name = 'Player';
  /** Our look, sent to the room after every create / join / rejoin. */
  style: PlayerStyle | null = null;

  constructor(url?: string) {
    super();
    const target = url || (import.meta.env.VITE_SERVER_URL as string | undefined) || undefined;
    this.socket = io(target ?? '/', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 3000,
      timeout: 7000,
      autoConnect: true,
    });
    this.wire();
    try {
      const raw = sessionStorage.getItem(SEAT_KEY);
      if (raw) this.seat = JSON.parse(raw) as Seat;
    } catch {
      /* ignore */
    }
  }

  get localRoles(): Role[] {
    const me = this.room?.players.find((p) => p.id === this.playerId);
    return me?.role ? [me.role] : [];
  }

  get myRole(): Role | null {
    return this.localRoles[0] ?? null;
  }

  get savedSeat(): Seat | null {
    return this.seat;
  }

  private setStatus(s: ConnectionStatus) {
    this.status = s;
    this.emit('connection', s);
  }

  /** Server ms -> local performance.now() ms */
  toLocal(serverMs: number): number {
    return serverMs - this.offset;
  }

  private wire() {
    const s = this.socket;
    s.on('connect', () => {
      this.setStatus('online');
      this.bestRtt = Infinity;
      this.syncClock(6);
      if (this.syncTimer === null) this.syncTimer = window.setInterval(() => this.syncClock(1), 3000);
      // transparently re-attach to our seat after a network drop
      if (this.seat && this.room) this.rejoin().catch(() => undefined);
    });
    s.on('disconnect', () => this.setStatus(this.room ? 'reconnecting' : 'offline'));
    s.on('connect_error', () => this.setStatus(this.room ? 'reconnecting' : 'offline'));
    s.io.on('reconnect_attempt', () => this.setStatus('reconnecting'));

    s.on('room:state', (room) => {
      this.room = room;
      this.emit('room', room);
      this.flushLoad();
    });
    s.on('room:kicked', (reason) => {
      this.clearSeat();
      this.room = null;
      this.emit('kicked', reason);
    });
    s.on('game:load', (p) => {
      this.pendingLoad = p;
      this.flushLoad();
    });
    s.on('game:countdown', (p) => this.emit('countdown', { endsAt: this.toLocal(p.endsAt) }));
    s.on('game:go', (p) => this.emit('go', { startedAt: this.toLocal(p.startedAt) }));
    s.on('game:results', (r) => this.emit('results', r));
    s.on('game:paused', (p) => this.emit('paused', p));
    s.on('race:event', (e) => this.emit('raceEvent', e));
    s.on('race:stats', (st) => this.emit('stats', st));
    s.on('car:state', (buf) => {
      const f = readFloat32(buf);
      if (f) this.emit('carState', f);
    });
    s.on('car:correction', (buf) => {
      const f = readFloat32(buf);
      if (f) this.emit('carCorrection', f);
    });
    s.on('car:teleport', (p) => this.emit('carTeleport', p));
    s.on('cabin:state', (buf) => {
      const f = readFloat32(buf);
      if (f) this.emit('cabinState', f);
    });
    s.on('props:state', (buf) => {
      const f = readFloat32(buf);
      if (f) this.emit('propsState', f);
    });
    s.on('fx:impact', (fx) => this.emit('impact', fx));
    s.on('fx:mud', (fx) => this.emit('mud', fx));
    s.on('fx:wipe', (p) => this.emit('wipe', p));
    s.on('doors:state', (d) => this.emit('doors', d));
    s.on('wipers:cycle', () => this.emit('wiperCycle', undefined));
    s.on('seats:state', (seats) => this.emit('seats', seats));
    s.on('tablet:owner', (p) => this.emit('tabletOwner', p.holder));
    s.on('callout', (m) => this.emit('callout', m));
    s.on('hint', (p) => this.emit('hint', p.text));
  }

  private pendingLoad: StageParams | null = null;

  /** Only start building a stage once we know which seat we're in. */
  private flushLoad() {
    if (this.pendingLoad && this.playerId && this.myRole) {
      const p = this.pendingLoad;
      this.pendingLoad = null;
      this.emit('load', p);
    }
  }

  get voiceSocket() {
    return this.socket;
  }

  private syncClock(samples: number) {
    for (let i = 0; i < samples; i++) {
      window.setTimeout(() => {
        const t0 = performance.now();
        this.socket.timeout(4000).emit('time:sync', { t: t0 }, (err, res) => {
          if (err || !res) return;
          const t1 = performance.now();
          const rtt = t1 - t0;
          this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
          if (rtt <= this.bestRtt * 1.3 || rtt < 30) {
            this.bestRtt = Math.min(this.bestRtt, rtt);
            this.offset = res.server - (t0 + rtt / 2);
          }
        });
      }, i * 120);
    }
  }

  waitForConnection(timeoutMs = 6000): Promise<void> {
    if (this.socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('Could not reach the game server. Is it running? (npm run dev)'));
      }, timeoutMs);
      const ok = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        this.socket.off('connect', ok);
      };
      this.socket.on('connect', ok);
    });
  }

  private saveSeat(ack: JoinAck) {
    if (!ack.ok || !ack.code || !ack.playerId || !ack.token) return;
    this.seat = { code: ack.code, playerId: ack.playerId, token: ack.token };
    this.playerId = ack.playerId;
    if (ack.room) this.room = ack.room;
    try {
      sessionStorage.setItem(SEAT_KEY, JSON.stringify(this.seat));
    } catch {
      /* ignore */
    }
    this.flushLoad();
  }

  clearSeat() {
    this.seat = null;
    try {
      sessionStorage.removeItem(SEAT_KEY);
    } catch {
      /* ignore */
    }
  }

  private ackCall(event: 'room:create' | 'room:join', payload: Record<string, unknown>): Promise<JoinAck> {
    return new Promise((resolve) => {
      const fn = (err: Error | null, res?: JoinAck) => {
        if (err || !res) resolve({ ok: false, error: 'Server did not answer' });
        else {
          this.saveSeat(res);
          // tell the room what we look like
          if (res.ok && this.style) this.socket.emit('lobby:style', { style: this.style });
          resolve(res);
        }
      };
      if (event === 'room:create') this.socket.timeout(6000).emit('room:create', payload as { name: string }, fn);
      else this.socket.timeout(6000).emit('room:join', payload as { code: string; name: string }, fn);
    });
  }

  async createRoom(name: string): Promise<JoinAck> {
    this.name = name;
    await this.waitForConnection();
    return this.ackCall('room:create', { name });
  }

  async joinRoom(code: string, name: string): Promise<JoinAck> {
    this.name = name;
    await this.waitForConnection();
    const seat = this.seat && this.seat.code === code.toUpperCase() ? this.seat : null;
    return this.ackCall('room:join', { code, name, playerId: seat?.playerId, token: seat?.token });
  }

  async rejoin(): Promise<JoinAck> {
    if (!this.seat) return { ok: false, error: 'No saved seat' };
    await this.waitForConnection();
    const res = await this.ackCall('room:join', { code: this.seat.code, name: this.name, playerId: this.seat.playerId, token: this.seat.token });
    if (!res.ok) this.clearSeat();
    return res;
  }

  setRole(role: Role | null) {
    this.socket.emit('lobby:role', { role });
  }
  setReady(ready: boolean) {
    this.socket.emit('lobby:ready', { ready });
  }
  setStyle(style: PlayerStyle) {
    this.style = style;
    if (this.socket.connected) this.socket.emit('lobby:style', { style });
  }
  setStage(length: StageLength, seed?: number, night?: boolean, map?: StageMap) {
    this.socket.emit('lobby:stage', { length, seed, night, map });
  }

  // --- gameplay ---------------------------------------------------------------
  sendCarState(buf: Float32Array) {
    if (this.socket.connected) this.socket.volatile.emit('car:state', toArrayBuffer(buf.slice()));
  }
  sendCabinState(buf: Float32Array) {
    if (this.socket.connected) this.socket.volatile.emit('cabin:state', toArrayBuffer(buf.slice()));
  }
  sendProps(buf: Float32Array) {
    // not volatile: a volatile packet is dropped whenever the socket is still busy with the car state
    if (this.socket.connected) this.socket.emit('props:state', toArrayBuffer(buf));
  }
  reportImpact(r: ImpactReport) {
    this.socket.emit('event:impact', r);
  }
  reportMud(r: MudReport) {
    this.socket.emit('event:mud', r);
  }
  sendWipe(u: number, v: number) {
    this.socket.volatile.emit('event:wipe', { u, v });
  }
  reportTabletDrop() {
    this.socket.emit('event:tabletDrop');
  }
  requestReset() {
    this.socket.emit('car:reset');
  }
  closeDoor(side: DoorSide) {
    this.socket.emit('door:close', { side });
  }
  wiperCycle() {
    this.socket.emit('wipers:cycle');
  }
  exitCar() {
    this.socket.emit('player:exit');
  }
  enterCar(pos: { x: number; y: number; z: number }) {
    this.socket.emit('player:enter', pos);
  }
  setTabletHeld(held: boolean) {
    this.socket.emit('tablet:grab', { held });
  }
  callout(id: CalloutId, text?: string) {
    this.socket.emit('callout', { id, text });
  }
  loaded(hash: number) {
    this.socket.emit('game:loaded', { hash });
  }
  restart(mode: 'retry' | 'new') {
    this.socket.emit('game:restart', { mode });
  }
  toLobby() {
    this.socket.emit('game:toLobby');
  }
  leave() {
    this.socket.emit('room:leave');
    this.clearSeat();
    this.room = null;
  }

  /** Fully closes the connection (back to the main menu). */
  close() {
    if (this.syncTimer !== null) window.clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.clear();
  }
}

// Offline session: runs the same GameAuthority the server uses, in-process.
// Used for solo practice and split-screen couch co-op (local dev mode).

import { GameAuthority } from '../shared/authority/GameAuthority';
import { COUNTDOWN_MS, type StageLength } from '../shared/constants';
import type { ImpactReport, MudReport } from '../shared/protocol';
import { generateStage } from '../shared/stage/StageGenerator';
import type { CalloutId, DoorSide, Role, StageMap, StageParams } from '../shared/types';
import { GameSession } from './Session';

export class LocalSession extends GameSession {
  readonly kind = 'local' as const;
  private authority: GameAuthority | null = null;
  private phase: 'idle' | 'loading' | 'countdown' | 'racing' | 'finished' = 'idle';
  private countdownEndsAt = 0;
  private params: StageParams;

  constructor(
    readonly localRoles: Role[],
    length: StageLength,
    night: boolean,
    map: StageMap,
    seed?: number,
  ) {
    super();
    this.params = { seed: seed ?? ((Math.random() * 0xffffffff) >>> 0), length, night, map };
  }

  get stageParams(): StageParams {
    return this.params;
  }

  start() {
    this.phase = 'loading';
    this.emit('load', { ...this.params });
  }

  loaded(hash: number) {
    const stage = generateStage(this.params);
    if (stage.hash !== hash) console.warn('[local] stage hash mismatch', stage.hash, hash);
    this.authority = new GameAuthority(
      stage,
      {
        raceEvent: (e) => this.emit('raceEvent', e),
        stats: (s) => this.emit('stats', s),
        impact: (fx) => this.emit('impact', fx),
        mud: (fx) => this.emit('mud', fx),
        doors: (d) => this.emit('doors', d),
        wiperCycle: () => this.emit('wiperCycle', undefined),
        seats: (s) => this.emit('seats', s),
        callout: (m) => this.emit('callout', m),
        teleport: (p) => this.emit('carTeleport', p),
        correction: (buf) => this.emit('carCorrection', buf),
        finished: (r) => {
          this.phase = 'finished';
          this.emit('results', r);
        },
        hint: (t) => this.emit('hint', t),
        tabletOwner: (h) => this.emit('tabletOwner', h),
      },
      () => this.now(),
    );
    this.phase = 'countdown';
    this.countdownEndsAt = this.now() + COUNTDOWN_MS;
    this.emit('countdown', { endsAt: this.countdownEndsAt });
  }

  tick() {
    if (!this.authority) return;
    if (this.phase === 'countdown' && this.now() >= this.countdownEndsAt && !this.authority.paused) {
      this.phase = 'racing';
      this.authority.start(this.now());
      this.emit('go', { startedAt: this.now() });
    }
    this.authority.tick();
  }

  setPaused(paused: boolean) {
    if (!this.authority) return;
    if (paused) this.authority.pause();
    else {
      if (this.phase === 'countdown' && this.authority.paused) {
        // extend the countdown by the paused duration
        this.countdownEndsAt = Math.max(this.countdownEndsAt, this.now() + 1000);
        this.emit('countdown', { endsAt: this.countdownEndsAt });
      }
      this.authority.resume();
    }
  }

  private role(r: Role): Role | null {
    return this.localRoles.includes(r) ? r : null;
  }

  sendCarState(buf: Float32Array) {
    this.authority?.acceptCarState(buf);
  }
  sendCabinState(buf: Float32Array) {
    this.authority?.acceptCabinState('navigator', buf);
  }
  sendProps() {}
  reportImpact(r: ImpactReport) {
    this.authority?.reportImpact('driver', r);
  }
  reportMud(r: MudReport) {
    this.authority?.reportMud('driver', r);
  }
  sendWipe() {}
  reportTabletDrop() {
    this.authority?.reportTabletDrop('navigator');
  }
  requestReset() {
    if (this.authority && !this.authority.isFinished) this.authority.requestReset('driver');
  }
  closeDoor(side: DoorSide) {
    // locally both seats exist (AI passenger closes their own door in solo)
    this.authority?.closeDoor(side === 'left' ? 'driver' : 'navigator', side);
  }
  wiperCycle() {
    this.authority?.wiperCycle('driver');
  }
  exitCar(role: Role = 'driver') {
    this.authority?.exitCar(role);
  }
  enterCar(pos: { x: number; y: number; z: number }, role: Role = 'driver') {
    this.authority?.enterCar(role, pos);
  }
  setTabletHeld(held: boolean) {
    this.authority?.tabletGrab('navigator', held);
  }
  callout(id: CalloutId, text?: string) {
    if (this.role('navigator') || this.localRoles.length === 1) this.authority?.callout('navigator', id, text);
  }
  restart(mode: 'retry' | 'new') {
    if (mode === 'new') this.params = { ...this.params, seed: (Math.random() * 0xffffffff) >>> 0 };
    this.authority = null;
    this.start();
  }
  toLobby() {
    this.leave();
  }
  leave() {
    this.authority = null;
    this.phase = 'idle';
  }
}

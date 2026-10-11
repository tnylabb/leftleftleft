// Server-authoritative gameplay rules. The Node server runs one instance per
// room; the browser's LocalSession runs the exact same class for offline play.
//
// Clients simulate (driver: car, navigator: cabin) for responsiveness, but this
// class validates every state, owns progress/time/penalties, and decides all
// shared chaos events (doors popping, mud) so both players see the same thing.

import {
  CABIN_BOUNDS,
  CAR_HOOKS,
  DOOR_EXIT,
  ENTER_RADIUS,
  EXIT_MAX_SPEED,
  FOOT_MAX_DISTANCE,
  GRIP_REACH,
  PULL_FORCE_MAX,
  RESET_PENALTY_MS,
  STUCK_SECONDS,
  WIPER_COOLDOWN_MS,
  CALLOUT_COOLDOWN_MS,
  MAX_CAR_SPEED,
  MAX_TELEPORT_SLACK,
  RESET_COOLDOWN_MS,
  ROAD_HALF_WIDTH,
  ROAD_SAMPLE_SPACING,
  STATS_BROADCAST_MS,
} from '../constants';
import type { ImpactReport, MudReport } from '../protocol';
import { clamp, isFiniteArray, rotateByQuat } from '../math';
import { RaceTracker } from '../race/RaceTracker';
import { Rng, hash2 } from '../rng';
import { CABIN, CABIN_FLAG, CAR, CAR_FLAG } from '../snapshot';
import { brakingDistance } from '../stage/pacenotes';
import { stageStartPose } from '../stage/StageGenerator';
import type {
  CalloutId,
  CalloutMsg,
  DoorSide,
  DoorStates,
  ImpactFx,
  MudFx,
  Pose,
  RaceEvent,
  RaceResults,
  RaceStats,
  Role,
  SeatStates,
  StageData,
} from '../types';

export interface AuthorityOutput {
  raceEvent(e: RaceEvent): void;
  stats(s: RaceStats): void;
  impact(fx: ImpactFx): void;
  mud(fx: MudFx): void;
  doors(d: DoorStates): void;
  /** One windscreen wiper sweep (out and back), shown on both screens. */
  wiperCycle(): void;
  seats(s: SeatStates): void;
  callout(msg: CalloutMsg): void;
  teleport(p: Pose): void;
  correction(buf: Float32Array): void;
  finished(results: RaceResults): void;
  hint(text: string): void;
  tabletOwner(holder: Role | null): void;
}

type Phase = 'countdown' | 'racing' | 'finished';

const ALLOWED_CALLOUTS: CalloutId[] = [
  'left', 'left3', 'right', 'right3', 'otherLeft', 'otherRight', 'brake', 'straight',
  'missed', 'accelerating', 'jump', 'wrongWay', 'dropped', 'nice', 'ouch', 'note',
];

export class GameAuthority {
  readonly tracker: RaceTracker;
  private phase: Phase = 'countdown';
  private startedAt = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;
  private finishTimeMs = 0;

  private lastState: Float32Array | null = null;
  private lastStateTime = 0;
  private violations = 0;
  private pendingTeleport: Pose | null = null;
  private lastResetAt = -Infinity;
  private recentSpeeds: { t: number; v: number }[] = [];

  private crashes = 0;
  private lastCrashAt = -Infinity;
  private lastImpactAt = -Infinity;
  private tabletDrops = 0;
  private lastDropAt = -Infinity;
  private doors: DoorStates = { left: false, right: false };
  private lastWiperAt = -Infinity;
  private seats: SeatStates = { driver: true, navigator: true };
  private resets = 0;
  private resetPenaltyMs = 0;
  private tabletHolder: Role | null = null;
  private rng: Rng;
  private puddleUsedAt = new Map<number, number>();
  private lastDirtAt = -Infinity;
  private roughTime = 0;

  private lastStatsAt = 0;
  private lastCalloutAt = -Infinity;
  private lastAutoAt = -Infinity;
  private lastDirectional: { dir: 1 | -1; t: number; answered: boolean } | null = null;
  private warnedCorners = new Set<number>();
  private stuckTime = 0;
  private flippedTime = 0;
  private stuckHinted = false;
  private offRouteTime = 0;
  private offRouteHinted = false;

  constructor(
    private stage: StageData,
    private out: AuthorityOutput,
    private now: () => number,
  ) {
    this.tracker = new RaceTracker(stage);
    this.rng = new Rng(hash2(stage.params.seed, 0xc4a05));
  }

  // --- lifecycle ---------------------------------------------------------------

  /** Countdown finished: the stage clock starts now. */
  start(at = this.now()) {
    this.phase = 'racing';
    this.startedAt = at;
    this.pausedTotal = 0;
    this.pausedAt = null;
  }

  get isRacing(): boolean {
    return this.phase === 'racing';
  }

  get isFinished(): boolean {
    return this.phase === 'finished';
  }

  get raceTimeMs(): number {
    if (this.phase === 'countdown') return 0;
    if (this.phase === 'finished') return this.finishTimeMs;
    const end = this.pausedAt ?? this.now();
    return Math.max(0, end - this.startedAt - this.pausedTotal);
  }

  pause() {
    if (this.pausedAt === null) this.pausedAt = this.now();
  }

  resume() {
    if (this.pausedAt !== null) {
      this.pausedTotal += this.now() - this.pausedAt;
      this.pausedAt = null;
    }
    // Avoid flagging the first snapshot after a reconnect as a teleport.
    this.lastStateTime = this.now();
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /** Last validated car state (used to resync reconnecting drivers). */
  get lastCarState(): Float32Array | null {
    return this.lastState;
  }

  get doorStates(): DoorStates {
    return { ...this.doors };
  }

  get seatStates(): SeatStates {
    return { ...this.seats };
  }

  /** Car-local point -> world, using the last validated car pose. */
  private carPointToWorld(p: { x: number; y: number; z: number }): { x: number; y: number; z: number } | null {
    const s = this.lastState;
    if (!s) return null;
    const r = rotateByQuat(p, { x: s[CAR.qx], y: s[CAR.qy], z: s[CAR.qz], w: s[CAR.qw] });
    return { x: r.x + s[CAR.px], y: r.y + s[CAR.py], z: r.z + s[CAR.pz] };
  }

  get holder(): Role | null {
    return this.tabletHolder;
  }

  // --- car -------------------------------------------------------------------------

  private startPose(): Pose {
    return stageStartPose(this.stage);
  }

  /** Validates a driver snapshot. Returns the sanitized buffer to relay, or null if rejected. */
  acceptCarState(buf: Float32Array): Float32Array | null {
    if (buf.length !== CAR.LENGTH || !isFiniteArray(buf)) return null;
    const now = this.now();
    // normalise quaternion
    const ql = Math.hypot(buf[CAR.qx], buf[CAR.qy], buf[CAR.qz], buf[CAR.qw]);
    if (ql < 0.5 || ql > 1.5) return this.reject();
    buf[CAR.qx] /= ql;
    buf[CAR.qy] /= ql;
    buf[CAR.qz] /= ql;
    buf[CAR.qw] /= ql;
    const speed = Math.hypot(buf[CAR.vx], buf[CAR.vy], buf[CAR.vz]);
    if (speed > MAX_CAR_SPEED) return this.reject();
    const b = this.stage.bounds;
    const x = buf[CAR.px], y = buf[CAR.py], z = buf[CAR.pz];
    if (x < b.minX - 500 || x > b.maxX + 500 || z < b.minZ - 500 || z > b.maxZ + 500 || y < -300 || y > 400) {
      return this.reject();
    }
    if (this.pendingTeleport) {
      // Waiting for the driver to apply a server-issued reset: silently drop
      // stale in-flight states, and re-send the teleport if it seems lost.
      const p = this.pendingTeleport;
      if (Math.hypot(x - p.x, y - p.y, z - p.z) > 3 + MAX_TELEPORT_SLACK) {
        if (now - this.lastResetAt > 1500) {
          this.lastResetAt = now;
          this.out.teleport(p);
        }
        return null;
      }
    } else if (this.lastState) {
      const dt = Math.max(0.05, (now - this.lastStateTime) / 1000);
      const allowed = MAX_CAR_SPEED * dt + MAX_TELEPORT_SLACK;
      const moved = Math.hypot(x - this.lastState[CAR.px], y - this.lastState[CAR.py], z - this.lastState[CAR.pz]);
      if (moved > allowed) return this.reject();
    }
    if (this.phase === 'countdown') {
      const sp = this.startPose();
      if (Math.hypot(x - sp.x, z - sp.z) > 4) return this.reject();
    }
    this.pendingTeleport = null;
    this.violations = 0;
    // seat state is server-owned: the driver can only be "out" if the server let them out
    const flags = buf[CAR.flags] | 0;
    if (!this.seats.driver !== !!(flags & CAR_FLAG.driverOut)) {
      buf[CAR.flags] = this.seats.driver ? flags & ~CAR_FLAG.driverOut : flags | CAR_FLAG.driverOut;
    }
    if (!this.seats.driver) this.sanitizeFoot(buf, CAR.footX, CAR.footGrip, { x, y, z });
    else buf[CAR.footGrip] = -1;
    const dt = this.lastState ? clamp((now - this.lastStateTime) / 1000, 0, 0.5) : 0;
    this.lastState = buf;
    this.lastStateTime = now;
    this.recentSpeeds.push({ t: now, v: speed });
    while (this.recentSpeeds.length && now - this.recentSpeeds[0].t > 1500) this.recentSpeeds.shift();

    if (this.phase === 'racing' && !this.paused) {
      const events = this.tracker.update(x, z, buf[CAR.vx], buf[CAR.vz], dt, this.raceTimeMs, y);
      for (const e of events) this.handleRaceEvent(e);
      this.evaluateCarContext(buf, dt, speed);
    }
    return buf;
  }

  /**
   * Keeps an on-foot player near the car and only lets them grip a tow hook
   * they are actually standing next to. Returns whether the grip is valid.
   */
  private sanitizeFoot(buf: Float32Array, o: number, gripIdx: number, car: { x: number; y: number; z: number }): boolean {
    const dx = buf[o] - car.x;
    const dy = buf[o + 1] - car.y;
    const dz = buf[o + 2] - car.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > FOOT_MAX_DISTANCE) {
      const k = FOOT_MAX_DISTANCE / d;
      buf[o] = car.x + dx * k;
      buf[o + 1] = car.y + dy * k;
      buf[o + 2] = car.z + dz * k;
    }
    const grip = Math.round(buf[gripIdx]);
    if (grip < 0 || grip >= CAR_HOOKS.length) {
      buf[gripIdx] = -1;
      return false;
    }
    const hook = this.carPointToWorld(CAR_HOOKS[grip]);
    if (!hook || Math.hypot(buf[o] - hook.x, buf[o + 2] - hook.z) > GRIP_REACH + 0.6) {
      buf[gripIdx] = -1;
      return false;
    }
    return true;
  }

  private reject(): null {
    this.violations++;
    if (this.violations >= 3) {
      this.violations = 0;
      if (this.lastState) this.out.correction(this.lastState.slice());
      else {
        const p = this.startPose();
        this.pendingTeleport = p;
        this.out.teleport(p);
      }
    }
    return null;
  }

  private handleRaceEvent(e: RaceEvent) {
    this.out.raceEvent(e);
    if (e.type === 'missedTurn') this.autoCallout('missed');
    if (e.type === 'wrongWay' && e.active) this.autoCallout('wrongWay');
    if (e.type === 'finish') {
      this.phase = 'finished';
      this.finishTimeMs = e.timeMs;
      this.out.finished(this.results());
      this.broadcastStats(true);
    }
  }

  /** Contextual automatic callouts + stuck / door-rattle logic. */
  private evaluateCarContext(buf: Float32Array, dt: number, speed: number) {
    const now = this.now();
    const loc = this.tracker.loc;
    const idx = loc.idx;
    const throttle = buf[CAR.throttle];
    const steer = buf[CAR.steer];

    // "Why are you still accelerating?" approaching a tight corner way too fast
    for (const c of this.stage.corners) {
      if (c.entryIdx < idx - 2) continue;
      const dist = (c.entryIdx - idx) * ROAD_SAMPLE_SPACING;
      if (dist > 70) break;
      if ((c.severity === 'hard' || c.severity === 'hairpin') && !this.warnedCorners.has(c.id)) {
        if (throttle > 0.6 && speed > c.targetSpeed * 1.45 && speed > 13 && dist < brakingDistance(speed, c.targetSpeed) * 0.75) {
          this.warnedCorners.add(c.id);
          this.autoCallout('accelerating');
        }
      }
      break;
    }

    // "No, the OTHER left!" — driver steers the opposite way right after a directional call
    const ld = this.lastDirectional;
    if (ld && !ld.answered && now - ld.t < 1800 && speed > 5) {
      if (Math.sign(steer) === -ld.dir && Math.abs(steer) > 0.16) {
        ld.answered = true;
        this.autoCallout(ld.dir < 0 ? 'otherLeft' : 'otherRight', true);
      } else if (Math.sign(steer) === ld.dir && Math.abs(steer) > 0.12) ld.answered = true;
    }

    // Stuck: the driver keeps asking for drive (or reverse) but the car does not
    // move. Normal stops and slow driving never count: no pedal = no stuck timer.
    const up = rotateByQuat({ x: 0, y: 1, z: 0 }, { x: buf[CAR.qx], y: buf[CAR.qy], z: buf[CAR.qz], w: buf[CAR.qw] });
    if (up.y < 0.3) this.flippedTime += dt;
    else this.flippedTime = 0;
    const pedal = Math.max(throttle, buf[CAR.brake]);
    if (this.seats.driver && speed < 0.6 && pedal > 0.5) this.stuckTime += dt;
    else if (speed > 1.5) {
      this.stuckTime = 0;
      this.stuckHinted = false;
    }
    if (!this.stuckHinted && (this.stuckTime > STUCK_SECONDS || this.flippedTime > 2)) {
      this.stuckHinted = true;
      const flipped = this.flippedTime > 2;
      this.out.raceEvent({ type: 'stuck', flipped });
      this.out.hint(
        flipped
          ? 'FLIPPED! HOLD R FOR AN EMERGENCY RESET (+5 s)'
          : 'STUCK! GET OUT AND PULL THE CAR FREE BY ITS TOW HOOKS',
      );
    }
    if (this.flippedTime > 6) {
      this.flippedTime = 0;
      this.issueReset(true);
    }

    // fell (or drove) onto a stretch of road the car hasn't got to yet: it doesn't count
    if (this.tracker.offRoute) this.offRouteTime += dt;
    else {
      this.offRouteTime = 0;
      this.offRouteHinted = false;
    }
    if (this.offRouteTime > 2 && !this.offRouteHinted) {
      this.offRouteHinted = true;
      this.out.hint('OFF YOUR ROUTE - THIS PART DOES NOT COUNT. HOLD R TO RESET TO WHERE YOU LEFT THE ROAD');
    }

    // rough terrain can shake a door open
    const rough = buf[CAR.rough];
    if (rough > 0.65 && speed > 8 && Math.abs(loc.lateral) > ROAD_HALF_WIDTH + 1) this.roughTime += dt;
    else this.roughTime = Math.max(0, this.roughTime - dt * 0.5);
    if (this.roughTime > 2.5) {
      this.roughTime = 0;
      if (this.rng.chance(0.35)) this.popDoor(this.rng.chance(0.5) ? 'left' : 'right');
    }
  }

  /** Emergency reset (last resort, costs time). Only the driver can call it. */
  requestReset(role: Role): boolean {
    if (role !== 'driver' || this.phase === 'finished') return false;
    if (this.now() - this.lastResetAt < RESET_COOLDOWN_MS) return false;
    this.issueReset(this.phase === 'racing');
    return true;
  }

  private issueReset(penalize = false) {
    const s = this.stage;
    this.lastResetAt = this.now();
    if (penalize) {
      this.resets++;
      this.resetPenaltyMs += RESET_PENALTY_MS;
    }
    // everybody is put back into their seat
    if (!this.seats.driver || !this.seats.navigator) {
      this.seats = { driver: true, navigator: true };
      this.out.seats(this.seatStates);
    }
    let i: number;
    if (this.phase === 'countdown' || !this.lastState) i = s.startIdx;
    // never further than the car has legitimately driven (no shortcuts by falling off the mountain)
    else i = Math.max(s.startIdx, Math.min(s.finishIdx - 2, Math.floor(Math.min(this.tracker.loc.idx, this.tracker.maxIdx)) - 3));
    // never reset onto a jump ramp
    for (const j of s.jumps) if (i > j.idx - 9 && i < j.idx + 8) i = j.idx - 10;
    const h = s.headings[i];
    const pose: Pose = { x: s.xs[i], y: s.ys[i] + 0.8, z: s.zs[i], qx: 0, qy: Math.sin(-h / 2), qz: 0, qw: Math.cos(-h / 2) };
    this.pendingTeleport = pose;
    this.tracker.teleported(pose.x, pose.z, i);
    this.stuckTime = 0;
    this.flippedTime = 0;
    this.stuckHinted = false;
    this.offRouteTime = 0;
    this.offRouteHinted = false;
    this.out.teleport(pose);
  }

  // --- events ----------------------------------------------------------------------

  reportImpact(role: Role, r: ImpactReport) {
    if (role !== 'driver' || !this.lastState) return;
    const now = this.now();
    if (now - this.lastImpactAt < 120) return;
    if (![r.strength, r.dx, r.dy, r.dz].every(Number.isFinite)) return;
    const recentMax = this.recentSpeeds.reduce((m, s) => Math.max(m, s.v), 0);
    const strength = clamp(r.strength, 0, recentMax * 1.25 + 4);
    if (strength < 1) return;
    this.lastImpactAt = now;
    const dl = Math.hypot(r.dx, r.dy, r.dz) || 1;
    const kinds: ImpactFx['kind'][] = ['tree', 'rock', 'terrain', 'bale', 'landing', 'other'];
    const kind = kinds.includes(r.kind) ? r.kind : 'other';
    const fx: ImpactFx = { strength, dx: r.dx / dl, dy: r.dy / dl, dz: r.dz / dl, kind };
    this.out.impact(fx);

    if (this.phase !== 'racing') return;
    const crashThreshold = kind === 'landing' ? 9 : 5;
    if (strength > crashThreshold && now - this.lastCrashAt > 1200) {
      this.lastCrashAt = now;
      this.crashes++;
      this.out.raceEvent({ type: 'crash', strength });
      if (this.rng.chance(0.45)) this.autoCallout('ouch');
    }
    // strong hits can unlatch a door — biased to the side that was hit
    if (strength > 3.2) {
      const p = Math.min(0.85, (strength - 3.2) / 6.5);
      if (this.rng.chance(p)) {
        let side: DoorSide;
        if (Math.abs(fx.dx) > 0.35) side = fx.dx > 0 ? 'right' : 'left';
        else side = this.rng.chance(0.5) ? 'left' : 'right';
        this.popDoor(side);
      }
    }
    if ((kind === 'terrain' || kind === 'landing') && strength > 3) {
      this.emitMud('impact', clamp(strength / 12, 0.2, 0.8));
    }
  }

  reportMud(role: Role, r: MudReport) {
    if (role !== 'driver' || !this.lastState || this.phase === 'finished') return;
    const now = this.now();
    const x = this.lastState[CAR.px], z = this.lastState[CAR.pz];
    const speed = Math.hypot(this.lastState[CAR.vx], this.lastState[CAR.vz]);
    if (r.kind === 'puddle' && typeof r.puddle === 'number') {
      const p = this.stage.puddles[r.puddle];
      if (!p) return;
      if (Math.hypot(p.x - x, p.z - z) > p.r + 4.5) return;
      if (now - (this.puddleUsedAt.get(r.puddle) ?? -Infinity) < 1500) return;
      if (speed < 4) return;
      this.puddleUsedAt.set(r.puddle, now);
      this.emitMud('puddle', clamp(speed / 18, 0.35, 1));
    } else if (r.kind === 'dirt') {
      if (Math.abs(this.tracker.loc.lateral) < ROAD_HALF_WIDTH + 0.3 || speed < 8) return;
      if (now - this.lastDirtAt < 700) return;
      this.lastDirtAt = now;
      this.emitMud('dirt', clamp(r.amount, 0.05, 0.3));
    }
  }

  private emitMud(kind: MudFx['kind'], amount: number) {
    this.out.mud({ seed: Math.floor(this.rng.next() * 0x7fffffff), amount, kind });
  }

  private popDoor(side: DoorSide) {
    if (this.doors[side]) return;
    this.doors = { ...this.doors, [side]: true };
    this.out.doors(this.doorStates);
  }

  closeDoor(role: Role, side: DoorSide) {
    // Each occupant can only reach their own door.
    if ((side === 'left' && role !== 'driver') || (side === 'right' && role !== 'navigator')) return;
    if (!this.doors[side]) return;
    this.doors = { ...this.doors, [side]: false };
    this.out.doors(this.doorStates);
  }

  /** One manual wiper sweep (the driver flicks the stalk). */
  wiperCycle(role: Role) {
    if (role !== 'driver' || !this.seats.driver) return;
    const now = this.now();
    if (now - this.lastWiperAt < WIPER_COOLDOWN_MS) return;
    this.lastWiperAt = now;
    this.out.wiperCycle();
  }

  /** A player gets out. Only allowed once the car has (almost) stopped. */
  exitCar(role: Role): boolean {
    if (this.phase === 'countdown' || !this.seats[role] || !this.lastState) return false;
    const speed = Math.hypot(this.lastState[CAR.vx], this.lastState[CAR.vy], this.lastState[CAR.vz]);
    if (speed > EXIT_MAX_SPEED) {
      this.out.hint(role === 'driver' ? 'STOP THE CAR BEFORE GETTING OUT' : 'WAIT UNTIL THE CAR HAS STOPPED');
      return false;
    }
    this.seats = { ...this.seats, [role]: false };
    if (role === 'navigator' && this.tabletHolder) this.tabletGrab('navigator', false);
    this.out.seats(this.seatStates);
    return true;
  }

  /** A player on foot climbs back into their own seat when standing at their door. */
  enterCar(role: Role, pos: { x: number; y: number; z: number }): boolean {
    if (this.seats[role] || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return false;
    const door = this.carPointToWorld(DOOR_EXIT[role]);
    if (!door || Math.hypot(pos.x - door.x, pos.z - door.z) > ENTER_RADIUS + 0.5) return false;
    this.seats = { ...this.seats, [role]: true };
    this.out.seats(this.seatStates);
    return true;
  }

  tabletGrab(role: Role, held: boolean) {
    if (role !== 'navigator') return;
    const holder = held ? 'navigator' : null;
    if (holder === this.tabletHolder) return;
    this.tabletHolder = holder;
    this.out.tabletOwner(holder);
  }

  reportTabletDrop(role: Role) {
    if (role !== 'navigator') return;
    const now = this.now();
    if (now - this.lastDropAt < 1500) return;
    this.lastDropAt = now;
    if (this.phase === 'racing') this.tabletDrops++;
    this.autoCallout('dropped', true);
  }

  /** Validates a cabin snapshot from the navigator (bounds + ownership). */
  acceptCabinState(role: Role, buf: Float32Array): Float32Array | null {
    if (role !== 'navigator' || buf.length !== CABIN.LENGTH || !isFiniteArray(buf)) return null;
    const b = CABIN_BOUNDS;
    const clampPose = (o: number) => {
      buf[o] = clamp(buf[o], b.minX, b.maxX);
      buf[o + 1] = clamp(buf[o + 1], b.minY, b.maxY);
      buf[o + 2] = clamp(buf[o + 2], b.minZ, b.maxZ);
      const l = Math.hypot(buf[o + 3], buf[o + 4], buf[o + 5], buf[o + 6]) || 1;
      for (let k = 3; k < 7; k++) buf[o + k] /= l;
    };
    clampPose(CABIN.tablet);
    for (let i = 0; i < (CABIN.reachX - CABIN.objects) / 7; i++) clampPose(CABIN.objects + i * 7);
    // ownership: the tablet can only be shown as held if the server granted it
    let flags = buf[CABIN.flags] | 0;
    if (flags & CABIN_FLAG.tabletHeld && this.tabletHolder !== 'navigator') flags &= ~CABIN_FLAG.tabletHeld;
    // seat state is server-owned; on foot the navigator must stay near the car and
    // can only pull on a tow hook they are standing next to, with a human-sized force
    const out = !this.seats.navigator;
    flags = out ? flags | CABIN_FLAG.navOut : flags & ~CABIN_FLAG.navOut;
    buf[CABIN.flags] = flags;
    const s = this.lastState;
    let gripOk = false;
    if (out && s) gripOk = this.sanitizeFoot(buf, CABIN.footX, CABIN.footGrip, { x: s[CAR.px], y: s[CAR.py], z: s[CAR.pz] });
    else buf[CABIN.footGrip] = -1;
    const f = Math.hypot(buf[CABIN.pullX], buf[CABIN.pullY], buf[CABIN.pullZ]);
    if (!gripOk) buf[CABIN.pullX] = buf[CABIN.pullY] = buf[CABIN.pullZ] = 0;
    else if (f > PULL_FORCE_MAX) {
      const k = PULL_FORCE_MAX / f;
      buf[CABIN.pullX] *= k;
      buf[CABIN.pullY] *= k;
      buf[CABIN.pullZ] *= k;
    }
    return buf;
  }

  callout(role: Role, id: CalloutId, text?: string) {
    if (role !== 'navigator') return;
    if (!ALLOWED_CALLOUTS.includes(id)) return;
    const now = this.now();
    if (now - this.lastCalloutAt < CALLOUT_COOLDOWN_MS) return;
    this.lastCalloutAt = now;
    let clean: string | undefined;
    if (id === 'note' && typeof text === 'string') {
      clean = text.toUpperCase().replace(/[^A-Z0-9 ,!?'.-]/g, '').slice(0, 48);
      if (!clean) return;
    }
    if (id === 'left' || id === 'left3') this.lastDirectional = { dir: -1, t: now, answered: false };
    else if (id === 'right' || id === 'right3') this.lastDirectional = { dir: 1, t: now, answered: false };
    this.out.callout({ id, text: clean, auto: false, from: 'navigator' });
  }

  private autoCallout(id: CalloutId, force = false) {
    const now = this.now();
    if (!force && now - this.lastAutoAt < 2600) return;
    this.lastAutoAt = now;
    this.out.callout({ id, auto: true, from: 'system' });
  }

  // --- periodic ----------------------------------------------------------------

  tick() {
    const now = this.now();
    if (now - this.lastStatsAt >= STATS_BROADCAST_MS) this.broadcastStats();
  }

  private broadcastStats(force = false) {
    const now = this.now();
    if (!force && this.phase === 'countdown') return;
    this.lastStatsAt = now;
    this.out.stats(this.stats());
  }

  stats(): RaceStats {
    const t = this.tracker;
    return {
      timeMs: this.raceTimeMs,
      progress: t.progress,
      distanceDriven: t.distanceDriven,
      checkpointsHit: t.checkpointsHit,
      checkpointsTotal: this.stage.checkpoints.length,
      missedCheckpoints: t.missedCheckpoints,
      crashes: this.crashes,
      missedTurns: t.missedTurns,
      tabletDrops: this.tabletDrops,
      resets: this.resets,
      penaltiesMs: t.penaltiesMs + this.resetPenaltyMs,
      topSpeed: t.topSpeed,
      wrongWay: t.wrongWay,
    };
  }

  results(): RaceResults {
    const s = this.stats();
    const finalTimeMs = s.timeMs + s.penaltiesMs;
    const stageLength = (this.stage.finishIdx - this.stage.startIdx) * ROAD_SAMPLE_SPACING;
    const par = (stageLength / 16.5) * 1000;
    const ratio = finalTimeMs / par;
    let grade: RaceResults['grade'];
    if (ratio < 0.92 && s.crashes <= 1 && s.missedTurns === 0 && s.missedCheckpoints === 0) grade = 'S';
    else if (ratio < 1.08 && s.crashes <= 3 && s.missedCheckpoints === 0) grade = 'A';
    else if (ratio < 1.3 && s.missedCheckpoints <= 1) grade = 'B';
    else if (ratio < 1.6) grade = 'C';
    else grade = 'D';
    let title = 'Weekend Warriors';
    if (s.missedCheckpoints >= 2) title = 'Shortcut Specialists';
    else if (grade === 'S') title = 'Pace Note Legends';
    else if (s.crashes >= 8) title = 'Demolition Duo';
    else if (s.missedTurns >= 4) title = 'Scenic Route Enthusiasts';
    else if (s.tabletDrops >= 4) title = 'Butterfingers Navigation Co.';
    else if (s.resets >= 3) title = 'Tow Truck Regulars';
    else if (grade === 'A') title = 'Gravel Gladiators';
    else if (s.crashes === 0) title = 'Careful Commuters';
    else if (grade === 'D') title = 'Lost In The Woods';
    return {
      ...s,
      finalTimeMs,
      avgSpeed: s.timeMs > 0 ? stageLength / (s.timeMs / 1000) : 0,
      stageLength,
      grade,
      title,
      seed: this.stage.params.seed,
    };
  }
}

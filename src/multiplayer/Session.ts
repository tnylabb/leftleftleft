// Common interface the game talks to, implemented by the online (Socket.IO)
// session and the in-process local session (offline / couch / solo modes).

import { EventBus } from '../core/EventBus';
import type { ImpactReport, MudReport } from '../shared/protocol';
import type { Standings } from '../shared/modes';
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
  RoomSnapshot,
  SeatStates,
  StageParams,
} from '../shared/types';

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface SessionEvents {
  load: StageParams;
  countdown: { endsAt: number };
  go: { startedAt: number };
  results: RaceResults;
  paused: { paused: boolean; reason: string };
  raceEvent: RaceEvent;
  stats: RaceStats;
  carState: Float32Array;
  carTeleport: Pose;
  carCorrection: Float32Array;
  cabinState: Float32Array;
  propsState: Float32Array;
  impact: ImpactFx;
  mud: MudFx;
  wipe: { u: number; v: number };
  doors: DoorStates;
  wiperCycle: void;
  seats: SeatStates;
  tabletOwner: Role | null;
  callout: CalloutMsg;
  hint: string;
  room: RoomSnapshot;
  connection: ConnectionStatus;
  kicked: string;
  /** Versus: live / final positions. */
  standings: Standings;
  /** Versus: another crew's car state. */
  opponentCar: { team: number; buf: Float32Array };
}

export abstract class GameSession extends EventBus<SessionEvents> {
  abstract readonly kind: 'online' | 'local';
  abstract readonly localRoles: Role[];
  /** Local clock in ms (performance.now timeline). */
  now(): number {
    return performance.now();
  }
  abstract sendCarState(buf: Float32Array): void;
  abstract sendCabinState(buf: Float32Array): void;
  abstract sendProps(buf: Float32Array): void;
  abstract reportImpact(r: ImpactReport): void;
  abstract reportMud(r: MudReport): void;
  abstract sendWipe(u: number, v: number): void;
  abstract reportTabletDrop(): void;
  abstract requestReset(): void;
  abstract closeDoor(side: DoorSide): void;
  /** One manual wiper sweep. */
  abstract wiperCycle(): void;
  /** `role` selects the player in split screen (online the server knows who you are). */
  abstract exitCar(role?: Role): void;
  abstract enterCar(pos: { x: number; y: number; z: number }, role?: Role): void;
  abstract setTabletHeld(held: boolean): void;
  abstract callout(id: CalloutId, text?: string): void;
  abstract loaded(hash: number): void;
  abstract restart(mode: 'retry' | 'new'): void;
  abstract toLobby(): void;
  abstract leave(): void;
  tick(_dt: number): void {}
  setPaused(_paused: boolean): void {}
  get canPause(): boolean {
    return this.kind === 'local';
  }
}

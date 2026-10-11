// Socket.IO event contracts shared by client and server.

import type { StageLength } from './constants';
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
} from './types';

export interface JoinAck {
  ok: boolean;
  error?: string;
  code?: string;
  playerId?: string;
  token?: string;
  room?: RoomSnapshot;
}

export interface ImpactReport {
  strength: number;
  dx: number;
  dy: number;
  dz: number;
  kind: ImpactFx['kind'];
}

export interface MudReport {
  kind: MudFx['kind'];
  amount: number;
  puddle?: number;
}

export interface ServerToClientEvents {
  'room:state': (room: RoomSnapshot) => void;
  'room:kicked': (reason: string) => void;
  'game:load': (payload: { seed: number; length: StageLength; night: boolean }) => void;
  'game:countdown': (payload: { endsAt: number }) => void;
  'game:go': (payload: { startedAt: number }) => void;
  'game:results': (results: RaceResults) => void;
  'game:paused': (payload: { paused: boolean; reason: string }) => void;
  'race:event': (event: RaceEvent) => void;
  'race:stats': (stats: RaceStats) => void;
  'car:state': (buf: ArrayBuffer) => void;
  'car:teleport': (pose: Pose) => void;
  'car:correction': (buf: ArrayBuffer) => void;
  'cabin:state': (buf: ArrayBuffer) => void;
  'props:state': (buf: ArrayBuffer) => void;
  'fx:impact': (fx: ImpactFx) => void;
  'fx:mud': (fx: MudFx) => void;
  'fx:wipe': (payload: { u: number; v: number }) => void;
  'doors:state': (doors: DoorStates) => void;
  'wipers:cycle': () => void;
  'seats:state': (seats: SeatStates) => void;
  'tablet:owner': (payload: { holder: Role | null }) => void;
  callout: (msg: CalloutMsg) => void;
  hint: (payload: { text: string }) => void;
  'voice:signal': (payload: { from: string; data: unknown }) => void;
  'voice:peer': (payload: { peerId: string | null; enabled: boolean }) => void;
}

export interface ClientToServerEvents {
  'room:create': (payload: { name: string }, ack: (res: JoinAck) => void) => void;
  'room:join': (payload: { code: string; name: string; playerId?: string; token?: string }, ack: (res: JoinAck) => void) => void;
  'room:leave': () => void;
  'lobby:role': (payload: { role: Role | null }) => void;
  'lobby:ready': (payload: { ready: boolean }) => void;
  'lobby:stage': (payload: { length: StageLength; seed?: number; night?: boolean }) => void;
  'game:loaded': (payload: { hash: number }) => void;
  'game:restart': (payload: { mode: 'retry' | 'new' }) => void;
  'game:toLobby': () => void;
  'car:state': (buf: ArrayBuffer) => void;
  'car:reset': () => void;
  'cabin:state': (buf: ArrayBuffer) => void;
  'props:state': (buf: ArrayBuffer) => void;
  'event:impact': (report: ImpactReport) => void;
  'event:mud': (report: MudReport) => void;
  'event:wipe': (payload: { u: number; v: number }) => void;
  'event:tabletDrop': () => void;
  'door:close': (payload: { side: DoorSide }) => void;
  'wipers:cycle': () => void;
  'player:exit': () => void;
  'player:enter': (payload: { x: number; y: number; z: number }) => void;
  'tablet:grab': (payload: { held: boolean }) => void;
  callout: (payload: { id: CalloutId; text?: string }) => void;
  'time:sync': (payload: { t: number }, ack: (res: { t: number; server: number }) => void) => void;
  'voice:signal': (payload: { data: unknown }) => void;
  'voice:enabled': (payload: { enabled: boolean }) => void;
}

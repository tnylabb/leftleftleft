import type { Server } from 'socket.io';
import { ROOM_CODE_LENGTH } from '../../src/shared/constants';
import type { ClientToServerEvents, ServerToClientEvents } from '../../src/shared/protocol';
import { ROOM_CODE_ALPHABET } from '../validation/payloads';
import { Room, type RaceSummary } from './Room';

export type GameServer = Server<ClientToServerEvents, ServerToClientEvents>;

export class RoomManager {
  private rooms = new Map<string, Room>();

  constructor(
    private io: GameServer,
    private graceMs: number,
    /** Finished races (stats). */
    private onRaceComplete: ((s: RaceSummary) => void) | null = null,
  ) {
    // sweep empty rooms
    setInterval(() => {
      for (const [code, room] of this.rooms) {
        if (room.isEmpty) {
          room.dispose();
          this.rooms.delete(code);
        }
      }
    }, 15000).unref();
  }

  get count(): number {
    return this.rooms.size;
  }

  create(): Room {
    let code = '';
    do {
      code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    } while (this.rooms.has(code));
    const room = new Room(code, this.io, this.graceMs, () => {
      room.dispose();
      this.rooms.delete(code);
    });
    room.onRaceComplete = this.onRaceComplete;
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }
}

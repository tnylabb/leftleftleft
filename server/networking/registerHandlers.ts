import { CABIN, CAR, MAX_PROPS_PER_MSG, PROP_STRIDE, readFloat32 } from '../../src/shared/snapshot';
import type { CalloutId } from '../../src/shared/types';
import type { Room, GameSocket, PlayerSlot } from '../rooms/Room';
import type { GameServer, RoomManager } from '../rooms/RoomManager';
import {
  RateLimiter,
  finite,
  isDoorSide,
  isObject,
  isRole,
  isSmallJson,
  isStageLength,
  normalizeCode,
  sanitizeName,
} from '../validation/payloads';

export function registerHandlers(io: GameServer, rooms: RoomManager) {
  io.on('connection', (socket: GameSocket) => {
    const limiter = new RateLimiter();
    socket.data.roomCode = null as string | null;
    socket.data.playerId = null as string | null;

    /** Resolves the caller's room + seat, or null when not in a session. */
    const ctx = (): { room: Room; slot: PlayerSlot } | null => {
      const code = socket.data.roomCode as string | null;
      const id = socket.data.playerId as string | null;
      if (!code || !id) return null;
      const room = rooms.get(code);
      const slot = room?.players.find((p) => p.id === id);
      if (!room || !slot || slot.socket !== socket) return null;
      return { room, slot };
    };

    const leaveCurrent = () => {
      const c = ctx();
      if (c) c.room.detach(c.slot, true);
    };

    socket.on('time:sync', (payload, ack) => {
      if (typeof ack !== 'function') return;
      ack({ t: isObject(payload) && finite(payload.t) ? payload.t : 0, server: Date.now() });
    });

    socket.on('room:create', (payload, ack) => {
      if (typeof ack !== 'function') return;
      if (!limiter.allow('join', 2, 5)) return ack({ ok: false, error: 'Too many requests' });
      leaveCurrent();
      const room = rooms.create();
      const slot = room.addPlayer(sanitizeName(isObject(payload) ? payload.name : ''));
      if (!slot) return ack({ ok: false, error: 'Could not create room' });
      room.attach(slot, socket);
      ack({ ok: true, code: room.code, playerId: slot.id, token: slot.token, room: room.snapshot() });
    });

    socket.on('room:join', (payload, ack) => {
      if (typeof ack !== 'function') return;
      if (!limiter.allow('join', 2, 5)) return ack({ ok: false, error: 'Too many requests' });
      if (!isObject(payload)) return ack({ ok: false, error: 'Bad request' });
      const code = normalizeCode(payload.code);
      if (!code) return ack({ ok: false, error: 'Room codes are 4 letters' });
      const room = rooms.get(code);
      if (!room) return ack({ ok: false, error: `Room ${code} does not exist` });

      // reconnection with a saved seat token
      if (typeof payload.playerId === 'string' && typeof payload.token === 'string') {
        const slot = room.findForReconnect(payload.playerId, payload.token);
        if (slot) {
          if (ctx()?.slot !== slot) leaveCurrent();
          room.attach(slot, socket);
          ack({ ok: true, code, playerId: slot.id, token: slot.token, room: room.snapshot() });
          room.resyncAfterJoin(slot);
          return;
        }
      }
      if (room.phase !== 'lobby') return ack({ ok: false, error: 'That stage is already running' });
      leaveCurrent();
      const slot = room.addPlayer(sanitizeName(payload.name));
      if (!slot) return ack({ ok: false, error: 'Room is full (2 players max)' });
      room.attach(slot, socket);
      ack({ ok: true, code, playerId: slot.id, token: slot.token, room: room.snapshot() });
    });

    socket.on('room:leave', () => leaveCurrent());

    socket.on('lobby:role', (payload) => {
      const c = ctx();
      if (!c || !isObject(payload)) return;
      if (payload.role !== null && !isRole(payload.role)) return;
      c.room.setRole(c.slot, payload.role);
    });

    socket.on('lobby:ready', (payload) => {
      const c = ctx();
      if (c && isObject(payload)) c.room.setReady(c.slot, payload.ready === true);
    });

    socket.on('lobby:stage', (payload) => {
      const c = ctx();
      if (!c || !isObject(payload) || !isStageLength(payload.length)) return;
      c.room.setStage(c.slot, payload.length, finite(payload.seed) ? payload.seed : undefined);
    });

    socket.on('game:loaded', (payload) => {
      const c = ctx();
      if (c && isObject(payload) && finite(payload.hash)) c.room.onLoaded(c.slot, payload.hash);
    });

    socket.on('game:restart', (payload) => {
      const c = ctx();
      if (c && isObject(payload)) c.room.restartVote(c.slot, payload.mode === 'retry' ? 'retry' : 'new');
    });

    socket.on('game:toLobby', () => {
      const c = ctx();
      if (c && c.room.phase !== 'lobby') c.room.toLobby(`${c.slot.name} returned to the lobby`);
    });

    // --- high-frequency binary state --------------------------------------------
    socket.on('car:state', (data) => {
      const c = ctx();
      if (!c || !limiter.allow('car', 40, 50)) return;
      const buf = readFloat32(data, CAR.LENGTH);
      if (buf) c.room.carState(c.slot, buf);
    });

    socket.on('cabin:state', (data) => {
      const c = ctx();
      if (!c || !limiter.allow('cabin', 30, 40)) return;
      const buf = readFloat32(data, CABIN.LENGTH);
      if (buf) c.room.cabinState(c.slot, buf);
    });

    socket.on('props:state', (data) => {
      const c = ctx();
      if (!c || !limiter.allow('props', 15, 20)) return;
      const buf = readFloat32(data);
      if (!buf) return;
      const n = buf[0] | 0;
      if (n < 0 || n > MAX_PROPS_PER_MSG || buf.length !== 1 + n * PROP_STRIDE) return;
      for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i])) return;
      c.room.propsState(c.slot, buf);
    });

    // --- discrete gameplay events -----------------------------------------------
    socket.on('car:reset', () => {
      const c = ctx();
      if (c && limiter.allow('reset', 1, 2)) c.room.reset(c.slot);
    });

    socket.on('event:impact', (r) => {
      const c = ctx();
      if (!c || !isObject(r) || !limiter.allow('impact', 10, 10)) return;
      if (![r.strength, r.dx, r.dy, r.dz].every(finite) || typeof r.kind !== 'string') return;
      c.room.impact(c.slot, r);
    });

    socket.on('event:mud', (r) => {
      const c = ctx();
      if (!c || !isObject(r) || !limiter.allow('mud', 6, 6)) return;
      if ((r.kind !== 'puddle' && r.kind !== 'dirt') || !finite(r.amount)) return;
      if (r.puddle !== undefined && !finite(r.puddle)) return;
      c.room.mud(c.slot, r);
    });

    socket.on('event:wipe', (p) => {
      const c = ctx();
      if (c && isObject(p) && finite(p.u) && finite(p.v) && limiter.allow('wipe', 15, 15)) c.room.wipe(c.slot, p.u, p.v);
    });

    socket.on('event:tabletDrop', () => {
      const c = ctx();
      if (c && limiter.allow('drop', 2, 2)) c.room.tabletDrop(c.slot);
    });

    socket.on('door:close', (p) => {
      const c = ctx();
      if (c && isObject(p) && isDoorSide(p.side) && limiter.allow('door', 4, 4)) c.room.closeDoor(c.slot, p.side);
    });

    socket.on('wipers:set', (p) => {
      const c = ctx();
      if (c && isObject(p) && limiter.allow('wipers', 5, 5)) c.room.wipers(c.slot, p.on === true);
    });

    socket.on('tablet:grab', (p) => {
      const c = ctx();
      if (c && isObject(p) && limiter.allow('grab', 10, 10)) c.room.tabletGrab(c.slot, p.held === true);
    });

    socket.on('callout', (p) => {
      const c = ctx();
      if (!c || !isObject(p) || typeof p.id !== 'string' || !limiter.allow('callout', 4, 4)) return;
      c.room.callout(c.slot, p.id as CalloutId, typeof p.text === 'string' ? p.text : undefined);
    });

    // --- voice chat signalling -------------------------------------------------------
    socket.on('voice:enabled', (p) => {
      const c = ctx();
      if (c && isObject(p)) c.room.setVoice(c.slot, p.enabled === true);
    });

    socket.on('voice:signal', (p) => {
      const c = ctx();
      if (!c || !isObject(p) || !limiter.allow('voice', 40, 60) || !isSmallJson(p.data)) return;
      c.room.relayVoice(c.slot, p.data);
    });

    socket.on('disconnect', () => {
      const c = ctx();
      if (c) c.room.detach(c.slot, false);
    });
  });
}

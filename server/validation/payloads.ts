// Input sanitisation for everything a client can send.

import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH, STAGE_LENGTHS, type StageLength } from '../../src/shared/constants';
import type { DoorSide, Role } from '../../src/shared/types';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Player';
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f<>&"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned || 'Player';
}

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export const isRole = (v: unknown): v is Role => v === 'driver' || v === 'navigator';
export const isDoorSide = (v: unknown): v is DoorSide => v === 'left' || v === 'right';
export const isStageLength = (v: unknown): v is StageLength => typeof v === 'string' && v in STAGE_LENGTHS;
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
export const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isSmallJson(v: unknown, maxBytes = 24000): boolean {
  try {
    return JSON.stringify(v).length <= maxBytes;
  } catch {
    return false;
  }
}

/** Simple per-socket token bucket used to cap high-frequency messages. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  allow(key: string, perSecond: number, burst = perSecond): boolean {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { tokens: burst, at: now }));
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

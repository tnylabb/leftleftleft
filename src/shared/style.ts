// Personal style: helmet, race suit, skin tone, face and the car livery.
// Shared by client (visuals, lobby pickers) and server (validation / sync).

export interface PlayerStyle {
  helmet: number;
  suit: number;
  skin: number;
  face: number;
  livery: number;
}

export interface HelmetLook {
  name: string;
  base: number;
  stripe: number;
}

export interface SuitLook {
  name: string;
  base: number;
  /** Side panels, collar, cuffs. */
  accent: number;
  /** Belt, boots trim, gloves. */
  trim: number;
}

export interface LiveryLook {
  name: string;
  body: number;
  stripeA: number;
  stripeB: number;
  /** Rims, wing end plates, light pod. */
  accent: number;
  number: number;
}

export const HELMETS: HelmetLook[] = [
  { name: 'Signal Orange', base: 0xe8742b, stripe: 0xf4f1e8 },
  { name: 'Bone White', base: 0xece6d8, stripe: 0xc8372d },
  { name: 'Canary', base: 0xf2c230, stripe: 0x1d1d1f },
  { name: 'Racing Red', base: 0xc8372d, stripe: 0xf4f1e8 },
  { name: 'Petrol Blue', base: 0x2b6f9e, stripe: 0xf2c230 },
  { name: 'Moss', base: 0x4f7a3a, stripe: 0xece6d8 },
  { name: 'Midnight', base: 0x22252c, stripe: 0xe8742b },
  { name: 'Bubblegum', base: 0xe57aa6, stripe: 0xf4f1e8 },
];

export const SUITS: SuitLook[] = [
  { name: 'Works Blue', base: 0x2b4f91, accent: 0xf2c230, trim: 0x1d1d1f },
  { name: 'Forest', base: 0x3d7a3a, accent: 0xece6d8, trim: 0x1d1d1f },
  { name: 'Overall Grey', base: 0x8c8a82, accent: 0xe8742b, trim: 0x2a2a2c },
  { name: 'Fire Red', base: 0xb8322a, accent: 0xece6d8, trim: 0x1d1d1f },
  { name: 'Snow', base: 0xe9e5dc, accent: 0x2b6f9e, trim: 0xc8372d },
  { name: 'Black Gold', base: 0x232327, accent: 0xd9a92e, trim: 0xd9a92e },
  { name: 'Tangerine', base: 0xe8742b, accent: 0x1d1d1f, trim: 0xf4f1e8 },
  { name: 'Lilac', base: 0x8a76c4, accent: 0xf2c230, trim: 0x2a2a2c },
];

export const SKINS: number[] = [0xf3cfae, 0xe0ad84, 0xc48a5d, 0x93613e, 0x684129];

export const FACES: string[] = ['Plain', 'Moustache', 'Shades', 'Beard', 'Monobrow'];

export const LIVERIES: LiveryLook[] = [
  { name: 'Faded Tomato', body: 0xc4553a, stripeA: 0xf2e7cf, stripeB: 0x2a2a2c, accent: 0xd9d4c8, number: 0x1d1d1f },
  { name: 'White Lightning', body: 0xece6d8, stripeA: 0xc8372d, stripeB: 0xe8a33a, accent: 0xd9a92e, number: 0x1d1d1f },
  { name: 'Petrol & Orange', body: 0x7fb4d8, stripeA: 0xe8742b, stripeB: 0x1d3c5a, accent: 0xece6d8, number: 0x1d1d1f },
  { name: 'Classic Stripes', body: 0xf0ede6, stripeA: 0x1f4f8f, stripeB: 0xc8372d, accent: 0x9a9a9a, number: 0x1d1d1f },
  { name: 'Black & Gold', body: 0x1f1f23, stripeA: 0xd9a92e, stripeB: 0xd9a92e, accent: 0xd9a92e, number: 0xd9a92e },
  { name: 'Forest Green', body: 0x2f5e3a, stripeA: 0xf2c230, stripeB: 0xece6d8, accent: 0xece6d8, number: 0x1d1d1f },
  { name: 'Banana', body: 0xf2c230, stripeA: 0x1d1d1f, stripeB: 0x1d1d1f, accent: 0x1d1d1f, number: 0x1d1d1f },
  { name: 'Primer', body: 0x7c7f7a, stripeA: 0xe8742b, stripeB: 0x5a5d58, accent: 0x2a2a2c, number: 0xe8742b },
];

export const STYLE_LIMITS: Record<keyof PlayerStyle, number> = {
  helmet: HELMETS.length,
  suit: SUITS.length,
  skin: SKINS.length,
  face: FACES.length,
  livery: LIVERIES.length,
};

const KEYS = Object.keys(STYLE_LIMITS) as (keyof PlayerStyle)[];

export const DEFAULT_STYLE: PlayerStyle = { helmet: 0, suit: 0, skin: 1, face: 0, livery: 0 };

/** Defaults by role for players who never picked (and the AI co-driver). */
export const ROLE_STYLE: Record<'driver' | 'navigator', PlayerStyle> = {
  driver: { helmet: 1, suit: 0, skin: 1, face: 1, livery: 0 },
  navigator: { helmet: 2, suit: 1, skin: 2, face: 2, livery: 0 },
};

/** Returns a valid style from untrusted input (null if it isn't one). */
export function sanitizeStyle(v: unknown): PlayerStyle | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out = { ...DEFAULT_STYLE };
  for (const k of KEYS) {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n >= STYLE_LIMITS[k]) return null;
    out[k] = n;
  }
  return out;
}

export function encodeStyle(s: PlayerStyle): string {
  return KEYS.map((k) => s[k]).join('.');
}

export function decodeStyle(text: string): PlayerStyle | null {
  const parts = text.split('.').map((p) => Number(p));
  if (parts.length !== KEYS.length) return null;
  return sanitizeStyle(Object.fromEntries(KEYS.map((k, i) => [k, parts[i]])));
}

export function randomStyle(rand: () => number = Math.random): PlayerStyle {
  const out = { ...DEFAULT_STYLE };
  for (const k of KEYS) out[k] = Math.floor(rand() * STYLE_LIMITS[k]);
  return out;
}

export function sameStyle(a: PlayerStyle, b: PlayerStyle): boolean {
  return KEYS.every((k) => a[k] === b[k]);
}

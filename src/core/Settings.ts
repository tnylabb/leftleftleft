// Persistent player settings (localStorage).

import { decodeStyle, DEFAULT_STYLE, encodeStyle, randomStyle, type PlayerStyle } from '../shared/style';

export type Quality = 'low' | 'medium' | 'high';

export interface SettingsData {
  name: string;
  /** Your look (helmet.suit.skin.face.livery), see shared/style. */
  style: string;
  /** Background music volume (menu / lobby and on the stage). */
  musicVolume: number;
  masterVolume: number;
  engineVolume: number;
  environmentVolume: number;
  collisionVolume: number;
  voiceVolume: number;
  uiVolume: number;
  mouseSensitivity: number;
  invertY: boolean;
  fov: number;
  cameraShake: number;
  quality: Quality;
  tts: boolean;
  autoCallouts: boolean;
  subtitles: boolean;
  showFps: boolean;
  recenterView: boolean;
  pushToTalk: boolean;
}

const DEFAULTS: SettingsData = {
  name: '',
  style: '',
  musicVolume: 0.35,
  masterVolume: 0.8,
  engineVolume: 0.8,
  environmentVolume: 0.7,
  collisionVolume: 0.9,
  voiceVolume: 1,
  uiVolume: 0.6,
  mouseSensitivity: 1,
  invertY: false,
  fov: 66,
  cameraShake: 1,
  quality: 'medium',
  tts: true,
  autoCallouts: true,
  subtitles: true,
  showFps: false,
  recenterView: true,
  pushToTalk: false,
};

const KEY = 'lll.settings.v1';

export class Settings {
  data: SettingsData;
  private listeners = new Set<(s: SettingsData) => void>();

  constructor() {
    this.data = { ...DEFAULTS };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SettingsData>;
        for (const k of Object.keys(DEFAULTS) as (keyof SettingsData)[]) {
          if (parsed[k] !== undefined && typeof parsed[k] === typeof DEFAULTS[k]) {
            (this.data as unknown as Record<string, unknown>)[k] = parsed[k];
          }
        }
      }
    } catch {
      /* storage unavailable - keep defaults */
    }
    // keep a generated name: it is your name tag in the lobby
    if (!this.data.name) this.set('name', randomName());
    // and a random look to start with
    if (!decodeStyle(this.data.style)) this.set('style', encodeStyle(randomStyle()));
  }

  get style(): PlayerStyle {
    return decodeStyle(this.data.style) ?? { ...DEFAULT_STYLE };
  }

  setStyle(style: PlayerStyle) {
    this.set('style', encodeStyle(style));
  }

  get<K extends keyof SettingsData>(k: K): SettingsData[K] {
    return this.data[k];
  }

  set<K extends keyof SettingsData>(k: K, v: SettingsData[K]) {
    this.data[k] = v;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* ignore */
    }
    for (const fn of this.listeners) fn(this.data);
  }

  onChange(fn: (s: SettingsData) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  reset() {
    const { name, style } = this.data;
    this.data = { ...DEFAULTS, name, style };
    this.set('name', name);
  }
}

function randomName(): string {
  const a = ['Gravel', 'Muddy', 'Sideways', 'Flat-Out', 'Lost', 'Panic', 'Turbo', 'Wobbly', 'Rusty', 'Dusty'];
  const b = ['Gus', 'Kimi', 'Petra', 'Colin', 'Mika', 'Sandy', 'Jo', 'Ari', 'Sam', 'Toni'];
  return `${a[Math.floor(Math.random() * a.length)]} ${b[Math.floor(Math.random() * b.length)]}`;
}

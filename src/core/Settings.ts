// Persistent player settings (localStorage).

export type Quality = 'low' | 'medium' | 'high';

export interface SettingsData {
  name: string;
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
  manualGearbox: boolean;
  showFps: boolean;
  recenterView: boolean;
  pushToTalk: boolean;
}

const DEFAULTS: SettingsData = {
  name: '',
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
  manualGearbox: false,
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
    if (!this.data.name) this.data.name = randomName();
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
    const name = this.data.name;
    this.data = { ...DEFAULTS, name };
    this.set('name', name);
  }
}

function randomName(): string {
  const a = ['Gravel', 'Muddy', 'Sideways', 'Flat-Out', 'Lost', 'Panic', 'Turbo', 'Wobbly', 'Rusty', 'Dusty'];
  const b = ['Gus', 'Kimi', 'Petra', 'Colin', 'Mika', 'Sandy', 'Jo', 'Ari', 'Sam', 'Toni'];
  return `${a[Math.floor(Math.random() * a.length)]} ${b[Math.floor(Math.random() * b.length)]}`;
}

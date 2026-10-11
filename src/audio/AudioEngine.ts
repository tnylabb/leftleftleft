// WebAudio context, mixing buses with independent volumes, and procedural
// one-shot helpers. Everything is synthesised - no audio assets needed.

import type { Settings } from '../core/Settings';

export type Bus = 'engine' | 'environment' | 'collisions' | 'voice' | 'ui';

export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  buses = {} as Record<Bus, GainNode>;
  noise!: AudioBuffer;
  private unlocked = false;
  private suspendedByGame = false;

  constructor(private settings: Settings) {
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    settings.onChange(() => this.applyVolumes());
  }

  get ready(): boolean {
    return !!this.ctx && this.unlocked;
  }

  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: 'interactive' });
      } catch {
        return;
      }
      const ctx = this.ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      comp.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.connect(comp);
      for (const b of ['engine', 'environment', 'collisions', 'voice', 'ui'] as Bus[]) {
        const g = ctx.createGain();
        g.connect(this.master);
        this.buses[b] = g;
      }
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended' && !this.suspendedByGame) this.ctx.resume().catch(() => undefined);
    this.unlocked = true;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings.data;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.masterVolume, t, 0.05);
    this.buses.engine.gain.setTargetAtTime(s.engineVolume, t, 0.05);
    this.buses.environment.gain.setTargetAtTime(s.environmentVolume, t, 0.05);
    this.buses.collisions.gain.setTargetAtTime(s.collisionVolume, t, 0.05);
    this.buses.voice.gain.setTargetAtTime(s.voiceVolume, t, 0.05);
    this.buses.ui.gain.setTargetAtTime(s.uiVolume, t, 0.05);
  }

  setPaused(paused: boolean) {
    if (!this.ctx) return;
    this.suspendedByGame = paused;
    if (paused) this.ctx.suspend().catch(() => undefined);
    else this.ctx.resume().catch(() => undefined);
  }

  noiseSource(loop = true): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = loop;
    src.loopStart = Math.random();
    return src;
  }

  private out(bus: Bus, pan: number): AudioNode {
    const ctx = this.ctx!;
    if (!pan) return this.buses[bus];
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.buses[bus]);
    return p;
  }

  /** Filtered noise burst (impacts, gravel, splashes, clicks). */
  burst(opts: { bus: Bus; duration: number; gain: number; freq: number; q?: number; type?: BiquadFilterType; pan?: number; attack?: number; delay?: number }) {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const src = this.noiseSource(false);
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.value = opts.freq;
    f.Q.value = opts.q ?? 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), t + (opts.attack ?? 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.duration);
    src.connect(f).connect(g).connect(this.out(opts.bus, opts.pan ?? 0));
    src.start(t, Math.random() * 1.5);
    src.stop(t + opts.duration + 0.05);
  }

  /** Pitched tone with optional sweep. */
  tone(opts: { bus: Bus; freq: number; endFreq?: number; duration: number; gain: number; type?: OscillatorType; pan?: number; delay?: number; attack?: number }) {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(opts.freq, t);
    if (opts.endFreq) o.frequency.exponentialRampToValueAtTime(Math.max(1, opts.endFreq), t + opts.duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.gain), t + (opts.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + opts.duration);
    o.connect(g).connect(this.out(opts.bus, opts.pan ?? 0));
    o.start(t);
    o.stop(t + opts.duration + 0.05);
  }

  // --- UI sounds ----------------------------------------------------------------
  uiClick() {
    this.tone({ bus: 'ui', freq: 900, endFreq: 600, duration: 0.06, gain: 0.25, type: 'triangle' });
  }
  uiHover() {
    this.tone({ bus: 'ui', freq: 1400, duration: 0.03, gain: 0.06, type: 'sine' });
  }
  uiError() {
    this.tone({ bus: 'ui', freq: 180, duration: 0.25, gain: 0.25, type: 'square' });
  }
  countdownBeep(final: boolean) {
    this.tone({ bus: 'ui', freq: final ? 1320 : 660, duration: final ? 0.5 : 0.22, gain: 0.35, type: 'square' });
  }
  chime() {
    [784, 988, 1319].forEach((f, i) => this.tone({ bus: 'ui', freq: f, duration: 0.3, gain: 0.2, type: 'triangle', delay: i * 0.08 }));
  }
  /** Short synthesised celebration for the stage finish: rising brass-ish stab + crowd swell. */
  fanfare() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => {
      this.tone({ bus: 'ui', freq: f, duration: i === 3 ? 1.1 : 0.22, gain: 0.16, type: 'sawtooth', delay: i * 0.12 });
      this.tone({ bus: 'ui', freq: f * 1.005, duration: i === 3 ? 1.1 : 0.22, gain: 0.1, type: 'square', delay: i * 0.12 });
    });
    this.tone({ bus: 'ui', freq: 784, duration: 1.0, gain: 0.1, type: 'triangle', delay: 0.48 });
    // distant crowd cheer
    this.burst({ bus: 'environment', duration: 2.2, gain: 0.22, freq: 1400, q: 0.5, attack: 0.5, delay: 0.25 });
    this.burst({ bus: 'environment', duration: 1.8, gain: 0.12, freq: 3200, q: 0.8, attack: 0.4, delay: 0.4 });
  }

  radioBlip() {
    this.burst({ bus: 'voice', duration: 0.08, gain: 0.18, freq: 2500, q: 0.8 });
    this.tone({ bus: 'voice', freq: 1100, duration: 0.05, gain: 0.08, type: 'square' });
  }
}

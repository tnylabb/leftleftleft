// Background music, synthesised like everything else (no audio files):
//  - "Service Park" (menu / garage / lobby / results): a laid-back 96 bpm
//    groove - electric-piano chords, round bass, soft swung drums and now and
//    then a little melody.
//  - "Stage Pressure" (on the stage): 138 bpm in E minor - pulsing bass,
//    dark pads, driving drums. The faster you go, the more it builds (16th
//    hats, an arpeggio, brighter pads, an extra kick).
// A look-ahead step sequencer schedules notes on the WebAudio clock; tracks
// crossfade. Everything goes through the 'music' bus (its own volume).

import type { AudioEngine } from './AudioEngine';

export type MusicTrack = 'lobby' | 'race';

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

interface Voice {
  out: GainNode;
}

export class Music {
  private track: MusicTrack | null = null;
  private voice: Voice | null = null;
  private step = 0;
  private nextTime = 0;
  private intensity = 0;
  private timer: number;

  constructor(private a: AudioEngine) {
    this.timer = window.setInterval(() => this.schedule(), 40);
  }

  /** Switches track with a crossfade (null = fade to silence). */
  play(track: MusicTrack | null) {
    if (track === this.track) return;
    this.track = track;
    const ctx = this.a.ctx;
    if (this.voice && ctx) {
      const g = this.voice.out.gain;
      g.cancelScheduledValues(ctx.currentTime);
      g.setValueAtTime(g.value, ctx.currentTime);
      g.linearRampToValueAtTime(0, ctx.currentTime + 1.6);
      const old = this.voice.out;
      window.setTimeout(() => old.disconnect(), 2500);
    }
    this.voice = null;
    this.step = 0;
  }

  /** 0..1, how hard the race music pushes (follows the car's speed). */
  setIntensity(k: number) {
    this.intensity += (Math.max(0, Math.min(1, k)) - this.intensity) * 0.05;
  }

  dispose() {
    window.clearInterval(this.timer);
    this.voice?.out.disconnect();
  }

  // ------------------------------------------------------------------ scheduler --
  private schedule() {
    const a = this.a;
    if (!a.ready || !this.track) return;
    const ctx = a.ctx!;
    if (!this.voice) {
      const out = ctx.createGain();
      out.gain.setValueAtTime(0, ctx.currentTime);
      out.gain.linearRampToValueAtTime(this.track === 'lobby' ? 2.2 : 1.3, ctx.currentTime + 2.5);
      out.connect(a.buses.music);
      this.voice = { out };
      this.nextTime = ctx.currentTime + 0.1;
    }
    // fell far behind (tab was asleep): skip ahead instead of a burst of notes
    if (this.nextTime < ctx.currentTime - 0.3) this.nextTime = ctx.currentTime + 0.05;
    const bpm = this.track === 'lobby' ? 96 : 138;
    const sixteenth = 60 / bpm / 4;
    while (this.nextTime < ctx.currentTime + 0.25) {
      // swing on the lobby groove: odd 16ths a little late
      const swing = this.track === 'lobby' && this.step % 2 === 1 ? sixteenth * 0.14 : 0;
      if (this.track === 'lobby') this.lobbyStep(this.step, this.nextTime + swing, sixteenth);
      else this.raceStep(this.step, this.nextTime, sixteenth);
      this.nextTime += sixteenth;
      this.step++;
    }
  }

  // ---------------------------------------------------------------- instruments --
  private tone(freq: number, t: number, dur: number, gain: number, o: { type?: OscillatorType; attack?: number; detune?: number; cutoff?: number; q?: number; sweep?: number } = {}) {
    const ctx = this.a.ctx!;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t);
    if (o.detune) osc.detune.value = o.detune;
    const g = ctx.createGain();
    const atk = o.attack ?? 0.008;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(dur, atk + 0.02));
    let node: AudioNode = osc;
    if (o.cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(o.cutoff, t);
      if (o.sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, o.sweep), t + dur);
      f.Q.value = o.q ?? 0.7;
      node.connect(f);
      node = f;
    }
    node.connect(g).connect(this.voice!.out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private noise(t: number, dur: number, gain: number, type: BiquadFilterType, freq: number, q = 0.8) {
    const ctx = this.a.ctx!;
    const src = this.a.noiseSource(false);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.voice!.out);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private kick(t: number, gain: number) {
    const ctx = this.a.ctx!;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(130, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(g).connect(this.voice!.out);
    osc.start(t);
    osc.stop(t + 0.35);
  }

  // ------------------------------------------------------------- "Service Park" --
  private lobbyStep(step: number, t: number, s16: number) {
    const bar = Math.floor(step / 16) % 4;
    const cycle = Math.floor(step / 64);
    const i = step % 16;
    // Fmaj7 - Em7 - Dm7 - Cmaj7
    const chords = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]];
    const roots = [41, 40, 38, 36];
    const ch = chords[bar];
    // electric piano: a soft pad at the top of the bar, stabs on the offbeats
    if (i === 0) for (const n of ch) this.tone(hz(n + 12), t, s16 * 14, 0.035, { type: 'triangle', attack: 0.04, cutoff: 1800 });
    if (i === 3 || i === 10 || (i === 14 && bar % 2 === 1)) {
      for (const n of ch) {
        this.tone(hz(n + 12), t, s16 * 2.2, 0.05, { type: 'sine' });
        this.tone(hz(n + 24), t, s16 * 1.2, 0.012, { type: 'sine' });
      }
    }
    // round bass
    const bassHits: Record<number, number> = { 0: 0, 6: 0, 8: 7, 11: 12, 14: 7 };
    if (i in bassHits) this.tone(hz(roots[bar] + bassHits[i]), t, s16 * (i === 0 ? 4 : 2), 0.16, { type: 'triangle', cutoff: 600 });
    // drums: soft kick, rim on 2 and 4, swung hats
    if (i === 0 || i === 7 || i === 10) this.kick(t, i === 0 ? 0.2 : 0.13);
    if (i === 4 || i === 12) this.noise(t, 0.09, 0.07, 'bandpass', 2000, 1.4);
    if (i % 2 === 0) this.noise(t, 0.03, i % 4 === 2 ? 0.035 : 0.018, 'highpass', 7500);
    // every other cycle: a little melody on a plucky triangle
    if (cycle % 2 === 1) {
      const melody: Record<number, number>[] = [
        { 0: 72, 3: 74, 6: 76, 10: 79, 14: 76 },
        { 2: 74, 6: 72, 10: 69 },
        { 0: 72, 4: 74, 8: 77, 12: 76 },
        { 0: 74, 8: 72 },
      ];
      const n = melody[bar][i];
      if (n) this.tone(hz(n), t, s16 * 3, 0.05, { type: 'triangle', cutoff: 2600 });
    }
  }

  // ------------------------------------------------------------ "Stage Pressure" --
  private raceStep(step: number, t: number, s16: number) {
    const k = this.intensity;
    const bar = Math.floor(step / 16) % 4;
    const cycle = Math.floor(step / 64);
    const i = step % 16;
    // Em - C - Am - B (the B major chord pulls back to E minor)
    const chords = [[52, 55, 59], [48, 52, 55], [45, 48, 52], [47, 51, 54]];
    const roots = [40, 36, 33, 35];
    const ch = chords[bar];
    // dark pads: detuned saws, opening up with speed
    if (i === 0) {
      for (const n of ch)
        for (const d of [-8, 8]) this.tone(hz(n + 12), t, s16 * 16, 0.022, { type: 'sawtooth', attack: 0.35, detune: d, cutoff: 700 + k * 1600, q: 0.9 });
    }
    // pulsing 16th bass with accents (octave jumps on the off-beats)
    const accent = i % 4 === 0 ? 1 : i % 4 === 3 ? 0.8 : 0.55;
    const oct = i === 6 || i === 14 ? 12 : 0;
    this.tone(hz(roots[bar] + oct), t, s16 * 0.9, 0.11 * accent, { type: 'sawtooth', cutoff: 380 + k * 420, sweep: 160, q: 2 });
    // drums: kick on the beat (and pushing at speed), snare on 2 and 4, hats, a crash each cycle
    if (i === 0 || i === 8 || (k > 0.55 && (i === 10 || i === 14))) this.kick(t, 0.36);
    if (i === 4 || i === 12) {
      this.noise(t, 0.16, 0.12, 'bandpass', 1500, 0.9);
      this.tone(190, t, 0.08, 0.06, { type: 'triangle' });
    }
    if (i % 2 === 0 || k > 0.45) this.noise(t, 0.035, (i % 4 === 2 ? 0.04 : 0.022) * (0.7 + k * 0.5), 'highpass', 8000);
    if (step % 64 === 0) this.noise(t, 1.4, 0.05, 'highpass', 5000, 0.5);
    // tom fill at the end of every other cycle
    if (bar === 3 && cycle % 2 === 1 && i >= 12) this.tone(220 - (i - 12) * 32, t, 0.18, 0.12, { type: 'sine' });
    // ostinato arpeggio once you're moving
    if (k > 0.3 && i % 2 === 0) {
      const n = ch[[0, 1, 2, 1][(i / 2) % 4]] + 24;
      this.tone(hz(n), t, s16 * 1.6, 0.03 * Math.min(1, (k - 0.3) * 2.5), { type: 'square', cutoff: 1800 + k * 1500 });
    }
  }
}

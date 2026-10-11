// Continuous car sounds (engine, road, gravel, tyre scrub, wind, wipers, horn)
// plus car-related one-shots (impacts, thumps, rattles, doors, splashes).

import type { AudioEngine } from './AudioEngine';

export interface CarAudioState {
  rpm: number;
  throttle: number;
  speed: number;
  slip: number;
  surface: number; // 0 road (gravel), 1 grass, 2 mud
  airborne: boolean;
  limiter: boolean;
  shifting: boolean;
  doorOpen: number; // 0..2 open doors
  wipers: boolean;
  horn: boolean;
  rough: number;
  /** -1 left .. 1 right: listener seat (driver left, navigator right). */
  listenerX: number;
}

/**
 * One crank revolution of a 4-cylinder engine as a harmonic spectrum (index =
 * multiples of the crank frequency): the firing order (2nd) dominates, a soft
 * half-order rumble from uneven cylinders, and harmonics that roll off fast -
 * no raw saw / square edges, so it hums and growls instead of buzzing.
 */
function engineWave(ctx: AudioContext): PeriodicWave {
  const n = 40;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  const amp: Record<number, number> = { 1: 0.32, 2: 1, 3: 0.22, 4: 0.46, 5: 0.1, 6: 0.22, 8: 0.12 };
  for (let k = 1; k < n; k++) {
    const a = amp[k] ?? (k % 2 === 0 ? 0.5 : 0.18) / Math.pow(k, 1.45);
    // fixed pseudo-random phases: a pulse-like, slightly lumpy waveform
    const ph = (k * 2.399) % (Math.PI * 2);
    real[k] = a * Math.cos(ph);
    imag[k] = a * Math.sin(ph);
  }
  return ctx.createPeriodicWave(real, imag);
}

export class CarAudio {
  private started = false;
  private oscA!: OscillatorNode;
  private engineFilter!: BiquadFilterNode;
  private engineGain!: GainNode;
  private intakeGain!: GainNode;
  private intakeFilter!: BiquadFilterNode;
  private roadGain!: GainNode;
  private roadFilter!: BiquadFilterNode;
  private gravelGain!: GainNode;
  private scrubGain!: GainNode;
  private squealOsc!: OscillatorNode;
  private squealGain!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private wiperGain!: GainNode;
  private hornGain!: GainNode;
  private crackleTimer = 0;
  private gravelTimer = 0;
  /** Seconds since the throttle was lifted at high revs (lift-off pops fade out). */
  private liftTime = 9;
  private prevThrottle = 0;

  constructor(private a: AudioEngine) {}

  private start() {
    const a = this.a;
    const ctx = a.ctx!;
    // engine: a combustion-like spectrum (no detuned copies: they beat into a slow "wah-wah")
    // -> gentle saturation -> smooth (non-resonant) low-pass -> exhaust boom -> top-end cut
    this.oscA = ctx.createOscillator();
    this.oscA.setPeriodicWave(engineWave(ctx));
    const gA = ctx.createGain();
    gA.gain.value = 0.9;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 1.3) / Math.tanh(1.3);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    // uneven combustion: slow random wobble of the level (a running engine, not a drone)
    const rough = ctx.createGain();
    rough.gain.value = 1;
    const wobble = a.noiseSource();
    const wobbleFilter = ctx.createBiquadFilter();
    wobbleFilter.type = 'lowpass';
    wobbleFilter.frequency.value = 22;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 0.055;
    wobble.connect(wobbleFilter).connect(wobbleDepth).connect(rough.gain);
    wobble.start();
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 0.55;
    const boom = ctx.createBiquadFilter();
    boom.type = 'peaking';
    boom.frequency.value = 140;
    boom.Q.value = 0.9;
    boom.gain.value = 5;
    const topCut = ctx.createBiquadFilter();
    topCut.type = 'highshelf';
    topCut.frequency.value = 2400;
    topCut.gain.value = -10;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.oscA.connect(gA).connect(shaper);
    shaper.connect(rough).connect(this.engineFilter).connect(boom).connect(topCut).connect(this.engineGain).connect(a.buses.engine);
    // intake noise
    const intake = a.noiseSource();
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.Q.value = 0.8;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    intake.connect(this.intakeFilter).connect(this.intakeGain).connect(a.buses.engine);

    // road rumble
    const road = a.noiseSource();
    this.roadFilter = ctx.createBiquadFilter();
    this.roadFilter.type = 'lowpass';
    this.roadFilter.frequency.value = 300;
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;
    road.connect(this.roadFilter).connect(this.roadGain).connect(a.buses.environment);
    // gravel hiss
    const gravel = a.noiseSource();
    const gf = ctx.createBiquadFilter();
    gf.type = 'highpass';
    gf.frequency.value = 2600;
    this.gravelGain = ctx.createGain();
    this.gravelGain.gain.value = 0;
    gravel.connect(gf).connect(this.gravelGain).connect(a.buses.environment);
    // tyre scrub + squeal
    const scrub = a.noiseSource();
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.value = 1100;
    sf.Q.value = 2;
    this.scrubGain = ctx.createGain();
    this.scrubGain.gain.value = 0;
    scrub.connect(sf).connect(this.scrubGain).connect(a.buses.environment);
    this.squealOsc = ctx.createOscillator();
    this.squealOsc.type = 'triangle';
    this.squealOsc.frequency.value = 720;
    const vib = ctx.createOscillator();
    vib.frequency.value = 9;
    const vibGain = ctx.createGain();
    vibGain.gain.value = 25;
    vib.connect(vibGain).connect(this.squealOsc.frequency);
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealOsc.connect(this.squealGain).connect(a.buses.environment);
    // wind
    const wind = a.noiseSource();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 600;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(a.buses.environment);
    // wiper motor
    const wm = ctx.createOscillator();
    wm.type = 'sawtooth';
    wm.frequency.value = 55;
    const wmf = ctx.createBiquadFilter();
    wmf.type = 'lowpass';
    wmf.frequency.value = 220;
    this.wiperGain = ctx.createGain();
    this.wiperGain.gain.value = 0;
    wm.connect(wmf).connect(this.wiperGain).connect(a.buses.environment);
    // horn (two-tone)
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    const hf = ctx.createBiquadFilter();
    hf.type = 'lowpass';
    hf.frequency.value = 1800;
    hf.connect(this.hornGain).connect(a.buses.environment);
    for (const f of [415, 520]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(hf);
      o.start();
    }

    for (const n of [this.oscA, this.squealOsc, vib, wm]) n.start();
    for (const n of [intake, road, gravel, scrub, wind]) n.start();
    this.started = true;
  }

  update(dt: number, s: CarAudioState) {
    if (!this.a.ready) return;
    if (!this.started) this.start();
    const ctx = this.a.ctx!;
    const t = ctx.currentTime;
    const tc = 0.05;
    // crank frequency (the wave's 2nd harmonic is the 4-cylinder firing frequency)
    const crank = Math.max(10, s.rpm / 60);
    this.oscA.frequency.setTargetAtTime(crank, t, 0.04);
    const load = s.shifting ? 0.15 : s.throttle;
    const rev = Math.min(1, s.rpm / 7400);
    // brighter and louder under load, mellow when cruising or coasting
    this.engineFilter.frequency.setTargetAtTime(380 + load * 900 + rev * 900, t, tc);
    let eg = 0.22 + load * 0.24 + rev * 0.16;
    if (s.limiter && Math.floor(t * 16) % 2 === 0) eg *= 0.6;
    this.engineGain.gain.setTargetAtTime(eg, t, 0.04);
    this.intakeFilter.frequency.setTargetAtTime(320 + s.rpm * 0.11, t, tc);
    this.intakeGain.gain.setTargetAtTime(load * rev * 0.09, t, tc);

    const sp = Math.min(1, s.speed / 35);
    const grounded = s.airborne ? 0 : 1;
    this.roadFilter.frequency.setTargetAtTime(s.surface > 0.5 ? 220 : 380, t, 0.1);
    this.roadGain.gain.setTargetAtTime((0.05 + sp * 0.35 + s.rough * 0.25) * grounded, t, tc);
    this.gravelGain.gain.setTargetAtTime(sp * (s.surface < 0.5 ? 0.06 : 0.015) * grounded, t, tc);
    this.scrubGain.gain.setTargetAtTime(Math.min(1, s.slip) * 0.32 * grounded, t, 0.04);
    this.squealGain.gain.setTargetAtTime(s.surface < 0.5 ? Math.max(0, s.slip - 0.45) * 0.05 * grounded : 0, t, 0.04);
    const windAmt = sp * sp * 0.25 + s.doorOpen * sp * 0.35;
    this.windGain.gain.setTargetAtTime(windAmt, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(400 + sp * 900 + s.doorOpen * 1400, t, 0.1);
    this.wiperGain.gain.setTargetAtTime(s.wipers ? 0.045 : 0, t, 0.08);
    this.hornGain.gain.setTargetAtTime(s.horn ? 0.12 : 0, t, 0.01);

    // gravel stones pinging the underbody
    this.gravelTimer -= dt;
    if (grounded && s.surface < 0.5 && s.speed > 6 && this.gravelTimer <= 0) {
      this.gravelTimer = 0.03 + Math.random() * (0.6 / (1 + s.speed * 0.15));
      this.a.burst({ bus: 'environment', duration: 0.03, gain: 0.04 + Math.random() * 0.06, freq: 3000 + Math.random() * 3000, q: 4, pan: (Math.random() - 0.5) * 1.2 });
    }
    // a few soft exhaust pops right after lifting off at high revs, dying away
    if (this.prevThrottle > 0.5 && s.throttle < 0.1 && s.rpm > 4200) this.liftTime = 0;
    this.prevThrottle = s.throttle;
    this.liftTime += dt;
    this.crackleTimer -= dt;
    if (this.liftTime < 1.1 && s.throttle < 0.1 && this.crackleTimer <= 0) {
      this.crackleTimer = 0.12 + Math.random() * 0.35;
      if (Math.random() < 0.6 - this.liftTime * 0.45) {
        this.a.burst({ bus: 'engine', duration: 0.06, gain: 0.09, freq: 260 + Math.random() * 200, q: 1.2, type: 'lowpass', pan: -s.listenerX * 0.2 });
      }
    }
  }

  impact(strength: number, pan: number, kind: string) {
    const k = Math.min(1, strength / 10);
    this.a.tone({ bus: 'collisions', freq: 90, endFreq: 35, duration: 0.25 + k * 0.3, gain: 0.25 + k * 0.6, type: 'sine', pan });
    this.a.burst({ bus: 'collisions', duration: 0.12 + k * 0.4, gain: 0.25 + k * 0.6, freq: 700, q: 0.7, type: 'lowpass', pan });
    if (kind !== 'landing' && kind !== 'terrain') {
      this.a.tone({ bus: 'collisions', freq: 210 + Math.random() * 80, endFreq: 120, duration: 0.18 + k * 0.25, gain: 0.08 + k * 0.2, type: 'square', pan });
      this.a.burst({ bus: 'collisions', duration: 0.3, gain: 0.08 + k * 0.25, freq: 3200, q: 3, pan, delay: 0.02 });
    }
    if (kind === 'tree' || kind === 'bale') this.a.burst({ bus: 'collisions', duration: 0.4, gain: 0.15 * (0.5 + k), freq: 1800, q: 0.6, pan, delay: 0.05 });
  }

  thump(strength: number) {
    const k = Math.min(1, strength);
    this.a.tone({ bus: 'collisions', freq: 70, endFreq: 40, duration: 0.15, gain: 0.08 + k * 0.25, type: 'sine' });
  }

  clack(strength: number, pan: number) {
    this.a.burst({ bus: 'collisions', duration: 0.05 + strength * 0.05, gain: 0.05 + strength * 0.3, freq: 2200 + Math.random() * 1200, q: 3, pan });
    this.a.tone({ bus: 'collisions', freq: 600 + Math.random() * 500, duration: 0.05, gain: 0.03 + strength * 0.08, type: 'triangle', pan });
  }

  doorRattle(pan: number, strength: number) {
    this.a.burst({ bus: 'collisions', duration: 0.04, gain: 0.04 + strength * 0.06, freq: 1500 + Math.random() * 800, q: 5, pan });
  }

  doorBang(pan: number, strength: number) {
    this.a.tone({ bus: 'collisions', freq: 140, endFreq: 70, duration: 0.25, gain: 0.2 + strength * 0.3, type: 'square', pan });
    this.a.burst({ bus: 'collisions', duration: 0.2, gain: 0.2 + strength * 0.3, freq: 900, q: 0.8, pan });
  }

  doorSlam(pan: number) {
    this.a.tone({ bus: 'collisions', freq: 110, endFreq: 50, duration: 0.3, gain: 0.5, type: 'sine', pan });
    this.a.burst({ bus: 'collisions', duration: 0.15, gain: 0.35, freq: 1300, q: 1, pan });
  }

  wiperSqueak() {
    this.a.tone({ bus: 'environment', freq: 1250, endFreq: 950, duration: 0.14, gain: 0.03, type: 'triangle' });
  }

  splash(amount: number) {
    this.a.burst({ bus: 'collisions', duration: 0.5 + amount * 0.4, gain: 0.25 + amount * 0.35, freq: 500, q: 0.6, type: 'lowpass' });
    this.a.burst({ bus: 'collisions', duration: 0.35, gain: 0.15 + amount * 0.2, freq: 2400, q: 1.2, delay: 0.04 });
  }

  rustle(amount: number) {
    this.a.burst({ bus: 'environment', duration: 0.25, gain: 0.06 + amount * 0.12, freq: 3500, q: 0.8 });
  }
}

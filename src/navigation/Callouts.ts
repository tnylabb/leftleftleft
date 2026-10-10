// Navigator callouts: quick-shout hotkeys, spoken subtitles (Web Speech API)
// and the AI co-driver used in solo practice.

import type { Settings } from '../core/Settings';
import { ROAD_SAMPLE_SPACING } from '../shared/constants';
import { computeInstruction, spokenNote } from '../shared/stage/pacenotes';
import type { CalloutId, CalloutMsg, StageData } from '../shared/types';

export const CALLOUT_TEXT: Record<CalloutId, string> = {
  left: 'LEFT!',
  left3: 'LEFT, LEFT, LEFT!',
  right: 'RIGHT!',
  right3: 'RIGHT, RIGHT, RIGHT!',
  otherLeft: 'NO, THE OTHER LEFT!',
  otherRight: 'NO, THE OTHER RIGHT!',
  brake: 'BRAKE!',
  straight: 'STRAIGHT!',
  missed: 'WE MISSED IT!',
  accelerating: 'WHY ARE YOU STILL ACCELERATING?!',
  jump: 'JUMP! HOLD ON!',
  wrongWay: 'WRONG WAY!',
  dropped: 'I DROPPED THE TABLET!',
  nice: 'NICE ONE!',
  ouch: 'OUCH!',
  note: '',
};

export const NAV_HOTKEYS: { code: string; key: string; id: CalloutId | 'other' }[] = [
  { code: 'Digit1', key: '1', id: 'left' },
  { code: 'Digit2', key: '2', id: 'left3' },
  { code: 'Digit3', key: '3', id: 'right' },
  { code: 'Digit4', key: '4', id: 'right3' },
  { code: 'Digit5', key: '5', id: 'brake' },
  { code: 'Digit6', key: '6', id: 'straight' },
  { code: 'Digit7', key: '7', id: 'other' },
  { code: 'Digit8', key: '8', id: 'missed' },
  { code: 'Digit9', key: '9', id: 'accelerating' },
  { code: 'Digit0', key: '0', id: 'jump' },
];

export function calloutText(msg: CalloutMsg): string {
  return msg.id === 'note' ? msg.text ?? '' : CALLOUT_TEXT[msg.id];
}

/** Text-to-speech for callouts (optional; falls back silently). */
export class Voice {
  private voice: SpeechSynthesisVoice | null = null;

  constructor(private settings: Settings) {
    if (typeof speechSynthesis === 'undefined') return;
    const pick = () => {
      const voices = speechSynthesis.getVoices();
      this.voice = voices.find((v) => /en[-_](GB|AU|IE)/i.test(v.lang)) ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
    };
    pick();
    speechSynthesis.addEventListener?.('voiceschanged', pick);
  }

  speak(text: string, urgent: boolean) {
    if (!this.settings.data.tts || typeof speechSynthesis === 'undefined' || !text) return;
    try {
      if (urgent) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.toLowerCase().replace(/!/g, '.'));
      if (this.voice) u.voice = this.voice;
      u.rate = urgent ? 1.45 : 1.25;
      u.pitch = urgent ? 1.25 : 1.05;
      u.volume = Math.min(1, this.settings.data.voiceVolume * this.settings.data.masterVolume);
      speechSynthesis.speak(u);
    } catch {
      /* speech unavailable */
    }
  }

  stop() {
    try {
      speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** Reads pace notes at the right moment from the real road (solo practice). */
export class AICoDriver {
  private called = new Set<number>();
  private calledJumps = new Set<number>();
  private finishCalled = false;
  private wasBlind = false;

  constructor(private stage: StageData) {}

  reset() {
    this.called.clear();
    this.calledJumps.clear();
    this.finishCalled = false;
  }

  /** Returns a note to say now (or null). `canSee` = the co-driver currently holds the tablet. */
  update(idx: number, speed: number, canSee: boolean): { text: string; urgent: boolean } | null {
    const st = this.stage;
    if (!canSee) {
      if (!this.wasBlind) {
        this.wasBlind = true;
        return { text: 'I DROPPED THE TABLET! YOU ARE ON YOUR OWN!', urgent: true };
      }
      return null;
    }
    if (this.wasBlind) {
      this.wasBlind = false;
      // skip notes we can no longer give in time
      for (const c of st.corners) if (c.entryIdx < idx + 8) this.called.add(c.id);
      return { text: 'GOT IT, GOT IT!', urgent: false };
    }
    const lead = Math.max(55, speed * 3.1 + 25);
    for (const j of st.jumps) {
      const d = (j.idx - idx) * ROAD_SAMPLE_SPACING;
      if (d > 0 && d < Math.max(40, speed * 2.4 + 15) && !this.calledJumps.has(j.idx)) {
        this.calledJumps.add(j.idx);
        return { text: 'JUMP! KEEP IT STRAIGHT!', urgent: true };
      }
    }
    const next = st.corners.find((c) => c.severity !== 'keep' && c.entryIdx > idx - 2 && !this.called.has(c.id));
    if (next) {
      const d = (next.entryIdx - idx) * ROAD_SAMPLE_SPACING;
      if (d < lead) {
        const ins = computeInstruction(st, idx, speed);
        this.called.add(next.id);
        if (next.into) {
          const after = st.corners.find((c) => c.id > next.id && c.severity !== 'keep');
          if (after) this.called.add(after.id);
        }
        const urgent = ins.brakeNow || next.severity === 'hairpin';
        return { text: (ins.brakeNow ? 'BRAKE! ' : '') + spokenNote({ ...ins, jumpAhead: null }), urgent };
      }
      return null;
    }
    const toFinish = (st.finishIdx - idx) * ROAD_SAMPLE_SPACING;
    if (!this.finishCalled && toFinish < 160) {
      this.finishCalled = true;
      return { text: 'FLAT OUT TO THE FINISH!', urgent: false };
    }
    return null;
  }
}

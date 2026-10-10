// Optional built-in voice chat: WebRTC audio between the two players with
// Socket.IO signalling ("perfect negotiation" pattern). Requires a secure
// context (https or localhost) for microphone access.

import type { Settings } from '../core/Settings';
import type { OnlineSession } from './OnlineSession';

type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };

export type VoiceState = 'off' | 'waiting' | 'connecting' | 'connected' | 'error';

export class VoiceChat {
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private audio = new Audio();
  private peerId: string | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  enabled = false;
  muted = false;
  state: VoiceState = 'off';
  error = '';
  private analyser: AnalyserNode | null = null;
  private levelData = new Uint8Array(64);
  onState: (s: VoiceState) => void = () => undefined;
  private unsub: (() => void)[] = [];

  constructor(
    private session: OnlineSession,
    private settings: Settings,
  ) {
    this.audio.autoplay = true;
    const sock = session.voiceSocket;
    const onPeer = (p: { peerId: string | null; enabled: boolean }) => this.onPeer(p.peerId);
    const onSignal = (p: { from: string; data: unknown }) => void this.onSignal(p.data as Signal);
    sock.on('voice:peer', onPeer);
    sock.on('voice:signal', onSignal);
    this.unsub.push(() => sock.off('voice:peer', onPeer), () => sock.off('voice:signal', onSignal));
    this.unsub.push(settings.onChange(() => this.applyVolume()));
  }

  static get supported(): boolean {
    return typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  private setState(s: VoiceState) {
    this.state = s;
    this.onState(s);
  }

  private applyVolume() {
    this.audio.volume = Math.min(1, this.settings.data.voiceVolume * this.settings.data.masterVolume);
    this.applyMute();
  }

  async enable() {
    if (this.enabled) return;
    if (!VoiceChat.supported || !window.isSecureContext) {
      this.error = 'Voice chat needs https:// or localhost. Use Discord or similar instead.';
      this.setState('error');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      this.error = 'Microphone permission denied';
      this.setState('error');
      return;
    }
    this.enabled = true;
    this.applyVolume();
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 128;
      src.connect(this.analyser);
    } catch {
      /* level meter is optional */
    }
    this.setState('waiting');
    this.session.voiceSocket.emit('voice:enabled', { enabled: true });
  }

  disable() {
    this.enabled = false;
    this.session.voiceSocket.emit('voice:enabled', { enabled: false });
    this.closePeer();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.setState('off');
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.applyMute();
  }

  /** Push-to-talk: transmit only while held (when enabled in settings). */
  setTalking(down: boolean) {
    if (!this.settings.data.pushToTalk) return;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = down && !this.muted));
  }

  private applyMute() {
    const ptt = this.settings.data.pushToTalk;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !this.muted && !ptt));
  }

  /** Microphone level 0..1 for the UI. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.levelData);
    let peak = 0;
    for (const v of this.levelData) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 64);
  }

  private onPeer(peerId: string | null) {
    if (!this.enabled) return;
    if (!peerId) {
      this.peerId = null;
      this.closePeer();
      this.setState('waiting');
      return;
    }
    if (this.peerId === peerId && this.pc) return;
    this.peerId = peerId;
    this.createPeer();
  }

  private get polite(): boolean {
    return (this.session.playerId ?? '') > (this.peerId ?? '');
  }

  private createPeer() {
    this.closePeer();
    const urls = ((import.meta.env.VITE_STUN_URLS as string | undefined) || 'stun:stun.l.google.com:19302')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const pc = new RTCPeerConnection({ iceServers: urls.length ? [{ urls }] : [] });
    this.pc = pc;
    this.setState('connecting');
    this.stream?.getTracks().forEach((t) => pc.addTrack(t, this.stream!));
    pc.ontrack = (e) => {
      this.audio.srcObject = e.streams[0];
      this.audio.play().catch(() => undefined);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send({ candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.setState('connected');
      else if (pc.connectionState === 'failed') {
        this.error = 'Voice connection failed (NAT?)';
        this.setState('error');
      }
    };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this.send({ description: pc.localDescription.toJSON() });
      } catch (err) {
        console.warn('[voice] negotiation', err);
      } finally {
        this.makingOffer = false;
      }
    };
  }

  private send(data: Signal) {
    this.session.voiceSocket.emit('voice:signal', { data });
  }

  private async onSignal(sig: Signal) {
    if (!this.enabled) return;
    if (!this.pc) this.createPeer();
    const pc = this.pc!;
    try {
      if (sig.description) {
        const collision = sig.description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await pc.setRemoteDescription(sig.description);
        if (sig.description.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription) this.send({ description: pc.localDescription.toJSON() });
        }
      } else if (sig.candidate) {
        try {
          await pc.addIceCandidate(sig.candidate);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('[voice] signal error', err);
    }
  }

  private closePeer() {
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.close();
      this.pc = null;
    }
    this.audio.srcObject = null;
  }

  dispose() {
    this.disable();
    for (const u of this.unsub) u();
  }
}

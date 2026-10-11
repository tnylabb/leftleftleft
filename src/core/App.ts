// Top-level flow: main menu -> (online lobby | local session) -> loading ->
// stage -> results -> restart / lobby / menu. Owns the render loop.

import { AudioEngine } from '../audio/AudioEngine';
import { Game, type GameMode } from '../game/Game';
import { LocalSession } from '../multiplayer/LocalSession';
import { OnlineSession } from '../multiplayer/OnlineSession';
import type { ConnectionStatus, GameSession } from '../multiplayer/Session';
import { VoiceChat } from '../multiplayer/VoiceChat';
import type { Renderer } from '../rendering/Renderer';
import type { StageLength } from '../shared/constants';
import type { RoomSnapshot, StageMap, StageParams } from '../shared/types';
import { UI } from '../ui/UI';
import { Input } from './Input';
import { Settings } from './Settings';

// Yield to the browser between loading steps. MessageChannel callbacks are not
// throttled in background tabs (unlike rAF / setTimeout), so a player who
// tabs away during loading doesn't stall the room.
const channel = new MessageChannel();
const yieldQueue: (() => void)[] = [];
channel.port1.onmessage = () => yieldQueue.shift()?.();
const nextFrame = () =>
  new Promise<void>((r) => {
    yieldQueue.push(r);
    channel.port2.postMessage(0);
  });

export class App {
  readonly settings = new Settings();
  readonly input: Input;
  readonly audio: AudioEngine;
  readonly ui: UI;
  private session: GameSession | null = null;
  private online: OnlineSession | null = null;
  private voice: VoiceChat | null = null;
  private game: Game | null = null;
  private mode: GameMode = 'solo';
  private menuLength: StageLength = 'medium';
  private menuNight = false;
  private menuMap: StageMap = 'countryside';
  private serverStatus: ConnectionStatus | 'checking' = 'checking';
  private loadToken = 0;
  private lastT = 0;
  private resultsShown = false;
  private lobbyMsg = '';
  private menuError = '';
  private unsub: (() => void)[] = [];
  private waitingBanner = false;

  constructor(
    private renderer: Renderer,
    uiRoot: HTMLElement,
  ) {
    this.input = new Input(renderer.canvas);
    this.audio = new AudioEngine(this.settings);
    this.ui = new UI(uiRoot, this.audio, this.settings);
    this.ui.onAction = (a, d, el) => this.onAction(a, d, el);
    renderer.applyQuality(this.settings.data.quality);
    // dev-only debug handle for testing from the console
    if (import.meta.env.DEV) (window as unknown as { __lll: App }).__lll = this;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') this.togglePause();
      // Tab = hold-to-show controls overlay in game; keep focus from jumping
      if (e.code === 'Tab' && this.game && this.input.gameplay) e.preventDefault();
      if (e.code === 'KeyT') this.voice?.setTalking(true);
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyT') this.voice?.setTalking(false);
    });
    renderer.canvas.addEventListener('click', () => {
      if (this.game?.wantsPointerLock && !this.ui.isShown('pause') && !this.ui.isShown('results')) this.input.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      // Esc while pointer-locked only releases the lock in most browsers: treat it as pause.
      if (!document.pointerLockElement && this.game?.wantsPointerLock && !this.game.isPaused && !this.ui.isShown('pause') && !this.ui.isShown('results')) {
        this.openPause();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.game && this.mode !== 'online' && !this.ui.isShown('pause')) this.openPause();
    });
  }

  private get isDriver(): boolean {
    return this.mode === 'solo' || (this.session?.localRoles.includes('driver') ?? false);
  }

  start() {
    this.showMenu();
    void this.checkServer();
    this.scheduleFrame();
  }

  private rafId = 0;
  private fallbackTimer = 0;

  /**
   * rAF drives the game, with a timer fallback for when the browser pauses rAF
   * (background tab, hidden pane) so an online driver's car keeps simulating.
   */
  private scheduleFrame() {
    this.rafId = requestAnimationFrame(this.loop);
    window.clearTimeout(this.fallbackTimer);
    this.fallbackTimer = window.setTimeout(() => {
      cancelAnimationFrame(this.rafId);
      this.loop(performance.now());
    }, 100);
  }

  private loop = (t: number) => {
    window.clearTimeout(this.fallbackTimer);
    const dt = this.lastT ? Math.max(0, (t - this.lastT) / 1000) : 0.016;
    this.lastT = t;
    try {
      if (this.game) {
        this.game.frame(dt);
        // results appear once the finish cinematic has played out
        if (this.game.phase === 'finished' && this.game.results && this.game.cinematicDone && !this.resultsShown) {
          this.resultsShown = true;
          this.showResults();
        }
        if (this.game.phase !== 'loading' && this.waitingBanner) {
          this.waitingBanner = false;
          this.ui.banner(null);
        }
      } else if (this.voice && this.ui.isShown('lobby')) this.ui.setMicLevel(this.voice.level());
    } catch (err) {
      console.error(err);
    }
    this.input.endFrame();
    this.scheduleFrame();
  };

  /**
   * Health check. A sleeping free-tier host (e.g. Render) takes up to a minute to
   * wake, so each attempt waits long enough, and an offline server is re-checked
   * every few seconds while the menu is open.
   */
  private async checkServer() {
    const base = ((import.meta.env.VITE_SERVER_URL as string | undefined) || '').replace(/\/+$/, '');
    let ok = false;
    try {
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 60000);
      const res = await fetch(`${base}/health`, { signal: ctrl.signal, cache: 'no-store' });
      window.clearTimeout(timer);
      ok = res.ok && (await res.json().catch(() => null))?.ok === true;
    } catch {
      ok = false;
    }
    const changed = this.serverStatus !== (ok ? 'online' : 'offline');
    this.serverStatus = ok ? 'online' : 'offline';
    if (changed && this.ui.isShown('menu')) this.showMenu();
    if (!ok) window.setTimeout(() => void this.checkServer(), 5000);
  }

  private savedSeatCode(): string | null {
    try {
      const raw = sessionStorage.getItem('lll.seat');
      return raw ? (JSON.parse(raw) as { code: string }).code : null;
    } catch {
      return null;
    }
  }

  private showMenu() {
    this.ui.hideAll();
    this.ui.hideHud();
    this.ui.renderMenu({ server: this.serverStatus, seat: this.serverStatus === 'online' ? this.savedSeatCode() : null, length: this.menuLength, night: this.menuNight, map: this.menuMap, error: this.menuError });
    this.menuError = '';
    this.ui.show('menu');
    this.input.gameplay = false;
  }

  // ================================================================ actions ==
  private onAction(action: string, data: DOMStringMap, el: HTMLElement) {
    switch (action) {
      case 'length':
        this.menuLength = (data.length as StageLength) ?? 'medium';
        this.showMenu();
        break;
      case 'time':
        this.menuNight = data.night === '1';
        this.showMenu();
        break;
      case 'map':
        this.menuMap = data.map === 'mountain' ? 'mountain' : 'countryside';
        this.showMenu();
        break;
      case 'create':
        void this.createOnline();
        break;
      case 'join':
        void this.joinOnline();
        break;
      case 'rejoin':
        void this.rejoinOnline();
        break;
      case 'couch':
        this.startLocal('couch');
        break;
      case 'solo':
        this.startLocal('solo');
        break;
      case 'settings':
        this.ui.renderSettings();
        this.ui.show('settings');
        break;
      case 'close-settings':
        this.ui.show('settings', false);
        break;
      case 'reset-settings':
        this.settings.reset();
        this.ui.renderSettings();
        break;
      case 'help':
        this.ui.show('help');
        break;
      case 'close-help':
        this.ui.show('help', false);
        break;
      // lobby
      case 'role':
        this.online?.setRole(data.role === 'driver' || data.role === 'navigator' ? data.role : null);
        break;
      case 'ready': {
        const me = this.online?.room?.players.find((p) => p.id === this.online?.playerId);
        this.online?.setReady(!me?.ready);
        break;
      }
      case 'stage':
        if (this.online?.room) {
          const st = this.online.room.stage;
          this.online.setStage((data.length as StageLength) ?? 'medium', st.seed, st.night, st.map);
        }
        break;
      case 'stage-time':
        if (this.online?.room) {
          const st = this.online.room.stage;
          this.online.setStage(st.length, st.seed, data.night === '1', st.map);
        }
        break;
      case 'stage-map':
        if (this.online?.room) {
          const st = this.online.room.stage;
          this.online.setStage(st.length, st.seed, st.night, data.map === 'mountain' ? 'mountain' : 'countryside');
        }
        break;
      case 'reroll':
        if (this.online?.room) {
          const st = this.online.room.stage;
          this.online.setStage(st.length, undefined, st.night, st.map);
        }
        break;
      case 'copy-code':
        void navigator.clipboard?.writeText(data.code ?? '').then(() => {
          el.querySelector('span')!.textContent = 'COPIED!';
        });
        break;
      case 'voice-on':
        void this.voice?.enable().then(() => this.renderLobby());
        break;
      case 'voice-off':
        this.voice?.disable();
        this.renderLobby();
        break;
      case 'voice-mute':
        this.voice?.setMuted(!this.voice.muted);
        this.renderLobby();
        break;
      case 'leave':
        this.quitToMenu();
        break;
      // pause / results
      case 'resume':
        this.closePause();
        break;
      case 'restart-retry':
      case 'restart-new':
        this.ui.show('pause', false);
        this.session?.restart(action === 'restart-retry' ? 'retry' : 'new');
        if (this.mode === 'online') {
          this.ui.toast('VOTE SENT - WAITING FOR YOUR PARTNER', 'info');
          if (this.game?.phase === 'finished' && this.game.results) this.showResults();
          else this.closePause();
        }
        break;
      case 'to-lobby':
        this.session?.toLobby();
        break;
      case 'quit':
        this.quitToMenu();
        break;
    }
  }

  // ================================================================= online ==
  private ensureOnline(): OnlineSession {
    if (!this.online) {
      this.online = new OnlineSession();
      this.session = this.online;
      this.mode = 'online';
      this.voice = new VoiceChat(this.online, this.settings);
      this.voice.onState = () => this.renderLobby();
      this.wireOnline(this.online);
    }
    return this.online;
  }

  private wireOnline(s: OnlineSession) {
    this.unsub.push(
      s.on('room', (room) => this.onRoom(room)),
      s.on('connection', () => {
        if (this.ui.isShown('lobby')) this.renderLobby();
      }),
      s.on('kicked', (reason) => {
        this.menuError = reason;
        this.quitToMenu();
      }),
      s.on('load', (p) => void this.startGame(p)),
      s.on('hint', (t) => {
        this.lobbyMsg = t;
        if (this.ui.isShown('lobby')) this.renderLobby();
      }),
    );
  }

  private async createOnline() {
    const { name } = this.ui.menuValues();
    try {
      const s = this.ensureOnline();
      const res = await s.createRoom(name);
      if (!res.ok) throw new Error(res.error ?? 'Could not create a room');
      this.showLobby();
    } catch (err) {
      this.failOnline(err);
    }
  }

  private async joinOnline() {
    const { name, code } = this.ui.menuValues();
    if (!/^[A-Za-z]{4}$/.test(code)) {
      this.menuError = 'Enter the 4-letter room code';
      this.audio.uiError();
      this.showMenu();
      return;
    }
    try {
      const s = this.ensureOnline();
      const res = await s.joinRoom(code, name);
      if (!res.ok) throw new Error(res.error ?? 'Could not join');
      this.showLobby();
      if (res.room && res.room.phase !== 'lobby') this.ui.setLoading(0.05, 'Rejoining the running stage…');
    } catch (err) {
      this.failOnline(err);
    }
  }

  private async rejoinOnline() {
    try {
      const s = this.ensureOnline();
      const res = await s.rejoin();
      if (!res.ok) throw new Error(res.error ?? 'That session is gone');
      this.showLobby();
    } catch (err) {
      this.failOnline(err);
    }
  }

  private failOnline(err: unknown) {
    this.audio.uiError();
    this.menuError = err instanceof Error ? err.message : String(err);
    this.teardownSession();
    this.showMenu();
  }

  private showLobby() {
    this.ui.hideAll();
    this.renderLobby();
    this.ui.show('lobby');
  }

  private renderLobby() {
    const s = this.online;
    if (!s?.room) return;
    const v = this.voice;
    this.ui.renderLobby(s.room, s.playerId, s.status, v ? { state: v.state, error: v.error, muted: v.muted } : null, this.lobbyMsg);
  }

  private onRoom(room: RoomSnapshot) {
    if (room.phase === 'lobby') {
      if (this.game) {
        this.disposeGame();
        this.showLobby();
      } else if (this.ui.isShown('lobby') || this.ui.isShown('results')) this.showLobby();
      else if (this.ui.isShown('loading')) this.showLobby();
      this.renderLobby();
    } else if (this.ui.isShown('lobby')) this.renderLobby();
    if (this.ui.isShown('results') && this.game?.results) this.showResults();
  }

  // ================================================================== local ==
  private startLocal(mode: 'couch' | 'solo') {
    this.teardownSession();
    this.mode = mode;
    const s = new LocalSession(mode === 'couch' ? ['driver', 'navigator'] : ['driver'], this.menuLength, this.menuNight, this.menuMap);
    this.session = s;
    this.unsub.push(s.on('load', (p) => void this.startGame(p)));
    s.start();
  }

  // =================================================================== game ==
  private async startGame(params: StageParams) {
    const session = this.session;
    if (!session) return;
    const token = ++this.loadToken;
    this.disposeGame();
    this.resultsShown = false;
    this.ui.hideAll();
    this.ui.hideHud();
    this.ui.setLoading(0, 'Preparing…');
    this.ui.show('loading');
    await nextFrame();
    const game = new Game({ renderer: this.renderer, input: this.input, settings: this.settings, audio: this.audio, ui: this.ui, session, mode: this.mode });
    let hash: number;
    try {
      hash = await game.load(params, async (f, text) => {
        this.ui.setLoading(f, text);
        await nextFrame();
      });
    } catch (err) {
      console.error(err);
      game.dispose();
      this.menuError = `Failed to build the stage: ${err instanceof Error ? err.message : err}`;
      this.quitToMenu();
      return;
    }
    if (token !== this.loadToken || this.session !== session) {
      game.dispose();
      return;
    }
    this.game = game;
    session.loaded(hash);
    this.ui.show('loading', false);
    this.ui.setupHud(game.hudViews);
    this.input.gameplay = true;
    if (game.phase === 'loading') {
      this.waitingBanner = true;
      this.ui.banner('WAITING FOR YOUR CO-DRIVER TO LOAD THE STAGE…');
    }
    if (this.isDriver && this.mode !== 'couch') this.ui.hint('CLICK THE SCREEN TO LOOK AROUND · HOLD TAB FOR CONTROLS', 5);
    if (this.mode === 'couch') this.ui.hint('DRIVER: WASD · NAVIGATOR: CLICK TO CAPTURE THE MOUSE · HOLD TAB FOR CONTROLS', 6);
    else if (!this.isDriver) this.ui.hint('CLICK TO CAPTURE THE MOUSE · AIM AT THE TABLET AND CLICK TO PICK IT UP · HOLD TAB FOR CONTROLS', 7);
    this.renderer.canvas.focus();
  }

  private disposeGame() {
    if (this.game) {
      this.game.dispose();
      this.game = null;
    }
    this.input.exitPointerLock();
    this.ui.hideHud();
    this.ui.cinematic(null);
    this.audio.setPaused(false);
  }

  private showResults() {
    const g = this.game;
    if (!g?.results) return;
    this.input.exitPointerLock();
    this.ui.cinematic(null);
    const room = this.online?.room;
    const me = this.online?.playerId ?? '';
    const partner = room?.players.find((p) => p.id !== me)?.id ?? '';
    this.ui.renderResults(g.results, this.mode, { mine: room?.restartVotes[me] ?? null, partner: room?.restartVotes[partner] ?? null });
    this.ui.show('results');
    this.input.gameplay = false;
  }

  private togglePause() {
    if (!this.game || this.ui.isShown('results') || this.ui.isShown('loading')) {
      if (this.ui.isShown('settings')) this.ui.show('settings', false);
      else if (this.ui.isShown('help')) this.ui.show('help', false);
      return;
    }
    if (this.ui.isShown('settings')) {
      this.ui.show('settings', false);
      return;
    }
    if (this.ui.isShown('pause')) this.closePause();
    else this.openPause();
  }

  private openPause() {
    if (!this.game) return;
    this.ui.renderPause(this.mode, this.mode === 'online');
    this.ui.show('pause');
    this.game.setPaused(true);
    this.input.exitPointerLock();
  }

  private closePause() {
    this.ui.show('pause', false);
    this.game?.setPaused(false);
    this.renderer.canvas.focus();
  }

  private teardownSession() {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.voice?.dispose();
    this.voice = null;
    if (this.online) {
      this.online.leave();
      this.online.close();
    }
    this.online = null;
    this.session = null;
  }

  private quitToMenu() {
    this.loadToken++;
    this.disposeGame();
    this.teardownSession();
    this.lobbyMsg = '';
    this.showMenu();
  }
}

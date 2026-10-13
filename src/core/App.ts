// Top-level flow: main menu -> (online lobby | local session) -> loading ->
// stage -> results -> restart / lobby / menu. Owns the render loop.

import { AudioEngine } from '../audio/AudioEngine';
import { Music } from '../audio/Music';
import { Game, type GameMode } from '../game/Game';
import { LocalSession } from '../multiplayer/LocalSession';
import { OnlineSession } from '../multiplayer/OnlineSession';
import type { ConnectionStatus, GameSession } from '../multiplayer/Session';
import { VoiceChat } from '../multiplayer/VoiceChat';
import type { Renderer } from '../rendering/Renderer';
import type { StageLength } from '../shared/constants';
import { randomStyle, ROLE_STYLE, sameStyle, STYLE_LIMITS, type PlayerStyle } from '../shared/style';
import { isDifficulty, type Difficulty } from '../shared/difficulty';
import { isRoomMode, MODE_SPEC, TEAM_COLORS, type Standings } from '../shared/modes';
import type { OpponentInfo } from '../game/Opponents';
import type { ProfileView } from '../ui/UI';
import { fetchProfile, protectName, savedCode, unlockName } from './Profiles';
import type { Role, RoomSnapshot, StageMap, StageParams } from '../shared/types';
import { LobbyScene } from '../ui/LobbyScene';
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
  private menuDifficulty: Difficulty = 'standard';
  private serverStatus: ConnectionStatus | 'checking' = 'checking';
  private loadToken = 0;
  private lastT = 0;
  private resultsShown = false;
  private lobbyMsg = '';
  private menuError = '';
  private unsub: (() => void)[] = [];
  private waitingBanner = false;
  /** 3D service park behind the main menu and the lobby. */
  private lobbyScene: LobbyScene;
  /** Where the look picker returns to. */
  private garageFrom: 'menu' | 'lobby' = 'menu';
  private music: Music;
  private profile: ProfileView | null = null;
  /** Versus: latest positions (results screen, HUD). */
  private standings: Standings | null = null;

  constructor(
    private renderer: Renderer,
    uiRoot: HTMLElement,
  ) {
    this.input = new Input(renderer.canvas);
    this.audio = new AudioEngine(this.settings);
    this.ui = new UI(uiRoot, this.audio, this.settings);
    this.ui.onAction = (a, d, el) => this.onAction(a, d, el);
    this.lobbyScene = new LobbyScene(renderer);
    this.music = new Music(this.audio);
    // your name tag follows the name field
    this.settings.onChange(() => {
      if (this.ui.isShown('menu')) this.showMenuScene();
    });
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
    this.updateMusic();
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
      } else {
        if (this.voice && this.ui.isShown('lobby')) this.ui.setMicLevel(this.voice.level());
        if (this.ui.isShown('menu') || this.ui.isShown('lobby') || this.ui.isShown('garage')) {
          this.lobbyScene.update(Math.min(dt, 0.1));
          // wide screens: the panel sits on the right, so push the scene to the left
          const wide = this.renderer.width > 900 && this.renderer.width / this.renderer.height > 1.15;
          this.lobbyScene.render(wide ? 0.16 : 0, wide ? 0 : 0.08);
        }
      }
    } catch (err) {
      console.error(err);
    }
    this.input.endFrame();
    this.scheduleFrame();
  };

  /** Lobby groove around the menus, the dramatic track on the stage (louder as you go faster). */
  private updateMusic() {
    const g = this.game;
    if (!g) this.music.play('lobby');
    else if (g.phase === 'countdown' || g.phase === 'racing') this.music.play('race');
    else this.music.play(this.resultsShown ? 'lobby' : null);
    this.music.setIntensity(g && g.phase === 'racing' ? g.cs.speed / 30 : 0);
  }

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
    this.ui.renderMenu({ server: this.serverStatus, seat: this.serverStatus === 'online' ? this.savedSeatCode() : null, length: this.menuLength, night: this.menuNight, map: this.menuMap, difficulty: this.menuDifficulty, error: this.menuError });
    this.menuError = '';
    this.ui.show('menu');
    this.input.gameplay = false;
    this.lobbyScene.setFocus(false);
    this.showMenuScene();
  }

  /** Main menu scene: just you, next to the car (in your livery), in the chosen stage's light. */
  private showMenuScene() {
    const style = this.settings.style;
    this.lobbyScene.setLook(this.menuMap, this.menuNight);
    this.lobbyScene.setCrews([{ livery: style.livery, slots: [{ name: this.settings.data.name, role: null, ready: false, me: true, connected: true, style, menu: true }] }]);
  }

  // =============================================================== profile ==
  private async openProfile(message: string | null = null, newCode: string | null = null) {
    const name = this.ui.menuValues().name;
    this.profile = { name, loading: true, error: null, profile: null, savedCode: savedCode(name), newCode, showCode: false, message };
    this.ui.renderProfile(this.profile);
    this.ui.show('profile');
    const r = await fetchProfile(name);
    if (!this.profile || this.profile.name !== name) return;
    this.profile.loading = false;
    if (r.ok) this.profile.profile = r.profile;
    else this.profile.error = r.error;
    this.ui.renderProfile(this.profile);
  }

  private async protectProfile(rotate: boolean) {
    const v = this.profile;
    if (!v) return;
    const r = await protectName(v.name, rotate ? (v.savedCode ?? undefined) : undefined);
    if ('code' in r) await this.openProfile(null, r.code);
    else await this.openProfile(r.error);
  }

  private async unlockProfile() {
    const v = this.profile;
    if (!v) return;
    const code = this.ui.profileCodeInput();
    if (!code) return;
    const ok = await unlockName(v.name, code);
    await this.openProfile(ok ? null : 'That recovery code does not match this name');
  }

  // ================================================================ garage ==
  private openGarage() {
    this.garageFrom = this.ui.isShown('lobby') ? 'lobby' : 'menu';
    if (this.garageFrom === 'menu') this.ui.menuValues(); // keep a freshly typed name
    this.ui.hideAll();
    this.renderGarage();
    this.ui.show('garage');
    this.lobbyScene.setFocus(true);
  }

  private renderGarage() {
    this.ui.renderGarage(this.settings.style, this.garageFrom === 'lobby');
    if (this.garageFrom === 'lobby') this.renderLobby();
    else this.showMenuScene();
  }

  private setStyle(style: PlayerStyle) {
    if (sameStyle(style, this.settings.style)) return;
    this.settings.setStyle(style);
    this.online?.setStyle(style);
    this.renderGarage();
  }

  private closeGarage() {
    this.lobbyScene.setFocus(false);
    if (this.garageFrom === 'lobby' && this.online?.room) this.showLobby();
    else this.showMenu();
  }

  /** Versus: the other crews' cars (looks, names, colours). */
  private opponentInfos(): OpponentInfo[] {
    const room = this.online?.room;
    const mine = this.online?.myTeam ?? null;
    if (this.mode !== 'online' || !room || !MODE_SPEC[room.mode].versus) return [];
    const out: OpponentInfo[] = [];
    for (let t = 0; t < MODE_SPEC[room.mode].teams; t++) {
      if (t === mine) continue;
      const crew = room.players.filter((p) => p.team === t).sort((a, b) => (a.role === 'driver' ? 0 : 1) - (b.role === 'driver' ? 0 : 1));
      if (!crew.length) continue;
      out.push({
        team: t,
        names: crew.map((p) => p.name),
        driver: crew.find((p) => p.role === 'driver')?.style ?? ROLE_STYLE.driver,
        navigator: crew.find((p) => p.role === 'navigator')?.style ?? ROLE_STYLE.navigator,
        color: TEAM_COLORS[t],
      });
    }
    return out;
  }

  /** Who looks like what on the stage. Local games: your partner (or the AI) gets a contrasting look. */
  private crewStyles(): Record<Role, PlayerStyle> {
    const room = this.online?.room;
    if (this.mode === 'online' && room) {
      const team = this.online?.myTeam ?? 0;
      const of = (r: Role) => room.players.find((pl) => pl.team === team && pl.role === r)?.style ?? ROLE_STYLE[r];
      return { driver: of('driver'), navigator: of('navigator') };
    }
    const mine = this.settings.style;
    const other = sameStyle(mine, ROLE_STYLE.navigator) ? ROLE_STYLE.driver : ROLE_STYLE.navigator;
    return { driver: mine, navigator: { ...other, livery: mine.livery } };
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
      case 'garage':
        this.openGarage();
        break;
      case 'difficulty':
        if (isDifficulty(data.difficulty)) this.menuDifficulty = data.difficulty;
        this.showMenu();
        break;
      case 'profile':
        void this.openProfile();
        break;
      case 'close-profile':
        this.ui.show('profile', false);
        break;
      case 'profile-protect':
      case 'profile-rotate':
        void this.protectProfile(action === 'profile-rotate');
        break;
      case 'profile-unlock':
        void this.unlockProfile();
        break;
      case 'profile-show-code':
        if (this.profile) {
          this.profile.showCode = !this.profile.showCode;
          this.ui.renderProfile(this.profile);
        }
        break;
      case 'mode':
        if (isRoomMode(data.mode)) this.online?.setMode(data.mode);
        break;
      case 'team':
        this.online?.setTeam(Number(data.team));
        break;
      case 'stage-difficulty':
        if (this.online?.room && isDifficulty(data.difficulty)) {
          const st = this.online.room.stage;
          this.online.setStage(st.length, st.seed, st.night, st.map, data.difficulty);
        }
        break;
      case 'style': {
        const key = data.key as keyof PlayerStyle;
        const value = Number(data.value);
        if (key in STYLE_LIMITS && Number.isInteger(value) && value >= 0 && value < STYLE_LIMITS[key]) this.setStyle({ ...this.settings.style, [key]: value });
        break;
      }
      case 'style-random':
        this.setStyle(randomStyle());
        break;
      case 'garage-done':
        this.closeGarage();
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
          this.online.setStage((data.length as StageLength) ?? 'medium', st.seed, st.night, st.map, st.difficulty);
        }
        break;
      case 'stage-time':
        if (this.online?.room) {
          const st = this.online.room.stage;
          this.online.setStage(st.length, st.seed, data.night === '1', st.map, st.difficulty);
        }
        break;
      case 'stage-map':
        if (this.online?.room) {
          const st = this.online.room.stage;
          this.online.setStage(st.length, st.seed, st.night, data.map === 'mountain' ? 'mountain' : 'countryside', st.difficulty);
        }
        break;
      case 'reroll':
        if (this.online?.room) {
          const st = this.online.room.stage;
          this.online.setStage(st.length, undefined, st.night, st.map, st.difficulty);
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
      this.online.style = this.settings.style;
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
      s.on('standings', (st) => {
        this.standings = st;
        if (this.ui.isShown('results')) this.showResults();
      }),
    );
  }

  private async createOnline() {
    const { name } = this.ui.menuValues();
    try {
      const s = this.ensureOnline();
      s.profileCode = savedCode(name);
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
      s.profileCode = savedCode(name);
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
    this.lobbyScene.setFocus(false);
    this.renderLobby();
    this.ui.show('lobby');
  }

  private renderLobby() {
    const s = this.online;
    if (!s?.room) return;
    const v = this.voice;
    this.ui.renderLobby(s.room, s.playerId, s.status, v ? { state: v.state, error: v.error, muted: v.muted } : null, this.lobbyMsg);
    // the crews in 3D: one car per crew, a ghost where a seat is still free,
    // the AI navigator next to each solo driver
    const room = s.room;
    this.lobbyScene.setLook(room.stage.map, room.stage.night);
    const spec = MODE_SPEC[room.mode];
    const myTeam = room.players.find((pl) => pl.id === s.playerId)?.team ?? null;
    const slotOf = (pl: RoomSnapshot['players'][number]) => {
      // your own look straight from the settings (the room echoes it back a moment later)
      const style = pl.id === s.playerId ? this.settings.style : pl.style;
      return { name: pl.name, role: pl.role, ready: pl.ready, me: pl.id === s.playerId, connected: pl.connected, style };
    };
    const crews = Array.from({ length: spec.teams }, (_, t) => {
      const members = room.players.filter((pl) => pl.team === t);
      const driver = members.find((pl) => pl.role === 'driver');
      const nav = members.find((pl) => pl.role === 'navigator');
      const extra = members.filter((pl) => pl !== driver && pl !== nav);
      const seats = [driver ?? extra.shift(), nav ?? extra.shift()];
      // the car wears its driver's livery (yours while you are picking one)
      const mine = t === myTeam && this.ui.isShown('garage');
      const livery = mine ? this.settings.style.livery : (driver ?? seats[0] ?? seats[1])?.style.livery ?? 0;
      const slots = [seats[0] ? slotOf(seats[0]) : null, seats[1] ? slotOf(seats[1]) : spec.crew === 1 ? { name: 'AI NAVIGATOR', role: 'navigator' as const, ready: true, me: false, connected: true, style: ROLE_STYLE.navigator, ai: true } : null];
      return { livery, slots };
    });
    this.lobbyScene.setCrews(crews);
  }

  private onRoom(room: RoomSnapshot) {
    if (room.phase === 'lobby') {
      if (this.game) {
        this.disposeGame();
        this.showLobby();
      } else if (this.ui.isShown('garage')) this.renderLobby();
      else if (this.ui.isShown('lobby') || this.ui.isShown('results')) this.showLobby();
      else if (this.ui.isShown('loading')) this.showLobby();
      this.renderLobby();
    } else if (this.ui.isShown('lobby') || this.ui.isShown('garage')) this.renderLobby();
    if (this.ui.isShown('results') && this.game?.results) this.showResults();
  }

  // ================================================================== local ==
  private startLocal(mode: 'couch' | 'solo') {
    this.teardownSession();
    this.mode = mode;
    const s = new LocalSession(mode === 'couch' ? ['driver', 'navigator'] : ['driver'], this.menuLength, this.menuNight, this.menuMap, undefined, this.menuDifficulty);
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
    this.standings = null;
    const game = new Game({
      renderer: this.renderer,
      input: this.input,
      settings: this.settings,
      audio: this.audio,
      ui: this.ui,
      session,
      mode: this.mode,
      crew: this.crewStyles(),
      aiNavigator: this.mode === 'online' && !!this.online?.aiNavigator,
      opponents: this.opponentInfos(),
      myTeam: this.online?.myTeam ?? null,
    });
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
    const others = room?.players.filter((p) => p.id !== me) ?? [];
    const otherVotes = others.map((p) => room?.restartVotes[p.id]).filter((v): v is 'retry' | 'new' => !!v);
    const partnerVote = others.length && otherVotes.length === others.length ? (otherVotes.includes('new') ? 'new' : 'retry') : null;
    this.ui.renderResults(g.results, this.mode, { mine: room?.restartVotes[me] ?? null, partner: partnerVote }, this.standings ?? g.standings, this.online?.myTeam ?? null);
    this.ui.show('results');
    this.input.gameplay = false;
  }

  private togglePause() {
    if (!this.game || this.ui.isShown('results') || this.ui.isShown('loading')) {
      if (this.ui.isShown('settings')) this.ui.show('settings', false);
      else if (this.ui.isShown('help')) this.ui.show('help', false);
      else if (this.ui.isShown('profile')) this.ui.show('profile', false);
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

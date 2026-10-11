// DOM overlay: menus, lobby, loading, HUD, pause, settings, help and results.
// Buttons use data-action attributes; the App handles them via `onAction`.

import type { AudioEngine } from '../audio/AudioEngine';
import type { Settings, SettingsData } from '../core/Settings';
import { GAME_TAGLINE, type StageLength } from '../shared/constants';
import { FACES, HELMETS, LIVERIES, SKINS, SUITS, type PlayerStyle } from '../shared/style';
import type { RaceResults, Role, RoomSnapshot, StageMap } from '../shared/types';
import type { ConnectionStatus } from '../multiplayer/Session';
import type { VoiceState } from '../multiplayer/VoiceChat';
import { NAV_HOTKEYS, CALLOUT_TEXT } from '../navigation/Callouts';
import type { BindMode } from '../core/Bindings';
import { referenceHtml, type Row } from './controlsHelp';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export type ScreenName = 'menu' | 'lobby' | 'garage' | 'loading' | 'pause' | 'settings' | 'help' | 'results' | 'fatal';

const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

export interface HudView {
  role: Role;
  rect: { x: number; y: number; w: number; h: number };
}

export interface HudData {
  speedKmh: number;
  gear: number;
  timeMs: number;
  cp: string;
  status: string | null;
  grip: number | null;
  warn: string | null;
  hover: { text: string; x: number; y: number } | null;
  /** Rows for the hold-Tab controls overlay (null = Tab not held). */
  tab: Row[] | null;
  /** 0..1 progress of holding the emergency-reset key. */
  resetHold: number;
  /** 0..1 head lamp glare (driver only). */
  glare: number;
  /** Driver / navigator view is showing an on-foot camera. */
  onFoot: boolean;
  /** Navigator interacting through the centre crosshair (mouse captured). */
  crosshair?: boolean;
}

const fmtTime = (ms: number) => {
  const t = Math.max(0, ms) / 1000;
  const m = Math.floor(t / 60);
  return `${m}:${(t % 60).toFixed(2).padStart(5, '0')}`;
};


export class UI {
  readonly root: HTMLElement;
  private screens = new Map<ScreenName, HTMLElement>();
  onAction: (action: string, data: DOMStringMap, el: HTMLElement) => void = () => undefined;
  private hud!: HTMLElement;
  private hudViews: HTMLElement[] = [];
  private subtitleTimer = 0;
  private hintTimer = 0;

  private lastHudKeys: string[] = [];

  constructor(
    root: HTMLElement,
    private audio: AudioEngine,
    private settings: Settings,
  ) {
    this.root = root;
    root.innerHTML = `
      <div class="screen scene-bg" id="scr-menu"></div>
      <div class="screen scene-bg" id="scr-lobby"></div>
      <div class="screen scene-bg" id="scr-garage"></div>
      <div class="screen menu-bg" id="scr-loading"></div>
      <div id="hud"></div>
      <div id="subtitle"></div>
      <div id="countdown"></div>
      <div id="cinematic"><div class="bar top"></div><div class="bar bottom"></div><div class="title"></div></div>
      <div id="toasts"></div>
      <div id="hint"></div>
      <div id="banner"></div>
      <div id="fps"></div>
      <div class="screen dim-bg" id="scr-pause"></div>
      <div class="screen dim-bg" id="scr-results"></div>
      <div class="screen dim-bg" id="scr-help"></div>
      <div class="screen dim-bg" id="scr-settings"></div>
      <div class="screen menu-bg fatal" id="scr-fatal"></div>`;
    for (const n of ['menu', 'lobby', 'garage', 'loading', 'pause', 'settings', 'help', 'results', 'fatal'] as ScreenName[]) {
      this.screens.set(n, root.querySelector(`#scr-${n}`) as HTMLElement);
    }
    this.hud = root.querySelector('#hud') as HTMLElement;
    root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!el || (el as HTMLButtonElement).disabled) return;
      this.audio.uiClick();
      this.onAction(el.dataset.action!, el.dataset, el);
    });
    root.addEventListener('mouseover', (e) => {
      const el = (e.target as HTMLElement).closest('.btn');
      if (el && !el.contains(e.relatedTarget as Node)) this.audio.uiHover();
    });
    root.addEventListener('keydown', (e) => {
      const t = e.target as HTMLInputElement;
      if (e.key === 'Enter' && t.dataset.enter) {
        this.audio.uiClick();
        this.onAction(t.dataset.enter, t.dataset, t);
      }
    });
    this.renderHelp();
  }

  show(name: ScreenName, on = true) {
    this.screens.get(name)!.classList.toggle('show', on);
  }

  hideAll() {
    for (const s of this.screens.values()) s.classList.remove('show');
  }

  isShown(name: ScreenName): boolean {
    return this.screens.get(name)!.classList.contains('show');
  }

  // --- menu ------------------------------------------------------------------
  renderMenu(opts: { server: ConnectionStatus | 'checking'; seat: string | null; length: StageLength; night: boolean; map: StageMap; error?: string }) {
    const s = this.screens.get('menu')!;
    const name = esc(this.settings.data.name);
    const statusText =
      opts.server === 'online' ? 'Game server online' : opts.server === 'checking' ? 'Connecting to the game server (waking it up can take up to a minute)…' : 'Game server offline – retrying…';
    const lenBtn = (l: StageLength, label: string) => `<button class="btn small ${opts.length === l ? 'selected' : ''}" data-action="length" data-length="${l}"><span>${label}</span></button>`;
    s.innerHTML = `
      <div class="menu-layout">
        <div class="menu-hero">
          <div>
            <h1 class="title"><span class="l1">LEFT!</span> <span class="l2">LEFT!</span><br><span class="l3">LEFT!</span></h1>
            <div class="tagline">${GAME_TAGLINE}</div>
          </div>
          <div class="hero-foot">
            <p class="blurb">An asymmetric co-op rally game. One player drives blind from the cockpit. The other holds a very
            real, very droppable navigation tablet and shouts directions.</p>
            <div class="chip"><span class="status-dot ${opts.server === 'checking' ? 'connecting' : opts.server}"></span>${statusText}</div>
          </div>
        </div>
        <div class="panel stack menu-panel">
          <h2 class="tape">START ENGINE</h2>
          <label class="field">Your name
            <input type="text" id="in-name" maxlength="16" value="${name}" data-enter="create">
          </label>
          <button class="btn look-btn" data-action="garage"><span>CHANGE YOUR LOOK<span class="sub">Helmet, race suit, face and the car's livery</span></span></button>
          <div class="error-box ${opts.error ? 'show' : ''}">${esc(opts.error ?? '')}</div>
          <div class="section-label">PLAY ONLINE</div>
          ${opts.seat ? `<button class="btn green" data-action="rejoin"><span>REJOIN ROOM ${esc(opts.seat)}<span class="sub">Get back into your running session</span></span></button>` : ''}
          <button class="btn primary big" data-action="create" ${opts.server !== 'online' ? 'disabled' : ''}><span>CREATE ONLINE GAME<span class="sub">Get a room code for your co-driver</span></span></button>
          <div class="row">
            <input type="text" class="code" id="in-code" maxlength="4" placeholder="CODE" data-enter="join">
            <button class="btn grow" data-action="join" ${opts.server !== 'online' ? 'disabled' : ''}><span>JOIN WITH CODE</span></button>
          </div>
          <div class="section-label">PLAY HERE</div>
          <div class="row">
            <button class="btn grow" data-action="couch"><span>SPLIT SCREEN<span class="sub">Two players, one keyboard + mouse</span></span></button>
            <button class="btn grow" data-action="solo"><span>SOLO PRACTICE<span class="sub">AI co-driver reads the notes</span></span></button>
          </div>
          <div class="section-label">STAGE <span class="muted small">(local games)</span></div>
          <div class="stage-card">
            <div class="seg"><button class="btn small ${opts.map === 'countryside' ? 'selected' : ''}" data-action="map" data-map="countryside"><span>COUNTRYSIDE</span></button><button class="btn small ${opts.map === 'mountain' ? 'selected' : ''}" data-action="map" data-map="mountain"><span>MOUNTAIN</span></button></div>
            <div class="seg">${lenBtn('short', 'SHORT')}${lenBtn('medium', 'MEDIUM')}${lenBtn('long', 'LONG')}</div>
            <div class="seg"><button class="btn small ${!opts.night ? 'selected' : ''}" data-action="time" data-night="0"><span>DAY</span></button><button class="btn small ${opts.night ? 'selected' : ''}" data-action="time" data-night="1"><span>NIGHT</span></button></div>
          </div>
          <div class="row">
            <button class="btn dark small grow" data-action="settings"><span>SETTINGS</span></button>
            <button class="btn dark small grow" data-action="help"><span>HOW TO PLAY</span></button>
          </div>
        </div>
      </div>`;
    const nameIn = s.querySelector('#in-name') as HTMLInputElement;
    nameIn.addEventListener('change', () => this.settings.set('name', nameIn.value.trim().slice(0, 16) || this.settings.data.name));
  }

  menuValues(): { name: string; code: string } {
    const name = (this.root.querySelector('#in-name') as HTMLInputElement | null)?.value.trim() || this.settings.data.name;
    const code = (this.root.querySelector('#in-code') as HTMLInputElement | null)?.value.trim().toUpperCase() || '';
    if (name !== this.settings.data.name) this.settings.set('name', name.slice(0, 16));
    return { name: name.slice(0, 16), code };
  }

  // --- lobby -----------------------------------------------------------------
  renderLobby(room: RoomSnapshot, myId: string | null, status: ConnectionStatus, voice: { state: VoiceState; error: string; muted: boolean } | null, msg = '') {
    const s = this.screens.get('lobby')!;
    const me = room.players.find((p) => p.id === myId);
    const host = !!me?.isHost;
    const crewRow = (i: number) => {
      const p = room.players[i];
      if (!p) return `<div class="crew-row empty"><span class="crew-name">Waiting for a co-driver…</span><span class="small muted">share the room code</span></div>`;
      return `<div class="crew-row ${p.id === myId ? 'me' : ''}">
        <span class="role-badge ${p.role ?? ''}">${p.role ? p.role.toUpperCase() : 'NO ROLE'}</span>
        <span class="crew-name">${esc(p.name)}${p.id === myId ? ' <span class="small muted">(you)</span>' : ''}${p.isHost ? ' <span class="small muted">· host</span>' : ''}</span>
        ${p.connected ? '' : '<span class="small" style="color:var(--yellow)">reconnecting…</span>'}
        <span class="ready ${p.ready ? 'yes' : ''}">${p.ready ? 'READY' : 'NOT READY'}</span>
      </div>`;
    };
    const taken = (r: Role) => room.players.some((p) => p.role === r && p.id !== myId);
    const icon = (r: Role) =>
      r === 'driver'
        ? '<svg viewBox="0 0 40 40" class="role-icon"><circle cx="20" cy="20" r="15" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="20" cy="20" r="4" fill="currentColor"/><path d="M5 20h11M24 20h11M20 24v11" stroke="currentColor" stroke-width="4"/></svg>'
        : '<svg viewBox="0 0 40 40" class="role-icon"><rect x="6" y="9" width="28" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="4"/><path d="M13 25l7-10 7 10" fill="none" stroke="currentColor" stroke-width="3"/></svg>';
    const roleBtn = (r: Role, title: string, sub: string) =>
      `<button class="btn role-tile ${r} ${me?.role === r ? 'selected' : ''}" data-action="role" data-role="${r}" ${taken(r) ? 'disabled' : ''}><span>${icon(r)}<span class="role-text">${title}${taken(r) ? ' <span class="small">(taken)</span>' : ''}<span class="sub">${sub}</span></span></span></button>`;
    const len = (l: StageLength, label: string) =>
      `<button class="btn small ${room.stage.length === l ? 'selected' : ''}" data-action="stage" data-length="${l}" ${host ? '' : 'disabled'}><span>${label}</span></button>`;
    const bothRoles = room.players.length === 2 && room.players.every((p) => p.role);
    const voiceHtml = voice
      ? `<div class="voice-row"><span class="muted">Voice chat:</span>
          ${voice.state === 'off' || voice.state === 'error'
            ? `<button class="btn small" data-action="voice-on"><span>ENABLE MIC</span></button>`
            : `<button class="btn small" data-action="voice-off"><span>DISABLE</span></button>
               <button class="btn small ${voice.muted ? 'selected' : ''}" data-action="voice-mute"><span>${voice.muted ? 'UNMUTE' : 'MUTE'}</span></button>
               <span class="small">${voice.state}</span><div class="meter"><div id="mic-meter"></div></div>`}
          ${voice.error ? `<span class="small" style="color:#ff8a7a">${esc(voice.error)}</span>` : ''}
          <span class="small muted">or use Discord / any voice app</span></div>`
      : '';
    const hint = msg || (room.players.length < 2 ? 'Send the code to your co-driver. They open this page and choose JOIN WITH CODE.' : !bothRoles ? 'Pick different roles.' : 'Both players must be ready to start.');
    s.innerHTML = `
      <div class="lobby-layout">
        <div class="lobby-hero">
          <div class="room-plate">
            <div class="k">ROOM CODE</div>
            <div class="room-code">${esc(room.code)}</div>
            <button class="btn small" data-action="copy-code" data-code="${esc(room.code)}"><span>COPY CODE</span></button>
          </div>
          <div class="lobby-hint">${esc(hint)}</div>
        </div>
        <div class="panel lobby-panel stack">
          <div class="row" style="justify-content:space-between">
            <h2 class="tape">LOBBY</h2>
            <div class="chip"><span class="status-dot ${status}"></span>${status}</div>
          </div>
          <div class="section-label">YOUR ROLE</div>
          <div class="role-pick">
            ${roleBtn('driver', 'DRIVER', 'Steer, brake, survive. No map for you.')}
            ${roleBtn('navigator', 'NAVIGATOR', 'Hold the tablet. Shout. Don’t drop it.')}
          </div>
          <button class="btn small look-btn" data-action="garage"><span>CHANGE YOUR LOOK</span></button>
          <div class="section-label">CREW</div>
          <div class="crew">${crewRow(0)}${crewRow(1)}</div>
          <div class="section-label">STAGE${host ? '' : ' <span class="muted small">(host decides)</span>'}</div>
          <div class="stage-card">
            <div class="seg"><button class="btn small ${room.stage.map === 'countryside' ? 'selected' : ''}" data-action="stage-map" data-map="countryside" ${host ? '' : 'disabled'}><span>COUNTRYSIDE</span></button><button class="btn small ${room.stage.map === 'mountain' ? 'selected' : ''}" data-action="stage-map" data-map="mountain" ${host ? '' : 'disabled'}><span>MOUNTAIN</span></button></div>
            <div class="seg">${len('short', 'SHORT')}${len('medium', 'MEDIUM')}${len('long', 'LONG')}</div>
            <div class="seg"><button class="btn small ${!room.stage.night ? 'selected' : ''}" data-action="stage-time" data-night="0" ${host ? '' : 'disabled'}><span>DAY</span></button><button class="btn small ${room.stage.night ? 'selected' : ''}" data-action="stage-time" data-night="1" ${host ? '' : 'disabled'}><span>NIGHT</span></button></div>
            <div class="row"><span class="muted small">seed ${room.stage.seed}</span>${host ? `<button class="btn small dark" data-action="reroll"><span>NEW ROAD</span></button>` : ''}</div>
          </div>
          ${voiceHtml}
          <div class="row" style="margin-top:6px">
            <button class="btn primary grow big ${me?.role && bothRoles && !me.ready ? 'pulse' : ''}" data-action="ready" ${me?.role && bothRoles ? '' : 'disabled'}><span>${me?.ready ? 'NOT READY' : 'READY!'}</span></button>
            <button class="btn dark" data-action="leave"><span>LEAVE</span></button>
          </div>
        </div>
      </div>`;
  }

  // --- garage: helmet, suit, skin, face and livery ---------------------------
  renderGarage(style: PlayerStyle, online: boolean) {
    const s = this.screens.get('garage')!;
    const sw = (key: keyof PlayerStyle, i: number, title: string, bg: string, cls = '') =>
      `<button class="swatch ${cls} ${style[key] === i ? 'selected' : ''}" data-action="style" data-key="${key}" data-value="${i}" title="${esc(title)}" aria-label="${esc(title)}" style="background:${bg}"></button>`;
    const helmets = HELMETS.map((h, i) => sw('helmet', i, h.name, `linear-gradient(90deg, ${css(h.base)} 0 38%, ${css(h.stripe)} 38% 62%, ${css(h.base)} 62%)`)).join('');
    const suits = SUITS.map((u, i) => sw('suit', i, u.name, `linear-gradient(90deg, ${css(u.accent)} 0 22%, ${css(u.base)} 22% 78%, ${css(u.accent)} 78%)`)).join('');
    const skins = SKINS.map((c, i) => sw('skin', i, 'Skin tone', css(c), 'round')).join('');
    const faces = FACES.map((f, i) => `<button class="btn small ${style.face === i ? 'selected' : ''}" data-action="style" data-key="face" data-value="${i}"><span>${esc(f.toUpperCase())}</span></button>`).join('');
    const liveries = LIVERIES.map((l, i) =>
      sw('livery', i, l.name, `linear-gradient(180deg, ${css(l.body)} 0 40%, ${css(l.stripeA)} 40% 62%, ${css(l.body)} 62% 70%, ${css(l.stripeB)} 70% 78%, ${css(l.body)} 78%)`, 'wide'),
    ).join('');
    s.innerHTML = `
      <div class="menu-layout">
        <div class="menu-hero">
          <div>
            <h1 class="title garage-title"><span class="l1">YOUR</span> <span class="l3">LOOK</span></h1>
            <div class="tagline">HELMET ON. SUIT UP. PAINT THE CAR.</div>
          </div>
          <div class="hero-foot">
            <p class="blurb">${online ? 'Your co-driver sees all of it, in the lobby and on the stage.' : 'This is how you look on the stage.'} The car always wears the <b>driver's</b> livery.</p>
          </div>
        </div>
        <div class="panel stack menu-panel garage-panel">
          <h2 class="tape">PIT GARAGE</h2>
          <div class="section-label">HELMET <span class="muted small">${esc(HELMETS[style.helmet].name)}</span></div>
          <div class="swatches">${helmets}</div>
          <div class="section-label">RACE SUIT <span class="muted small">${esc(SUITS[style.suit].name)}</span></div>
          <div class="swatches">${suits}</div>
          <div class="section-label">FACE</div>
          <div class="swatches">${skins}</div>
          <div class="seg wrap">${faces}</div>
          <div class="section-label">CAR LIVERY <span class="muted small">${esc(LIVERIES[style.livery].name)}</span></div>
          <div class="swatches">${liveries}</div>
          <div class="row" style="margin-top:6px">
            <button class="btn dark grow" data-action="style-random"><span>SURPRISE ME</span></button>
            <button class="btn primary grow big" data-action="garage-done"><span>DONE</span></button>
          </div>
        </div>
      </div>`;
  }

  setMicLevel(level: number) {
    const m = this.root.querySelector('#mic-meter') as HTMLElement | null;
    if (m) m.style.width = `${Math.round(level * 100)}%`;
  }

  // --- loading -----------------------------------------------------------------
  setLoading(fraction: number, text: string) {
    const s = this.screens.get('loading')!;
    if (!s.firstElementChild) {
      s.innerHTML = `<div class="panel loading-box"><h2 class="tape">LOADING STAGE</h2><div class="bar"><div id="load-bar"></div></div><div class="muted" id="load-text"></div></div>`;
    }
    (s.querySelector('#load-bar') as HTMLElement).style.width = `${Math.round(fraction * 100)}%`;
    (s.querySelector('#load-text') as HTMLElement).textContent = text;
  }

  // --- HUD -----------------------------------------------------------------------
  setupHud(views: HudView[]) {
    this.hud.innerHTML = '';
    this.lastHudKeys = [];
    this.lastTabKeys = [];
    this.hudViews = views.map((v) => {
      const el = document.createElement('div');
      el.className = 'hud-view';
      el.style.left = `${v.rect.x * 100}%`;
      el.style.top = `${(1 - v.rect.y - v.rect.h) * 100}%`;
      el.style.width = `${v.rect.w * 100}%`;
      el.style.height = `${v.rect.h * 100}%`;
      const callouts =
        v.role === 'navigator'
          ? `<div class="tab-callouts"><h4>CALLOUTS</h4>${NAV_HOTKEYS.map((h) => `<kbd>${h.key}</kbd> ${h.id === 'other' ? 'NO, THE OTHER…' : h.id === 'animal' ? 'COW! / SHEEP! / TRACTOR!' : CALLOUT_TEXT[h.id]}`).join('<br>')}</div>`
          : '';
      el.innerHTML = `
        ${v.role === 'driver' ? '<div class="hud-glare"></div>' : ''}
        <div class="hud-role ${v.role}">${v.role.toUpperCase()}</div>
        <div class="hud-time"><span class="t">0:00.00</span><span class="cp"></span></div>
        <div class="hud-status"></div>
        <div class="hud-warn"></div>
        ${v.role === 'driver' ? `<div class="hud-speed"><span class="v">0</span><span class="g">1</span><div class="u">KM/H</div></div>` : ''}
        ${v.role === 'navigator' ? `<div class="hud-grip">GRIP<div class="track"><div class="fill" style="width:100%"></div></div></div><div class="hud-hover"></div><div class="hud-cross"></div>` : ''}
        ${v.role === 'driver' ? `<div class="hud-reset">EMERGENCY RESET<div class="track"><div class="fill"></div></div></div>` : ''}
        <div class="hud-tabhint">hold <kbd>Tab</kbd> for controls</div>
        <div class="hud-tab"><div class="tab-panel"><h4>${v.role.toUpperCase()} CONTROLS</h4><div class="tab-rows"></div></div>${callouts}</div>`;
      this.hud.appendChild(el);
      return el;
    });
    this.hud.classList.add('show');
  }

  hideHud() {
    this.hud.classList.remove('show');
    this.hud.innerHTML = '';
    this.hudViews = [];
    this.countdown(null);
    this.banner(null);
    this.hint(null);
    this.cinematic(null);
    (this.root.querySelector('#subtitle') as HTMLElement).classList.remove('show');
  }

  private lastTabKeys: string[] = [];

  updateHud(dt: number, index: number, d: HudData) {
    const el = this.hudViews[index];
    if (!el) return;
    const q = (sel: string) => el.querySelector(sel) as HTMLElement | null;
    const key = `${Math.round(d.speedKmh)}|${d.gear}|${Math.floor(d.timeMs / 10)}|${d.cp}|${d.status}|${d.grip !== null ? Math.round(d.grip) : ''}|${d.warn}|${d.onFoot}`;
    if (key !== this.lastHudKeys[index]) {
      this.lastHudKeys[index] = key;
      const t = q('.hud-time .t');
      if (t) t.textContent = fmtTime(d.timeMs);
      const cp = q('.hud-time .cp');
      if (cp) cp.textContent = d.cp;
      const v = q('.hud-speed .v');
      if (v) v.textContent = String(Math.round(d.speedKmh));
      const g = q('.hud-speed .g');
      if (g) g.textContent = d.gear === -1 ? 'R' : d.gear === 0 ? 'N' : String(d.gear);
      const sp = q('.hud-speed');
      if (sp) sp.style.display = d.onFoot ? 'none' : '';
      const st = q('.hud-status');
      if (st) {
        st.textContent = d.status ?? '';
        st.style.display = d.status ? 'block' : 'none';
      }
      const grip = q('.hud-grip .fill');
      if (grip && d.grip !== null) {
        grip.style.width = `${Math.max(0, Math.min(100, d.grip))}%`;
        grip.style.background = d.grip < 35 ? 'var(--red)' : 'var(--yellow)';
      }
      const gw = q('.hud-grip');
      if (gw) gw.style.opacity = d.onFoot ? '0' : d.grip === null ? '0.35' : '1';
      const w = q('.hud-warn');
      if (w) {
        w.textContent = d.warn ?? '';
        w.classList.toggle('show', !!d.warn);
      }
    }
    const cross = q('.hud-cross');
    if (cross) cross.style.display = d.crosshair ? 'block' : 'none';
    const hov = q('.hud-hover');
    if (hov) {
      if (d.hover) {
        hov.style.display = 'block';
        hov.textContent = d.hover.text;
        hov.style.left = `${d.hover.x}px`;
        hov.style.top = `${d.hover.y}px`;
      } else hov.style.display = 'none';
    }
    // hold-Tab controls overlay (does not pause the game)
    const tab = q('.hud-tab');
    if (tab) {
      tab.classList.toggle('show', !!d.tab);
      const hint = q('.hud-tabhint');
      if (hint) hint.style.display = d.tab ? 'none' : '';
      const callouts = q('.tab-callouts');
      if (callouts) callouts.style.display = d.onFoot ? 'none' : ''; // shouting callouts only works from the seat
      if (d.tab) {
        const tk = d.tab.map((r) => r.join('|')).join('/');
        if (tk !== this.lastTabKeys[index]) {
          this.lastTabKeys[index] = tk;
          q('.tab-rows')!.innerHTML = d.tab.map(([k, a]) => `<div class="tab-row"><kbd>${esc(k)}</kbd><span>${esc(a)}</span></div>`).join('');
        }
      }
    }
    const reset = q('.hud-reset');
    if (reset) {
      reset.style.display = d.resetHold > 0 ? 'block' : 'none';
      (reset.querySelector('.fill') as HTMLElement).style.width = `${Math.round(d.resetHold * 100)}%`;
    }
    const glare = q('.hud-glare');
    if (glare) glare.style.opacity = d.glare.toFixed(3);
    if (index === 0) {
      this.subtitleTimer -= dt;
      this.hintTimer -= dt;
      if (this.subtitleTimer <= 0) (this.root.querySelector('#subtitle') as HTMLElement).classList.remove('show');
      if (this.hintTimer <= 0) this.hint(null);
    }
  }

  /** Cinematic finish overlay: letterbox bars + title (null hides it). */
  cinematic(title: string | null, sub = '') {
    const el = this.root.querySelector('#cinematic') as HTMLElement;
    if (!title) {
      el.classList.remove('show');
      return;
    }
    (el.querySelector('.title') as HTMLElement).innerHTML = `${esc(title)}<span class="sub">${esc(sub)}</span>`;
    el.classList.add('show');
  }

  subtitle(text: string, from: string, auto: boolean) {
    if (!this.settings.data.subtitles) return;
    const el = this.root.querySelector('#subtitle') as HTMLElement;
    el.innerHTML = `<span class="from">${esc(from)}</span>${esc(text)}`;
    el.classList.toggle('auto', auto);
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    this.subtitleTimer = Math.max(1.6, text.length * 0.07);
  }

  countdown(text: string | null) {
    const el = this.root.querySelector('#countdown') as HTMLElement;
    if (!text) {
      el.classList.remove('show');
      el.textContent = '';
      return;
    }
    if (el.textContent === text) return;
    el.textContent = text;
    el.classList.toggle('go', text === 'GO!');
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  toast(text: string, kind: 'good' | 'bad' | 'info' = 'info') {
    const box = this.root.querySelector('#toasts') as HTMLElement;
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    box.appendChild(t);
    while (box.children.length > 4) box.firstElementChild?.remove();
    window.setTimeout(() => t.remove(), 2600);
  }

  hint(text: string | null, seconds = 4) {
    const el = this.root.querySelector('#hint') as HTMLElement;
    if (text) {
      el.textContent = text;
      el.classList.add('show');
      this.hintTimer = seconds;
    } else el.classList.remove('show');
  }

  banner(text: string | null) {
    const el = this.root.querySelector('#banner') as HTMLElement;
    el.textContent = text ?? '';
    el.classList.toggle('show', !!text);
  }

  fps(text: string | null) {
    const el = this.root.querySelector('#fps') as HTMLElement;
    el.style.display = text ? 'block' : 'none';
    if (text) el.textContent = text;
  }

  // --- pause / help / settings -------------------------------------------------
  renderPause(mode: 'online' | 'couch' | 'solo', online: boolean) {
    const s = this.screens.get('pause')!;
    const bind: BindMode = mode === 'couch' ? 'couch' : 'single';
    s.innerHTML = `
      <div class="panel modal-wide stack">
        <h2 class="tape">PAUSED${online ? ' <span class="small">(the stage keeps running online!)</span>' : ''}</h2>
        <div class="row">
          <button class="btn primary" data-action="resume"><span>RESUME</span></button>
          <button class="btn" data-action="settings"><span>SETTINGS</span></button>
          ${mode !== 'online' ? `<button class="btn" data-action="restart-retry"><span>RESTART STAGE</span></button><button class="btn" data-action="restart-new"><span>NEW STAGE</span></button>` : `<button class="btn" data-action="restart-new"><span>VOTE: NEW STAGE</span></button>`}
          <button class="btn dark" data-action="quit"><span>${mode === 'online' ? 'LEAVE SESSION' : 'MAIN MENU'}</span></button>
        </div>
        <div class="help">
          <div><h3>DRIVER${mode === 'couch' ? ' (LEFT SCREEN)' : ''}</h3>${referenceHtml('driver', bind)}</div>
          <div><h3>NAVIGATOR${mode === 'couch' ? ' (RIGHT SCREEN)' : ''}</h3>${referenceHtml('navigator', bind)}</div>
        </div>
        <p class="muted small">In game, hold <kbd>Tab</kbd> for the controls that apply right now.</p>
      </div>`;
  }

  private renderHelp() {
    const s = this.screens.get('help')!;
    s.innerHTML = `
      <div class="panel modal-wide stack">
        <h2 class="tape">HOW TO PLAY</h2>
        <p class="muted">Two players share one hatchback. The <b>driver</b> has no map: only the road, the mud and the
        navigator's voice. The <b>navigator</b> holds a physical tablet showing the route, next turn and distance - but it's
        a real object in a bouncing car. Hard corners and crashes will knock it out of their hands. Pick it up again and keep
        calling the turns. Hit every checkpoint and reach the finish. Crashes, missed turns and missed checkpoints all count.</p>
        <p class="muted">Use voice chat (built-in, Discord, or just shout across the room). The navigator can also hit the
        number keys to shout preset callouts, read the next pace note aloud, or physically point the way.</p>
        <p class="muted">Two stages: the <b>countryside</b> - fast gravel through the forest - and the <b>mountain</b>, a narrow road
        carved into a steep mountainside. Leave the road on the drop side and you go over the edge: the car falls and tumbles
        down the slope for real. Land on a lower bend and it doesn't count - hold R to go back to where you left the road.</p>
        <div class="help">
          <div><h3>DRIVER</h3>${referenceHtml('driver', 'single')}</div>
          <div><h3>NAVIGATOR</h3>${referenceHtml('navigator', 'single')}</div>
        </div>
        <div class="help"><div><h3>CABIN CHAOS</h3>Mud puddles splatter the windscreen: each press of the wiper key gives one sweep
        that only clears its arc, so hand-wipe the corners. Big hits can unlatch a door - it swings around and drags the car until
        you close it. Loose objects fly. At night the tablet's screen is only readable in your head lamp's beam - look at it to
        light it, and try not to look your driver in the eyes.</div>
        <div><h3>STUCK?</h3>If the car is stuck, stop, get out and grab a tow hook (front or rear bumper). Walk away from the car
        while holding on to pull it free - pull together for more force, and pull along the car rather than sideways. The
        emergency reset is a last resort and costs 5 seconds. Split screen uses separate keys for each player: see the pause menu.</div></div>
        <div class="row"><button class="btn primary" data-action="close-help"><span>GOT IT</span></button></div>
      </div>`;
  }

  renderSettings() {
    const s = this.screens.get('settings')!;
    const d = this.settings.data;
    const range = (k: keyof SettingsData, label: string, min: number, max: number, step: number) =>
      `<div class="setting"><span>${label}</span><input type="range" data-key="${k}" min="${min}" max="${max}" step="${step}" value="${d[k] as number}"></div>`;
    const check = (k: keyof SettingsData, label: string) =>
      `<div class="setting"><span>${label}</span><input type="checkbox" data-key="${k}" ${d[k] ? 'checked' : ''}></div>`;
    s.innerHTML = `
      <div class="panel modal-wide stack">
        <h2 class="tape">SETTINGS</h2>
        <div class="settings-grid">
          ${range('masterVolume', 'Master volume', 0, 1, 0.05)}
          ${range('engineVolume', 'Engine', 0, 1, 0.05)}
          ${range('environmentVolume', 'Environment (road, wind)', 0, 1, 0.05)}
          ${range('collisionVolume', 'Collisions & cabin', 0, 1, 0.05)}
          ${range('voiceVolume', 'Voice & callouts', 0, 1, 0.05)}
          ${range('uiVolume', 'Interface', 0, 1, 0.05)}
          ${range('mouseSensitivity', 'Mouse sensitivity', 0.3, 2.5, 0.05)}
          ${range('fov', 'Field of view', 52, 82, 1)}
          ${range('cameraShake', 'Cabin motion intensity', 0, 1.5, 0.05)}
          <div class="setting"><span>Graphics quality</span><select data-key="quality">
            ${(['low', 'medium', 'high'] as const).map((q) => `<option value="${q}" ${d.quality === q ? 'selected' : ''}>${q}</option>`).join('')}
          </select></div>
          ${check('invertY', 'Invert mouse Y')}
          ${check('recenterView', 'Auto-centre driver view')}
          ${check('tts', 'Spoken callouts (text-to-speech)')}
          ${check('subtitles', 'Callout subtitles')}
          ${check('autoCallouts', 'Automatic reaction callouts')}
          ${check('pushToTalk', 'Voice chat push-to-talk (T)')}
          ${check('showFps', 'Show FPS')}
        </div>
        <p class="muted small">Graphics quality applies to the next stage you load.</p>
        <div class="row"><button class="btn primary" data-action="close-settings"><span>DONE</span></button>
          <button class="btn dark" data-action="reset-settings"><span>RESET DEFAULTS</span></button></div>
      </div>`;
    s.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]').forEach((input) => {
      input.addEventListener('input', () => {
        const k = input.dataset.key as keyof SettingsData;
        let v: unknown;
        if (input instanceof HTMLInputElement && input.type === 'checkbox') v = input.checked;
        else if (input instanceof HTMLInputElement && input.type === 'range') v = Number(input.value);
        else v = input.value;
        this.settings.set(k, v as never);
      });
    });
  }

  // --- results -------------------------------------------------------------------
  renderResults(r: RaceResults, mode: 'online' | 'couch' | 'solo', votes: { mine: string | null; partner: string | null }) {
    const s = this.screens.get('results')!;
    const stat = (k: string, v: string) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    const voteInfo =
      mode === 'online'
        ? `<p class="muted small">${votes.mine ? `You voted <b>${votes.mine.toUpperCase()}</b>. ` : ''}${votes.partner ? `Partner voted <b>${votes.partner.toUpperCase()}</b>.` : 'Waiting for your partner to vote…'}</p>`
        : '';
    s.innerHTML = `
      <div class="panel results stack">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div>
            <h2 class="tape">STAGE COMPLETE</h2>
            <div class="result-title">${esc(r.title)}</div>
            <div class="big-time">${fmtTime(r.finalTimeMs)}</div>
            <div class="muted small">stage time ${fmtTime(r.timeMs)} + penalties ${fmtTime(r.penaltiesMs)}</div>
          </div>
          <div class="grade">${r.grade}</div>
        </div>
        <div class="result-grid">
          ${stat('Distance driven', `${(r.distanceDriven / 1000).toFixed(2)} km`)}
          ${stat('Stage length', `${(r.stageLength / 1000).toFixed(2)} km`)}
          ${stat('Average speed', `${Math.round(r.avgSpeed * 3.6)} km/h`)}
          ${stat('Top speed', `${Math.round(r.topSpeed * 3.6)} km/h`)}
          ${stat('Crashes', String(r.crashes))}
          ${stat('Missed turns', String(r.missedTurns))}
          ${stat('Checkpoints', `${r.checkpointsHit}/${r.checkpointsTotal}`)}
          ${stat('Tablet drops', String(r.tabletDrops))}
          ${stat('Emergency resets', String(r.resets ?? 0))}
          ${stat('Stage seed', String(r.seed))}
        </div>
        ${voteInfo}
        <div class="row">
          <button class="btn primary" data-action="restart-new"><span>NEXT STAGE (NEW ROAD)</span></button>
          <button class="btn" data-action="restart-retry"><span>RETRY THIS STAGE</span></button>
          ${mode === 'online' ? `<button class="btn dark" data-action="to-lobby"><span>LOBBY</span></button>` : ''}
          <button class="btn dark" data-action="quit"><span>MAIN MENU</span></button>
        </div>
      </div>`;
  }

  fatal(title: string, message: string) {
    const s = this.screens.get('fatal')!;
    s.innerHTML = `<h1 class="title" style="font-size:64px">${esc(title)}</h1><div class="panel" style="max-width:640px">${message}</div>`;
    this.hideAll();
    this.show('fatal');
  }
}

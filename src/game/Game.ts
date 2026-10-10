// One rally stage in progress: builds the world, runs the fixed-step
// simulation for whichever roles are local, exchanges state through the
// session, and renders one (online / solo) or two (couch) first-person views.

import * as THREE from 'three';
import { CarAudio } from '../audio/CarAudio';
import type { AudioEngine } from '../audio/AudioEngine';
import { Cockpit } from '../cockpit/Cockpit';
import { DoorSim } from '../cockpit/Doors';
import { LAYOUT } from '../cockpit/layout';
import { Occupant } from '../cockpit/Occupant';
import { Windshield } from '../cockpit/Windshield';
import type { Input } from '../core/Input';
import type { Settings } from '../core/Settings';
import { DriverControls } from '../interactions/DriverControls';
import { NavigatorControls, type NavContext } from '../interactions/NavigatorControls';
import { GameSession } from '../multiplayer/Session';
import { SnapshotBuffer, interpolateCar, makePoseInterp } from '../multiplayer/SnapshotBuffer';
import { AICoDriver, calloutText, Voice } from '../navigation/Callouts';
import { Minimap } from '../navigation/Minimap';
import { CabinPhysics } from '../physics/CabinPhysics';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { LAYER } from '../rendering/layers';
import { Particles } from '../rendering/Particles';
import type { Renderer, View } from '../rendering/Renderer';
import { Sky } from '../rendering/Sky';
import { FIXED_DT, LOOSE_OBJECT_COUNT, MAX_STEPS_PER_FRAME } from '../shared/constants';
import { clamp } from '../shared/math';
import { RoadLocator } from '../shared/race/RoadLocator';
import { CABIN, CABIN_FLAG, CAR, CAR_FLAG } from '../shared/snapshot';
import { computeInstruction, spokenNote, type NavInstruction } from '../shared/stage/pacenotes';
import { generateStage, stageStartPose } from '../shared/stage/StageGenerator';
import type { CalloutMsg, DoorSide, ImpactFx, RaceEvent, RaceResults, RaceStats, Role, StageData, StageParams } from '../shared/types';
import { TabletModel, buildLooseObjectMeshes } from '../tablet/TabletModel';
import type { HudData, UI } from '../ui/UI';
import { CarModel } from '../vehicle/CarModel';
import { VehicleController } from '../vehicle/VehicleController';
import { Props } from '../world/Props';
import { Road } from '../world/Road';
import { Terrain } from '../world/Terrain';
import { TerrainField } from '../world/TerrainField';
import { Vegetation } from '../world/Vegetation';
import { CarRenderState } from './CarRenderState';
import { SeatView } from './SeatView';

export type GameMode = 'online' | 'couch' | 'solo';
export type GamePhase = 'loading' | 'countdown' | 'racing' | 'finished';

export interface GameDeps {
  renderer: Renderer;
  input: Input;
  settings: Settings;
  audio: AudioEngine;
  ui: UI;
  session: GameSession;
  mode: GameMode;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _g = new THREE.Vector3();

export class Game {
  readonly scene = new THREE.Scene();
  stage!: StageData;
  phase: GamePhase = 'loading';
  results: RaceResults | null = null;
  private d: GameDeps;
  private roles: Role[];
  private simulateCar: boolean;
  private simulateCabin: boolean;

  private physics: PhysicsWorld | null = null;
  private sky!: Sky;
  private field!: TerrainField;
  private terrain!: Terrain;
  private road!: Road;
  private veg!: Vegetation;
  private props!: Props;
  private car!: CarModel;
  private cockpit!: Cockpit;
  private windshield!: Windshield;
  private doors!: Record<DoorSide, DoorSim>;
  private driverBody!: Occupant;
  private navBody!: Occupant;
  private tablet!: TabletModel;
  private loose: THREE.Mesh[] = [];
  private minimap!: Minimap;
  private particles!: Particles;
  private vehicle: VehicleController | null = null;
  private cabin: CabinPhysics | null = null;
  private carBuf: SnapshotBuffer | null = null;
  private cabinBuf: SnapshotBuffer | null = null;
  private carSample = new Float32Array(CAR.LENGTH);
  private cabinSample = new Float32Array(CABIN.LENGTH);
  private carOut = new Float32Array(CAR.LENGTH);
  private cabinOut = new Float32Array(CABIN.LENGTH);
  readonly cs = new CarRenderState();
  private driverView!: SeatView;
  private navView!: SeatView;
  private driverControls: DriverControls | null = null;
  private navControls: NavigatorControls | null = null;
  private mirrorCam!: THREE.PerspectiveCamera;
  private mirrorRT!: THREE.WebGLRenderTarget;
  private orbitCam!: THREE.PerspectiveCamera;
  private carAudio: CarAudio;
  private voice: Voice;
  private ai: AICoDriver | null = null;
  private locator!: RoadLocator;
  private ins: NavInstruction | null = null;

  private countdownEndsAt = 0;
  private stats: RaceStats | null = null;
  private statsAt = 0;
  private pausedLocal = false;
  private pausedRemote = false;
  private acc = 0;
  private simTime = 0;
  private steps = 0;
  private seq = 0;
  private frameCount = 0;
  private disposed = false;
  private unsub: (() => void)[] = [];
  private wipersOn = false;
  private doorStates = { left: false, right: false };
  private remoteTabletHeld = false;
  private remoteNavHead = { yaw: 0.1, pitch: -0.3 };
  private remoteReach = new THREE.Vector3();
  private remoteHeldObj = -1;
  private flash: { text: string; color: string; until: number } | null = null;
  private lastPuddle = -1;
  private lastPuddleAt = 0;
  private dirtTimer = 0;
  private rustleTimer = 0;
  private wipeSendTimer = 0;
  private resetCooldown = 0;
  private closingDoorTimer = { left: 0, right: 0 };
  private shiftHand = 0;
  private aiRegrab = 0;
  private aiTimer = 0;
  private handL = new THREE.Vector3();
  private handR = new THREE.Vector3();
  private navHandL = new THREE.Vector3();
  private navHandR = new THREE.Vector3();
  private handsInit = false;
  private lastDirectional: 'left' | 'right' = 'left';
  private tabletVisible = true;
  private lastCabinPose: { pos: THREE.Vector3; prev: THREE.Vector3 }[] = [];
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fpsText = '';
  private minimapTimer = 0;
  private wipeRay = new THREE.Raycaster();
  private holdPos = new THREE.Vector3();
  private holdQuat = new THREE.Quaternion();

  constructor(deps: GameDeps) {
    this.d = deps;
    this.roles = deps.mode === 'online' ? [...deps.session.localRoles] : deps.mode === 'couch' ? ['driver', 'navigator'] : ['driver'];
    this.simulateCar = this.roles.includes('driver');
    this.simulateCabin = this.roles.includes('navigator') || deps.mode === 'solo';
    this.carAudio = new CarAudio(deps.audio);
    this.voice = new Voice(deps.settings);
  }

  get isPaused(): boolean {
    return this.pausedLocal;
  }

  // ===================================================================== load ==
  async load(params: StageParams, progress: (f: number, text: string) => Promise<void>): Promise<number> {
    const d = this.d;
    const quality = d.settings.data.quality;
    await progress(0.02, 'Generating rally stage…');
    this.stage = generateStage(params);
    this.locator = new RoadLocator(this.stage);
    d.renderer.applyQuality(quality);
    this.sky = new Sky(this.scene, d.renderer.shadowMapSize);
    if (this.simulateCar) this.physics = new PhysicsWorld();

    await progress(0.08, 'Shaping hills and ditches…');
    this.field = new TerrainField(this.stage);
    this.terrain = new Terrain(this.field, this.physics, quality);
    await this.terrain.build((f) => progress(0.08 + f * 0.4, 'Shaping hills and ditches…'));
    this.scene.add(this.terrain.group);
    await progress(0.5, 'Laying gravel…');
    this.road = new Road(this.stage, this.physics);
    this.scene.add(this.road.group);
    await progress(0.55, 'Planting far too many trees…');
    this.veg = new Vegetation(this.field, this.physics, quality);
    await this.veg.build((f) => progress(0.55 + f * 0.3, 'Planting far too many trees…'));
    this.scene.add(this.veg.group);
    this.props = new Props(this.stage, this.field, this.road, this.physics);
    this.scene.add(this.props.group);
    await progress(0.88, 'Bolting the cockpit together…');
    this.buildCar();
    this.particles = new Particles();
    this.scene.add(this.particles.mesh);
    this.wireSession();
    await progress(0.95, 'Warming up shaders…');
    this.applyPose();
    this.d.renderer.renderer.compile(this.scene, this.primaryCamera);
    await progress(1, 'Waiting for your co-driver…');
    return this.stage.hash;
  }

  private buildCar() {
    const d = this.d;
    this.car = new CarModel();
    this.scene.add(this.car.root);
    this.cockpit = new Cockpit();
    this.car.root.add(this.cockpit.group);
    this.windshield = new Windshield({ wiperEnd: () => this.carAudio.wiperSqueak() });
    this.windshield.group.traverse((o) => o.layers.set(LAYER.COCKPIT));
    this.car.root.add(this.windshield.group);
    this.driverBody = new Occupant('driver');
    this.navBody = new Occupant('navigator');
    this.car.root.add(this.driverBody.group, this.navBody.group);
    this.minimap = new Minimap(this.stage);
    this.tablet = new TabletModel(this.minimap.texture);
    this.car.root.add(this.tablet.group);
    this.loose = buildLooseObjectMeshes();
    for (const m of this.loose) this.car.root.add(m);
    for (let i = 0; i <= LOOSE_OBJECT_COUNT; i++) this.lastCabinPose.push({ pos: new THREE.Vector3(), prev: new THREE.Vector3() });

    const pan = (side: DoorSide) => (side === 'left' ? -1 : 1) * this.listenerSide() * -0.8 + (side === 'left' ? -0.4 : 0.4);
    const events = {
      bang: (side: DoorSide, s: number) => this.carAudio.doorBang(pan(side), s),
      rattle: (side: DoorSide, s: number) => this.carAudio.doorRattle(pan(side), s),
      slam: (side: DoorSide) => this.carAudio.doorSlam(pan(side)),
    };
    this.doors = { left: new DoorSim('left', this.car.doors.left, events), right: new DoorSim('right', this.car.doors.right, events) };

    const fov = d.settings.data.fov;
    this.driverView = new SeatView('driver', this.car.root, fov);
    this.navView = new SeatView('navigator', this.car.root, fov);
    const split = d.mode === 'couch';
    if (this.roles.includes('driver')) this.driverControls = new DriverControls(d.input, d.settings, split);
    if (this.roles.includes('navigator')) this.navControls = new NavigatorControls(d.input, d.settings, split, d.renderer.canvas);

    // mirrors: one wide backwards render feeds the rear-view and both side mirrors
    this.mirrorRT = new THREE.WebGLRenderTarget(384, 128, { depthBuffer: true });
    this.mirrorRT.texture.colorSpace = THREE.SRGBColorSpace;
    this.mirrorCam = new THREE.PerspectiveCamera(36, 3, 0.3, 260);
    this.mirrorCam.position.set(0, 0.62, 1.3);
    this.mirrorCam.rotation.set(-0.04, Math.PI, 0);
    this.mirrorCam.layers.set(LAYER.WORLD);
    this.car.root.add(this.mirrorCam);
    this.cockpit.setMirrorTexture(this.mirrorRT.texture);
    this.orbitCam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 580);
    this.orbitCam.layers.enableAll();

    const start = stageStartPose(this.stage);
    if (this.simulateCar && this.physics) {
      this.vehicle = new VehicleController(this.physics, start, this.road.puddleAt);
      this.cs.fromVehicle(this.vehicle, 1);
    } else {
      this.cs.pos.set(start.x, start.y - 0.18, start.z);
      this.cs.quat.set(start.qx, start.qy, start.qz, start.qw);
      this.carBuf = new SnapshotBuffer(CAR.LENGTH, interpolateCar, 0.11);
    }
    if (this.simulateCabin) {
      this.cabin = new CabinPhysics({
        contact: (i, s) => this.onCabinContact(i, s),
        dropped: (reason) => this.onTabletDropped(reason),
      });
    } else {
      const poses = [CABIN.tablet, ...Array.from({ length: LOOSE_OBJECT_COUNT }, (_, k) => CABIN.objects + k * 7)];
      this.cabinBuf = new SnapshotBuffer(CABIN.LENGTH, makePoseInterp(poses, [CABIN.flags, CABIN.heldObject]), 0.1);
      // until the first snapshot arrives, show everything at its start position
      this.cabinSample[CABIN.tablet] = LAYOUT.navLap.x;
      this.cabinSample[CABIN.tablet + 1] = LAYOUT.navLap.y;
      this.cabinSample[CABIN.tablet + 2] = LAYOUT.navLap.z;
      this.cabinSample[CABIN.tablet + 6] = 1;
      this.cabinSample[CABIN.heldObject] = -1;
    }
    if (d.mode === 'solo') this.ai = new AICoDriver(this.stage);
  }

  private listenerSide(): number {
    return this.roles.includes('driver') ? -1 : 1;
  }

  private get primaryCamera(): THREE.PerspectiveCamera {
    return this.roles.includes('driver') ? this.driverView.camera : this.navView.camera;
  }

  // ================================================================== session ==
  private wireSession() {
    const s = this.d.session;
    this.unsub.push(
      s.on('countdown', (p) => {
        this.countdownEndsAt = p.endsAt;
        if (this.phase === 'loading') this.phase = 'countdown';
      }),
      s.on('go', () => {
        this.phase = 'racing';
        this.d.ui.countdown('GO!');
        this.d.audio.countdownBeep(true);
        window.setTimeout(() => this.d.ui.countdown(null), 900);
        this.stats = this.stats ?? null;
        this.statsAt = performance.now();
      }),
      s.on('results', (r) => {
        this.results = r;
        this.phase = 'finished';
        this.d.audio.chime();
      }),
      s.on('paused', (p) => {
        this.pausedRemote = p.paused;
        this.d.ui.banner(p.paused ? p.reason : null);
        if (!p.paused) {
          this.carBuf?.clear();
          this.cabinBuf?.clear();
          this.acc = 0;
        }
      }),
      s.on('stats', (st) => {
        this.stats = st;
        this.statsAt = performance.now();
      }),
      s.on('raceEvent', (e) => this.onRaceEvent(e)),
      s.on('carState', (buf) => this.carBuf?.push(buf, performance.now() / 1000)),
      s.on('cabinState', (buf) => this.cabinBuf?.push(buf, performance.now() / 1000)),
      s.on('propsState', (buf) => {
        if (!this.simulateCar) this.props.applyRemote(buf);
      }),
      s.on('carTeleport', (p) => {
        if (this.vehicle) {
          this.vehicle.setPose(p);
          this.cs.fromVehicle(this.vehicle, 1);
        }
        this.carBuf?.clear();
        this.d.ui.toast('CAR RESET', 'info');
      }),
      s.on('carCorrection', (b) => {
        if (!this.vehicle) return;
        this.vehicle.setPose(
          { x: b[CAR.px], y: b[CAR.py], z: b[CAR.pz], qx: b[CAR.qx], qy: b[CAR.qy], qz: b[CAR.qz], qw: b[CAR.qw] },
          { x: b[CAR.vx], y: b[CAR.vy], z: b[CAR.vz] },
          { x: b[CAR.wx], y: b[CAR.wy], z: b[CAR.wz] },
        );
      }),
      s.on('impact', (fx) => this.onImpactFx(fx, true)),
      s.on('mud', (fx) => {
        this.windshield.splat(fx);
        if (fx.kind !== 'dirt') this.carAudio.splash(fx.amount);
      }),
      s.on('wipe', (p) => {
        if (!this.simulateCar) this.windshield.wipeAt(p.u, p.v, 0.35);
      }),
      s.on('doors', (dd) => {
        if (dd.left && !this.doorStates.left) this.d.ui.toast('DRIVER DOOR FLEW OPEN!', 'bad');
        if (dd.right && !this.doorStates.right) this.d.ui.toast('PASSENGER DOOR FLEW OPEN!', 'bad');
        this.doorStates = { ...dd };
        this.doors.left.setOpen(dd.left);
        this.doors.right.setOpen(dd.right);
      }),
      s.on('wipers', (on) => {
        this.wipersOn = on;
        this.windshield.setWipers(on);
      }),
      s.on('tabletOwner', (h) => {
        this.remoteTabletHeld = h === 'navigator';
      }),
      s.on('callout', (m) => this.onCallout(m)),
      s.on('hint', (t) => this.d.ui.hint(t, 5)),
    );
  }

  private onRaceEvent(e: RaceEvent) {
    const ui = this.d.ui;
    const now = performance.now();
    switch (e.type) {
      case 'checkpoint':
        ui.toast(`CHECKPOINT ${e.index + 1}/${e.total}  ${(e.splitMs / 1000).toFixed(1)}s`, 'good');
        this.d.audio.chime();
        this.flash = { text: `CHECKPOINT ${e.index + 1}!`, color: 'rgba(47,143,70,0.85)', until: now + 1600 };
        break;
      case 'missedCheckpoint':
        ui.toast(`MISSED CHECKPOINT ${e.index + 1}  +${e.penaltyMs / 1000}s`, 'bad');
        this.flash = { text: 'CHECKPOINT MISSED', color: 'rgba(214,40,30,0.85)', until: now + 2200 };
        break;
      case 'missedTurn':
        ui.toast('TURN MISSED!', 'bad');
        this.flash = { text: 'TURN MISSED!', color: 'rgba(232,116,43,0.9)', until: now + 2200 };
        break;
      case 'crash':
        ui.toast(e.strength > 9 ? 'MASSIVE CRASH!' : 'CRASH!', 'bad');
        break;
      case 'stuck':
        ui.hint(this.roles.includes('driver') ? 'STUCK? PRESS R TO RESET' : 'TELL YOUR DRIVER TO PRESS R', 6);
        break;
      case 'finish':
        ui.toast('FINISH!', 'good');
        break;
      case 'wrongWay':
        break;
    }
  }

  private onCallout(m: CalloutMsg) {
    if (m.auto && !this.d.settings.data.autoCallouts) return;
    const text = calloutText(m);
    if (!text) return;
    const from = m.from === 'system' ? 'CO-DRIVER (PANICKING)' : 'NAVIGATOR';
    this.d.ui.subtitle(text, from, m.auto);
    this.d.audio.radioBlip();
    const iAmNavigatorOnly = this.roles.length === 1 && this.roles[0] === 'navigator';
    // the navigator hears their own shouts through voice chat, not TTS
    if (!(iAmNavigatorOnly && !m.auto && this.d.mode === 'online')) this.voice.speak(text, m.id !== 'note');
  }

  /** Impact effects. `echo` = came back from the authority (server or local). */
  private onImpactFx(fx: ImpactFx, echo: boolean) {
    // the online driver already played its own impacts immediately
    if (echo && this.d.mode === 'online' && this.simulateCar) return;
    const dir = _v.set(fx.dx, fx.dy, fx.dz);
    this.driverView.motion.shock(dir, fx.strength);
    this.navView.motion.shock(dir, fx.strength);
    if (this.cabin) this.cabin.shock(dir, fx.strength);
    const pan = clamp(fx.dx - this.listenerSide() * 0.3, -1, 1);
    this.carAudio.impact(fx.strength, pan, fx.kind);
    if (fx.kind === 'tree' || fx.kind === 'bale' || fx.kind === 'rock') {
      const p = _v2.set(fx.dx * 1.5, 0.5, fx.dz * 2).applyQuaternion(this.cs.quat).add(this.cs.pos);
      const col = fx.kind === 'tree' ? 0x6b4d33 : fx.kind === 'bale' ? 0xd8b04f : 0x8a877e;
      for (let i = 0; i < 10; i++) {
        this.particles.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 5, Math.random() * 4 + 1, (Math.random() - 0.5) * 5, 0.06 + Math.random() * 0.08, 1.2, col, 9, 0.5);
      }
    }
    if (fx.kind === 'landing') this.dustBurst(14, 0xa38d6c);
  }

  private onCabinContact(index: number, strength: number) {
    const p = this.cabin ? this.cabin.currPos[index] : this.lastCabinPose[index].pos;
    const pan = clamp((p.x - LAYOUT.seatX * this.listenerSide()) * 1.4, -1, 1);
    this.carAudio.clack(strength * (index === 0 ? 1 : 0.7), pan);
  }

  private onTabletDropped(reason: string) {
    this.d.session.setTabletHeld(false);
    this.d.session.reportTabletDrop();
    this.d.ui.toast(reason === 'impact' ? 'TABLET KNOCKED AWAY!' : reason === 'gforce' ? 'TABLET SLIPPED!' : 'LOST GRIP!', 'bad');
    if (this.d.mode === 'solo') this.aiRegrab = 2.2 + Math.random() * 1.5;
  }

  // ================================================================= controls ==
  setPaused(paused: boolean) {
    if (this.d.session.canPause) {
      this.pausedLocal = paused;
      this.d.session.setPaused(paused);
      this.d.audio.setPaused(paused);
      this.voice.stop();
    } else {
      // online: the menu opens but the shared stage keeps running
      this.pausedLocal = false;
    }
    this.d.input.gameplay = !paused;
  }

  get views(): View[] {
    if (this.phase === 'finished' && this.results) return [{ camera: this.orbitCam, x: 0, y: 0, w: 1, h: 1 }];
    if (this.d.mode === 'couch') {
      return [
        { camera: this.driverView.camera, x: 0, y: 0, w: 0.5, h: 1 },
        { camera: this.navView.camera, x: 0.5, y: 0, w: 0.5, h: 1 },
      ];
    }
    return [{ camera: this.primaryCamera, x: 0, y: 0, w: 1, h: 1 }];
  }

  get hudViews(): { role: Role; rect: { x: number; y: number; w: number; h: number } }[] {
    if (this.d.mode === 'couch') {
      return [
        { role: 'driver', rect: { x: 0, y: 0, w: 0.5, h: 1 } },
        { role: 'navigator', rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
      ];
    }
    return [{ role: this.roles[0] ?? 'driver', rect: { x: 0, y: 0, w: 1, h: 1 } }];
  }

  // ==================================================================== frame ==
  frame(dtRaw: number) {
    if (this.disposed || !this.stage) return;
    const dt = Math.min(dtRaw, 0.1);
    const d = this.d;
    const now = performance.now();
    d.session.tick(dt);
    const frozen = this.pausedLocal || this.pausedRemote;

    // countdown display
    if (this.phase === 'countdown') {
      const left = (this.countdownEndsAt - d.session.now()) / 1000;
      const n = Math.ceil(left);
      const text = n > 3 ? null : n >= 1 ? String(n) : null;
      if (text && text !== this.lastCountdown) {
        d.audio.countdownBeep(false);
        this.lastCountdown = text;
      }
      d.ui.countdown(text);
    }

    // driver input (per frame; consumed by fixed steps)
    if (this.driverControls) {
      const enabled = !frozen && (this.phase === 'racing' || this.phase === 'countdown');
      this.driverControls.update(dt, enabled, d.mode !== 'couch');
      this.handleDriverActions();
    }

    // fixed-step simulation
    if (!frozen) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        if (this.vehicle) this.stepCar(FIXED_DT);
        this.simTime += FIXED_DT;
        if (!this.vehicle) this.sampleRemoteCar();
        if (this.cabin) this.stepCabin(FIXED_DT);
        this.acc -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.acc = 0; // never spiral
    }
    const alpha = this.acc / FIXED_DT;
    if (this.vehicle) this.cs.fromVehicle(this.vehicle, alpha);
    else this.sampleRemoteCar(dt);
    if (this.driverControls) {
      this.cs.headYaw = this.driverControls.lookYaw;
      this.cs.headPitch = this.driverControls.lookPitch;
    }

    this.applyPose(alpha);
    this.updateCabinVisuals(alpha);
    this.updateViews(dt);
    this.updateNavigator(dt);
    this.updateArms(dt);
    this.updateCockpit(dt);
    this.updateNavigation(dt, now);
    this.updateAudio(dt);
    this.particles.update(dt);
    if (this.vehicle && !frozen) this.emitDriveParticles(dt);
    this.props.updateMeshes(alpha, dt);
    this.sky.update(this.cs.pos);
    this.updateHud(dt, now);
    this.render();
    this.frameCount++;
  }
  private lastCountdown: string | null = null;

  private handleDriverActions() {
    const dc = this.driverControls!;
    const s = this.d.session;
    if (dc.toggleWipers) s.setWipers(!this.wipersOn);
    if (dc.requestReset && this.resetCooldown <= 0 && this.phase !== 'finished') {
      this.resetCooldown = 1;
      s.requestReset();
    }
    if (dc.closeDoor && this.doorStates.left && this.closingDoorTimer.left <= 0) {
      this.closingDoorTimer.left = 0.75;
    }
    let flags = this.cs.flags & ~(CAR_FLAG.horn | CAR_FLAG.wiping | CAR_FLAG.closingDoor | CAR_FLAG.wipers);
    if (dc.horn) flags |= CAR_FLAG.horn;
    if (dc.wiping) flags |= CAR_FLAG.wiping;
    if (this.closingDoorTimer.left > 0) flags |= CAR_FLAG.closingDoor;
    if (this.wipersOn) flags |= CAR_FLAG.wipers;
    this.cs.flags = flags;
  }

  // -------------------------------------------------------------------- car --
  private stepCar(dt: number) {
    const v = this.vehicle!;
    const dc = this.driverControls!;
    const s = this.d.session;
    this.resetCooldown -= dt;
    v.frozen = this.phase === 'countdown' || this.phase === 'loading';
    // one hand off the wheel while wiping / closing the door / shifting
    let authority = 1;
    if (dc.wiping) authority = 0.5;
    if (this.closingDoorTimer.left > 0) authority = 0.45;
    const inp = dc.driveInput(authority, this.d.settings.data.manualGearbox);
    if (this.phase === 'finished') {
      inp.throttle = 0;
      inp.brake = 0.35;
    }
    // open doors drag the car and pull it to one side; bushes slow it down
    const speed = this.cs.speed;
    const sl = Math.sin(this.doors.left.angle);
    const sr = Math.sin(this.doors.right.angle);
    v.extraYawTorque = (sl - sr) * speed * speed * 1.6;
    v.extraDrag = (sl + sr) * 5 * speed;
    const bushes = this.veg.bushesAt(this.cs.pos.x, this.cs.pos.z, 1.2);
    if (bushes > 0) {
      v.extraDrag += bushes * 240;
      this.rustleTimer -= dt;
      if (this.rustleTimer <= 0 && speed > 3) {
        this.rustleTimer = 0.35;
        this.carAudio.rustle(Math.min(1, speed / 15));
        for (let i = 0; i < 5; i++) {
          const p = _v.set((Math.random() - 0.5) * 1.6, 0.6, -1.9).applyQuaternion(this.cs.quat).add(this.cs.pos);
          this.particles.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 3, 0.07, 1.4, 0x4f8a35, 3, 1.2);
        }
      }
    }

    v.preStep(inp, dt);
    this.physics!.step();
    v.postStep(dt);
    this.props.afterPhysicsStep();

    for (const imp of v.impacts) {
      s.reportImpact({ strength: imp.strength, dx: imp.dir.x, dy: imp.dir.y, dz: imp.dir.z, kind: imp.kind });
      // online drivers feel their own hits immediately; everyone else waits for the authority echo
      if (this.d.mode === 'online') this.onImpactFx({ strength: imp.strength, dx: imp.dir.x, dy: imp.dir.y, dz: imp.dir.z, kind: imp.kind }, false);
    }
    v.impacts.length = 0;
    // suspension thumps over big bumps
    if (v.roughness > 0.55 && Math.random() < v.roughness * 0.08) this.carAudio.thump(v.roughness * 0.6);

    // mud
    const now = performance.now();
    if (v.puddleHit >= 0 && speed > 4 && (v.puddleHit !== this.lastPuddle || now - this.lastPuddleAt > 1600)) {
      this.lastPuddle = v.puddleHit;
      this.lastPuddleAt = now;
      s.reportMud({ kind: 'puddle', amount: Math.min(1, speed / 18), puddle: v.puddleHit });
      this.splashParticles(Math.min(1, speed / 18));
    }
    if (v.surfaceAvg > 0.6 && speed > 10) {
      this.dirtTimer -= dt;
      if (this.dirtTimer <= 0) {
        this.dirtTimer = 0.8;
        s.reportMud({ kind: 'dirt', amount: Math.min(0.3, speed / 80) });
      }
    }
    // safety: fell out of the world / far into the woods
    if (this.steps % 30 === 0 && this.phase === 'racing') {
      const ground = this.field.heightAt(this.cs.pos.x, this.cs.pos.z);
      const q = this.locator.locate(this.cs.pos.x, this.cs.pos.z);
      if (this.cs.pos.y < ground - 4 || q.distance > 140) {
        if (this.resetCooldown <= 0) {
          this.resetCooldown = 3;
          s.requestReset();
          this.d.ui.hint('TOO FAR OFF THE ROUTE - RESETTING', 3);
        }
      }
    }

    // network: car state at 30 Hz, props at 10 Hz
    this.steps++;
    if (this.steps % 2 === 0) {
      this.cs.fromVehicle(v, 1);
      if (this.driverControls) {
        this.cs.headYaw = this.driverControls.lookYaw;
        this.cs.headPitch = this.driverControls.lookPitch;
      }
      this.cs.toSnapshot(this.carOut, this.simTime, this.seq++);
      s.sendCarState(this.d.mode === 'online' ? this.carOut : this.carOut.slice());
    }
    if (this.d.mode === 'online' && this.steps % 6 === 0) {
      const p = this.props.packMoving();
      if (p) s.sendProps(p);
    }
  }

  private sampleRemoteCar(dt = 0) {
    if (!this.carBuf) return;
    if (this.carBuf.sample(performance.now() / 1000, this.carSample)) this.cs.fromSnapshot(this.carSample, dt);
  }

  // ------------------------------------------------------------------ cabin --
  private stepCabin(dt: number) {
    const cabin = this.cabin!;
    // effective gravity in the car frame = g - a
    _q.copy(this.cs.quat).invert();
    _g.set(0, -9.81, 0).applyQuaternion(_q).sub(this.cs.accelLocal);
    if (this.navControls && cabin.held >= 0) {
      cabin.setHoldTarget(this.holdPos, this.holdQuat);
    } else if (this.d.mode === 'solo') {
      // AI passenger holds the tablet in front of their chest, facing themselves
      this.aiRegrab -= dt;
      if (cabin.held !== 0 && this.aiRegrab <= 0 && cabin.canGrab()) {
        if (cabin.currPos[0].distanceTo(this.navBody.shoulderR) < 1.35) {
          cabin.grab(0);
          this.d.session.setTabletHeld(true);
        } else this.aiRegrab = 1;
      }
      const pos = _v.set(0.32, 0.36, -0.12);
      const look = _v2.copy(LAYOUT.navEye).sub(pos).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const x = new THREE.Vector3().crossVectors(up.clone().addScaledVector(look, -look.y).normalize(), look).normalize();
      const u = new THREE.Vector3().crossVectors(look, x).normalize();
      const m = new THREE.Matrix4().makeBasis(x, look, u.negate());
      cabin.setHoldTarget(pos, _q.setFromRotationMatrix(m));
    }
    cabin.step(dt, _g);
    if (this.d.mode === 'online' && this.navControls && this.steps % 3 === 0) this.sendCabin();
    if (!this.vehicle) this.steps++;
  }

  private sendCabin() {
    const cabin = this.cabin!;
    const b = this.cabinOut;
    const nc = this.navControls!;
    b[CABIN.time] = this.simTime;
    let flags = 0;
    if (cabin.held === 0) flags |= CABIN_FLAG.tabletHeld;
    if (nc.reaching) flags |= CABIN_FLAG.reaching;
    if (this.closingDoorTimer.right > 0) flags |= CABIN_FLAG.closingDoor;
    b[CABIN.flags] = flags;
    b[CABIN.headYaw] = nc.lookYaw;
    b[CABIN.headPitch] = nc.lookPitch;
    for (let i = 0; i <= LOOSE_OBJECT_COUNT; i++) {
      const o = i === 0 ? CABIN.tablet : CABIN.objects + (i - 1) * 7;
      const p = cabin.currPos[i];
      const q = cabin.currQuat[i];
      b[o] = p.x;
      b[o + 1] = p.y;
      b[o + 2] = p.z;
      b[o + 3] = q.x;
      b[o + 4] = q.y;
      b[o + 5] = q.z;
      b[o + 6] = q.w;
    }
    b[CABIN.reachX] = nc.reachTarget.x;
    b[CABIN.reachY] = nc.reachTarget.y;
    b[CABIN.reachZ] = nc.reachTarget.z;
    b[CABIN.heldObject] = cabin.held;
    this.d.session.sendCabinState(b);
  }

  private updateCabinVisuals(alpha: number) {
    const objs = [this.tablet.group, ...this.loose];
    if (this.cabin) {
      for (let i = 0; i < objs.length; i++) this.cabin.interpolate(i, alpha, objs[i].position, objs[i].quaternion);
      return;
    }
    if (this.cabinBuf && this.cabinBuf.sample(performance.now() / 1000, this.cabinSample)) {
      const b = this.cabinSample;
      this.remoteTabletHeld = ((b[CABIN.flags] | 0) & CABIN_FLAG.tabletHeld) !== 0;
      this.remoteNavHead.yaw = b[CABIN.headYaw];
      this.remoteNavHead.pitch = b[CABIN.headPitch];
      this.remoteReach.set(b[CABIN.reachX], b[CABIN.reachY], b[CABIN.reachZ]);
      this.remoteHeldObj = Math.round(b[CABIN.heldObject]);
      if ((b[CABIN.flags] | 0) & CABIN_FLAG.closingDoor) this.closingDoorTimer.right = Math.max(this.closingDoorTimer.right, 0.1);
    }
    const b = this.cabinSample;
    for (let i = 0; i < objs.length; i++) {
      const o = i === 0 ? CABIN.tablet : CABIN.objects + (i - 1) * 7;
      objs[i].position.set(b[o], b[o + 1], b[o + 2]);
      if (b[o + 6] !== 0 || b[o + 3] !== 0) objs[i].quaternion.set(b[o + 3], b[o + 4], b[o + 5], b[o + 6]).normalize();
      // remote rattle sounds: sudden stops of fast-moving objects
      const lp = this.lastCabinPose[i];
      const speed = lp.pos.distanceTo(objs[i].position) * 60;
      const prevSpeed = lp.prev.distanceTo(lp.pos) * 60;
      if (prevSpeed > 0.9 && speed < prevSpeed * 0.35) this.onCabinContact(i, Math.min(1, prevSpeed / 4));
      lp.prev.copy(lp.pos);
      lp.pos.copy(objs[i].position);
    }
  }

  // ------------------------------------------------------------------ views --
  private applyPose(_alpha = 1) {
    this.car.root.position.copy(this.cs.pos);
    this.car.root.quaternion.copy(this.cs.quat);
    this.car.root.updateMatrixWorld(true);
  }

  private updateViews(dt: number) {
    const fov = this.d.settings.data.fov;
    const shake = this.d.settings.data.cameraShake;
    this.driverView.motion.intensity = shake;
    this.navView.motion.intensity = shake;
    this.driverView.setFov(fov);
    this.navView.setFov(fov);
    const dyaw = this.cs.headYaw;
    const dpitch = this.cs.headPitch;
    this.driverView.update(dt, this.cs.accelLocal, dyaw, dpitch);
    let nyaw = this.remoteNavHead.yaw;
    let npitch = this.remoteNavHead.pitch;
    if (this.navControls) {
      nyaw = this.navControls.lookYaw;
      npitch = this.navControls.lookPitch;
      this.navView.lean = this.navControls.lean;
    } else if (this.d.mode === 'solo') {
      // AI passenger mostly looks at the tablet, glances at the road
      this.aiTimer += dt;
      nyaw = 0.15 + Math.sin(this.aiTimer * 0.7) * 0.15;
      npitch = this.cabin && this.cabin.held === 0 ? -0.45 : -0.1;
    }
    this.navView.update(dt, this.cs.accelLocal, nyaw, npitch);
    this.driverBody.pose(this.driverView.motion.offset, dyaw * 0.9, dpitch * 0.8);
    this.navBody.pose(this.navView.motion.offset.clone().add(new THREE.Vector3(-0.2, -0.1, -0.1).multiplyScalar(this.navView.lean)), nyaw * 0.9, npitch * 0.8);

    // results orbit camera
    if (this.phase === 'finished') {
      const t = performance.now() / 1000;
      _v.set(Math.sin(t * 0.25) * 7, 2.6, Math.cos(t * 0.25) * 7).add(this.cs.pos);
      this.orbitCam.position.lerp(_v, this.orbitCam.position.lengthSq() ? 0.05 : 1);
      this.orbitCam.lookAt(this.cs.pos.x, this.cs.pos.y + 0.6, this.cs.pos.z);
    }
  }

  private updateNavigator(dt: number) {
    const nc = this.navControls;
    const cabin = this.cabin;
    if (!nc || !cabin) return;
    const rect = this.d.mode === 'couch' ? { x: 0.5, y: 0, w: 0.5, h: 1 } : { x: 0, y: 0, w: 1, h: 1 };
    const enabled = !this.pausedLocal && !this.pausedRemote && this.phase !== 'loading';
    const ctx: NavContext = {
      camera: this.navView.camera,
      rect,
      carRoot: this.car.root,
      eyeLocal: this.navView.eyeLocal,
      shoulderLocal: this.navBody.shoulderR,
      cabin,
      doorHandle: this.doorStates.right ? this.car.doors.right.handle : null,
      enabled,
      lastDirectional: this.lastDirectional,
    };
    nc.update(dt, ctx);
    const a = nc.actions;
    const s = this.d.session;
    if (a.grabbed === 0) {
      s.setTabletHeld(true);
      this.d.audio.uiClick();
    } else if (a.grabbed > 0) this.d.audio.uiClick();
    if (a.released && cabin.held < 0) s.setTabletHeld(false);
    if (a.cantReach) this.d.ui.hint("CAN'T REACH IT - HOLD F TO LEAN, OR WAIT FOR A CORNER TO SLIDE IT BACK", 3);
    if (a.closeDoor && this.doorStates.right && this.closingDoorTimer.right <= 0) this.closingDoorTimer.right = 0.75;
    if (a.callout) {
      if (a.callout === 'left' || a.callout === 'left3') this.lastDirectional = 'left';
      if (a.callout === 'right' || a.callout === 'right3') this.lastDirectional = 'right';
      s.callout(a.callout);
    }
    if (a.readNote) {
      if (this.tabletVisible && this.ins) s.callout('note', spokenNote(this.ins));
      else this.d.ui.hint("YOU CAN'T SEE THE TABLET!", 2);
    }
    if (cabin.held >= 0) nc.holdPose(ctx, this.holdPos, this.holdQuat);
    // cursor feedback
    const canvas = this.d.renderer.canvas;
    canvas.style.cursor = cabin.held >= 0 ? 'grabbing' : nc.hover >= 0 || nc.hoverDoor ? (nc.hoverReachable || nc.hoverDoor ? 'grab' : 'not-allowed') : 'crosshair';
  }

  private doorHandleLocal(side: DoorSide, out: THREE.Vector3): THREE.Vector3 {
    this.car.doors[side].handle.getWorldPosition(out);
    return this.car.root.worldToLocal(out);
  }

  private updateArms(dt: number) {
    const k = this.handsInit ? clamp(dt * 16, 0, 1) : 1;
    this.handsInit = true;
    // ---- driver
    const gl = _v.set(0, 0, 0);
    const gr = _v2.set(0, 0, 0);
    this.cockpit.gripPoints(gl, gr);
    const tl = gl.clone();
    const tr = gr.clone();
    const flags = this.cs.flags;
    const shifting = (flags & CAR_FLAG.shifting) !== 0;
    this.shiftHand = shifting ? 0.35 : Math.max(0, this.shiftHand - dt);
    if ((flags & CAR_FLAG.wiping) !== 0) {
      const t = performance.now() / 1000;
      const uv = this.wipeTargetUV();
      this.windshield.uvToLocal(uv.u + Math.sin(t * 14) * 0.04, uv.v + Math.cos(t * 9) * 0.03, tl);
      tl.add(new THREE.Vector3(0, -0.77, 0.64).multiplyScalar(0.04));
    } else if ((flags & CAR_FLAG.closingDoor) !== 0 || this.closingDoorTimer.left > 0) {
      this.doorHandleLocal('left', tl);
    } else if ((flags & CAR_FLAG.horn) !== 0) {
      tl.copy(LAYOUT.wheelCenter).add(new THREE.Vector3(-0.03, 0.02, 0.05));
    }
    if ((flags & CAR_FLAG.handbrake) !== 0 && this.phase !== 'countdown') this.cockpit.handbrakeGrip(tr);
    else if (this.shiftHand > 0) this.cockpit.gearKnob(tr).add(new THREE.Vector3(0, 0.03, 0));
    this.handL.lerp(tl, k);
    this.handR.lerp(tr, k);
    const db = this.driverBody;
    const axis = this.cockpit.wheelAxis(new THREE.Vector3());
    db.left.solve(db.shoulderL, this.handL, db.shoulderL.clone().add(new THREE.Vector3(-0.35, -0.5, 0.1)), axis.clone().add(new THREE.Vector3(-0.6, 0, 0)));
    db.right.solve(db.shoulderR, this.handR, db.shoulderR.clone().add(new THREE.Vector3(0.35, -0.5, 0.1)), axis.clone().add(new THREE.Vector3(0.6, 0, 0)));

    // ---- navigator
    const nb = this.navBody;
    const restL = new THREE.Vector3(0.22, 0.17, 0.02);
    const restR = new THREE.Vector3(0.5, 0.17, 0.02);
    let nl = restL;
    let nr = restR;
    const held = this.cabin ? this.cabin.held : this.remoteTabletHeld ? 0 : this.remoteHeldObj;
    const tabletHeld = this.cabin ? this.cabin.held === 0 : this.remoteTabletHeld;
    const tg = this.tablet.group;
    if (tabletHeld) {
      // grip the side edges from behind (fingers wrap around the back) so the screen stays visible
      nl = new THREE.Vector3(-0.155, -0.035, 0.035).applyQuaternion(tg.quaternion).add(tg.position);
      nr = new THREE.Vector3(0.155, -0.035, 0.035).applyQuaternion(tg.quaternion).add(tg.position);
    } else if (held > 0) {
      nr = this.loose[held - 1].position.clone();
    } else {
      const reaching = this.navControls ? this.navControls.reaching : false;
      if (reaching) nr = tg.position.clone();
      else if (!this.cabin && this.remoteReach.lengthSq() > 0 && this.remoteHeldObj < 0 && this.remoteReachActive()) nr = this.remoteReach.clone();
    }
    if (this.closingDoorTimer.right > 0) nr = this.doorHandleLocal('right', new THREE.Vector3());
    this.navHandL.lerp(nl, k);
    this.navHandR.lerp(nr, k);
    const up = tabletHeld ? new THREE.Vector3(0, -1, 0).applyQuaternion(tg.quaternion) : new THREE.Vector3(0, 1, 0);
    nb.left.solve(nb.shoulderL, this.navHandL, nb.shoulderL.clone().add(new THREE.Vector3(-0.2, -0.5, 0.2)), up);
    nb.right.solve(nb.shoulderR, this.navHandR, nb.shoulderR.clone().add(new THREE.Vector3(0.35, -0.5, 0.15)), up);

    // door closing timers complete -> tell the authority
    for (const side of ['left', 'right'] as DoorSide[]) {
      if (this.closingDoorTimer[side] > 0) {
        this.closingDoorTimer[side] -= dt;
        const mine = side === 'left' ? this.roles.includes('driver') : this.roles.includes('navigator') || this.d.mode === 'solo';
        if (this.closingDoorTimer[side] <= 0 && mine) this.d.session.closeDoor(side);
      }
    }
    // the AI passenger closes their door after a moment
    if (this.d.mode === 'solo' && this.doorStates.right && this.closingDoorTimer.right <= 0 && Math.random() < dt * 0.4) this.closingDoorTimer.right = 0.75;
  }

  private remoteReachActive(): boolean {
    return ((this.cabinSample[CABIN.flags] | 0) & CABIN_FLAG.reaching) !== 0;
  }

  private wipeTargetUV(): { u: number; v: number } {
    if (!this.simulateCar) return { u: this.cs.wipeU, v: this.cs.wipeV };
    // driver wipes where they are looking
    const cam = this.driverView.camera;
    const ray = this.wipeRay;
    ray.layers.enableAll(); // the windshield lives on the cockpit layer
    ray.setFromCamera(new THREE.Vector2(0, 0), cam);
    const hits = ray.intersectObject(this.windshield.mesh, false);
    if (hits.length && hits[0].uv) {
      this.cs.wipeU = clamp(hits[0].uv.x, 0.03, 0.97);
      this.cs.wipeV = clamp(hits[0].uv.y, 0.05, 0.95);
    } else {
      this.cs.wipeU = 0.3;
      this.cs.wipeV = 0.45;
    }
    return { u: this.cs.wipeU, v: this.cs.wipeV };
  }

  private updateCockpit(dt: number) {
    const cs = this.cs;
    this.car.updateWheels(cs.compression, cs.spin, cs.steer);
    this.car.setBrakeLights(cs.brake > 0.1);
    this.cockpit.update(dt, {
      steer: cs.steer,
      gear: cs.gear,
      shifting: cs.has(CAR_FLAG.shifting),
      handbrake: cs.has(CAR_FLAG.handbrake) ? 1 : 0,
      throttle: cs.throttle,
      brake: cs.brake,
      speed: cs.speed,
      rpm: cs.rpm,
      accelLocal: cs.accelLocal,
      doorOpen: this.doorStates.left || this.doorStates.right,
      wipers: this.wipersOn,
    });
    this.doors.left.update(dt, cs.accelLocal, cs.speed, cs.rough);
    this.doors.right.update(dt, cs.accelLocal, cs.speed, cs.rough);
    // hand wiping
    if (cs.has(CAR_FLAG.wiping)) {
      const uv = this.wipeTargetUV();
      this.windshield.wipeAt(uv.u, uv.v, 0.12);
      if (this.simulateCar && this.d.mode === 'online') {
        this.wipeSendTimer -= dt;
        if (this.wipeSendTimer <= 0) {
          this.wipeSendTimer = 0.1;
          this.d.session.sendWipe(uv.u, uv.v);
        }
      }
    }
    this.windshield.update(dt);
  }

  private updateNavigation(dt: number, now: number) {
    const loc = this.locator.locate(this.cs.pos.x, this.cs.pos.z);
    this.ins = this.phase === 'loading' ? null : computeInstruction(this.stage, loc.idx, this.cs.speed);
    // can the navigator actually see the screen?
    const eye = this.navView.eyeLocal;
    const tg = this.tablet.group;
    const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(tg.quaternion);
    const toEye = eye.clone().sub(tg.position);
    const dist = toEye.length();
    const facing = normal.dot(toEye.normalize());
    const camDir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.navView.camera.quaternion);
    const inView = camDir.dot(tg.position.clone().sub(eye).normalize()) > 0.45;
    this.tabletVisible = facing > 0.25 && dist < 1.3 && inView;
    // AI co-driver
    if (this.ai && (this.phase === 'racing' || this.phase === 'countdown')) {
      const canSee = !!this.cabin && this.cabin.held === 0;
      const note = this.phase === 'racing' ? this.ai.update(loc.idx, this.cs.speed, canSee) : null;
      if (note) {
        this.d.ui.subtitle(note.text, 'AI CO-DRIVER', false);
        this.voice.speak(note.text, note.urgent);
      }
    }
    // tablet screen at ~20 fps
    this.minimapTimer -= dt;
    if (this.minimapTimer <= 0) {
      this.minimapTimer = 1 / 20;
      const st = this.stats;
      this.minimap.draw({
        x: this.cs.pos.x,
        z: this.cs.pos.z,
        heading: this.cs.heading,
        speed: this.cs.speed,
        idx: loc.idx,
        ins: this.ins,
        timeMs: this.raceTimeMs(now),
        checkpointsHit: st?.checkpointsHit ?? 0,
        checkpointsTotal: this.stage.checkpoints.length,
        wrongWay: !!st?.wrongWay,
        flash: this.flash,
        banner: this.phase === 'countdown' ? 'GET READY…' : this.phase === 'finished' ? 'STAGE COMPLETE!' : null,
        now,
      });
    }
  }

  private raceTimeMs(now: number): number {
    if (this.phase === 'finished' && this.results) return this.results.timeMs;
    if (this.phase !== 'racing' || !this.stats) return 0;
    if (this.pausedLocal || this.pausedRemote) return this.stats.timeMs;
    return this.stats.timeMs + (now - this.statsAt);
  }

  private updateAudio(dt: number) {
    const cs = this.cs;
    this.carAudio.update(dt, {
      rpm: cs.rpm,
      throttle: cs.throttle,
      speed: cs.speed,
      slip: cs.slip,
      surface: cs.surface,
      airborne: cs.has(CAR_FLAG.airborne),
      limiter: cs.limiter,
      shifting: cs.has(CAR_FLAG.shifting),
      doorOpen: (this.doorStates.left ? 1 : 0) + (this.doorStates.right ? 1 : 0),
      wipers: this.windshield.wipersActive,
      horn: cs.has(CAR_FLAG.horn),
      rough: cs.rough,
      listenerX: this.listenerSide(),
    });
  }

  private emitDriveParticles(dt: number) {
    const v = this.vehicle!;
    const speed = this.cs.speed;
    const rate = (speed > 6 ? speed * 0.6 : 0) + v.slipAmount * 30;
    if (rate <= 0) return;
    const n = Math.random() < rate * dt ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const w = v.wheels[2 + (Math.random() < 0.5 ? 0 : 1)];
      if (!w.grounded) continue;
      const col = w.surface === 'grass' ? 0x7fa04c : w.surface === 'mud' ? 0x5a4127 : 0xd2c29e;
      const back = _v.set(0, 0, 1).applyQuaternion(this.cs.quat);
      this.particles.emit(w.contact.x, w.contact.y + 0.15, w.contact.z, back.x * 2 + (Math.random() - 0.5) * 2, 0.8 + Math.random() * 1.2, back.z * 2 + (Math.random() - 0.5) * 2, 0.1 + Math.random() * 0.14 + v.slipAmount * 0.22, 0.7 + Math.random() * 0.5, col, -0.3, 1.8);
    }
  }

  private dustBurst(n: number, color: number) {
    for (let i = 0; i < n; i++) {
      const p = _v.set((Math.random() - 0.5) * 2, -0.3, (Math.random() - 0.5) * 3.5).applyQuaternion(this.cs.quat).add(this.cs.pos);
      this.particles.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 4, Math.random() * 2, (Math.random() - 0.5) * 4, 0.16 + Math.random() * 0.2, 1.1, color, -0.2, 1.5);
    }
  }

  private splashParticles(amount: number) {
    for (let i = 0; i < 18 * amount + 6; i++) {
      const p = _v.set((Math.random() - 0.5) * 1.8, -0.2, -1.6 + Math.random() * 2.8).applyQuaternion(this.cs.quat).add(this.cs.pos);
      this.particles.emit(p.x, p.y, p.z, (Math.random() - 0.5) * 5 + this.cs.vel.x * 0.3, 2 + Math.random() * 4, (Math.random() - 0.5) * 5 + this.cs.vel.z * 0.3, 0.08 + Math.random() * 0.12, 1, 0x4a3a28, 9.81, 0.4);
    }
  }

  private updateHud(dt: number, now: number) {
    const ui = this.d.ui;
    const st = this.stats;
    const s = this.d.session as GameSession & { status?: string; rtt?: number };
    const cp = `CP ${st?.checkpointsHit ?? 0}/${this.stage.checkpoints.length}`;
    let status: string | null = null;
    if (this.d.mode === 'online') status = `${s.status === 'online' ? '● ONLINE' : `● ${String(s.status).toUpperCase()}`}${s.rtt ? ` ${Math.round(s.rtt)}ms` : ''}`;
    this.hudViews.forEach((v, i) => {
      const data: HudData = {
        speedKmh: this.cs.speed * 3.6,
        gear: this.cs.gear,
        timeMs: this.raceTimeMs(now),
        cp,
        status,
        grip: null,
        warn: null,
        hover: null,
      };
      if (v.role === 'navigator' && this.cabin && this.navControls) {
        const nc = this.navControls;
        data.grip = this.cabin.held === 0 ? this.cabin.grip : null;
        if (this.cabin.held !== 0) data.warn = this.cabin.currPos[0].distanceTo(this.navBody.shoulderR) > nc.reach() ? 'TABLET OUT OF REACH! HOLD F' : 'TABLET DROPPED! CLICK IT OR PRESS F';
        else if (!this.tabletVisible) data.warn = 'TABLET FACING AWAY / OUT OF VIEW';
        if (this.doorStates.right) data.warn = (data.warn ? data.warn + ' · ' : '') + 'DOOR OPEN! (G)';
        if (nc.mouseInView && (nc.hover >= 0 || nc.hoverDoor)) {
          const r = this.d.renderer.canvas.getBoundingClientRect();
          const names = ['TABLET', 'WATER BOTTLE', 'COFFEE', 'PACE NOTES', 'SNACKS'];
          data.hover = {
            text: nc.hoverDoor ? 'CLOSE DOOR' : nc.hoverReachable ? `GRAB ${names[nc.hover]}` : 'TOO FAR',
            x: this.d.input.mouseX - r.left - v.rect.x * r.width,
            y: this.d.input.mouseY - r.top,
          };
        }
      }
      if (v.role === 'driver') {
        const warns: string[] = [];
        if (this.doorStates.left) warns.push('YOUR DOOR IS OPEN! (G)');
        if (st?.wrongWay) warns.push('WRONG WAY');
        if (this.windshield.coverage > 0.28) warns.push('CAN’T SEE! WIPERS (V) / WIPE (C)');
        data.warn = warns.length ? warns.join(' · ') : null;
      }
      ui.updateHud(dt, i, data);
    });
    // fps
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fpsText = `${Math.round(this.fpsFrames / this.fpsAcc)} fps`;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    ui.fps(this.d.settings.data.showFps ? this.fpsText : null);
  }

  private render() {
    const r = this.d.renderer;
    // mirrors every other frame
    if (this.frameCount % 2 === 0 && this.phase !== 'finished') r.renderToTarget(this.scene, this.mirrorCam, this.mirrorRT);
    r.render(this.scene, this.views);
  }

  dispose() {
    this.disposed = true;
    for (const u of this.unsub) u();
    this.unsub = [];
    this.voice.stop();
    this.terrain?.dispose();
    this.road?.dispose();
    this.veg?.dispose();
    this.props?.dispose();
    this.vehicle?.dispose();
    this.car?.dispose();
    this.cockpit?.dispose();
    this.windshield?.dispose();
    this.driverBody?.dispose();
    this.navBody?.dispose();
    this.tablet?.dispose();
    for (const m of this.loose) m.geometry.dispose();
    this.minimap?.dispose();
    this.particles?.dispose();
    this.sky?.dispose();
    this.mirrorRT?.dispose();
    this.cabin?.dispose();
    this.physics?.dispose();
    this.scene.clear();
    this.d.renderer.canvas.style.cursor = '';
  }
}

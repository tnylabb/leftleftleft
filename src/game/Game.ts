// One rally stage in progress: builds the world, runs the fixed-step
// simulation for whichever roles are local, exchanges state through the
// session, and renders one (online / solo) or two (couch) first-person views.

import * as THREE from 'three';
import { CarAudio } from '../audio/CarAudio';
import type { AudioEngine } from '../audio/AudioEngine';
import { Cockpit } from '../cockpit/Cockpit';
import { DoorSim } from '../cockpit/Doors';
import { Headlamp } from '../cockpit/Headlamp';
import { LAYOUT } from '../cockpit/layout';
import { Occupant } from '../cockpit/Occupant';
import { Windshield } from '../cockpit/Windshield';
import { DRIVER_KEYS, NAV_KEYS, type BindMode } from '../core/Bindings';
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
import {
  CABIN_BODY,
  CABIN_BODY_COUNT,
  CAR_HOOKS,
  DOOR_EXIT,
  ENTER_RADIUS,
  EXIT_MAX_SPEED,
  FIXED_DT,
  GRIP_REACH,
  MAX_STEPS_PER_FRAME,
  ROAD_HALF_WIDTH,
} from '../shared/constants';
import { clamp } from '../shared/math';
import { RoadLocator } from '../shared/race/RoadLocator';
import { CABIN, CABIN_FLAG, CAR, CAR_FLAG, cabinPoseOffset } from '../shared/snapshot';
import { computeInstruction, spokenNote, type NavInstruction } from '../shared/stage/pacenotes';
import { generateStage, stageStartPose } from '../shared/stage/StageGenerator';
import type { CalloutMsg, DoorSide, ImpactFx, RaceEvent, RaceResults, RaceStats, Role, SeatStates, StageData, StageParams } from '../shared/types';
import { CABIN_OBJECT_NAMES } from '../tablet/cabinObjects';
import { TabletModel, buildLooseObjectMeshes } from '../tablet/TabletModel';
import { controlRows, type ControlsState } from '../ui/controlsHelp';
import type { HudData, UI } from '../ui/UI';
import { CarModel } from '../vehicle/CarModel';
import { VehicleController } from '../vehicle/VehicleController';
import { Props } from '../world/Props';
import { Road } from '../world/Road';
import { Terrain } from '../world/Terrain';
import { TerrainField } from '../world/TerrainField';
import { Vegetation } from '../world/Vegetation';
import { CarRenderState } from './CarRenderState';
import { FallCamera } from './FallCamera';
import { CINEMATIC_SECONDS, FinishCinematic } from './FinishCinematic';
import { EYE_HEIGHT, FootAvatar, FootController, hookWorld, type FootEnv, type FootIntent } from './OnFoot';
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
const DOOR_OF: Record<Role, DoorSide> = { driver: 'left', navigator: 'right' };

export class Game {
  readonly scene = new THREE.Scene();
  stage!: StageData;
  phase: GamePhase = 'loading';
  results: RaceResults | null = null;
  private d: GameDeps;
  private roles: Role[];
  private bindMode: BindMode;
  private simulateCar: boolean;
  private simulateCabin: boolean;
  private night = false;

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
  private headlamp!: Headlamp;
  /** The car's opaque bodywork (not the glass): blocks the head lamp from outside. */
  private bodywork: THREE.Object3D[] = [];
  private loose: THREE.Mesh[] = [];
  /** Render objects for cabin bodies, index-aligned with CabinPhysics.bodies. */
  private bodyObjects: THREE.Object3D[] = [];
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
  private carAudio: CarAudio;
  private voice: Voice;
  private ai: AICoDriver | null = null;
  private locator!: RoadLocator;
  private ins: NavInstruction | null = null;

  // seats / on foot
  private seats: SeatStates = { driver: true, navigator: true };
  private seatChangedAt: Record<Role, number> = { driver: -1e9, navigator: -1e9 };
  private footDriver = new FootController();
  private footNav = new FootController();
  private driverAvatar!: FootAvatar;
  private navAvatar!: FootAvatar;
  private footCamDriver!: THREE.PerspectiveCamera;
  private footCamNav!: THREE.PerspectiveCamera;
  private footEnv!: FootEnv;
  private obstacleScratch: { x: number; z: number; r: number }[] = [];
  private stuckNoticeUntil = 0;

  // over the edge: third-person view of the fall
  private fallCam: FallCamera | null = null;
  private fallRest = 0;
  private fallCooldown = 0;

  // finish
  private cinematic: FinishCinematic | null = null;
  private finishStarted = false;

  // head lamp / glare
  private lampOn = false;
  private glare = 0;
  private glareArmed = true;
  private glareAway = 0;
  private lastGlareAt = -1e9;
  private glareRay = new THREE.Raycaster();
  private tabletLit = true;
  private aiLampOn = false;
  private aiGlance = 0;

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
  private lastCountdown: string | null = null;

  constructor(deps: GameDeps) {
    this.d = deps;
    this.roles = deps.mode === 'online' ? [...deps.session.localRoles] : deps.mode === 'couch' ? ['driver', 'navigator'] : ['driver'];
    this.bindMode = deps.mode === 'couch' ? 'couch' : 'single';
    this.simulateCar = this.roles.includes('driver');
    this.simulateCabin = this.roles.includes('navigator') || deps.mode === 'solo';
    this.carAudio = new CarAudio(deps.audio);
    this.voice = new Voice(deps.settings);
  }

  get isPaused(): boolean {
    return this.pausedLocal;
  }

  /** True once the finish cinematic has played (results may be shown). */
  get cinematicDone(): boolean {
    return !!this.cinematic && this.cinematic.elapsed >= CINEMATIC_SECONDS;
  }

  /** Whether the local player currently looks around with a captured mouse. */
  get wantsPointerLock(): boolean {
    if (this.phase === 'finished' || this.cinematic) return false;
    // split screen: the mouse belongs to the navigator; otherwise both roles look with it
    if (this.d.mode === 'couch') return this.roles.includes('navigator');
    return this.roles.length > 0;
  }

  // ===================================================================== load ==
  async load(params: StageParams, progress: (f: number, text: string) => Promise<void>): Promise<number> {
    const d = this.d;
    const quality = d.settings.data.quality;
    await progress(0.02, 'Generating rally stage…');
    this.stage = generateStage(params);
    this.night = this.stage.params.night;
    this.locator = new RoadLocator(this.stage);
    d.renderer.applyQuality(quality);
    this.sky = new Sky(this.scene, d.renderer.shadowMapSize, this.night, this.stage.params.map === 'mountain');
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
    this.d.renderer.lightAllLayers(this.scene);
    this.d.renderer.renderer.compile(this.scene, this.primaryCamera);
    await progress(1, 'Waiting for your co-driver…');
    return this.stage.hash;
  }

  private buildCar() {
    const d = this.d;
    this.car = new CarModel();
    this.car.setHeadlights(this.night);
    this.car.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !(m.material as THREE.Material).transparent) this.bodywork.push(m);
    });
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
    this.tablet = new TabletModel(this.minimap.texture, this.night);
    this.car.root.add(this.tablet.group);
    this.loose = buildLooseObjectMeshes();
    for (const m of this.loose) this.car.root.add(m);
    this.headlamp = new Headlamp(this.night);
    this.scene.add(this.headlamp.group);
    this.bodyObjects = [this.tablet.group, ...this.loose];
    for (let i = 0; i < CABIN_BODY_COUNT; i++) this.lastCabinPose.push({ pos: new THREE.Vector3(), prev: new THREE.Vector3() });

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
    if (this.roles.includes('driver')) this.driverControls = new DriverControls(d.input, d.settings, this.bindMode);
    if (this.roles.includes('navigator')) this.navControls = new NavigatorControls(d.input, d.settings, this.bindMode, d.renderer.canvas);

    // on-foot avatars and cameras
    this.driverAvatar = new FootAvatar('driver');
    this.navAvatar = new FootAvatar('navigator');
    this.scene.add(this.driverAvatar.root, this.navAvatar.root);
    const footCam = (role: Role) => {
      const c = new THREE.PerspectiveCamera(fov, 16 / 9, 0.05, 580);
      c.rotation.order = 'YXZ';
      c.layers.enable(LAYER.COCKPIT);
      c.layers.enable(role === 'driver' ? LAYER.NAV_BODY : LAYER.DRIVER_BODY);
      this.scene.add(c);
      return c;
    };
    this.footCamDriver = footCam('driver');
    this.footCamNav = footCam('navigator');
    this.footEnv = {
      groundY: (x, z) => this.groundY(x, z),
      carPos: this.cs.pos,
      carQuat: this.cs.quat,
      obstacles: (x, z, r, out) => this.veg.obstaclesNear(x, z, r, out),
    };

    // mirrors: one wide backwards render feeds the rear-view and both side mirrors
    this.mirrorRT = new THREE.WebGLRenderTarget(384, 128, { depthBuffer: true });
    this.mirrorRT.texture.colorSpace = THREE.SRGBColorSpace;
    this.mirrorCam = new THREE.PerspectiveCamera(36, 3, 0.3, 260);
    this.mirrorCam.position.set(0, 0.62, 1.3);
    this.mirrorCam.rotation.set(-0.04, Math.PI, 0);
    this.mirrorCam.layers.set(LAYER.WORLD);
    this.car.root.add(this.mirrorCam);
    this.cockpit.setMirrorTexture(this.mirrorRT.texture);

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
        dropped: (i, reason) => this.onObjectDropped(i, reason),
      });
    } else {
      const poses = Array.from({ length: CABIN_BODY_COUNT }, (_, k) => cabinPoseOffset(k));
      this.cabinBuf = new SnapshotBuffer(CABIN.LENGTH, makePoseInterp(poses, [CABIN.flags, CABIN.heldObject, CABIN.footGrip]), 0.1);
      // until the first snapshot arrives, show everything at its start position
      this.cabinSample[CABIN.tablet] = LAYOUT.navLap.x;
      this.cabinSample[CABIN.tablet + 1] = LAYOUT.navLap.y;
      this.cabinSample[CABIN.tablet + 2] = LAYOUT.navLap.z;
      this.cabinSample[CABIN.tablet + 6] = 1;
      this.cabinSample[CABIN.heldObject] = -1;
      this.cabinSample[CABIN.footGrip] = -1;
    }
    if (d.mode === 'solo') this.ai = new AICoDriver(this.stage);
  }

  private listenerSide(): number {
    return this.roles.includes('driver') ? -1 : 1;
  }

  private get primaryCamera(): THREE.PerspectiveCamera {
    return this.cameraFor(this.roles.includes('driver') ? 'driver' : 'navigator');
  }

  private cameraFor(role: Role): THREE.PerspectiveCamera {
    if (role === 'driver') return this.seats.driver ? this.driverView.camera : this.footCamDriver;
    return this.seats.navigator ? this.navView.camera : this.footCamNav;
  }

  /** Ground height for walking: the road surface on the road, terrain elsewhere. */
  private groundY(x: number, z: number): number {
    const q = this.field.queryRoad(x, z);
    if (q.dist < ROAD_HALF_WIDTH + 0.35) return q.roadY;
    return this.field.heightAt(x, z);
  }

  private carPointToWorld(p: { x: number; y: number; z: number }, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(p.x, p.y, p.z).applyQuaternion(this.cs.quat).add(this.cs.pos);
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
        this.statsAt = performance.now();
      }),
      s.on('results', (r) => {
        this.results = r;
        this.phase = 'finished';
        this.startFinish();
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
        this.d.ui.toast(this.phase === 'racing' ? 'EMERGENCY RESET  +5s' : 'CAR RESET', 'info');
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
      s.on('wiperCycle', () => this.windshield.triggerCycle()),
      s.on('seats', (seats) => this.onSeats(seats)),
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
        this.stuckNoticeUntil = now + 15000;
        ui.toast(e.flipped ? 'FLIPPED!' : 'STUCK!', 'bad');
        break;
      case 'finish':
        this.startFinish();
        break;
      case 'wrongWay':
        break;
    }
  }

  /** Cinematic finish: shared trigger (authority event), guarded against duplicates. */
  private startFinish() {
    if (this.finishStarted) return;
    this.finishStarted = true;
    this.d.input.exitPointerLock();
    this.cinematic = new FinishCinematic(this.primaryCamera);
    const t = this.results ? this.results.timeMs / 1000 : this.raceTimeMs(performance.now()) / 1000;
    const mm = Math.floor(t / 60);
    this.d.ui.cinematic('STAGE COMPLETE', `${mm}:${(t % 60).toFixed(2).padStart(5, '0')}`);
    this.d.audio.fanfare();
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

  private onObjectDropped(index: number, reason: string) {
    if (index === CABIN_BODY.tablet) {
      this.d.session.setTabletHeld(false);
      this.d.session.reportTabletDrop();
      this.d.ui.toast(reason === 'impact' ? 'TABLET KNOCKED AWAY!' : reason === 'gforce' ? 'TABLET SLIPPED!' : 'LOST GRIP!', 'bad');
      if (this.d.mode === 'solo') this.aiRegrab = 2.2 + Math.random() * 1.5;
    }
  }

  // ==================================================================== seats ==
  /** Authoritative seat change: someone got out or back in. */
  private onSeats(next: SeatStates) {
    const prev = this.seats;
    this.seats = { ...next };
    for (const role of ['driver', 'navigator'] as Role[]) {
      if (prev[role] === next[role]) continue;
      this.seatChangedAt[role] = performance.now();
      this.doors[DOOR_OF[role]].passThrough();
      const local = this.roles.includes(role);
      if (!next[role]) {
        // stepped out: stand next to the door, facing along the car
        if (local) {
          const foot = role === 'driver' ? this.footDriver : this.footNav;
          foot.place(this.exitSpot(role), this.carYaw());
          if (role === 'navigator' && this.cabin) this.cabin.releaseAll();
          if (this.d.mode !== 'couch' || role === 'navigator') this.d.input.requestPointerLock();
          this.d.ui.hint('GRAB A TOW HOOK (FRONT OR REAR BUMPER) AND WALK AWAY TO PULL', 5);
        }
      } else {
        (role === 'driver' ? this.driverAvatar : this.navAvatar).hide();
        if (local && role === 'navigator') this.d.input.exitPointerLock();
      }
    }
  }

  /** Camera yaw that faces along the car's nose. */
  private carYaw(): number {
    const f = _v.set(0, 0, -1).applyQuaternion(this.cs.quat);
    return Math.atan2(-f.x, -f.z);
  }

  /** A free place to stand outside the given door (avoids trees right next to it). */
  private exitSpot(role: Role): THREE.Vector3 {
    const d = DOOR_EXIT[role];
    const candidates = [d, { x: d.x, y: 0, z: d.z + 1.4 }, { x: d.x, y: 0, z: d.z - 1.4 }, { x: d.x * 1.5, y: 0, z: d.z }];
    for (const c of candidates) {
      const p = this.carPointToWorld(c);
      if (!this.veg.obstaclesNear(p.x, p.z, 0.45, this.obstacleScratch).length) {
        p.y = this.groundY(p.x, p.z);
        return p;
      }
    }
    const p = this.carPointToWorld(d);
    p.y = this.groundY(p.x, p.z);
    return p;
  }

  private nearOwnDoor(role: Role, pos: THREE.Vector3): boolean {
    const door = this.carPointToWorld(DOOR_EXIT[role]);
    return Math.hypot(pos.x - door.x, pos.z - door.z) <= ENTER_RADIUS;
  }

  private nearHook(pos: THREE.Vector3): boolean {
    for (let i = 0; i < CAR_HOOKS.length; i++) {
      const h = hookWorld(i, this.cs.pos, this.cs.quat, _v);
      if (Math.hypot(h.x - pos.x, h.z - pos.z) < GRIP_REACH) return true;
    }
    return false;
  }

  /** E pressed by a local player: get out (stopped car) or back in (at your door). */
  private requestExitEnter(role: Role) {
    if (this.phase !== 'racing' && this.phase !== 'finished') return;
    // one key press must not get you in and straight back out (local seats change instantly)
    if (performance.now() - this.seatChangedAt[role] < 350) return;
    if (this.seats[role]) {
      if (this.cs.speed > EXIT_MAX_SPEED) {
        this.d.ui.hint(role === 'driver' ? 'STOP THE CAR BEFORE GETTING OUT' : 'WAIT FOR THE CAR TO STOP', 2);
        return;
      }
      this.d.session.exitCar(role);
    } else {
      const foot = role === 'driver' ? this.footDriver : this.footNav;
      if (!this.nearOwnDoor(role, foot.pos)) {
        this.d.ui.hint(`WALK TO THE ${role === 'driver' ? 'DRIVER' : 'PASSENGER'} DOOR TO GET IN`, 2);
        return;
      }
      this.d.session.enterCar({ x: foot.pos.x, y: foot.pos.y, z: foot.pos.z }, role);
    }
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
    if (this.cinematic) return [{ camera: this.cinematic.camera, x: 0, y: 0, w: 1, h: 1 }];
    if (this.fallCam && this.roles.every((r) => this.seats[r])) return [{ camera: this.fallCam.camera, x: 0, y: 0, w: 1, h: 1 }];
    const view = (role: Role, x: number, w: number): View => ({ camera: this.cameraFor(role), x, y: 0, w, h: 1, ...this.speedBlur(role) });
    if (this.d.mode === 'couch') return [view('driver', 0, 0.5), view('navigator', 0.5, 0.5)];
    return [view(this.roles.includes('driver') ? 'driver' : 'navigator', 0, 1)];
  }

  /**
   * Local, purely visual speed blur for an occupant's seat view: none below
   * ~55 km/h, growing smoothly to full strength at ~165 km/h, centred on the
   * direction the car is actually moving in.
   */
  private speedBlur(role: Role): { blur: number; blurCenter?: { x: number; y: number } } {
    if (!this.seats[role] || this.phase === 'loading') return { blur: 0 };
    const k = clamp((this.cs.speed * 3.6 - 55) / 110, 0, 1);
    const blur = k * k * (3 - 2 * k) * 0.9;
    if (blur <= 0.01) return { blur: 0 };
    const cam = role === 'driver' ? this.driverView.camera : this.navView.camera;
    cam.updateMatrixWorld();
    const ahead = cam.getWorldPosition(new THREE.Vector3()).addScaledVector(this.cs.vel.clone().normalize(), 60).project(cam);
    // looking well away from the direction of travel: blur fades instead of swirling around
    if (ahead.z > 1 || Math.abs(ahead.x) > 2.5 || Math.abs(ahead.y) > 2.5) return { blur: blur * 0.35 };
    return { blur, blurCenter: { x: clamp(ahead.x * 0.5 + 0.5, -0.5, 1.5), y: clamp(ahead.y * 0.5 + 0.5, -0.5, 1.5) } };
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
    const active = !frozen && (this.phase === 'racing' || this.phase === 'countdown') && !this.cinematic;
    if (this.driverControls) {
      this.driverControls.update(dt, active, d.mode !== 'couch', !this.seats.driver);
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

    this.applyPose();
    this.updateCabinVisuals(alpha);
    this.updateFoot(dt, !frozen && !this.cinematic);
    this.updateViews(dt);
    this.updateHeadlamp();
    this.updateNavigator(dt);
    this.updateArms(dt);
    this.updateCockpit(dt);
    this.updateNavigation(dt, now);
    this.updateGlare(dt, now);
    this.updateFall(dt);
    this.updateAudio(dt);
    this.particles.update(dt);
    if (this.vehicle && !frozen) this.emitDriveParticles(dt);
    this.props.updateMeshes(alpha, dt);
    this.sky.update(this.cs.pos);
    if (this.cinematic) {
      this.cinematic.trackStart(this.primaryCamera.getWorldPosition(_v));
      this.cinematic.update(dt, this.cs.pos, this.cs.quat, (a, b) => this.lineClearance(a, b));
    }
    this.updateHud(dt, now);
    this.render();
    this.frameCount++;
  }

  private handleDriverActions() {
    const dc = this.driverControls!;
    const s = this.d.session;
    if (dc.wiperCycle && this.seats.driver) s.wiperCycle();
    if (dc.requestReset && this.resetCooldown <= 0 && this.phase !== 'finished') {
      this.resetCooldown = 1;
      s.requestReset();
    }
    if (dc.exitEnter) this.requestExitEnter('driver');
    if (dc.closeDoor && this.doorStates.left && this.closingDoorTimer.left <= 0) {
      this.closingDoorTimer.left = 0.75;
    }
    let flags = this.cs.flags & ~(CAR_FLAG.horn | CAR_FLAG.wiping | CAR_FLAG.closingDoor | CAR_FLAG.driverOut);
    if (dc.horn) flags |= CAR_FLAG.horn;
    if (dc.wiping) flags |= CAR_FLAG.wiping;
    if (this.closingDoorTimer.left > 0) flags |= CAR_FLAG.closingDoor;
    if (!this.seats.driver) flags |= CAR_FLAG.driverOut;
    this.cs.flags = flags;
  }

  // -------------------------------------------------------------------- car --
  private stepCar(dt: number) {
    const v = this.vehicle!;
    const dc = this.driverControls!;
    const s = this.d.session;
    this.resetCooldown -= dt;
    v.frozen = this.phase === 'countdown' || this.phase === 'loading';
    // one hand off the wheel while wiping / closing the door
    let authority = 1;
    if (dc.wiping) authority = 0.5;
    if (this.closingDoorTimer.left > 0) authority = 0.45;
    const inp = dc.driveInput(authority);
    if (!this.seats.driver) {
      // nobody at the wheel: neutral and parked on the brakes (released below while pulled)
      inp.throttle = inp.steer = 0;
      inp.brake = 1;
      inp.handbrake = true;
      inp.neutral = true;
    }
    if (this.phase === 'finished') {
      // roll on after the line, following the road, and slow down gradually
      const t = this.cinematic ? this.cinematic.elapsed : 4;
      inp.throttle = 0;
      inp.handbrake = false;
      inp.brake = this.seats.driver ? clamp(0.05 + t * 0.08, 0, 0.35) : 0;
      inp.steer = this.seats.driver ? this.roadFollowSteer() : 0;
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
    // players pulling on the tow hooks: combined through the car's rigid body
    v.externalForces.length = 0;
    const addPull = (grip: number, force: THREE.Vector3) => {
      if (grip < 0 || grip >= CAR_HOOKS.length || force.lengthSq() < 1) return;
      v.externalForces.push({ point: hookWorld(grip, this.cs.pos, this.cs.quat), force: force.clone() });
    };
    if (!this.seats.driver) addPull(this.footDriver.grip, this.footDriver.pull);
    if (!this.seats.navigator) {
      if (this.roles.includes('navigator')) addPull(this.footNav.grip, this.footNav.pull);
      else if (this.cabinBuf) {
        const b = this.cabinSample;
        addPull(Math.round(b[CABIN.footGrip]), _v2.set(b[CABIN.pullX], b[CABIN.pullY], b[CABIN.pullZ]));
      }
    }
    // an empty car rolls freely only while someone is actually pulling it
    if (!this.seats.driver && v.externalForces.length) {
      inp.handbrake = false;
      inp.brake = 0;
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
      const f = this.footDriver;
      this.cs.footPos.copy(f.pos);
      this.cs.footYaw = f.yaw;
      this.cs.footPitch = f.pitch;
      this.cs.footGrip = this.seats.driver ? -1 : f.grip;
      this.cs.footWalk = f.walkPhase;
      this.cs.toSnapshot(this.carOut, this.simTime, this.seq++);
      s.sendCarState(this.d.mode === 'online' ? this.carOut : this.carOut.slice());
    }
    if (this.d.mode === 'online' && this.steps % 6 === 0) {
      const p = this.props.packMoving();
      if (p) s.sendProps(p);
    }
  }

  /** Steering towards the road a little ahead (the driver coasting after the finish line). */
  private roadFollowSteer(): number {
    const s = this.stage;
    const loc = this.locator.locate(this.cs.pos.x, this.cs.pos.z);
    const ahead = Math.min(s.count - 1, Math.floor(loc.idx + 4 + this.cs.speed * 0.45));
    let err = Math.atan2(s.xs[ahead] - this.cs.pos.x, -(s.zs[ahead] - this.cs.pos.z)) - this.cs.heading;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    return clamp(err * 2.2, -1, 1);
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
    const nc = this.navControls;
    if (nc && this.seats.navigator) {
      // the right hand is busy (pointing, door) -> the object is held one-handed
      cabin.oneHanded = nc.pointing || this.closingDoorTimer.right > 0;
      if (cabin.held >= 0) cabin.setHoldTarget(this.holdPos, this.holdQuat);
    } else if (this.d.mode === 'solo') this.aiCabin(dt);
    cabin.step(dt, _g);
    if (this.d.mode === 'online' && nc && this.steps % 3 === 0) this.sendCabin();
    if (!this.vehicle) this.steps++;
  }

  /** The AI passenger holds the tablet (and at night switches its head lamp on). */
  private aiCabin(dt: number) {
    const cabin = this.cabin!;
    this.aiRegrab -= dt;
    if (cabin.held !== CABIN_BODY.tablet && this.aiRegrab <= 0 && cabin.canGrab()) {
      if (cabin.currPos[CABIN_BODY.tablet].distanceTo(this.navBody.shoulderR) < 1.35) {
        cabin.grab(CABIN_BODY.tablet);
        this.d.session.setTabletHeld(true);
      } else this.aiRegrab = 1;
    }
    if (this.night && !this.aiLampOn && this.phase !== 'loading') {
      this.aiLampOn = true;
      this.setLamp(true);
    }
    cabin.oneHanded = false;
    const pos = _v.set(0.32, 0.36, -0.12);
    const look = _v2.copy(LAYOUT.navEye).sub(pos).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const x = new THREE.Vector3().crossVectors(up.clone().addScaledVector(look, -look.y).normalize(), look).normalize();
    const u = new THREE.Vector3().crossVectors(look, x).normalize();
    const m = new THREE.Matrix4().makeBasis(x, look, u.negate());
    cabin.setHoldTarget(pos, _q.setFromRotationMatrix(m));
  }

  private setLamp(on: boolean) {
    this.lampOn = on;
    this.headlamp.setOn(on);
    this.carAudio.clack(0.2, 0.5 * this.listenerSide());
  }

  private sendCabin() {
    const cabin = this.cabin!;
    const b = this.cabinOut;
    const nc = this.navControls!;
    b[CABIN.time] = this.simTime;
    let flags = 0;
    if (cabin.held === CABIN_BODY.tablet) flags |= CABIN_FLAG.tabletHeld;
    if (nc.reaching) flags |= CABIN_FLAG.reaching;
    if (this.closingDoorTimer.right > 0) flags |= CABIN_FLAG.closingDoor;
    if (!this.seats.navigator) flags |= CABIN_FLAG.navOut;
    if (nc.pointing && this.seats.navigator) flags |= CABIN_FLAG.pointing;
    if (this.lampOn) flags |= CABIN_FLAG.headlampOn;
    b[CABIN.flags] = flags;
    b[CABIN.headYaw] = nc.lookYaw;
    b[CABIN.headPitch] = nc.lookPitch;
    for (let i = 0; i < CABIN_BODY_COUNT; i++) {
      const o = cabinPoseOffset(i);
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
    // reach target, or the pointing hand's target so the driver sees exactly where it points
    const reach = nc.pointing && this.seats.navigator ? this.navPointTarget(_v2) : nc.reachTarget;
    b[CABIN.reachX] = reach.x;
    b[CABIN.reachY] = reach.y;
    b[CABIN.reachZ] = reach.z;
    b[CABIN.heldObject] = cabin.held;
    const f = this.footNav;
    b[CABIN.footX] = f.pos.x;
    b[CABIN.footY] = f.pos.y;
    b[CABIN.footZ] = f.pos.z;
    b[CABIN.footYaw] = f.yaw;
    b[CABIN.footPitch] = f.pitch;
    b[CABIN.footGrip] = this.seats.navigator ? -1 : f.grip;
    b[CABIN.pullX] = f.pull.x;
    b[CABIN.pullY] = f.pull.y;
    b[CABIN.pullZ] = f.pull.z;
    b[CABIN.footWalk] = f.walkPhase;
    this.d.session.sendCabinState(b);
  }

  private remoteFlag(flag: number): boolean {
    return ((this.cabinSample[CABIN.flags] | 0) & flag) !== 0;
  }

  private updateCabinVisuals(alpha: number) {
    const objs = this.bodyObjects;
    if (this.cabin) {
      const c = this.cabin;
      for (let i = 0; i < objs.length; i++) c.interpolate(i, alpha, objs[i].position, objs[i].quaternion);
      return;
    }
    if (this.cabinBuf && this.cabinBuf.sample(performance.now() / 1000, this.cabinSample)) {
      const b = this.cabinSample;
      this.remoteTabletHeld = this.remoteFlag(CABIN_FLAG.tabletHeld);
      this.remoteNavHead.yaw = b[CABIN.headYaw];
      this.remoteNavHead.pitch = b[CABIN.headPitch];
      this.remoteReach.set(b[CABIN.reachX], b[CABIN.reachY], b[CABIN.reachZ]);
      this.remoteHeldObj = Math.round(b[CABIN.heldObject]);
      if (this.remoteFlag(CABIN_FLAG.closingDoor)) this.closingDoorTimer.right = Math.max(this.closingDoorTimer.right, 0.1);
      const on = this.remoteFlag(CABIN_FLAG.headlampOn);
      if (on !== this.lampOn) {
        this.lampOn = on;
        this.headlamp.setOn(on);
      }
    }
    const b = this.cabinSample;
    for (let i = 0; i < objs.length; i++) {
      const o = cabinPoseOffset(i);
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

  /** The head lamp sits on the navigator's head: seat camera, on-foot camera or the synced avatar look. */
  private updateHeadlamp() {
    const eye = new THREE.Vector3();
    const q = new THREE.Quaternion();
    if (this.seats.navigator) {
      const cam = this.navView.camera;
      cam.updateMatrixWorld(true);
      cam.getWorldPosition(eye);
      cam.getWorldQuaternion(q);
    } else if (this.roles.includes('navigator')) {
      this.footCamNav.updateMatrixWorld(true);
      this.footCamNav.getWorldPosition(eye);
      this.footCamNav.getWorldQuaternion(q);
    } else {
      const b = this.cabinSample;
      eye.set(b[CABIN.footX], b[CABIN.footY] + EYE_HEIGHT, b[CABIN.footZ]);
      q.setFromEuler(new THREE.Euler(b[CABIN.footPitch], b[CABIN.footYaw], 0, 'YXZ'));
    }
    this.headlamp.setPose(eye, q);
  }

  // ------------------------------------------------------------------- foot --
  private footIntent(role: Role): FootIntent {
    const i = this.d.input;
    if (role === 'driver') {
      const k = DRIVER_KEYS[this.bindMode];
      const fwd = (i.anyDown(...k.footForward.codes) ? 1 : 0) - (i.anyDown(...k.footBack.codes) ? 1 : 0);
      const side = (i.anyDown(...k.footRight.codes) ? 1 : 0) - (i.anyDown(...k.footLeft.codes) ? 1 : 0);
      return {
        forward: fwd,
        strafe: k.footTurnWithKeys ? 0 : side,
        turn: k.footTurnWithKeys ? -side : 0,
        run: i.anyDown(...k.footRun.codes),
        grip: k.footGrip ? i.anyDown(...k.footGrip.codes) : i.mouseDown('left'),
        lookDX: k.footTurnWithKeys ? 0 : i.mouseDX,
        lookDY: k.footTurnWithKeys ? 0 : i.mouseDY * (this.d.settings.data.invertY ? -1 : 1),
      };
    }
    const k = NAV_KEYS[this.bindMode];
    return {
      forward: (i.anyDown(...k.footForward.codes) ? 1 : 0) - (i.anyDown(...k.footBack.codes) ? 1 : 0),
      strafe: (i.anyDown(...k.footRight.codes) ? 1 : 0) - (i.anyDown(...k.footLeft.codes) ? 1 : 0),
      turn: 0,
      run: i.anyDown(...k.footRun.codes),
      grip: i.mouseDown('left'),
      lookDX: i.mouseDX,
      lookDY: i.mouseDY * (this.d.settings.data.invertY ? -1 : 1),
    };
  }

  private updateFoot(dt: number, active: boolean) {
    const sens = this.d.settings.data.mouseSensitivity;
    const idle: FootIntent = { forward: 0, strafe: 0, turn: 0, run: false, grip: false, lookDX: 0, lookDY: 0 };
    for (const role of ['driver', 'navigator'] as Role[]) {
      const avatar = role === 'driver' ? this.driverAvatar : this.navAvatar;
      if (this.seats[role]) {
        avatar.hide();
        continue;
      }
      const foot = role === 'driver' ? this.footDriver : this.footNav;
      if (this.roles.includes(role)) {
        foot.update(dt, active ? this.footIntent(role) : idle, this.footEnv, sens);
        const hook = foot.grip >= 0 ? hookWorld(foot.grip, this.cs.pos, this.cs.quat) : null;
        avatar.pose(foot.pos, foot.yaw, foot.pitch, foot.walkPhase, hook);
        const cam = role === 'driver' ? this.footCamDriver : this.footCamNav;
        cam.position.set(foot.pos.x, foot.pos.y + EYE_HEIGHT, foot.pos.z);
        cam.rotation.set(foot.pitch, foot.yaw, 0, 'YXZ');
        const fov = this.d.settings.data.fov;
        if (cam.fov !== fov) {
          cam.fov = fov;
          cam.updateProjectionMatrix();
        }
      } else if (role === 'driver') {
        const hook = this.cs.footGrip >= 0 ? hookWorld(this.cs.footGrip, this.cs.pos, this.cs.quat) : null;
        avatar.pose(this.cs.footPos, this.cs.footYaw, this.cs.footPitch, this.cs.footWalk, hook);
      } else {
        const b = this.cabinSample;
        const grip = Math.round(b[CABIN.footGrip]);
        const hook = grip >= 0 ? hookWorld(grip, this.cs.pos, this.cs.quat) : null;
        avatar.pose(_v.set(b[CABIN.footX], b[CABIN.footY], b[CABIN.footZ]), b[CABIN.footYaw], b[CABIN.footPitch], b[CABIN.footWalk], hook);
      }
    }
    if (this.navControls && !this.seats.navigator) {
      this.navControls.updateOnFoot();
      if (this.navControls.actions.exitEnter && active) this.requestExitEnter('navigator');
      if (this.navControls.actions.headlampToggle && active) this.setLamp(!this.lampOn);
    }
  }

  // ------------------------------------------------------------------ views --
  private applyPose() {
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
      // AI passenger looks at the tablet it holds (its head lamp follows), glances at the road now and then
      this.aiTimer += dt;
      this.aiGlance -= dt;
      if (this.aiGlance < -4 - Math.random() * 3) this.aiGlance = 0.7;
      if (this.cabin && this.cabin.held === 0 && this.aiGlance <= 0) {
        const d = this.bodyObjects[0].position.clone().sub(this.navView.eyeLocal);
        nyaw = Math.atan2(-d.x, -d.z);
        npitch = Math.asin(clamp(d.y / Math.max(d.length(), 1e-3), -1, 1));
      } else {
        nyaw = 0.1 + Math.sin(this.aiTimer * 0.7) * 0.1;
        npitch = -0.1;
      }
    }
    this.navView.update(dt, this.cs.accelLocal, nyaw, npitch);
    this.driverBody.pose(this.driverView.motion.offset, dyaw * 0.9, dpitch * 0.8);
    this.navBody.pose(this.navView.motion.offset.clone().add(new THREE.Vector3(-0.2, -0.1, -0.1).multiplyScalar(this.navView.lean)), nyaw * 0.9, npitch * 0.8);
    this.driverBody.group.visible = this.seats.driver;
    this.navBody.group.visible = this.seats.navigator;
  }

  private navContext(): NavContext | null {
    if (!this.cabin) return null;
    const rect = this.d.mode === 'couch' ? { x: 0.5, y: 0, w: 0.5, h: 1 } : { x: 0, y: 0, w: 1, h: 1 };
    return {
      camera: this.navView.camera,
      rect,
      carRoot: this.car.root,
      eyeLocal: this.navView.eyeLocal,
      shoulderLocal: this.navBody.shoulderR,
      cabin: this.cabin,
      doorHandle: this.doorStates.right ? this.car.doors.right.handle : null,
      enabled: !this.pausedLocal && !this.pausedRemote && this.phase !== 'loading' && !this.cinematic,
      lastDirectional: this.lastDirectional,
    };
  }

  private updateNavigator(dt: number) {
    const nc = this.navControls;
    const cabin = this.cabin;
    if (!nc || !cabin || !this.seats.navigator) return;
    const ctx = this.navContext()!;
    nc.update(dt, ctx);
    const a = nc.actions;
    const s = this.d.session;
    if (a.grabbed === CABIN_BODY.tablet) {
      s.setTabletHeld(true);
      this.d.audio.uiClick();
    } else if (a.grabbed > 0) this.d.audio.uiClick();
    if (a.released && cabin.held < 0) s.setTabletHeld(false);
    if (a.cantReach) this.d.ui.hint(`CAN'T REACH IT - HOLD ${nc.keys.tabletPickup.label.replace(' (hold)', '')} TO LEAN, OR WAIT FOR A CORNER TO SLIDE IT BACK`, 3);
    if (a.handsFull) this.d.ui.hint('YOUR HANDS ARE FULL - CLICK TO PUT DOWN WHAT YOU HOLD', 2.5);
    if (a.closeDoor && this.doorStates.right && this.closingDoorTimer.right <= 0) this.closingDoorTimer.right = 0.75;
    if (a.headlampToggle) this.setLamp(!this.lampOn);
    if (a.exitEnter) this.requestExitEnter('navigator');
    if (a.callout) {
      if (a.callout === 'left' || a.callout === 'left3') this.lastDirectional = 'left';
      if (a.callout === 'right' || a.callout === 'right3') this.lastDirectional = 'right';
      s.callout(a.callout);
    }
    if (a.readNote) {
      if (this.tabletVisible && this.tabletLit && this.ins) s.callout('note', spokenNote(this.ins));
      else this.d.ui.hint(this.tabletVisible ? `TOO DARK TO READ THE TABLET - HEAD LAMP: ${nc.keys.headlamp.label}` : "YOU CAN'T SEE THE TABLET!", 2);
    }
    if (cabin.held >= 0) nc.holdPose(ctx, this.holdPos, this.holdQuat, cabin.oneHanded);
    // cursor feedback (hidden anyway while the mouse is captured)
    const canvas = this.d.renderer.canvas;
    canvas.style.cursor = cabin.held >= 0 ? 'grabbing' : nc.hover >= 0 || nc.hoverDoor ? (nc.hoverReachable || nc.hoverDoor ? 'grab' : 'not-allowed') : 'crosshair';
  }

  private doorHandleLocal(side: DoorSide, out: THREE.Vector3): THREE.Vector3 {
    this.car.doors[side].handle.getWorldPosition(out);
    return this.car.root.worldToLocal(out);
  }

  /** Where the navigator's pointing hand goes (car-local), stopped short of the dash / glass. */
  private navPointTarget(out: THREE.Vector3): THREE.Vector3 {
    const cam = this.navView.camera;
    const carQ = this.car.root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()).premultiply(carQ));
    const sh = this.navBody.shoulderR;
    const free = this.cabin ? this.cabin.castStatic(sh, fwd, 0.75) : 0.75;
    return out.copy(sh).addScaledVector(fwd, clamp(free - 0.08, 0.28, 0.6));
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
    this.handL.lerp(tl, k);
    this.handR.lerp(tr, k);
    const db = this.driverBody;
    const axis = this.cockpit.wheelAxis(new THREE.Vector3());
    db.left.solve(db.shoulderL, this.handL, db.shoulderL.clone().add(new THREE.Vector3(-0.35, -0.5, 0.1)), axis.clone().add(new THREE.Vector3(-0.6, 0, 0)));
    db.right.solve(db.shoulderR, this.handR, db.shoulderR.clone().add(new THREE.Vector3(0.35, -0.5, 0.1)), axis.clone().add(new THREE.Vector3(0.6, 0, 0)));

    // ---- navigator: left hand = main object, right hand = pointing / door / main object
    const nb = this.navBody;
    const restL = new THREE.Vector3(0.22, 0.17, 0.02);
    const restR = new THREE.Vector3(0.5, 0.17, 0.02);
    let nl = restL;
    let nr = restR;
    const local = !!this.cabin;
    const held = local ? this.cabin!.held : this.remoteTabletHeld ? 0 : this.remoteHeldObj;
    const pointing = local ? !!this.navControls?.pointing && this.seats.navigator : this.remoteFlag(CABIN_FLAG.pointing);
    const mainObj = held >= 0 ? this.bodyObjects[held] : null;
    let mainUp: THREE.Vector3 | null = null;
    if (mainObj) {
      // grip the side edges from behind so the screen stays visible
      const half = held === CABIN_BODY.tablet ? 0.155 : 0.05;
      nl = new THREE.Vector3(-half, -0.035, 0.035).applyQuaternion(mainObj.quaternion).add(mainObj.position);
      nr = new THREE.Vector3(half, -0.035, 0.035).applyQuaternion(mainObj.quaternion).add(mainObj.position);
      mainUp = new THREE.Vector3(0, -1, 0).applyQuaternion(mainObj.quaternion);
    }
    if (this.closingDoorTimer.right > 0) nr = this.doorHandleLocal('right', new THREE.Vector3());
    else if (pointing) nr = local ? this.navPointTarget(new THREE.Vector3()) : this.remoteReach.clone();
    else if (!mainObj) {
      const reaching = this.navControls ? this.navControls.reaching : false;
      if (reaching) nr = this.bodyObjects[CABIN_BODY.tablet].position.clone();
      else if (!local && this.remoteHeldObj < 0 && this.remoteFlag(CABIN_FLAG.reaching)) nr = this.remoteReach.clone();
    }
    nb.right.setPointing(pointing && this.closingDoorTimer.right <= 0);
    this.navHandL.lerp(nl, k);
    this.navHandR.lerp(nr, k);
    const up = mainUp ?? new THREE.Vector3(0, 1, 0);
    nb.left.solve(nb.shoulderL, this.navHandL, nb.shoulderL.clone().add(new THREE.Vector3(-0.2, -0.5, 0.2)), up);
    nb.right.solve(nb.shoulderR, this.navHandR, nb.shoulderR.clone().add(new THREE.Vector3(0.35, -0.5, 0.15)), pointing ? new THREE.Vector3(0, 1, 0) : up);

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
    this.car.setBrakeLights(cs.brake > 0.1 && !cs.has(CAR_FLAG.driverOut));
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
      wipers: this.windshield.wipersActive,
    });
    this.doors.left.update(dt, cs.accelLocal, cs.speed, cs.rough);
    this.doors.right.update(dt, cs.accelLocal, cs.speed, cs.rough);
    // hand wiping
    if (cs.has(CAR_FLAG.wiping) && this.seats.driver) {
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
    this.tabletVisible = this.seats.navigator && facing > 0.25 && dist < 1.3 && inView;
    // at night the screen is only readable where the head lamp actually lights it
    if (this.night) {
      const p = this.tablet.screen.getWorldPosition(new THREE.Vector3());
      const n = new THREE.Vector3(0, 1, 0).applyQuaternion(this.tablet.screen.getWorldQuaternion(new THREE.Quaternion()));
      this.tabletLit = this.headlamp.illuminationAt(p, n) > 0.08;
    } else this.tabletLit = true;
    // AI co-driver
    if (this.ai && (this.phase === 'racing' || this.phase === 'countdown')) {
      const canSee = !!this.cabin && this.cabin.held === 0 && this.tabletLit;
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

  /**
   * Head lamp in the driver's eyes: beam direction, distance and line of sight
   * (cockpit geometry, the tablet, loose objects and the navigator's body block
   * it; glass doesn't). Only the local driver's view is affected, controls are
   * untouched; stays partly dazzled while the beam stays on them and re-arms
   * quickly once it has moved away.
   */
  private updateGlare(dt: number, now: number) {
    this.glare = Math.max(0, this.glare - dt / 1.4);
    if (!this.driverControls || !this.seats.driver || !this.headlamp.on) {
      this.glareAway += dt;
      if (this.glareAway > 0.3) this.glareArmed = true;
      return;
    }
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.headlamp.beam(origin, dir);
    const eye = this.driverView.camera.getWorldPosition(new THREE.Vector3());
    const to = eye.clone().sub(origin);
    const dist = to.length();
    to.multiplyScalar(1 / Math.max(dist, 1e-4));
    const inBeam = dist < 5 && to.dot(dir) > Math.cos(0.42); // in the cabin or a few metres outside
    let clear = false;
    if (inBeam) {
      const ray = this.glareRay;
      ray.layers.enableAll();
      ray.set(origin.clone().addScaledVector(to, 0.06), to);
      ray.far = dist - 0.12;
      const blockers: THREE.Object3D[] = [this.cockpit.group, this.tablet.group, ...this.loose, ...this.bodywork];
      if (this.seats.navigator) blockers.push(this.navBody.body);
      const hits = ray.intersectObjects(blockers, true).filter((h) => (h.object as THREE.Mesh).visible !== false);
      clear = hits.length === 0;
    }
    if (inBeam && clear) {
      this.glareAway = 0;
      if (this.glareArmed && now - this.lastGlareAt > 700) {
        this.glareArmed = false;
        this.lastGlareAt = now;
        this.glare = this.night ? 1 : 0.9;
        this.carAudio.clack(0.15, -0.6);
      }
      // still dazzled while the beam stays in their eyes
      this.glare = Math.max(this.glare, this.night ? 0.55 : 0.4);
    } else {
      this.glareAway += dt;
      if (this.glareAway > 0.3) this.glareArmed = true;
    }
  }

  /**
   * Over the edge: when the car leaves the road and drops well below it, the
   * occupants' views switch to a third-person camera that follows the fall
   * until the car has come to rest (or is reset). Decided from the shared car
   * state, so both players see it; purely visual.
   */
  private updateFall(dt: number) {
    this.fallCooldown = Math.max(0, this.fallCooldown - dt);
    const cs = this.cs;
    const q = this.field.queryRoad(cs.pos.x, cs.pos.z);
    const onRoad = q.dist < this.field.halfWidthAt(q.idx) + 1.2 && Math.abs(cs.pos.y - q.roadY) < 2.5;
    if (!this.fallCam) {
      if (this.phase !== 'racing' || this.cinematic || this.fallCooldown > 0 || !this.roles.some((r) => this.seats[r])) return;
      if (onRoad || q.dist === Infinity) return;
      const below = q.roadY - cs.pos.y;
      if ((below > 2.5 && cs.vel.y < -3) || below > 5) {
        // edge point: the nearest road edge, at road level
        const lat = Math.sign(q.lateral) * this.field.halfWidthAt(q.idx);
        const i = Math.max(0, Math.min(this.stage.count - 1, Math.round(q.idx)));
        const h = this.stage.headings[i];
        const edge = new THREE.Vector3(this.stage.xs[i] + Math.cos(h) * lat, q.roadY + 1, this.stage.zs[i] + Math.sin(h) * lat);
        const from = this.roles.includes('driver') && this.seats.driver ? this.driverView.camera : this.navView.camera;
        this.fallCam = new FallCamera(from, cs.pos, edge);
        this.fallRest = 0;
        this.d.ui.toast('OVER THE EDGE!', 'bad');
      }
      return;
    }
    const fc = this.fallCam;
    const eye = (this.roles.includes('driver') && this.seats.driver ? this.driverView : this.navView).camera;
    fc.trackStart(eye.getWorldPosition(new THREE.Vector3()), eye.getWorldQuaternion(new THREE.Quaternion()));
    // ground for the camera: terrain, plus boulders / trees standing there
    const ground = (x: number, z: number) => this.field.heightAt(x, z) + (this.veg.obstaclesNear(x, z, 0.6, this.obstacleScratch).length ? 3.6 : 0);
    fc.update(dt, cs.pos, ground, (a, b) => this.lineClearance(a, b));
    this.fallRest = cs.speed < 1.2 ? this.fallRest + dt : 0;
    // back to the cockpit once it has settled, when it's back on the road (reset), or after a long slide
    const done = (fc.elapsed > 2.5 && this.fallRest > 1.4) || (onRoad && fc.elapsed > 0.8) || fc.elapsed > 14 || this.cinematic || this.phase !== 'racing';
    if (done) {
      this.fallCam = null;
      this.fallCooldown = 1.5;
    }
  }

  /** Unobstructed fraction of a camera segment: tree trunks / canopies, boulders and terrain. */
  private lineClearance(from: THREE.Vector3, to: THREE.Vector3): number {
    const len = from.distanceTo(to);
    const n = Math.max(2, Math.ceil(len / 0.4));
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const x = from.x + (to.x - from.x) * f;
      const y = from.y + (to.y - from.y) * f;
      const z = from.z + (to.z - from.z) * f;
      if (y < this.field.heightAt(x, z) + 0.45) return (i - 1) / n;
      if (f * len > 1.6 && this.veg.obstaclesNear(x, z, 1.3, this.obstacleScratch).length) return (i - 1) / n;
    }
    return 1;
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

  // -------------------------------------------------------------------- HUD --
  private controlsState(role: Role): ControlsState {
    const cabin = this.cabin;
    const held = cabin ? cabin.held : -1;
    const foot = role === 'driver' ? this.footDriver : this.footNav;
    const voiced = !!(this.d.session as GameSession & { voiceEnabled?: boolean }).voiceEnabled;
    return {
      role,
      mode: this.bindMode,
      online: this.d.mode === 'online',
      inCar: this.seats[role],
      carStopped: this.cs.speed <= EXIT_MAX_SPEED,
      nearDoor: !this.seats[role] && this.nearOwnDoor(role, foot.pos),
      nearHook: !this.seats[role] && this.nearHook(foot.pos),
      gripping: !this.seats[role] && foot.grip >= 0,
      holding: held < 0 ? null : held === CABIN_BODY.tablet ? 'tablet' : 'object',
      headlampOn: this.lampOn,
      mouseCaptured: this.d.input.pointerLocked,
      doorOpen: this.doorStates[DOOR_OF[role]],
      voice: voiced,
    };
  }

  private updateHud(dt: number, now: number) {
    const ui = this.d.ui;
    const st = this.stats;
    const s = this.d.session as GameSession & { status?: string; rtt?: number };
    const cp = `CP ${st?.checkpointsHit ?? 0}/${this.stage.checkpoints.length}`;
    let status: string | null = null;
    if (this.d.mode === 'online') status = `${s.status === 'online' ? '● ONLINE' : `● ${String(s.status).toUpperCase()}`}${s.rtt ? ` ${Math.round(s.rtt)}ms` : ''}`;
    const tabHeld = this.d.input.isDown('Tab') && !this.cinematic;
    const stuckRecent = now < this.stuckNoticeUntil;
    this.hudViews.forEach((v, i) => {
      const onFoot = !this.seats[v.role];
      const data: HudData = {
        speedKmh: this.cs.speed * 3.6,
        gear: this.cs.gear,
        timeMs: this.raceTimeMs(now),
        cp,
        status,
        grip: null,
        warn: null,
        hover: null,
        tab: tabHeld && this.roles.includes(v.role) ? controlRows(this.controlsState(v.role)) : null,
        resetHold: v.role === 'driver' && this.driverControls ? this.driverControls.resetHold : 0,
        glare: v.role === 'driver' && this.driverControls ? this.glare : 0,
        onFoot,
        crosshair: v.role === 'navigator' && !onFoot && !!this.navControls?.crosshair && !this.cinematic,
      };
      const warns: string[] = [];
      if (onFoot) {
        const foot = v.role === 'driver' ? this.footDriver : this.footNav;
        if (foot.grip >= 0) warns.push(foot.tensionShown > 0.05 ? `PULLING ${Math.round(foot.tensionShown * 100)}%` : 'WALK AWAY FROM THE CAR TO PULL');
        else if (this.nearHook(foot.pos)) warns.push(this.bindMode === 'couch' && v.role === 'driver' ? 'HOLD SPACE TO GRIP THE TOW HOOK' : 'HOLD LEFT MOUSE TO GRIP THE TOW HOOK');
        if (this.nearOwnDoor(v.role, foot.pos)) {
          const key = v.role === 'driver' ? DRIVER_KEYS[this.bindMode].exitEnter.label : NAV_KEYS[this.bindMode].exitEnter.label;
          warns.push(`${key}: GET BACK IN`);
        }
      } else if (v.role === 'navigator' && this.cabin && this.navControls) {
        const nc = this.navControls;
        data.grip = this.cabin.held >= 0 ? this.cabin.grip : null;
        const pick = nc.keys.tabletPickup.label.replace(' (hold)', '');
        if (this.cabin.held !== CABIN_BODY.tablet) {
          warns.push(this.cabin.currPos[0].distanceTo(this.navBody.shoulderR) > nc.reach() ? `TABLET OUT OF REACH! HOLD ${pick}` : `TABLET DROPPED! CLICK IT OR PRESS ${pick}`);
        } else if (!this.tabletVisible) warns.push('TABLET FACING AWAY / OUT OF VIEW');
        else if (!this.tabletLit) warns.push(this.lampOn ? 'TOO DARK! LOOK AT THE TABLET TO LIGHT IT' : `TOO DARK! HEAD LAMP: ${nc.keys.headlamp.label}`);
        if (this.doorStates.right) warns.push(`DOOR OPEN! (${nc.keys.closeDoor?.label ?? 'CLICK THE HANDLE'})`);
        if (stuckRecent && this.cs.speed < EXIT_MAX_SPEED) warns.push(`STUCK: ${nc.keys.exitEnter.label} TO GET OUT AND PULL`);
        if (nc.mouseInView && (nc.hover >= 0 || nc.hoverDoor)) {
          const r = this.d.renderer.canvas.getBoundingClientRect();
          // label next to the cursor, or under the centre crosshair while the mouse is captured
          data.hover = {
            text: nc.hoverDoor ? 'CLOSE DOOR' : nc.hoverReachable ? `GRAB ${CABIN_OBJECT_NAMES[nc.hover]}` : 'TOO FAR',
            x: nc.crosshair ? (v.rect.w * r.width) / 2 : this.d.input.mouseX - r.left - v.rect.x * r.width,
            y: nc.crosshair ? r.height / 2 + 14 : this.d.input.mouseY - r.top,
          };
        }
      } else if (v.role === 'driver') {
        const k = DRIVER_KEYS[this.bindMode];
        if (this.doorStates.left) warns.push(`YOUR DOOR IS OPEN! (${k.closeDoor.label})`);
        if (st?.wrongWay) warns.push('WRONG WAY');
        if (this.windshield.coverage > 0.28) warns.push(`CAN’T SEE! WIPERS (${k.wipers.label}) / WIPE (${k.handWipe.label.replace(' (hold)', '')})`);
        if (stuckRecent && this.cs.speed < EXIT_MAX_SPEED) warns.push(`STUCK: ${k.exitEnter.label} TO GET OUT AND PULL · HOLD ${k.reset.label.replace(' (hold)', '')} = EMERGENCY RESET`);
      }
      data.warn = warns.length ? warns.join(' · ') : null;
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
    if (this.frameCount % 2 === 0 && !this.cinematic) r.renderToTarget(this.scene, this.mirrorCam, this.mirrorRT);
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
    this.driverAvatar?.dispose();
    this.navAvatar?.dispose();
    this.tablet?.dispose();
    this.headlamp?.dispose();
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

// Headless cooperative-recovery test with the real vehicle physics and the real
// on-foot controller: the car rolls nose-first into a V-shaped ditch, then
// players grip the rear tow hook and walk backwards up the slope.
// Checks: the parked car holds on the slope, one player alone can't drag it up
// a 12° grass bank, two players together can, releasing stops the pull, the
// car's motion stays continuous (no teleports), and on flat ground one player
// can move it. Run: npx tsx scripts/recovery-test.ts

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { FootController, hookWorld, type FootEnv, type FootIntent } from '../src/game/OnFoot';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { FIXED_DT } from '../src/shared/constants';
import { VehicleController, type DriveInput } from '../src/vehicle/VehicleController';

await RAPIER.init();
let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

/** Ground plane through the origin rising towards +Z at `deg` (or towards -Z for a wall). */
function slab(physics: PhysicsWorld, deg: number, risesTowardsMinusZ = false) {
  const a = THREE.MathUtils.degToRad(deg) * (risesTowardsMinusZ ? 1 : -1);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
  const top = new THREE.Vector3(0, 0.5, 0).applyQuaternion(q);
  physics.addStatic(
    RAPIER.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(-top.x, -top.y, -top.z).setRotation(q).setFriction(0.9),
    'grass',
  );
}

interface Scenario {
  physics: PhysicsWorld;
  car: VehicleController;
  ground: (x: number, z: number) => number;
}

function ditch(bankDeg: number): Scenario {
  const physics = new PhysicsWorld();
  slab(physics, bankDeg); // the bank the car slid down (rises behind it)
  slab(physics, 38, true); // steep far side of the ditch in front of the nose
  const tb = Math.tan(THREE.MathUtils.degToRad(bankDeg));
  const tw = Math.tan(THREE.MathUtils.degToRad(38));
  const ground = (_x: number, z: number) => Math.max(z * tb, -z * tw);
  const z0 = 4;
  const pitch = THREE.MathUtils.degToRad(bankDeg);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch); // nose down the bank
  const car = new VehicleController(physics, { x: 0, y: z0 * tb + 0.75, z: z0, qx: q.x, qy: q.y, qz: q.z, qw: q.w }, () => -1);
  return { physics, car, ground };
}

function flat(): Scenario {
  const physics = new PhysicsWorld();
  slab(physics, 0);
  const car = new VehicleController(physics, { x: 0, y: 0.75, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }, () => -1);
  return { physics, car, ground: () => 0 };
}

const carPos = new THREE.Vector3();
const carQuat = new THREE.Quaternion();
const syncCar = (car: VehicleController) => {
  const t = car.body.translation();
  const r = car.body.rotation();
  carPos.set(t.x, t.y, t.z);
  carQuat.set(r.x, r.y, r.z, r.w);
};

const parked = (): DriveInput => ({ throttle: 0, brake: 1, steer: 0, handbrake: true, neutral: true, steerAuthority: 1 });

/** Simulates `seconds` with the given players (same per-step logic as Game.stepCar for an empty car). */
function simulate(sc: Scenario, seconds: number, players: { foot: FootController; intent: FootIntent }[], free = false) {
  const env: FootEnv = { groundY: sc.ground, carPos, carQuat, obstacles: (_x, _z, _r, out) => ((out.length = 0), out) };
  let maxStep = 0;
  let maxPull = 0;
  const prev = new THREE.Vector3();
  for (let t = 0; t < seconds; t += FIXED_DT) {
    syncCar(sc.car);
    prev.copy(carPos);
    for (const p of players) p.foot.update(FIXED_DT, p.intent, env, 1);
    const inp = parked();
    sc.car.externalForces.length = 0;
    for (const p of players) {
      if (p.foot.grip < 0 || p.foot.pull.lengthSq() < 1) continue;
      sc.car.externalForces.push({ point: hookWorld(p.foot.grip, carPos, carQuat), force: p.foot.pull.clone() });
    }
    if (sc.car.externalForces.length || free) {
      inp.handbrake = false;
      inp.brake = 0;
    }
    maxPull = Math.max(maxPull, sc.car.externalForces.reduce((s, f) => s + f.force.length(), 0));
    sc.car.preStep(inp, FIXED_DT);
    sc.physics.step();
    sc.car.postStep(FIXED_DT);
    syncCar(sc.car);
    maxStep = Math.max(maxStep, carPos.distanceTo(prev));
  }
  syncCar(sc.car);
  return { maxStep, maxPull };
}

/** A player standing behind the car at the rear hook, facing it, walking backwards. */
function puller(side: number): { foot: FootController; intent: FootIntent } {
  const foot = new FootController();
  const hook = hookWorld(1, carPos, carQuat);
  foot.place(new THREE.Vector3(hook.x + side * 0.35, 0, hook.z + 0.6), 0); // yaw 0 = facing -Z (the car)
  return { foot, intent: { forward: -1, strafe: 0, turn: 0, run: false, grip: true, lookDX: 0, lookDY: 0 } };
}

// ---------------------------------------------------------------- ditch ----
const BANK = 12;
const sc = ditch(BANK);
simulate(sc, 6, [], true); // slide into the ditch (brakes off) and come to rest
const rest = carPos.clone();
console.log(`car settled in the ditch at z=${rest.z.toFixed(2)} y=${rest.y.toFixed(2)}`);
check('car rolled down into the ditch bottom', rest.z < 3);

// engine alone: the driver tries to reverse out (informational - is it really stuck?)
{
  const s2 = ditch(BANK);
  simulate(s2, 6, [], true);
  const before = new THREE.Vector3().copy(carPos);
  for (let t = 0; t < 5; t += FIXED_DT) {
    s2.car.preStep({ throttle: 0, brake: 1, steer: 0, handbrake: false, neutral: false, steerAuthority: 1 }, FIXED_DT);
    s2.physics.step();
    s2.car.postStep(FIXED_DT);
  }
  syncCar(s2.car);
  console.log(`info: 5 s of full reverse from the ditch moved the car ${carPos.distanceTo(before).toFixed(2)} m`);
}

syncCar(sc.car);
simulate(sc, 3, []);
check(`parked car holds still in the ditch (moved ${carPos.distanceTo(rest).toFixed(3)} m in 3 s)`, carPos.distanceTo(rest) < 0.05);

const solo = [puller(0)];
syncCar(sc.car);
const a = carPos.clone();
const r1 = simulate(sc, 8, solo);
const soloMove = carPos.z - a.z;
console.log(`one player pulling (peak ${r1.maxPull.toFixed(0)} N): car moved ${soloMove.toFixed(2)} m up the bank`);
check(`one player alone can't drag the car up a ${BANK}° bank (< 0.5 m)`, soloMove < 0.5);
check('the player actually gripped the hook and pulled', solo[0].foot.grip === 1 && r1.maxPull > 1000);

syncCar(sc.car);
const duo = [puller(-1), puller(1)];
const b0 = carPos.clone();
const r2 = simulate(sc, 10, duo);
const duoMove = carPos.z - b0.z;
console.log(`two players pulling (peak ${r2.maxPull.toFixed(0)} N): car moved ${duoMove.toFixed(2)} m up the bank, max step ${(r2.maxStep * 1000).toFixed(1)} mm`);
check('two players together drag the car up and out (> 2 m)', duoMove > 2);
check('car motion is continuous - no teleport (< 5 cm per 1/60 s step)', r2.maxStep < 0.05);

// release: nobody pulls -> handbrake holds the car where they left it
for (const p of duo) p.intent.grip = false;
syncCar(sc.car);
const c0 = carPos.clone();
simulate(sc, 3, duo);
const after = carPos.z - c0.z;
check(`releasing the grip stops pulling; the parked car holds (moved ${after.toFixed(2)} m)`, Math.abs(after) < 0.3 && duo.every((p) => p.foot.grip < 0 && p.foot.pull.lengthSq() === 0));

// ----------------------------------------------------------------- flat ----
const fl = flat();
simulate(fl, 2, []);
const f0 = carPos.clone();
const one = [puller(0)];
simulate(fl, 6, one);
const flatMove = carPos.distanceTo(f0);
console.log(`flat ground, one player: car moved ${flatMove.toFixed(2)} m in 6 s`);
check('on flat ground one player can move the car (> 2 m)', flatMove > 2);

console.log(failures ? `${failures} FAILED` : 'ALL RECOVERY CHECKS PASSED');
process.exit(failures ? 1 : 0);

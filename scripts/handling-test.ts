// Handling test on a flat gravel pad with the real vehicle physics:
//  - lane change at 70 km/h (sharp flick left, then right, then straight):
//    how far the tail steps out (peak body slip angle), whether it spins, and
//    how quickly it settles back to straight;
//  - a long fast corner (full lock at 60 km/h for 2 s): sideways slide;
//  - a deliberate handbrake turn at 50 km/h: the car must still rotate.
// Run: npx tsx scripts/handling-test.ts [standard|hard|expert ...]

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { FIXED_DT } from '../src/shared/constants';
import { DIFFICULTY, type Difficulty } from '../src/shared/difficulty';
import type { DrivingAssist } from '../src/vehicle/assists';
import { VehicleController } from '../src/vehicle/VehicleController';

await RAPIER.init();
let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

function pad(surface: 'road' | 'grass') {
  const physics = new PhysicsWorld();
  physics.addStatic(RAPIER.ColliderDesc.cuboid(400, 0.5, 400).setTranslation(0, -0.5, 0).setFriction(0.9), surface);
  return physics;
}

interface Run {
  peakSlip: number; // deg
  peakSideSpeed: number; // m/s
  yaw: number; // total heading change, deg
  settle: number; // s until slip < 3 deg after the input ends (-1 = never)
  spun: boolean;
}

function drive(assist: DrivingAssist, surface: 'road' | 'grass' | 'mud', speedKmh: number, script: (t: number) => { steer: number; handbrake?: boolean; throttle?: number }, seconds: number, inputEnds: number): Run {
  const physics = pad(surface === 'mud' ? 'road' : surface);
  // mud = one big puddle on the road
  const car = new VehicleController(physics, { x: 0, y: 0.75, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }, () => (surface === 'mud' ? 0 : -1));
  car.assist = assist;
  // settle on the springs, then launch straight ahead (-Z)
  for (let i = 0; i < 40; i++) {
    car.preStep({ throttle: 0, brake: 0, steer: 0, handbrake: false, neutral: false, steerAuthority: 1 }, FIXED_DT);
    physics.step();
    car.postStep(FIXED_DT);
  }
  car.body.setLinvel({ x: 0, y: 0, z: -speedKmh / 3.6 }, true);
  let peakSlip = 0;
  let peakSide = 0;
  let settle = -1;
  let spun = false;
  const startYaw = 0;
  let yaw = 0;
  let lastYaw = 0;
  for (let t = 0; t < seconds; t += FIXED_DT) {
    const c = script(t);
    car.preStep({ throttle: c.throttle ?? 0.35, brake: 0, steer: c.steer, handbrake: !!c.handbrake, neutral: false, steerAuthority: 1 }, FIXED_DT);
    physics.step();
    car.postStep(FIXED_DT);
    const r = car.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const v = car.body.linvel();
    const vel = new THREE.Vector3(v.x, 0, v.z);
    const sp = vel.length();
    const h = Math.atan2(-fwd.x, -fwd.z);
    let dh = h - lastYaw;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    yaw += dh;
    lastYaw = h;
    if (sp > 3) {
      const slip = Math.abs(Math.atan2(vel.dot(right), Math.max(0.1, vel.dot(fwd)))) * 57.3;
      peakSlip = Math.max(peakSlip, slip);
      peakSide = Math.max(peakSide, Math.abs(vel.dot(right)));
      if (slip > 85) spun = true;
      if (t > inputEnds && settle < 0 && slip < 3) settle = t - inputEnds;
    }
  }
  physics.dispose();
  return { peakSlip, peakSideSpeed: peakSide, yaw: Math.abs(yaw - startYaw) * 57.3, settle, spun };
}

const laneChange = (t: number) => ({ steer: t < 0.45 ? -1 : t < 1.0 ? 1 : 0 });
const sweeper = (t: number) => ({ steer: t < 2 ? 1 : 0, throttle: 0.6 });
const handbrake = (t: number) => ({ steer: t < 1.0 ? -1 : 0, handbrake: t > 0.15 && t < 0.85, throttle: 0.2 });

const levels = (process.argv.slice(2).length ? process.argv.slice(2) : ['standard', 'hard', 'expert']) as Difficulty[];
const fmt = (r: Run) =>
  `peak slip ${r.peakSlip.toFixed(1).padStart(5)}°  side ${r.peakSideSpeed.toFixed(1).padStart(4)} m/s  yaw ${r.yaw.toFixed(0).padStart(4)}°  settles ${r.settle < 0 ? ' never' : `${r.settle.toFixed(2)} s`}${r.spun ? '  SPUN' : ''}`;
const results: Record<string, { lane: Run; sweep: Run; hb: Run; grass: Run; mud?: Run; lane50?: Run }> = {};
for (const l of levels) {
  const a = DIFFICULTY[l].handling;
  const lane = drive(a, 'road', 70, laneChange, 4, 1.0);
  const sweep = drive(a, 'road', 60, sweeper, 4, 2.0);
  const hb = drive(a, 'road', 50, handbrake, 3, 1.0);
  const grass = drive(a, 'grass', 70, laneChange, 4, 1.0);
  const mud = drive(a, 'mud', 50, laneChange, 4, 1.0);
  const lane50 = drive(a, 'road', 50, laneChange, 4, 1.0);
  results[l] = { lane, sweep, hb, grass, mud, lane50 };
  console.log(`${l.toUpperCase()}`);
  console.log(`  lane change 70 km/h (gravel): ${fmt(lane)}`);
  console.log(`  lane change 70 km/h (grass):  ${fmt(grass)}`);
  console.log(`  lane change 50 km/h (gravel): ${fmt(lane50)}`);
  console.log(`  lane change 50 km/h (mud):    ${fmt(mud)}`);
  console.log(`  long corner 60 km/h:          ${fmt(sweep)}`);
  console.log(`  handbrake turn 50 km/h:       ${fmt(hb)}`);
}
if (process.env.HANDLING_BASELINE) process.exit(0);
for (const l of levels) {
  const r = results[l];
  check(`${l}: no spin in the lane change (gravel and grass)`, !r.lane.spun && !r.grass.spun);
  check(`${l}: the tail stays in check in a lane change (peak slip ${r.lane.peakSlip.toFixed(1)}° < 14°)`, r.lane.peakSlip < 14);
  check(`${l}: settles straight within 1.5 s after the lane change`, r.lane.settle >= 0 && r.lane.settle < 1.5);
  check(`${l}: grass is still looser than gravel (${r.grass.peakSlip.toFixed(1)}° vs ${r.lane.peakSlip.toFixed(1)}°)`, r.grass.peakSlip >= r.lane.peakSlip * 0.9);
  check(`${l}: mud is more slippery than gravel at the same speed (slip ${r.mud!.peakSlip.toFixed(1)}° vs ${r.lane50!.peakSlip.toFixed(1)}°)`, r.mud!.peakSlip > r.lane50!.peakSlip * 1.25);
  check(`${l}: handbrake turns still work (yaw ${r.hb.yaw.toFixed(0)}° > 70°, slip ${r.hb.peakSlip.toFixed(0)}° > 18°)`, r.hb.yaw > 70 && r.hb.peakSlip > 18);
}
console.log(failures ? `${failures} HANDLING CHECK(S) FAILED` : 'ALL HANDLING CHECKS PASSED');
process.exit(failures ? 1 : 0);

// Headless livestock test with the real stage, world and vehicle physics.
// Checks: animals spawn on the ground and graze without wandering off; a flock
// scatters when the car comes at speed; a cow on the road is a real obstacle
// (the car reports an 'animal' impact) and gets knocked over, then stands up
// again; a honk moves a cow off the road; the tractor sets off when the car
// comes up behind it and stays on its side of the road; and the network pack
// reproduces the poses on a client without physics.
// Run: npx tsx scripts/animal-test.ts [seed]

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { FIXED_DT } from '../src/shared/constants';
import { mergeProps } from '../src/shared/snapshot';
import { generateStage } from '../src/shared/stage/StageGenerator';
import type { StageData } from '../src/shared/types';
import { VehicleController } from '../src/vehicle/VehicleController';
import { Animals, type CarNearby } from '../src/world/Animals';
import { Road } from '../src/world/Road';
import { Terrain } from '../src/world/Terrain';
import { TerrainField } from '../src/world/TerrainField';

await RAPIER.init();
const seed = Number(process.argv[2] ?? 42);
let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const stage = generateStage({ seed, length: 'medium', night: false, map: 'countryside' });
const field = new TerrainField(stage);
const kinds = { sheep: 0, cow: 0, tractor: 0 };
for (const a of stage.animals) kinds[a.kind]++;
console.log(`seed ${seed}: ${kinds.sheep} sheep, ${kinds.cow} cows, ${kinds.tractor} tractor(s)`);
check('the stage has sheep, cows and a tractor', kinds.sheep >= 4 && kinds.cow >= 1 && kinds.tractor === 1);

async function world() {
  const physics = new PhysicsWorld();
  const terrain = new Terrain(field, physics, 'low');
  await terrain.build();
  const road = new Road(stage, physics);
  const animals = new Animals(stage, field, road, physics);
  return { physics, road, animals };
}

const poseAt = (st: StageData, i: number, lateral = 0) => {
  const h = st.headings[i];
  return { x: st.xs[i] + Math.cos(h) * lateral, y: st.ys[i] + 0.75, z: st.zs[i] + Math.sin(h) * lateral, qx: 0, qy: Math.sin(-h / 2), qz: 0, qw: Math.cos(-h / 2) };
};

/** Steps the world; `car` may be null (no car anywhere near). */
function run(w: Awaited<ReturnType<typeof world>>, seconds: number, car: VehicleController | null, near: CarNearby, each?: (t: number) => void, input = { throttle: 0, brake: 0 }) {
  for (let t = 0; t < seconds; t += FIXED_DT) {
    if (car) {
      const p = car.body.translation();
      const v = car.body.linvel();
      near.pos.set(p.x, p.y, p.z);
      near.vel.set(v.x, v.y, v.z);
    }
    w.animals.beforePhysicsStep(FIXED_DT, near);
    car?.preStep({ throttle: input.throttle, brake: input.brake, steer: 0, handbrake: false, neutral: false, steerAuthority: 1 }, FIXED_DT);
    w.physics.step();
    car?.postStep(FIXED_DT);
    w.animals.afterPhysicsStep(near);
    w.animals.updateMeshes(1, FIXED_DT, near.pos);
    each?.(t);
  }
}
const farAway = (): CarNearby => ({ pos: new THREE.Vector3(1e5, 0, 1e5), vel: new THREE.Vector3(), horn: false });

// --- 1. spawn + grazing -------------------------------------------------------------
{
  const w = await world();
  // the car parked 70 m from the first flock: close enough that they graze, too far to scare them
  const f0 = w.animals.list.find((a) => a.kind === 'sheep')!;
  const parked: CarNearby = { pos: new THREE.Vector3(f0.pos.x + 70, f0.pos.y, f0.pos.z), vel: new THREE.Vector3(), horn: false };
  run(w, 8, null, parked);
  let maxGround = 0;
  let maxWander = 0;
  let grazed = 0;
  for (const a of w.animals.list) {
    if (a.kind === 'tractor') continue;
    maxGround = Math.max(maxGround, Math.abs(a.pos.y - field.heightAt(a.pos.x, a.pos.z)));
    maxWander = Math.max(maxWander, Math.hypot(a.pos.x - a.spawn.x, a.pos.z - a.spawn.z));
    if (a.spawn.flock === f0.spawn.flock && Math.hypot(a.pos.x - a.spawn.x, a.pos.z - a.spawn.z) > 0.3) grazed++;
  }
  check(`animals stand on the ground (max ${maxGround.toFixed(2)} m off)`, maxGround < 0.6);
  check(`the flock grazes (${grazed} sheep moved) but stays near home (max ${maxWander.toFixed(1)} m in 8 s)`, grazed >= 2 && maxWander < 8);
  const upright = w.animals.list.every((a) => new THREE.Vector3(0, 1, 0).applyQuaternion(a.quat).y > 0.95);
  check('everyone is still upright', upright);
}

// --- 2. a flock scatters ------------------------------------------------------------------
{
  const w = await world();
  const flock = w.animals.list.filter((a) => a.kind === 'sheep' && a.spawn.flock === 0);
  const fi = flock[0].spawn.idx;
  const car = new VehicleController(w.physics, poseAt(stage, fi - 30), () => -1);
  const h = stage.headings[fi - 30];
  car.body.setLinvel({ x: Math.sin(h) * 12, y: 0, z: -Math.cos(h) * 12 }, true);
  const near: CarNearby = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), horn: false };
  let maxSpeed = 0;
  run(w, 3.2, car, near, () => {
    for (const a of flock) maxSpeed = Math.max(maxSpeed, a.shownSpeed);
  }, { throttle: 0.2, brake: 0 });
  const fled = flock.filter((a) => a.state === 'flee' || Math.hypot(a.pos.x - a.spawn.x, a.pos.z - a.spawn.z) > 3).length;
  check(`the flock scatters when the car comes (${fled}/${flock.length} ran, top speed ${maxSpeed.toFixed(1)} m/s)`, fled >= Math.ceil(flock.length / 2) && maxSpeed > 2.5);
}

// --- 3. a cow on the road: impact, knocked over, stands up again ----------------------------
{
  const w = await world();
  const cow = w.animals.list.find((a) => a.kind === 'cow')!;
  // put her right in the middle of the road
  const ci = cow.spawn.idx;
  const p0 = poseAt(stage, ci);
  cow.body!.setTranslation({ x: p0.x, y: field.heightAt(p0.x, p0.z) + 0.05, z: p0.z }, true);
  run(w, 1, null, farAway());
  // aimed straight at her (the road may bend a little)
  const start = poseAt(stage, ci - 14);
  const h = Math.atan2(cow.pos.x - start.x, -(cow.pos.z - start.z));
  const car = new VehicleController(w.physics, { ...start, qy: Math.sin(-h / 2), qw: Math.cos(-h / 2) }, () => -1);
  car.body.setLinvel({ x: Math.sin(h) * 13, y: 0, z: -Math.cos(h) * 13 }, true);
  const near: CarNearby = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), horn: false };
  let animalHits = 0;
  let maxHit = 0;
  let tumbled = false;
  run(w, 2.5, car, near, () => {
    for (const imp of car.impacts) {
      if (imp.kind === 'animal') {
        animalHits++;
        maxHit = Math.max(maxHit, imp.strength);
      }
    }
    car.impacts.length = 0;
    if (cow.state === 'tumble') tumbled = true;
  }, { throttle: 0.3, brake: 0 });
  check(`the car hits the cow (${animalHits} 'animal' impacts, max ${maxHit.toFixed(1)})`, animalHits > 0 && maxHit > 1.5);
  check('the cow gets knocked over', tumbled);
  run(w, 7, car, near, () => (car.impacts.length = 0), { throttle: 0, brake: 1 });
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cow.quat).y;
  check(`...and gets back on her feet (up ${up.toFixed(2)}, state ${cow.state})`, up > 0.95 && cow.state !== 'tumble');
  check('the car stays on its wheels', new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion().copy(car.body.rotation() as THREE.Quaternion)).y > 0.5);
}

// --- 4. a honk moves a cow off the road ---------------------------------------------------------
{
  const w = await world();
  const cow = w.animals.list.filter((a) => a.kind === 'cow').at(-1)!;
  const ci = cow.spawn.idx;
  const p0 = poseAt(stage, ci, 0.4);
  cow.body!.setTranslation({ x: p0.x, y: field.heightAt(p0.x, p0.z) + 0.05, z: p0.z }, true);
  run(w, 1, null, farAway());
  const before = field.queryRoad(cow.pos.x, cow.pos.z).dist;
  const c = poseAt(stage, ci - 9);
  const near: CarNearby = { pos: new THREE.Vector3(c.x, c.y, c.z), vel: new THREE.Vector3(), horn: true };
  run(w, 5, null, near);
  const after = field.queryRoad(cow.pos.x, cow.pos.z).dist;
  check(`a honk sends the cow off the road (${before.toFixed(1)} -> ${after.toFixed(1)} m from the centre line)`, after > stage.halfWidths[ci] + 0.5 && after > before + 2);
}

// --- 5. the tractor ------------------------------------------------------------------------------
{
  const w = await world();
  const tr = w.animals.list.find((a) => a.kind === 'tractor')!;
  const ti = tr.spawn.idx;
  const c = poseAt(stage, ti - 25);
  const near: CarNearby = { pos: new THREE.Vector3(c.x, c.y, c.z), vel: new THREE.Vector3(), horn: false };
  run(w, 0.5, null, farAway());
  check('the tractor waits while nobody is around', tr.state === 'park');
  let maxLat = 0;
  run(w, 6, null, near, () => {
    const q = field.queryRoad(tr.pos.x, tr.pos.z);
    maxLat = Math.max(maxLat, Math.abs(q.lateral));
  });
  const moved = Math.hypot(tr.pos.x - tr.spawn.x, tr.pos.z - tr.spawn.z);
  check(`it sets off when the car comes up behind (${moved.toFixed(1)} m in 6 s)`, tr.state === 'drive' && moved > 25 && moved < 40);
  check(`it keeps to its side of the road (max ${maxLat.toFixed(2)} m from the centre)`, maxLat < stage.halfWidths[ti] - 0.6 && maxLat > 0.5);
}

// --- 6. network round trip ----------------------------------------------------------------------
{
  const w = await world();
  run(w, 2, null, farAway());
  const target = w.animals.list.find((a) => a.kind === 'sheep')!;
  const at = target.pos.clone();
  const pack = mergeProps(null, w.animals.packNear(at, 40));
  const remote = new Animals(stage, field, w.road, null);
  remote.applyRemote(pack!);
  for (let i = 0; i < 120; i++) remote.updateMeshes(1, 1 / 60, at);
  const twin = remote.list.find((a) => a.spawn.id === target.spawn.id)!;
  check(`a client without physics shows the same pose (${twin.pos.distanceTo(target.pos).toFixed(3)} m apart)`, twin.pos.distanceTo(target.pos) < 0.05);
}

console.log(failures ? `${failures} ANIMAL CHECK(S) FAILED` : 'ALL ANIMAL CHECKS PASSED');
process.exit(failures ? 1 : 0);

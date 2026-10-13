// Driving difficulty test: a deliberately clumsy "human" bot drives the same
// stages with the help of each difficulty (the same standard stages, so only the car differs). It steers with keyboard-style full lock,
// reacts a little late, only sees the road a short way ahead and brakes hard
// and late (a blind driver hearing the call too late). The assists should
// keep it on the road far more often and get it to the finish.
// Run: npx tsx scripts/assist-test.ts

import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { FIXED_DT, ROAD_SAMPLE_SPACING } from '../src/shared/constants';
import { RaceTracker } from '../src/shared/race/RaceTracker';
import { generateStage, stageStartPose } from '../src/shared/stage/StageGenerator';
import type { StageMap } from '../src/shared/types';
import { DIFFICULTIES as DRIVING_LEVELS, DIFFICULTY, type Difficulty as DrivingLevel } from '../src/shared/difficulty';
import { applyAssistInput } from '../src/vehicle/assists';
import { VehicleController } from '../src/vehicle/VehicleController';
import { Road } from '../src/world/Road';
import { Terrain } from '../src/world/Terrain';
import { TerrainField } from '../src/world/TerrainField';
import { Vegetation } from '../src/world/Vegetation';

await RAPIER.init();
let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

interface Result {
  finished: boolean;
  time: number;
  offRoad: number;
  hits: number;
  resets: number;
}

async function drive(seed: number, map: StageMap, level: DrivingLevel): Promise<Result> {
  const stage = generateStage({ seed, length: 'short', night: false, map });
  const physics = new PhysicsWorld();
  const field = new TerrainField(stage);
  await new Terrain(field, physics, 'low').build();
  const road = new Road(stage, physics);
  await new Vegetation(field, physics, 'low').build();
  const car = new VehicleController(physics, stageStartPose(stage), road.puddleAt);
  car.assist = DIFFICULTY[level].handling;
  const tracker = new RaceTracker(stage);
  const delay: number[] = [];
  let time = 0;
  let offRoad = 0;
  let wasOff = false;
  let hits = 0;
  let resets = 0;
  let stuck = 0;
  for (let step = 0; step < 60 * 200 && !tracker.finished; step++) {
    const t = car.body.translation();
    const v = car.body.linvel();
    const r = car.body.rotation();
    const loc = tracker.locator.locate(t.x, t.z);
    const speed = Math.hypot(v.x, v.z);
    // short look-ahead, keyboard steering (full lock or nothing), ~0.2 s reaction delay
    const ahead = Math.min(stage.count - 1, Math.floor(loc.idx + 3 + speed * 0.28));
    const fx = -2 * (r.x * r.z + r.w * r.y);
    const fz = -(1 - 2 * (r.x * r.x + r.y * r.y));
    let err = Math.atan2(stage.xs[ahead] - t.x, -(stage.zs[ahead] - t.z)) - Math.atan2(fx, -fz);
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    delay.push(err > 0.07 ? 1 : err < -0.07 ? -1 : 0);
    const steer = delay.length > 12 ? delay.shift()! : 0;
    // flat out, and a hard, late stamp on the brakes when a corner is suddenly right there
    let brake = 0;
    for (const c of stage.corners) {
      const d = (c.entryIdx - loc.idx) * ROAD_SAMPLE_SPACING;
      if (c.severity !== 'keep' && d > -4 && d < 22 && speed > c.targetSpeed + 4) brake = 1;
    }
    const inp = { throttle: brake ? 0 : 1, brake, steer, handbrake: false, neutral: false, steerAuthority: 1 };
    applyAssistInput(car.assist, stage, loc, car.forwardSpeed, inp, ROAD_SAMPLE_SPACING);
    car.frozen = step < 60;
    car.preStep(inp, FIXED_DT);
    physics.step();
    car.postStep(FIXED_DT);
    for (const imp of car.impacts) if (imp.kind !== 'landing' && imp.kind !== 'terrain' && imp.strength > 2) hits++;
    car.impacts.length = 0;
    time += FIXED_DT;
    if (step % 2 === 0) tracker.update(t.x, t.z, v.x, v.z, FIXED_DT * 2, time * 1000, t.y);
    const hw = stage.halfWidths[Math.max(0, Math.min(stage.count - 1, Math.round(loc.idx)))];
    const off = loc.distance > hw + 1.5;
    if (off && !wasOff) offRoad++;
    wasOff = off;
    // like a player: reset when stuck, or after going over the edge
    stuck = speed < 0.8 && !car.frozen ? stuck + FIXED_DT : 0;
    if (stuck > 4 || loc.roadY - t.y > 6) {
      stuck = 0;
      resets++;
      const i = Math.max(stage.startIdx, Math.floor(Math.min(loc.idx, tracker.maxIdx)) - 3);
      const h = stage.headings[i];
      car.setPose({ x: stage.xs[i], y: stage.ys[i] + 0.8, z: stage.zs[i], qx: 0, qy: Math.sin(-h / 2), qz: 0, qw: Math.cos(-h / 2) });
      tracker.teleported(stage.xs[i], stage.zs[i], i);
      delay.length = 0;
    }
  }
  physics.dispose();
  return { finished: tracker.finished, time, offRoad, hits, resets };
}

const runs: [number, StageMap][] = [[42, 'countryside'], [7, 'countryside'], [1234, 'countryside'], [42, 'mountain']];
const total: Record<DrivingLevel, Result & { done: number }> = {
  expert: { finished: true, time: 0, offRoad: 0, hits: 0, resets: 0, done: 0 },
  hard: { finished: true, time: 0, offRoad: 0, hits: 0, resets: 0, done: 0 },
  standard: { finished: true, time: 0, offRoad: 0, hits: 0, resets: 0, done: 0 },
};
for (const [seed, map] of runs) {
  for (const level of DRIVING_LEVELS) {
    const r = await drive(seed, map, level);
    console.log(`${map} ${seed} ${level.padEnd(6)} ${r.finished ? 'finished' : 'DNF     '} ${r.time.toFixed(0).padStart(4)} s  off-road ${String(r.offRoad).padStart(2)}  hits ${String(r.hits).padStart(2)}  resets ${r.resets}`);
    const t = total[level];
    t.offRoad += r.offRoad;
    t.hits += r.hits;
    t.resets += r.resets;
    t.time += r.time;
    if (r.finished) t.done++;
  }
}
for (const l of DRIVING_LEVELS) console.log(`${l.padEnd(6)}: ${total[l].done}/${runs.length} finished, off-road ${total[l].offRoad}, hits ${total[l].hits}, resets ${total[l].resets}`);
const mistakes = (l: DrivingLevel) => total[l].offRoad + total[l].hits + total[l].resets * 2;
check(`HARD helps a bit: fewer mistakes than EXPERT (${mistakes('hard')} vs ${mistakes('expert')})`, mistakes('hard') < mistakes('expert'));
check(`STANDARD helps most (${mistakes('standard')} vs HARD ${mistakes('hard')})`, mistakes('standard') <= mistakes('hard'));
check(`STANDARD gets the clumsy driver to the finish every time (${total.standard.done}/${runs.length})`, total.standard.done === runs.length);
console.log(failures ? `${failures} ASSIST CHECK(S) FAILED` : 'ALL ASSIST CHECKS PASSED');
process.exit(failures ? 1 : 0);

// Headless physics smoke test: builds a stage's colliders and lets a simple
// autopilot drive the hatchback along the road. Run: npx tsx scripts/sim-test.ts [seed] [countryside|mountain] [standard|hard|expert]
// Verifies the car drives, steers, stays on its wheels and reaches checkpoints.

import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { FIXED_DT, ROAD_SAMPLE_SPACING } from '../src/shared/constants';
import { RaceTracker } from '../src/shared/race/RaceTracker';
import { generateStage, stageStartPose } from '../src/shared/stage/StageGenerator';
import { VehicleController } from '../src/vehicle/VehicleController';
import { difficultyOf, isDifficulty } from '../src/shared/difficulty';
import { Road } from '../src/world/Road';
import { Terrain } from '../src/world/Terrain';
import { TerrainField } from '../src/world/TerrainField';
import { Vegetation } from '../src/world/Vegetation';

await RAPIER.init();
const seed = Number(process.argv[2] ?? 42);
const map = process.argv[3] === 'mountain' ? 'mountain' : 'countryside';
const difficulty = isDifficulty(process.argv[4]) ? process.argv[4] : 'standard';
const stage = generateStage({ seed, length: 'short', night: false, map, difficulty });
console.log(`${map} ${difficulty} stage, seed ${seed}: ${stage.totalLength.toFixed(0)} m, ${stage.corners.length} corners`);
const physics = new PhysicsWorld();
const field = new TerrainField(stage);
const t0 = performance.now();
const terrain = new Terrain(field, physics, 'medium');
await terrain.build();
const road = new Road(stage, physics);
const veg = new Vegetation(field, physics, 'medium');
await veg.build();
console.log(`world built in ${(performance.now() - t0).toFixed(0)} ms, colliders: ${physics.world.colliders.len()}`);

const car = new VehicleController(physics, stageStartPose(stage), road.puddleAt);
car.assist = difficultyOf(stage.params).handling;
const tracker = new RaceTracker(stage);
let time = 0;
let maxSpeed = 0;
let flips = 0;
let impacts = 0;
let lastLog = 0;
let stuckTime = 0;
let resets = 0;
const events: string[] = [];
const target = { steer: 0 };

for (let step = 0; step < 60 * 240; step++) {
  const t = car.body.translation();
  const v = car.body.linvel();
  const loc = tracker.locator.locate(t.x, t.z);
  // look ahead on the road and steer towards it
  const speed = Math.hypot(v.x, v.z);
  const ahead = Math.min(stage.count - 1, Math.floor(loc.idx + 4 + speed * 0.45));
  const tx = stage.xs[ahead] - t.x;
  const tz = stage.zs[ahead] - t.z;
  const r = car.body.rotation();
  // car forward heading
  const fx = 2 * (r.x * r.z + r.w * r.y) * -1;
  const fz = -(1 - 2 * (r.x * r.x + r.y * r.y));
  const heading = Math.atan2(fx, -fz);
  const want = Math.atan2(tx, -tz);
  let err = want - heading;
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;
  target.steer = Math.max(-1, Math.min(1, err * 2.2));
  // brake for upcoming corners
  let targetSpeed = 42;
  for (const c of stage.corners) {
    const d = (c.entryIdx - loc.idx) * ROAD_SAMPLE_SPACING;
    if (d > -10 && d < 80 && c.exitIdx > loc.idx) targetSpeed = Math.min(targetSpeed, c.targetSpeed * 0.85 + d * 0.12);
  }
  const throttle = speed < targetSpeed ? 1 : 0;
  const brake = speed > targetSpeed + 2 ? 0.7 : 0;
  car.frozen = step < 60;
  car.preStep({ throttle, brake, steer: target.steer, handbrake: false, neutral: false, steerAuthority: 1 }, FIXED_DT);
  physics.step();
  car.postStep(FIXED_DT);
  impacts += car.impacts.length;
  for (const imp of car.impacts) events.push(`t=${time.toFixed(1)} impact ${imp.kind} ${imp.strength.toFixed(1)}`);
  car.impacts.length = 0;
  time += FIXED_DT;
  maxSpeed = Math.max(maxSpeed, speed);
  const up = 1 - 2 * (r.x * r.x + r.z * r.z);
  if (up < 0.2) flips++;
  if (step % 2 === 0) for (const e of tracker.update(t.x, t.z, v.x, v.z, FIXED_DT * 2, time * 1000, t.y)) events.push(`t=${time.toFixed(1)} ${JSON.stringify(e)}`);
  // behave like a player: press R when stuck for 4 s (reset to the road like the server does)
  stuckTime = speed < 0.8 && !car.frozen ? stuckTime + FIXED_DT : 0;
  if (stuckTime > 4) {
    stuckTime = 0;
    resets++;
    // same rule as the server: back to where the car legitimately got to
    const i = Math.max(stage.startIdx, Math.floor(Math.min(loc.idx, tracker.maxIdx)) - 3);
    const h = stage.headings[i];
    car.setPose({ x: stage.xs[i], y: stage.ys[i] + 0.8, z: stage.zs[i], qx: 0, qy: Math.sin(-h / 2), qz: 0, qw: Math.cos(-h / 2) });
    tracker.teleported(stage.xs[i], stage.zs[i], i);
    events.push(`t=${time.toFixed(1)} RESET`);
  }
  if (time - lastLog > 10) {
    lastLog = time;
    console.log(`t=${time.toFixed(0)}s idx=${loc.idx.toFixed(0)}/${stage.finishIdx} lat=${loc.lateral.toFixed(1)} speed=${(speed * 3.6).toFixed(0)}km/h gear=${car.drivetrain.gear} rpm=${car.drivetrain.rpm.toFixed(0)} y=${t.y.toFixed(1)} roadY=${loc.roadY.toFixed(1)} up=${up.toFixed(2)}`);
  }
  if (tracker.finished) break;
}
console.log(events.slice(0, 40).join('\n'));
console.log(`finished=${tracker.finished} time=${time.toFixed(1)}s top=${(maxSpeed * 3.6).toFixed(0)}km/h impacts=${impacts} flippedSteps=${flips} missedTurns=${tracker.missedTurns} resets=${resets} cps=${tracker.checkpointsHit}/${stage.checkpoints.length}`);
process.exit(0);

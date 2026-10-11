// Headless mountain-edge test with the real world and vehicle physics: on an
// exposed section, the car leaves the road on the drop side at speed. Checks it
// actually falls (no invisible wall), tumbles / slides with impacts, never ends
// up inside the terrain, comes to rest on the mountainside, and that the race
// tracker doesn't count a lower stretch of road it may land on.
// Run: npx tsx scripts/fall-test.ts [seed] [km/h]

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { FIXED_DT } from '../src/shared/constants';
import { RaceTracker } from '../src/shared/race/RaceTracker';
import { generateStage } from '../src/shared/stage/StageGenerator';
import { VehicleController } from '../src/vehicle/VehicleController';
import { Road } from '../src/world/Road';
import { Terrain } from '../src/world/Terrain';
import { TerrainField } from '../src/world/TerrainField';
import { Vegetation } from '../src/world/Vegetation';

await RAPIER.init();
const seed = Number(process.argv[2] ?? 42);
const kmh = Number(process.argv[3] ?? 60);
let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const stage = generateStage({ seed, length: 'short', night: false, map: 'mountain' });
const physics = new PhysicsWorld();
const field = new TerrainField(stage);
const terrain = new Terrain(field, physics, 'medium');
await terrain.build();
new Road(stage, physics);
const veg = new Vegetation(field, physics, 'medium');
await veg.build();

// the most exposed, fairly straight stretch with a real drop beside it
let best = -1;
let bestDrop = 0;
let dropSide = 1;
for (let i = stage.startIdx + 40; i < stage.finishIdx - 40; i++) {
  if (stage.exposure[i] < 0.6) continue;
  let straight = true;
  for (let j = i - 12; j <= i + 4 && straight; j++) if (Math.abs(stage.curvature[j]) > 1 / 40) straight = false;
  if (!straight) continue;
  const h = stage.headings[i];
  for (const side of [-1, 1]) {
    const l = side * (stage.halfWidths[i] + 10);
    const drop = stage.ys[i] - field.heightAt(stage.xs[i] + Math.cos(h) * l, stage.zs[i] + Math.sin(h) * l);
    if (drop > bestDrop) {
      bestDrop = drop;
      best = i;
      dropSide = side;
    }
  }
}
check(`found an exposed section (idx ${best}, ground ${bestDrop.toFixed(1)} m below the road 10 m out)`, best > 0 && bestDrop > 5);

// start 12 samples (24 m) back, aimed a little towards the drop side
const i0 = best - 12;
const h0 = stage.headings[i0] + dropSide * 0.2;
const car = new VehicleController(
  physics,
  { x: stage.xs[i0], y: stage.ys[i0] + 0.75, z: stage.zs[i0], qx: 0, qy: Math.sin(-h0 / 2), qz: 0, qw: Math.cos(-h0 / 2) },
  () => -1,
);
const tracker = new RaceTracker(stage);
tracker.teleported(stage.xs[i0], stage.zs[i0], i0);
tracker.maxIdx = i0;
const v = kmh / 3.6;
car.body.setLinvel({ x: Math.sin(h0) * v, y: 0, z: -Math.cos(h0) * v }, true);

const start = new THREE.Vector3(stage.xs[i0], stage.ys[i0], stage.zs[i0]);
let minClear = Infinity;
let maxTilt = 0;
let impacts = 0;
let maxImpact = 0;
const kinds = new Map<string, number>();
let rest = 0;
let t = 0;
let leftRoadAt = -1;
const log: string[] = [];
for (let step = 0; step < 60 * 14; step++) {
  // a driver who has just gone over the edge stamps on the brake a moment later
  const braking = leftRoadAt >= 0 && t > leftRoadAt + 0.8;
  car.preStep({ throttle: t < 1 && leftRoadAt < 0 ? 0.6 : 0, brake: braking ? 1 : 0, steer: 0, handbrake: braking, neutral: false, steerAuthority: 1 }, FIXED_DT);
  physics.step();
  car.postStep(FIXED_DT);
  for (const imp of car.impacts) {
    impacts++;
    maxImpact = Math.max(maxImpact, imp.strength);
    kinds.set(imp.kind, (kinds.get(imp.kind) ?? 0) + 1);
  }
  car.impacts.length = 0;
  t += FIXED_DT;
  const p = car.body.translation();
  const r = car.body.rotation();
  const up = 1 - 2 * (r.x * r.x + r.z * r.z);
  maxTilt = Math.max(maxTilt, Math.acos(Math.max(-1, Math.min(1, up))) * 57.3);
  minClear = Math.min(minClear, p.y - field.heightAt(p.x, p.z));
  const q = field.queryRoad(p.x, p.z);
  if (leftRoadAt < 0 && q.dist > stage.halfWidths[Math.floor(q.idx)] + 1) leftRoadAt = t;
  const lv = car.body.linvel();
  if (step % 2 === 0) tracker.update(p.x, p.z, lv.x, lv.z, FIXED_DT * 2, t * 1000, p.y);
  const speed = Math.hypot(lv.x, lv.y, lv.z);
  if (step % 30 === 0) log.push(`t=${t.toFixed(1)} drop ${(start.y - p.y).toFixed(1)} m, ${(speed * 3.6).toFixed(0)} km/h, tilt ${(Math.acos(Math.max(-1, Math.min(1, up))) * 57.3).toFixed(0)}°, road ${q.dist.toFixed(1)} m away`);
  rest = speed < 0.4 ? rest + FIXED_DT : 0;
  if (rest > 1.5) break;
}
console.log(log.join('\n'));
const p = car.body.translation();
const q = field.queryRoad(p.x, p.z);
const fell = start.y - p.y;
console.log(`left the road after ${leftRoadAt.toFixed(2)} s; fell ${fell.toFixed(1)} m; max tilt ${maxTilt.toFixed(0)}°; impacts ${impacts} (max ${maxImpact.toFixed(1)}: ${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}); ends ${q.dist.toFixed(1)} m from the nearest road (sample ${q.idx.toFixed(0)}, car was at ${i0}); tracker maxIdx ${tracker.maxIdx.toFixed(0)}, offRoute ${tracker.offRoute}`);
check('the car leaves the road over the edge (no invisible wall)', leftRoadAt > 0);
check(`it falls down the mountainside (${fell.toFixed(1)} m)`, fell > 3);
check(`it hits the hillside / rocks on the way (${impacts} impacts)`, impacts > 0);
check(`it never ends up inside the terrain (min clearance ${minClear.toFixed(2)} m)`, minClear > -0.6);
check(`it comes to rest on the mountain (${rest > 1.5 ? 'stopped' : 'still moving after 14 s'})`, rest > 1.5);
check('progress never jumps ahead along the route', tracker.maxIdx <= best + 14);
console.log(failures ? `${failures} FAILED` : 'ALL FALL CHECKS PASSED');
process.exit(failures ? 1 : 0);

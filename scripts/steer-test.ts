// Headless steering response: from a steady speed on flat gravel, steer full
// lock for 0.6 s and measure the yaw rate reached, the time to reach half of
// it, and the slip (sideways speed). Run: npx tsx scripts/steer-test.ts

import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from '../src/physics/PhysicsWorld';
import { FIXED_DT } from '../src/shared/constants';
import { VehicleController, type DriveInput } from '../src/vehicle/VehicleController';

await RAPIER.init();
const rows: string[] = [];
for (const kmh of [30, 60, 100, 140]) {
  const physics = new PhysicsWorld();
  physics.addStatic(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setTranslation(0, -0.5, 0).setFriction(0.9), 'road');
  const car = new VehicleController(physics, { x: 0, y: 0.75, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }, () => -1);
  const v = kmh / 3.6;
  const step = (inp: Partial<DriveInput>) => {
    car.preStep({ throttle: 0, brake: 0, steer: 0, handbrake: false, neutral: false, steerAuthority: 1, ...inp }, FIXED_DT);
    physics.step();
    car.postStep(FIXED_DT);
  };
  for (let i = 0; i < 60; i++) step({});
  car.body.setLinvel({ x: 0, y: 0, z: -v }, true);
  // hold the speed for a moment
  for (let i = 0; i < 30; i++) {
    car.body.setLinvel({ x: 0, y: car.body.linvel().y, z: -v }, true);
    step({ throttle: 0.4 });
  }
  let peak = 0;
  let tHalf = -1;
  const yaw: number[] = [];
  for (let i = 0; i < 36; i++) {
    step({ steer: 1, throttle: 0.4 });
    yaw.push(Math.abs(car.body.angvel().y));
  }
  peak = Math.max(...yaw);
  tHalf = yaw.findIndex((w) => w >= peak / 2) * FIXED_DT;
  const lv = car.body.linvel();
  const r = car.body.rotation();
  const fx = -2 * (r.x * r.z + r.w * r.y);
  const fz = -(1 - 2 * (r.x * r.x + r.y * r.y));
  const side = Math.abs(lv.x * -fz + lv.z * fx);
  rows.push(`${String(kmh).padStart(3)} km/h: steer angle ${car.steerAngle.toFixed(3)} rad, peak yaw ${peak.toFixed(2)} rad/s, half-peak after ${(tHalf * 1000).toFixed(0)} ms, sideways ${side.toFixed(1)} m/s`);
  car.dispose();
  physics.dispose();
}
console.log(rows.join('\n'));

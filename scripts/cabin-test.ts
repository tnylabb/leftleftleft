// Headless cabin physics test: tablet + loose objects under cornering, braking,
// weightlessness and an impact; one-handed holding. Run: npx tsx scripts/cabin-test.ts

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CabinPhysics } from '../src/physics/CabinPhysics';
import { CABIN_BOUNDS, FIXED_DT } from '../src/shared/constants';

await RAPIER.init();
const drops: string[] = [];
let contacts = 0;
let failures = 0;
const cabin = new CabinPhysics({ contact: () => contacts++, dropped: (i, r) => drops.push(`${i}:${r}`) });
const fmt = (v: THREE.Vector3) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};
const g = new THREE.Vector3();
const HOLD_POS = new THREE.Vector3(0.3, 0.4, -0.15);
const HOLD_QUAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.0);
const run = (label: string, seconds: number, gravity: THREE.Vector3, hold = false, log = true) => {
  for (let t = 0; t < seconds; t += FIXED_DT) {
    if (hold) cabin.setHoldTarget(HOLD_POS, HOLD_QUAT);
    cabin.step(FIXED_DT, gravity);
  }
  if (!log) return;
  const names = ['tablet', 'bottle', 'cup', 'notes', 'snack'];
  console.log(`${label.padEnd(28)} ${names.map((n, i) => `${n}${fmt(cabin.currPos[i])}`).join(' ')} held=${cabin.held} grip=${cabin.grip.toFixed(0)}`);
};
run('settle (1g)', 1.5, g.set(0, -9.81, 0));
cabin.grab(0);
run('held, calm', 1, g.set(0, -9.81, 0), true);
run('held, hard left turn (0.6g)', 1.5, g.set(6, -9.81, 0), true);
run('held, 1g slide', 3, g.set(10, -9.81, 0), true);
cabin.shock(new THREE.Vector3(0, 0, -1), 8);
run('after frontal impact', 1.0, g.set(0, -9.81, 0));
run('hard braking', 1.0, g.set(0, -9.81, -8));
run('weightless (jump)', 0.6, g.set(0, 0, 0));
run('right turn', 1.5, g.set(-9, -9.81, 0));
let escaped = 0;
const b = CABIN_BOUNDS;
for (const p of cabin.currPos) if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY || p.z < b.minZ || p.z > b.maxZ) escaped++;
console.log(`drops=${JSON.stringify(drops)} contacts=${contacts} escaped=${escaped}`);
check('nothing escaped the cabin', escaped === 0);

// ---- one-handed hold (right hand pointing / on the door) drains the grip faster
cabin.reset();
run('', 1.0, g.set(0, -9.81, 0), false, false);
const drainOver = (oneHanded: boolean) => {
  cabin.release('released', false);
  cabin.grab(0);
  cabin.oneHanded = oneHanded;
  for (let t = 0; t < 1.0; t += FIXED_DT) {
    cabin.setHoldTarget(HOLD_POS, HOLD_QUAT);
    cabin.step(FIXED_DT, g.set(6.5, -9.81, 0));
  }
  return 100 - cabin.grip;
};
const two = drainOver(false);
const one = drainOver(true);
cabin.oneHanded = false;
check(`one-handed grip drains faster in a 0.66 g corner (${one.toFixed(0)} vs ${two.toFixed(0)} per second)`, one > two * 1.4);
check('only the tablet and the four loose objects are cabin bodies', cabin.bodies.length === 5);

console.log(failures ? `${failures} FAILED` : 'ALL CABIN CHECKS PASSED');
process.exit(failures ? 1 : 0);

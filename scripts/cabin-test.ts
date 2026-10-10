// Headless cabin physics test: tablet + loose objects under cornering, braking,
// weightlessness and an impact. Run: npx tsx scripts/cabin-test.ts

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CabinPhysics } from '../src/physics/CabinPhysics';
import { CABIN_BOUNDS, FIXED_DT } from '../src/shared/constants';

await RAPIER.init();
const drops: string[] = [];
let contacts = 0;
const cabin = new CabinPhysics({ contact: () => contacts++, dropped: (r) => drops.push(r) });
const fmt = (v: THREE.Vector3) => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
const g = new THREE.Vector3();
const run = (label: string, seconds: number, gravity: THREE.Vector3, hold = false) => {
  for (let t = 0; t < seconds; t += FIXED_DT) {
    if (hold) cabin.setHoldTarget(new THREE.Vector3(0.3, 0.4, -0.15), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.0));
    cabin.step(FIXED_DT, gravity);
  }
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
process.exit(0);

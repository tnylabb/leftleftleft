// Headless cabin physics test: tablet + loose objects under cornering, braking,
// weightlessness and an impact; then the dashboard flashlight and the glovebox
// paper map. Run: npx tsx scripts/cabin-test.ts

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CabinPhysics } from '../src/physics/CabinPhysics';
import { CABIN_BODY, CABIN_BOUNDS, FIXED_DT } from '../src/shared/constants';
import { FLASHLIGHT_HOLDER, GLOVEBOX_OPENING } from '../src/tablet/cabinObjects';

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

// ---- flashlight: rides in its holder through hard driving, then hand-held and returned
cabin.reset();
const fl = CABIN_BODY.flashlight;
run('', 1.5, g.set(9, -9.81, -7), false, false);
check(`flashlight stays clipped in its holder under 1g (${fmt(cabin.currPos[fl])})`, cabin.flashlightStowed && cabin.currPos[fl].distanceTo(FLASHLIGHT_HOLDER.pos) < 0.01);
check('flashlight goes to the torch hand', cabin.grab(fl) && cabin.torchHeld && !cabin.flashlightStowed);
cabin.grab(0);
check('tablet held in the other hand at the same time', cabin.held === 0 && cabin.torchHeld);
const aim = new THREE.Vector3(0.5, 0.45, -0.2);
const aimQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.6);
for (let t = 0; t < 1.2; t += FIXED_DT) {
  cabin.setHoldTarget(HOLD_POS, HOLD_QUAT);
  cabin.setTorchTarget(aim, aimQ);
  cabin.step(FIXED_DT, g.set(0, -9.81, 0));
}
check(`hand-held flashlight follows the hand target (err ${cabin.currPos[fl].distanceTo(aim).toFixed(3)} m)`, cabin.currPos[fl].distanceTo(aim) < 0.05);
cabin.stowFlashlight();
check('flashlight returned to the holder', cabin.flashlightStowed && !cabin.torchHeld && cabin.currPos[fl].distanceTo(FLASHLIGHT_HOLDER.pos) < 0.01);
cabin.releaseTorch('impact');
run('', 0.6, g.set(0, -9.81, 0), true, false);
check('a stowed flashlight is not knocked loose by a drop call', cabin.flashlightStowed);

// ---- paper map: out of the glovebox, opened, harder to hold at speed, put back
const mp = CABIN_BODY.map;
check('map starts in the closed glovebox', cabin.mapStowed);
check('map comes out of the glovebox into the hand', cabin.grab(mp) && cabin.held === mp && !cabin.mapStowed && cabin.currPos[mp].distanceTo(GLOVEBOX_OPENING) < 0.05);
cabin.setMapOpen(true);
cabin.awkwardness = 1;
run('', 1.0, g.set(0, -9.81, 0), true, false);
const calmGrip = cabin.grip;
check(`open map held calmly keeps full grip (${calmGrip.toFixed(0)})`, calmGrip > 95);
cabin.awkwardness = 1 + 25 / 18; // open map at ~90 km/h (Game: 1 + min(1.6, speed/18))
let lostAt = -1;
for (let t = 0; t < 6 && cabin.held === mp; t += FIXED_DT) {
  cabin.setHoldTarget(HOLD_POS, HOLD_QUAT);
  cabin.step(FIXED_DT, g.set(5.5, -9.81, 0));
  lostAt = t;
}
check(`open map at speed in a long corner slips out of the hand (after ${lostAt.toFixed(1)} s)`, cabin.held !== mp);
cabin.awkwardness = 1;
cabin.grab(mp);
cabin.setMapOpen(false);
cabin.stowMap();
check('map folded and back in the glovebox', cabin.mapStowed && !cabin.mapOpen && cabin.held < 0);

console.log(failures ? `${failures} FAILED` : 'ALL CABIN CHECKS PASSED');
process.exit(failures ? 1 : 0);

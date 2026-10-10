// Main (world-space) Rapier physics world with surface tagging for colliders.

import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT } from '../shared/constants';

export type Surface = 'road' | 'grass' | 'tree' | 'rock' | 'bale' | 'prop' | 'car';

export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly events: RAPIER.EventQueue;
  private surfaces = new Map<number, Surface>();

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
    this.events = new RAPIER.EventQueue(true);
  }

  addStatic(desc: RAPIER.ColliderDesc, surface: Surface): RAPIER.Collider {
    const c = this.world.createCollider(desc);
    this.surfaces.set(c.handle, surface);
    return c;
  }

  addBody(bodyDesc: RAPIER.RigidBodyDesc, colliders: RAPIER.ColliderDesc[], surface: Surface): { body: RAPIER.RigidBody; colliders: RAPIER.Collider[] } {
    const body = this.world.createRigidBody(bodyDesc);
    const cs = colliders.map((d) => {
      const c = this.world.createCollider(d, body);
      this.surfaces.set(c.handle, surface);
      return c;
    });
    return { body, colliders: cs };
  }

  surfaceOf(handle: number): Surface {
    return this.surfaces.get(handle) ?? 'grass';
  }

  step() {
    this.world.step(this.events);
  }

  dispose() {
    this.events.free();
    this.world.free();
    this.surfaces.clear();
  }
}

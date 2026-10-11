// Builds the controls shown in the hold-Tab overlay (and the pause / help
// screens) straight from core/Bindings, filtered by the player's current state,
// so every listed control actually works right now.

import { CALLOUT_KEY_LABEL, COMMON_KEYS, DRIVER_KEYS, NAV_KEYS, type BindMode } from '../core/Bindings';
import type { Role } from '../shared/types';

export interface ControlsState {
  role: Role;
  mode: BindMode;
  online: boolean;
  inCar: boolean;
  carStopped: boolean;
  nearDoor: boolean;
  nearHook: boolean;
  gripping: boolean;
  holding: 'tablet' | 'object' | null;
  headlampOn: boolean;
  /** The mouse is captured (pointer lock): look with the mouse, interact via the centre crosshair. */
  mouseCaptured: boolean;
  doorOpen: boolean;
  voice: boolean;
}

export type Row = [keys: string, action: string];

export function controlRows(s: ControlsState): Row[] {
  const rows: Row[] = [];
  if (s.role === 'driver') {
    const k = DRIVER_KEYS[s.mode];
    if (s.inCar) {
      rows.push([`${k.throttle.label} · ${k.brake.label}`, 'Throttle · brake / reverse']);
      rows.push([`${k.left.label} · ${k.right.label}`, 'Steer']);
      rows.push([k.handbrake.label, 'Handbrake']);
      rows.push([k.wipers.label, 'One wiper sweep']);
      rows.push([k.handWipe.label, 'Wipe the glass by hand (where you look)']);
      rows.push([k.horn.label, 'Horn']);
      rows.push(k.glance ? [k.glance.label, 'Glance at the navigator / tablet'] : ['Click + mouse', 'Look around']);
      if (s.doorOpen) rows.push([k.closeDoor.label, 'Close your door']);
      if (s.carStopped) rows.push([k.exitEnter.label, 'Get out of the car']);
    } else {
      if (k.footTurnWithKeys) {
        rows.push([`${k.footForward.label} · ${k.footBack.label}`, 'Walk forward / back']);
        rows.push([`${k.footLeft.label} · ${k.footRight.label}`, 'Turn']);
      } else {
        rows.push([`${k.footForward.label}${k.footLeft.label}${k.footBack.label}${k.footRight.label}`, 'Walk']);
        rows.push(['Mouse', 'Look around']);
      }
      rows.push([k.footRun.label, 'Run']);
      const grip = k.footGrip ? k.footGrip.label : 'Left mouse (hold)';
      if (s.gripping) rows.push([`${grip} + walk away`, 'Pull the car (release to let go)']);
      else if (s.nearHook) rows.push([grip, 'Grip the tow hook']);
      if (s.nearDoor) rows.push([k.exitEnter.label, 'Get back in']);
    }
    rows.push([k.reset.label, 'Emergency reset (last resort, +5 s)']);
  } else {
    const k = NAV_KEYS[s.mode];
    if (s.inCar) {
      if (s.mouseCaptured) {
        rows.push(['Mouse', 'Look around']);
        rows.push(['Left click', s.holding ? 'Put down what you hold' : 'Grab what the crosshair is on']);
      } else {
        rows.push(['Click the game', 'Capture the mouse to look around']);
        rows.push(['Left click', s.holding ? 'Put down what you hold' : 'Grab tablet / object']);
        rows.push(['Right mouse (hold)', 'Look around']);
      }
      if (s.holding) {
        rows.push(['Mouse wheel', 'Hold closer / farther']);
        rows.push(['Middle-drag', 'Rotate it']);
        rows.push([`${k.turnLeft.label} ${k.turnRight.label}`, 'Turn it (show the driver!)']);
        rows.push([`${k.tiltUp.label} ${k.tiltDown.label}`, 'Tilt']);
      }
      if (!s.holding) rows.push([k.tabletPickup.label, 'Pick up the tablet (lean)']);
      rows.push([k.headlamp.label, s.headlampOn ? 'Head lamp off' : 'Head lamp on']);
      rows.push([k.point.label, 'Point (aim by looking)']);
      rows.push([CALLOUT_KEY_LABEL, 'Shout a callout']);
      rows.push([k.readNote.label, 'Read the next pace note aloud']);
      if (s.doorOpen) rows.push([k.closeDoor ? `${k.closeDoor.label} / click handle` : 'Click handle', 'Close your door']);
      if (s.carStopped) rows.push([k.exitEnter.label, 'Get out of the car']);
    } else {
      rows.push([`${k.footForward.label}${k.footLeft.label}${k.footBack.label}${k.footRight.label}`, 'Walk']);
      rows.push(['Mouse', 'Look around']);
      rows.push([k.footRun.label, 'Run']);
      if (s.gripping) rows.push(['Left mouse + walk away', 'Pull the car (release to let go)']);
      else if (s.nearHook) rows.push(['Left mouse (hold)', 'Grip the tow hook']);
      rows.push([k.headlamp.label, s.headlampOn ? 'Head lamp off' : 'Head lamp on']);
      if (s.nearDoor) rows.push([k.exitEnter.label, 'Get back in']);
    }
  }
  if (s.online && s.voice) rows.push([COMMON_KEYS.talk.label, 'Push to talk']);
  rows.push([COMMON_KEYS.controls.label, 'This list']);
  rows.push([COMMON_KEYS.pause.label, s.online ? 'Menu + free the mouse (the stage keeps running)' : 'Pause + free the mouse']);
  return rows;
}

/** Full reference for the pause and help screens (everything, both states). */
export function referenceHtml(role: Role, mode: BindMode): string {
  const base: Omit<ControlsState, 'role' | 'inCar'> = {
    mode,
    online: false,
    carStopped: true,
    nearDoor: true,
    nearHook: true,
    gripping: false,
    holding: null,
    headlampOn: false,
    mouseCaptured: true,
    doorOpen: true,
    voice: false,
  };
  const seen = new Set<string>();
  const lines: string[] = [];
  const add = (rows: Row[]) => {
    for (const [keys, action] of rows) {
      const id = keys + action;
      if (seen.has(id) || keys.startsWith('Tab') || keys === 'Esc') continue;
      seen.add(id);
      lines.push(`<kbd>${keys}</kbd> ${action}`);
    }
  };
  add(controlRows({ ...base, role, inCar: true }));
  if (role === 'navigator') {
    add(controlRows({ ...base, role, inCar: true, holding: 'tablet' }));
  }
  lines.push('<b>On foot</b>');
  add(controlRows({ ...base, role, inCar: false }));
  add(controlRows({ ...base, role, inCar: false, gripping: true }));
  return lines.join('<br>');
}

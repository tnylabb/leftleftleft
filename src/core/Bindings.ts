// Single source of truth for key bindings. Controls read their keys from here
// and the Tab overlay prints these exact labels, so the overlay can never show
// a control that does not work. Split screen ("couch") gives the navigator
// separate keys so no physical key ever triggers actions for both players.

export interface Binding {
  label: string;
  codes: string[];
}

const b = (label: string, ...codes: string[]): Binding => ({ label, codes });

export type BindMode = 'single' | 'couch';

export interface DriverKeys {
  throttle: Binding;
  brake: Binding;
  left: Binding;
  right: Binding;
  handbrake: Binding;
  wipers: Binding;
  handWipe: Binding;
  closeDoor: Binding;
  horn: Binding;
  exitEnter: Binding;
  reset: Binding;
  glance: Binding | null; // keyboard glance (split screen has no mouse for the driver)
  footForward: Binding;
  footBack: Binding;
  footLeft: Binding;
  footRight: Binding;
  footRun: Binding;
  footGrip: Binding | null; // null = left mouse button
  /** Split screen: A/D turn on foot instead of strafing (no mouse). */
  footTurnWithKeys: boolean;
}

export interface NavKeys {
  turnLeft: Binding;
  turnRight: Binding;
  tiltUp: Binding;
  tiltDown: Binding;
  tabletPickup: Binding;
  flashlight: Binding;
  flashlightToggle: Binding;
  map: Binding;
  point: Binding;
  closeDoor: Binding | null; // null = only by clicking the door handle
  exitEnter: Binding;
  readNote: Binding;
  footForward: Binding;
  footBack: Binding;
  footLeft: Binding;
  footRight: Binding;
  footRun: Binding;
}

export const COMMON_KEYS = {
  controls: b('Tab (hold)', 'Tab'),
  pause: b('Esc', 'Escape'),
  talk: b('T (hold)', 'KeyT'),
};

export const DRIVER_KEYS: Record<BindMode, DriverKeys> = {
  single: {
    throttle: b('W / ↑', 'KeyW', 'ArrowUp'),
    brake: b('S / ↓', 'KeyS', 'ArrowDown'),
    left: b('A / ←', 'KeyA', 'ArrowLeft'),
    right: b('D / →', 'KeyD', 'ArrowRight'),
    handbrake: b('Space', 'Space'),
    wipers: b('V', 'KeyV'),
    handWipe: b('C (hold)', 'KeyC'),
    closeDoor: b('G', 'KeyG'),
    horn: b('H', 'KeyH'),
    exitEnter: b('E', 'KeyE'),
    reset: b('R (hold)', 'KeyR'),
    glance: null,
    footForward: b('W', 'KeyW', 'ArrowUp'),
    footBack: b('S', 'KeyS', 'ArrowDown'),
    footLeft: b('A', 'KeyA', 'ArrowLeft'),
    footRight: b('D', 'KeyD', 'ArrowRight'),
    footRun: b('Shift', 'ShiftLeft', 'ShiftRight'),
    footGrip: null,
    footTurnWithKeys: false,
  },
  couch: {
    throttle: b('W', 'KeyW'),
    brake: b('S', 'KeyS'),
    left: b('A', 'KeyA'),
    right: b('D', 'KeyD'),
    handbrake: b('Space', 'Space'),
    wipers: b('V', 'KeyV'),
    handWipe: b('C (hold)', 'KeyC'),
    closeDoor: b('G', 'KeyG'),
    horn: b('H', 'KeyH'),
    exitEnter: b('E', 'KeyE'),
    reset: b('R (hold)', 'KeyR'),
    glance: b('Q (hold)', 'KeyQ'),
    footForward: b('W', 'KeyW'),
    footBack: b('S', 'KeyS'),
    footLeft: b('A', 'KeyA'),
    footRight: b('D', 'KeyD'),
    footRun: b('Left Shift', 'ShiftLeft'),
    footGrip: b('Space (hold)', 'Space'),
    footTurnWithKeys: true,
  },
};

export const NAV_KEYS: Record<BindMode, NavKeys> = {
  single: {
    turnLeft: b('←', 'ArrowLeft'),
    turnRight: b('→', 'ArrowRight'),
    tiltUp: b('↑', 'ArrowUp'),
    tiltDown: b('↓', 'ArrowDown'),
    tabletPickup: b('Q (hold)', 'KeyQ'),
    flashlight: b('F', 'KeyF'),
    flashlightToggle: b('G', 'KeyG'),
    map: b('M', 'KeyM'),
    point: b('X (hold)', 'KeyX'),
    closeDoor: b('C', 'KeyC'),
    exitEnter: b('E', 'KeyE'),
    readNote: b('Space', 'Space'),
    footForward: b('W', 'KeyW'),
    footBack: b('S', 'KeyS'),
    footLeft: b('A', 'KeyA'),
    footRight: b('D', 'KeyD'),
    footRun: b('Shift', 'ShiftLeft', 'ShiftRight'),
  },
  couch: {
    turnLeft: b('←', 'ArrowLeft'),
    turnRight: b('→', 'ArrowRight'),
    tiltUp: b('↑', 'ArrowUp'),
    tiltDown: b('↓', 'ArrowDown'),
    tabletPickup: b('Right Shift (hold)', 'ShiftRight'),
    flashlight: b('F', 'KeyF'),
    flashlightToggle: b('L', 'KeyL'),
    map: b('M', 'KeyM'),
    point: b('X (hold)', 'KeyX'),
    closeDoor: null,
    exitEnter: b('P', 'KeyP'),
    readNote: b('Enter', 'Enter', 'NumpadEnter'),
    footForward: b('↑', 'ArrowUp'),
    footBack: b('↓', 'ArrowDown'),
    footLeft: b('←', 'ArrowLeft'),
    footRight: b('→', 'ArrowRight'),
    footRun: b('Right Ctrl', 'ControlRight'),
  },
};

export const CALLOUT_KEY_LABEL = '1 – 0';

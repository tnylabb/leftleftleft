// Keyboard, mouse and gamepad state with per-frame edge detection.

export interface GamepadState {
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
  reset: boolean;
  lookX: number;
  lookY: number;
}

const BLOCKED_DEFAULT = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backquote', 'F1',
]);

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  mouseDX = 0;
  mouseDY = 0;
  buttons = 0;
  private buttonsPressed = 0;
  private buttonsReleased = 0;
  wheel = 0;
  pointerLocked = false;
  /** True once the mouse has moved over the page at least once. */
  mouseSeen = false;
  /** When false, game keys are ignored (menus / text fields). */
  gameplay = false;
  private gpPrevButtons: boolean[] = [];
  private gpPressed = new Set<number>();

  constructor(private canvas: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.clearAll);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clearAll();
    });
    window.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
    });
  }

  private isTyping(e: Event): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.isTyping(e)) return;
    if (this.gameplay && BLOCKED_DEFAULT.has(e.code)) e.preventDefault();
    if (!this.down.has(e.code)) this.pressed.add(e.code);
    this.down.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (this.down.has(e.code)) this.released.add(e.code);
    this.down.delete(e.code);
  };

  private onMouseMove = (e: MouseEvent) => {
    this.mouseSeen = true;
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    this.mouseDX += e.movementX || 0;
    this.mouseDY += e.movementY || 0;
  };

  private onMouseDown = (e: MouseEvent) => {
    const bit = e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 4 : 0;
    if (e.button === 1) e.preventDefault();
    this.buttons |= bit;
    this.buttonsPressed |= bit;
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
  };

  private onMouseUp = (e: MouseEvent) => {
    const bit = e.button === 0 ? 1 : e.button === 2 ? 2 : e.button === 1 ? 4 : 0;
    if (this.buttons & bit) this.buttonsReleased |= bit;
    this.buttons &= ~bit;
  };

  private onWheel = (e: WheelEvent) => {
    if (this.gameplay) e.preventDefault();
    this.wheel += Math.sign(e.deltaY);
  };

  clearAll = () => {
    for (const k of this.down) this.released.add(k);
    this.down.clear();
    this.buttons = 0;
  };

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  anyDown(...codes: string[]): boolean {
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  anyPressed(...codes: string[]): boolean {
    for (const c of codes) if (this.pressed.has(c)) return true;
    return false;
  }

  wasReleased(code: string): boolean {
    return this.released.has(code);
  }

  mouseDown(button: 'left' | 'right' | 'middle'): boolean {
    return (this.buttons & (button === 'left' ? 1 : button === 'right' ? 2 : 4)) !== 0;
  }

  mousePressed(button: 'left' | 'right' | 'middle'): boolean {
    return (this.buttonsPressed & (button === 'left' ? 1 : button === 'right' ? 2 : 4)) !== 0;
  }

  mouseReleased(button: 'left' | 'right' | 'middle'): boolean {
    return (this.buttonsReleased & (button === 'left' ? 1 : button === 'right' ? 2 : 4)) !== 0;
  }

  requestPointerLock() {
    if (document.pointerLockElement !== this.canvas) {
      try {
        const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        p?.catch?.(() => undefined);
      } catch {
        /* user gesture required - ignore */
      }
    }
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  gamepad(): GamepadState | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && Array.from(pads).find((p) => p && p.connected);
    if (!gp) return null;
    const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
    const btn = (i: number) => gp.buttons[i]?.pressed ?? false;
    const val = (i: number) => gp.buttons[i]?.value ?? 0;
    for (let i = 0; i < gp.buttons.length; i++) {
      if (btn(i) && !this.gpPrevButtons[i]) this.gpPressed.add(i);
      this.gpPrevButtons[i] = btn(i);
    }
    return {
      steer: dz(gp.axes[0] ?? 0),
      throttle: val(7),
      brake: val(6),
      handbrake: btn(0) || btn(5),
      reset: this.gpPressed.has(3),
      lookX: dz(gp.axes[2] ?? 0),
      lookY: dz(gp.axes[3] ?? 0),
    };
  }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.buttonsPressed = 0;
    this.buttonsReleased = 0;
    this.wheel = 0;
    this.gpPressed.clear();
  }
}

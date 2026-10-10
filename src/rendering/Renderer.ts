import * as THREE from 'three';
import type { Quality } from '../core/Settings';

export interface View {
  camera: THREE.PerspectiveCamera;
  /** Normalised viewport rect (0..1, origin bottom-left). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  width = 1;
  height = 1;
  private quality: Quality = 'medium';
  private observer: ResizeObserver;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    this.canvas = this.renderer.domElement;
    this.canvas.id = 'game-canvas';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      document.body.dataset.contextLost = '1';
    });
  }

  applyQuality(q: Quality) {
    this.quality = q;
    const maxRatio = q === 'high' ? 2 : q === 'medium' ? 1.25 : 0.85;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxRatio));
    this.renderer.shadowMap.enabled = q !== 'low';
    this.resize();
  }

  get shadowMapSize(): number {
    return this.quality === 'high' ? 2048 : 1536;
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
  }

  /** Renders one or more viewports (split screen). */
  render(scene: THREE.Scene, views: View[]) {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.clear();
    for (const v of views) {
      const x = Math.floor(v.x * this.width);
      const y = Math.floor(v.y * this.height);
      const w = Math.max(1, Math.floor(v.w * this.width));
      const h = Math.max(1, Math.floor(v.h * this.height));
      const aspect = w / h;
      if (Math.abs(v.camera.aspect - aspect) > 1e-4) {
        v.camera.aspect = aspect;
        v.camera.updateProjectionMatrix();
      }
      r.setViewport(x, y, w, h);
      r.setScissor(x, y, w, h);
      r.setScissorTest(true);
      r.render(scene, v.camera);
    }
    r.setScissorTest(false);
  }

  renderToTarget(scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget) {
    const r = this.renderer;
    r.setRenderTarget(target);
    r.setScissorTest(false);
    r.setViewport(0, 0, target.width, target.height);
    r.clear();
    r.render(scene, camera);
    r.setRenderTarget(null);
  }

  dispose() {
    this.observer.disconnect();
    this.renderer.dispose();
  }
}

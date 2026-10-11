import * as THREE from 'three';
import type { Quality } from '../core/Settings';
import { LAYER } from './layers';

export interface View {
  camera: THREE.PerspectiveCamera;
  /** Normalised viewport rect (0..1, origin bottom-left). */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Speed blur for an in-car view (0 = off, 1 = strongest). The exterior (world
   * layer) is blurred radially away from `blurCenter` (screen uv of the direction
   * of travel); the cockpit layers are drawn sharp on top.
   */
  blur?: number;
  blurCenter?: { x: number; y: number };
}

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

const BLUR_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 center;
uniform float strength;
uniform float aspect;
uniform float cameraNear;
uniform float cameraFar;
varying vec2 vUv;

float viewDepth(vec2 uv) {
  return -perspectiveDepthToViewZ(texture2D(tDepth, uv).r, cameraNear, cameraFar);
}

void main() {
  vec4 base = texture2D(tColor, vUv);
  vec2 dir = vUv - center;
  float r = length(dir * vec2(aspect, 1.0));
  // nearby things (the car's own bonnet) and the road straight ahead stay sharp;
  // roadside scenery towards the edges of the view streaks the most
  float amount = strength * smoothstep(3.5, 9.0, viewDepth(vUv)) * smoothstep(0.06, 0.55, r);
  vec3 col = base.rgb;
  if (amount > 0.002) {
    vec3 acc = base.rgb;
    float total = 1.0;
    for (int i = 1; i < 10; i++) {
      float t = float(i) / 9.0;
      vec2 uv = vUv - dir * amount * 0.13 * t;
      // don't smear the bonnet into the scenery
      float w = step(3.5, viewDepth(uv)) * (1.0 - t * 0.35);
      acc += texture2D(tColor, uv).rgb * w;
      total += w;
    }
    col = acc / total;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  width = 1;
  height = 1;
  private quality: Quality = 'medium';
  private observer: ResizeObserver;
  // speed blur
  private blurTarget: THREE.WebGLRenderTarget | null = null;
  private blurMat: THREE.ShaderMaterial;
  private blurScene = new THREE.Scene();
  private blurCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

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
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: BLUR_VERT,
      fragmentShader: BLUR_FRAG,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        center: { value: new THREE.Vector2(0.5, 0.5) },
        strength: { value: 0 },
        aspect: { value: 1 },
        cameraNear: { value: 0.05 },
        cameraFar: { value: 1000 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
    quad.frustumCulled = false;
    this.blurScene.add(quad);
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
      if ((v.blur ?? 0) > 0.01) {
        this.renderBlurred(scene, v, x, y, w, h);
        continue;
      }
      r.setViewport(x, y, w, h);
      r.setScissor(x, y, w, h);
      r.setScissorTest(true);
      r.render(scene, v.camera);
    }
    r.setScissorTest(false);
  }

  /** Exterior into an offscreen buffer -> radial speed blur into the viewport -> sharp cockpit on top. */
  private renderBlurred(scene: THREE.Scene, v: View, x: number, y: number, w: number, h: number) {
    const r = this.renderer;
    const pr = r.getPixelRatio();
    const tw = Math.max(1, Math.floor(w * pr));
    const th = Math.max(1, Math.floor(h * pr));
    if (!this.blurTarget) {
      this.blurTarget = new THREE.WebGLRenderTarget(tw, th, { type: THREE.HalfFloatType, samples: 4 });
      this.blurTarget.depthTexture = new THREE.DepthTexture(tw, th);
    } else if (this.blurTarget.width !== tw || this.blurTarget.height !== th) this.blurTarget.setSize(tw, th);
    const cam = v.camera;
    const mask = cam.layers.mask;

    // 1) the world outside
    cam.layers.set(LAYER.WORLD);
    r.setRenderTarget(this.blurTarget);
    r.setScissorTest(false);
    r.clear();
    r.render(scene, cam);

    // 2) blurred composite into this view's rectangle
    r.setRenderTarget(null);
    r.setViewport(x, y, w, h);
    r.setScissor(x, y, w, h);
    r.setScissorTest(true);
    const u = this.blurMat.uniforms;
    u.tColor.value = this.blurTarget.texture;
    u.tDepth.value = this.blurTarget.depthTexture;
    u.strength.value = Math.min(1, v.blur ?? 0);
    u.center.value.set(v.blurCenter?.x ?? 0.5, v.blurCenter?.y ?? 0.5);
    u.aspect.value = w / h;
    u.cameraNear.value = cam.near;
    u.cameraFar.value = cam.far;
    r.render(this.blurScene, this.blurCam);

    // 3) the cockpit (and the other occupant) sharp on top; shadows were already drawn this frame
    cam.layers.mask = mask & ~(1 << LAYER.WORLD);
    const bg = scene.background;
    const autoShadows = r.shadowMap.autoUpdate;
    scene.background = null;
    r.shadowMap.autoUpdate = false;
    r.clearDepth();
    r.render(scene, cam);
    scene.background = bg;
    r.shadowMap.autoUpdate = autoShadows;
    cam.layers.mask = mask;
  }

  /** Lights must reach every layer: the blurred path draws the cockpit layers on their own. */
  lightAllLayers(scene: THREE.Object3D) {
    scene.traverse((o) => {
      if ((o as THREE.Light).isLight) o.layers.enableAll();
    });
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
    this.blurTarget?.dispose();
    this.blurMat.dispose();
    this.renderer.dispose();
  }
}

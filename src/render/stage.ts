/**
 * The renderer, scene, camera and post-processing (bloom), shared by the game and the sandbox pages.
 *
 * Bloom: anything brighter than about 0.75 (linear, before tone mapping) glows. Neon lines and the exhaust are drawn bright
 * (emissive colours > 1 are fine: the composer's buffers are half-float), the dark terrain body stays below the threshold.
 *
 * Big coordinates: three.js builds modelView matrices on the CPU in double precision, so objects far from the origin render
 * precisely as long as the camera is near them. Only shaders that use WORLD positions themselves (terrain noise, grid lines) must
 * take care of float32 precision; see src/world/coords.ts for the axes.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { PALETTE } from './palette';

export interface StageOptions {
  /** Device-pixel-ratio cap (1 = fastest). */
  maxPixelRatio?: number;
  bloom?: boolean;
}

/**
 * Quality levels, cheapest first. `ratio` caps the render resolution (device pixels per CSS pixel; the browser scales the canvas
 * up), `samples` is the MSAA of the scene buffer, `bloom` the glow pass. The terrain and the neon lines are anti-aliased in their
 * shaders, so the low levels stay clean; they cost a fraction of `high`'s pixels (a weak integrated GPU holds 60 fps there).
 */
export const QUALITY = [
  { name: 'lowest', ratio: 0.6, samples: 0, bloom: false },
  { name: 'low', ratio: 0.8, samples: 0, bloom: true },
  { name: 'medium', ratio: 1.0, samples: 2, bloom: true },
  { name: 'high', ratio: 1.5, samples: 4, bloom: true },
] as const;
export const QUALITY_HIGH = QUALITY.length - 1;

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  private readonly maxPixelRatio: number;
  private level: number = QUALITY_HIGH;

  constructor(readonly canvas: HTMLCanvasElement, opts: StageOptions = {}) {
    this.maxPixelRatio = opts.maxPixelRatio ?? 1.5;
    // (no antialias on the canvas itself: the scene renders into the composer's MSAA buffer, the canvas only gets the result)
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.maxPixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(PALETTE.skyHorizon);

    this.camera = new THREE.PerspectiveCamera(65, 1, 0.5, 60000);

    const size = new THREE.Vector2(canvas.clientWidth || 1280, canvas.clientHeight || 720);
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(size, 0.9, 0.55, 0.75);
    this.bloom.enabled = opts.bloom ?? true;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** The quality level in force (an index into QUALITY). */
  get quality(): number {
    return this.level;
  }

  set quality(level: number) {
    const l = Math.max(0, Math.min(QUALITY_HIGH, Math.round(level)));
    if (l === this.level) return;
    this.level = l;
    const q = QUALITY[l];
    for (const t of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (t.samples !== q.samples) {
        t.samples = q.samples;
        t.dispose(); // (re-created with the new sample count on its next use)
      }
    }
    this.bloom.enabled = q.bloom;
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const pr = Math.min(window.devicePixelRatio, this.maxPixelRatio, QUALITY[this.level].ratio);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.composer.render();
  }
}

/**
 * Automatic graphics quality: keeps the game smooth on whatever GPU the browser hands it.
 *
 * On a laptop with two GPUs, a browser tab usually runs on the integrated one (an Intel UHD here: 30 fps at `high`, 80 at
 * `low`), unless the browser is told to use the fast one (play.bat does). So:
 *   - the first level is `high`, or `low` when the GPU's name says it is an integrated one;
 *   - while flying, every 2 s window that runs below 50 fps, or hitches (its slowest 5 % of frames over 45 ms), steps one level
 *     down, until it holds;
 *   - the level is remembered for that GPU (localStorage), so the next visit starts there, and a different GPU starts afresh.
 * `?q=` on the URL fixes a level and turns this off.
 */
import { QUALITY, QUALITY_HIGH, type Stage } from './stage';

const KEY = 'neon-flight.quality';
const WINDOW_S = 2;
const SETTLE_S = 1.5;
const MIN_FPS = 50;
const MAX_P95_MS = 45;
const INTEGRATED = /intel|uhd|iris|radeon\(tm\) graphics|radeon graphics|microsoft basic|swiftshader|llvmpipe/i;

export function gpuName(stage: Stage): string {
  try {
    const gl = stage.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    return 'unknown';
  }
}

export class QualityGovernor {
  readonly gpu: string;
  private fixed: boolean;
  private settle = SETTLE_S;
  private frames: number[] = [];
  private elapsed = 0;
  /** Called when the governor changes the level (for the HUD). */
  onChange: ((name: string) => void) | null = null;

  constructor(private readonly stage: Stage, fixed: boolean) {
    this.gpu = gpuName(stage);
    this.fixed = fixed;
    if (!fixed) stage.quality = this.remembered();
  }

  /** 'auto' adapts again, from the level remembered for this GPU; a number fixes that level (the settings menu). */
  setMode(mode: 'auto' | number): void {
    this.fixed = mode !== 'auto';
    this.frames = [];
    this.elapsed = 0;
    this.settle = SETTLE_S;
    this.stage.quality = mode === 'auto' ? this.remembered() : mode;
  }

  /** The level last settled on for this GPU, else the first guess (low on an integrated GPU, high otherwise). */
  private remembered(): number {
    let level: number = INTEGRATED.test(this.gpu) ? 1 : QUALITY_HIGH;
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { gpu?: string; level?: number } | null;
      if (saved && saved.gpu === this.gpu && typeof saved.level === 'number') level = saved.level;
    } catch {
      // no storage (private window, blocked): start from the guess
    }
    return level;
  }

  /** One frame of real time (seconds); `active` is false while paused or crashed (those frames are not judged). */
  frame(dt: number, active: boolean): void {
    if (this.fixed || !active || dt > 1) return;
    if (this.settle > 0) {
      this.settle -= dt;
      return;
    }
    this.frames.push(dt * 1000);
    this.elapsed += dt;
    if (this.elapsed < WINDOW_S) return;
    const fps = this.frames.length / this.elapsed;
    const sorted = [...this.frames].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    this.frames = [];
    this.elapsed = 0;
    if ((fps < MIN_FPS || p95 > MAX_P95_MS) && this.stage.quality > 0) {
      this.stage.quality -= 1;
      this.settle = SETTLE_S;
      this.save();
      this.onChange?.(QUALITY[this.stage.quality].name);
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ gpu: this.gpu, level: this.stage.quality }));
    } catch {
      // not kept: the next visit adapts again
    }
  }
}

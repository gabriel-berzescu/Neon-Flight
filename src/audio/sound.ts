/**
 * Sound, synthesised with Web Audio (no samples): one jet voice per engine, panned to its side (whine follows the spool, roar
 * follows the thrust), wind that grows with airspeed, and a crash.
 *
 * Browsers only start audio after a click or a key press (a gamepad press does not count), so `locked` stays true until then
 * and the HUD says so.
 */
import type { FlightState } from '../flight/flight';

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < d.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    d[i] = (s / 4294967296) * 2 - 1;
  }
  return b;
}

class JetVoice {
  private readonly whine: OscillatorNode;
  private readonly whine2: OscillatorNode;
  private readonly whineGain: GainNode;
  private readonly roarFilter: BiquadFilterNode;
  private readonly roarGain: GainNode;

  constructor(ctx: AudioContext, noise: AudioBuffer, out: AudioNode, pan: number) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(out);
    this.whine = ctx.createOscillator();
    this.whine.type = 'sawtooth';
    this.whine2 = ctx.createOscillator();
    this.whine2.type = 'triangle';
    const wf = ctx.createBiquadFilter();
    wf.type = 'lowpass';
    wf.frequency.value = 2400;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(wf);
    this.whine2.connect(wf);
    wf.connect(this.whineGain).connect(panner);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.playbackRate.value = 0.7 + Math.random() * 0.1;
    this.roarFilter = ctx.createBiquadFilter();
    this.roarFilter.type = 'lowpass';
    this.roarFilter.Q.value = 0.7;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    src.connect(this.roarFilter).connect(this.roarGain).connect(panner);
    this.whine.start();
    this.whine2.start();
    src.start(0, Math.random());
  }

  set(t: number, spool: number, thrust: number, running: boolean): void {
    const k = 0.08;
    const f = 220 + 1500 * spool;
    this.whine.frequency.setTargetAtTime(f, t, k);
    this.whine2.frequency.setTargetAtTime(f * 1.51, t, k);
    this.whineGain.gain.setTargetAtTime(running ? 0.012 + 0.03 * spool : 0, t, k);
    this.roarFilter.frequency.setTargetAtTime(240 + 2600 * thrust, t, k);
    this.roarGain.gain.setTargetAtTime(running ? 0.05 + 0.3 * thrust : 0, t, k);
  }
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private jets: [JetVoice, JetVoice] | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private wasCrashed = false;

  constructor(target: EventTarget = window) {
    const unlock = () => {
      this.start();
      if (this.ctx && this.ctx.state === 'running') {
        target.removeEventListener('keydown', unlock);
        target.removeEventListener('pointerdown', unlock);
      }
    };
    target.addEventListener('keydown', unlock);
    target.addEventListener('pointerdown', unlock);
  }

  get locked(): boolean {
    return !this.ctx || this.ctx.state !== 'running';
  }

  private start(): void {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      this.ctx = ctx;
      this.noise = noiseBuffer(ctx, 3);
      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      const comp = ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(ctx.destination);
      this.jets = [new JetVoice(ctx, this.noise, this.master, -0.55), new JetVoice(ctx, this.noise, this.master, 0.55)];
      const wind = ctx.createBufferSource();
      wind.buffer = this.noise;
      wind.loop = true;
      this.windFilter = ctx.createBiquadFilter();
      this.windFilter.type = 'bandpass';
      this.windFilter.Q.value = 0.6;
      this.windGain = ctx.createGain();
      this.windGain.gain.value = 0;
      wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
      wind.start();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  update(s: FlightState, paused: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.jets || !this.windFilter || !this.windGain || !this.master) return;
    const t = ctx.currentTime;
    const running = !s.crashed && !paused;
    for (let i = 0; i < 2; i++) {
      const spool = Math.max(0, Math.min(1, (s.n2[i] - 60) / 40));
      const thrust = Math.max(0, Math.min(1, s.thrust[i] / 11000));
      this.jets[i].set(t, spool, thrust, running);
    }
    const v = Math.min(1.2, s.speed / 280);
    this.windFilter.frequency.setTargetAtTime(300 + 1400 * v, t, 0.1);
    this.windGain.gain.setTargetAtTime(running ? 0.35 * v * v : 0, t, 0.1);
    if (s.crashed && !this.wasCrashed) this.crash();
    this.wasCrashed = s.crashed;
  }

  private crash(): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.master) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3000, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 1.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.2);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 2.3);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(30, t + 0.8);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.7, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 1.1);
  }
}

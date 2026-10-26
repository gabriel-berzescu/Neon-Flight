/**
 * The canyon run's own HUD, over the flight HUD: the run bar (gate, combo, clock, score), the points that pop up at each gate,
 * the marker on the next gate (or an arrow toward it when it is off screen), and the countdown.
 */
import * as THREE from 'three';
import type { CanyonRun, GateEvent } from '../game/canyon-run';

const CSS = `
.nf-run { position: fixed; inset: 0; pointer-events: none; color: #bff9ff; font: 600 15px/1.25 ui-monospace, 'Cascadia Mono', Consolas, monospace;
  letter-spacing: .08em; text-transform: uppercase; text-shadow: 0 0 6px rgba(34,243,255,.75), 0 0 18px rgba(34,243,255,.35); }
.nf-run .bar { position: absolute; top: 50px; left: 50%; transform: translateX(-50%); display: flex; gap: 26px; align-items: baseline;
  font-variant-numeric: tabular-nums; }
.nf-run .bar b { font-size: 22px; color: #fff; }
.nf-run .bar .score b { color: #ffd27a; text-shadow: 0 0 10px #ff9a40; font-size: 26px; }
.nf-run .bar .combo b { color: #ff6be6; text-shadow: 0 0 10px #ff2bd6; }
.nf-run .pop { position: absolute; top: 62%; left: 50%; transform: translate(-50%, 0); text-align: center; font-size: 26px; transition: none; }
.nf-run .pop.pass { color: #8dffbf; text-shadow: 0 0 10px #2dff8a, 0 0 28px #2dff8a; }
.nf-run .pop.miss { color: #ff7088; text-shadow: 0 0 10px #ff3355, 0 0 28px #ff3355; }
.nf-run .pop small { display: block; font-size: 14px; opacity: .85; margin-top: 2px; }
.nf-run .mark { position: absolute; width: 0; height: 0; }
.nf-run .mark svg { position: absolute; left: -22px; top: -22px; filter: drop-shadow(0 0 6px #ff9a40); }
.nf-run .mark span { position: absolute; left: 26px; top: -8px; font-size: 12px; color: #ffd27a; white-space: nowrap; }
.nf-run .count { position: absolute; top: 38%; left: 50%; transform: translate(-50%, -50%); font-size: 96px; color: #fff;
  text-shadow: 0 0 20px #ff2bd6, 0 0 60px #ff2bd6; letter-spacing: .1em; }
`;

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
};

export class RunHud {
  private readonly root: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly pop: HTMLElement;
  private readonly mark: HTMLElement;
  private readonly markText: HTMLElement;
  private readonly markSvg: SVGElement;
  private readonly count: HTMLElement;
  private popLeft = 0;
  private readonly v = new THREE.Vector3();
  private last = '';

  constructor(parent: HTMLElement) {
    if (!document.getElementById('nf-run-css')) {
      const st = document.createElement('style');
      st.id = 'nf-run-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = document.createElement('div');
    this.root.className = 'nf-run';
    this.root.innerHTML = `<div class="bar"></div><div class="pop"></div>
      <div class="mark"><svg width="44" height="44" viewBox="-22 -22 44 44" fill="none" stroke="#ffd27a" stroke-width="2.5"></svg><span></span></div>
      <div class="count"></div>`;
    parent.appendChild(this.root);
    this.bar = this.root.querySelector('.bar') as HTMLElement;
    this.pop = this.root.querySelector('.pop') as HTMLElement;
    this.mark = this.root.querySelector('.mark') as HTMLElement;
    this.markSvg = this.root.querySelector('.mark svg') as SVGElement;
    this.markText = this.root.querySelector('.mark span') as HTMLElement;
    this.count = this.root.querySelector('.count') as HTMLElement;
    this.hide();
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  /** A gate was passed or missed. */
  event(e: GateEvent): void {
    if (e.result === 'passed') {
      this.pop.className = 'pop pass';
      const extra = [e.bullseye ? 'bullseye' : '', e.multiplier > 1 ? `x${e.multiplier.toFixed(2).replace(/\.?0+$/, '')}` : ''].filter(Boolean).join(' · ');
      this.pop.innerHTML = `+${e.points}${extra ? `<small>${extra}</small>` : ''}`;
    } else {
      this.pop.className = 'pop miss';
      this.pop.innerHTML = 'missed<small>combo lost</small>';
    }
    this.popLeft = 1.3;
  }

  update(run: CanyonRun, position: THREE.Vector3, camera: THREE.Camera, dt: number, countdown: number): void {
    this.root.style.display = 'block';
    const total = run.canyon.gates.length;
    const gate = Math.min(run.next + 1, total);
    const html =
      `<div>gate <b>${gate}/${total}</b></div>` +
      `<div class="combo">combo <b>x${run.multiplier.toFixed(2).replace(/\.?0+$/, '')}</b></div>` +
      `<div>time <b>${fmtTime(run.elapsed)}</b></div>` +
      `<div class="score">score <b>${run.score}</b></div>`;
    if (html !== this.last) {
      this.bar.innerHTML = html;
      this.last = html;
    }

    this.popLeft = Math.max(0, this.popLeft - dt);
    this.pop.style.opacity = String(Math.min(1, this.popLeft / 0.4));
    this.pop.style.transform = `translate(-50%, ${(-(1.3 - this.popLeft) * 30).toFixed(1)}px)`;

    this.count.textContent = countdown > 0 ? (countdown > 3 ? '' : String(Math.ceil(countdown))) : countdown > -0.8 && run.elapsed < 0.8 ? 'go' : '';

    // the next gate: a diamond on it, or an arrow at the screen's edge pointing toward it
    const g = run.canyon.gates[run.next];
    if (!g || run.status !== 'flying') {
      this.mark.style.display = 'none';
      return;
    }
    this.mark.style.display = 'block';
    const dist = Math.hypot(g.x - position.x, g.y - position.y, g.z - position.z);
    this.v.set(g.x, g.y, g.z).project(camera);
    const behind = this.v.z > 1;
    let x = this.v.x, y = this.v.y;
    if (behind) {
      x = -x;
      y = -y;
    }
    const onScreen = !behind && Math.abs(x) < 0.95 && Math.abs(y) < 0.9;
    if (onScreen) {
      this.markSvg.innerHTML = '<path d="M0 -16 L16 0 L0 16 L-16 0 Z"/>';
      this.markSvg.style.transform = '';
    } else {
      const k = 0.9 / Math.max(Math.abs(x) / 0.95, Math.abs(y) / 0.9, 1e-6);
      x *= k;
      y *= k;
      const angle = Math.atan2(-y, x);
      this.markSvg.innerHTML = '<path d="M-10 -12 L12 0 L-10 12 Z" fill="#ffd27a"/>';
      this.markSvg.style.transform = `rotate(${angle}rad)`;
    }
    this.mark.style.left = `${((x + 1) * 50).toFixed(2)}%`;
    this.mark.style.top = `${((1 - y) * 50).toFixed(2)}%`;
    this.markText.textContent = `${Math.round(dist)} m`;
  }
}

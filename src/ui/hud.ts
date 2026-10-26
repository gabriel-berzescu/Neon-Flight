/**
 * The HUD: a few neon readouts over the 3D view (DOM, no canvas).
 *
 *   bottom left / right   each side's engine (thrust bar, trigger tick) and its elevon (the stick that moves it)
 *   bottom centre         airspeed (km/h), altitude (m), g
 *   top centre            heading
 *   centre                the flight-path marker (where the wing is actually going), warnings
 *   overlays              the controls card on the first flight, pause, crash, gamepad / sound hints
 */
import * as THREE from 'three';
import type { FlightState } from '../flight/flight';
import type { ControlFrame } from '../input/controls';

const CSS = `
.nf-hud { position: fixed; inset: 0; pointer-events: none; color: #bff9ff; font: 600 15px/1.25 ui-monospace, 'Cascadia Mono', Consolas, monospace;
  letter-spacing: 0.08em; text-transform: uppercase; text-shadow: 0 0 6px rgba(34,243,255,.75), 0 0 18px rgba(34,243,255,.35); user-select: none; }
.nf-hud .row { position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%); display: flex; gap: 34px; align-items: flex-end; }
.nf-hud .read { text-align: center; min-width: 96px; }
.nf-hud .read b { display: block; font-size: 30px; font-weight: 700; letter-spacing: 0.04em; font-variant-numeric: tabular-nums; }
.nf-hud .read i { font-style: normal; font-size: 11px; opacity: .7; letter-spacing: .2em; }
.nf-hud .hdg { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); font-size: 18px; font-variant-numeric: tabular-nums; }
.nf-hud .side { position: absolute; bottom: 26px; display: flex; gap: 22px; align-items: flex-end; }
.nf-hud .side.l { left: 28px; } .nf-hud .side.r { right: 28px; flex-direction: row-reverse; }
.nf-hud .bar { position: relative; width: 16px; height: 150px; border: 1.5px solid rgba(191,249,255,.7); border-radius: 3px;
  box-shadow: 0 0 10px rgba(34,243,255,.35), inset 0 0 8px rgba(34,243,255,.15); }
.nf-hud .bar .fill { position: absolute; left: 2px; right: 2px; bottom: 2px; background: linear-gradient(#ffd27a, #ff7a30);
  box-shadow: 0 0 12px #ff9a40; border-radius: 1px; }
.nf-hud .bar .tick { position: absolute; left: -7px; right: -7px; height: 2px; background: #fff; box-shadow: 0 0 6px #fff; }
.nf-hud .elev { position: relative; width: 6px; height: 70px; border-left: 1.5px solid rgba(255,43,214,.6); margin-bottom: 40px; }
.nf-hud .elev .dot { position: absolute; left: -6px; width: 10px; height: 10px; margin-top: -5px; border-radius: 50%; background: #ff6be6;
  box-shadow: 0 0 10px #ff2bd6; }
.nf-hud .lab { font-size: 10px; opacity: .75; letter-spacing: .14em; margin-top: 6px; text-align: center; white-space: nowrap; }
.nf-hud .stack { display: flex; flex-direction: column; align-items: center; }
.nf-hud .fpm { position: absolute; width: 34px; height: 34px; margin: -17px 0 0 -17px; }
.nf-hud .warn { position: absolute; top: 30%; left: 50%; transform: translateX(-50%); font-size: 28px; color: #ff6be6;
  text-shadow: 0 0 10px #ff2bd6, 0 0 30px #ff2bd6; letter-spacing: .3em; }
.nf-hud .warn.blink { animation: nfblink .5s steps(2, start) infinite; }
@keyframes nfblink { to { visibility: hidden; } }
.nf-hud .center { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; }
.nf-hud .big { font-size: 54px; letter-spacing: .35em; color: #ff6be6; text-shadow: 0 0 14px #ff2bd6, 0 0 40px #ff2bd6; }
.nf-hud .sub { margin-top: 12px; font-size: 15px; opacity: .85; }
.nf-hud .card { position: absolute; top: 64px; left: 28px; padding: 18px 24px; border: 1.5px solid rgba(34,243,255,.55);
  border-radius: 10px; background: rgba(7,2,15,.55); backdrop-filter: blur(3px); box-shadow: 0 0 24px rgba(34,243,255,.25); max-width: 430px; font-size: 14px;
  transition: opacity .8s; text-transform: none; letter-spacing: .03em; font-weight: 500; }
.nf-hud .card h1 { margin: 0 0 12px; font-size: 22px; letter-spacing: .4em; text-transform: uppercase; color: #fff; }
.nf-hud .card table { border-collapse: collapse; }
.nf-hud .card td { padding: 4px 10px; } .nf-hud .card td:first-child { color: #ffd27a; text-align: right; text-shadow: 0 0 6px #ff9a40; }
.nf-hud .card p { margin: 12px 0 0; font-size: 12px; opacity: .8; }
.nf-hud .hint { position: absolute; top: 18px; right: 22px; font-size: 12px; opacity: .8; letter-spacing: .12em; }
.nf-hud .dev { position: absolute; top: 18px; left: 22px; font-size: 12px; opacity: .7; letter-spacing: .12em; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

class Side {
  readonly fill: HTMLElement;
  readonly tick: HTMLElement;
  readonly dot: HTMLElement;
  constructor(parent: HTMLElement, cls: 'l' | 'r', label: string) {
    const side = el('div', `side ${cls}`, parent);
    const s1 = el('div', 'stack', side);
    const bar = el('div', 'bar', s1);
    this.fill = el('div', 'fill', bar);
    this.tick = el('div', 'tick', bar);
    el('div', 'lab', s1, `${label} eng`);
    const s2 = el('div', 'stack', side);
    const elev = el('div', 'elev', s2);
    this.dot = el('div', 'dot', elev);
    el('div', 'lab', s2, `${label} wing`);
  }
  set(thrust: number, trigger: number, elevon: number): void {
    this.fill.style.height = `${(Math.max(0, Math.min(1, thrust)) * 144).toFixed(1)}px`;
    this.tick.style.bottom = `${(Math.max(0, Math.min(1, trigger)) * 144 + 1).toFixed(1)}px`;
    // trailing edge up (stick back) shows the dot low, like the stick itself
    this.dot.style.top = `${((1 + Math.max(-1, Math.min(1, elevon))) * 35).toFixed(1)}px`;
  }
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly spd: HTMLElement;
  private readonly alt: HTMLElement;
  private readonly g: HTMLElement;
  private readonly hdg: HTMLElement;
  private readonly sides: [Side, Side];
  private readonly fpm: HTMLElement;
  private readonly warn: HTMLElement;
  private readonly center: HTMLElement;
  private readonly card: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly dev: HTMLElement;
  private readonly v = new THREE.Vector3();
  private last: Record<string, string> = {};
  private cardTimer = 0;
  private flashText = '';
  private flashLeft = 0;
  private cardGone = false;

  constructor(parent: HTMLElement) {
    if (!document.getElementById('nf-hud-css')) {
      const st = document.createElement('style');
      st.id = 'nf-hud-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = el('div', 'nf-hud', parent);
    this.hdg = el('div', 'hdg', this.root);
    const row = el('div', 'row', this.root);
    const read = (label: string) => {
      const r = el('div', 'read', row);
      const b = el('b', '', r);
      el('i', '', r, label);
      return b;
    };
    this.spd = read('km/h');
    this.alt = read('alt m');
    this.g = read('g');
    this.sides = [new Side(this.root, 'l', 'L'), new Side(this.root, 'r', 'R')];
    this.fpm = el('div', 'fpm', this.root, `<svg viewBox="-17 -17 34 34" width="34" height="34" fill="none" stroke="#bff9ff" stroke-width="2"
      style="filter: drop-shadow(0 0 4px #22f3ff)"><circle r="6"/><path d="M-16 0H-6M6 0H16M0 -6V-13"/></svg>`);
    this.warn = el('div', 'warn', this.root);
    this.center = el('div', 'center', this.root);
    this.card = el(
      'div',
      'card',
      this.root,
      `<h1>Neon&#8209;Flight</h1>
      <table>
        <tr><td>left stick &#8597;</td><td>left wing</td></tr>
        <tr><td>right stick &#8597;</td><td>right wing</td></tr>
        <tr><td>LT / RT</td><td>left / right engine</td></tr>
        <tr><td>both back / forward</td><td>nose up / down</td></tr>
        <tr><td>one back, one forward</td><td>roll</td></tr>
        <tr><td>START</td><td>pause</td></tr>
      </table>
      <p>Centred sticks keep flying where the nose points. Bank to turn, pull to tighten.<br>
      Keyboard: W/S and &#8593;/&#8595; for the wings, Left/Right Shift for the engines.</p>`,
    );
    this.hint = el('div', 'hint', this.root);
    this.dev = el('div', 'dev', this.root);
  }

  /** A short notice in the top-right corner for a few seconds. */
  flash(text: string, seconds = 4): void {
    this.flashText = text;
    this.flashLeft = seconds;
  }

  private text(e: HTMLElement, key: string, s: string): void {
    if (this.last[key] === s) return;
    this.last[key] = s;
    e.textContent = s;
  }

  private html(e: HTMLElement, key: string, s: string): void {
    if (this.last[key] === s) return;
    this.last[key] = s;
    e.innerHTML = s;
  }

  update(s: FlightState, c: ControlFrame, camera: THREE.Camera, dt: number, opts: { paused: boolean; respawnIn: number; soundLocked: boolean }): void {
    this.text(this.spd, 'spd', Math.round(s.airspeed * 3.6).toString());
    this.text(this.alt, 'alt', Math.round(s.altitude).toString());
    this.text(this.g, 'g', (Math.abs(s.g) < 0.05 ? 0 : s.g).toFixed(1));
    const hdg = Math.round(((s.headingDeg % 360) + 360) % 360) % 360;
    const card = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(hdg / 45) % 8];
    this.text(this.hdg, 'hdg', `${card.padEnd(2, ' ')} ${hdg.toString().padStart(3, '0')}°`);
    this.sides[0].set(s.thrust[0] / 11000, c.engineLeft, s.elevons[0]);
    this.sides[1].set(s.thrust[1] / 11000, c.engineRight, s.elevons[1]);

    // flight-path marker: where the velocity vector meets the screen
    const show = !s.crashed && s.speed > 20;
    if (show) {
      this.v.copy(s.velocity).normalize().multiplyScalar(2000).add(s.position).project(camera);
      const vis = this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1;
      this.fpm.style.display = vis ? 'block' : 'none';
      if (vis) {
        this.fpm.style.left = `${((this.v.x + 1) * 50).toFixed(2)}%`;
        this.fpm.style.top = `${((1 - this.v.y) * 50).toFixed(2)}%`;
      }
    } else this.fpm.style.display = 'none';

    // warnings: about to hit the ground, or at the wing's lift limit
    let warn = '';
    if (!s.crashed && !opts.paused) {
      const sink = -s.climb;
      if (sink > 5 && s.agl / sink < 4.5) warn = 'pull up';
      else if (s.limiting) warn = 'max lift';
    }
    this.text(this.warn, 'warn', warn);
    this.warn.classList.toggle('blink', warn === 'pull up');

    if (opts.paused) this.html(this.center, 'center', `<div class="big">paused</div><div class="sub">start / esc to fly</div>`);
    else if (s.crashed) this.html(this.center, 'center', `<div class="big">crashed</div><div class="sub">new flight in ${Math.max(1, Math.ceil(opts.respawnIn))}</div>`);
    else this.html(this.center, 'center', '');

    // the controls card: shown at the start until the pilot has been flying for a while (real time, crashes included)
    if (!this.cardGone) {
      if (c.active || this.cardTimer > 0 || s.time > 2) this.cardTimer += dt;
      if (this.cardTimer > 9) {
        this.cardGone = true;
        this.card.style.opacity = '0';
      }
    }

    const dev =
      c.device === 'gamepad' ? (c.padName ?? 'gamepad') : c.device === 'keyboard' ? 'keyboard' : 'no controller: press a button on the pad';
    this.text(this.dev, 'dev', dev);
    this.flashLeft = Math.max(0, this.flashLeft - dt);
    this.text(this.hint, 'hint', this.flashLeft > 0 ? this.flashText : opts.soundLocked ? 'click or press a key for sound' : '');
  }
}

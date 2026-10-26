/**
 * A small neon menu card (pause, run results): a title, an optional body, a list of choices.
 *
 * Gamepad: D-pad up / down to move, A to pick, B to go back (when the menu has a back choice); each choice can also have a
 * shortcut button shown beside it (X). Keyboard: the arrow keys, Enter, Escape / Backspace, R. Mouse: click a choice.
 * Flight controls are not read while a menu is open.
 */
import type { ControlFrame } from '../input/controls';

export interface MenuChoice {
  id: string;
  label: string;
  /** Shown at the right of the row, e.g. the gamepad button that picks it directly. */
  key?: string;
}

export interface MenuSpec {
  title: string;
  /** HTML under the title (scores and the like). */
  body?: string;
  choices: MenuChoice[];
  /** The choice B / Escape picks (none: they do nothing). */
  back?: string;
  /** The choice X / R picks directly. */
  retry?: string;
}

const CSS = `
.nf-menu { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; pointer-events: none; }
.nf-menu.open { display: flex; }
.nf-menu .box { pointer-events: auto; min-width: 360px; max-width: 520px; padding: 22px 26px 18px; border: 1.5px solid rgba(34,243,255,.6);
  border-radius: 12px; background: rgba(7,2,15,.72); backdrop-filter: blur(4px); box-shadow: 0 0 30px rgba(34,243,255,.28);
  color: #bff9ff; font: 600 15px/1.35 ui-monospace, 'Cascadia Mono', Consolas, monospace; letter-spacing: .06em;
  text-shadow: 0 0 6px rgba(34,243,255,.6); }
.nf-menu h2 { margin: 0 0 12px; font-size: 24px; letter-spacing: .35em; text-transform: uppercase; color: #fff; }
.nf-menu .body { margin: 0 0 14px; font-weight: 500; letter-spacing: .03em; }
.nf-menu .body table { border-collapse: collapse; width: 100%; }
.nf-menu .body td { padding: 2px 0; } .nf-menu .body td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.nf-menu .body .total td { padding-top: 8px; font-size: 20px; color: #ffd27a; text-shadow: 0 0 8px #ff9a40; }
.nf-menu .body .note { margin-top: 8px; font-size: 12px; opacity: .75; }
.nf-menu ul { list-style: none; margin: 0; padding: 0; }
.nf-menu li { display: flex; justify-content: space-between; padding: 8px 12px; margin: 3px 0; border-radius: 6px; cursor: pointer;
  text-transform: uppercase; letter-spacing: .14em; }
.nf-menu li .k { opacity: .6; font-size: 12px; }
.nf-menu li.sel { background: rgba(255,43,214,.16); color: #fff; box-shadow: inset 0 0 0 1.5px rgba(255,107,230,.8), 0 0 14px rgba(255,43,214,.35);
  text-shadow: 0 0 8px #ff2bd6; }
.nf-menu .help { margin-top: 10px; font-size: 11px; opacity: .55; letter-spacing: .12em; text-transform: uppercase; }
`;

export class Menu {
  private readonly root: HTMLElement;
  private readonly box: HTMLElement;
  private spec: MenuSpec | null = null;
  private sel = 0;
  private picked: string | null = null;

  constructor(parent: HTMLElement) {
    if (!document.getElementById('nf-menu-css')) {
      const st = document.createElement('style');
      st.id = 'nf-menu-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.root = document.createElement('div');
    this.root.className = 'nf-menu';
    this.box = document.createElement('div');
    this.box.className = 'box';
    this.root.appendChild(this.box);
    parent.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.spec !== null;
  }

  /** The id of the menu's first choice, to tell menus apart. */
  get title(): string | null {
    return this.spec?.title ?? null;
  }

  open(spec: MenuSpec): void {
    this.spec = spec;
    this.sel = 0;
    this.picked = null;
    this.render();
    this.root.classList.add('open');
  }

  close(): void {
    this.spec = null;
    this.root.classList.remove('open');
  }

  /** Reads this frame's navigation; returns the choice picked this frame, if any. */
  handle(nav: ControlFrame['nav']): string | null {
    const spec = this.spec;
    if (!spec) return null;
    if (this.picked) {
      const p = this.picked;
      this.picked = null;
      return p;
    }
    const n = spec.choices.length;
    if (nav.up) this.select((this.sel - 1 + n) % n);
    if (nav.down) this.select((this.sel + 1) % n);
    if (nav.confirm) return spec.choices[this.sel]?.id ?? null;
    if (nav.back && spec.back) return spec.back;
    if (nav.retry && spec.retry) return spec.retry;
    return null;
  }

  private select(i: number): void {
    this.sel = i;
    this.box.querySelectorAll('li').forEach((li, k) => li.classList.toggle('sel', k === i));
  }

  private render(): void {
    const spec = this.spec;
    if (!spec) return;
    this.box.innerHTML = '';
    const h = document.createElement('h2');
    h.textContent = spec.title;
    this.box.appendChild(h);
    if (spec.body) {
      const b = document.createElement('div');
      b.className = 'body';
      b.innerHTML = spec.body;
      this.box.appendChild(b);
    }
    const ul = document.createElement('ul');
    spec.choices.forEach((c, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span></span><span class="k"></span>`;
      (li.firstChild as HTMLElement).textContent = c.label;
      (li.lastChild as HTMLElement).textContent = c.key ?? '';
      if (i === this.sel) li.classList.add('sel');
      li.addEventListener('mouseenter', () => this.select(i));
      li.addEventListener('click', () => (this.picked = c.id));
      ul.appendChild(li);
    });
    this.box.appendChild(ul);
    const help = document.createElement('div');
    help.className = 'help';
    help.textContent = 'd-pad / arrows to choose, A / enter to pick';
    this.box.appendChild(help);
  }
}

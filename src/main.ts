import { Game } from './game';
import { groundAt } from './world/terrain';
import { TerrainView } from './render/terrain';
import { SkyView, SUN_DIRECTION } from './render/sky';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

const game = new Game(canvas, ui, { ground: groundAt, views: [new SkyView(), new TerrainView()], sunDirection: SUN_DIRECTION });
game.boot().catch((err: unknown) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:24px;color:#ff2bd6;font:14px/1.5 monospace;white-space:pre-wrap;z-index:99';
  pre.textContent = `Neon-Flight failed to start:\n\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  document.body.appendChild(pre);
});

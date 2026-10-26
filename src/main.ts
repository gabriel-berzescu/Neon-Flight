import { Game } from './game';
import { baseHeightAt, groundAt, setActiveCanyon } from './world/terrain';
import { buildCanyonField } from './world/canyon-field';
import { TerrainView } from './render/terrain';
import { SkyView, SUN_DIRECTION } from './render/sky';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

const terrain = new TerrainView();
const game = new Game(canvas, ui, {
  ground: groundAt,
  baseGround: baseHeightAt,
  views: [new SkyView(), terrain],
  sunDirection: SUN_DIRECTION,
  // a canyon run carves its canyon into both the physics' ground and the rendered terrain
  setCanyon: (canyon) => {
    const field = canyon ? buildCanyonField(canyon) : null;
    setActiveCanyon(field);
    terrain.setCanyon(field);
  },
});
game.boot().catch((err: unknown) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:24px;color:#ff2bd6;font:14px/1.5 monospace;white-space:pre-wrap;z-index:99';
  pre.textContent = `Neon-Flight failed to start:\n\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  document.body.appendChild(pre);
});

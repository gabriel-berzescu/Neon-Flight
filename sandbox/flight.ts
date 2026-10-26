// Flight sandbox: the game on a stand-in world (gentle sine hills drawn as a grid that follows the camera), for testing the
// aircraft, camera, HUD and controls without the real terrain.
import * as THREE from 'three';
import { Game, type World, type WorldView } from '../src/game';

const ground = (x: number, z: number) => 40 + 30 * Math.sin(x / 700) * Math.cos(z / 900);

class GridWorld implements WorldView {
  readonly object = new THREE.Group();
  private readonly grid: THREE.LineSegments;
  constructor() {
    const pts: number[] = [];
    const N = 120, step = 50;
    for (let i = -N; i <= N; i++) {
      for (let j = -N; j < N; j++) {
        pts.push(i * step, 0, j * step, i * step, 0, (j + 1) * step);
        pts.push(j * step, 0, i * step, (j + 1) * step, 0, i * step);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(0x22f3ff).multiplyScalar(1.4) }));
    this.object.add(this.grid);
    this.object.frustumCulled = false;
    this.grid.frustumCulled = false;
  }
  update(camera: THREE.PerspectiveCamera): void {
    const step = 50;
    const ox = Math.round(camera.position.x / step) * step, oz = Math.round(camera.position.z / step) * step;
    this.object.position.set(ox, 0, oz);
    const p = (this.grid.geometry.attributes.position as THREE.BufferAttribute);
    const a = p.array as Float32Array;
    for (let i = 0; i < a.length; i += 3) a[i + 1] = ground(a[i] + ox, a[i + 2] + oz);
    p.needsUpdate = true;
  }
}

const world: World = { ground, views: [new GridWorld()], sunDirection: new THREE.Vector3(0, 0.08, -1).normalize() };
const game = new Game(document.getElementById('game') as HTMLCanvasElement, document.getElementById('ui') as HTMLElement, world);
game.stage.scene.fog = new THREE.Fog(0x2a0b45, 500, 6000);
game.boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:20px;color:#f6c">${String(e?.stack ?? e)}</pre>`);
});

#!/usr/bin/env node
/**
 * One-click launcher: builds the game if needed, serves it locally, and opens it in a dedicated
 * Chrome app window on the high-performance GPU (its own profile, so the flags always apply).
 * Closing the window stops the server.
 *
 *   node scripts/play.mjs            build if dist/ is missing or stale, then play
 *   node scripts/play.mjs --build    force a fresh build
 *   node scripts/play.mjs --dev      play from the dev server (hot reload)
 *   node scripts/play.mjs --window   windowed instead of fullscreen
 *   node scripts/play.mjs --serve    only build + serve (open the printed URL in any browser)
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev');
const port = dev ? 5240 : 5241;
const url = `http://127.0.0.1:${port}/`;

function newestMtime(dir) {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return t;
}

// run Vite's CLI with this Node directly (no shell, no npx)
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

if (!dev) {
  const distIndex = join(root, 'dist', 'index.html');
  const built = existsSync(distIndex) ? statSync(distIndex).mtimeMs : 0;
  const stale = !built || newestMtime(join(root, 'src')) > built || newestMtime(join(root, 'public')) > built || statSync(join(root, 'index.html')).mtimeMs > built;
  if (stale || args.has('--build')) {
    console.log('Building Neon-Flight…');
    const r = spawnSync(process.execPath, [vite, 'build'], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

async function up() {
  try {
    const r = await fetch(url);
    return r.ok;
  } catch {
    return false;
  }
}

let server = null;
if (!(await up())) {
  server = spawn(process.execPath, [vite, dev ? '' : 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'].filter(Boolean), { cwd: root, stdio: 'ignore' });
  for (let i = 0; i < 100 && !(await up()); i++) await new Promise((r) => setTimeout(r, 150));
}

if (args.has('--serve')) {
  console.log(`Neon-Flight is being served at ${url} — press Ctrl+C to stop.`);
  await new Promise(() => {});
}

const candidates = [
  join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
];
const browser = candidates.find((p) => existsSync(p));
if (!browser) {
  console.log(`No Chrome/Edge found — open ${url} yourself.`);
  process.exit(0);
}
const profile = join(process.env['LOCALAPPDATA'] ?? root, 'NeonFlight', 'browser-profile');
// A brand-new Chrome profile checks once whether the Windows password is blank, by trying to sign in with an empty one (a failed
// sign-in that counts towards the account's lockout). Seed the new profile from the template where that check already ran
// (.cache/chrome-profile/template, see scripts/chrome.mjs), so even the first launch costs nothing.
if (!existsSync(join(profile, 'Local State'))) {
  const template = join(root, '.cache', 'chrome-profile', 'template');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  for (const f of ['Local State', join('Default', 'Preferences')]) if (existsSync(join(template, f))) copyFileSync(join(template, f), join(profile, f));
}
mkdirSync(profile, { recursive: true });
const flags = [
  `--app=${url}`,
  `--user-data-dir=${profile}`,
  '--force_high_performance_gpu',
  '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-features=CalculateNativeWinOcclusion',
  '--no-first-run',
  '--no-default-browser-check',
  args.has('--window') ? '--window-size=1600,900' : '--start-fullscreen',
];
console.log('Starting Neon-Flight — close the window to quit.');
const chrome = spawn(browser, flags, { stdio: 'ignore' });
chrome.on('exit', () => {
  if (server) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    else server.kill();
  }
  process.exit(0);
});

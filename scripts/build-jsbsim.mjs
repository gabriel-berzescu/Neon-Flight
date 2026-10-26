#!/usr/bin/env node
/**
 * Builds JSBSim (the flight dynamics engine) and native/jsbsim-bridge.cpp into one WebAssembly module:
 *   src/fdm/wasm/jsbsim.mjs + jsbsim.wasm   (committed: the game and CI never need a C++ toolchain)
 *   src/fdm/wasm/BUILD.json                  (what went in: JSBSim tag, bridge hash, compiler version, flags)
 *
 * Needs the Emscripten SDK. Looks in $EMSDK, then ~/emsdk. Install it once with:
 *   git clone https://github.com/emscripten-core/emsdk ~/emsdk && cd ~/emsdk && py emsdk.py install latest && py emsdk.py activate latest
 *
 * JSBSim's source is fetched at the pinned tag into .cache/jsbsim-src (git-ignored). Objects are cached in .cache/jsbsim-obj and
 * rebuilt only when a source is newer, so a bridge change relinks in seconds.
 *
 *   node scripts/build-jsbsim.mjs            build (incremental)
 *   node scripts/build-jsbsim.mjs --clean    rebuild every object
 *
 * JSBSim is LGPL-2.1: its source is the official repository at JSBSIM_TAG, unmodified; this script is how to rebuild the module.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const JSBSIM_TAG = 'v1.3.3';
const JSBSIM_REPO = 'https://github.com/JSBSim-Team/jsbsim.git';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, '.cache', 'jsbsim-src');
const OBJ = join(ROOT, '.cache', 'jsbsim-obj');
const OUT = join(ROOT, 'src', 'fdm', 'wasm');
const BRIDGE = join(ROOT, 'native', 'jsbsim-bridge.cpp');

const COMPILE_FLAGS = ['-O3', '-fwasm-exceptions', `-I${join(SRC, 'src')}`, `-DJSBSIM_VERSION="${JSBSIM_TAG.slice(1)}"`];
const CXX_FLAGS = ['-std=c++17'];
const LINK_FLAGS = [
  '-O3',
  '-fwasm-exceptions',
  '-lembind',
  '-sMODULARIZE=1',
  '-sEXPORT_ES6=1',
  '-sEXPORT_NAME=createJSBSim',
  '-sENVIRONMENT=web,node',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sINITIAL_MEMORY=33554432',
  '-sSTACK_SIZE=1048576',
  '-sFILESYSTEM=1',
  '-sFORCE_FILESYSTEM=1',
  '-sEXPORTED_RUNTIME_METHODS=FS',
];

/**
 * Sources of the library: the files JSBSim's own CMake build compiles (named in the CMakeLists.txt of their folder: the tree also
 * holds dead code that no longer builds), minus the command-line programs and the expat files that are #included, not compiled.
 */
function librarySources() {
  const skip = new Set(['JSBSim.cpp', 'JSBSim.minimal.cpp', 'nrlmsise-00_test.c', 'xmltok_impl.c', 'xmltok_ns.c']);
  const out = [];
  const walk = (dir) => {
    const cmake = existsSync(join(dir, 'CMakeLists.txt')) ? readFileSync(join(dir, 'CMakeLists.txt'), 'utf8') : '';
    const listed = (name) => new RegExp(`(^|[\\s(/])${name.replace(/[.+]/g, '\\$&')}($|[\\s)])`, 'm').test(cmake);
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(cpp|cxx|c)$/.test(name) && !skip.has(name) && listed(name)) out.push(p);
    }
  };
  walk(join(SRC, 'src'));
  return out.sort();
}

function emsdkRoot() {
  for (const c of [process.env.EMSDK, join(homedir(), 'emsdk')]) if (c && existsSync(join(c, 'upstream', 'emscripten'))) return c;
  throw new Error('Emscripten SDK not found: set EMSDK or install it in ~/emsdk (see the header of this script).');
}

function toolEnv(emsdk) {
  const env = { ...process.env, EMSDK: emsdk, EM_CONFIG: join(emsdk, '.emscripten') };
  const py = join(emsdk, 'python');
  if (existsSync(py)) {
    const v = readdirSync(py).find((d) => existsSync(join(py, d, 'python.exe')));
    if (v) env.EMSDK_PYTHON = join(py, v, 'python.exe');
  }
  return env;
}

function tool(emsdk, name) {
  const base = join(emsdk, 'upstream', 'emscripten', name);
  return existsSync(base + '.exe') ? base + '.exe' : base;
}

function run(cmd, args, env) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(`${relative(ROOT, args.at(-1) ?? '')} (exit ${code}):\n${out}`))));
  });
}

async function pool(jobs, width) {
  let next = 0;
  const workers = Array.from({ length: width }, async () => {
    while (next < jobs.length) await jobs[next++]();
  });
  await Promise.all(workers);
}

function fetchSource() {
  if (existsSync(join(SRC, 'src', 'FGFDMExec.cpp'))) return;
  console.log(`Fetching JSBSim ${JSBSIM_TAG} ...`);
  mkdirSync(dirname(SRC), { recursive: true });
  const r = spawnSync('git', ['clone', '--depth', '1', '--branch', JSBSIM_TAG, JSBSIM_REPO, SRC], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('git clone of JSBSim failed');
}

async function main() {
  const clean = process.argv.includes('--clean');
  fetchSource();
  const emsdk = emsdkRoot();
  const env = toolEnv(emsdk);
  const emcc = tool(emsdk, 'emcc');
  const empp = tool(emsdk, 'em++');
  if (clean) rmSync(OBJ, { recursive: true, force: true });
  mkdirSync(OBJ, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const sources = [...librarySources(), BRIDGE];
  const objects = [];
  const jobs = [];
  for (const src of sources) {
    const rel = src === BRIDGE ? 'bridge/jsbsim-bridge.cpp' : relative(join(SRC, 'src'), src);
    const obj = join(OBJ, rel.replace(/[\\/]/g, '__') + '.o');
    objects.push(obj);
    if (existsSync(obj) && statSync(obj).mtimeMs >= statSync(src).mtimeMs) continue;
    const isC = src.endsWith('.c');
    const args = [...COMPILE_FLAGS, ...(isC ? [] : CXX_FLAGS), '-c', '-o', obj, src];
    jobs.push(async () => {
      await run(isC ? emcc : empp, args, env);
      process.stdout.write('.');
    });
  }
  const t0 = Date.now();
  if (jobs.length) {
    console.log(`Compiling ${jobs.length} of ${sources.length} sources with Emscripten`);
    await pool(jobs, Math.max(2, cpus().length - 1));
    console.log(`\ncompiled in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  const out = join(OUT, 'jsbsim.mjs');
  const t1 = Date.now();
  await run(empp, [...LINK_FLAGS, ...objects, '-o', out], env);
  const version = spawnSync(empp, ['--version'], { env, encoding: 'utf8' }).stdout.split('\n')[0].trim();
  const wasmBytes = statSync(join(OUT, 'jsbsim.wasm')).size;
  writeFileSync(
    join(OUT, 'BUILD.json'),
    JSON.stringify(
      {
        jsbsim: { repo: JSBSIM_REPO, tag: JSBSIM_TAG },
        bridgeSha256: createHash('sha256').update(readFileSync(BRIDGE)).digest('hex'),
        emscripten: version,
        compileFlags: COMPILE_FLAGS.filter((f) => !f.startsWith('-I')),
        linkFlags: LINK_FLAGS,
        wasmBytes,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`linked in ${((Date.now() - t1) / 1000).toFixed(1)} s -> ${relative(ROOT, out)} (+ jsbsim.wasm, ${(wasmBytes / 1e6).toFixed(2)} MB)`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});

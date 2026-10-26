/**
 * The terrain shaders. TERRAIN_HEIGHT_GLSL is the GLSL twin of heightAt() in src/world/terrain.ts: the same integer hash, the same
 * noise, the same formulas and parameters (they are pasted in from there), evaluated in float32 relative to a camera-snapped
 * origin so it stays precise 300 km from the world origin. It also returns the gradient (dual numbers: vec3(value, d/dx, d/dz))
 * for the shading normals. Keep it in step with heightAt(): sandbox/terrain-check.html compares the two.
 * CANYON_GLSL is the twin of the canyon carve (src/world/canyon-field.ts): canyonApply(terrainHD(p, cam), p) is the canyon run's
 * terrain; the vertex shader carves the mesh with it, the fragment shader again per pixel for the shading.
 */
import {
  HRIDGE_NORM, OCTAVES, RIDGE_NORM, SLOT, TERRAIN_FADE_END, TERRAIN_FADE_START, TERRAIN_SLOT_COUNT, TERRAIN_SLOT_LAMBDA, TERRAIN_SLOT_M, TP,
} from '../world/terrain';
import { CANYON_STEP } from '../world/canyon';
import { CF } from '../world/canyon-field';
import { SKY_COMMON_GLSL } from './skyGlsl';

/** Grid cells per clipmap level side (vertices = cells + 1). Multiple of 4. */
export const TERRAIN_CELLS = 224;
/** A level morphs into the next coarser one over this many of its cells, ending 2.5 cells inside its outer rim. */
export const TERRAIN_MORPH_CELLS = 24;
/** Number of clipmap levels; level k has cells of 2 * 2^k metres. */
export const TERRAIN_LEVELS = 9;
/** The terrain's height band (m) for frustum culling: centre and half height. heightAt() stays inside [-1100, 3900] (it reaches about [-600, 3000]). */
export const CULL_YMID = 1400;
export const CULL_HY = 2500;
/** Clipmap levels with cells at least this big (m) shade a canyon run per pixel; the finer ones carve their vertex normals. */
export const CANYON_PIXEL_CELL = 4;
/** Terrain fog: fully fogged well before the far edge of the mesh. */
export const TERRAIN_FOG_DISTANCE = 21000;
/**
 * The grid lines sit at multiples of 10/50/200/1000/5000 m from this point (m), not from the world origin: the player spawns at
 * the origin, and a 5 km line right under the spawn, in the middle of the screen, would look like a mistake.
 */
export const TERRAIN_GRID_SHIFT = { x: 1275, z: 640 };

/** A float literal for GLSL. */
function fl(v: number): string {
  if (Number.isInteger(v)) return `${v}.0`;
  const s = v.toPrecision(9);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

function slotTables(): string {
  const m: string[] = [];
  const lam: string[] = [];
  for (let s = 0; s < TERRAIN_SLOT_COUNT; s++) {
    m.push(`vec4(${[0, 1, 2, 3].map((k) => fl(TERRAIN_SLOT_M[s * 4 + k])).join(', ')})`);
    lam.push(fl(TERRAIN_SLOT_LAMBDA[s]));
  }
  return `const vec4 SLOT_M[${TERRAIN_SLOT_COUNT}] = vec4[${TERRAIN_SLOT_COUNT}](\n  ${m.join(',\n  ')}\n);
const float SLOT_LAMBDA[${TERRAIN_SLOT_COUNT}] = float[${TERRAIN_SLOT_COUNT}](${lam.join(', ')});`;
}

const P = TP;

export const TERRAIN_HEIGHT_GLSL = /* glsl */ `
#define NSLOT ${TERRAIN_SLOT_COUNT}
// per slot: (lattice cell x, cell z, fraction x, fraction z) of the origin, float64 on the CPU (terrainLattice)
uniform vec4 uSlot[NSLOT];
${slotTables()}

#define S_WARP ${SLOT.warp}
#define S_CONT ${SLOT.cont}
#define S_MASKM ${SLOT.maskM}
#define S_MASKH ${SLOT.maskH}
#define S_RIDGE ${SLOT.ridge}
#define S_HRIDGE ${SLOT.hillRidge}
#define S_HILL ${SLOT.hill}
#define S_DETAIL ${SLOT.detail}
#define S_CANYON ${SLOT.canyon}
#define S_CMASK ${SLOT.canyonMask}
#define S_VALLEY ${SLOT.valley}
#define S_VMASK ${SLOT.valleyMask}
#define S_COAST ${SLOT.coast}
#define N_RIDGE ${OCTAVES.ridge}
#define N_HRIDGE ${OCTAVES.hillRidge}
#define N_HILL ${OCTAVES.hill}
#define N_DETAIL ${OCTAVES.detail}
#define FADE_START ${fl(TERRAIN_FADE_START)}
#define FADE_END ${fl(TERRAIN_FADE_END)}

const float WARP = ${fl(P.warp)};
const float COAST_AMP = ${fl(P.coastAmp)};
const float COAST_DECAY = ${fl(P.coastDecay)};
const float CONT_SCALE = ${fl(P.contScale)};
const float CONT_T = ${fl(P.contT)};
const float SEA_CUT = ${fl(P.seaCut)};
const float LAND_LO = ${fl(P.landLo)};
const float LAND_HI = ${fl(P.landHi)};
const float BELT_W = ${fl(P.beltW)};
const float SEG_LO = ${fl(P.segLo)};
const float SEG_HI = ${fl(P.segHi)};
const float HILL_LO = ${fl(P.hillLo)};
const float HILL_HI = ${fl(P.hillHi)};
const float MTN_BASE = ${fl(P.mtnBase)};
const float MTN_AMP = ${fl(P.mtnAmp)};
const float RIDGE_GAIN = ${fl(P.ridgeGain)};
const float RIDGE_DECAY = ${fl(P.ridgeDecay)};
const float RIDGE_EPS = ${fl(P.ridgeEps)};
const float RIDGE_EPS_GROW = ${fl(P.ridgeEpsGrow)};
const float RIDGE_NORM = ${fl(RIDGE_NORM)};
const float HILL_AMP = ${fl(P.hillAmp)};
const float HILL_DECAY = ${fl(P.hillDecay)};
const float HR_AMP = ${fl(P.hillRidgeAmp)};
const float HR_GAIN = ${fl(P.hillRidgeGain)};
const float HR_DECAY = ${fl(P.hillRidgeDecay)};
const float HR_EPS = ${fl(P.hillRidgeEps)};
const float HR_EPS_GROW = ${fl(P.hillRidgeEpsGrow)};
const float HRIDGE_NORM = ${fl(HRIDGE_NORM)};
const float DETAIL_AMP = ${fl(P.detailAmp)};
const float DETAIL_DECAY = ${fl(P.detailDecay)};
const float VALLEY_LO = ${fl(P.valleyLo)};
const float VALLEY_HI = ${fl(P.valleyHi)};
const float VALLEY_W0 = ${fl(P.valleyW0)};
const float VALLEY_W1 = ${fl(P.valleyW1)};
const float VALLEY_PULL = ${fl(P.valleyPull)};
const float VALLEY_FLOOR = ${fl(P.valleyFloor)};
const float CANYON_LO = ${fl(P.canyonLo)};
const float CANYON_HI = ${fl(P.canyonHi)};
const float CANYON_W0 = ${fl(P.canyonW0)};
const float CANYON_W1 = ${fl(P.canyonW1)};
const float CANYON_DEPTH = ${fl(P.canyonDepth)};
const float CANYON_GMIN = ${fl(P.canyonGradMin)};
const float GRAD_SCALE = ${fl(1 / 32767.5)};

// The integer hash of a lattice cell: identical to ihash() in terrain.ts (uint arithmetic wraps mod 2^32, like Math.imul).
uint ihash(ivec2 c) {
  uint h = uint(c.x) * 0x27d4eb2du ^ uint(c.y) * 0x165667b1u ^ 0x9e3779b9u;
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}
vec2 gdec(uint h) {
  return vec2(float(h & 0xffffu), float(h >> 16u)) * GRAD_SCALE - 1.0;
}

// Gradient noise of slot s at the local position p (metres from the origin): vec3(value, d/dpx, d/dpz).
vec3 nzd(int s, vec2 p) {
  vec4 L = uSlot[s];
  vec4 m = SLOT_M[s];
  vec2 q = vec2(m.x * p.x + m.y * p.y, m.z * p.x + m.w * p.y) + L.zw;
  vec2 fq = floor(q);
  vec2 f = q - fq;
  ivec2 c = ivec2(L.xy) + ivec2(fq);
  vec2 g00 = gdec(ihash(c));
  vec2 g10 = gdec(ihash(c + ivec2(1, 0)));
  vec2 g01 = gdec(ihash(c + ivec2(0, 1)));
  vec2 g11 = gdec(ihash(c + ivec2(1, 1)));
  vec2 f1 = f - 1.0;
  float a = g00.x * f.x + g00.y * f.y;
  float b = g10.x * f1.x + g10.y * f.y;
  float cc = g01.x * f.x + g01.y * f1.y;
  float d = g11.x * f1.x + g11.y * f1.y;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float k = a - b - cc + d;
  vec2 dq = g00 + u.x * (g10 - g00) + u.y * (g01 - g00) + u.x * u.y * (g00 - g10 - g01 + g11)
          + du * vec2(u.y * k + b - a, u.x * k + cc - a);
  return vec3(a + u.x * (b - a) + u.y * (cc - a) + u.x * u.y * k, m.x * dq.x + m.z * dq.y, m.y * dq.x + m.w * dq.y);
}

// dual-number helpers: vec3(value, d/dx, d/dz)
vec3 dsmooth(vec3 a, float e0, float e1) {
  float t = clamp((a.x - e0) / (e1 - e0), 0.0, 1.0);
  float s = t * t * (3.0 - 2.0 * t);
  float k = (t > 0.0 && t < 1.0) ? 6.0 * t * (1.0 - t) / (e1 - e0) : 0.0;
  return vec3(s, k * a.yz);
}
vec3 dmul(vec3 a, vec3 b) {
  return vec3(a.x * b.x, a.x * b.yz + b.x * a.yz);
}

// gradient w.r.t. the unwarped position of f(pw), given its gradient g w.r.t. pw and the warp's Jacobian J = (1+dwx/dx, dwx/dz, dwz/dx, 1+dwz/dz)
vec3 nzw(int s, vec2 pw, vec4 J) {
  vec3 n = nzd(s, pw);
  return vec3(n.x, n.y * J.x + n.z * J.z, n.y * J.y + n.z * J.w);
}

// Octaves fade out with distance from the camera, once they are too fine for the mesh there.
float octFade(int s, float dist) {
  float l = SLOT_LAMBDA[s];
  return 1.0 - smoothstep(FADE_START * l, FADE_END * l, dist);
}

// Ridged multifractal 0..1 with gradient (see ridged() in terrain.ts), octaves fading out with distance.
vec3 ridgedD(int s0, int count, float gain, float decay, float eps0, float epsGrow, float norm, vec2 pw, vec4 J, float dist) {
  vec3 sum = vec3(0.0);
  float w = 1.0;
  float amp = 1.0;
  float eps = eps0;
  for (int i = 0; i < count; i++) {
    float fw = octFade(s0 + i, dist);
    if (fw <= 0.0) break;
    vec3 n = nzw(s0 + i, pw, J);
    float s = n.x * gain;
    float rt = sqrt(s * s + eps * eps);
    float r = 1.0 - (rt - eps);
    vec2 dr = -(s / rt) * gain * n.yz;
    if (r < 0.0) {
      r = 0.0;
      dr = vec2(0.0);
    }
    float t = r * r;
    sum += (amp * w * fw) * vec3(t, 2.0 * r * dr);
    float u = min(t * 2.0, 1.0);
    w = u * u * (3.0 - 2.0 * u);
    amp *= decay;
    eps *= epsGrow;
  }
  return sum / norm;
}

// Terrain height at the local position p and its gradient: vec3(height, d/dx, d/dz). cam is the camera's local position.
vec3 terrainHD(vec2 p, vec2 cam) {
  float dist = length(p - cam);

  // domain warp
  vec3 wx = nzd(S_WARP, p) * WARP;
  vec3 wz = nzd(S_WARP + 1, p) * WARP;
  vec2 pw = p + vec2(wx.x, wz.x);
  vec4 J = vec4(1.0 + wx.y, wx.z, wz.y, 1.0 + wz.z);

  // continent -> base elevation
  vec3 c = ${fl(P.contW[0])} * nzw(S_CONT, pw, J) + ${fl(P.contW[1])} * nzw(S_CONT + 1, pw, J)
         + ${fl(P.contW[2])} * nzw(S_CONT + 2, pw, J) + ${fl(P.contW[3])} * nzw(S_CONT + 3, pw, J);
  vec3 coast = octFade(S_COAST, dist) * nzw(S_COAST, pw, J) + (COAST_DECAY * octFade(S_COAST + 1, dist)) * nzw(S_COAST + 1, pw, J)
             + (COAST_DECAY * COAST_DECAY * octFade(S_COAST + 2, dist)) * nzw(S_COAST + 2, pw, J);
  vec3 eb = vec3(CONT_SCALE * (c.x - CONT_T), CONT_SCALE * c.yz) + COAST_AMP * coast;
  if (eb.x < SEA_CUT) return eb;
  vec3 land = dsmooth(eb, LAND_LO, LAND_HI);

  // region masks
  vec3 nm0 = nzw(S_MASKM, pw, J);
  vec3 belt = vec3(1.0, 0.0, 0.0) - dsmooth(vec3(abs(nm0.x), sign(nm0.x) * nm0.yz), 0.0, BELT_W);
  vec3 mm = dmul(belt, dsmooth(nzw(S_MASKM + 1, pw, J), SEG_LO, SEG_HI));
  vec3 mh = dsmooth(0.65 * nzw(S_MASKH, pw, J) + 0.35 * nzw(S_MASKH + 1, pw, J), HILL_LO, HILL_HI);

  vec3 h = eb;

  // ridged mountains
  if (mm.x > 0.0) {
    vec3 ridge = ridgedD(S_RIDGE, N_RIDGE, RIDGE_GAIN, RIDGE_DECAY, RIDGE_EPS, RIDGE_EPS_GROW, RIDGE_NORM, pw, J, dist);
    h += dmul(dmul(land, mm), vec3(MTN_BASE, 0.0, 0.0) + MTN_AMP * ridge);
  }

  // hills
  if (mh.x > 0.0) {
    vec3 sum = vec3(0.0);
    float amp = 1.0;
    for (int i = 0; i < N_HILL; i++) {
      float fw = octFade(S_HILL + i, dist);
      if (fw <= 0.0) break;
      sum += (amp * fw) * nzw(S_HILL + i, pw, J);
      amp *= HILL_DECAY;
    }
    vec3 lmh = dmul(land, mh);
    h += HILL_AMP * dmul(lmh, sum);
    if (mm.x < 1.0) {
      vec3 hr = ridgedD(S_HRIDGE, N_HRIDGE, HR_GAIN, HR_DECAY, HR_EPS, HR_EPS_GROW, HRIDGE_NORM, pw, J, dist);
      h += HR_AMP * dmul(dmul(lmh, vec3(1.0 - mm.x, -mm.yz)), hr);
    }
  }

  // valleys
  vec3 vm = dmul(land, dsmooth(nzw(S_VMASK, pw, J), VALLEY_LO, VALLEY_HI));
  if (vm.x > 0.0) {
    vec3 nv = nzd(S_VALLEY, pw);
    float gv = sqrt(dot(nv.yz, nv.yz) + CANYON_GMIN * CANYON_GMIN);
    float dv = abs(nv.x) / gv;
    vec2 gdv = sign(nv.x) * vec2(nv.y * J.x + nv.z * J.z, nv.y * J.y + nv.z * J.w) / gv;
    vec3 prof = dsmooth(vec3(dv, gdv), VALLEY_W0, VALLEY_W1);
    vec3 pull = VALLEY_PULL * dmul(vm, vec3(1.0 - prof.x, -prof.yz));
    h -= dmul(pull, h - (eb - vec3(VALLEY_FLOOR, 0.0, 0.0)));
  }

  // canyons
  vec3 cm = dmul(dmul(land, vec3(1.0 - mm.x, -mm.yz)), dsmooth(nzw(S_CMASK, pw, J), CANYON_LO, CANYON_HI));
  if (cm.x > 0.0) {
    vec3 nc = nzd(S_CANYON, pw);
    float gc = sqrt(dot(nc.yz, nc.yz) + CANYON_GMIN * CANYON_GMIN);
    float dc = abs(nc.x) / gc;
    vec2 gdc = sign(nc.x) * vec2(nc.y * J.x + nc.z * J.z, nc.y * J.y + nc.z * J.w) / gc;
    vec3 prof = dsmooth(vec3(dc, gdc), CANYON_W0, CANYON_W1);
    h -= CANYON_DEPTH * dmul(cm, vec3(1.0 - prof.x, -prof.yz));
  }

  // fine detail (not warped)
  {
    vec3 sum = vec3(0.0);
    float amp = 1.0;
    for (int i = 0; i < N_DETAIL; i++) {
      float fw = octFade(S_DETAIL + i, dist);
      if (fw <= 0.0) break;
      sum += (amp * fw) * nzd(S_DETAIL + i, p);
      amp *= DETAIL_DECAY;
    }
    h += DETAIL_AMP * (0.35 + 0.65 * (mm.x + mh.x - mm.x * mh.x)) * dmul(land, sum);
  }
  return h;
}
`;

// ----------------------------------------------------------------------------------------------------------------------------
// The canyon run's carve: the GLSL twin of carveHeight() / CanyonField.apply() in src/world/canyon-field.ts (same float32 data,
// same bilinear order, same formulas). The field's texels are addressed like the noise lattice: the CPU gives the cell and
// fraction of the camera-snapped origin in the field's grid (float64 there), the shader adds the local offset.
// ----------------------------------------------------------------------------------------------------------------------------
export const CANYON_GLSL = /* glsl */ `
uniform float uCanyonOn;
uniform highp sampler2D uCanyonField;  // nx x nz RGBA32F: dist, s, mesa mask, mesa height
uniform highp sampler2D uCanyonSec;    // n x 1 RGBA32F: floor, rim, half, wall per centreline sample
uniform vec4 uCanyonGrid;              // origin in the field's grid: cell x, cell z, fraction x, fraction z
uniform vec4 uCanyonDim;               // nx, nz, 1 / cell size, n
uniform vec4 uCanyonBox;               // the field's extent relative to the origin: min x, min z, max x, max z
uniform float uCanyonLen;              // centreline length (m)

#define CF_STEP ${fl(CANYON_STEP)}
#define CF_SKIP ${fl(CF.skip)}
#define CF_FOOT ${fl(CF.foot)}
#define CF_RIM_ROUND ${fl(CF.rimRound)}
#define CF_KMIN ${fl(CF.kMin)}
#define CF_STEEP_START ${fl(CF.steepStart)}
#define CF_STEEP_Q ${fl(CF.steepQ)}
#define CF_MESA_K ${fl(CF.mesaK)}
#define CF_EPS ${fl(CF.gradStep)}

float cfSmin(float a, float b, float k) {
  float hh = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return b + (a - b) * hh - k * hh * (1.0 - hh);
}

// the carve for base height h, field values f = (dist, s, mask, mesa height) and section q = (floor, rim, half, wall)
// the canyon's cross-section at the field values f and section q, and the width k of its smooth minimum with the land
float canyonCut(vec4 f, vec4 q, out float k) {
  float depth = max(q.y - q.x, 0.0);
  float a = CF_FOOT * q.w;
  float slope = depth / (q.w - 0.5 * a);
  float sn = max(-f.y, 0.0);
  float sp = max(f.y - uCanyonLen, 0.0);
  float r = sqrt(f.x * f.x + sn * sn + sp * sp);
  float t = r - q.z;
  float ramp = t <= 0.0 ? 0.0 : t < a ? t * t / (2.0 * a) : t - 0.5 * a;
  float u = max(t - q.w - CF_STEEP_START, 0.0);
  k = max((slope + 2.0 * CF_STEEP_Q * u) * CF_RIM_ROUND * q.w, CF_KMIN);
  return q.x + slope * ramp + CF_STEEP_Q * u * u;
}

float canyonCarve(float h, vec4 f, vec4 q) {
  float raised = h + f.z * (-cfSmin(-h, -f.w, CF_MESA_K) - h);
  float k;
  float cut = canyonCut(f, q, k);
  return cfSmin(raised, cut, k);
}

// The field at the local position p: f = (dist, s, mask, mesa height), its derivatives fx, fz in this cell (per metre), the
// section q = (floor, rim, half, wall) at s and dq = d/ds of it. False where the carve is the identity (outside the field, or
// beyond the canyon's reach with no mesa).
bool canyonFetch(vec2 p, out vec4 f, out vec4 fx, out vec4 fz, out vec4 q, out vec4 dq) {
  if (uCanyonOn < 0.5 || p.x < uCanyonBox.x || p.y < uCanyonBox.y || p.x > uCanyonBox.z || p.y > uCanyonBox.w) return false;
  vec2 g = uCanyonGrid.zw + p * uCanyonDim.z;
  vec2 fg = floor(g);
  vec2 fr = g - fg;
  ivec2 c = ivec2(uCanyonGrid.xy) + ivec2(fg);
  ivec2 cmax = ivec2(uCanyonDim.xy) - 2;
  if (c.x > cmax.x) { fr.x += float(c.x - cmax.x); c.x = cmax.x; }
  if (c.y > cmax.y) { fr.y += float(c.y - cmax.y); c.y = cmax.y; }
  if (c.x < 0) { fr.x += float(c.x); c.x = 0; }
  if (c.y < 0) { fr.y += float(c.y); c.y = 0; }
  vec4 t00 = texelFetch(uCanyonField, c, 0);
  vec4 t10 = texelFetch(uCanyonField, c + ivec2(1, 0), 0);
  vec4 t01 = texelFetch(uCanyonField, c + ivec2(0, 1), 0);
  vec4 t11 = texelFetch(uCanyonField, c + ivec2(1, 1), 0);
  vec4 a = t00 + (t10 - t00) * fr.x;
  vec4 b = t01 + (t11 - t01) * fr.x;
  f = a + (b - a) * fr.y;
  if (f.z <= 0.0 && f.x >= CF_SKIP) return false;
  fx = ((t10 - t00) + ((t11 - t01) - (t10 - t00)) * fr.y) * uCanyonDim.z;
  fz = (b - a) * uCanyonDim.z;
  // the section at s: linear between samples, clamped to the ends
  float w = clamp(f.y, 0.0, uCanyonLen) / CF_STEP;
  float si = min(floor(w), uCanyonDim.w - 2.0);
  float sf = w - si;
  vec4 q0 = texelFetch(uCanyonSec, ivec2(int(si), 0), 0);
  vec4 q1 = texelFetch(uCanyonSec, ivec2(int(si) + 1, 0), 0);
  q = q0 + (q1 - q0) * sf;
  dq = (f.y > 0.0 && f.y < uCanyonLen) ? (q1 - q0) / CF_STEP : vec4(0.0);
  return true;
}

// The carve with its gradient, from fetched field values: a finite difference of the carve with the base hd = vec3(height, d/dx,
// d/dz), the field and the section linearised in this cell (no extra texture reads).
vec3 canyonCarveD(vec3 hd, vec4 f, vec4 fx, vec4 fz, vec4 q, vec4 dq) {
  float h0 = canyonCarve(hd.x, f, q);
  float hx = canyonCarve(hd.x + CF_EPS * hd.y, f + CF_EPS * fx, q + (CF_EPS * fx.y) * dq);
  float hz = canyonCarve(hd.x + CF_EPS * hd.z, f + CF_EPS * fz, q + (CF_EPS * fz.y) * dq);
  return vec3(h0, (hx - h0) / CF_EPS, (hz - h0) / CF_EPS);
}

// The canyon carved into the base height h at the local position p (heights only).
float canyonHeight(float h, vec2 p) {
  vec4 f, fx, fz, q, dq;
  return canyonFetch(p, f, fx, fz, q, dq) ? canyonCarve(h, f, q) : h;
}

// The canyon carved into hd = vec3(height, d/dx, d/dz) at the local position p, with the gradient (for the shading).
vec3 canyonApply(vec3 hd, vec2 p) {
  vec4 f, fx, fz, q, dq;
  if (!canyonFetch(p, f, fx, fz, q, dq)) return hd;
  return canyonCarveD(hd, f, fx, fz, q, dq);
}
`;

// ----------------------------------------------------------------------------------------------------------------------------
// The clipmap vertex shader. Level k is a square grid of TERRAIN_CELLS cells of size c = 2 * 2^k metres (hole cut out where the finer
// level k-1 lies), world-fixed: vertex (i, j) is at (i - N/2) * c + shift, relative to the camera-snapped origin. Near its outer rim
// a level morphs to the next coarser one: odd vertices slide to the lower even neighbour, so the rim coincides with the coarse
// level's mesh (same triangulation, same heights) and there are no cracks and no pops.
// ----------------------------------------------------------------------------------------------------------------------------
export const TERRAIN_VERT = /* glsl */ `
${TERRAIN_HEIGHT_GLSL}
${CANYON_GLSL}

#define HALF_CELLS ${fl(TERRAIN_CELLS / 2)}
#define CANYON_PIXEL_CELL ${fl(CANYON_PIXEL_CELL)}
#define MORPH1 ${fl(TERRAIN_CELLS / 2 - 2.5)}
#define MORPH0 ${fl(TERRAIN_CELLS / 2 - 2.5 - TERRAIN_MORPH_CELLS)}

uniform vec4 uLevel;  // cell size (m), shift x, shift z (the level's centre relative to the origin), level index
uniform vec2 uCam;    // camera relative to the origin (m)
uniform vec4 uPlanes[6];  // the view frustum's planes in local space: inside where dot(xyz, p) + w >= 0 (all zero = no culling)

// Terrain heights stay within this band (checked in tests/terrain.test.ts); the culling boxes use it.
#define CULL_YMID ${fl(CULL_YMID)}
#define CULL_HY ${fl(CULL_HY)}

// True if the whole box (centre, half extents) lies outside one frustum plane.
bool outsideFrustum(vec3 centre, vec3 halfExtent) {
  for (int i = 0; i < 6; i++) {
    vec4 pl = uPlanes[i];
    if (dot(pl.xyz, centre) + pl.w + dot(abs(pl.xyz), halfExtent) < 0.0) return true;
  }
  return false;
}

varying vec3 vLocal;
varying vec3 vNormal;
varying vec3 vView;
varying vec2 vDebug;  // level, morph amount
varying vec3 vBase;   // the base terrain (height, d/dx, d/dz) before the canyon carve: the fragment shader carves it again per pixel

void main() {
  vec2 idx = position.xz;
  float c = uLevel.x;
  vec2 P = (idx - HALF_CELLS) * c + uLevel.yz;
  vec2 dc = abs(P - uCam);
  float alpha = clamp((max(dc.x, dc.y) / c - MORPH0) / (MORPH1 - MORPH0), 0.0, 1.0);
  P -= mod(idx, 2.0) * (alpha * c);

  // Vertices whose whole column (every height the terrain can have, plus the reach of the triangles around them) is outside the
  // view frustum cannot touch a visible triangle: skip the expensive part and give them a harmless height.
  vec3 hd = vec3(CULL_YMID, 0.0, 0.0);
  float h = CULL_YMID;
  vBase = hd;
  if (!outsideFrustum(vec3(P.x, CULL_YMID, P.y), vec3(3.0 * c, CULL_HY, 3.0 * c))) {
    // A canyon run. Where the mesa is fully raised (mask 1: the land is at least its height) and the canyon's cross-section lies
    // at least k below that height, the carve is the cross-section whatever the land: the floor and most of the walls skip the
    // base terrain (most of this shader's cost). They hand the fragment shader the mesa as their base, which is the same there.
    // (Nothing from the field is kept across terrainHD(): it would hold registers through the costliest part of the shader.)
    vec4 f, fx, fz, q, dq;
    bool carve = canyonFetch(P, f, fx, fz, q, dq);
    float k = 0.0;
    if (carve && f.z >= 1.0 && canyonCut(f, q, k) + k <= f.w) {
      hd = vec3(f.w, fx.w, fz.w);
      vBase = hd;
      // On the finest levels the vertices are close enough to follow the walls: carve with the gradient here. On the coarser ones
      // the mesh only takes the carved height, and the fragment shader carves vBase again per pixel for the shading.
      if (c < CANYON_PIXEL_CELL) hd = canyonCarveD(hd, f, fx, fz, q, dq);
      else hd.x = canyonCarve(hd.x, f, q);
    } else {
      hd = terrainHD(P, uCam);
      vBase = hd;
      if (carve) {
        if (c < CANYON_PIXEL_CELL) hd = canyonApply(hd, P);
        else hd.x = canyonHeight(hd.x, P);
      }
    }
    h = hd.x;
  }
  vec4 mv = modelViewMatrix * vec4(P.x, max(h, 0.0), P.y, 1.0);
  gl_Position = projectionMatrix * mv;
  vLocal = vec3(P.x, h, P.y);
  vNormal = h > 0.0 ? normalize(vec3(-hd.y, 1.0, -hd.z)) : vec3(0.0, 1.0, 0.0);
  vView = mv.xyz;
  vDebug = vec2(uLevel.w, alpha);
}
`;

export const TERRAIN_FRAG = /* glsl */ `
${SKY_COMMON_GLSL}
${CANYON_GLSL}

uniform vec2 uGridOff;     // (origin - grid shift) modulo 5000 m, so the lines are fixed to the world
uniform float uTime;
uniform float uAgl;        // camera height above the ground (m): a fine 10 m grid fades in when flying low, for the sense of speed
uniform vec3 uGround;
uniform vec3 uWater;
uniform vec3 uCyan;
uniform vec3 uMagenta;
uniform vec3 uAmber;

varying vec3 vLocal;
varying vec3 vNormal;
varying vec3 vView;
varying vec2 vDebug;
varying vec3 vBase;
uniform vec4 uLevel;
#define CANYON_PIXEL_CELL ${fl(CANYON_PIXEL_CELL)}
#define CANYON_PIXEL_HEIGHT_CELL 8.0
uniform float uDebug;  // 0 = normal, 1 = colour by level, 2 = morph amount, 3 = flat green (any other pixel in the terrain area is a crack), 4 = geometry (height, slope), 5 = the fragment's position (local x, raw height, local z) as floats, for sandbox/terrain-check

#define FOG_DISTANCE ${fl(TERRAIN_FOG_DISTANCE)}
#define BODY_SLOPE 1.15

// Lines are drawn as a gaussian across the line, sigma about 3/4 of a pixel: whatever the sub-pixel position of the line, about the same
// light lands in each pixel column (a box-filtered line is full strength when it hits a pixel centre and half when it straddles two,
// so a near-horizontal line gets beads). d = distance to the line in pixels.
float lineGauss(float d, float sigma) {
  return exp(-0.5 * d * d / (sigma * sigma));
}

// The size of a pixel in the units of v (its screen-space gradient length: the true distance across a line whatever its direction).
vec2 pixelSize(vec2 v) {
  vec2 dx = dFdx(v);
  vec2 dy = dFdy(v);
  return sqrt(dx * dx + dy * dy);
}

// The glow of a line is drawn here, not by the bloom pass: the bloom only passes pixels above its threshold, so the brightness of
// a line that is near the threshold, and the glow it makes, would pulse along the line with its sub-pixel position (beads that crawl
// when the camera moves). Every grid line stays below the threshold (a crossing of two may go above it: a spark) and carries its own
// wide, faint gaussian halo, which is phase-independent. halo = the halo's strength relative to the core.
#define HALO_SIGMA 2.3
float lineProfile(float d, float sigma, float halo, float haloVis) {
  float core = exp(-0.5 * d * d / (sigma * sigma));
  float wide = exp(-0.5 * d * d / (HALO_SIGMA * HALO_SIGMA));
  return (core + halo * haloVis * wide) / (1.0 + halo * haloVis);
}

// A grid with lines every 'period' metres, faded out when the spacing drops below ~lo pixels (fully visible at hi).
// pxp = pixelSize(p), the size of a pixel in metres; it is taken once, outside any branch.
float gridLines(vec2 p, vec2 pxp, float period, float sigma, float halo, float lo, float hi) {
  vec2 inv = period / max(pxp, vec2(1e-6));                  // the spacing of the lines in pixels
  vec2 vis = smoothstep(vec2(lo), vec2(hi), inv);
  if (vis.x + vis.y <= 0.0) return 0.0;
  vec2 d = abs(fract(p / period - 0.5) - 0.5) * inv;         // distance to the nearest line, in pixels
  vec2 hv = smoothstep(vec2(14.0), vec2(40.0), inv);         // lines close together get no halo (they would fill the gaps with fog)
  return max(lineProfile(d.x, sigma, halo, hv.x) * vis.x, lineProfile(d.y, sigma, halo, hv.y) * vis.y);
}

void main() {
  float dist = length(vView);
  vec3 wdir = (vec4(vView / dist, 0.0) * viewMatrix).xyz;   // view direction in world space
  vec3 hz = skyHorizonColor(wdir);                           // the sky at the horizon that way: the fog colour

  // In a canyon run, on the coarser clipmap levels, the carve is evaluated again here, per pixel, from the interpolated base terrain
  // (smooth, so interpolating it is exact enough): the walls are far sharper than those levels' cells, so the shading normal, the
  // contour lines and the floor's edge follow the true surface instead of zigzagging along the triangles. (The finest level has
  // carved vertex normals: per pixel there would cost the most pixels for the least gain.)
  float h = vLocal.y;
  vec3 n = normalize(vNormal);
  if (uCanyonOn > 0.5 && uLevel.x >= CANYON_PIXEL_CELL) {
    vec3 cd = canyonApply(vBase, vLocal.xz);
    if (cd != vBase) {
      // (the height too, for the contour lines, but only where the triangles are still close to the true surface: on the
      // coarsest levels a pixel can lie metres off the true wall, and true-height contours there would bunch up in spikes)
      if (uLevel.x <= CANYON_PIXEL_HEIGHT_CELL) h = cd.x;
      n = cd.x > 0.0 ? normalize(vec3(-cd.y, 1.0, -cd.z)) : vec3(0.0, 1.0, 0.0);
    }
  }
  float fwh = fwidth(h);
  float wat = 1.0 - smoothstep(-fwh, fwh, h);                // 1 on water, antialiased at the shore

  // fog; lines dim with distance a little before the fog takes them
  float fd = dist / FOG_DISTANCE;
  float fog = 1.0 - exp(-fd * fd);
  float lineFade = (1.0 - fog) * (1.0 - fog);

  // ---- land body: very dark, with a little purple on the slopes (more at grazing angles) so mountains read as solid between the lines
  float ndv = clamp(dot(n, -wdir), 0.0, 1.0);
  float slope = 1.0 - n.y;
  float steep = smoothstep(0.03, 0.4, slope);
  float rim = pow(1.0 - ndv, 2.0);
  float sunFace = max(dot(n, uSunDir), 0.0);
  vec3 land = uGround * (1.0 + 3.0 * slope) + hz * (BODY_SLOPE * steep * (0.3 + 0.7 * rim)) + uSunGlow * (0.16 * sunFace * sunFace * steep);

  // ---- water body: darker still, mirrors the horizon at grazing angles and the sun in a glitter path
  float fres = pow(1.0 - clamp(-wdir.y, 0.0, 1.0), 5.0);
  vec3 water = uWater + hz * (0.35 * fres);
  if (wat > 0.0) {
    vec2 wp = vLocal.xz + uGridOff;
    float t = uTime;
    vec2 nw = vec2(sin(wp.x * 0.047 + t * 0.9) + sin(wp.y * 0.033 - t * 0.7) + sin((wp.x + wp.y) * 0.021 + t * 0.5),
                   sin(wp.y * 0.052 - t * 0.8) + sin(wp.x * 0.029 + t * 0.6) + sin((wp.y - wp.x) * 0.024 - t * 0.4));
    float calm = 1.0 / (1.0 + dist * 0.00012);             // far away the waves average out
    vec3 nW = normalize(vec3(nw.x * 0.011 * calm, 1.0, nw.y * 0.011 * calm));
    float sr = max(dot(reflect(wdir, nW), uSunDir), 0.0);
    float glitter = (pow(sr, 700.0) * 2.2 + pow(sr, 60.0) * 0.1) * (1.0 - smoothstep(8000.0, 24000.0, dist));
    water += mix(uSunGlow, uAmber, 0.35) * glitter;
  }
  vec3 col = mix(land, water, wat);

  // ---- world-fixed grid lines (10 m when low, 50 m, 200 m, 1 km, 5 km): each fades out where its spacing gets too small on screen
  vec2 P = vLocal.xz + uGridOff;
  vec2 pxp = pixelSize(P);
  float g10 = uAgl < 260.0 ? gridLines(P, pxp, 10.0, 0.5, 0.0, 7.0, 18.0) * (1.0 - smoothstep(70.0, 260.0, uAgl)) : 0.0;
  float g50 = gridLines(P, pxp, 50.0, 0.52, 0.0, 6.0, 16.0);
  float g200 = gridLines(P, pxp, 200.0, 0.58, 0.12, 6.0, 16.0);
  float g1k = gridLines(P, pxp, 1000.0, 0.64, 0.45, 6.0, 16.0);
  float g5k = gridLines(P, pxp, 5000.0, 0.72, 0.8, 6.0, 16.0);
  // (max, not a sum: where a 1 km line lies on a 200 m line it must not get brighter, and crossings must not turn into beads)
  float gridI = max(max(0.1 * g10, 0.3 * g50), max(max(0.8 * g200, 1.05 * g1k), 1.1 * g5k));
  vec3 gridCol = mix(uCyan, uCyan * vec3(0.5, 0.62, 1.3), wat);
  col += gridCol * gridI * mix(1.0, 0.24, wat) * lineFade;

  // ---- magenta contour lines every 100 m of altitude; the 0 m one is the shore and shows on both sides
  float hc = h / 100.0;
  float fc = max(pixelSize(vec2(hc)).x, 0.0015 / 100.0);        // contour spacing per pixel (a flat spot would otherwise fill with line)
  float dcl = abs(fract(hc - 0.5) - 0.5) / fc;                  // distance to the nearest contour, in pixels
  float cvis = smoothstep(5.0, 14.0, 1.0 / fc);
  float shore = 1.0 - step(0.5, abs(hc));
  float contour = lineGauss(dcl, 0.72) * cvis * mix(1.0 - wat, 1.0, shore);
  col += mix(uMagenta, uMagenta * vec3(1.0, 0.6, 1.0) + 0.25, shore) * (0.9 * contour * lineFade);

  // ---- fog into the sky's horizon colour
  col = mix(col, hz, fog);

  if (uDebug > 0.5) {
    vec3 lc = 0.5 + 0.5 * cos(6.2831853 * (vDebug.x * 0.11 + vec3(0.0, 0.33, 0.67)));
    col = uDebug < 1.5 ? lc * (0.35 + 0.65 * (1.0 - vDebug.y)) * 0.8 : uDebug < 2.5 ? vec3(vDebug.y) : uDebug < 3.5 ? vec3(0.0, 1.0, 0.0) : uDebug < 4.5 ? vec3(clamp(h / 4000.0, 0.0, 1.0), n.y, fract(h / 16.0)) : vLocal;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

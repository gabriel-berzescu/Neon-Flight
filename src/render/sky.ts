/**
 * The synthwave night sky: a deep gradient from the zenith to the horizon, a big low striped sun on the horizon due NORTH (right
 * ahead of the player at the spawn), a soft glow around it, and a field of small stars that fade out towards the horizon.
 *
 * One full-screen triangle drawn first with depth test and write off, so it needs no geometry, never clips and always "follows
 * the camera". The horizon colour is skyHorizonColor() from skyGlsl.ts, the very function the terrain fog uses, so the far
 * terrain melts into the sky without a seam. Below the horizon the sky is that same colour.
 */
import * as THREE from 'three';
import { PALETTE } from './palette';
import { horizonColor, SKY_COMMON_GLSL, SKY_UNIFORMS, SUN_DIRECTION, SUN_ELEVATION_DEG, SUN_RADIUS_DEG } from './skyGlsl';

export { SUN_DIRECTION, horizonColor };

const VERT = /* glsl */ `
uniform mat4 uInvProj;
uniform mat3 uCamRot;
varying vec3 vDir;
void main() {
  vec4 v = uInvProj * vec4(position.xy, 1.0, 1.0);
  vDir = uCamRot * (v.xyz / v.w);
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

function fl(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : v.toPrecision(9);
}

const FRAG = /* glsl */ `
${SKY_COMMON_GLSL}
uniform float uTime;
uniform vec3 uAmber;
uniform vec3 uMagenta;
varying vec3 vDir;

#define SUN_R ${fl((SUN_RADIUS_DEG * Math.PI) / 180)}
#define SUN_GAIN 1.3

uint hash3(ivec3 c) {
  uint h = uint(c.x) * 0x27d4eb2du ^ uint(c.y) * 0x165667b1u ^ uint(c.z) * 0x9e3779b1u;
  h ^= h >> 16u;
  h *= 0x7feb352du;
  h ^= h >> 15u;
  h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

// Stars: a jittered 3D grid on the sphere, at most one star per cell, drawn as a ~1 pixel gaussian. pix = angle of a pixel (radians).
vec3 stars(vec3 dir, float pix) {
  vec3 p = dir * 46.0;
  ivec3 cell = ivec3(floor(p));
  uint h = hash3(cell);
  if (float(h & 0xffu) > 25.5) return vec3(0.0);
  vec3 jit = vec3(float((h >> 8u) & 0xffu), float((h >> 16u) & 0xffu), float(h >> 24u)) / 255.0;
  vec3 sp = vec3(cell) + 0.2 + 0.6 * jit;
  float d = length(p - sp);
  float r = max(pix * 46.0, 0.012) * 0.9;
  float core = exp(-(d * d) / (r * r));
  float mag = float((h >> 5u) & 0xffu) / 255.0;
  float b = 0.22 + 1.7 * mag * mag * mag;
  vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), float((h >> 12u) & 0xffu) / 255.0);
  float tw = 0.86 + 0.14 * sin(uTime * (1.0 + 3.0 * mag) + float(h & 0xfffu));
  return tint * (core * b * tw);
}

// The sun: a disc on the horizon, amber at the top to magenta at the bottom, its lower part cut by horizontal gaps that widen downwards.
// pix = angle of a pixel (radians), pixY = the same for the elevation: both taken by the caller, outside any branch (derivatives).
vec3 sunLayer(vec3 dir, float pix, float pixY, out float haloAmount, out float discAmount) {
  discAmount = 0.0;
  // the glow around the sun: a soft falloff that reaches zero smoothly (a hard cut-off would show as a faint edge in the dark sky)
  float c = dot(dir, uSunDir);
  float ang2 = max(2.0 * (1.0 - c), 0.0);
  haloAmount = (1.0 / (1.0 + 5.0 * ang2 / (SUN_R * SUN_R))) * (1.0 - smoothstep(0.1, 0.45, sqrt(ang2)));
  if (c < 0.85) return vec3(0.0);
  // angles from the sun's centre: azimuth (scaled to a true angle) and elevation
  float sunEl = asin(clamp(uSunDir.y, -1.0, 1.0));
  float az = atan(dir.x, -dir.z) - atan(uSunDir.x, -uSunDir.z);
  az -= 6.2831853 * floor(az / 6.2831853 + 0.5);
  vec2 d = vec2(az * cos(sunEl), asin(clamp(dir.y, -1.0, 1.0)) - sunEl);
  float r = length(d);
  float aa = max(pix, 1e-5) * 1.2;
  float disc = 1.0 - smoothstep(SUN_R - aa, SUN_R + aa, r);
  float v = clamp((d.y + SUN_R) / (2.0 * SUN_R), 0.0, 1.0);          // 0 at the bottom, 1 at the top
  vec3 grad = v > 0.5 ? mix(uSunGlow, uAmber, smoothstep(0.45, 0.85, v)) : mix(uMagenta, uSunGlow, smoothstep(0.0, 0.5, v));
  // gaps centred on whole numbers of a band coordinate that runs from the top of the striped part (0) to the bottom (8); they widen downwards
  const float STRIPED = 0.56;
  float sy = clamp((STRIPED - v) / STRIPED, 0.0, 1.0);
  float x = sy * 8.0;
  float bd = abs(fract(x + 0.5) - 0.5);
  float halfGap = 0.45 * sy;
  float aab = max(8.0 / (STRIPED * 2.0 * SUN_R) * pixY * 0.7, 1e-4);
  float bar = smoothstep(halfGap - aab, halfGap + aab, bd);
  float striped = mix(1.0, bar, smoothstep(0.0, 0.06, sy));
  discAmount = disc;
  return grad * (SUN_GAIN * disc * striped);
}

void main() {
  vec3 dir = normalize(vDir);
  float pix = length(fwidth(dir));
  float pixY = fwidth(dir.y);
  float y = max(dir.y, 0.0);
  vec3 hz = skyHorizonColor(dir);

  // gradient: exactly the horizon colour (what the terrain fog is) at and below the horizon, falling quickly to the deep zenith colour
  float t = smoothstep(0.0, 1.0, pow(y, 0.5));
  vec3 col = mix(hz, uSkyZenith, t);

  // clip everything that belongs to the sky proper at the horizon line
  float clip = smoothstep(0.0, max(pixY * 1.5, 1e-5), dir.y);

  float halo;
  float disc;
  vec3 sun = sunLayer(dir, pix, pixY, halo, disc);
  // (the halo is only left out where the disc is really drawn: below the horizon line there is no disc, so no hole in the glow)
  col += uSunGlow * (0.55 * halo * (1.0 - disc * clip) * (0.25 + 0.75 * clip));
  col += sun * clip;

  float starFade = smoothstep(0.03, 0.4, dir.y) * (1.0 - 0.85 * clamp(halo * 2.0, 0.0, 1.0));
  col += stars(dir, pix) * starFade;

  gl_FragColor = vec4(col, 1.0);
}
`;

export class SkyView {
  readonly object: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly uniforms = {
    uInvProj: { value: new THREE.Matrix4() },
    uCamRot: { value: new THREE.Matrix3() },
    uTime: { value: 0 },
    uAmber: { value: new THREE.Color(PALETTE.amber) },
    uMagenta: { value: new THREE.Color(PALETTE.magenta) },
    ...SKY_UNIFORMS,
  };

  constructor() {
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.object = new THREE.Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = -1000;
    this.object.name = 'sky';
    // the renderer's own camera, whatever it is, at draw time
    this.object.onBeforeRender = (_renderer, _scene, camera) => this.setCamera(camera);
  }

  private setCamera(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.uniforms.uCamRot.value.setFromMatrix4(camera.matrixWorld);
  }

  update(camera: THREE.PerspectiveCamera, timeSeconds: number): void {
    this.uniforms.uTime.value = timeSeconds;
    this.setCamera(camera);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

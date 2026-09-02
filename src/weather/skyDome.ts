/**
 * Sky dome: a single shader sphere that follows the camera and paints the
 * whole atmosphere — zenith→horizon gradient, sun disc with corona and
 * forward-scatter haze, drifting FBM clouds shaded toward the sun, a moon,
 * a hashed star field with twinkle, and a matching ground hemisphere so the
 * same shader can be baked into a PMREM environment map. The env map is what
 * makes car paint, glass and wet asphalt reflect the actual sky.
 */

import * as THREE from 'three';
import type { SkySystem } from './sky';

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
#include <common>
varying vec3 vDir;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uNight;
uniform float uCloudCover;
uniform float uOvercast;
uniform vec2 uCloudOffset;
uniform vec3 uFogColor;
uniform vec3 uGround;
uniform float uTime;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = r * p * 2.03 + 13.7;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float t = clamp(y, 0.0, 1.0);

  // base gradient with a soft haze band near the horizon
  vec3 col = mix(uHorizon, uZenith, pow(t, 0.42));

  // sun: disc + corona + horizon forward scatter
  float sd = max(dot(d, uSunDir), 0.0);
  float disc = smoothstep(0.99945, 0.99985, sd);
  float corona = pow(sd, 48.0) * 0.55 + pow(sd, 7.0) * 0.12;
  float haze = pow(1.0 - t, 5.0) * (0.25 + 0.75 * pow(sd, 4.0));
  col += uSunColor * (corona + haze * 0.55) * uSunIntensity * (1.0 - uOvercast * 0.7);
  col += uSunColor * disc * 9.0 * uSunIntensity * (1.0 - uOvercast);

  // stars (only above the horizon, only at night)
  {
    vec3 p = d * 140.0;
    vec3 ip = floor(p);
    vec3 fp = p - ip;
    float h = hash13(ip);
    float star = 0.0;
    if (h > 0.972) {
      vec3 off = hash33(ip + 7.0) * 0.8 + 0.1;
      float dd = length(fp - off);
      float bright = (h - 0.972) / 0.028;
      float tw = 0.75 + 0.25 * sin(uTime * (2.0 + bright * 4.0) + h * 40.0);
      star = smoothstep(0.09, 0.0, dd) * bright * tw;
    }
    col += vec3(0.9, 0.95, 1.0) * star * uNight * smoothstep(0.0, 0.15, y) * (1.0 - uOvercast) * 1.4;
  }

  // moon
  {
    float md = max(dot(d, uMoonDir), 0.0);
    float mdisc = smoothstep(0.9990, 0.9996, md);
    float mglow = pow(md, 90.0) * 0.25;
    col += vec3(0.85, 0.9, 1.0) * (mdisc * 1.8 + mglow) * uNight * (1.0 - uOvercast * 0.8);
  }

  // clouds: planar projection of the direction with a slow drift
  {
    vec2 cuv = d.xz / (y + 0.10) * 0.55 + uCloudOffset;
    float base = fbm(cuv * 1.2);
    float detail = fbm(cuv * 3.6 + 4.2) * 0.35;
    float dens = base * 0.8 + detail;
    float thresh = 1.0 - uCloudCover * 0.85;
    float cloud = smoothstep(thresh, thresh + 0.32, dens);
    float thick = smoothstep(thresh, thresh + 0.6, dens);
    // lit toward the sun; bottoms darker where thick
    float lit = 0.55 + 0.45 * pow(sd, 1.5);
    vec3 cloudLight = mix(uHorizon, vec3(1.0), 0.65) * lit;
    vec3 cloudDark = mix(uHorizon, uZenith, 0.5) * 0.75;
    vec3 cloudCol = mix(cloudLight, cloudDark, thick * (0.45 + 0.5 * uOvercast));
    cloudCol *= mix(1.0, 0.16, uNight);
    cloudCol += uSunColor * pow(sd, 10.0) * 0.6 * uSunIntensity * (1.0 - thick) * (1.0 - uOvercast);
    cloud *= smoothstep(0.0, 0.14, y);
    col = mix(col, cloudCol, cloud * (0.85 + 0.15 * uOvercast));
  }

  // blend to fog colour at the horizon, ground colour below it
  col = mix(uFogColor, col, smoothstep(-0.01, 0.09, y));
  if (y < 0.0) col = mix(uFogColor, uGround, smoothstep(0.0, -0.22, y));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private envScene = new THREE.Scene();
  private envMesh: THREE.Mesh;
  private envTex: THREE.Texture | null = null;
  private envHour = -99;
  private envOvercast = -1;
  private cloudOffset = new THREE.Vector2(0, 0);
  /** Cloud cover 0..1 (weather drives this). */
  cloudCover = 0.35;
  overcast = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
        uZenith: { value: new THREE.Color(0x3a72c8) },
        uHorizon: { value: new THREE.Color(0xc8d9ea) },
        uSunColor: { value: new THREE.Color(0xfff0d8) },
        uSunIntensity: { value: 1 },
        uNight: { value: 0 },
        uCloudCover: { value: 0.35 },
        uOvercast: { value: 0 },
        uCloudOffset: { value: this.cloudOffset },
        uFogColor: { value: new THREE.Color(0xc6d8ea) },
        uGround: { value: new THREE.Color(0x3a4030) },
        uTime: { value: 0 },
      },
    });
    (this.material as THREE.ShaderMaterial & { toneMapped: boolean }).toneMapped = true;
    const geo = new THREE.SphereGeometry(1, 48, 28);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.scale.setScalar(1400);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
    this.envMesh = new THREE.Mesh(geo, this.material);
    this.envMesh.scale.setScalar(40);
    this.envScene.add(this.envMesh);
  }

  update(dt: number, camX: number, camY: number, camZ: number, sky: SkySystem, sunPos: THREE.Vector3, moonPos: THREE.Vector3, fogColor: THREE.Color): void {
    const u = this.material.uniforms;
    this.mesh.position.set(camX, camY, camZ);
    // sun direction relative to the player (the light is positioned around the player)
    u.uSunDir.value.set(sunPos.x - camX, sunPos.y, sunPos.z - camZ).normalize();
    u.uMoonDir.value.set(moonPos.x - camX, moonPos.y, moonPos.z - camZ).normalize();
    const p = sky.palette;
    u.uZenith.value.copy(p.zenith);
    u.uHorizon.value.copy(p.horizon);
    u.uSunColor.value.copy(p.sunColor);
    u.uSunIntensity.value = Math.min(1, p.sunIntensity / 2.2);
    u.uNight.value = sky.nightFactor;
    u.uCloudCover.value = this.cloudCover;
    u.uOvercast.value = this.overcast;
    u.uFogColor.value.copy(fogColor);
    u.uTime.value += dt;
    this.cloudOffset.x += dt * 0.004;
    this.cloudOffset.y += dt * 0.0015;
  }

  /**
   * Bake the dome into a PMREM environment when the light has moved enough.
   * Returns the (possibly unchanged) environment texture.
   */
  refreshEnvironment(renderer: THREE.WebGLRenderer, sky: SkySystem, force = false): THREE.Texture | null {
    const moved = Math.abs(sky.hour - this.envHour) > 0.18 || Math.abs(this.overcast - this.envOvercast) > 0.08;
    if (!force && this.envTex && !moved) return this.envTex;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const prev = this.envTex;
    const target = pmrem.fromScene(this.envScene, 0.02, 0.1, 100);
    this.envTex = target.texture;
    pmrem.dispose();
    prev?.dispose();
    this.envHour = sky.hour;
    this.envOvercast = this.overcast;
    return this.envTex;
  }
}

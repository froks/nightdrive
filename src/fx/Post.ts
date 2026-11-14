import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { ScenePreset } from '../scenes/types';
import { BloomPass } from './Bloom';

/** VHS / CRT look: barrel, tracking wobble, glitch bands, chromatic aberration, scanlines, grain, vignette. */
const VHSShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1, 1) },
    /** x = time, y = glitch (0..1), z = amount (0 disables the effect) */
    uParams: { value: new THREE.Vector4(0, 0, 1, 0) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform vec4 uParams;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      float uTime = uParams.x, uGlitch = uParams.y, fx = uParams.z;
      vec2 p = vUv * 2.0 - 1.0;
      float r2 = dot(p, p);
      vec2 u = (p * (1.0 + 0.025 * r2 * fx)) * 0.5 + 0.5;
      float line = floor(u.y * uRes.y / 3.0);
      float band = 1.0 - smoothstep(0.0, 0.06, abs(u.y - fract(uTime * 0.07 + 0.3)));
      u.x += fx * (hash(vec2(line, floor(uTime * 24.0))) - 0.5) * (0.0008 + 0.012 * uGlitch) * (0.25 + band + uGlitch);
      u.x += fx * uGlitch * 0.02 * sin(u.y * 40.0 + uTime * 30.0) * step(0.5, hash(vec2(floor(u.y * 12.0), floor(uTime * 20.0))));
      vec2 ca = (u - 0.5) * (0.0016 + 0.006 * uGlitch) * (1.0 + 0.8 * r2) * fx;
      vec3 col;
      col.r = texture2D(tDiffuse, u + ca).r;
      col.g = texture2D(tDiffuse, u).g;
      col.b = texture2D(tDiffuse, u - ca).b;
      col *= 1.0 - fx * 0.09 * (0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159 * 0.66));
      col += fx * (hash(gl_FragCoord.xy + fract(uTime) * 97.0) - 0.5) * 0.04;
      col *= mix(1.0, 1.0 - smoothstep(0.35, 1.6, length(p * vec2(0.9, 1.05))), 0.8 * fx + 0.2);
      col = col * 0.97 + vec3(0.008, 0.006, 0.018) * fx;
      if (u.x < 0.0 || u.x > 1.0 || u.y < 0.0 || u.y > 1.0) col = vec3(0.0);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Post {
  readonly composer: EffectComposer;
  readonly bloom: BloomPass;
  readonly vhs: ShaderPass;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new BloomPass(1, 0.5, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.vhs = new ShaderPass(VHSShader);
    this.composer.addPass(this.vhs);
  }

  setPreset(p: ScenePreset) {
    this.bloom.strength = p.bloom.strength;
    this.bloom.radius = p.bloom.radius;
    this.bloom.threshold = p.bloom.threshold;
    this.renderer.toneMappingExposure = p.exposure;
  }

  setSize(w: number, h: number, pr: number) {
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.vhs.uniforms.uRes.value.set(w * pr, h * pr);
  }

  render(t: number, glitch: number, fx: boolean) {
    this.vhs.uniforms.uParams.value.set(t % 1000, glitch, fx ? 1 : 0, 0);
    this.composer.render();
  }
}

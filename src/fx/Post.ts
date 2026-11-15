import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { ScenePreset } from '../scenes/types';
import { BloomPass } from './Bloom';
import { config } from '../config';

/**
 * Final pass: bloom composite + tone mapping + sRGB + VHS / CRT look (barrel,
 * tracking wobble, glitch bands, chromatic aberration, scanlines, grain,
 * vignette) in one full-screen pass. Used to be three passes (bloom composite,
 * OutputPass, VHS), each reading and writing the full-resolution HDR buffer.
 */
class FinalPass extends Pass {
  readonly uniforms = {
    tScene: { value: null as THREE.Texture | null },
    tBloom: { value: null as THREE.Texture | null },
    uBloom: { value: 0 },
    toneMappingExposure: { value: 1 },
    uRes: { value: new THREE.Vector2(1, 1) },
    /** x = time, y = glitch (0..1), z = amount (0 disables the effect) */
    uParams: { value: new THREE.Vector4(0, 0, 1, 0) },
  };
  private quad: FullScreenQuad;
  private black = new THREE.DataTexture(new Uint8Array(4), 1, 1);

  constructor(private bloom: BloomPass) {
    super();
    this.needsSwap = false;
    this.black.needsUpdate = true;
    this.quad = new FullScreenQuad(new THREE.RawShaderMaterial({
      name: 'FinalPass',
      uniforms: this.uniforms,
      depthTest: false, depthWrite: false,
      vertexShader: /* glsl */`
        precision highp float;
        attribute vec3 position;
        attribute vec2 uv;
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tScene, tBloom;
        uniform float uBloom;
        uniform vec2 uRes;
        uniform vec4 uParams;
        varying vec2 vUv;
        #include <tonemapping_pars_fragment>
        #include <colorspace_pars_fragment>
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        /** scene + bloom, tone mapped, sRGB encoded (what OutputPass produced) */
        vec3 graded(vec2 uv) {
          vec3 c = texture2D(tScene, uv).rgb + texture2D(tBloom, uv).rgb * uBloom;
          return sRGBTransferOETF(vec4(ACESFilmicToneMapping(c), 1.0)).rgb;
        }
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
          if (fx > 0.0) {
            col.r = graded(u + ca).r;
            col.g = graded(u).g;
            col.b = graded(u - ca).b;
          } else {
            col = graded(u);
          }
          col *= 1.0 - fx * 0.09 * (0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159 * 0.66));
          col += fx * (hash(gl_FragCoord.xy + fract(uTime) * 97.0) - 0.5) * 0.04;
          col *= mix(1.0, 1.0 - smoothstep(0.35, 1.6, length(p * vec2(0.9, 1.05))), 0.8 * fx + 0.2);
          col = col * 0.97 + vec3(0.008, 0.006, 0.018) * fx;
          if (u.x < 0.0 || u.x > 1.0 || u.y < 0.0 || u.y > 1.0) col = vec3(0.0);
          gl_FragColor = vec4(col, 1.0);
        }`,
    }));
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const u = this.uniforms;
    u.tScene.value = readBuffer.texture;
    const bloom = this.bloom.enabled;
    u.tBloom.value = bloom ? this.bloom.texture : this.black;
    u.uBloom.value = bloom ? this.bloom.gain : 0;
    u.toneMappingExposure.value = renderer.toneMappingExposure;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.quad.material.dispose();
    this.quad.dispose();
    this.black.dispose();
  }
}

export class Post {
  readonly composer: EffectComposer;
  readonly bloom: BloomPass;
  private final: FinalPass;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: config.msaa });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new BloomPass(1, 0.5, 0.85);
    this.bloom.composite = false; // FinalPass adds it
    this.composer.addPass(this.bloom);
    this.final = new FinalPass(this.bloom);
    this.composer.addPass(this.final);
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
    this.final.uniforms.uRes.value.set(w * pr, h * pr);
  }

  /** @param dt frame time (s), for the bloom's temporal blend */
  render(t: number, glitch: number, fx: boolean, dt: number) {
    this.final.uniforms.uParams.value.set(t % 1000, glitch, fx ? 1 : 0, 0);
    this.composer.render(dt);
  }
}

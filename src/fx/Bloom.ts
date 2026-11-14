import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Temporally stable bloom (replaces UnrealBloomPass).
 *
 * UnrealBloomPass flickers on this scene: its threshold is a hard step, and a
 * tiny, very bright feature (a distant neon line or lamp only a pixel wide)
 * dumps all its HDR energy into the blur, so the slightest camera motion makes
 * the halo pulse. This follows the usual "next-gen" bloom recipe instead:
 *  - 13-tap filtered downsample chain (half res down to ~1/64);
 *  - Karis average (luma-weighted) on the first downsample, which keeps
 *    single bright pixels from dominating;
 *  - quadratic soft-knee threshold after that first filter (no hard step);
 *  - 3x3 tent upsample, adding each level with UnrealBloom-style weights;
 *  - a very short temporal blend (~40 ms) of the result, which damps the
 *    remaining one-frame flashes from thin lines gaining/losing MSAA samples.
 * Same knobs as UnrealBloomPass: strength, radius, threshold.
 */
const LEVELS = 7;
/** overall gain so the presets' UnrealBloom-era strength/radius values look about the same */
const GAIN = 2.8;

const vert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const downFrag = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uFirst, uThreshold, uKnee;
  varying vec2 vUv;
  vec3 tap(float x, float y) { return min(max(texture2D(tSrc, vUv + vec2(x, y) * uTexel).rgb, 0.0), vec3(1000.0)); }
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  void main() {
    vec3 a = tap(-2.0, -2.0), b = tap(0.0, -2.0), c = tap(2.0, -2.0);
    vec3 d = tap(-1.0, -1.0), e = tap(1.0, -1.0);
    vec3 f = tap(-2.0, 0.0), g = tap(0.0, 0.0), h = tap(2.0, 0.0);
    vec3 i = tap(-1.0, 1.0), j = tap(1.0, 1.0);
    vec3 k = tap(-2.0, 2.0), l = tap(0.0, 2.0), m = tap(2.0, 2.0);
    vec3 col;
    if (uFirst > 0.5) {
      // Karis average: weight each 2x2 group by 1 / (1 + luma)
      vec3 g0 = (d + e + i + j) * 0.25, g1 = (a + b + f + g) * 0.25, g2 = (b + c + g + h) * 0.25;
      vec3 g3 = (f + g + k + l) * 0.25, g4 = (g + h + l + m) * 0.25;
      float w0 = 0.5 / (1.0 + luma(g0)), w1 = 0.125 / (1.0 + luma(g1)), w2 = 0.125 / (1.0 + luma(g2));
      float w3 = 0.125 / (1.0 + luma(g3)), w4 = 0.125 / (1.0 + luma(g4));
      col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
      // soft-knee threshold (continuous: no sudden on/off)
      float br = max(col.r, max(col.g, col.b));
      float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
      soft = soft * soft / (4.0 * uKnee + 1e-4);
      col *= max(soft, br - uThreshold) / max(br, 1e-4);
    } else {
      col = (d + e + i + j) * 0.125 + (a + c + k + m) * 0.03125 + (b + f + h + l) * 0.0625 + g * 0.125;
    }
    gl_FragColor = vec4(col, 1.0);
  }`;

const upFrag = /* glsl */`
  uniform sampler2D tLow, tCur;
  uniform vec2 uTexel; // texel size of tLow
  uniform float uWeight, uLowScale;
  varying vec2 vUv;
  void main() {
    vec2 o = uTexel;
    vec3 s = texture2D(tLow, vUv).rgb * 4.0;
    s += (texture2D(tLow, vUv + vec2(-o.x, 0.0)).rgb + texture2D(tLow, vUv + vec2(o.x, 0.0)).rgb
        + texture2D(tLow, vUv + vec2(0.0, -o.y)).rgb + texture2D(tLow, vUv + vec2(0.0, o.y)).rgb) * 2.0;
    s += texture2D(tLow, vUv - o).rgb + texture2D(tLow, vUv + o).rgb
       + texture2D(tLow, vUv + vec2(-o.x, o.y)).rgb + texture2D(tLow, vUv + vec2(o.x, -o.y)).rgb;
    vec3 col = s / 16.0 * uLowScale + texture2D(tCur, vUv).rgb * uWeight;
    gl_FragColor = vec4(col, 1.0);
  }`;

const blendFrag = /* glsl */`
  uniform sampler2D tPrev, tCur;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(mix(texture2D(tPrev, vUv).rgb, texture2D(tCur, vUv).rgb, uAlpha), 1.0); }`;

const compFrag = /* glsl */`
  uniform sampler2D tBloom;
  uniform float uStrength;
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(texture2D(tBloom, vUv).rgb * uStrength, 1.0); }`;

export class BloomPass extends Pass {
  strength: number;
  radius: number;
  threshold: number;
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private downMat = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 }, uThreshold: { value: 1 }, uKnee: { value: 0.5 } },
    vertexShader: vert, fragmentShader: downFrag, depthTest: false, depthWrite: false,
  });
  private upMat = new THREE.ShaderMaterial({
    uniforms: { tLow: { value: null }, tCur: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 }, uLowScale: { value: 1 } },
    vertexShader: vert, fragmentShader: upFrag, depthTest: false, depthWrite: false,
  });
  private compMat = new THREE.ShaderMaterial({
    uniforms: { tBloom: { value: null }, uStrength: { value: 1 } },
    vertexShader: vert, fragmentShader: compFrag,
    blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
  });
  private blendMat = new THREE.ShaderMaterial({
    uniforms: { tPrev: { value: null }, tCur: { value: null }, uAlpha: { value: 1 } },
    vertexShader: vert, fragmentShader: blendFrag, depthTest: false, depthWrite: false,
  });
  private quad = new FullScreenQuad();
  /** temporal history (ping-pong) */
  private hist: THREE.WebGLRenderTarget[] = [];
  private histIdx = 0;
  private histValid = false;

  constructor(strength = 1, radius = 0.5, threshold = 0.85) {
    super();
    this.strength = strength;
    this.radius = radius;
    this.threshold = threshold;
    this.needsSwap = false;
    for (let i = 0; i < LEVELS; i++) {
      const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
      this.down.push(new THREE.WebGLRenderTarget(1, 1, opts));
      this.up.push(new THREE.WebGLRenderTarget(1, 1, opts));
    }
    for (let i = 0; i < 2; i++) {
      this.hist.push(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
    }
  }

  setSize(w: number, h: number) {
    for (let i = 0; i < LEVELS; i++) {
      const s = 2 ** (i + 1);
      const rw = Math.max(1, Math.round(w / s)), rh = Math.max(1, Math.round(h / s));
      this.down[i].setSize(rw, rh);
      this.up[i].setSize(rw, rh);
    }
    for (const t of this.hist) t.setSize(this.up[0].width, this.up[0].height);
    this.histValid = false;
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime = 1 / 60) {
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    const du = this.downMat.uniforms, uu = this.upMat.uniforms;

    // downsample chain (first step: Karis average + soft threshold)
    du.uThreshold.value = this.threshold;
    du.uKnee.value = Math.max(0.05, this.threshold * 0.5);
    let src: THREE.Texture = readBuffer.texture;
    let sw = readBuffer.width, sh = readBuffer.height;
    this.quad.material = this.downMat;
    for (let i = 0; i < LEVELS; i++) {
      du.tSrc.value = src;
      du.uTexel.value.set(1 / sw, 1 / sh);
      du.uFirst.value = i === 0 ? 1 : 0;
      renderer.setRenderTarget(this.down[i]);
      this.quad.render(renderer);
      src = this.down[i].texture;
      sw = this.down[i].width; sh = this.down[i].height;
    }

    // upsample: up[i] = tent(up[i+1]) + down[i] * w(i), starting from the coarsest level * w
    this.quad.material = this.upMat;
    const weight = (i: number) => {
      const f = Math.max(0.1, 1 - i * 0.2); // 1, .8, .6, .4, .2, .1, .1
      return THREE.MathUtils.lerp(f, 1.2 - f, 0.5 + 0.5 * this.radius);
    };
    let low = this.down[LEVELS - 1];
    for (let i = LEVELS - 2; i >= 0; i--) {
      uu.tLow.value = low.texture;
      uu.uTexel.value.set(1 / low.width, 1 / low.height);
      uu.uLowScale.value = i === LEVELS - 2 ? weight(LEVELS - 1) : 1;
      uu.tCur.value = this.down[i].texture;
      uu.uWeight.value = weight(i);
      renderer.setRenderTarget(this.up[i]);
      this.quad.render(renderer);
      low = this.up[i];
    }

    // temporal blend with the previous frame's bloom (frame-rate independent, tau ~40 ms)
    const prev = this.hist[this.histIdx], next = this.hist[1 - this.histIdx];
    this.blendMat.uniforms.tPrev.value = prev.texture;
    this.blendMat.uniforms.tCur.value = this.up[0].texture;
    this.blendMat.uniforms.uAlpha.value = this.histValid ? 1 - Math.exp(-Math.min(0.1, Math.max(0, deltaTime)) / 0.04) : 1;
    this.quad.material = this.blendMat;
    renderer.setRenderTarget(next);
    this.quad.render(renderer);
    this.histIdx = 1 - this.histIdx;
    this.histValid = true;

    // add onto the scene
    this.quad.material = this.compMat;
    this.compMat.uniforms.tBloom.value = next.texture;
    this.compMat.uniforms.uStrength.value = this.strength * GAIN;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.quad.render(renderer);

    renderer.autoClear = auto;
  }

  dispose() {
    for (const t of [...this.down, ...this.up, ...this.hist]) t.dispose();
    this.downMat.dispose(); this.upMat.dispose(); this.blendMat.dispose(); this.compMat.dispose();
    this.quad.dispose();
  }
}

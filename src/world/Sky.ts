import * as THREE from 'three';
import type { ScenePreset } from '../scenes/types';
import { galaxyTexture } from '../util/textures';

const R = 4500;
const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const ROT_X = new THREE.Matrix4();

/**
 * Sky dome centred on the camera: gradient + procedural star field (in shader)
 * + a galaxy billboard. Stars/galaxy are oriented by `skyYaw` so the scene
 * composition stays pleasing while the road winds.
 */
export class Sky {
  readonly group = new THREE.Group();
  private uniforms = {
    uZenith: { value: new THREE.Color() },
    uMid: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
    uGlowStrength: { value: 0.5 },
    uGlowDir: { value: new THREE.Vector3(0, 0, -1) },
    uStarRot: { value: new THREE.Matrix3() },
    uStarBright: { value: 1 },
    /** 0..1 night mode (DIM switch) */
    uDim: { value: 0 },
    uTime: { value: 0 },
  };
  private galaxy: THREE.Mesh;
  private m4 = new THREE.Matrix4();
  private drift = 0;
  private p!: ScenePreset;

  constructor(preset: ScenePreset) {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uZenith, uMid, uHorizon, uGlow, uGlowDir;
        uniform float uGlowStrength, uStarBright, uTime, uDim;
        uniform mat3 uStarRot;
        varying vec3 vDir;

        vec3 hash33(vec3 p) {
          p = fract(p * vec3(.1031, .1030, .0973));
          p += dot(p, p.yxz + 33.33);
          return fract((p.xxy + p.yxx) * p.zyx);
        }
        vec3 starLayer(vec3 d, float scale, float density) {
          vec3 p = d * scale;
          vec3 id = floor(p);
          vec3 h = hash33(id);
          if (h.x > density) return vec3(0.0);
          vec3 c = 0.25 + 0.5 * hash33(id + 17.0);
          float dist = length(fract(p) - c);
          float px = length(fwidth(p)) * 0.42;
          float big = pow(h.y, 8.0);
          float size = px * (0.8 + 2.0 * big);
          float tw = 0.7 + 0.3 * sin(uTime * (0.6 + h.z * 3.0) + h.y * 40.0);
          float core = 1.0 - smoothstep(0.0, size, dist);
          float halo = (1.0 - smoothstep(0.0, size * 4.0, dist)) * big * 0.25;
          vec3 tint = mix(vec3(1.0, 0.82, 0.68), vec3(0.72, 0.82, 1.0), h.z);
          return tint * (core + halo) * (0.25 + 0.75 * h.y) * tw;
        }
        void main() {
          vec3 d = normalize(vDir);
          float e = d.y;
          vec3 col = mix(uHorizon, uMid, smoothstep(-0.02, 0.22, e));
          col = mix(col, uZenith, smoothstep(0.22, 0.9, e));
          float band = 1.0 - smoothstep(0.0, 0.09, abs(e));
          float g = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), uGlowDir), 0.0), 10.0) * (1.0 - smoothstep(0.0, 0.3, abs(e)));
          col += uGlow * (g * 0.9 + band * 0.25) * uGlowStrength * (1.0 - 0.7 * uDim);
          col *= 1.0 - 0.55 * uDim;
          vec3 sd = uStarRot * d;
          vec3 st = starLayer(sd, 150.0, 0.10) + starLayer(sd, 320.0, 0.07) * 0.8 + starLayer(sd, 640.0, 0.06) * 0.55;
          col += st * smoothstep(-0.01, 0.12, e) * uStarBright * (1.0 - 0.75 * uDim);
          if (e < 0.0) col = mix(uHorizon, uHorizon * 0.4, smoothstep(0.0, 0.2, -e));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(R, 64, 32), mat);
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    this.group.add(dome);

    this.galaxy = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: galaxyTexture(1024), transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, fog: false, color: new THREE.Color(0.6, 0.6, 0.6),
      }),
    );
    this.galaxy.renderOrder = -9;
    this.galaxy.scale.setScalar(R * 0.62);
    this.galaxy.frustumCulled = false;
    this.group.add(this.galaxy);
    this.setPreset(preset);
  }

  setPreset(p: ScenePreset) {
    this.p = p;
    const u = this.uniforms;
    u.uZenith.value.set(p.sky.zenith);
    u.uMid.value.set(p.sky.mid);
    u.uHorizon.value.set(p.sky.horizon);
    u.uGlow.value.set(p.sky.glow);
    u.uGlowStrength.value = p.sky.glowStrength;
    u.uStarBright.value = p.sky.starBrightness;
    this.galaxy.visible = p.sky.galaxy;
  }

  /**
   * @param camPos camera position (render space)
   * @param skyYaw yaw the star field / galaxy is anchored to
   * @param roadDir horizontal direction to the road's vanishing point (world)
   */
  /** DIM switch: 0 = normal, 1 = dimmed night sky. */
  setDim(d: number) {
    this.uniforms.uDim.value = d;
    (this.galaxy.material as THREE.MeshBasicMaterial).color.setScalar(0.6 * (1 - 0.8 * d));
  }

  update(camPos: THREE.Vector3, skyYaw: number, roadDir: THREE.Vector3, t: number, dt: number) {
    this.group.position.copy(camPos);
    this.drift += this.p.sky.starDrift * dt;
    const u = this.uniforms;
    u.uTime.value = t;
    u.uGlowDir.value.copy(roadDir).setY(0).normalize();
    this.m4.makeRotationY(skyYaw).multiply(ROT_X.makeRotationX(this.drift));
    u.uStarRot.value.setFromMatrix4(this.m4);

    // galaxy: fixed in the (rotating) star frame, ~24° above the horizon, slightly left
    const yaw = skyYaw - 0.05, el = 0.36;
    this.galaxy.position.set(Math.sin(yaw) * Math.cos(el), Math.sin(el), -Math.cos(yaw) * Math.cos(el)).multiplyScalar(R * 0.9);
    // face the dome centre (+Z of the plane points inwards)
    this.galaxy.quaternion.setFromRotationMatrix(this.m4.lookAt(ORIGIN, this.galaxy.position, UP));
    this.galaxy.rotateZ(0.7);
  }
}

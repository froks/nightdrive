import * as THREE from 'three';

const N = 4000;
const BOX = { x: 50, y: 22, z: 70 };

/**
 * Falling rain streaks in a box around the camera (camera space), animated
 * entirely in the vertex shader. Streaks are stretched along the relative
 * velocity (gravity + driving speed) for a motion-blur look.
 */
export class Rain {
  readonly mesh: THREE.LineSegments;
  private uniforms = {
    uFall: { value: 0 },
    uDist: { value: 0 },
    uVel: { value: new THREE.Vector3(0, -9, 0) },
    uAmount: { value: 0 },
    uColor: { value: new THREE.Color(0.55, 0.62, 0.8) },
    fogColor: { value: new THREE.Color() },
    fogDensity: { value: 0 },
  };
  private fall = 0;
  private dist = 0;

  constructor() {
    const pos = new Float32Array(N * 2 * 3);
    const end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * BOX.x, y = Math.random() * BOX.y, z = Math.random() * BOX.z;
      for (let k = 0; k < 2; k++) {
        pos.set([x, y, z], (i * 2 + k) * 3);
        end[i * 2 + k] = k;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
        attribute float aEnd;
        uniform float uFall, uDist;
        uniform vec3 uVel;
        varying float vDepth;
        varying float vEnd;
        void main() {
          vec3 p = position;
          // wrap inside the box: falling (y) and approaching (z) as we drive
          p.y = mod(p.y - uFall, ${BOX.y.toFixed(1)}) - 3.0;
          p.z = mod(p.z + uDist, ${BOX.z.toFixed(1)}) - ${(BOX.z + 1.8).toFixed(1)};
          p -= uVel * 0.035 * aEnd;
          vEnd = aEnd;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor, fogColor;
        uniform float uAmount, fogDensity;
        varying float vDepth;
        varying float vEnd;
        void main() {
          float fog = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth * 4.0);
          float near = smoothstep(1.5, 4.0, vDepth);
          gl_FragColor = vec4(uColor * 0.2 * uAmount * (1.0 - fog) * near * (1.0 - 0.6 * vEnd), 1.0);
        }`,
    });
    this.mesh = new THREE.LineSegments(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  update(dt: number, amount: number, speed: number, fog: THREE.FogExp2 | null) {
    this.mesh.visible = amount > 0.001;
    if (!this.mesh.visible) return;
    this.fall = (this.fall + dt * 9) % BOX.y;
    this.dist = (this.dist + dt * speed) % BOX.z;
    const u = this.uniforms;
    u.uFall.value = this.fall;
    u.uDist.value = this.dist;
    u.uVel.value.set(0, -9, speed);
    u.uAmount.value = amount;
    if (fog) { u.fogColor.value.copy(fog.color); u.fogDensity.value = fog.density; }
  }
}

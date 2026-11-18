/* =========================================================
   WebGL layer (three.js) — inspired by lusion.co / igloo.inc
   1. Hero: real-time 3D solar tracker (bloom, mirror reflectors,
      light dust, energy particles driven by live power).
   2. Morph: scroll-driven particle morph sun -> tracker -> waveform.
   3. Outro: shader light rays behind the closing section.
   Purely visual. If WebGL or this module fails, the 2D canvas
   and static layouts in motion.js / styles.css remain.
   ========================================================= */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = window.matchMedia('(max-width: 720px)').matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const DPR = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 1.75);

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) { return false; }
}

function livePower() {
  const n = document.querySelector('[data-live="p"]');
  const v = n ? parseFloat(n.textContent.replace('−', '-')) : NaN;
  return Number.isFinite(v) ? v : null;
}

// Shared pointer (normalised -1..1)
const pointer = { x: 0, y: 0 };
window.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
}, { passive: true });

// Runs a render loop only while the element is on screen and the tab is visible
function visibilityLoop(el, tick) {
  let onScreen = false, raf = 0, last = performance.now();
  const loop = (t) => {
    raf = 0;
    if (!onScreen || document.hidden) return;
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    tick(t / 1000, dt);
    raf = requestAnimationFrame(loop);
  };
  const kick = () => { if (onScreen && !document.hidden && !raf) { last = performance.now(); raf = requestAnimationFrame(loop); } };
  new IntersectionObserver((en) => { onScreen = en[0].isIntersecting; kick(); }, { rootMargin: '100px' }).observe(el);
  document.addEventListener('visibilitychange', kick);
}

function softDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* =========================================================
   1. HERO — 3D tracker
   ========================================================= */
function initHero() {
  const preview = document.getElementById('preview');
  if (!preview) return;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(DPR);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.className = 'preview-canvas preview-gl';
  canvas.setAttribute('aria-hidden', 'true');
  preview.insertBefore(canvas, preview.firstChild);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x0a0b18, 9, 28);
  const camera = new THREE.PerspectiveCamera(34, 2, 0.1, 100);

  // Environment for mirror-like reflectors
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Sky dome with sun glow (raw sRGB values, no tone mapping)
  const v3 = (hex) => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); };
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    uniforms: { uTop: { value: v3('#04050B') }, uBottom: { value: v3('#2B2F5E') }, uGlow: { value: v3('#F6A93B') }, uSunDir: { value: new THREE.Vector3(0, 1, 0) } },
    vertexShader: 'varying vec3 vW; void main(){ vW = (modelMatrix*vec4(position,1.0)).xyz; gl_Position = projectionMatrix*viewMatrix*vec4(vW,1.0); }',
    fragmentShader: [
      'uniform vec3 uTop; uniform vec3 uBottom; uniform vec3 uGlow; uniform vec3 uSunDir; varying vec3 vW;',
      'void main(){ vec3 d = normalize(vW); float h = clamp(d.y*0.9+0.18, 0.0, 1.0);',
      ' vec3 col = mix(uBottom, uTop, smoothstep(0.0, 1.0, h));',
      ' float s = max(dot(d, normalize(uSunDir)), 0.0);',
      ' col += uGlow * (pow(s, 40.0)*0.9 + pow(s, 6.0)*0.25 + pow(s,2.0)*0.06);',
      ' gl_FragColor = vec4(col, 1.0); }'
    ].join('\n')
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(60, 48, 24), skyMat));

  // Ground + faint grid
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x07080f, roughness: 0.95, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const grid = new THREE.GridHelper(40, 60, 0x3a3f7a, 0x1d2042);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  grid.position.y = 0.002;
  scene.add(grid);

  // Lights
  scene.add(new THREE.HemisphereLight(0x8090ff, 0x05060c, 0.35));
  const sunLight = new THREE.DirectionalLight(0xffd6a0, 3.2);
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Sun (HDR colour so bloom catches it)
  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 16), new THREE.MeshBasicMaterial({ toneMapped: false }));
  sun.material.color.setRGB(4.2, 2.6, 1.1);
  scene.add(sun);

  // Tracker
  const tracker = new THREE.Group();
  tracker.rotation.y = 0;               // tilt axis points at the viewer, so the cell face stays visible
  scene.add(tracker);
  const metal = new THREE.MeshStandardMaterial({ color: 0xb8bccb, metalness: 0.8, roughness: 0.45, envMapIntensity: 0.45 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 1.3, 20), metal);
  post.position.y = 0.65;
  tracker.add(post);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.08, 32), metal);
  base.position.y = 0.04;
  tracker.add(base);
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 16), metal);
  axle.rotation.x = Math.PI / 2;
  axle.position.y = 1.32;
  tracker.add(axle);

  // Solar-cell texture
  const tc = document.createElement('canvas');
  tc.width = 1024; tc.height = 640;
  const g = tc.getContext('2d');
  g.fillStyle = '#c9ccd8'; g.fillRect(0, 0, tc.width, tc.height);
  const cols = 10, rows = 6, pad = 10, gap = 6;
  const cw = (tc.width - pad * 2 - gap * (cols - 1)) / cols, ch = (tc.height - pad * 2 - gap * (rows - 1)) / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = pad + c * (cw + gap), y = pad + r * (ch + gap);
    const lg = g.createLinearGradient(x, y, x + cw, y + ch);
    lg.addColorStop(0, '#1f3f8f'); lg.addColorStop(1, '#0b1a45');
    g.fillStyle = lg; g.fillRect(x, y, cw, ch);
    g.strokeStyle = 'rgba(200,215,255,.35)'; g.lineWidth = 1.5;
    for (let k = 1; k < 3; k++) { g.beginPath(); g.moveTo(x + (cw / 3) * k, y); g.lineTo(x + (cw / 3) * k, y + ch); g.stroke(); }
  }
  const cellTex = new THREE.CanvasTexture(tc);
  cellTex.colorSpace = THREE.SRGBColorSpace;
  cellTex.anisotropy = renderer.capabilities.getMaxAnisotropy();

  const panelPivot = new THREE.Group();
  panelPivot.position.y = 1.36;
  tracker.add(panelPivot);
  const panelTop = new THREE.MeshPhysicalMaterial({ map: cellTex, roughness: 0.16, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.3 });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xd8dbe6, metalness: 0.85, roughness: 0.35, envMapIntensity: 0.6 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.06, 1.35), [frameMat, frameMat, panelTop, frameMat, frameMat, frameMat]);
  panelPivot.add(panel);

  const mirror = new THREE.MeshStandardMaterial({ color: 0xe4e9ff, metalness: 0.92, roughness: 0.12, envMapIntensity: 1.1, emissive: 0x20264a, emissiveIntensity: 0.6 });
  const reflectorGeo = new THREE.BoxGeometry(0.95, 0.025, 1.35);
  const hinges = [-1, 1].map((side) => {
    const hinge = new THREE.Group();
    hinge.position.x = side * 1.1;
    hinge.rotation.z = side * 0.95;          // tilt outward and up
    const m = new THREE.Mesh(reflectorGeo, mirror);
    m.position.x = side * 0.475;
    hinge.add(m);
    panelPivot.add(hinge);
    return m;
  });

  // Light beams (sun -> panel, sun -> reflector -> panel)
  const beamMat = new THREE.LineBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  const beamGeo = new THREE.BufferGeometry();
  const beamPos = new Float32Array(6 * 3 * 2);
  beamGeo.setAttribute('position', new THREE.BufferAttribute(beamPos, 3));
  const beams = new THREE.LineSegments(beamGeo, beamMat);
  scene.add(beams);

  // Floating light dust
  const dot = softDotTexture();
  const dustN = small ? 260 : 600;
  const dustPos = new Float32Array(dustN * 3);
  const dustSeed = new Float32Array(dustN);
  for (let i = 0; i < dustN; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 12;
    dustPos[i * 3 + 1] = Math.random() * 5;
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * 8;
    dustSeed[i] = Math.random();
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.035, map: dot, color: 0xffd9a8, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(dust);

  // Energy particles: panel -> down the post -> along the ground toward the reading
  const eN = 160;
  const ePos = new Float32Array(eN * 3);
  const eState = Array.from({ length: eN }, () => ({ s: Math.random(), alive: false, j: (Math.random() - 0.5) * 0.12 }));
  const eGeo = new THREE.BufferGeometry();
  eGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
  const energy = new THREE.Points(eGeo, new THREE.PointsMaterial({ size: 0.09, map: dot, color: 0xffc46b, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  energy.material.color.setRGB(2.2, 1.4, 0.5);
  energy.material.toneMapped = false;
  scene.add(energy);
  let spawnAcc = 0;

  // Post-processing
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), small ? 0.6 : 0.8, 0.6, 0.93);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function resize() {
    const r = preview.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    composer.setPixelRatio(DPR);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 50 : 34;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(preview);
  resize();

  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  let mx = 0, my = 0, panelAng = 0;

  function frame(time, dt) {
    // Sun path east -> west (illustrative)
    const u = reduced ? 0.4 : (time % 20) / 20;
    const th = (160 - 140 * u) * Math.PI / 180;
    const R = 5.4;
    sun.position.set(R * Math.cos(th), R * Math.sin(th) * 0.62 + 1.0, -2.2);
    skyMat.uniforms.uSunDir.value.copy(sun.position).normalize();
    sunLight.position.copy(sun.position);
    sunLight.target.position.set(0, 1.3, 0);

    // Single-axis tracking: panel normal points at the sun (mechanically limited)
    // sun direction in the tracker's local frame (tracker is rotated about Y)
    const cy = Math.cos(-tracker.rotation.y), sy = Math.sin(-tracker.rotation.y);
    const dx = sun.position.x * cy + sun.position.z * sy, dy = sun.position.y - 1.36;
    const target = clamp(-Math.atan2(dx, dy), -0.85, 0.85);
    panelAng = lerp(panelAng, target, 1 - Math.pow(0.02, dt));
    panelPivot.rotation.z = panelAng;

    // Camera: pointer parallax + scroll orbit
    const r = preview.getBoundingClientRect();
    const sp = clamp(1 - (r.top + r.height * 0.5) / window.innerHeight, -0.5, 1.2);
    mx = lerp(mx, pointer.x, 0.05); my = lerp(my, pointer.y, 0.05);
    const orbit = (sp - 0.35) * 0.4 + mx * 0.22;
    const dist = 8.4 - sp * 1.0;
    camera.position.set(Math.sin(orbit) * dist, 4.3 - my * 0.45 + sp * 0.4, Math.cos(orbit) * dist);
    camera.lookAt(-0.3, 1.45, 0);

    // Beams
    panelPivot.updateMatrixWorld(true);
    panel.getWorldPosition(tmpA);
    let k = 0;
    const put = (a, b) => { beamPos[k++] = a.x; beamPos[k++] = a.y; beamPos[k++] = a.z; beamPos[k++] = b.x; beamPos[k++] = b.y; beamPos[k++] = b.z; };
    put(sun.position, tmpA);
    hinges.forEach((m) => { m.getWorldPosition(tmpB); put(sun.position, tmpB); put(tmpB, tmpA); });
    while (k < beamPos.length) beamPos[k++] = 0;
    beamGeo.attributes.position.needsUpdate = true;
    beamMat.opacity = 0.22 + 0.12 * Math.sin(time * 2);

    // Dust drift
    for (let i = 0; i < dustN; i++) {
      dustPos[i * 3 + 1] += dt * (0.05 + dustSeed[i] * 0.08);
      dustPos[i * 3] += Math.sin(time * 0.3 + dustSeed[i] * 20) * dt * 0.05;
      if (dustPos[i * 3 + 1] > 5) dustPos[i * 3 + 1] = 0;
    }
    dustGeo.attributes.position.needsUpdate = true;

    // Energy flow follows live power; no data => no particles
    const pw = livePower();
    if (!reduced && pw !== null && pw > 0) spawnAcc += dt * clamp(pw * 22, 3, 60);
    const speed = 0.25 + clamp(pw || 0, 0, 3) * 0.35;
    for (let i = 0; i < eN; i++) {
      const q = eState[i];
      if (!q.alive && spawnAcc >= 1) { q.alive = true; q.s = 0; spawnAcc -= 1; }
      if (!q.alive) { ePos[i * 3 + 1] = -10; continue; }
      q.s += dt * speed * 0.45;
      if (q.s >= 1) { q.alive = false; ePos[i * 3 + 1] = -10; continue; }
      // path: panel centre (0,1.36) -> post bottom (0,0.05) -> ground toward camera-left
      if (q.s < 0.35) { const t = q.s / 0.35; tmpC.set(q.j * 0.3, lerp(1.36, 0.06, t), q.j * 0.3); }
      else { const t = (q.s - 0.35) / 0.65; tmpC.set(lerp(0, -3.2, t) + q.j, 0.06, lerp(0, 2.6, t) + q.j); }
      ePos[i * 3] = tmpC.x; ePos[i * 3 + 1] = tmpC.y; ePos[i * 3 + 2] = tmpC.z;
    }
    spawnAcc = Math.min(spawnAcc, 4);
    eGeo.attributes.position.needsUpdate = true;

    composer.render(dt);
  }

  preview.classList.add('webgl-on');
  if (reduced) { frame(0, 0.016); window.addEventListener('resize', () => setTimeout(() => frame(0, 0.016), 50)); }
  else visibilityLoop(preview, frame);
}

/* =========================================================
   2. MORPH — scroll-driven particles: sun -> tracker -> waveform
   ========================================================= */
function initMorph() {
  const section = document.getElementById('morph');
  if (!section) return;
  const holder = section.querySelector('.morph-sticky');
  const steps = Array.from(section.querySelectorAll('.morph-steps li'));
  const bar = section.querySelector('.morph-progress i');

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setPixelRatio(DPR);
  const canvas = renderer.domElement;
  canvas.className = 'morph-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  holder.insertBefore(canvas, holder.firstChild);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 2, 0.1, 50);
  camera.position.set(0, 0, 7.5);

  const N = small ? 5000 : 11000;
  const A = new Float32Array(N * 3), B = new Float32Array(N * 3), C = new Float32Array(N * 3);
  const cA = new Float32Array(N * 3), cB = new Float32Array(N * 3), cC = new Float32Array(N * 3);
  const rnd = new Float32Array(N);
  const setC = (arr, i, hex, m) => { const c = new THREE.Color(hex); arr[i * 3] = c.r * m; arr[i * 3 + 1] = c.g * m; arr[i * 3 + 2] = c.b * m; };
  const set = (arr, i, x, y, z) => { arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z; };
  const sph = () => { const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u); return [s * Math.cos(t), u, s * Math.sin(t)]; };
  const waveY = (x) => 0.75 * Math.sin(x * 1.25 + 0.6) + 0.28 * Math.sin(x * 3.2 + 1.3) + 0.12 * Math.sin(x * 7.0);

  for (let i = 0; i < N; i++) {
    rnd[i] = Math.random();
    const q = Math.random();

    // A: the sun — dense sphere + corona flares
    let [x, y, z] = sph();
    if (q < 0.82) { const r = 1.55 * Math.pow(Math.random(), 0.15); set(A, i, x * r + 1.2, y * r + 0.2, z * r); setC(cA, i, Math.random() < 0.5 ? '#FFE3A8' : '#F6A93B', 1); }
    else { const r = 1.6 + Math.pow(Math.random(), 2) * 1.6; set(A, i, x * r + 1.2, y * r + 0.2, z * r); setC(cA, i, '#FF7A2E', 0.55); }

    // B: the tracker — tilted panel with cells, two reflectors, post, small sun
    const tilt = -0.35, ct = Math.cos(tilt), st = Math.sin(tilt);
    const rotZ = (px, py) => [px * ct - py * st, px * st + py * ct];
    if (q < 0.6) {
      let px = (Math.random() - 0.5) * 3.2, pz = (Math.random() - 0.5) * 2.0;
      const line = Math.random() < 0.35;
      if (line) { if (Math.random() < 0.5) px = Math.round(px / 0.32) * 0.32; else pz = Math.round(pz / 0.33) * 0.33; }
      const [rx, ry] = rotZ(px, 0);
      set(B, i, rx + 0.6, ry + 0.25, pz);
      setC(cB, i, line ? '#C8D4FF' : (Math.random() < 0.5 ? '#3E63E0' : '#6E8FFF'), line ? 1 : 0.9);
    } else if (q < 0.85) {
      const side = Math.random() < 0.5 ? -1 : 1, along = Math.random() * 1.15, pz = (Math.random() - 0.5) * 2.0;
      const ang = side * 0.95;
      const hx = side * 1.6, hy = 0;
      const lx = hx + side * along * Math.cos(ang), ly = hy + along * Math.abs(Math.sin(ang));
      const [rx, ry] = rotZ(lx, ly);
      set(B, i, rx + 0.6, ry + 0.25, pz);
      setC(cB, i, '#EEF0FF', 0.85);
    } else if (q < 0.94) {
      set(B, i, 0.6 + (Math.random() - 0.5) * 0.08, 0.25 - Math.random() * 1.9, (Math.random() - 0.5) * 0.08);
      setC(cB, i, '#9AA0C0', 0.8);
    } else {
      const [sx, sy, sz] = sph(); const r = 0.35 * Math.random();
      set(B, i, sx * r - 2.4, sy * r + 1.7, sz * r);
      setC(cB, i, '#FFD08A', 1.2);
    }

    // C: measurement — glowing waveform, axes and faint bars
    if (q < 0.62) {
      const px = (Math.random() - 0.5) * 5.6;
      set(C, i, px, waveY(px) + (Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.25);
      setC(cC, i, Math.random() < 0.7 ? '#2FE0B6' : '#BFFFF0', 1);
    } else if (q < 0.8) {
      const px = Math.round(((Math.random() - 0.5) * 5.6) / 0.28) * 0.28;
      const top = waveY(px);
      set(C, i, px + (Math.random() - 0.5) * 0.04, -1.5 + Math.random() * (top + 1.5), (Math.random() - 0.5) * 0.2);
      setC(cC, i, '#F6A93B', 0.35);
    } else if (q < 0.9) {
      set(C, i, (Math.random() - 0.5) * 5.8, -1.5, 0);
      setC(cC, i, '#FFFFFF', 0.45);
    } else {
      set(C, i, -2.9, -1.5 + Math.random() * 3.0, 0);
      setC(cC, i, '#FFFFFF', 0.45);
    }
  }

  // Fit shapes: tracker a little smaller and centred, waveform smaller and nudged right
  for (let i = 0; i < N; i++) {
    B[i * 3] = (B[i * 3] - 0.5) * 0.82; B[i * 3 + 1] = B[i * 3 + 1] * 0.82 - 0.1; B[i * 3 + 2] *= 0.82;
    C[i * 3] = C[i * 3] * 0.78 + 0.35; C[i * 3 + 1] *= 0.8; C[i * 3 + 2] *= 0.8;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(A, 3));
  geo.setAttribute('aB', new THREE.BufferAttribute(B, 3));
  geo.setAttribute('aC', new THREE.BufferAttribute(C, 3));
  geo.setAttribute('cA', new THREE.BufferAttribute(cA, 3));
  geo.setAttribute('cB', new THREE.BufferAttribute(cB, 3));
  geo.setAttribute('cC', new THREE.BufferAttribute(cC, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uP: { value: 0 }, uTime: { value: 0 }, uSize: { value: small ? 38 : 46 }, uPixel: { value: DPR }, uAmp: { value: 1 } },
    vertexShader: [
      'attribute vec3 aB; attribute vec3 aC; attribute vec3 cA; attribute vec3 cB; attribute vec3 cC; attribute float aRand;',
      'uniform float uP; uniform float uTime; uniform float uSize; uniform float uPixel; uniform float uAmp;',
      'varying vec3 vColor; varying float vAlpha;',
      'void main(){',
      '  float t1 = smoothstep(0.0, 1.0, clamp(uP*1.4 - aRand*0.4, 0.0, 1.0));',
      '  float t2 = smoothstep(0.0, 1.0, clamp((uP-1.0)*1.4 - aRand*0.4, 0.0, 1.0));',
      '  vec3 c3 = aC; c3.y *= uAmp;',
      '  vec3 p = mix(mix(position, aB, t1), c3, t2);',
      '  float mid = sin(3.14159*t1) + sin(3.14159*t2);',
      '  p += vec3(sin(uTime*0.8 + aRand*40.0), cos(uTime*0.9 + aRand*31.0), sin(uTime*0.7 + aRand*53.0)) * (0.015 + 0.55*mid);',
      '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  gl_PointSize = uSize * uPixel * (0.45 + aRand*0.75) / -mv.z;',
      '  vColor = mix(mix(cA, cB, t1), cC, t2);',
      '  vAlpha = 0.5 + 0.5*aRand;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'varying vec3 vColor; varying float vAlpha;',
      'void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;',
      '  float a = smoothstep(0.5, 0.0, r); gl_FragColor = vec4(vColor * a, a * vAlpha); }'
    ].join('\n')
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  function resize() {
    const w = holder.clientWidth, h = holder.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Push the shapes right on wide screens so the copy on the left stays readable
    camera.setViewOffset(w, h, w > 900 ? -w * 0.19 : 0, w > 900 ? 0 : -h * 0.2, w, h);
    camera.position.z = w / h < 1 ? 14 : 7.5;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(holder);
  resize();

  let p = 0, mx = 0, my = 0, lastStep = -1;
  function frame(time, dt) {
    const r = section.getBoundingClientRect();
    const total = r.height - window.innerHeight;
    const target = clamp(-r.top / Math.max(1, total), 0, 1) * 2;
    p = reduced ? target : lerp(p, target, 1 - Math.pow(0.001, dt));
    mat.uniforms.uP.value = p;
    mat.uniforms.uTime.value = time;
    const pw = livePower();
    mat.uniforms.uAmp.value = lerp(mat.uniforms.uAmp.value, pw === null ? 0.85 : 0.75 + clamp(pw, 0, 1.5) * 0.25, 0.05);

    mx = lerp(mx, pointer.x, 0.04); my = lerp(my, pointer.y, 0.04);
    const settle = clamp(p - 1, 0, 1);                         // waveform faces the viewer
    points.rotation.y = (Math.sin(time * 0.25) * 0.35 + mx * 0.5) * (1 - settle * 0.85) + (p < 1 ? time * 0.08 * (1 - p) : 0);
    const tB = clamp(1 - Math.abs(p - 1), 0, 1);               // tracker stage: tilt so the panel face is visible
    points.rotation.x = (my * 0.25 + 0.15 * (1 - settle)) * (1 - settle * 0.7) + 0.62 * tB;

    const step = p < 0.66 ? 0 : p < 1.4 ? 1 : 2;
    if (step !== lastStep) {
      steps.forEach((li, i) => li.classList.toggle('is-active', i === step));
      lastStep = step;
    }
    if (bar) bar.style.transform = 'scaleX(' + (p / 2).toFixed(3) + ')';
    renderer.render(scene, camera);
  }

  section.classList.add('morph-live');
  if (reduced) {
    // Static fallback layout keeps all three steps visible; render one still frame of the tracker
    section.classList.remove('morph-live');
    canvas.remove();
    return;
  }
  visibilityLoop(section, frame);
}

/* =========================================================
   3. OUTRO — shader light rays
   ========================================================= */
function initOutro() {
  const outro = document.querySelector('.outro');
  if (!outro) return;
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(DPR, 1.25));
  const canvas = renderer.domElement;
  canvas.className = 'outro-gl';
  canvas.setAttribute('aria-hidden', 'true');
  outro.insertBefore(canvas, outro.querySelector('.outro-inner'));
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uMouse: { value: new THREE.Vector2(0.5, 0.5) } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: [
      'uniform float uTime; uniform vec2 uRes; uniform vec2 uMouse; varying vec2 vUv;',
      'float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }',
      'float n(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);',
      '  return mix(mix(h(i),h(i+vec2(1.0,0.0)),u.x), mix(h(i+vec2(0.0,1.0)),h(i+vec2(1.0,1.0)),u.x), u.y); }',
      'void main(){',
      '  vec2 uv = vUv; float asp = uRes.x / uRes.y;',
      '  vec2 src = vec2(0.5 + (uMouse.x - 0.5) * 0.18, 1.06);',
      '  vec2 d = uv - src; d.x *= asp;',
      '  float ang = atan(d.x, -d.y); float dist = length(d);',
      '  float rays = n(vec2(ang*7.0, uTime*0.22))*0.6 + n(vec2(ang*19.0, -uTime*0.35))*0.4;',
      '  rays = pow(rays, 2.4);',
      '  float fall = exp(-dist*1.35);',
      '  vec3 amber = vec3(0.965,0.663,0.231); vec3 indigo = vec3(0.36,0.35,0.62);',
      '  vec3 col = mix(indigo, amber, smoothstep(1.0, 0.15, dist)) * rays * fall * 1.5;',
      '  col += amber * exp(-dist*5.0) * 0.55;',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n')
  });
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  let mx = 0.5;
  function resize() {
    const w = outro.clientWidth, h = outro.clientHeight;
    renderer.setSize(w, h, false);
    mat.uniforms.uRes.value.set(w, h);
  }
  new ResizeObserver(resize).observe(outro);
  resize();
  const frame = (time) => {
    mx = lerp(mx, pointer.x * 0.5 + 0.5, 0.04);
    mat.uniforms.uMouse.value.set(mx, 0.5);
    mat.uniforms.uTime.value = time;
    renderer.render(scene, cam);
  };
  outro.classList.add('outro-live');
  if (reduced) frame(3); else visibilityLoop(outro, frame);
}

/* ---------------- Boot ---------------- */
function boot() {
  if (!webglAvailable()) { window.dispatchEvent(new CustomEvent('webgl:done', { detail: { ok: false } })); return; }
  const parts = [initHero, initMorph, initOutro];
  let ok = true;
  parts.forEach((fn) => { try { fn(); } catch (e) { ok = false; console.warn('[webgl] ' + fn.name + ' failed:', e); } });
  window.dispatchEvent(new CustomEvent('webgl:done', { detail: { ok } }));
}
boot();

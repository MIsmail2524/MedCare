import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Organ } from '@medcare/engine';

// Procedural holographic human digital twin. Organs glow with therapeutic engagement (blue) and
// pulse red with predicted toxicity; drug "molecules" flow GI → liver (first pass) → blood →
// tissues → metabolism / renal excretion in proportion to the simulated mass balance.

export type Compartment = 'gut' | 'firstPass' | 'plasma' | 'tissue' | 'metabolised' | 'excreted';
export const COMPARTMENTS: Compartment[] = ['gut', 'firstPass', 'plasma', 'tissue', 'metabolised', 'excreted'];

export interface Callout {
  organ: Organ;
  label: string;
  severity: 'mild' | 'moderate' | 'severe';
}

export interface BodyFrame {
  organs: Record<Organ, { therapeutic: number; risk: number }>;
  /** Fraction (0–1) of the total administered dose in each compartment at this instant. */
  journey: Record<Compartment, number>;
  /** Fraction of the eventual total dose that has been administered so far. */
  dosedFraction: number;
  heartRate: number;
  breathing: number; // 0..1 respiratory drive
  callouts: Callout[];
  targetOrgans: Organ[];
}

export interface Layers {
  skin: boolean;
  muscle: boolean;
  skeleton: boolean;
  vessels: boolean;
}

interface Props {
  /** Anatomical model (BodyParts3D-derived GLB). Falls back to procedural organs if it fails to load. */
  anatomyUrl?: string;
  layers?: Layers;
  onAnatomyStatus?: (s: 'loading' | 'ready' | 'fallback') => void;
  frame: BodyFrame;
  drugColor: string;
  highlight?: Organ | null;
  onHoverOrgan?: (o: Organ | null) => void;
  height?: number;
  autoRotate?: boolean;
}

const N = 700;
const ORGAN_POS: Record<Organ, [number, number, number]> = {
  brain: [0, 0.755, 0.005],
  thyroid: [0, 0.565, 0.045],
  lungs: [0, 0.34, 0.0],
  heart: [0.028, 0.29, 0.045],
  liver: [-0.06, 0.175, 0.035],
  pancreas: [0.02, 0.115, 0.0],
  gi: [0.0, 0.02, 0.04],
  kidneys: [0.0, 0.1, -0.045],
  blood: [0.0, 0.2, -0.02],
  muscle: [0.065, -0.42, 0.0],
  skin: [0.17, 0.25, 0.05],
};

function cssColor(v: string): THREE.Color {
  // Resolve CSS custom properties like "var(--s1)" to concrete colours.
  const m = /var\((--[^)]+)\)/.exec(v);
  const raw = m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() : v;
  try {
    return new THREE.Color(raw || '#3987e5');
  } catch {
    return new THREE.Color('#3987e5');
  }
}

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function BodyTwin3D({ frame, drugColor, highlight, onHoverOrgan, height = 620, autoRotate = true, anatomyUrl = '/models/anatomy.glb', layers, onAnatomyStatus }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const frameRef = useRef(frame);
  const colorRef = useRef(drugColor);
  const hlRef = useRef<Organ | null>(highlight ?? null);
  const hoverCb = useRef(onHoverOrgan);
  const rotRef = useRef(autoRotate);
  const [supported] = useState(webglAvailable);
  frameRef.current = frame;
  colorRef.current = drugColor;
  hlRef.current = highlight ?? null;
  hoverCb.current = onHoverOrgan;
  rotRef.current = autoRotate;
  const layersRef = useRef<Layers>(layers ?? { skin: true, muscle: false, skeleton: true, vessels: true });
  layersRef.current = layers ?? layersRef.current;
  const statusCb = useRef(onAnatomyStatus);
  statusCb.current = onAnatomyStatus;

  useEffect(() => {
    if (!supported || !mount.current) return;
    const el = mount.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, el.clientWidth / el.clientHeight, 0.01, 20);
    camera.position.set(0, 0.25, 3.1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.12, 0);
    controls.enableDamping = true;
    controls.minDistance = 0.8;
    controls.maxDistance = 4.5;
    controls.enablePan = false;
    controls.autoRotateSpeed = 0.9;

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1.5, 2, 2.5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x66ccff, 0.8);
    rim.position.set(-2, 1, -2);
    scene.add(rim);

    const disposables: { dispose: () => void }[] = [];
    const track = <T extends { dispose: () => void }>(x: T) => {
      disposables.push(x);
      return x;
    };

    // ---------- holographic skin shell
    const shell = new THREE.Group();
    const skinMat = track(
      new THREE.MeshPhysicalMaterial({ color: 0x7fd3ff, transparent: true, opacity: 0.1, roughness: 0.3, metalness: 0, depthWrite: false, side: THREE.DoubleSide, emissive: 0x0b4a6f, emissiveIntensity: 0.35 }),
    );
    const edgeMat = track(new THREE.LineBasicMaterial({ color: 0x7fd3ff, transparent: true, opacity: 0.18 }));
    const addShell = (geo: THREE.BufferGeometry, pos: THREE.Vector3, rot?: THREE.Euler) => {
      track(geo);
      const m = new THREE.Mesh(geo, skinMat);
      m.position.copy(pos);
      if (rot) m.rotation.copy(rot);
      m.userData.organ = 'skin';
      shell.add(m);
      const wire = new THREE.LineSegments(track(new THREE.WireframeGeometry(geo)), edgeMat);
      wire.position.copy(pos);
      if (rot) wire.rotation.copy(rot);
      wire.scale.setScalar(1.001);
      shell.add(wire);
      return m;
    };
    const torsoProfile = [
      [0.0, -0.13], [0.15, -0.13], [0.165, -0.06], [0.15, 0.04], [0.14, 0.14], [0.155, 0.28], [0.175, 0.4], [0.17, 0.47], [0.12, 0.52], [0.05, 0.55], [0.0, 0.555],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const torso = addShell(new THREE.LatheGeometry(torsoProfile, 28), v(0, 0, 0));
    torso.scale.set(1, 1, 0.62);
    shell.children[shell.children.length - 1].scale.set(1, 1, 0.62);
    addShell(new THREE.SphereGeometry(0.105, 24, 18), v(0, 0.72, 0)).scale.set(0.92, 1.08, 1);
    addShell(new THREE.CylinderGeometry(0.045, 0.055, 0.1, 16), v(0, 0.6, 0));
    const limb = (len: number, r: number) => new THREE.CapsuleGeometry(r, len, 6, 14);
    addShell(limb(0.3, 0.042), v(-0.215, 0.32, 0), new THREE.Euler(0, 0, -0.18));
    addShell(limb(0.3, 0.042), v(0.215, 0.32, 0), new THREE.Euler(0, 0, 0.18));
    addShell(limb(0.28, 0.035), v(-0.27, -0.02, 0.02), new THREE.Euler(0, 0, -0.08));
    addShell(limb(0.28, 0.035), v(0.27, -0.02, 0.02), new THREE.Euler(0, 0, 0.08));
    addShell(limb(0.38, 0.065), v(-0.075, -0.38, 0), new THREE.Euler(0, 0, 0.03));
    addShell(limb(0.38, 0.065), v(0.075, -0.38, 0), new THREE.Euler(0, 0, -0.03));
    addShell(limb(0.36, 0.045), v(-0.085, -0.8, -0.01));
    addShell(limb(0.36, 0.045), v(0.085, -0.8, -0.01));
    scene.add(shell);

    // ---------- organs
    const organMeshes: THREE.Mesh[] = [];
    const organMats: Partial<Record<Organ, THREE.MeshStandardMaterial[]>> = {};
    const base: Record<Organ, number> = {
      brain: 0xe8a3b8, thyroid: 0xd97a6a, heart: 0xd9534f, lungs: 0xe49aa6, liver: 0x9c3d2e, pancreas: 0xe3b778, gi: 0xe6a583, kidneys: 0xa3423a, blood: 0xc0392b, muscle: 0xb5524b, skin: 0x7fd3ff,
    };
    const addOrgan = (organ: Organ, geo: THREE.BufferGeometry, pos: THREE.Vector3, scale: THREE.Vector3, rot?: THREE.Euler, opacity = 0.92) => {
      track(geo);
      const mat = track(new THREE.MeshStandardMaterial({ color: base[organ], roughness: 0.55, metalness: 0.05, transparent: true, opacity, emissive: 0x000000 }));
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(pos);
      m.scale.copy(scale);
      if (rot) m.rotation.copy(rot);
      m.userData.organ = organ;
      m.userData.baseScale = scale.clone();
      scene.add(m);
      organMeshes.push(m);
      (organMats[organ] ??= []).push(mat);
      return m;
    };
    const sphere = track(new THREE.SphereGeometry(1, 28, 20));
    addOrgan('brain', sphere.clone(), v(...ORGAN_POS.brain), v(0.083, 0.068, 0.092));
    addOrgan('thyroid', new THREE.TorusGeometry(0.018, 0.008, 8, 16, Math.PI * 1.3), v(0, 0.565, 0.035), v(1, 1, 1), new THREE.Euler(0, 0, Math.PI * 1.15));
    let lungL = addOrgan('lungs', sphere.clone(), v(-0.078, 0.345, 0.0), v(0.064, 0.115, 0.06), undefined, 0.75);
    let lungR = addOrgan('lungs', sphere.clone(), v(0.078, 0.345, 0.0), v(0.058, 0.11, 0.058), undefined, 0.75);
    let heart = addOrgan('heart', sphere.clone(), v(...ORGAN_POS.heart), v(0.042, 0.05, 0.04), new THREE.Euler(0, 0, -0.5));
    addOrgan('liver', sphere.clone(), v(...ORGAN_POS.liver), v(0.105, 0.048, 0.065), new THREE.Euler(0, 0, -0.18));
    addOrgan('gi', sphere.clone(), v(0.065, 0.16, 0.04), v(0.05, 0.038, 0.035), new THREE.Euler(0, 0, 0.5)); // stomach
    addOrgan('pancreas', new THREE.CapsuleGeometry(0.012, 0.09, 4, 10), v(...ORGAN_POS.pancreas), v(1, 1, 1), new THREE.Euler(0, 0, Math.PI / 2 - 0.15));
    addOrgan('kidneys', sphere.clone(), v(-0.062, 0.1, -0.045), v(0.024, 0.04, 0.02), new THREE.Euler(0, 0, 0.2));
    addOrgan('kidneys', sphere.clone(), v(0.062, 0.1, -0.045), v(0.024, 0.04, 0.02), new THREE.Euler(0, 0, -0.2));
    let bladder = addOrgan('kidneys', sphere.clone(), v(0, -0.115, 0.035), v(0.03, 0.026, 0.026), undefined, 0.6);
    // intestines: coiled tube
    const coil: THREE.Vector3[] = [];
    for (let i = 0; i <= 90; i++) {
      const t = i / 90;
      const a = t * Math.PI * 9;
      coil.push(v(Math.cos(a) * (0.075 - 0.02 * Math.sin(t * 7)), 0.075 - t * 0.15, 0.045 + Math.sin(a) * 0.02));
    }
    const coilCurve = new THREE.CatmullRomCurve3(coil);
    addOrgan('gi', new THREE.TubeGeometry(coilCurve, 240, 0.011, 8, false), v(0, 0, 0), v(1, 1, 1), undefined, 0.85);
    addOrgan('muscle', new THREE.CapsuleGeometry(0.045, 0.3, 4, 12), v(-0.075, -0.39, 0), v(1, 1, 1), undefined, 0.35);
    addOrgan('muscle', new THREE.CapsuleGeometry(0.045, 0.3, 4, 12), v(0.075, -0.39, 0), v(1, 1, 1), undefined, 0.35);

    // vessels (blood)
    const vessel = (pts: THREE.Vector3[], r: number, color = 0xc0392b) => {
      const curve = new THREE.CatmullRomCurve3(pts);
      const mesh = addOrgan('blood', new THREE.TubeGeometry(curve, 80, r, 6, false), v(0, 0, 0), v(1, 1, 1), undefined, 0.7);
      (mesh.material as THREE.MeshStandardMaterial).color.setHex(color);
      return curve;
    };
    vessel([v(0.02, 0.3, 0.03), v(0.03, 0.38, 0.0), v(0.005, 0.36, -0.035), v(-0.005, 0.2, -0.04), v(0, 0.0, -0.035), v(0, -0.12, -0.02), v(-0.07, -0.3, 0.0), v(-0.08, -0.7, 0.0)], 0.007);
    vessel([v(0, -0.12, -0.02), v(0.07, -0.3, 0.0), v(0.08, -0.7, 0.0)], 0.006);
    vessel([v(-0.02, 0.27, 0.02), v(-0.025, 0.1, -0.02), v(-0.02, -0.1, -0.01)], 0.007, 0x2e6fb5);
    vessel([v(0.01, 0.38, 0.0), v(0.03, 0.56, 0.01), v(0.03, 0.7, 0.0)], 0.004);
    vessel([v(0.01, 0.38, 0.0), v(-0.03, 0.56, 0.01), v(-0.03, 0.7, 0.0)], 0.004);
    vessel([v(0.02, 0.38, -0.01), v(0.15, 0.45, 0), v(0.22, 0.25, 0), v(0.28, -0.12, 0.02)], 0.004);
    vessel([v(-0.02, 0.38, -0.01), v(-0.15, 0.45, 0), v(-0.22, 0.25, 0), v(-0.28, -0.12, 0.02)], 0.004);
    // portal vein: intestine → liver
    vessel([v(0.0, 0.03, 0.03), v(-0.02, 0.1, 0.03), v(-0.05, 0.16, 0.035)], 0.005, 0x7b4fa0);

    // ---------- particle paths
    let giPath = new THREE.CatmullRomCurve3([v(0, 0.68, 0.085), v(0, 0.6, 0.03), v(0.005, 0.45, 0.0), v(0.03, 0.25, 0.01), v(0.065, 0.165, 0.04), v(0.03, 0.12, 0.05), ...coil.slice(0, 91).filter((_, i) => i % 3 === 0)]);
    let loops = [
      new THREE.CatmullRomCurve3([v(0.028, 0.29, 0.045), v(0.03, 0.38, 0.0), v(0.0, 0.3, -0.04), v(0, 0.0, -0.035), v(0, -0.12, -0.02), v(-0.07, -0.3, 0.0), v(-0.08, -0.75, 0.0), v(-0.06, -0.3, 0.02), v(-0.02, -0.1, 0.0), v(-0.02, 0.12, -0.02)], true),
      new THREE.CatmullRomCurve3([v(0.028, 0.29, 0.045), v(0.03, 0.38, 0.0), v(0, -0.12, -0.02), v(0.07, -0.3, 0.0), v(0.08, -0.75, 0.0), v(0.06, -0.3, 0.02), v(0.02, -0.1, 0.0), v(-0.02, 0.12, -0.02)], true),
      new THREE.CatmullRomCurve3([v(0.028, 0.29, 0.045), v(0.03, 0.45, 0.0), v(0.03, 0.72, 0.0), v(0, 0.8, 0.0), v(-0.03, 0.72, 0.0), v(-0.03, 0.45, 0.0)], true),
      new THREE.CatmullRomCurve3([v(0.028, 0.29, 0.045), v(0.15, 0.45, 0), v(0.22, 0.25, 0), v(0.28, -0.12, 0.02), v(0.24, 0.2, 0.02), v(0.1, 0.4, 0.0)], true),
      new THREE.CatmullRomCurve3([v(0.028, 0.29, 0.045), v(-0.15, 0.45, 0), v(-0.22, 0.25, 0), v(-0.28, -0.12, 0.02), v(-0.24, 0.2, 0.02), v(-0.1, 0.4, 0.0)], true),
      new THREE.CatmullRomCurve3([v(0.028, 0.29, 0.045), v(-0.04, 0.2, 0.03), v(-0.06, 0.175, 0.035), v(0.05, 0.1, -0.045), v(-0.05, 0.1, -0.045), v(0.0, 0.2, 0.0)], true),
    ];

    const positions = new Float32Array(N * 3);
    const colors = new Float32Array(N * 3);
    const sizes = new Float32Array(N);
    const geom = track(new THREE.BufferGeometry());
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const pMat = track(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
        uniforms: { scale: { value: renderer.getPixelRatio() * 72 } },
        vertexShader: `attribute float size; varying vec3 vColor; uniform float scale;
          void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `varying vec3 vColor; void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard; float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vColor * (0.6 + a), a); }`,
      }),
    );
    const points = new THREE.Points(geom, pMat);
    points.frustumCulled = false;
    scene.add(points);

    type PState = { comp: Compartment | 'inactive'; seed: number; loop: number; off: THREE.Vector3; target: number };
    const ps: PState[] = Array.from({ length: N }, (_, i) => ({
      comp: 'inactive',
      seed: Math.random(),
      loop: i % 4,
      off: v((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2),
      target: Math.floor(Math.random() * 1000),
    }));
    for (let i = 0; i < N; i++) {
      const p = giPath.getPointAt(0);
      positions.set([p.x, p.y, p.z], i * 3);
    }

    const PREFER: Record<Compartment, (Compartment | 'inactive')[]> = {
      gut: ['inactive'],
      firstPass: ['gut'],
      plasma: ['gut', 'inactive', 'tissue'],
      tissue: ['plasma'],
      metabolised: ['plasma', 'firstPass', 'tissue'],
      excreted: ['plasma'],
    };
    const reassign = () => {
      const f = frameRef.current;
      const active = Math.round(N * Math.min(1, Math.max(0, f.dosedFraction)));
      const want: Record<string, number> = { inactive: N - active };
      let acc = 0;
      COMPARTMENTS.forEach((c, i) => {
        const n = i === COMPARTMENTS.length - 1 ? active - acc : Math.round(active * Math.max(0, f.journey[c]));
        want[c] = Math.max(0, Math.min(n, active - acc));
        acc += want[c];
      });
      const lists: Record<string, number[]> = {};
      ps.forEach((p, i) => (lists[p.comp] ??= []).push(i));
      const pool: { i: number; from: string }[] = [];
      for (const c of ['inactive', ...COMPARTMENTS]) {
        const l = lists[c] ?? [];
        while (l.length > (want[c] ?? 0)) pool.push({ i: l.pop()!, from: c });
      }
      const fill = (c: Compartment | 'inactive', prefs: string[]) => {
        const have = (lists[c] ?? []).length;
        let need = (want[c] ?? 0) - have;
        for (const pref of [...prefs, '*']) {
          for (let k = 0; k < pool.length && need > 0; k++) {
            if (pref === '*' || pool[k].from === pref) {
              ps[pool[k].i].comp = c;
              pool.splice(k, 1);
              k--;
              need--;
            }
          }
        }
      };
      for (const c of COMPARTMENTS) fill(c, PREFER[c]);
      fill('inactive', []);
    };

    const tmp = new THREE.Vector3();
    const greyC = new THREE.Color(0x8b93a7);
    const metabC = new THREE.Color(0xb48cff);
    const urineC = new THREE.Color(0xffd54a);
    const anchors: Record<Organ, THREE.Vector3> = Object.fromEntries((Object.keys(ORGAN_POS) as Organ[]).map((o) => [o, v(...ORGAN_POS[o])])) as Record<Organ, THREE.Vector3>;
    let bladderPos = v(0, -0.115, 0.035);
    const organAnchor = (o: Organ) => anchors[o].clone();
    const proceduralOrgans = organMeshes.slice();
    const pulseTargets: { mesh: THREE.Mesh; kind: 'heart' | 'lung' | 'bladder' }[] = [];
    const layerGroups: Record<keyof Layers, THREE.Object3D[]> = { skin: [shell], muscle: [], skeleton: [], vessels: [] };
    for (const m of proceduralOrgans) if (m.userData.organ === 'blood') layerGroups.vessels.push(m);

    // ---------- real anatomy (BodyParts3D, CC BY 4.0)
    statusCb.current?.('loading');
    new GLTFLoader().load(
      anatomyUrl,
      (gltf) => {
        const anat = gltf.scene;
        const ORGAN_OF: Record<string, Organ | 'skeleton'> = {
          brain: 'brain', thyroid: 'thyroid', heart: 'heart', lungs: 'lungs', liver: 'liver', pancreas: 'pancreas', gi: 'gi', stomach: 'gi', esophagus: 'gi',
          kidneys: 'kidneys', bladder: 'kidneys', blood: 'blood', muscle: 'muscle', skeleton: 'skeleton', skin: 'skin', other: 'skeleton',
        };
        const groupBoxes: Record<string, THREE.Box3> = {};
        const meshes: THREE.Mesh[] = [];
        anat.traverse((o) => {
          if (!(o as THREE.Mesh).isMesh) return;
          const mesh = o as THREE.Mesh;
          const gname = ((Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material).name;
          const organ = ORGAN_OF[gname];
          if (!organ) return;
          mesh.updateWorldMatrix(true, false);
          // De-quantize (KHR_mesh_quantization) to float before baking the node transform.
          const src0 = mesh.geometry.getAttribute('position');
          const f32 = new Float32Array(src0.count * 3);
          for (let i = 0; i < src0.count; i++) {
            f32[i * 3] = src0.getX(i);
            f32[i * 3 + 1] = src0.getY(i);
            f32[i * 3 + 2] = src0.getZ(i);
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(f32, 3));
          if (mesh.geometry.index) geo.setIndex(mesh.geometry.index);
          mesh.geometry.dispose();
          mesh.geometry = geo;
          track(geo);
          mesh.geometry.applyMatrix4(mesh.matrixWorld);
          mesh.geometry.computeVertexNormals();
          mesh.geometry.computeBoundingBox();
          const box = mesh.geometry.boundingBox!.clone();
          (groupBoxes[gname] ??= new THREE.Box3()).union(box);
          // centre geometry so the organ can pulse/scale about its own centre
          const c = box.getCenter(new THREE.Vector3());
          mesh.geometry.translate(-c.x, -c.y, -c.z);
          mesh.position.copy(c);
          mesh.rotation.set(0, 0, 0);
          mesh.scale.set(1, 1, 1);
          const src = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
          const isSkel = organ === 'skeleton';
          const isMuscle = organ === 'muscle';
          if (gname === 'skin') {
            // Real skin surface rendered as a translucent hologram.
            // Dense real skin: translucent fresnel-like shell without wireframe so organs stay visible.
            mesh.material = track(
              new THREE.MeshPhysicalMaterial({ color: 0x8fd8ff, transparent: true, opacity: 0.07, roughness: 0.25, depthWrite: false, side: THREE.FrontSide, emissive: 0x0b4a6f, emissiveIntensity: 0.4 }),
            );
            mesh.userData.organ = 'skin';
            mesh.userData.group = 'skin';
            mesh.userData.baseScale = new THREE.Vector3(1, 1, 1);
            meshes.push(mesh);
            return;
          }
          const mat = track(
            new THREE.MeshStandardMaterial({
              color: src.color ?? new THREE.Color(0xcccccc),
              roughness: isSkel ? 0.7 : 0.5,
              metalness: 0,
              transparent: true,
              opacity: gname === 'other' ? 0.35 : isSkel ? 0.28 : isMuscle ? 0.22 : gname === 'blood' ? 0.85 : 0.95,
              depthWrite: !isMuscle,
              emissive: 0x000000,
            }),
          );
          mesh.material = mat;
          mesh.userData.organ = isSkel ? null : organ;
          if (gname === 'other') mesh.userData.organ = null;
          mesh.userData.baseScale = new THREE.Vector3(1, 1, 1);
          mesh.userData.group = gname;
          meshes.push(mesh);
        });
        if (!meshes.length) {
          statusCb.current?.('fallback');
          return;
        }
        // swap procedural organs for anatomical ones
        for (const m of proceduralOrgans) {
          m.visible = false;
          const idx = organMeshes.indexOf(m);
          if (idx >= 0) organMeshes.splice(idx, 1);
        }
        layerGroups.vessels = [];
        const root = new THREE.Group();
        for (const m of meshes) {
          root.add(m);
          const g = m.userData.group as string;
          if (g === 'skin') layerGroups.skin.push(m);
          if (g === 'skeleton') layerGroups.skeleton.push(m);
          else if (g === 'muscle') layerGroups.muscle.push(m);
          else if (g === 'blood') layerGroups.vessels.push(m);
          if (m.userData.organ) organMeshes.push(m);
          if (g === 'heart') pulseTargets.push({ mesh: m, kind: 'heart' });
          if (g === 'lungs') pulseTargets.push({ mesh: m, kind: 'lung' });
          if (g === 'bladder') pulseTargets.push({ mesh: m, kind: 'bladder' });
        }
        scene.add(root);
        const centre = (k: string) => groupBoxes[k]?.getCenter(new THREE.Vector3());
        for (const o of Object.keys(anchors) as Organ[]) {
          const k = o === 'gi' ? 'stomach' : o;
          const c = centre(k) ?? centre(o);
          if (c) anchors[o].copy(c);
        }
        if (groupBoxes.gi) anchors.gi.copy(groupBoxes.gi.getCenter(new THREE.Vector3()));
        if (centre('bladder')) bladderPos = centre('bladder')!;
        const all = new THREE.Box3();
        for (const b of Object.values(groupBoxes)) all.union(b);
        if (groupBoxes.skin) {
          shell.visible = false;
          layerGroups.skin = layerGroups.skin.filter((o) => o !== shell);
        }
        // fit the holographic skin to the anatomy (used only if no skin mesh)
        const shellBox = new THREE.Box3().setFromObject(shell);
        const sH = shellBox.max.y - shellBox.min.y;
        const aH = all.max.y - all.min.y;
        const k = (aH / sH) * 1.02;
        shell.scale.setScalar(k);
        const sb = new THREE.Box3().setFromObject(shell);
        shell.position.add(new THREE.Vector3((all.min.x + all.max.x) / 2 - (sb.min.x + sb.max.x) / 2, all.min.y - sb.min.y - 0.01, (all.min.z + all.max.z) / 2 - (sb.min.z + sb.max.z) / 2));
        // particle paths through the real anatomy
        const H = anchors.heart;
        const gb = groupBoxes.gi ?? new THREE.Box3(v(-0.08, -0.08, 0), v(0.08, 0.08, 0.06));
        const gc = gb.getCenter(new THREE.Vector3());
        const gs = gb.getSize(new THREE.Vector3());
        const coil2: THREE.Vector3[] = [];
        for (let i = 0; i <= 60; i++) {
          const t2 = i / 60;
          const a = t2 * Math.PI * 7;
          coil2.push(v(gc.x + Math.cos(a) * gs.x * 0.35, gb.max.y - t2 * gs.y * 0.9, gc.z + Math.sin(a) * gs.z * 0.3));
        }
        const brainC = anchors.brain;
        const mouth = v(brainC.x, brainC.y - (groupBoxes.brain ? (groupBoxes.brain.max.y - groupBoxes.brain.min.y) * 1.1 : 0.12), brainC.z + 0.06);
        const eso = groupBoxes.esophagus;
        giPath = new THREE.CatmullRomCurve3([
          mouth,
          eso ? v(eso.getCenter(new THREE.Vector3()).x, eso.max.y, eso.getCenter(new THREE.Vector3()).z) : mouth.clone().add(v(0, -0.08, -0.04)),
          eso ? eso.getCenter(new THREE.Vector3()) : H.clone().add(v(-0.02, 0, -0.04)),
          centre('stomach') ?? anchors.gi.clone().add(v(0.05, 0.12, 0)),
          ...coil2,
        ]);
        const legY = all.min.y + aH * 0.12;
        const kid = anchors.kidneys;
        const liv = anchors.liver;
        loops = [
          new THREE.CatmullRomCurve3([H, v(H.x, H.y + 0.06, H.z - 0.04), v(0, kid.y, kid.z), v(-0.07, legY, 0), v(-0.05, kid.y - 0.15, 0.02), v(H.x - 0.03, H.y - 0.05, H.z)], true),
          new THREE.CatmullRomCurve3([H, v(H.x, H.y + 0.06, H.z - 0.04), v(0, kid.y, kid.z), v(0.07, legY, 0), v(0.05, kid.y - 0.15, 0.02), v(H.x - 0.03, H.y - 0.05, H.z)], true),
          new THREE.CatmullRomCurve3([H, v(H.x + 0.02, (H.y + brainC.y) / 2, H.z - 0.02), brainC.clone(), v(H.x - 0.02, (H.y + brainC.y) / 2, H.z - 0.02)], true),
          new THREE.CatmullRomCurve3([H, liv.clone(), kid.clone().add(v(0.06, 0, 0)), kid.clone().add(v(-0.06, 0, 0)), v(H.x, H.y - 0.06, H.z)], true),
        ];
        controls.target.set(0, (all.min.y + all.max.y) / 2 + aH * 0.05, 0);
        statusCb.current?.('ready');
      },
      undefined,
      () => statusCb.current?.('fallback'),
    );

    // ---------- interaction
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovered: Organ | null = null;
    const onMove = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(organMeshes, false)[0];
      const o = (hit?.object.userData.organ as Organ | undefined) ?? null;
      if (o !== hovered) {
        hovered = o;
        hoverCb.current?.(o);
      }
    };
    const onLeave = () => {
      hovered = null;
      hoverCb.current?.(null);
    };
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerleave', onLeave);

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(el);

    const clock = new THREE.Clock();
    let raf = 0;
    let lastAssign = 0;
    const labelEls = new Map<string, HTMLDivElement>();

    const animate = () => {
      raf = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const f = frameRef.current;
      controls.autoRotate = rotRef.current && !reduced;
      controls.update();

      if (t - lastAssign > 0.12) {
        reassign();
        lastAssign = t;
      }

      // organ appearance
      for (const m of organMeshes) {
        const o = m.userData.organ as Organ;
        const st = f.organs[o];
        const mat = m.material as THREE.MeshStandardMaterial;
        const pulse = st.risk > 0.15 ? 0.55 + 0.45 * Math.sin(t * (2 + 4 * st.risk)) : 0;
        const em = new THREE.Color(0, 0, 0);
        if (st.therapeutic > 0.03) em.add(new THREE.Color(0x2a78d6).multiplyScalar(0.25 + 0.9 * st.therapeutic));
        if (st.risk > 0.05) em.lerp(new THREE.Color(0xff2a2a).multiplyScalar(0.4 + 1.2 * st.risk * (0.6 + 0.4 * pulse)), Math.min(1, st.risk * 1.6));
        if (hlRef.current === o || hovered === o) em.add(new THREE.Color(0x444444));
        mat.emissive.copy(em);
      }
      const beat = 1 + 0.07 * Math.max(0, Math.sin(t * Math.PI * 2 * (f.heartRate / 60))) ** 3;
      heart.scale.copy((heart.userData.baseScale as THREE.Vector3).clone().multiplyScalar(beat));
      for (const pt of pulseTargets) {
        if (pt.kind === 'heart') pt.mesh.scale.setScalar(beat);
      }
      const breath = 1 + 0.05 * f.breathing * Math.sin(t * Math.PI * 2 * (0.12 + 0.13 * f.breathing));
      for (const lung of [lungL, lungR]) lung.scale.set((lung.userData.baseScale as THREE.Vector3).x * breath, (lung.userData.baseScale as THREE.Vector3).y * breath, (lung.userData.baseScale as THREE.Vector3).z);
      bladder.scale.setScalar(1).multiply(v(0.03, 0.026, 0.026)).multiplyScalar(1 + 0.6 * f.journey.excreted);
      for (const pt of pulseTargets) {
        if (pt.kind === 'lung') pt.mesh.scale.set(breath, breath, 1);
        if (pt.kind === 'bladder') pt.mesh.scale.setScalar(1 + 0.5 * f.journey.excreted);
      }
      const L = layersRef.current;
      for (const [k, objs] of Object.entries(layerGroups) as [keyof Layers, THREE.Object3D[]][]) for (const o of objs) o.visible = L[k];

      // particles
      const dc = cssColor(colorRef.current).lerp(new THREE.Color(0xffffff), 0.35);
      const speed = reduced ? 0.3 : 1;
      const targets = f.targetOrgans.length ? f.targetOrgans : (['muscle'] as Organ[]);
      for (let i = 0; i < N; i++) {
        const p = ps[i];
        let size = 0.75;
        let col = dc;
        switch (p.comp) {
          case 'inactive':
            giPath.getPointAt(0, tmp);
            size = 0;
            break;
          case 'gut': {
            const u = 0.18 + ((p.seed + t * 0.015 * speed) % 1) * 0.8;
            giPath.getPointAt(Math.min(u, 1), tmp);
            tmp.addScaledVector(p.off, 0.008);
            size = 0.9;
            break;
          }
          case 'firstPass':
            tmp.copy(organAnchor('liver')).add(v(p.off.x * 0.08, p.off.y * 0.03, p.off.z * 0.04));
            col = greyC;
            size = 0.6;
            break;
          case 'plasma':
            loops[p.loop].getPointAt((p.seed + t * 0.09 * speed) % 1, tmp);
            tmp.addScaledVector(p.off, 0.004);
            size = 0.85;
            break;
          case 'tissue': {
            const o = targets[p.target % targets.length];
            tmp.copy(organAnchor(o)).addScaledVector(p.off, o === 'muscle' ? 0.07 : o === 'skin' ? 0.12 : 0.045);
            tmp.y += Math.sin(t * 1.5 + p.seed * 10) * 0.004;
            size = 0.7;
            break;
          }
          case 'metabolised':
            tmp.copy(organAnchor('liver')).add(v(p.off.x * 0.09, p.off.y * 0.035, p.off.z * 0.05));
            tmp.x += Math.sin(t + p.seed * 20) * 0.006;
            col = metabC;
            size = 0.45;
            break;
          case 'excreted':
            tmp.copy(bladderPos).addScaledVector(p.off, 0.02);
            col = urineC;
            size = 0.5;
            break;
        }
        // glide toward target (visualises transfer between compartments)
        const k = 0.12;
        positions[i * 3] += (tmp.x - positions[i * 3]) * k;
        positions[i * 3 + 1] += (tmp.y - positions[i * 3 + 1]) * k;
        positions[i * 3 + 2] += (tmp.z - positions[i * 3 + 2]) * k;
        colors[i * 3] = col.r;
        colors[i * 3 + 1] = col.g;
        colors[i * 3 + 2] = col.b;
        sizes[i] = size;
      }
      geom.attributes.position.needsUpdate = true;
      geom.attributes.color.needsUpdate = true;
      geom.attributes.size.needsUpdate = true;

      renderer.render(scene, camera);

      // side-effect callouts projected to screen
      const box = labels.current;
      if (box) {
        const seen = new Set<string>();
        const w = el.clientWidth;
        const h = el.clientHeight;
        f.callouts.slice(0, 5).forEach((c, idx) => {
          const keyId = `${c.organ}:${c.label}`;
          seen.add(keyId);
          let d = labelEls.get(keyId);
          if (!d) {
            d = document.createElement('div');
            d.className = 'twin-callout';
            box.appendChild(d);
            labelEls.set(keyId, d);
          }
          d.dataset.sev = c.severity;
          d.textContent = c.label;
          const p3 = organAnchor(c.organ).project(camera);
          const x = (p3.x * 0.5 + 0.5) * w;
          const y = (-p3.y * 0.5 + 0.5) * h;
          const side = x > w / 2 ? 1 : -1;
          d.style.transform = `translate(${x + side * 28}px, ${y - 10 + idx * 2}px) translateX(${side > 0 ? '0' : '-100%'})`;
          d.style.opacity = p3.z < 1 ? '1' : '0';
        });
        for (const [k2, d] of labelEls) {
          if (!seen.has(k2)) {
            d.remove();
            labelEls.delete(k2);
          }
        }
      }
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      el.removeChild(renderer.domElement);
      labelEls.forEach((d) => d.remove());
    };
  }, [supported, anatomyUrl]);

  if (!supported) return null;
  return (
    <div className="relative w-full overflow-hidden rounded-2xl bg-[radial-gradient(ellipse_at_center,#10233f_0%,#070d18_75%)]" style={{ height }}>
      <div ref={mount} className="absolute inset-0" />
      <div ref={labels} className="pointer-events-none absolute inset-0" aria-hidden />
    </div>
  );
}

export function webglSupported() {
  return webglAvailable();
}

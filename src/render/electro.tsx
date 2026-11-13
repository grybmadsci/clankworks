import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three/webgpu';

/**
 * Victorian electro-steam fittings shared by the buildings and vehicles: faintly lit coil bands and
 * vacuum tubes, sparks that now and then run along a seam, and brass finials and scrollwork, in
 * polished copper, chrome and brass. The glow is one shared material that hums (see ElectroPulse);
 * placement holograms pass a single `material` that replaces everything.
 */
export const ELECTRO = {
  /** Cold blue-white glow, kept low so it reads as a hint of current rather than a light show. */
  arc: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 1.25, 1.6) }),
  /** A spark running along a seam: bright, briefly. */
  spark: new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 5, 6), transparent: true, depthWrite: false }),
  copper: new THREE.MeshStandardMaterial({ color: '#c46a3a', metalness: 0.85, roughness: 0.32 }),
  chrome: new THREE.MeshStandardMaterial({ color: '#c8ccd2', metalness: 0.95, roughness: 0.18 }),
  brass: new THREE.MeshStandardMaterial({ color: '#c9a050', metalness: 0.8, roughness: 0.3 }),
  glass: new THREE.MeshStandardMaterial({ color: '#9fd8e8', metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.35, depthWrite: false }),
};

/** Drives the shared glow: a slow mains hum with the odd flicker. Mount once. */
export function ElectroPulse() {
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const k = 0.9 + Math.sin(t * 2.3) * 0.08 + (Math.random() < 0.02 ? 0.25 : 0);
    ELECTRO.arc.color.setRGB(0.45 * k, 1.25 * k, 1.6 * k);
  });
  return null;
}

type P3 = [number, number, number];

/** Points round an arc in a plane: 'xy' (facing the camera), 'yz' (round the x axis) or 'xz'. */
export function arcPath(c: P3, r: number, a0: number, a1: number, plane: 'xy' | 'yz' | 'xz' = 'xy', n = 12): P3[] {
  return Array.from({ length: n + 1 }, (_, k) => {
    const a = a0 + ((a1 - a0) * k) / n, u = Math.cos(a) * r, v = Math.sin(a) * r;
    return plane === 'xy' ? [c[0] + u, c[1] + v, c[2]] : plane === 'yz' ? [c[0], c[1] + v, c[2] + u] : [c[0] + u, c[1], c[2] + v];
  });
}

const TAIL = 5;
const sparkGeometry = new THREE.SphereGeometry(1, 6, 4);

/**
 * Sparks that now and then race along a seam of a model: each path (in the model's own space) is a
 * polyline, and every few seconds a bright bead with a fading tail runs along one of them. `every`
 * is the mean seconds between sparks; `material` colours them (blue-white by default).
 */
export function SurfaceSparks({ paths, every = 4, size = 0.008, material = ELECTRO.spark }: { paths: P3[][]; every?: number; size?: number; material?: THREE.Material }) {
  const beads = useRef<THREE.Mesh[]>([]);
  const lines = useMemo(() => paths.map((p) => {
    const pts = p.map((q) => new THREE.Vector3(...q));
    const lens = [0];
    for (let k = 1; k < pts.length; k++) lens.push(lens[k - 1] + pts[k].distanceTo(pts[k - 1]));
    return { pts, lens, total: lens[lens.length - 1] };
  }), [paths]);
  const run = useRef<{ line: number; s: number; dir: number } | null>(null);
  const at = (line: (typeof lines)[number], s: number, out: THREE.Vector3) => {
    const d = Math.max(0, Math.min(line.total, s));
    let k = 1;
    while (k < line.lens.length - 1 && line.lens[k] < d) k++;
    const f = (d - line.lens[k - 1]) / Math.max(1e-6, line.lens[k] - line.lens[k - 1]);
    return out.copy(line.pts[k - 1]).lerp(line.pts[k], f);
  };
  useFrame((_, dt) => {
    const r = run.current;
    if (!r) {
      beads.current.forEach((b) => { if (b) b.visible = false; });
      if (lines.length && Math.random() < dt / every) run.current = { line: Math.floor(Math.random() * lines.length), s: 0, dir: Math.random() < 0.5 ? 1 : -1 };
      return;
    }
    const line = lines[r.line];
    r.s += dt * 1.6;
    beads.current.forEach((b, k) => {
      if (!b) return;
      const s = r.s - k * 0.025;
      b.visible = s >= 0 && s <= line.total && Math.random() > 0.08;
      at(line, r.dir > 0 ? s : line.total - s, b.position);
      b.scale.setScalar(size * (1 - k / TAIL) * (0.8 + Math.random() * 0.4));
    });
    if (r.s - TAIL * 0.025 > line.total) run.current = null;
  });
  return (
    <group>
      {Array.from({ length: TAIL }, (_, k) => (
        <mesh key={k} ref={(m) => { if (m) beads.current[k] = m; }} geometry={sparkGeometry} material={material} visible={false} />
      ))}
    </group>
  );
}

/** A faintly lit coil band: a copper ring with a thin glowing core, wrapped round a pipe or tank. */
export function GlowRing({ radius, tube = 0.012, material, position, rotation = [Math.PI / 2, 0, 0] }: {
  radius: number; tube?: number; material?: THREE.Material; position?: P3; rotation?: P3;
}) {
  return (
    <group position={position} rotation={rotation}>
      <mesh material={material ?? ELECTRO.copper}><torusGeometry args={[radius, tube, 6, 32]} /></mesh>
      <mesh material={material ?? ELECTRO.arc}><torusGeometry args={[radius + tube * 0.75, tube * 0.3, 4, 32]} /></mesh>
    </group>
  );
}

/** An upright vacuum tube `height` tall: chrome base, glass envelope and a glowing filament. */
export function VacuumTube({ height = 0.1, material, position }: { height?: number; material?: THREE.Material; position?: P3 }) {
  const r = height * 0.28;
  return (
    <group position={position}>
      <mesh position={[0, height * 0.1, 0]} material={material ?? ELECTRO.brass}><cylinderGeometry args={[r * 1.1, r * 1.2, height * 0.2, 10]} /></mesh>
      <mesh position={[0, height * 0.55, 0]} material={material ?? ELECTRO.glass}><capsuleGeometry args={[r, height * 0.5, 4, 10]} /></mesh>
      <mesh position={[0, height * 0.55, 0]} material={material ?? ELECTRO.arc}><cylinderGeometry args={[r * 0.15, r * 0.15, height * 0.5, 5]} /></mesh>
    </group>
  );
}

const finialGeometry = (() => {
  // Turned brass: a collar, a ball, a waist and a spike, like the top of a Victorian railing post.
  const g = new THREE.LatheGeometry([
    [0.001, 0], [0.3, 0.02], [0.26, 0.1], [0.12, 0.2], [0.22, 0.26], [0.28, 0.38], [0.22, 0.5], [0.1, 0.62], [0.12, 0.72], [0.08, 0.9], [0.001, 1],
  ].map(([x, y]) => new THREE.Vector2(x, y)), 14);
  g.computeVertexNormals();
  return g;
})();

/** A turned brass finial `height` tall, standing on `position`. */
export function Finial({ height = 0.08, material, position }: { height?: number; material?: THREE.Material; position?: P3 }) {
  return <mesh position={position} scale={[height, height, height]} geometry={finialGeometry} material={material ?? ELECTRO.brass} />;
}

const scrollGeometry = (() => {
  // A brass curl: a spiral strip that winds in one and a half turns, like a cast-iron bracket.
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k <= 40; k++) {
    const a = (k / 40) * Math.PI * 3, r = 1 - (k / 40) * 0.75;
    pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 0.09, 5, false);
})();

/** A brass scroll `size` across, facing the camera; `flip` mirrors it left-right. */
export function Scroll({ size = 0.05, material, position, flip = false, rotation = 0 }: { size?: number; material?: THREE.Material; position?: P3; flip?: boolean; rotation?: number }) {
  return <mesh position={position} rotation={[0, 0, rotation]} scale={[flip ? -size : size, size, size]} geometry={scrollGeometry} material={material ?? ELECTRO.brass} />;
}

import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three/webgpu';

/**
 * Electro-steampunk fittings shared by the buildings and vehicles: Tesla coils with crackling
 * arcs, glowing coil rings and vacuum tubes, in polished copper, chrome and porcelain. The glow is
 * one shared material that hums and flickers (see ElectroPulse); placement holograms pass a single
 * `material` that replaces everything.
 */
export const ELECTRO = {
  /** Cold blue-white glow, HDR so the bloom picks it up. Animated by ElectroPulse. */
  arc: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 2.6, 3.4) }),
  /** Bright arc bolts, shown in flickers. */
  bolt: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 4, 5) }),
  copper: new THREE.MeshStandardMaterial({ color: '#c46a3a', metalness: 0.85, roughness: 0.32 }),
  chrome: new THREE.MeshStandardMaterial({ color: '#c8ccd2', metalness: 0.95, roughness: 0.18 }),
  porcelain: new THREE.MeshStandardMaterial({ color: '#e9e2d0', metalness: 0, roughness: 0.3 }),
  glass: new THREE.MeshStandardMaterial({ color: '#9fd8e8', metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.35, depthWrite: false }),
};

/** Arc bolts currently mounted; ElectroPulse flicks them on and off. */
const bolts = new Set<THREE.Object3D>();

/** Drives the shared glow: a mains hum with the odd surge. Mount once. */
export function ElectroPulse() {
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const surge = Math.random() < 0.03 ? 1.6 : 1;
    const k = (0.85 + Math.sin(t * 50) * 0.06 + Math.sin(t * 3.1) * 0.1) * surge;
    ELECTRO.arc.color.setRGB(0.9 * k, 2.6 * k, 3.4 * k);
    for (const b of bolts) {
      if (b.visible ? Math.random() < 0.5 : Math.random() < 0.025) {
        b.visible = !b.visible;
        b.rotation.y = Math.random() * Math.PI * 2;
      }
    }
  });
  return null;
}

/** A jagged bolt from the origin out to about `length`, as a thin tube. */
function boltGeometry(length: number, seed: number) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const pts = Array.from({ length: 6 }, (_, n) => {
    const f = n / 5;
    return new THREE.Vector3(f * length, (n && n < 5 ? rnd() * 0.5 : 0) * length * 0.5 - f * length * 0.35, rnd() * length * 0.25);
  });
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0), 12, 0.0035, 3, false);
}

/**
 * A Tesla coil `height` tall (origin at its foot): porcelain insulator stack, copper winding,
 * chrome toroid crown with a glowing core, and arcs that crackle off the crown.
 */
export function TeslaCoil({ height = 0.3, material, position, arcs = 2 }: { height?: number; material?: THREE.Material; position?: [number, number, number]; arcs?: number }) {
  const m = (own: THREE.Material) => material ?? own;
  const h = height, r = h * 0.12;
  const bolt = useMemo(() => Array.from({ length: arcs }, (_, n) => boltGeometry(h * 0.55, 7 + n * 31 + Math.round(h * 1000))), [arcs, h]);
  const group = useRef<THREE.Group>(null!);
  useEffect(() => {
    if (material) return;
    const mine = [...group.current.children];
    mine.forEach((b) => { b.visible = false; bolts.add(b); });
    return () => mine.forEach((b) => bolts.delete(b));
  }, [material]);
  const turns = 7;
  return (
    <group position={position}>
      {/* Insulator stack */}
      {[0, 1, 2].map((n) => (
        <mesh key={n} position={[0, h * (0.04 + n * 0.07), 0]} material={m(ELECTRO.porcelain)}><cylinderGeometry args={[r * (1.3 - n * 0.15), r * (1.45 - n * 0.15), h * 0.05, 12]} /></mesh>
      ))}
      {/* Winding: copper turns on a dark former */}
      <mesh position={[0, h * 0.5, 0]} material={m(ELECTRO.chrome)}><cylinderGeometry args={[r * 0.7, r * 0.7, h * 0.46, 10]} /></mesh>
      {Array.from({ length: turns }, (_, n) => (
        <mesh key={`t${n}`} position={[0, h * (0.3 + (n / (turns - 1)) * 0.4), 0]} rotation={[Math.PI / 2, 0, 0]} material={m(ELECTRO.copper)}>
          <torusGeometry args={[r * 0.78, r * 0.12, 5, 14]} />
        </mesh>
      ))}
      {/* Crown: chrome toroid round a glowing core */}
      <mesh position={[0, h * 0.82, 0]} rotation={[Math.PI / 2, 0, 0]} material={m(ELECTRO.chrome)}><torusGeometry args={[r * 1.2, r * 0.45, 8, 18]} /></mesh>
      <mesh position={[0, h * 0.86, 0]} material={m(ELECTRO.arc)}><sphereGeometry args={[r * 0.55, 10, 8]} /></mesh>
      <group ref={group} position={[0, h * 0.86, 0]}>
        {!material && bolt.map((g, n) => <mesh key={n} geometry={g} material={ELECTRO.bolt} />)}
      </group>
    </group>
  );
}

/** A glowing coil band: a copper ring with a lit core, wrapped round a pipe or tank. */
export function GlowRing({ radius, tube = 0.012, material, position, rotation = [Math.PI / 2, 0, 0] }: {
  radius: number; tube?: number; material?: THREE.Material; position?: [number, number, number]; rotation?: [number, number, number];
}) {
  return (
    <group position={position} rotation={rotation}>
      <mesh material={material ?? ELECTRO.copper}><torusGeometry args={[radius, tube, 6, 28]} /></mesh>
      <mesh material={material ?? ELECTRO.arc}><torusGeometry args={[radius + tube * 0.4, tube * 0.45, 4, 28]} /></mesh>
    </group>
  );
}

/** An upright vacuum tube `height` tall: chrome base, glass envelope and a glowing filament. */
export function VacuumTube({ height = 0.1, material, position }: { height?: number; material?: THREE.Material; position?: [number, number, number] }) {
  const r = height * 0.28;
  return (
    <group position={position}>
      <mesh position={[0, height * 0.1, 0]} material={material ?? ELECTRO.chrome}><cylinderGeometry args={[r * 1.1, r * 1.1, height * 0.2, 10]} /></mesh>
      <mesh position={[0, height * 0.55, 0]} material={material ?? ELECTRO.glass}><capsuleGeometry args={[r, height * 0.5, 4, 10]} /></mesh>
      <mesh position={[0, height * 0.55, 0]} material={material ?? ELECTRO.arc}><cylinderGeometry args={[r * 0.18, r * 0.18, height * 0.55, 5]} /></mesh>
    </group>
  );
}

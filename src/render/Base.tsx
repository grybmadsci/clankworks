import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three/webgpu';
import { DEPTH } from '../config';
import { HUB, dockSlot } from '../game/base';
import type { Game } from '../game/Game';
import { ParticleKind } from '../gpu/GpuSim';

const Z_HUB = -DEPTH * 0.62;
const HUB_D = 0.7;
const FRONT = Z_HUB + HUB_D / 2;
const Z_ACTORS = -DEPTH * 0.45;

const mat = (color: string, metalness = 0.4, roughness = 0.6) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
const M = {
  wall: mat('#6e604a', 0.35, 0.7),
  trim: mat('#3b352d', 0.5, 0.6),
  steel: mat('#6f7780', 0.75, 0.4),
  darkSteel: mat('#3d4248', 0.7, 0.45),
  brass: mat('#b8862f', 0.8, 0.35),
  copper: mat('#a5552a', 0.8, 0.4),
  rust: mat('#c98a2b', 0.3, 0.7),
  hazard: mat('#d6a21e', 0.2, 0.6),
  black: mat('#1c1b1a', 0.2, 0.8),
  rubber: mat('#242322', 0, 0.95),
  ore: mat('#7a4a2a', 0.2, 0.9),
};

/** A cog wheel: teeth around a rim, a hub hole, and lightening holes between the spokes. */
function gearGeometry(radius: number, teeth: number, depth: number) {
  const shape = new THREE.Shape();
  const root = radius * 0.8;
  const step = (Math.PI * 2) / teeth;
  for (let n = 0; n < teeth; n++) {
    const a = n * step;
    const pts: [number, number][] = [[root, a], [radius, a + step * 0.12], [radius, a + step * 0.42], [root, a + step * 0.55]];
    pts.forEach(([r, ang], m) => {
      const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
      if (n === 0 && m === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, radius * 0.16, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  if (radius > 0.12) {
    for (let n = 0; n < 5; n++) {
      const a = (n / 5) * Math.PI * 2;
      const h = new THREE.Path();
      h.absarc(Math.cos(a) * radius * 0.48, Math.sin(a) * radius * 0.48, radius * 0.15, 0, Math.PI * 2, true);
      shape.holes.push(h);
    }
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 6 });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

function Box({ p, s, m, r }: { p: [number, number, number]; s: [number, number, number]; m: THREE.Material; r?: [number, number, number] }) {
  return <mesh position={p} rotation={r} material={m}><boxGeometry args={s} /></mesh>;
}

/**
 * The starting base: a hub whose roof is the drone landing deck, a rack tower of charging
 * cradles, and a lot of machinery that keeps itself busy: meshing cogs, a crank-driven piston,
 * a radar dish, a steaming chimney, an ore conveyor, chasing deck lights and a status screen.
 */
export function Base({ game }: { game: Game }) {
  const d = game.layout.depot;
  const gears = useMemo(() => ({
    big: gearGeometry(0.2, 14, 0.05),
    small: gearGeometry(0.11, 8, 0.05),
    tiny: gearGeometry(0.07, 6, 0.04),
    fly: gearGeometry(0.12, 16, 0.04),
    valve: gearGeometry(0.06, 6, 0.02),
  }), []);
  const refs = {
    big: useRef<THREE.Mesh>(null!), small: useRef<THREE.Mesh>(null!), tiny: useRef<THREE.Mesh>(null!),
    fly: useRef<THREE.Mesh>(null!), rod: useRef<THREE.Mesh>(null!), piston: useRef<THREE.Mesh>(null!),
    radar: useRef<THREE.Group>(null!), beacon: useRef<THREE.MeshBasicMaterial>(null!), valve: useRef<THREE.Mesh>(null!),
    rollers: useRef<THREE.Group>(null!), lumps: useRef<THREE.Group>(null!), bars: useRef<THREE.Group>(null!),
    chase: useRef<THREE.Group>(null!), pads: useRef<THREE.Group>(null!),
  };
  const steamAt = useRef(0);
  const slots = useMemo(() => Array.from({ length: 12 }, (_, n) => {
    const s = dockSlot(d, n);
    return { x: s.x - d.x, y: s.y - d.y };
  }), [d]);

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    // Meshing gears turn in tooth ratio, in alternating directions.
    const w = t * 0.9;
    refs.big.current.rotation.z = w;
    refs.small.current.rotation.z = -w * (14 / 8) + 0.2;
    refs.tiny.current.rotation.z = w * (14 / 6);
    // Crank: the flywheel's pin drives a connecting rod that pumps the piston.
    const crank = t * 2.4, cr = 0.07;
    refs.fly.current.rotation.z = crank;
    const pin = { x: -0.6 + Math.cos(crank) * cr, y: 0.62 + Math.sin(crank) * cr };
    const headY = 0.34 + Math.sin(crank) * cr;
    refs.piston.current.position.y = headY;
    const dx = pin.x - -0.6, dy = pin.y - headY;
    refs.rod.current.position.set(-0.6 + dx / 2, headY + dy / 2, FRONT + 0.05);
    refs.rod.current.rotation.z = Math.atan2(dy, dx) - Math.PI / 2;
    refs.rod.current.scale.y = Math.hypot(dx, dy) / 0.28;
    refs.radar.current.rotation.y = t * 0.8;
    refs.beacon.current.color.setRGB(Math.sin(t * 4) > 0.6 ? 4 : 0.3, Math.sin(t * 4) > 0.6 ? 1.6 : 0.1, 0);
    refs.valve.current.rotation.z = Math.sin(t * 0.4) * 2;
    for (const r of refs.rollers.current.children) r.rotation.z = -t * 6;
    refs.lumps.current.children.forEach((l, n) => {
      const f = (t * 0.25 + n / 4) % 1;
      l.position.set(1.48 - f * 0.6, 0.47 + f * 0.18, 0);
      l.visible = f < 0.95;
    });
    refs.bars.current.children.forEach((b, n) => { b.scale.y = 0.35 + 0.65 * Math.abs(Math.sin(t * (1.3 + n * 0.7) + n)); });
    refs.chase.current.children.forEach((c, n) => {
      const on = Math.floor(t * 8) % 8 === n;
      ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setRGB(on ? 3 : 0.4, on ? 2 : 0.25, 0);
    });
    // Pad and cradle lights: green while a drone is docked there, slow amber blink while it's out.
    const docked = new Set(game.bots.filter((b) => !b.dead && b.state === 'docked').map((b) => b.slot));
    const out = new Set(game.bots.filter((b) => !b.dead && b.state !== 'docked').map((b) => b.slot));
    refs.pads.current.children.forEach((c, n) => {
      const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
      if (docked.has(n)) m.color.setRGB(0.3, 2.2, 0.6);
      else if (out.has(n)) m.color.setRGB(Math.sin(t * 3 + n) > 0 ? 2.4 : 0.3, Math.sin(t * 3 + n) > 0 ? 1.2 : 0.15, 0);
      else m.color.setRGB(0.15, 0.08, 0.06);
    });
    steamAt.current -= dt;
    if (steamAt.current <= 0 && game.gpu) {
      steamAt.current = 0.9 + Math.random() * 0.8;
      game.gpu.burst(d.x + 0.62, d.y + 1.6, 5, ParticleKind.Steam, 0.5, 0.04);
    }
  });

  return (
    <group position={[d.x, d.y, 0]}>
      {/* Hub building */}
      <group position={[0, 0, Z_HUB]}>
        <Box p={[0, HUB.h / 2, 0]} s={[HUB.w, HUB.h, HUB_D]} m={M.wall} />
        <Box p={[0, 0.03, 0]} s={[HUB.w + 0.06, 0.06, HUB_D + 0.06]} m={M.trim} />
        {[-1, 1].map((sx) => <Box key={sx} p={[sx * (HUB.w / 2), HUB.h / 2, HUB_D / 2]} s={[0.06, HUB.h, 0.06]} m={M.trim} />)}
        {[-0.85, -0.3, 0.2].map((x) => <Box key={x} p={[x * 0.5 + 0.1, HUB.h - 0.1, HUB_D / 2 + 0.005]} s={[0.04, 0.12, 0.01]} m={M.trim} />)}
        {/* Landing deck with hazard edge and pads */}
        <Box p={[0, HUB.h + 0.02, 0]} s={[HUB.w + 0.12, 0.04, HUB_D + 0.12]} m={M.darkSteel} />
        {Array.from({ length: 9 }, (_, n) => (
          <Box key={n} p={[-0.8 + n * 0.2, HUB.h + 0.02, HUB_D / 2 + 0.065]} s={[0.1, 0.04, 0.01]} m={n % 2 ? M.black : M.hazard} />
        ))}
      </group>
      {/* Door and status screen */}
      <Box p={[-0.12, 0.25, FRONT + 0.005]} s={[0.3, 0.46, 0.02]} m={M.darkSteel} />
      {Array.from({ length: 4 }, (_, n) => <Box key={n} p={[-0.12, 0.06 + n * 0.11, FRONT + 0.018]} s={[0.26, 0.02, 0.01]} m={n % 2 ? M.black : M.hazard} />)}
      <Box p={[-0.12, 0.68, FRONT + 0.005]} s={[0.42, 0.24, 0.02]} m={M.black} />
      <mesh position={[-0.12, 0.68, FRONT + 0.017]}><planeGeometry args={[0.36, 0.18]} /><meshBasicMaterial color={[0.05, 0.4, 0.12]} /></mesh>
      <group ref={refs.bars} position={[-0.26, 0.6, FRONT + 0.02]}>
        {Array.from({ length: 6 }, (_, n) => (
          <mesh key={n} position={[n * 0.055, 0.07, 0]}><planeGeometry args={[0.035, 0.14]} /><meshBasicMaterial color={[0.3, 2.4, 0.7]} /></mesh>
        ))}
      </group>
      {/* Gear train */}
      <mesh ref={refs.big} geometry={gears.big} material={M.brass} position={[0.42, 0.42, FRONT + 0.03]} />
      <mesh ref={refs.small} geometry={gears.small} material={M.copper} position={[0.68, 0.6, FRONT + 0.03]} />
      <mesh ref={refs.tiny} geometry={gears.tiny} material={M.steel} position={[0.69, 0.17, FRONT + 0.03]} />
      {[[0.42, 0.42], [0.68, 0.6], [0.69, 0.17]].map(([x, y]) => (
        <mesh key={x + y} position={[x, y, FRONT + 0.06]} rotation={[Math.PI / 2, 0, 0]} material={M.darkSteel}><cylinderGeometry args={[0.025, 0.025, 0.04, 10]} /></mesh>
      ))}
      {/* Flywheel, connecting rod and piston */}
      <mesh ref={refs.fly} geometry={gears.fly} material={M.steel} position={[-0.6, 0.62, FRONT + 0.03]} />
      <mesh ref={refs.rod} material={M.darkSteel}><boxGeometry args={[0.025, 0.28, 0.02]} /></mesh>
      <Box p={[-0.6, 0.17, FRONT + 0.04]} s={[0.12, 0.26, 0.08]} m={M.darkSteel} />
      <mesh ref={refs.piston} position={[-0.6, 0.34, FRONT + 0.05]} material={M.steel}><cylinderGeometry args={[0.035, 0.035, 0.1, 12]} /></mesh>
      {/* Chimney */}
      <mesh position={[0.62, HUB.h + 0.33, Z_HUB - 0.15]} material={M.trim}><cylinderGeometry args={[0.06, 0.08, 0.66, 12]} /></mesh>
      <mesh position={[0.62, HUB.h + 0.68, Z_HUB - 0.15]} material={M.rust}><cylinderGeometry args={[0.09, 0.07, 0.06, 12]} /></mesh>
      {/* Radar mast, rotating dish and beacon */}
      <mesh position={[-0.74, HUB.h + 0.35, Z_HUB - 0.2]} material={M.steel}><cylinderGeometry args={[0.018, 0.025, 0.7, 8]} /></mesh>
      <group ref={refs.radar} position={[-0.74, HUB.h + 0.62, Z_HUB - 0.2]}>
        <mesh position={[0.06, 0, 0]} rotation={[0, 0, Math.PI / 2 - 0.4]} material={M.steel}><sphereGeometry args={[0.13, 16, 8, 0, Math.PI * 2, 0, 0.9]} /></mesh>
        <mesh position={[0.1, 0.03, 0]} rotation={[0, 0, -1.2]} material={M.darkSteel}><cylinderGeometry args={[0.006, 0.006, 0.14]} /></mesh>
      </group>
      <mesh position={[-0.74, HUB.h + 0.73, Z_HUB - 0.2]}><sphereGeometry args={[0.03, 10, 8]} /><meshBasicMaterial ref={refs.beacon} /></mesh>
      {/* Pipe into the rock with a fidgeting valve wheel */}
      <mesh position={[-1.7, 0.78, Z_HUB - 0.25]} rotation={[0, 0, Math.PI / 2]} material={M.copper}><cylinderGeometry args={[0.035, 0.035, 1.8, 10]} /></mesh>
      <mesh ref={refs.valve} geometry={gears.valve} material={M.hazard} position={[-1.05, 0.78, Z_HUB - 0.2]} />
      {/* Ore conveyor feeding the hub from a hopper */}
      <group position={[0, 0, Z_ACTORS + 0.1]}>
        <Box p={[1.18, 0.52, 0]} s={[0.66, 0.035, 0.18]} m={M.rubber} r={[0, 0, -0.29]} />
        <group ref={refs.rollers}>
          {[0.88, 1.48].map((x) => (
            <mesh key={x} position={[x, x < 1 ? 0.6 : 0.43, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.steel}><cylinderGeometry args={[0.035, 0.035, 0.2, 8]} /></mesh>
          ))}
        </group>
        {[0.95, 1.4].map((x) => <Box key={x} p={[x, x < 1 ? 0.28 : 0.2, 0]} s={[0.03, x < 1 ? 0.56 : 0.4, 0.03]} m={M.darkSteel} />)}
        <group ref={refs.lumps}>
          {Array.from({ length: 4 }, (_, n) => <Box key={n} p={[0, 0, 0]} s={[0.06, 0.05, 0.06]} m={M.ore} />)}
        </group>
        <Box p={[1.62, 0.22, 0]} s={[0.3, 0.3, 0.28]} m={M.rust} />
        <Box p={[1.62, 0.36, 0]} s={[0.24, 0.04, 0.22]} m={M.ore} />
      </group>
      {/* Barrels */}
      {[[1.05, -0.2], [1.22, -0.32]].map(([x, z]) => (
        <mesh key={x} position={[x, 0.13, z]} material={x < 1.1 ? M.rust : M.darkSteel}><cylinderGeometry args={[0.08, 0.08, 0.26, 12]} /></mesh>
      ))}
      {/* Rack tower of charging cradles */}
      <group position={[0, 0, Z_ACTORS]}>
        {[-1.88, -0.97].flatMap((x) => [-0.22, 0.22].map((z) => <Box key={`${x}${z}`} p={[x, 0.9, z]} s={[0.04, 1.8, 0.04]} m={M.steel} />))}
        {slots.slice(4).map((s, n) => <Box key={n} p={[s.x, s.y - 0.1, 0]} s={[0.34, 0.025, 0.4]} m={M.darkSteel} />)}
        {[0.32, 0.74, 1.16, 1.58].map((y) => <Box key={y} p={[-1.42, y - 0.11, -0.2]} s={[0.91, 0.03, 0.03]} m={M.steel} />)}
      </group>
      {/* Pad / cradle status lights, one per landing slot */}
      <group ref={refs.pads}>
        {slots.map((s, n) => (
          <mesh key={n} position={[s.x, s.y - 0.08, n < 4 ? Z_ACTORS + 0.16 : Z_ACTORS + 0.21]}>
            <sphereGeometry args={[0.018, 8, 6]} /><meshBasicMaterial color="black" />
          </mesh>
        ))}
      </group>
      {/* Chasing lights along the deck's front edge */}
      <group ref={refs.chase}>
        {Array.from({ length: 8 }, (_, n) => (
          <mesh key={n} position={[-0.75 + n * (1.5 / 7), HUB.h - 0.03, FRONT + 0.01]}><sphereGeometry args={[0.016, 8, 6]} /><meshBasicMaterial /></mesh>
        ))}
      </group>
      <pointLight position={[0, 1.6, 0.8]} intensity={3} distance={6} color="#ffd9a0" />
    </group>
  );
}

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { CELL, DEPTH } from '../config';
import type { Blast, Bot, Critter, Debris, Game, Smelter, Strut } from '../game/Game';

const Z_ACTORS = -DEPTH * 0.45;
const DEBRIS_COLORS = ['#000', '#7a5236', '#6f6c6a', '#9a6440', '#9fc8dc', '#2b2a2e', '#6b5644', '#5f6450'];

/** Re-render when the game's entity lists change (checked once per frame). */
function useEntityVersion(game: Game) {
  const [v, setV] = useState(game.entityVersion);
  useFrame(() => { if (game.entityVersion !== v) setV(game.entityVersion); });
  return v;
}

export function Entities({ game }: { game: Game }) {
  useEntityVersion(game);
  return (
    <>
      <Depot game={game} />
      <Carl game={game} />
      <Terrarium game={game} />
      {game.bots.filter((b) => !b.dead).map((b) => <BotModel key={b.id} bot={b} />)}
      {game.debris.map((d) => <DebrisModel key={d.id} debris={d} />)}
      {game.struts.map((s) => <StrutModel key={s.id} strut={s} />)}
      {game.smelters.map((s) => <SmelterModel key={s.id} smelter={s} game={game} />)}
      {game.blasts.map((b) => <BlastModel key={b.id} blast={b} />)}
      {game.critters.map((c) => <CritterModel key={c.id} critter={c} />)}
      <HeadLamps game={game} />
    </>
  );
}

const rust = '#c98a2b';

/** A clunky Wall-E-ish scrapbot: treads, boxy body, binocular head, wobbly antenna. */
function BotModel({ bot }: { bot: Bot }) {
  const root = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const head = useRef<THREE.Group>(null!);
  const arm = useRef<THREE.Group>(null!);
  const glow = useRef<THREE.MeshStandardMaterial>(null!);
  const flame = useRef<THREE.Mesh>(null!);
  const phase = useMemo(() => Math.random() * 10, []);
  useFrame(({ clock }) => {
    if (bot.dead) return;
    const t = clock.elapsedTime + phase;
    const p = bot.body.translation();
    const v = bot.body.linvel();
    root.current.position.set(p.x, p.y - 0.05 + Math.sin(t * 5) * 0.015, Z_ACTORS);
    // Fake Z tilt from 2D velocity sells the volume of a 2D body.
    body.current.rotation.set(-v.y * 0.05, bot.facing * 0.5 + v.x * 0.06, -v.x * 0.07);
    const saluting = bot.state === 'salute';
    const tantrum = bot.state === 'tantrum';
    head.current.rotation.set(saluting ? 0.5 : Math.sin(t * 1.3) * 0.15, tantrum ? Math.sin(t * 30) * 0.5 : 0, tantrum ? Math.sin(t * 25) * 0.3 : 0);
    if (bot.drillPoint) {
      const ang = Math.atan2(bot.drillPoint.y - p.y, (bot.drillPoint.x - p.x) * bot.facing);
      arm.current.rotation.set(0, 0, ang);
      arm.current.children[1].rotation.x = t * 40;
    } else {
      arm.current.rotation.set(0, 0, saluting ? 1.9 : -0.5 + Math.sin(t * 2) * 0.1);
    }
    glow.current.emissive.setRGB(bot.heat / 60, bot.heat / 300, 0);
    flame.current.visible = bot.body.gravityScale() === 0 && v.y > -0.1;
    flame.current.scale.y = 0.6 + Math.random() * 0.6;
  });
  return (
    <group ref={root}>
      <group ref={body}>
        {/* treads */}
        <mesh position={[0, -0.11, 0.09]}><boxGeometry args={[0.36, 0.09, 0.07]} /><meshStandardMaterial color="#2c2b2a" roughness={0.9} /></mesh>
        <mesh position={[0, -0.11, -0.09]}><boxGeometry args={[0.36, 0.09, 0.07]} /><meshStandardMaterial color="#2c2b2a" roughness={0.9} /></mesh>
        {/* body */}
        <mesh position={[0, 0.02, 0]}><boxGeometry args={[0.3, 0.2, 0.24]} /><meshStandardMaterial ref={glow} color={rust} roughness={0.7} metalness={0.3} /></mesh>
        <mesh position={[0, 0.02, 0.121]}><planeGeometry args={[0.18, 0.1]} /><meshStandardMaterial color="#3d3a33" /></mesh>
        {/* head */}
        <group ref={head} position={[0.02, 0.17, 0]}>
          <mesh position={[0, -0.03, 0]}><cylinderGeometry args={[0.015, 0.015, 0.08]} /><meshStandardMaterial color="#555" /></mesh>
          {[-0.055, 0.055].map((z) => (
            <group key={z} position={[0.02, 0.03, z]}>
              <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.045, 0.05, 0.1, 12]} /><meshStandardMaterial color="#8e8a80" metalness={0.5} roughness={0.4} /></mesh>
              <mesh position={[0.051, 0, 0]} rotation={[0, Math.PI / 2, 0]}><circleGeometry args={[0.032, 12]} /><meshStandardMaterial color="#111" emissive="#7fd8ff" emissiveIntensity={1.5} /></mesh>
            </group>
          ))}
          <mesh position={[-0.04, 0.1, 0]} rotation={[0, 0, 0.3]}><cylinderGeometry args={[0.006, 0.006, 0.12]} /><meshStandardMaterial color="#444" /></mesh>
          <mesh position={[-0.058, 0.16, 0]}><sphereGeometry args={[0.018]} /><meshStandardMaterial color="#f33" emissive="#f22" emissiveIntensity={2} /></mesh>
        </group>
        {/* drill arm */}
        <group ref={arm} position={[0.12, 0.02, 0.13]}>
          <mesh position={[0.08, 0, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.018, 0.018, 0.16]} /><meshStandardMaterial color="#666" metalness={0.6} /></mesh>
          <mesh position={[0.2, 0, 0]} rotation={[0, 0, -Math.PI / 2]}><coneGeometry args={[0.04, 0.1, 6]} /><meshStandardMaterial color="#bbb" metalness={0.8} roughness={0.3} /></mesh>
        </group>
        {/* thruster flame */}
        <mesh ref={flame} position={[0, -0.2, 0]} rotation={[Math.PI, 0, 0]}><coneGeometry args={[0.05, 0.14, 8]} /><meshBasicMaterial color={[3, 1.3, 0.3]} /></mesh>
      </group>
    </group>
  );
}

/** A handful of point lights follow the first bots so the deep tunnels aren't pitch black. */
function HeadLamps({ game }: { game: Game }) {
  const lights = useRef<(THREE.PointLight | null)[]>([]);
  useFrame(() => {
    const bots = game.bots.filter((b) => !b.dead);
    lights.current.forEach((l, n) => {
      if (!l) return;
      const b = bots[n];
      l.intensity = b ? 2.2 : 0;
      if (b) { const p = b.body.translation(); l.position.set(p.x + b.facing * 0.3, p.y + 0.2, 0.4); }
    });
  });
  return <>{[0, 1, 2, 3, 4, 5].map((n) => <pointLight key={n} ref={(l) => { lights.current[n] = l; }} color="#ffe2b0" distance={4.5} decay={1.5} />)}</>;
}

function DebrisModel({ debris }: { debris: Debris }) {
  const ref = useRef<THREE.Group>(null!);
  const mesh = useMemo(() => {
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL, CELL, DEPTH * 0.85), new THREE.MeshStandardMaterial({ roughness: 0.95 }), debris.cells.length);
    const mat = new THREE.Matrix4();
    const color = new THREE.Color();
    debris.cells.forEach((c, n) => {
      mat.makeTranslation(c.x, c.y, (Math.random() - 0.5) * 0.08);
      m.setMatrixAt(n, mat);
      m.setColorAt(n, color.set(DEBRIS_COLORS[c.mat] ?? '#666').multiplyScalar(0.85 + Math.random() * 0.3));
    });
    return m;
  }, [debris]);
  useFrame(() => {
    if (debris.removed) return;
    const p = debris.body.translation();
    const v = debris.body.linvel();
    ref.current.position.set(p.x, p.y, -DEPTH * 0.5);
    ref.current.rotation.set(v.y * 0.02, v.x * 0.03, debris.body.rotation());
  });
  return <group ref={ref}><primitive object={mesh} /></group>;
}

function StrutModel({ strut }: { strut: Strut }) {
  const x = (strut.i + 0.5) * CELL;
  const y0 = strut.j0 * CELL, y1 = (strut.j1 + 1) * CELL;
  const h = y1 - y0;
  const braces = Math.max(1, Math.floor(h / 0.6));
  return (
    <group position={[x, y0 + h / 2, -DEPTH * 0.72]}>
      {[-0.07, 0.07].map((dx) => (
        <mesh key={dx} position={[dx, 0, 0]}><boxGeometry args={[0.05, h, 0.1]} /><meshStandardMaterial color="#5d6670" metalness={0.7} roughness={0.45} /></mesh>
      ))}
      {Array.from({ length: braces }, (_, n) => (
        <mesh key={n} position={[0, -h / 2 + (n + 0.5) * (h / braces), 0]} rotation={[0, 0, n % 2 ? 0.9 : -0.9]}>
          <boxGeometry args={[0.03, 0.2, 0.04]} /><meshStandardMaterial color="#7c858e" metalness={0.7} roughness={0.4} />
        </mesh>
      ))}
      <mesh position={[0, h / 2 - 0.03, 0]}><boxGeometry args={[0.3, 0.06, 0.3]} /><meshStandardMaterial color="#4a525a" metalness={0.6} /></mesh>
      <mesh position={[0, -h / 2 + 0.03, 0]}><boxGeometry args={[0.3, 0.06, 0.3]} /><meshStandardMaterial color="#4a525a" metalness={0.6} /></mesh>
    </group>
  );
}

function SmelterModel({ smelter, game }: { smelter: Smelter; game: Game }) {
  const mouth = useRef<THREE.MeshBasicMaterial>(null!);
  useFrame(({ clock }) => {
    const hot = game.time < smelter.hotUntil ? 1 : 0.15;
    mouth.current.color.setRGB(3 * hot + Math.sin(clock.elapsedTime * 9) * 0.3 * hot, 1.1 * hot, 0.2 * hot);
  });
  return (
    <group position={[smelter.x, smelter.y, Z_ACTORS]}>
      <mesh position={[0, 0.3, 0]}><boxGeometry args={[0.8, 0.6, 0.6]} /><meshStandardMaterial color="#5b4a3f" metalness={0.5} roughness={0.6} /></mesh>
      <mesh position={[0.22, 0.85, -0.1]}><cylinderGeometry args={[0.08, 0.1, 0.6]} /><meshStandardMaterial color="#3d3530" metalness={0.5} /></mesh>
      <mesh position={[-0.1, 0.25, 0.301]}><planeGeometry args={[0.3, 0.22]} /><meshBasicMaterial ref={mouth} /></mesh>
      <mesh position={[0, 0.62, 0]}><boxGeometry args={[0.86, 0.05, 0.66]} /><meshStandardMaterial color={rust} /></mesh>
    </group>
  );
}

function BlastModel({ blast }: { blast: Blast }) {
  const led = useRef<THREE.MeshBasicMaterial>(null!);
  useFrame(() => { led.current.color.setRGB(Math.sin(blast.fuse * (12 - blast.fuse * 3)) > 0 ? 4 : 0.2, 0, 0); });
  return (
    <group position={[blast.x, blast.y, Z_ACTORS + 0.2]}>
      <mesh><cylinderGeometry args={[0.06, 0.06, 0.22, 10]} /><meshStandardMaterial color="#b3261e" /></mesh>
      <mesh position={[0, 0.13, 0]}><sphereGeometry args={[0.03]} /><meshBasicMaterial ref={led} /></mesh>
    </group>
  );
}

function CritterModel({ critter }: { critter: Critter }) {
  const ref = useRef<THREE.Group>(null!);
  const skin = useRef<THREE.MeshStandardMaterial>(null!);
  const hue = useMemo(() => 0.25 + Math.random() * 0.3, []);
  useFrame(() => {
    const hop = Math.abs(Math.sin(critter.hop)) * (critter.dead ? 0 : critter.happy ? 0.08 : 0.15);
    ref.current.position.set(critter.x, critter.y + 0.1 + hop, -DEPTH * 0.35);
    const squash = critter.dead ? 0.35 : 1 - hop * 1.2;
    ref.current.scale.set(1 / Math.sqrt(squash), squash, 1);
    ref.current.rotation.y = critter.vx > 0 ? 0.6 : -0.6;
    skin.current.color.setHSL(critter.dead ? 0 : critter.happy ? hue : 0.02, critter.dead ? 0 : 0.6, 0.5);
  });
  return (
    <group ref={ref}>
      <mesh><sphereGeometry args={[0.12, 14, 10]} /><meshStandardMaterial ref={skin} roughness={0.35} /></mesh>
      {[-0.05, 0.05].map((z) => (
        <group key={z} position={[0.08, 0.05, z]}>
          <mesh><sphereGeometry args={[0.035, 8, 6]} /><meshStandardMaterial color="white" /></mesh>
          <mesh position={[0.025, 0, 0]}><sphereGeometry args={[0.018, 6, 4]} /><meshBasicMaterial color="black" /></mesh>
        </group>
      ))}
    </group>
  );
}

function Depot({ game }: { game: Game }) {
  const d = game.layout.depot;
  return (
    <group position={[d.x, d.y, -DEPTH * 0.6]}>
      <mesh position={[0, 0.3, 0]}><boxGeometry args={[1.1, 0.6, 0.6]} /><meshStandardMaterial color="#6d5d3b" roughness={0.8} /></mesh>
      <mesh position={[0, 0.62, 0]}><boxGeometry args={[1.2, 0.06, 0.7]} /><meshStandardMaterial color="#c9a227" metalness={0.4} /></mesh>
      <mesh position={[0, 0.85, 0]}><boxGeometry args={[0.5, 0.18, 0.04]} /><meshBasicMaterial color={[0.3, 2.2, 0.6]} /></mesh>
      <pointLight position={[0, 1.4, 0.8]} intensity={3} distance={6} color="#ffd9a0" />
    </group>
  );
}

/** Carl: an obsolete Roomba-style predecessor, broken down in his alcove. */
function Carl({ game }: { game: Game }) {
  const led = useRef<THREE.MeshBasicMaterial>(null!);
  const c = game.layout.carl;
  useFrame(({ clock }) => { led.current.color.setRGB(Math.sin(clock.elapsedTime * 1.5) > 0.7 ? 3 : 0.2, 0, 0); });
  return (
    <group position={[c.x, c.y + 0.06, -DEPTH * 0.5]} rotation={[0.25, 0, 0.18]}>
      <mesh><cylinderGeometry args={[0.22, 0.22, 0.09, 20]} /><meshStandardMaterial color="#5a5e63" metalness={0.5} roughness={0.5} /></mesh>
      <mesh position={[0.08, 0.05, 0.08]}><sphereGeometry args={[0.025]} /><meshBasicMaterial ref={led} /></mesh>
    </group>
  );
}

function Terrarium({ game }: { game: Game }) {
  const t = game.layout.terrarium;
  return (
    <group position={[t.x, t.y, 0]}>
      <mesh position={[0, 0.03, -DEPTH * 0.5]}><boxGeometry args={[t.w, 0.06, DEPTH * 0.9]} /><meshStandardMaterial color="#3f6b2a" roughness={1} /></mesh>
      {[-1.4, -0.7, 0.4, 1.2].map((x, n) => (
        <mesh key={x} position={[x, 0.2 + n * 0.03, -DEPTH * 0.8]}><coneGeometry args={[0.08, 0.35 + n * 0.08, 6]} /><meshStandardMaterial color="#4f9a3a" /></mesh>
      ))}
      <mesh position={[0, t.h / 2, 0.06]}>
        <planeGeometry args={[t.w, t.h]} />
        <meshPhysicalMaterial color="#bfe6ff" transparent opacity={0.12} roughness={0.05} metalness={0} />
      </mesh>
    </group>
  );
}

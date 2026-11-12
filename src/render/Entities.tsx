import { useFrame } from '@react-three/fiber';
import { type Ref, useMemo, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { CELL, DEPTH, ISO } from '../config';
import { enabled } from '../debug';
import { brickMaterial, groutMaterial, rustMaterial } from './materials';
import { bucketTotal, cargoTotal } from '../game/Game';
import { DEPOT, OUTPOST, RECIPES, VEHICLE } from '../game/tech';
import { ParticleKind } from '../gpu/GpuSim';
import type { BaseSite, Bot, Critter, Debris, Depot, Game, Girder, Smelter, Strut, Vehicle } from '../game/Game';
import { Base } from './Base';

export const Z_ACTORS = -DEPTH * 0.45;
const DEBRIS_COLORS = ['#000', '#7a5236', '#6f6c6a', '#9a6440', '#9fc8dc', '#2b2a2e', '#6b5644', '#5f6450', '#7a3f2c', '#3c4250'];

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
      <Base game={game} />
      <Carl game={game} />
      {game.bots.filter((b) => !b.dead).map((b) => <DroneModel key={b.id} bot={b} game={game} />)}
      {game.debris.map((d) => <DebrisModel key={d.id} debris={d} />)}
      {game.struts.map((s) => <StrutModel key={`${s.id}:${s.j0}:${s.j1}:${s.broken}`} strut={s} game={game} />)}
      {game.smelters.map((s) => <SmelterModel key={s.id} smelter={s} game={game} />)}
      {game.bases.filter((b) => b.kind === 'outpost').map((b) => <OutpostModel key={b.id} base={b} game={game} />)}
      {game.girders.map((g) => <GirderModel key={g.id} girder={g} />)}
      {game.depots.map((d) => <DepotModel key={d.id} depot={d} game={game} />)}
      {game.vehicles.map((v) => <VehicleModel key={v.id} vehicle={v} game={game} />)}
      {game.critters.map((c) => <CritterModel key={c.id} critter={c} />)}
      <HeadLamps game={game} />
      <StrutLamps game={game} />
    </>
  );
}

const rust = '#c98a2b';

const ROTORS: [number, number][] = [[0.11, 0.09], [-0.11, 0.09], [0.11, -0.09], [-0.11, -0.09]];

/**
 * A small mining quad-copter: four rotors on crossed arms, a cyclops sensor eye, a cargo pod
 * that fills with ore, and an under-slung mining laser. It banks into its flight direction.
 */
function DroneModel({ bot, game }: { bot: Bot; game: Game }) {
  const root = useRef<THREE.Group>(null!);
  const frame = useRef<THREE.Group>(null!);
  const rotors = useRef<(THREE.Group | null)[]>([]);
  const blurs = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const shell = useRef<THREE.MeshStandardMaterial>(null!);
  const led = useRef<THREE.MeshBasicMaterial>(null!);
  const pod = useRef<THREE.Mesh>(null!);
  const gauges = useRef<(THREE.Mesh | null)[]>([]);
  const beam = useRef<THREE.Mesh>(null!);
  const spot = useRef<THREE.Mesh>(null!);
  const state = useMemo(() => ({ phase: Math.random() * 10, spin: 0, angle: 0, z: Z_ACTORS }), []);
  useFrame(({ clock }, dt) => {
    if (bot.dead) return;
    const t = clock.elapsedTime + state.phase;
    const p = bot.body.translation();
    const v = bot.body.linvel();
    const docked = bot.state === 'docked';
    // Rotors spin down on the pad and up for flight.
    state.spin += ((docked ? 6 : 70) - state.spin) * Math.min(1, dt * (docked ? 1.5 : 4));
    state.angle += state.spin * dt;
    rotors.current.forEach((r, n) => { if (r) r.rotation.y = state.angle * (n % 3 === 0 ? 1 : -1) + n; });
    blurs.current.forEach((m) => { if (m) m.opacity = Math.min(0.35, state.spin / 200); });
    const hover = docked ? 0 : Math.sin(t * 3.1) * 0.012;
    // Drones route around buildings when they can; when they can't, they fly past in front of
    // them (eased forward and back) rather than through them.
    const front = !docked && (game.buildingAt(p.x, p.y) || game.buildingAt(p.x, p.y - 0.12) || game.buildingAt(p.x, p.y + 0.12));
    state.z += ((front ? -0.15 : Z_ACTORS) - state.z) * Math.min(1, dt * 6);
    root.current.position.set(p.x, p.y + hover, state.z);
    const saluting = bot.state === 'salute', tantrum = bot.state === 'tantrum';
    // Bank into the direction of travel; salute with a barrel roll, tantrum with a furious wobble.
    const roll = saluting ? (1 - Math.max(0, bot.stateTimer) / 2.2) * Math.PI * 2 : -v.x * 0.12 + (tantrum ? Math.sin(t * 28) * 0.4 : 0);
    frame.current.rotation.set(v.y * 0.05 + (tantrum ? Math.sin(t * 23) * 0.3 : 0), bot.facing > 0 ? -0.35 : Math.PI + 0.35, roll * bot.facing);
    shell.current.emissive.setRGB(bot.heat / 60, bot.heat / 300, 0);
    const blink = Math.sin(t * 5) > 0;
    const c = tantrum ? [3, 0.2, 0.1] : docked ? [0.2, blink ? 2 : 0.5, 0.4] : bot.state === 'toDepot' ? [0.3, 0.9, 2.5] : [2.5, 1.4, 0.2];
    led.current.color.setRGB(c[0], c[1], c[2]);
    // Battery gauges on both flanks: green, yellow, then blinking red; a slow pulse while charging.
    const level = bot.battery / 100;
    const charging = docked && bot.battery < 99.5;
    const glow = level < 0.25 ? (Math.sin(t * 9) > 0 ? 3 : 0.4) : charging ? 1.2 + Math.sin(t * 4) * 0.8 : 1.6;
    gauges.current.forEach((g) => {
      if (!g) return;
      g.scale.x = Math.max(0.02, level);
      g.position.x = -0.035 + 0.035 * Math.max(0.02, level);
      const m = g.material as THREE.MeshBasicMaterial;
      if (level > 0.5) m.color.setRGB(0.25 * glow, glow, 0.35 * glow);
      else if (level > 0.25) m.color.setRGB(glow, 0.8 * glow, 0.1 * glow);
      else m.color.setRGB(glow, 0.12 * glow, 0.08 * glow);
    });
    const load = Math.min(1, cargoTotal(bot) / 6);
    pod.current.scale.set(1, 0.4 + load * 0.6, 1);
    // Mining laser from the emitter under the nose to the cell being cut.
    const dp = bot.drillPoint;
    beam.current.visible = spot.current.visible = !!dp && enabled('laser');
    if (dp) {
      const ex = 0.05 * bot.facing, ey = -0.07;
      const dx = dp.x - p.x - ex, dy = dp.y - p.y - ey;
      const len = Math.hypot(dx, dy);
      beam.current.position.set(ex + dx / 2, ey + dy / 2, 0.02);
      beam.current.rotation.set(0, 0, Math.atan2(dy, dx) - Math.PI / 2);
      beam.current.scale.set(0.7 + Math.random() * 0.6, len, 0.7 + Math.random() * 0.6);
      spot.current.position.set(dp.x - p.x, dp.y - p.y, 0.05);
      spot.current.scale.setScalar(0.7 + Math.random() * 0.6);
    }
  });
  return (
    <group ref={root}>
      <group ref={frame} scale={1.3}>
        {/* body shell and sensor eye */}
        <mesh><boxGeometry args={[0.15, 0.06, 0.12]} /><meshStandardMaterial ref={shell} color={rust} roughness={0.55} metalness={0.4} /></mesh>
        <mesh position={[0, 0.035, 0]}><boxGeometry args={[0.1, 0.02, 0.09]} /><meshStandardMaterial color="#3d3a33" metalness={0.5} /></mesh>
        <mesh position={[0.075, 0, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.026, 0.026, 0.02, 12]} /><meshStandardMaterial color="#8e8a80" metalness={0.6} roughness={0.35} /></mesh>
        <mesh position={[0.086, 0, 0]} rotation={[0, Math.PI / 2, 0]}><circleGeometry args={[0.018, 12]} /><meshStandardMaterial color="#111" emissive="#7fd8ff" emissiveIntensity={1.8} /></mesh>
        <mesh position={[-0.05, 0.05, 0]}><sphereGeometry args={[0.012, 8, 6]} /><meshBasicMaterial ref={led} /></mesh>
        {/* crossed arms, motors and rotors */}
        {[0.69, -0.69].map((a) => (
          <mesh key={a} rotation={[0, a, 0]} position={[0, 0.01, 0]}><boxGeometry args={[0.3, 0.014, 0.018]} /><meshStandardMaterial color="#3d4248" metalness={0.7} roughness={0.4} /></mesh>
        ))}
        {ROTORS.map(([x, z], n) => (
          <group key={n} position={[x, 0.025, z]}>
            <mesh><cylinderGeometry args={[0.014, 0.016, 0.03, 8]} /><meshStandardMaterial color="#2c2b2a" metalness={0.6} /></mesh>
            <group ref={(g) => { rotors.current[n] = g; }} position={[0, 0.02, 0]}>
              <mesh><boxGeometry args={[0.12, 0.003, 0.014]} /><meshStandardMaterial color="#c8c4bc" /></mesh>
            </group>
            <mesh position={[0, 0.022, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[0.062, 20]} />
              <meshBasicMaterial ref={(m) => { blurs.current[n] = m; }} color="#d8d4cc" transparent depthWrite={false} side={THREE.DoubleSide} />
            </mesh>
          </group>
        ))}
        {/* battery gauges, one on each flank */}
        {[1, -1].map((side, n) => (
          <group key={side} position={[-0.005, 0.002, side * 0.0615]}>
            <mesh><boxGeometry args={[0.082, 0.024, 0.003]} /><meshStandardMaterial color="#141210" /></mesh>
            <mesh ref={(m) => { gauges.current[n] = m; }} position={[0, 0, side * 0.0022]}><boxGeometry args={[0.07, 0.014, 0.002]} /><meshBasicMaterial /></mesh>
            <mesh position={[0.044, 0, 0]}><boxGeometry args={[0.006, 0.01, 0.003]} /><meshStandardMaterial color="#141210" /></mesh>
          </group>
        ))}
        {/* landing skids */}
        {[-0.05, 0.05].map((z) => (
          <mesh key={z} position={[0, -0.055, z]}><boxGeometry args={[0.13, 0.008, 0.008]} /><meshStandardMaterial color="#2c2b2a" /></mesh>
        ))}
        {/* cargo pod and laser emitter */}
        <mesh ref={pod} position={[-0.01, -0.04, 0]}><boxGeometry args={[0.07, 0.04, 0.06]} /><meshStandardMaterial color="#9a6440" roughness={0.8} /></mesh>
        <mesh position={[0.05, -0.05, 0]} rotation={[0, 0, 0.6]}><cylinderGeometry args={[0.008, 0.012, 0.04, 8]} /><meshStandardMaterial color="#bbb" metalness={0.8} roughness={0.3} /></mesh>
      </group>
      {/* Pure light: additive and kept out of the depth buffer, so ambient occlusion doesn't paint
          dark halos around the beam onto the rock. */}
      <mesh ref={beam} renderOrder={5}><cylinderGeometry args={[0.008, 0.008, 1, 6]} /><meshBasicMaterial color={[4, 1.6, 0.4]} transparent depthWrite={false} blending={THREE.AdditiveBlending} /></mesh>
      <mesh ref={spot} renderOrder={5}><sphereGeometry args={[0.035, 10, 8]} /><meshBasicMaterial color={[5, 2.4, 0.7]} transparent depthWrite={false} blending={THREE.AdditiveBlending} /></mesh>
    </group>
  );
}

/** A handful of point lights follow the airborne drones so the deep tunnels aren't pitch black. */
function HeadLamps({ game }: { game: Game }) {
  const lights = useRef<(THREE.PointLight | null)[]>([]);
  useFrame(() => {
    const bots = enabled('lamps') ? game.bots.filter((b) => !b.dead && b.state !== 'docked') : [];
    lights.current.forEach((l, n) => {
      if (!l) return;
      const b = bots[n];
      l.intensity = b ? 4 : 0;
      if (b) { const p = b.body.translation(); l.position.set(p.x + b.facing * 0.3, p.y + 0.2, 0.4); }
    });
  });
  return <>{[0, 1, 2, 3, 4, 5].map((n) => <pointLight key={n} ref={(l) => { lights.current[n] = l; }} color="#ffe2b0" distance={6.5} decay={1.4} />)}</>;
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

export const Z_STRUT = -DEPTH * 0.72;

/** Small deterministic PRNG, so a strut's lamps land in the same places every time. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Lamp { x: number; y: number; z: number; side: number }
/** Keyed by span, since struts stretch when the rock at their ends is dug away. */
const lampCache = new Map<string, Lamp[]>();

/**
 * Lamps spread up a strut, roughly one per 0.7m, alternating between the two posts with a
 * little random offset so they don't line up.
 */
export function strutLamps(strut: Pick<Strut, 'i' | 'j0' | 'j1'>): Lamp[] {
  const key = `${strut.i}:${strut.j0}:${strut.j1}`;
  const cached = lampCache.get(key);
  if (cached) return cached;
  const rand = seeded(strut.i * 92821 + strut.j0 * 1237 + strut.j1);
  const y0 = strut.j0 * CELL, y1 = (strut.j1 + 1) * CELL, h = y1 - y0;
  const n = Math.max(1, Math.round(h / 0.7));
  const out: Lamp[] = [];
  for (let k = 0; k < n; k++) {
    const side = (k + (rand() < 0.5 ? 0 : 1)) % 2 ? -1 : 1;
    const y = Math.min(y1 - 0.15, Math.max(y0 + 0.15, y0 + ((k + 0.5) / n) * h + (rand() - 0.5) * 0.22));
    out.push({ x: (strut.i + 0.5) * CELL + side * (0.12 + rand() * 0.025), y, z: Z_STRUT + 0.06 + rand() * 0.04, side });
  }
  lampCache.set(key, out);
  return out;
}

const STRUT_MATS = {
  post: new THREE.MeshStandardMaterial({ color: '#5d6670', metalness: 0.7, roughness: 0.45 }),
  brace: new THREE.MeshStandardMaterial({ color: '#7c858e', metalness: 0.7, roughness: 0.4 }),
  plate: new THREE.MeshStandardMaterial({ color: '#4a525a', metalness: 0.6 }),
  iron: new THREE.MeshStandardMaterial({ color: '#2b2725', metalness: 0.7 }),
  rusted: new THREE.MeshStandardMaterial({ color: '#5a3a2c', metalness: 0.4, roughness: 0.8 }),
  brass: new THREE.MeshStandardMaterial({ color: '#c19a4b', metalness: 0.9, roughness: 0.3 }),
};

/**
 * A strut's frame (posts, cross braces, end plates) and its lamps, centred on the strut. Real
 * struts pass nothing and get steel and glowing lamps; the hologram passes one material.
 */
export function StrutBody({ strut, material, flames, broken }: {
  strut: Pick<Strut, 'i' | 'j0' | 'j1'>; material?: THREE.Material; flames?: (THREE.MeshBasicMaterial | null)[]; broken?: boolean;
}) {
  // A dug-out strut looks dead: dark rusty steel, lamps out.
  const m = (own: THREE.Material) => material ?? (broken && own !== STRUT_MATS.brass ? STRUT_MATS.rusted : own);
  const y0 = strut.j0 * CELL, h = (strut.j1 + 1) * CELL - y0;
  const cx = (strut.i + 0.5) * CELL, cy = y0 + h / 2;
  const braces = Math.max(1, Math.floor(h / 0.6));
  const lamps = strutLamps(strut);
  return (
    <>
      <group position={[cx, cy, Z_STRUT]}>
        {[-0.07, 0.07].map((dx) => <mesh key={dx} position={[dx, 0, 0]} material={m(STRUT_MATS.post)}><boxGeometry args={[0.05, h, 0.1]} /></mesh>)}
        {Array.from({ length: braces }, (_, n) => (
          <mesh key={n} position={[0, -h / 2 + (n + 0.5) * (h / braces), 0]} rotation={[0, 0, n % 2 ? 0.9 : -0.9]} material={m(STRUT_MATS.brace)}>
            <boxGeometry args={[0.03, 0.2, 0.04]} />
          </mesh>
        ))}
        {[1, -1].map((s) => <mesh key={s} position={[0, s * (h / 2 - 0.03), 0]} material={m(STRUT_MATS.plate)}><boxGeometry args={[0.3, 0.06, 0.3]} /></mesh>)}
      </group>
      {lamps.map((l, n) => (
        <group key={n} position={[l.x, l.y, l.z]}>
          <mesh position={[-l.side * 0.03, 0.035, -0.02]} rotation={[0, 0, Math.PI / 2]} material={m(STRUT_MATS.iron)}><cylinderGeometry args={[0.005, 0.005, 0.06, 4]} /></mesh>
          <mesh position={[0, 0.035, 0]} material={m(STRUT_MATS.brass)}><coneGeometry args={[0.022, 0.02, 8]} /></mesh>
          {material
            ? <mesh material={material}><cylinderGeometry args={[0.014, 0.014, 0.05, 8]} /></mesh>
            : <mesh><cylinderGeometry args={[0.014, 0.014, 0.05, 8]} /><meshBasicMaterial ref={(f) => { if (flames) flames[n] = f; }} /></mesh>}
          <mesh position={[0, -0.03, 0]} material={m(STRUT_MATS.brass)}><cylinderGeometry args={[0.018, 0.015, 0.01, 8]} /></mesh>
        </group>
      ))}
    </>
  );
}

/**
 * Point lights for the strut lamps nearest the middle of the view. Every lamp glows, but only
 * a handful cast light, so building lots of struts doesn't multiply the lighting cost. A light
 * stays with its lamp while it fades out, and fades in at its next lamp, so lamps never snap dark
 * as the camera moves.
 */
const STRUT_LIGHTS = 10;
function StrutLamps({ game }: { game: Game }) {
  const lights = useRef<(THREE.PointLight | null)[]>([]);
  const slots = useRef(Array.from({ length: STRUT_LIGHTS }, () => ({ key: null as string | null, level: 0, x: 0, y: 0, z: 0 })));
  useFrame(({ clock }, dt) => {
    const v = game.view;
    const nearest = game.struts.filter((s) => !s.broken)
      .flatMap((s) => strutLamps(s).map((p, n) => ({ p, key: `${s.id}:${s.j0}:${s.j1}:${n}` })))
      .sort((a, b) => Math.hypot(a.p.x - v.x, a.p.y - v.y) - Math.hypot(b.p.x - v.x, b.p.y - v.y))
      .slice(0, STRUT_LIGHTS);
    const wanted = new Map(nearest.map((l) => [l.key, l.p]));
    const rate = dt * 2.5;
    for (const slot of slots.current) {
      if (!slot.key) continue;
      if (wanted.has(slot.key)) { slot.level = Math.min(1, slot.level + rate); wanted.delete(slot.key); }
      else if ((slot.level -= rate) <= 0) { slot.level = 0; slot.key = null; }
    }
    for (const [key, p] of wanted) {
      const free = slots.current.find((sl) => !sl.key);
      if (!free) break;
      Object.assign(free, { key, level: 0, x: p.x, y: p.y, z: p.z + 0.2 });
    }
    lights.current.forEach((l, n) => {
      if (!l) return;
      const slot = slots.current[n];
      l.intensity = 0.9 * slot.level * (0.85 + Math.sin(clock.elapsedTime * 11 + n * 2.3) * 0.08);
      l.position.set(slot.x, slot.y, slot.z);
    });
  });
  return <>{Array.from({ length: STRUT_LIGHTS }, (_, n) => <pointLight key={n} ref={(l) => { lights.current[n] = l; }} color="#ffb46b" distance={3} decay={1.4} intensity={0} />)}</>;
}

/**
 * A grout plinth: a square frustum one unit tall, wide (0.38) where it meets the rock and as wide
 * as the plate (0.28) where it meets the steel. Origin at the plate end; +y runs into the rock.
 */
const groutGeometry = (() => {
  const g = new THREE.CylinderGeometry(0.27, 0.2, 1, 4, 1);
  g.rotateY(Math.PI / 4);
  g.translate(0, 0.5, 0);
  g.computeVertexNormals();
  return g;
})();

/**
 * How far from a plate edge at height `y` the rock surface is, looking `dir` (-1 down, +1 up),
 * across the plate's width. The surface is the terrain's density isoline, which can sit well
 * past the cell boundary the plate rests on once the rock there has been partly dug.
 */
function surfaceGap(game: Game, x: number, y: number, dir: number) {
  let gap = 0;
  for (const dx of [-0.12, 0, 0.12]) {
    let d = 0;
    while (d < 1.2 && game.terrain.sample(x + dx, y + dir * d) <= ISO) d += 0.02;
    gap = Math.max(gap, d);
  }
  return gap;
}

/**
 * Grout poured between a strut's plates and the surfaces they bear on, like the base of a steel
 * column, so the plates never hang in the air over an uneven or partly dug floor or ceiling.
 * Re-measured as the rock changes.
 */
function StrutFootings({ strut, game }: { strut: Strut; game: Game }) {
  const refs = [useRef<THREE.Mesh>(null!), useRef<THREE.Mesh>(null!)];
  const x = (strut.i + 0.5) * CELL;
  const ends = useMemo(() => [
    { y: strut.j0 * CELL, dir: -1 },
    { y: (strut.j1 + 1) * CELL, dir: 1 },
  ], [strut]);
  const next = useRef(0);
  useFrame(({ clock }) => {
    if (clock.elapsedTime < next.current) return;
    next.current = clock.elapsedTime + 0.5;
    ends.forEach((e, n) => {
      // Run the grout a little into the rock, with a minimum height so it always reads as a base.
      const h = surfaceGap(game, x, e.y, e.dir) + 0.1;
      const mesh = refs[n].current;
      mesh.scale.set(1, h, 1);
      mesh.rotation.x = e.dir < 0 ? Math.PI : 0;
      mesh.position.set(x, e.y, Z_STRUT);
    });
  });
  return <>{ends.map((e, n) => <mesh key={n} ref={refs[n]} geometry={groutGeometry} material={groutMaterial()} />)}</>;
}

function StrutModel({ strut, game }: { strut: Strut; game: Game }) {
  const flames = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const phase = useMemo(() => Math.random() * 10, []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + phase;
    flames.current.forEach((f, n) => {
      if (!f) return;
      const k = strut.broken ? 0.03 : 0.8 + Math.sin(t * 11 + n * 1.9) * 0.08 + Math.sin(t * 23 + n) * 0.06 + (Math.random() - 0.5) * 0.06;
      f.color.setRGB(3 * k, 1.5 * k, 0.4 * k);
    });
  });
  return (
    <>
      <StrutBody strut={strut} flames={flames.current} broken={strut.broken} />
      {/* A dug-out strut no longer bears on the rock, so it has no grout base. */}
      {!strut.broken && <StrutFootings strut={strut} game={game} />}
    </>
  );
}

const SMELTER_MATS = {
  brick: brickMaterial(),
  body: rustMaterial('#4a4038', 0.55),
  dark: rustMaterial('#2c2724', 0.35),
  brass: new THREE.MeshStandardMaterial({ color: '#b8934a', metalness: 0.55, roughness: 0.5 }),
  leather: new THREE.MeshStandardMaterial({ color: '#4a2f1c', roughness: 0.9 }),
  wood: new THREE.MeshStandardMaterial({ color: '#5a3b22', roughness: 0.85 }),
  ore: new THREE.MeshStandardMaterial({ color: '#a5602f', roughness: 0.8 }),
};

/** Moving and glowing parts of a smelter, animated by SmelterModel. */
interface SmelterParts {
  mouth: Ref<THREE.MeshBasicMaterial>;
  bellows: Ref<THREE.Group>;
  stream: Ref<THREE.Mesh>;
  ingot: Ref<THREE.MeshBasicMaterial>;
  ore: Ref<THREE.Group>;
  light: Ref<THREE.PointLight>;
}

/**
 * A small crucible furnace on a firebrick plinth: rusty iron body with a domed top and chimney,
 * a fire door, an ore hopper feeding it from the right, hand bellows on the left, and a spout
 * pouring into an ingot mould. Origin at its base. Real smelters pass `parts` to animate; the
 * placement hologram passes one `material` for everything.
 */
export function SmelterBody({ material, parts }: { material?: THREE.Material; parts?: SmelterParts }) {
  const m = (own: THREE.Material) => material ?? own;
  const glow = (ref: Ref<THREE.MeshBasicMaterial> | undefined) => (material ? undefined : <meshBasicMaterial ref={ref} />);
  return (
    <>
      <mesh position={[0, 0.08, 0]} material={m(SMELTER_MATS.brick)}><boxGeometry args={[0.92, 0.16, 0.6]} /></mesh>
      {/* Furnace body, bands, dome and chimney */}
      <mesh position={[-0.1, 0.41, 0]} material={m(SMELTER_MATS.body)}><cylinderGeometry args={[0.27, 0.29, 0.5, 20]} /></mesh>
      {[0.22, 0.6].map((y) => <mesh key={y} position={[-0.1, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={m(SMELTER_MATS.brass)}><torusGeometry args={[0.285, 0.014, 6, 28]} /></mesh>)}
      <mesh position={[-0.1, 0.66, 0]} material={m(SMELTER_MATS.body)}><sphereGeometry args={[0.27, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2]} /></mesh>
      <mesh position={[-0.12, 1.0, -0.04]} rotation={[0, 0, 0.05]} material={m(SMELTER_MATS.dark)}><cylinderGeometry args={[0.05, 0.065, 0.5, 10]} /></mesh>
      <mesh position={[-0.13, 1.27, -0.04]} material={m(SMELTER_MATS.dark)}><coneGeometry args={[0.1, 0.07, 10]} /></mesh>
      {/* Fire door */}
      <mesh position={[-0.1, 0.36, 0.27]} material={m(SMELTER_MATS.brass)}><torusGeometry args={[0.095, 0.018, 8, 20]} /></mesh>
      <mesh position={[-0.1, 0.36, 0.272]} material={material}><circleGeometry args={[0.085, 18]} />{glow(parts?.mouth)}</mesh>
      {/* Ore hopper on legs, with a chute into the furnace */}
      <mesh position={[0.29, 0.8, -0.02]} material={m(SMELTER_MATS.body)}><cylinderGeometry args={[0.15, 0.06, 0.22, 12, 1, true]} /></mesh>
      {[0.22, 0.36].map((x) => <mesh key={x} position={[x, 0.42, -0.02]} material={m(SMELTER_MATS.dark)}><cylinderGeometry args={[0.012, 0.012, 0.52, 6]} /></mesh>)}
      <mesh position={[0.15, 0.66, -0.02]} rotation={[0, 0, 1.0]} material={m(SMELTER_MATS.dark)}><cylinderGeometry args={[0.025, 0.025, 0.22, 8]} /></mesh>
      <group ref={parts?.ore} position={[0.29, 0.86, -0.02]}>
        {[[-0.05, 0], [0.04, 0.03], [0, -0.04]].map(([x, z], n) => <mesh key={n} position={[x, 0, z]} material={m(SMELTER_MATS.ore)}><dodecahedronGeometry args={[0.04]} /></mesh>)}
      </group>
      {/* Bellows: two boards and a leather bag, hinged at the back, blowing into the furnace */}
      <group position={[-0.47, 0.3, 0.06]}>
        <mesh position={[0.08, -0.015, 0]} material={m(SMELTER_MATS.wood)}><boxGeometry args={[0.18, 0.02, 0.15]} /></mesh>
        <group ref={parts?.bellows}>
          <mesh position={[0.08, 0.015, 0]} material={m(SMELTER_MATS.wood)}><boxGeometry args={[0.18, 0.02, 0.15]} /></mesh>
        </group>
        <mesh position={[0.07, 0, 0]} scale={[1, 0.6, 1]} material={m(SMELTER_MATS.leather)}><sphereGeometry args={[0.075, 10, 6]} /></mesh>
        <mesh position={[0.2, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={m(SMELTER_MATS.brass)}><cylinderGeometry args={[0.012, 0.02, 0.08, 8]} /></mesh>
      </group>
      {/* Spout, molten stream and the ingot mould on a little stand */}
      <mesh position={[0.21, 0.29, 0.06]} rotation={[0, 0, -0.35]} material={m(SMELTER_MATS.dark)}><boxGeometry args={[0.16, 0.03, 0.05]} /></mesh>
      <mesh ref={parts?.stream} position={[0.29, 0.235, 0.06]} material={material}><cylinderGeometry args={[0.008, 0.012, 0.07, 6]} />{material ? null : <meshBasicMaterial color={[4, 1.8, 0.4]} />}</mesh>
      <mesh position={[0.31, 0.18, 0.06]} material={m(SMELTER_MATS.dark)}><boxGeometry args={[0.2, 0.04, 0.15]} /></mesh>
      <mesh position={[0.31, 0.202, 0.06]} material={material}><boxGeometry args={[0.15, 0.008, 0.1]} />{glow(parts?.ingot)}</mesh>
      {!material && <pointLight ref={parts?.light} position={[-0.1, 0.4, 0.5]} color="#ff8a3a" distance={3} decay={1.5} intensity={0} />}
    </>
  );
}

/**
 * Animates a smelter while it works: the fire door flickers, the bellows pump, the chimney
 * smokes, the hopper shows ore, and near the end of each batch molten copper pours into the mould,
 * where the new ingot glows and then cools.
 */
function SmelterModel({ smelter, game }: { smelter: Smelter; game: Game }) {
  const parts = {
    mouth: useRef<THREE.MeshBasicMaterial>(null!), bellows: useRef<THREE.Group>(null!), stream: useRef<THREE.Mesh>(null!),
    ingot: useRef<THREE.MeshBasicMaterial>(null!), ore: useRef<THREE.Group>(null!), light: useRef<THREE.PointLight>(null!),
  };
  const smoke = useRef(0);
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime, active = smelter.crafting;
    const f = smelter.smeltTimer / RECIPES[smelter.recipe].time;
    const heat = active ? 1 : Math.max(0, (smelter.hotUntil - game.time) / 1.5) * 0.6;
    const flick = 0.85 + Math.sin(t * 17) * 0.08 + Math.random() * 0.12;
    parts.mouth.current.color.setRGB(0.3 + 3 * heat * flick, 0.08 + 1.2 * heat * flick, 0.02 + 0.25 * heat);
    parts.light.current.intensity = 2.2 * heat * flick;
    parts.bellows.current.rotation.z = active ? 0.06 + 0.22 * (0.5 + 0.5 * Math.sin(t * 7)) : 0.05;
    // Pour in the last quarter of a batch; the ingot glows as it fills, then cools.
    const pouring = active && f > 0.7 && f < 0.97;
    parts.stream.current.visible = pouring;
    parts.stream.current.scale.set(0.8 + Math.random() * 0.4, 1, 0.8 + Math.random() * 0.4);
    const ingotHeat = active ? Math.max(0, (f - 0.7) / 0.3) : Math.max(0, (smelter.hotUntil - game.time) / 1.5);
    parts.ingot.current.color.setRGB(0.08 + 3.5 * ingotHeat, 0.05 + 1.4 * ingotHeat, 0.03 + 0.3 * ingotHeat);
    parts.ore.current.visible = game.resources.ore >= 1 || active;
    smoke.current -= dt;
    if (active && smoke.current <= 0 && game.gpu) {
      smoke.current = 0.5 + Math.random() * 0.4;
      game.gpu.burst(smelter.x - 0.13, smelter.y + 1.32, 4, ParticleKind.Steam, 0.4, 0.03);
      if (Math.random() < 0.4) game.gpu.burst(smelter.x - 0.1, smelter.y + 0.36, 4, ParticleKind.Spark, 1.2, 0.04);
    }
  });
  return (
    <group position={[smelter.x, smelter.y, Z_ACTORS]}>
      <SmelterBody parts={parts} />
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

const OUTPOST_MATS = {
  tank: rustMaterial('#4a4440', 0.45),
  frame: rustMaterial('#2c2724', 0.35),
  brass: new THREE.MeshStandardMaterial({ color: '#b8934a', metalness: 0.55, roughness: 0.5 }),
};

/**
 * An outpost: a rusty pressure tank on a skid with a deck on legs above it, two brass landing pads,
 * a stack and a beacon. Origin at its base, centred. Real outposts pass `rings`/`beacon` to light;
 * the placement hologram passes one `material`.
 */
export function OutpostBody({ material, rings, beacon }: { material?: THREE.Material; rings?: Ref<THREE.Group>; beacon?: Ref<THREE.MeshBasicMaterial> }) {
  const m = (own: THREE.Material) => material ?? own;
  const z = -DEPTH * 0.6;
  const deckY = OUTPOST.height;
  return (
    <>
      <mesh position={[0, 0.05, z]} material={m(OUTPOST_MATS.frame)}><boxGeometry args={[OUTPOST.width - 0.2, 0.1, 0.7]} /></mesh>
      <mesh position={[0, 0.42, z]} material={m(OUTPOST_MATS.tank)}><cylinderGeometry args={[0.3, 0.3, 0.62, 18]} /></mesh>
      <mesh position={[0, 0.74, z]} material={m(OUTPOST_MATS.tank)}><sphereGeometry args={[0.3, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2]} /></mesh>
      {[0.2, 0.62].map((y) => <mesh key={y} position={[0, y, z]} rotation={[Math.PI / 2, 0, 0]} material={m(OUTPOST_MATS.brass)}><torusGeometry args={[0.305, 0.012, 6, 24]} /></mesh>)}
      {/* Deck on four legs, carrying the two pads */}
      {[-0.75, 0.75].flatMap((x) => [z - 0.25, z + 0.25].map((lz) => (
        <mesh key={`${x}${lz}`} position={[x, deckY / 2, lz]} material={m(OUTPOST_MATS.frame)}><cylinderGeometry args={[0.025, 0.03, deckY, 6]} /></mesh>
      )))}
      <mesh position={[0, deckY - 0.02, z]} material={m(OUTPOST_MATS.frame)}><boxGeometry args={[1.6, 0.04, 0.66]} /></mesh>
      {[-0.35, 0.35].map((x) => (
        <mesh key={x} position={[x, deckY + 0.012, Z_ACTORS]} material={m(OUTPOST_MATS.brass)}><cylinderGeometry args={[0.17, 0.17, 0.025, 24]} /></mesh>
      ))}
      <group ref={rings}>
        {[-0.35, 0.35].map((x) => (
          <mesh key={x} position={[x, deckY + 0.03, Z_ACTORS]} rotation={[Math.PI / 2, 0, 0]} material={material}>
            <torusGeometry args={[0.15, 0.012, 6, 24]} />{material ? null : <meshBasicMaterial color="black" />}
          </mesh>
        ))}
      </group>
      {/* Stack and beacon */}
      <mesh position={[0.7, deckY + 0.3, z - 0.2]} rotation={[0, 0, 0.04]} material={m(OUTPOST_MATS.frame)}><cylinderGeometry args={[0.05, 0.06, 0.6, 10]} /></mesh>
      <mesh position={[-0.7, deckY + 0.25, z - 0.2]} material={m(OUTPOST_MATS.frame)}><cylinderGeometry args={[0.012, 0.016, 0.5, 6]} /></mesh>
      <mesh position={[-0.7, deckY + 0.52, z - 0.2]} material={material}><sphereGeometry args={[0.035, 10, 8]} />{material ? null : <meshBasicMaterial ref={beacon} />}</mesh>
    </>
  );
}

/** A built outpost: pad rings show docked (green) or out (amber) drones; the beacon blinks. */
function OutpostModel({ base, game }: { base: BaseSite; game: Game }) {
  const rings = useRef<THREE.Group>(null!);
  const beacon = useRef<THREE.MeshBasicMaterial>(null!);
  const light = useRef<THREE.PointLight>(null!);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const on = Math.sin(t * 3) > 0.5;
    beacon.current.color.setRGB(on ? 3 : 0.3, on ? 1.4 : 0.1, 0);
    light.current.intensity = 1.8 * (0.9 + Math.sin(t * 11) * 0.05);
    rings.current.children.forEach((c, n) => {
      const bot = game.bots.find((b) => !b.dead && b.pad === `${base.id}:${n}`);
      const mat = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
      if (bot?.state === 'docked') mat.color.setRGB(0.3, 2.2, 0.6);
      else if (bot) mat.color.setRGB(Math.sin(t * 3 + n) > 0 ? 2.4 : 0.3, Math.sin(t * 3 + n) > 0 ? 1.2 : 0.15, 0);
      else mat.color.setRGB(0.12, 0.07, 0.05);
    });
  });
  return (
    <group position={[base.x, base.y, 0]}>
      <OutpostBody rings={rings} beacon={beacon} />
      <pointLight ref={light} position={[0, 1.4, 0.4]} color="#ffcf99" distance={6} decay={1.4} />
    </group>
  );
}

const GIRDER_MATS = {
  steel: rustMaterial('#4c4a48', 0.35),
  rivet: new THREE.MeshStandardMaterial({ color: '#8a7a5a', metalness: 0.7, roughness: 0.45 }),
};

/**
 * A riveted steel girder `length` long, one cell deep top to bottom and running the whole depth
 * of the slice: a deck plate on top, a bottom chord, and a lattice of braces on the front and back
 * faces. Origin at its centre on the cutaway face; placement holograms pass one `material`.
 */
export function GirderBody({ length, material }: { length: number; material?: THREE.Material }) {
  const m = (own: THREE.Material) => material ?? own;
  const bays = Math.max(1, Math.round(length / 0.25)), bay = length / bays;
  const h = CELL * 0.72, angle = Math.atan2(h, bay), diag = Math.hypot(h, bay);
  const z = -DEPTH / 2;
  return (
    <>
      <mesh position={[0, CELL * 0.4, z]} material={m(GIRDER_MATS.steel)}><boxGeometry args={[length, 0.05, DEPTH]} /></mesh>
      <mesh position={[0, -CELL * 0.42, z]} material={m(GIRDER_MATS.steel)}><boxGeometry args={[length, 0.035, DEPTH * 0.96]} /></mesh>
      {[-0.03, -DEPTH + 0.03].map((fz) => (
        <group key={fz} position={[0, 0, fz]}>
          {Array.from({ length: bays }, (_, n) => (
            <mesh key={n} position={[-length / 2 + (n + 0.5) * bay, 0, 0]} rotation={[0, 0, n % 2 ? -angle : angle]} material={m(GIRDER_MATS.steel)}>
              <boxGeometry args={[diag, 0.022, 0.02]} />
            </mesh>
          ))}
          {Array.from({ length: bays + 1 }, (_, n) => (
            <mesh key={`v${n}`} position={[-length / 2 + n * bay, 0, 0]} material={m(GIRDER_MATS.steel)}><boxGeometry args={[0.025, h + 0.04, 0.025]} /></mesh>
          ))}
        </group>
      ))}
      {Array.from({ length: bays * 2 }, (_, n) => (
        <mesh key={`r${n}`} position={[-length / 2 + (n + 0.5) * (bay / 2), CELL * 0.4, 0.002]} rotation={[Math.PI / 2, 0, 0]} material={m(GIRDER_MATS.rivet)}>
          <cylinderGeometry args={[0.011, 0.011, 0.012, 6]} />
        </mesh>
      ))}
    </>
  );
}

function GirderModel({ girder }: { girder: Girder }) {
  const length = (girder.i1 - girder.i0 + 1) * CELL;
  return (
    <group position={[girder.i0 * CELL + length / 2, (girder.j + 0.5) * CELL, 0]}>
      <GirderBody length={length} />
    </group>
  );
}

const DEPOT_MATS = {
  wall: rustMaterial('#5a4a3a', 0.5),
  frame: rustMaterial('#2c2724', 0.35),
  brass: new THREE.MeshStandardMaterial({ color: '#b8934a', metalness: 0.55, roughness: 0.5 }),
  stripe: new THREE.MeshStandardMaterial({ color: '#d9a21a', roughness: 0.7 }),
  black: new THREE.MeshStandardMaterial({ color: '#141210', roughness: 0.8 }),
  bench: new THREE.MeshStandardMaterial({ color: '#5a3b22', roughness: 0.85 }),
};

/**
 * A vehicle depot: an open-fronted corrugated shed with a rolled-up shutter, hazard-striped
 * lintel, a chain hoist, a workbench and a status lamp. Origin at its floor, centred.
 */
export function DepotBody({ material, lamp }: { material?: THREE.Material; lamp?: Ref<THREE.MeshBasicMaterial> }) {
  const m = (own: THREE.Material) => material ?? own;
  const w = DEPOT.width, h = DEPOT.height, back = -DEPTH * 0.9;
  return (
    <>
      <mesh position={[0, 0.01, -DEPTH / 2]} material={m(DEPOT_MATS.frame)}><boxGeometry args={[w, 0.02, DEPTH * 0.85]} /></mesh>
      <mesh position={[0, h / 2, back]} material={m(DEPOT_MATS.wall)}><boxGeometry args={[w, h, 0.05]} /></mesh>
      {Array.from({ length: 12 }, (_, n) => (
        <mesh key={n} position={[-w / 2 + 0.06 + n * ((w - 0.12) / 11), h / 2, back + 0.035]} material={m(DEPOT_MATS.wall)}><boxGeometry args={[0.03, h - 0.04, 0.02]} /></mesh>
      ))}
      {[-w / 2, w / 2].flatMap((x) => [-0.1, back].map((z) => (
        <mesh key={`${x}${z}`} position={[x, h / 2, z]} material={m(DEPOT_MATS.frame)}><boxGeometry args={[0.06, h, 0.06]} /></mesh>
      )))}
      {/* Roof with a lip, the rolled-up shutter and a hazard-striped lintel */}
      <mesh position={[0, h + 0.03, -DEPTH / 2 + 0.02]} rotation={[0.05, 0, 0]} material={m(DEPOT_MATS.wall)}><boxGeometry args={[w + 0.14, 0.05, DEPTH * 0.95]} /></mesh>
      <mesh position={[0, h - 0.05, -0.14]} rotation={[0, 0, Math.PI / 2]} material={m(DEPOT_MATS.frame)}><cylinderGeometry args={[0.055, 0.055, w - 0.06, 12]} /></mesh>
      {Array.from({ length: 10 }, (_, n) => (
        <mesh key={`s${n}`} position={[-w / 2 + 0.075 + n * ((w - 0.15) / 9), h - 0.13, -0.08]} rotation={[0, 0, 0.6]} material={m(n % 2 ? DEPOT_MATS.black : DEPOT_MATS.stripe)}>
          <boxGeometry args={[0.07, 0.05, 0.02]} />
        </mesh>
      ))}
      {/* Chain hoist on a beam */}
      <mesh position={[0, h - 0.12, -DEPTH / 2]} rotation={[Math.PI / 2, 0, 0]} material={m(DEPOT_MATS.frame)}><boxGeometry args={[0.05, DEPTH * 0.8, 0.05]} /></mesh>
      <mesh position={[0.2, h - 0.35, -DEPTH / 2]} material={m(DEPOT_MATS.brass)}><cylinderGeometry args={[0.006, 0.006, 0.42, 4]} /></mesh>
      <mesh position={[0.2, h - 0.58, -DEPTH / 2]} rotation={[0, 0, Math.PI / 2]} material={m(DEPOT_MATS.brass)}><torusGeometry args={[0.03, 0.008, 6, 12, Math.PI * 1.4]} /></mesh>
      {/* Workbench with a toolbox, against the back wall */}
      <mesh position={[-0.5, 0.28, back + 0.16]} material={m(DEPOT_MATS.bench)}><boxGeometry args={[0.4, 0.04, 0.22]} /></mesh>
      {[-0.67, -0.33].map((x) => <mesh key={x} position={[x, 0.13, back + 0.16]} material={m(DEPOT_MATS.frame)}><boxGeometry args={[0.03, 0.26, 0.18]} /></mesh>)}
      <mesh position={[-0.55, 0.34, back + 0.16]} material={m(DEPOT_MATS.stripe)}><boxGeometry args={[0.14, 0.08, 0.08]} /></mesh>
      {/* Status lamp: green with a vehicle to build, amber while its vehicle is out */}
      <mesh position={[w / 2 - 0.1, h - 0.22, -0.1]} material={material}><sphereGeometry args={[0.03, 10, 8]} />{material ? null : <meshBasicMaterial ref={lamp} />}</mesh>
    </>
  );
}

function DepotModel({ depot, game }: { depot: Depot; game: Game }) {
  const lamp = useRef<THREE.MeshBasicMaterial>(null!);
  useFrame(({ clock }) => {
    const out = game.vehicles.some((v) => v.depotId === depot.id);
    const blink = Math.sin(clock.elapsedTime * 2.5) > 0 ? 1 : 0.4;
    if (out) lamp.current.color.setRGB(2.4 * blink, 1.2 * blink, 0); else lamp.current.color.setRGB(0.3, 2.2, 0.5);
  });
  return (
    <group position={[depot.x, depot.y, 0]}>
      <DepotBody lamp={lamp} />
      <pointLight position={[0, DEPOT.height - 0.2, -0.3]} color="#ffd9a8" distance={3.5} decay={1.5} intensity={1.2} />
    </group>
  );
}

const VEHICLE_MATS = {
  paint: rustMaterial('#8a4a22', 0.4),
  frame: rustMaterial('#2c2724', 0.35),
  brass: new THREE.MeshStandardMaterial({ color: '#c9a050', metalness: 0.65, roughness: 0.4 }),
  steel: new THREE.MeshStandardMaterial({ color: '#8f9399', metalness: 0.8, roughness: 0.35 }),
  tyre: new THREE.MeshStandardMaterial({ color: '#1a1816', roughness: 0.95 }),
  glass: new THREE.MeshStandardMaterial({ color: '#1d2a30', metalness: 0.2, roughness: 0.15 }),
};
/** Bucket fill colour by material id (what's mostly in it). */
const SPOIL_COLORS = ['#000', '#6b4a32', '#5f5d5b', '#9a6440', '#9fc8dc', '#2b2a2e', '#5e4c3c', '#5f6450', '#7a3f2c', '#3c4250'];

/**
 * A steam-driven mining vehicle: a riveted hull with a brass boiler and stack, a cyclops lamp, a
 * spinning drill on a tilting arm at the front, and a bucket at the back that visibly fills.
 * The wheels are separate rigid bodies, drawn where they are.
 */
function VehicleModel({ vehicle, game }: { vehicle: Vehicle; game: Game }) {
  const root = useRef<THREE.Group>(null!);
  const flip = useRef<THREE.Group>(null!);
  const arm = useRef<THREE.Group>(null!);
  const bit = useRef<THREE.Group>(null!);
  const fill = useRef<THREE.Mesh>(null!);
  const fillMat = useRef<THREE.MeshStandardMaterial>(null!);
  const eye = useRef<THREE.MeshBasicMaterial>(null!);
  const light = useRef<THREE.PointLight>(null!);
  const marker = useRef<THREE.Mesh>(null!);
  const wheels = useRef<(THREE.Group | null)[]>([]);
  const state = useMemo(() => ({ spin: 0, puff: 0 }), []);
  useFrame(({ clock }, dt) => {
    if (vehicle.removed) return;
    const p = vehicle.body.translation();
    root.current.position.set(p.x, p.y, Z_ACTORS);
    root.current.rotation.z = vehicle.body.rotation();
    flip.current.scale.x = vehicle.facing;
    arm.current.rotation.z = vehicle.drillAngle;
    state.spin += dt * (vehicle.drilling ? 30 : 0);
    bit.current.rotation.x = state.spin;
    const load = Math.min(1, bucketTotal(vehicle) / VEHICLE.bucket);
    fill.current.visible = load > 0.01;
    fill.current.scale.y = Math.max(0.01, load);
    fill.current.position.y = 0.02 + 0.09 * load;
    let top = 0, most = 0;
    for (const [m, n] of Object.entries(vehicle.bucket)) if (n > most) { most = n; top = Number(m); }
    fillMat.current.color.set(SPOIL_COLORS[top] ?? '#5e4c3c');
    const driven = game.driving === vehicle;
    eye.current.color.setRGB(driven ? 3 : 0.6, driven ? 2.2 : 0.4, driven ? 0.8 : 0.2);
    light.current.intensity = driven ? 2.5 : 0;
    marker.current.visible = driven;
    marker.current.position.y = 0.5 + Math.sin(clock.elapsedTime * 4) * 0.03;
    vehicle.wheels.forEach((w, n) => {
      const g = wheels.current[n];
      if (!g) return;
      const wp = w.translation();
      g.position.set(wp.x, wp.y, Z_ACTORS);
      g.rotation.z = w.rotation();
    });
    // The stack puffs while it drives or drills.
    state.puff -= dt;
    if (driven && (game.drive.throttle || vehicle.drilling) && state.puff <= 0 && game.gpu) {
      state.puff = 0.25;
      const a = vehicle.body.rotation(), lx = -0.12 * vehicle.facing, ly = 0.34;
      game.gpu.burst(p.x + lx * Math.cos(a) - ly * Math.sin(a), p.y + lx * Math.sin(a) + ly * Math.cos(a), 3, ParticleKind.Steam, 0.4, 0.03);
    }
  });
  return (
    <>
      <group ref={root}>
        <group ref={flip}>
          {/* Hull: frame, painted body, boiler with brass bands, stack, cab dome and lamp */}
          <mesh position={[0, -0.03, 0]} material={VEHICLE_MATS.frame}><boxGeometry args={[0.82, 0.08, 0.34]} /></mesh>
          <mesh position={[0.02, 0.06, 0]} material={VEHICLE_MATS.paint}><boxGeometry args={[0.56, 0.12, 0.3]} /></mesh>
          <mesh position={[-0.04, 0.17, 0]} rotation={[0, 0, Math.PI / 2]} material={VEHICLE_MATS.brass}><cylinderGeometry args={[0.07, 0.07, 0.3, 14]} /></mesh>
          {[-0.14, 0.06].map((x) => <mesh key={x} position={[x, 0.17, 0]} rotation={[0, 0, Math.PI / 2]} material={VEHICLE_MATS.frame}><cylinderGeometry args={[0.074, 0.074, 0.02, 14]} /></mesh>)}
          <mesh position={[-0.12, 0.28, -0.04]} material={VEHICLE_MATS.frame}><cylinderGeometry args={[0.025, 0.032, 0.14, 8]} /></mesh>
          <mesh position={[0.2, 0.15, 0]} material={VEHICLE_MATS.glass}><sphereGeometry args={[0.08, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2]} /></mesh>
          <mesh position={[0.3, 0.07, 0.1]}><sphereGeometry args={[0.025, 10, 8]} /><meshBasicMaterial ref={eye} /></mesh>
          <pointLight ref={light} position={[0.5, 0.1, 0.3]} color="#ffe0a8" distance={4} decay={1.4} intensity={0} />
          {/* Bucket at the back, filling with what the drill cuts */}
          <group position={[-0.46, 0.02, 0]}>
            <mesh position={[0, 0, 0]} material={VEHICLE_MATS.frame}><boxGeometry args={[0.24, 0.025, 0.3]} /></mesh>
            <mesh position={[-0.13, 0.1, 0]} rotation={[0, 0, -0.35]} material={VEHICLE_MATS.frame}><boxGeometry args={[0.025, 0.22, 0.3]} /></mesh>
            <mesh position={[0.11, 0.08, 0]} material={VEHICLE_MATS.frame}><boxGeometry args={[0.02, 0.16, 0.3]} /></mesh>
            <mesh position={[0, 0.1, 0.155]} material={VEHICLE_MATS.paint}><boxGeometry args={[0.24, 0.2, 0.01]} /></mesh>
            <mesh ref={fill} position={[0, 0.06, -0.01]}><boxGeometry args={[0.22, 0.18, 0.27]} /><meshStandardMaterial ref={fillMat} roughness={0.95} /></mesh>
          </group>
          {/* Drill arm and bit */}
          <group ref={arm} position={[0.42, 0.02, 0]}>
            <mesh position={[0.03, 0, 0]} material={VEHICLE_MATS.frame}><boxGeometry args={[0.1, 0.06, 0.12]} /></mesh>
            <mesh rotation={[Math.PI / 2, 0, 0]} material={VEHICLE_MATS.brass}><cylinderGeometry args={[0.04, 0.04, 0.16, 12]} /></mesh>
            <group ref={bit} position={[0.08, 0, 0]}>
              <mesh position={[0.11, 0, 0]} rotation={[0, 0, -Math.PI / 2]} material={VEHICLE_MATS.steel}><coneGeometry args={[0.1, 0.22, 7]} /></mesh>
              {[0, 1, 2].map((n) => (
                <mesh key={n} position={[0.08, 0, 0]} rotation={[(n * Math.PI * 2) / 3, 0, 0]} material={VEHICLE_MATS.brass}>
                  <boxGeometry args={[0.16, 0.012, 0.012]} />
                </mesh>
              ))}
              {[0, 1, 2].map((n) => (
                <mesh key={`f${n}`} position={[0.08, Math.cos((n * Math.PI * 2) / 3) * 0.06, Math.sin((n * Math.PI * 2) / 3) * 0.06]} rotation={[(n * Math.PI * 2) / 3, 0, -0.35]} material={VEHICLE_MATS.brass}>
                  <boxGeometry args={[0.14, 0.012, 0.02]} />
                </mesh>
              ))}
            </group>
          </group>
        </group>
        {/* "You're driving this one" marker */}
        <mesh ref={marker} rotation={[0, 0, Math.PI]}><coneGeometry args={[0.06, 0.1, 3]} /><meshBasicMaterial color={[0.4, 2.4, 3]} /></mesh>
      </group>
      {vehicle.wheels.map((_, n) => (
        <group key={n} ref={(g) => { wheels.current[n] = g; }}>
          {[0.2, -0.2].map((z) => (
            <group key={z} position={[0, 0, z]}>
              <mesh rotation={[Math.PI / 2, 0, 0]} material={VEHICLE_MATS.tyre}><cylinderGeometry args={[0.14, 0.14, 0.07, 18]} /></mesh>
              <mesh position={[0, 0, z > 0 ? 0.036 : -0.036]} rotation={[Math.PI / 2, 0, 0]} material={VEHICLE_MATS.brass}><cylinderGeometry args={[0.075, 0.075, 0.01, 12]} /></mesh>
              {[0, 1, 2].map((s) => (
                <mesh key={s} position={[0, 0, z > 0 ? 0.042 : -0.042]} rotation={[0, 0, (s * Math.PI) / 3]} material={VEHICLE_MATS.frame}><boxGeometry args={[0.13, 0.018, 0.008]} /></mesh>
              ))}
            </group>
          ))}
        </group>
      ))}
    </>
  );
}

import { useFrame } from '@react-three/fiber';
import { type Ref, useMemo, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { CELL, DEPTH, ISO } from '../config';
import { enabled } from '../debug';
import { groutMaterial } from './materials';
import type { Blast, Bot, Critter, Debris, Game, Smelter, Strut } from '../game/Game';
import { Base } from './Base';

export const Z_ACTORS = -DEPTH * 0.45;
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
      <Base game={game} />
      <Carl game={game} />
      {game.bots.filter((b) => !b.dead).map((b) => <DroneModel key={b.id} bot={b} />)}
      {game.debris.map((d) => <DebrisModel key={d.id} debris={d} />)}
      {game.struts.map((s) => <StrutModel key={`${s.id}:${s.j0}:${s.j1}:${s.broken}`} strut={s} game={game} />)}
      {game.smelters.map((s) => <SmelterModel key={s.id} smelter={s} game={game} />)}
      {game.blasts.map((b) => <BlastModel key={b.id} blast={b} />)}
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
function DroneModel({ bot }: { bot: Bot }) {
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
  const state = useMemo(() => ({ phase: Math.random() * 10, spin: 0, angle: 0 }), []);
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
    root.current.position.set(p.x, p.y + hover, Z_ACTORS);
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
    const load = Math.min(1, (bot.cargo.ore + bot.cargo.scrap) / 6);
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
      <StrutFootings strut={strut} game={game} />
    </>
  );
}

const SMELTER_MATS = {
  body: new THREE.MeshStandardMaterial({ color: '#5b4a3f', metalness: 0.5, roughness: 0.6 }),
  stack: new THREE.MeshStandardMaterial({ color: '#3d3530', metalness: 0.5 }),
  trim: new THREE.MeshStandardMaterial({ color: rust }),
};

/**
 * The smelter's shapes, with origin at its base. Real smelters pass their materials; the
 * placement hologram passes one see-through material for everything.
 */
export function SmelterBody({ material, mouth }: { material?: THREE.Material; mouth?: Ref<THREE.MeshBasicMaterial> }) {
  const m = (own: THREE.Material) => material ?? own;
  return (
    <>
      <mesh position={[0, 0.3, 0]} material={m(SMELTER_MATS.body)}><boxGeometry args={[0.8, 0.6, 0.6]} /></mesh>
      <mesh position={[0.22, 0.85, -0.1]} material={m(SMELTER_MATS.stack)}><cylinderGeometry args={[0.08, 0.1, 0.6]} /></mesh>
      <mesh position={[0, 0.62, 0]} material={m(SMELTER_MATS.trim)}><boxGeometry args={[0.86, 0.05, 0.66]} /></mesh>
      {material
        ? <mesh position={[-0.1, 0.25, 0.301]} material={material}><planeGeometry args={[0.3, 0.22]} /></mesh>
        : <mesh position={[-0.1, 0.25, 0.301]}><planeGeometry args={[0.3, 0.22]} /><meshBasicMaterial ref={mouth} /></mesh>}
    </>
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
      <SmelterBody mouth={mouth} />
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

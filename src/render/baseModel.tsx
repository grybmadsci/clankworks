import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three/webgpu';
import { DEPTH } from '../config';
import type { Game } from '../game/Game';
import { ParticleKind } from '../gpu/GpuSim';
import { ELECTRO, Finial, GlowRing, Scroll, SurfaceSparks, arcPath } from './electro';
import { gearGeometry } from './gear';
import { rustMaterial } from './materials';
import { WallMount } from './mount';
import { HUB } from '../game/base';

/**
 * The base's model — a steam boiler powered by quantum energy, a bit worse for wear — and the kit
 * of parts and finishes the other buildings, the drones and the vehicle share with it: matte brass,
 * weathered copper and clean iron, live gauges, nixie tubes, glowing circuit traces, AI-brain
 * panels and quantum ports. The base hangs off the cavern wall (see WallMount) under a raised
 * landing deck whose four pads sit where the drones dock (see dockSlot). Origins are at the floor,
 * centred.
 */

const Z_HUB = -DEPTH * 0.62;
const Z_ACTORS = -DEPTH * 0.45;
/** The real base's landing pads (see dockSlot), so the drones' docking spots line up. */
const PAD_X = [-0.6, -0.2, 0.2, 0.6];

const glow = (r: number, g: number, b: number) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b) });
const std = (color: string, metalness: number, roughness: number) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
const M = {
  iron: rustMaterial('#3b3530', 0.75),
  ironDark: rustMaterial('#25221f', 0.5),
  panel: std('#121519', 0.6, 0.45),
  enamel: std('#e8dcc0', 0.1, 0.4),
  black: std('#08090b', 0.2, 0.8),
  wire: std('#7a2a1e', 0.2, 0.6),
};

/** Steam from local points of a model every few seconds (`at` is where the model stands). */
function useSteam(game: Game, at: { x: number; y: number }, vents: [number, number][], every = 3) {
  const t = useRef(Math.random() * every);
  useFrame((_, dt) => {
    t.current -= dt;
    if (t.current > 0 || !game.gpu) return;
    t.current = every * (0.6 + Math.random() * 0.8);
    const [vx, vy] = vents[Math.floor(Math.random() * vents.length)];
    game.gpu.burst(at.x + vx, at.y + vy, 4, ParticleKind.Steam, 0.5, 0.04);
  });
}

/** A tube through world-free local points. */
const tube = (pts: [number, number, number][], r = 0.02) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), 24, r, 6, false);

// ------------------------------------------------------------------ parts

type V3 = [number, number, number];

/** Spark circuitry: lit traces along `paths`, brass terminals at their ends, sparks running along them now and then. */
function Circuit({ paths, every = 3 }: { paths: V3[][]; every?: number }) {
  const geos = useMemo(() => paths.map((p) => tube(p, 0.0035)), [paths]);
  return (
    <>
      {geos.map((g, n) => <mesh key={n} geometry={g} material={ELECTRO.arc} />)}
      {paths.flatMap((p, n) => [p[0], p[p.length - 1]].map((q, k) => <mesh key={`${n}:${k}`} position={q} material={ELECTRO.brass}><sphereGeometry args={[0.011, 8, 6]} /></mesh>))}
      <SurfaceSparks every={every} size={0.008} paths={paths} />
    </>
  );
}

/** A point on a lying boiler's face (radius R round (y, z)) at height `y1`, just proud of it. */
const face = (R: number, y: number, z: number, x: number, y1: number, out = 0.004): V3 => [x, y1, z + Math.sqrt(Math.max(0, R * R - (y1 - y) ** 2)) + out];

/** A patch over an old leak: a clean iron plate with a rivet in each corner. */
function Patch({ at, tilt = 0.15 }: { at: V3; tilt?: number }) {
  return (
    <group position={at} rotation={[-0.4, 0, tilt]}>
      <mesh material={CLEAN_IRON}><boxGeometry args={[0.15, 0.1, 0.01]} /></mesh>
      {[[-0.06, -0.035], [0.06, -0.035], [-0.06, 0.035], [0.06, 0.035]].map(([x, y]) => <mesh key={`${x}${y}`} position={[x, y, 0.007]} material={ELECTRO.brass}><sphereGeometry args={[0.009, 6, 4]} /></mesh>)}
    </group>
  );
}

// ------------------------------------------------------------------ finishes, gauges, the engine and the deck

/** Warm copper end caps, weathered to rust rather than verdigris. */
const CAP = rustMaterial('#a65c34', 0.4);
/** Cast brass for cogs and fittings: matte, not polished. */
const COG = std('#9c7c40', 0.45, 0.72);

/** The landing pads' height: on the raised deck, just under where drones dock (see dockSlot). */
const PAD_Y = HUB.h - 0.005;

/** A pressure gauge whose needle never quite settles: it hunts round its reading in small jitters. */
function LiveGauge({ position, cracked, reading = -0.6, size = 1 }: { position: V3; cracked?: boolean; reading?: number; size?: number }) {
  const needle = useRef<THREE.Group>(null!);
  const state = useRef({ v: reading, target: reading, next: 0 });
  useFrame(({ clock }, dt) => {
    const s = state.current, t = clock.elapsedTime;
    if (t > s.next) { s.target = reading + (Math.random() - 0.5) * 0.25; s.next = t + 0.3 + Math.random() * 0.8; }
    s.v += (s.target - s.v) * Math.min(1, dt * 4);
    needle.current.rotation.z = s.v + Math.sin(t * 23) * 0.012;
  });
  return (
    <group position={position} scale={size}>
      <mesh rotation={[Math.PI / 2, 0, 0]} material={ELECTRO.brass}><cylinderGeometry args={[0.07, 0.07, 0.025, 20]} /></mesh>
      <mesh position={[0, 0, 0.0135]} material={M.enamel}><circleGeometry args={[0.058, 20]} /></mesh>
      {/* Red zone and tick marks */}
      <mesh position={[0, 0, 0.0142]} rotation={[0, 0, -0.95]} material={M.wire}><ringGeometry args={[0.044, 0.054, 12, 1, 0, 0.75]} /></mesh>
      {Array.from({ length: 7 }, (_, n) => {
        const a = Math.PI * 1.15 - n * (Math.PI * 1.3 / 6);
        return <mesh key={n} position={[Math.cos(a) * 0.049, Math.sin(a) * 0.049, 0.0145]} rotation={[0, 0, a]} material={M.black}><boxGeometry args={[0.01, 0.0025, 0.001]} /></mesh>;
      })}
      <group ref={needle} position={[0, 0, 0.016]}>
        <mesh position={[0, 0.022, 0]}><boxGeometry args={[0.005, 0.046, 0.002]} /><meshBasicMaterial color="#b3261e" /></mesh>
      </group>
      <mesh position={[0, 0, 0.018]} material={ELECTRO.brass}><cylinderGeometry args={[0.007, 0.007, 0.004, 8]} /></mesh>
      {cracked && <mesh position={[-0.012, -0.008, 0.02]} rotation={[0, 0, 0.7]} material={M.black}><boxGeometry args={[0.07, 0.0025, 0.001]} /></mesh>}
    </group>
  );
}

/**
 * A steam piston turning a cog, facing the viewer: a brass cylinder with its valve chest, the
 * piston rod running out to a crosshead on slide bars, and a connecting rod from the crosshead to
 * a crank pin on the cog. The cylinder is on the cog's left (`side` 1) or right (-1); `rotation`
 * turns the whole engine (π/2: cylinder below, driving up). Steam puffs from its exhaust on each
 * stroke. Origin at the cog's axle. `bare` leaves the cog out (just its crank pin), for a second
 * engine sharing another's cog.
 */
function SteamEngine({ game, position, rotation = 0, side = 1, cog = 0.13, teeth = 14, crank = 0.055, rod = 0.2, cylLen = 0.14, pistonRod = 0.14, speed = 2.4, phase = 0, onTurn }: {
  game: Game; position: V3; rotation?: number; side?: 1 | -1; cog?: number; teeth?: number; crank?: number; rod?: number; cylLen?: number; pistonRod?: number; speed?: number; phase?: number; onTurn?: (a: number) => void;
}) {
  const gear = useRef<THREE.Group>(null!), link = useRef<THREE.Mesh>(null!), head = useRef<THREE.Group>(null!), exhaust = useRef<THREE.Object3D>(null!);
  const geo = useMemo(() => gearGeometry(cog, teeth, 0.03), [cog, teeth]);
  const last = useRef(0);
  const mouth = -side * (rod + crank + 0.05), bedA = side * 0.08, bedB = mouth - side * cylLen;
  const world = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }) => {
    const a = clock.elapsedTime * speed + phase;
    gear.current.rotation.z = a;
    const px = crank * Math.cos(a), py = crank * Math.sin(a);
    const xh = px - side * Math.sqrt(rod * rod - py * py);
    head.current.position.x = xh;
    link.current.position.set((px + xh) / 2, py / 2, 0.022);
    link.current.rotation.z = Math.atan2(py, px - xh);
    onTurn?.(a);
    // A puff at each end of the stroke.
    const stroke = Math.floor(a / Math.PI);
    if (stroke !== last.current && game.gpu) {
      last.current = stroke;
      exhaust.current.getWorldPosition(world);
      game.gpu.burst(world.x, world.y, 3, ParticleKind.Steam, 0.35, 0.03);
    }
  });
  return (
    <group position={position} rotation={[0, 0, rotation]}>
      {/* Bed plate behind it all */}
      <mesh position={[(bedA + bedB) / 2, 0, -0.035]} material={M.ironDark}><boxGeometry args={[Math.abs(bedB - bedA), 0.05, 0.015]} /></mesh>
      {/* The cog, its hub and the crank pin */}
      <group ref={gear}>
        <mesh geometry={geo} material={COG} />
        <mesh position={[crank, 0, 0.02]} rotation={[Math.PI / 2, 0, 0]} material={ELECTRO.chrome}><cylinderGeometry args={[0.009, 0.009, 0.03, 8]} /></mesh>
      </group>
      <mesh rotation={[Math.PI / 2, 0, 0]} material={M.ironDark}><cylinderGeometry args={[cog * 0.18, cog * 0.18, 0.05, 12]} /></mesh>
      {/* Slide bars, the crosshead running on them with the piston rod into the cylinder */}
      {[-1, 1].map((s) => <mesh key={s} position={[mouth / 2 + side * 0.01, s * 0.022, 0.01]} material={ELECTRO.chrome}><boxGeometry args={[Math.abs(mouth) * 0.55, 0.006, 0.006]} /></mesh>)}
      <group ref={head}>
        <mesh position={[0, 0, 0.012]} material={ELECTRO.brass}><boxGeometry args={[0.035, 0.034, 0.03]} /></mesh>
        <mesh position={[-side * pistonRod / 2, 0, 0.012]} rotation={[0, 0, Math.PI / 2]} material={ELECTRO.chrome}><cylinderGeometry args={[0.008, 0.008, pistonRod, 8]} /></mesh>
      </group>
      <mesh ref={link} material={M.iron}><boxGeometry args={[rod, 0.016, 0.012]} /></mesh>
      {/* The cylinder, with its valve chest on top and the exhaust */}
      <group position={[mouth - side * cylLen / 2, 0, 0.012]}>
        <mesh rotation={[0, 0, Math.PI / 2]} material={ELECTRO.brass}><cylinderGeometry args={[0.045, 0.045, cylLen, 16]} /></mesh>
        {[-1, 1].map((s) => <mesh key={s} position={[s * cylLen / 2, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={M.iron}><cylinderGeometry args={[0.05, 0.05, 0.014, 16]} /></mesh>)}
        <mesh position={[0, 0.055, 0]} material={M.iron}><boxGeometry args={[cylLen * 0.7, 0.035, 0.05]} /></mesh>
        <object3D ref={exhaust} position={[side * 0.02, 0.09, 0]} />
        <mesh position={[side * 0.02, 0.085, 0]} material={ELECTRO.brass}><cylinderGeometry args={[0.01, 0.012, 0.03, 8]} /></mesh>
      </group>
    </group>
  );
}

/**
 * The raised landing deck: a plate clear above the boiler carrying the four pads, glowing circuitry
 * along its front and round each pad, sparks running along it, held up by two posts at the front
 * with scroll brackets.
 */
function PadDeck() {
  const y = PAD_Y - 0.03, front = -0.39, back = -0.95, w = 1.9;
  const lit = useMemo(() => glow(0.45, 1.25, 1.6), []);
  useFrame(({ clock }) => { const k = 0.9 + Math.sin(clock.elapsedTime * 2.3) * 0.08; lit.color.setRGB(0.45 * k, 1.25 * k, 1.6 * k); });
  const traces = useMemo<V3[][]>(() => [
    [[-0.88, y, front + 0.004], [-0.4, y, front + 0.004], [-0.36, y + 0.008, front + 0.004], [0.36, y + 0.008, front + 0.004], [0.4, y, front + 0.004], [0.88, y, front + 0.004]],
  ], [y]);
  return (
    <>
      <mesh position={[0, y, (front + back) / 2]} material={M.ironDark}><boxGeometry args={[w, 0.04, front - back]} /></mesh>
      <mesh position={[0, y - 0.028, front - 0.01]} material={ELECTRO.brass}><boxGeometry args={[w, 0.012, 0.02]} /></mesh>
      <Circuit paths={traces} every={2.5} />
      {PAD_X.map((x) => (
        <group key={x} position={[x, PAD_Y, Z_ACTORS]}>
          <mesh material={ELECTRO.brass}><cylinderGeometry args={[0.15, 0.15, 0.025, 24]} /></mesh>
          <mesh position={[0, 0.014, 0]} rotation={[Math.PI / 2, 0, 0]} material={lit}><torusGeometry args={[0.125, 0.005, 4, 28]} /></mesh>
          <mesh position={[0, 0.0135, 0]} rotation={[-Math.PI / 2, 0, 0]} material={lit}><ringGeometry args={[0.03, 0.036, 16]} /></mesh>
        </group>
      ))}
      {[-0.92, 0.92].map((x) => <mesh key={x} position={[x, (0.1 + y) / 2, front + 0.04]} material={M.ironDark}><cylinderGeometry args={[0.02, 0.024, y - 0.1, 8]} /></mesh>)}
      {[-0.92, 0.92].map((x) => <Scroll key={`s${x}`} size={0.06} flip={x > 0} position={[x * 0.93, y - 0.09, front + 0.035]} />)}
      {[-1, 1].map((s) => <Finial key={s} height={0.07} position={[s * 0.93, y + 0.02, front + 0.03]} />)}
    </>
  );
}

const KR = 0.38, KY = 0.48, KZ = Z_HUB;
const onKettle = (x: number, y: number, out = 0.004) => face(KR, KY, KZ, x, y, out);






// ------------------------------------------------------------------ boiler fittings and the AI brain

/** A boiler band riveted down: the brass band, and a row of rivet heads round its front. */
function RivetedBand({ x, R = KR, y = KY, z = KZ }: { x: number; R?: number; y?: number; z?: number }) {
  return (
    <>
      <mesh position={[x, y, z]} rotation={[0, Math.PI / 2, 0]} material={ELECTRO.brass}><torusGeometry args={[R + 0.01, 0.018, 8, 40]} /></mesh>
      {Array.from({ length: 13 }, (_, n) => {
        const a = -Math.PI / 2 + (n / 12) * Math.PI;
        return [-0.014, 0.014].map((dx) => (
          <mesh key={`${n}${dx}`} position={[x + dx, y + Math.sin(a) * (R + 0.024), z + Math.cos(a) * (R + 0.024)]} material={COG}><sphereGeometry args={[0.007, 6, 4]} /></mesh>
        ));
      })}
    </>
  );
}

/** A gauge held out from the boiler's face on a short pipe, toward the viewer. */
function GaugeOnStalk({ x, y, out = 0.08, cracked, reading, size }: { x: number; y: number; out?: number; cracked?: boolean; reading?: number; size?: number }) {
  const at = onKettle(x, y, 0);
  return (
    <>
      <mesh position={[x, y, at[2] + out / 2]} rotation={[Math.PI / 2, 0, 0]} material={M.ironDark}><cylinderGeometry args={[0.012, 0.016, out, 8]} /></mesh>
      <mesh position={[x, y, at[2] + 0.004]} rotation={[Math.PI / 2, 0, 0]} material={COG}><cylinderGeometry args={[0.028, 0.028, 0.012, 10]} /></mesh>
      <LiveGauge position={[x, y, at[2] + out]} cracked={cracked} reading={reading} size={size} />
    </>
  );
}

/** Seeded numbers, so each brain panel's circuitry is the same every visit. */
function rng(seed: number) {
  let s = seed * 9301 + 49297;
  return () => { s = (s * 16807) % 2147483647; return (s % 100000) / 100000; };
}

/**
 * The base's AI brain: a board of dense circuitry in a riveted brass frame — traces routed on a
 * fine grid, chips with pin rows, a big core chip pulsing violet at the middle, and indicator
 * lamps blinking away — with sparks running along its longest traces. `door` hangs an inspection
 * door open on its left hinge.
 */
function BrainPanel({ position, w, h, seed = 1, door, density = 1 }: { position: V3; w: number; h: number; seed?: number; door?: boolean; density?: number }) {
  const parts = useMemo(() => {
    // Denser panels route on a finer grid, with more of their traces lit.
    const r = rng(seed), g = 0.02 / Math.sqrt(Math.max(1, density)), cols = Math.floor((w - 0.06) / g), rows = Math.floor((h - 0.06) / g);
    const litShare = Math.min(0.75, 0.45 + 0.12 * (density - 1));
    const x0 = -w / 2 + 0.03, y0 = -h / 2 + 0.03;
    const segs: { x: number; y: number; len: number; vert: boolean; lit: boolean }[] = [];
    const runs: V3[][] = [];
    for (let n = 0; n < Math.round(cols * rows * 0.09 * density); n++) {
      let c = Math.floor(r() * cols), k = Math.floor(r() * rows), vert = r() < 0.5;
      const lit = r() < litShare, run: V3[] = [[x0 + c * g, y0 + k * g, 0.012]];
      for (let step = 0; step < 2 + Math.floor(r() * 3); step++) {
        const len = 1 + Math.floor(r() * 4), dir = r() < 0.5 ? -1 : 1;
        const nc = vert ? c : Math.max(0, Math.min(cols, c + dir * len)), nk = vert ? Math.max(0, Math.min(rows, k + dir * len)) : k;
        const a = vert ? Math.min(k, nk) : Math.min(c, nc), b = vert ? Math.max(k, nk) : Math.max(c, nc);
        if (b > a) segs.push({ x: vert ? x0 + c * g : x0 + ((a + b) / 2) * g, y: vert ? y0 + ((a + b) / 2) * g : y0 + k * g, len: (b - a) * g, vert, lit });
        c = nc; k = nk; vert = !vert;
        run.push([x0 + c * g, y0 + k * g, 0.012]);
      }
      if (lit && run.length >= 4) runs.push(run);
    }
    const chips = Array.from({ length: Math.max(3, Math.round(w * h * 60 * density)) }, () => ({ x: x0 + 0.04 + r() * (w - 0.14), y: y0 + 0.03 + r() * (h - 0.1), w: 0.035 + r() * 0.03, h: 0.025 + r() * 0.02 }));
    // Small parts scattered between the chips: resistors and the like.
    const bits = Array.from({ length: Math.round(w * h * 500 * Math.max(0, density - 1)) }, () => ({ x: x0 + r() * (w - 0.06), y: y0 + r() * (h - 0.08), vert: r() < 0.5, hue: Math.floor(r() * 3) }));
    const lamps = Array.from({ length: Math.round(w * 22) }, (_, n) => ({ x: x0 + 0.02 + (n / Math.round(w * 22)) * (w - 0.08), y: h / 2 - 0.045, hue: n % 3 }));
    return { segs, chips, bits, lamps, runs: runs.sort((a, b) => b.length - a.length).slice(0, 3) };
  }, [w, h, seed]);
  const lit = useMemo(() => glow(0.35, 1.3, 1.7), []);
  // Unlit traces in faint amber, so the board still reads as circuitry in the gloom.
  const bare = useMemo(() => (density > 1 ? glow(0.45, 0.22, 0.07) : ELECTRO.copper), [density]);
  const core = useMemo(() => glow(1.8, 0.9, 3.2), []);
  const lampMats = useMemo(() => parts.lamps.map((l) => glow(...([[3, 1.6, 0.3], [0.4, 2.4, 3], [3, 0.4, 0.3]][l.hue] as [number, number, number]))), [parts]);
  const lampState = useRef(parts.lamps.map(() => Math.random() < 0.6));
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    const k = 0.75 + Math.sin(t * 2.7) * 0.2;
    core.color.setRGB(1.8 * k, 0.9 * k, 3.2 * k);
    const f = 0.85 + Math.sin(t * 9) * 0.06 + (Math.random() < 0.02 ? 0.3 : 0);
    lit.color.setRGB(0.35 * f, 1.3 * f, 1.7 * f);
    lampState.current.forEach((on, n) => {
      if (Math.random() < 0.04) lampState.current[n] = !on;
      const base = [[3, 1.6, 0.3], [0.4, 2.4, 3], [3, 0.4, 0.3]][parts.lamps[n].hue];
      const m = lampState.current[n] ? 1 : 0.06;
      lampMats[n].color.setRGB(base[0] * m, base[1] * m, base[2] * m);
    });
  });
  return (
    <group position={position}>
      <mesh material={M.panel}><boxGeometry args={[w, h, 0.016]} /></mesh>
      {/* Riveted brass frame */}
      {[[0, h / 2, w + 0.02, 0.02], [0, -h / 2, w + 0.02, 0.02], [w / 2, 0, 0.02, h], [-w / 2, 0, 0.02, h]].map(([x, y, fw, fh], n) => (
        <mesh key={`f${n}`} position={[x, y, 0.006]} material={COG}><boxGeometry args={[fw, fh, 0.02]} /></mesh>
      ))}
      {[-1, 1].flatMap((sx) => [-1, 1].map((sy) => <mesh key={`r${sx}${sy}`} position={[sx * w / 2, sy * h / 2, 0.018]} material={ELECTRO.brass}><sphereGeometry args={[0.008, 6, 4]} /></mesh>))}
      {/* Traces: lit ones glow, the rest are bare copper */}
      {parts.segs.map((s, n) => (
        <mesh key={n} position={[s.x, s.y, 0.0095]} material={s.lit ? lit : bare}><boxGeometry args={s.vert ? [0.003, s.len + 0.003, 0.002] : [s.len + 0.003, 0.003, 0.002]} /></mesh>
      ))}
      {parts.chips.map((c, n) => (
        <group key={`c${n}`} position={[c.x, c.y, 0.013]}>
          <mesh material={M.black}><boxGeometry args={[c.w, c.h, 0.006]} /></mesh>
          {[-1, 1].map((s) => <mesh key={s} position={[0, s * (c.h / 2 + 0.003), -0.001]} material={ELECTRO.brass}><boxGeometry args={[c.w * 0.85, 0.004, 0.003]} /></mesh>)}
        </group>
      ))}
      {parts.bits.map((b, n) => (
        <mesh key={`b${n}`} position={[b.x, b.y, 0.0125]} material={[ELECTRO.brass, M.black, M.wire][b.hue]}><boxGeometry args={b.vert ? [0.004, 0.012, 0.004] : [0.012, 0.004, 0.004]} /></mesh>
      ))}
      {/* The core chip: the brain proper */}
      <group position={[0, -0.01, 0.014]}>
        <mesh material={M.black}><boxGeometry args={[Math.min(0.11, w * 0.2), Math.min(0.09, h * 0.35), 0.008]} /></mesh>
        <mesh position={[0, 0, 0.005]} material={core}><boxGeometry args={[Math.min(0.05, w * 0.1), Math.min(0.04, h * 0.16), 0.002]} /></mesh>
        {[-1, 1].flatMap((s) => [0, 1, 2, 3, 4].map((n) => <mesh key={`${s}${n}`} position={[s * (Math.min(0.11, w * 0.2) / 2 + 0.004), (n - 2) * 0.015, -0.002]} material={ELECTRO.brass}><boxGeometry args={[0.008, 0.005, 0.003]} /></mesh>))}
      </group>
      {parts.lamps.map((l, n) => <mesh key={`l${n}`} position={[l.x, l.y, 0.014]} material={lampMats[n]}><sphereGeometry args={[0.005, 6, 4]} /></mesh>)}
      <SurfaceSparks every={2.2} size={0.006} paths={parts.runs} />
      {door && (
        <group position={[-w / 2 - 0.01, 0, 0.012]} rotation={[0, -2.5, 0]}>
          <mesh position={[w / 2 + 0.01, 0, 0]} material={M.iron}><boxGeometry args={[w + 0.02, h + 0.02, 0.012]} /></mesh>
          {[-1, 1].map((s) => <mesh key={s} position={[0, s * h * 0.35, 0]} material={COG}><cylinderGeometry args={[0.009, 0.009, 0.04, 8]} /></mesh>)}
        </group>
      )}
    </group>
  );
}

/** Clean dark iron: painted and kept, no rust. */
const CLEAN_IRON = std('#2a2624', 0.55, 0.42);

/**
 * The boiler's shell, along x, with a round window cut through it at (`hx`, `hy`) of radius `hr`
 * (measured over the curved surface), so what's behind it reads as inside the boiler.
 */
function shellWithWindow(R: number, len: number, hx: number, hy: number, hr: number) {
  const nx = 140, nt = 96, th = Math.asin((hy - KY) / R);
  const pos: number[] = [], nrm: number[] = [];
  const at = (x: number, t: number) => [x, KY + R * Math.sin(t), KZ + R * Math.cos(t)];
  for (let i = 0; i < nx; i++) for (let k = 0; k < nt; k++) {
    const x0 = -len / 2 + (i / nx) * len, x1 = -len / 2 + ((i + 1) / nx) * len;
    const t0 = -Math.PI + (k / nt) * Math.PI * 2, t1 = -Math.PI + ((k + 1) / nt) * Math.PI * 2;
    const cx = (x0 + x1) / 2 - hx, ct = R * ((t0 + t1) / 2 - th);
    if (cx * cx + ct * ct < hr * hr) continue;
    const quad = [[x0, t0], [x1, t0], [x1, t1], [x0, t0], [x1, t1], [x0, t1]];
    for (const [x, t] of quad) { pos.push(...at(x, t)); nrm.push(0, Math.sin(t), Math.cos(t)); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/**
 * The quantum core seen through a window in the boiler: a copper flange flush with the shell, glass
 * across it, and behind it a black cavity in which the core turns inside its gyroscope.
 */
function InsetCore({ x, y, r }: { x: number; y: number; r: number }) {
  const rings = useRef<THREE.Group[]>([]);
  const core = useMemo(() => glow(2.2, 1.1, 3.6), []);
  const light = useRef<THREE.PointLight>(null!);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    rings.current.forEach((g, n) => { if (g) g.rotation.set(t * (0.9 + n * 0.4), t * (0.5 - n * 0.3), 0); });
    // Kept low, so the core glows rather than blooming out over its window.
    const k = (0.85 + Math.sin(t * 3) * 0.1 + (Math.random() < 0.03 ? 0.3 : 0)) * 0.45;
    core.color.setRGB(2.2 * k, 1.1 * k, 3.6 * k);
    light.current.intensity = 1.3 * k;
  });
  const th = Math.asin((y - KY) / KR), zs = KZ + KR * Math.cos(th), depth = 0.24, s = r / 0.19;
  const cavity = useMemo(() => new THREE.MeshStandardMaterial({ color: '#050506', roughness: 0.9, side: THREE.DoubleSide }), []);
  return (
    <group position={[x, y, zs]} rotation={[-th, 0, 0]}>
      {/* The cavity: a black-walled well into the boiler, closed at the back */}
      <mesh position={[0, 0, -depth / 2]} rotation={[Math.PI / 2, 0, 0]} material={cavity}><cylinderGeometry args={[r, r, depth, 32, 1, true]} /></mesh>
      <mesh position={[0, 0, -depth]} material={cavity}><circleGeometry args={[r, 32]} /></mesh>
      <group position={[0, 0, -0.1]}>
        <mesh material={core}><sphereGeometry args={[0.045 * s, 16, 12]} /></mesh>
        {[0.11, 0.09, 0.07].map((rr, n) => (
          <group key={rr} ref={(m) => { if (m) rings.current[n] = m; }}><mesh material={COG}><torusGeometry args={[rr * s, 0.006, 6, 32]} /></mesh></group>
        ))}
        <pointLight ref={light} color="#b48aff" distance={2.2} decay={1.6} />
      </group>
      {/* Glass across the opening, unlit and faintly violet so the rim's light can't wash the core
          out, and the copper flange round it, flush with the shell */}
      <mesh position={[0, 0, 0.004]} material={VIOLET_GLASS}><circleGeometry args={[r, 32]} /></mesh>
      <FlangeTrim r={r} {...COPPER_RING} />
    </group>
  );
}

/**
 * A window's flange: weathered copper riveted round the glass, with a dim amber light ring round
 * its inner edge (`rim` bright), amber sparks racing round it now and then (every `every` seconds
 * or so), and with `inner` a faint violet ring just inside — where the core's light meets the
 * trim's. `lip` is the copper lip's thickness round the glass and `width` the flange's.
 */
type Flange = { rim: number; every: number; width: number; lip: number; inner?: boolean };

const AMBER: [number, number, number] = [3, 1.6, 0.4];
const VIOLET_GLASS = new THREE.MeshBasicMaterial({ color: '#4a2a7a', transparent: true, opacity: 0.18, depthWrite: false });

function FlangeTrim({ r, rim, every, width, inner, lip }: Flange & { r: number }) {
  const lit = useMemo(() => glow(...AMBER), []);
  const innerLit = useMemo(() => glow(0.9, 0.45, 1.5), []);
  const spark = useMemo(() => new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 3, 0.9), transparent: true, depthWrite: false }), []);
  const light = useRef<THREE.PointLight>(null!);
  useFrame(({ clock }) => {
    // A faint shimmer.
    const k = rim * (0.92 + 0.08 * Math.sin(clock.elapsedTime * 2));
    lit.color.setRGB(AMBER[0] * k, AMBER[1] * k, AMBER[2] * k);
    light.current.intensity = 0.5 * k;
  });
  const outer = r + 0.006 + lip + width;
  const path = useMemo<V3[][]>(() => [arcPath([0, 0, 0.03], r + 0.026, 0, Math.PI * 2, 'xy', 40)], [r]);
  const n = Math.round(14 * (outer / (r + 0.05)));
  return (
    <>
      <mesh position={[0, 0, 0.008]} material={CAP}><torusGeometry args={[r + 0.006, lip, 8, 40]} /></mesh>
      <mesh position={[0, 0, 0.004]} material={CAP}><ringGeometry args={[r + 0.006 + lip, outer, 48]} /></mesh>
      <mesh position={[0, 0, 0.012]} material={lit}><torusGeometry args={[r + 0.026, 0.004, 4, 48]} /></mesh>
      {inner && <mesh position={[0, 0, 0.012]} material={innerLit}><torusGeometry args={[r - 0.006, 0.003, 4, 48]} /></mesh>}
      {Array.from({ length: n }, (_, k) => {
        const a = (k / n) * Math.PI * 2, rr = r + 0.02 + width * 0.6;
        return <mesh key={k} position={[Math.cos(a) * rr, Math.sin(a) * rr, 0.008]} material={COG}><sphereGeometry args={[0.007, 6, 4]} /></mesh>;
      })}
      <SurfaceSparks every={every} size={0.008} paths={path} material={spark} />
      <pointLight ref={light} position={[0, 0, 0.12]} color="#ffc070" distance={0.9} decay={1.6} />
    </>
  );
}

/**
 * A cast-iron pedestal from the deck up behind a cog (or under an engine's cylinder), with the
 * axle running from it through the cog to a brass bearing cap, so nothing hangs in the air.
 */
function CogMount({ x, y, z, axle = true, width = 0.06 }: { x: number; y: number; z: number; axle?: boolean; width?: number }) {
  const h = y - 0.1;
  return (
    <>
      <mesh position={[x, 0.1 + h / 2, z - 0.06]} material={M.ironDark}><boxGeometry args={[width, h + 0.03, 0.03]} /></mesh>
      <mesh position={[x, 0.11, z - 0.06]} material={M.ironDark}><boxGeometry args={[width + 0.05, 0.02, 0.07]} /></mesh>
      {[-1, 1].map((s) => <mesh key={s} position={[x + s * (width / 2 + 0.014), 0.122, z - 0.04]} material={COG}><sphereGeometry args={[0.007, 6, 4]} /></mesh>)}
      {axle && (
        <>
          <mesh position={[x, y, z - 0.02]} rotation={[Math.PI / 2, 0, 0]} material={CLEAN_IRON}><cylinderGeometry args={[0.012, 0.012, 0.1, 10]} /></mesh>
          <mesh position={[x, y, z + 0.03]} rotation={[Math.PI / 2, 0, 0]} material={ELECTRO.brass}><cylinderGeometry args={[0.02, 0.02, 0.014, 12]} /></mesh>
        </>
      )}
    </>
  );
}

/** Hex digits as nixie glyphs: fine red-orange wire strokes with a glow, drawn once and shared. */
let nixieDigits: THREE.CanvasTexture[] | null = null;
function digits() {
  nixieDigits ??= '0123456789ABCDEF'.split('').map((ch) => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 96;
    const g = c.getContext('2d')!;
    g.font = '200 82px Georgia, serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    // A fine wire stroke, as a nixie's cathodes are, with a soft glow round it.
    g.shadowColor = 'rgba(255,80,30,0.9)'; g.shadowBlur = 8;
    g.strokeStyle = '#fff2e0'; g.lineWidth = 1.4;
    g.strokeText(ch, 32, 52);
    g.strokeText(ch, 32, 52);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
  return nixieDigits;
}

/** The digits' glow (HDR, so it blooms). */
const NIXIE: [number, number, number] = [2.8, 0.75, 0.2];

/**
 * A row of `count` nixie tubes in black bakelite sockets on a riveted rail, each slowly turning
 * over random hex digits (a flicker as the cathode changes), behind the faint mesh of its anode.
 */
function NixieRow({ position, spacing = 0.056, scale = 1, count = 4 }: { position: V3; spacing?: number; scale?: number; count?: number }) {
  const [cr, cg, cb] = NIXIE;
  const mats = useMemo(() => Array.from({ length: count }, () => new THREE.MeshBasicMaterial({ map: digits()[0], color: new THREE.Color(cr, cg, cb), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })), [cr, cg, cb, count]);
  const state = useRef(Array.from({ length: count }, (_, n) => ({ next: 0.5 + n * 0.7, flick: 0 })));
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    state.current.forEach((s, n) => {
      if (t > s.next) {
        mats[n].map = digits()[Math.floor(Math.random() * 16)];
        mats[n].needsUpdate = true;
        s.next = t + 1.6 + Math.random() * 2.4;
        s.flick = 0.18;
      }
      s.flick = Math.max(0, s.flick - dt);
      const k = s.flick > 0 ? (Math.random() < 0.5 ? 0.25 : 0.8) : 0.95 + Math.sin(t * 40 + n) * 0.03;
      mats[n].color.setRGB(cr * k, cg * k, cb * k);
    });
  });
  const mesh = useMemo(() => new THREE.MeshBasicMaterial({ color: '#3a2a1a', transparent: true, opacity: 0.5, wireframe: true }), []);
  return (
    <group position={position} scale={scale}>
      {/* The rail they stand in, riveted down to the deck */}
      <mesh position={[0, 0.012, 0]} material={M.ironDark}><boxGeometry args={[spacing * count + 0.04, 0.024, 0.06]} /></mesh>
      {[-1, 1].map((s) => <mesh key={s} position={[s * (spacing * count / 2 + 0.008), 0.026, 0.018]} material={COG}><sphereGeometry args={[0.006, 6, 4]} /></mesh>)}
      {mats.map((m, n) => {
        const x = (n - (count - 1) / 2) * spacing;
        return (
          <group key={n} position={[x, 0.024, 0]}>
            <mesh position={[0, 0.012, 0]} material={M.black}><cylinderGeometry args={[0.02, 0.023, 0.024, 12]} /></mesh>
            <mesh position={[0, 0.07, 0]} material={ELECTRO.glass}><capsuleGeometry args={[0.019, 0.07, 4, 12]} /></mesh>
            <mesh position={[0, 0.07, -0.004]} material={mesh}><planeGeometry args={[0.03, 0.06, 4, 6]} /></mesh>
            <mesh position={[0, 0.07, 0.002]} material={m}><planeGeometry args={[0.03, 0.045]} /></mesh>
          </group>
        );
      })}
    </group>
  );
}

// ------------------------------------------------------------------ the base

/**
 * The stack, out of the boiler's side: a pipe leaves the right end cap through a riveted flange,
 * turns up at an elbow beyond the pad deck's end, and rises past it (a touch crooked), puffing
 * steam from its crown.
 */
function SideStack({ game, at }: { game: Game; at: { x: number; y: number } }) {
  const y = 0.58, x0 = 0.76, x1 = 1.09, top = 1.48;
  useSteam(game, at, [[x1 + 0.02, top + 0.06]], 1.6);
  return (
    <group position={[0, 0, KZ]}>
      <mesh position={[x0 + 0.02, y, 0]} rotation={[0, 0, Math.PI / 2]} material={CLEAN_IRON}><cylinderGeometry args={[0.085, 0.09, 0.03, 16]} /></mesh>
      {Array.from({ length: 6 }, (_, n) => <mesh key={n} position={[x0 + 0.036, y + Math.sin(n * 1.047) * 0.07, Math.cos(n * 1.047) * 0.07]} material={COG}><sphereGeometry args={[0.008, 6, 4]} /></mesh>)}
      <mesh position={[(x0 + x1) / 2, y, 0]} rotation={[0, 0, Math.PI / 2]} material={CLEAN_IRON}><cylinderGeometry args={[0.055, 0.055, x1 - x0, 14]} /></mesh>
      <mesh position={[x1, y, 0]} material={CLEAN_IRON}><sphereGeometry args={[0.062, 14, 10]} /></mesh>
      <group position={[x1, y, 0]} rotation={[0, 0, 0.03]}>
        <mesh position={[0, (top - y) / 2, 0]} material={CLEAN_IRON}><cylinderGeometry args={[0.055, 0.062, top - y, 14]} /></mesh>
        {[0.25, 0.6].map((f) => <mesh key={f} position={[0, (top - y) * f, 0]} rotation={[Math.PI / 2, 0, 0]} material={ELECTRO.brass}><torusGeometry args={[0.06, 0.008, 6, 20]} /></mesh>)}
        <mesh position={[0, top - y + 0.02, 0]} material={ELECTRO.brass}><cylinderGeometry args={[0.09, 0.06, 0.06, 14]} /></mesh>
      </group>
    </group>
  );
}

/**
 * The base: a riveted boiler hung off the back wall, its quantum core seen through a window cut in
 * the shell (see InsetCore) behind the copper flange; a long-stroke steam engine whose cog drives a
 * small one, both on pedestals; the AI brain behind a service door hanging open, with nixies under
 * it; glowing field coils and circuitry; a gauge on a stalk; a patched leak; the stack leaving the
 * boiler's right end, clear of the raised landing deck, and puffing.
 */
export function BaseModel({ game, at }: { game: Game; at: { x: number; y: number } }) {
  const core: [number, number] = [-0.2, 0.53];
  const engine: V3 = [0.15, 0.32, KZ + KR + 0.12];
  // The small cog sits below and left of the engine's, a cog-pair apart (0.13 + 0.06).
  const smallAt: V3 = [engine[0] - 0.19 * Math.cos(Math.PI / 6), engine[1] - 0.19 * Math.sin(Math.PI / 6), engine[2]];
  const shell = useMemo(() => shellWithWindow(KR, 1.4, core[0], core[1], 0.15), []);
  const small = useRef<THREE.Group>(null!);
  const smallGeo = useMemo(() => gearGeometry(0.06, 8, 0.03), []);
  const traces = useMemo<V3[][]>(() => [[[0.88, PAD_Y - 0.05, -0.38], [0.86, 0.72, -0.36], [0.4, 0.52, KZ + KR + 0.1]]], []);
  const turn = (a: number) => { small.current.rotation.z = -a * (14 / 8) + 0.2; };
  return (
    <>
      <WallMount z={0} width={2.32} height={1.6} deckWidth={1.95} deckTop={0.1} front={-0.3} gussets={3} />
      <mesh geometry={shell} material={M.iron} />
      {[-1, 1].map((s) => <mesh key={s} position={[s * 0.7, KY, KZ]} scale={[0.3, 1, 1]} material={CAP}><sphereGeometry args={[KR, 24, 14]} /></mesh>)}
      {[-0.66, -0.45, 0.62].map((x) => <RivetedBand key={x} x={x} />)}
      {[0.25, 0.48].map((x) => <GlowRing key={`c${x}`} radius={KR + 0.008} tube={0.013} position={[x, KY, KZ]} rotation={[0, Math.PI / 2, 0]} />)}
      <SurfaceSparks every={3} size={0.009} paths={[0.25, 0.48].map((x) => arcPath([x, KY, KZ], KR + 0.03, -Math.PI / 2, Math.PI / 2, 'yz', 16))} />
      {[-0.45, 0.45].map((x) => <mesh key={`s${x}`} position={[x, 0.13, KZ]} material={M.ironDark}><boxGeometry args={[0.1, 0.06, 0.42]} /></mesh>)}
      <Patch at={onKettle(0.02, 0.74, 0.005)} tilt={-0.12} />
      <SideStack game={game} at={at} />
      <InsetCore x={core[0]} y={core[1]} r={0.15} />
      {/* Pedestals for the cogs and the engine's cylinder */}
      <CogMount x={engine[0]} y={engine[1]} z={engine[2]} />
      <CogMount x={smallAt[0]} y={smallAt[1]} z={smallAt[2]} width={0.045} />
      <CogMount x={engine[0] + 0.465} y={engine[1] - 0.05} z={engine[2] + 0.04} axle={false} width={0.08} />
      <group ref={small} position={smallAt}><mesh geometry={smallGeo} material={COG} /></group>
      <SteamEngine game={game} position={engine} side={-1} cog={0.13} rod={0.24} cylLen={0.24} pistonRod={0.22} onTurn={turn} />
      <Circuit paths={traces} every={1.8} />
      <GaugeOnStalk x={0.38} y={0.74} cracked />
      <PadDeck />
      {/* The brain, behind its service door hanging open */}
      <mesh position={[-0.56, 0.6, KZ + KR - 0.01]} material={M.ironDark}><boxGeometry args={[0.28, 0.32, 0.06]} /></mesh>
      <BrainPanel position={[-0.56, 0.6, KZ + KR + 0.025]} w={0.24} h={0.28} seed={5} door density={3} />
      <NixieRow position={[-0.56, 0.1, -0.36]} scale={1.25} />
    </>
  );
}

/** The base's core window: the copper flange lit dim amber, with the faint violet inner ring. */
const COPPER_RING: Flange = { rim: 0.4, every: 2, width: 0.034, lip: 0.015, inner: true };

/**
 * A small quantum port for buildings and machines in the base's style: a black well with a violet
 * core turning in two matte-brass rings, behind faintly violet glass, in a weathered copper flange
 * lit amber with the faint violet inner ring (as the base's core window), `r` across, facing +z.
 */
export function QuantumPort({ position, r, rotation }: { position: V3; r: number; rotation?: V3 }) {
  const core = useMemo(() => glow(1, 0.5, 1.6), []);
  const rings = useRef<THREE.Group[]>([]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    rings.current.forEach((g, n) => { if (g) g.rotation.set(t * (1.1 + n * 0.5), t * (0.6 - n * 0.4), 0); });
    const k = 0.85 + Math.sin(t * 3) * 0.1;
    core.color.setRGB(1 * k, 0.5 * k, 1.6 * k);
  });
  const g = r / 0.15, depth = r * 0.8;
  return (
    <group position={position} rotation={rotation}>
      <mesh position={[0, 0, -depth / 2]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[r, r, depth, 24, 1, true]} /><meshStandardMaterial color="#050506" roughness={0.9} side={THREE.DoubleSide} /></mesh>
      <mesh position={[0, 0, -depth]} material={M.black}><circleGeometry args={[r, 24]} /></mesh>
      <group position={[0, 0, -depth / 2]}>
        <mesh material={core}><sphereGeometry args={[r * 0.25, 12, 8]} /></mesh>
        {[0.6, 0.45].map((f, n) => <group key={f} ref={(m) => { if (m) rings.current[n] = m; }}><mesh material={COG}><torusGeometry args={[r * f, Math.max(0.0025, r * 0.035), 5, 24]} /></mesh></group>)}
      </group>
      <mesh position={[0, 0, 0.003]} material={VIOLET_GLASS}><circleGeometry args={[r, 24]} /></mesh>
      <FlangeTrim r={r} {...COPPER_RING} every={COPPER_RING.every * 2} lip={COPPER_RING.lip * g} width={COPPER_RING.width * g} />
    </group>
  );
}

/** The base's kit of parts and finishes, for the other buildings, the drones and the vehicle. */
export { CLEAN_IRON, COG, Circuit, LiveGauge, NixieRow, BrainPanel };
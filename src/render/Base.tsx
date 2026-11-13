import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { DEPTH } from '../config';
import { HUB, dockSlot } from '../game/base';
import { DEPLOY_TIME, type Game } from '../game/Game';
import { rustMaterial } from './materials';
import { BaseModel } from './baseModel';

const Z_HUB = -DEPTH * 0.62;
const Z_ACTORS = -DEPTH * 0.45;
/** Just in front of the cavern's back wall, where everything is bolted on. */
const Z_WALL = -DEPTH + 0.03;

/** A horizontal arm from the back wall out to depth z, at (x, y). */
function WallArm({ x, y, z, r = 0.014 }: { x: number; y: number; z: number; r?: number }) {
  const len = z - Z_WALL;
  return (
    <>
      <mesh position={[x, y, Z_WALL + len / 2]} rotation={[Math.PI / 2, 0, 0]} material={M.darkIron}><cylinderGeometry args={[r, r, len, 8]} /></mesh>
      <mesh position={[x, y, Z_WALL]} rotation={[Math.PI / 2, 0, 0]} material={M.iron}><cylinderGeometry args={[r * 3, r * 3, 0.02, 10]} /></mesh>
    </>
  );
}

const mat = (color: string, metalness = 0.6, roughness = 0.45) => new THREE.MeshStandardMaterial({ color, metalness, roughness });
// Worn, dusty metal: modest metalness and fairly rough, so it doesn't read as polished chrome.
const M = {
  iron: mat('#3b3530', 0.4, 0.75),
  darkIron: mat('#25221f', 0.4, 0.72),
  brass: mat('#b8934a', 0.55, 0.52),
  copper: mat('#ad6038', 0.5, 0.55),
  verdigris: mat('#5f8f7c', 0.4, 0.6),
  wood: mat('#5a3b22', 0, 0.85),
  ore: mat('#a5602f', 0.25, 0.8),
  steelScrap: mat('#8a8f95', 0.45, 0.6),
  // Neglect: rust on the boiler's iron, verdigris on its copper ends.
  rustIron: rustMaterial('#3b3530', 0.75),
  rustDark: rustMaterial('#25221f', 0.5),
  verdigris2: rustMaterial('#ad6038', 0.5, ['#2f5a48', '#6aa486']),
  enamel: mat('#e8dcc0', 0.1, 0.4),
  black: mat('#141210', 0.3, 0.7),
};

/** Lathe-turned profile (radius, height pairs), for domes, stacks and finials. */
function lathe(profile: [number, number][], segments = 24) {
  return new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), segments);
}

/** 0 → 1 with a little overshoot, for parts snapping into place. */
const easeOutBack = (x: number) => 1 + 2.7 * (x - 1) ** 3 + 1.7 * (x - 1) ** 2;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Show a group at a scale from 0 (hidden) to 1. */
function grow(g: THREE.Object3D, f: number) {
  g.visible = f > 0.001;
  g.scale.setScalar(Math.max(0.001, f));
}

/** Gas lamp on a wall bracket; flickers and lights the cavern warmly once `power()` is up. */
function Lantern({ x, z, h, power }: { x: number; z: number; h: number; power: () => number }) {
  const light = useRef<THREE.PointLight>(null!);
  const flame = useRef<THREE.MeshBasicMaterial>(null!);
  const phase = useMemo(() => Math.random() * 10, []);
  const cap = useMemo(() => lathe([[0.001, 0.09], [0.05, 0.05], [0.075, 0.0]], 12), []);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + phase;
    const f = 0.85 + Math.sin(t * 13) * 0.05 + Math.sin(t * 29) * 0.04 + (Math.random() - 0.5) * 0.05;
    const p = power();
    light.current.intensity = 3.2 * f * p;
    flame.current.color.setRGB(3.2 * f * p, 1.6 * f * p, 0.45 * f * p);
  });
  return (
    <group position={[x, 0, z]}>
      <group position={[-x, 0, -z]}><WallArm x={x} y={h + 0.27} z={z} /></group>
      <mesh position={[0, h + 0.24, 0]} material={M.darkIron}><cylinderGeometry args={[0.006, 0.006, 0.06, 4]} /></mesh>
      <mesh position={[0, h + 0.02, 0]} material={M.brass}><cylinderGeometry args={[0.05, 0.04, 0.03, 12]} /></mesh>
      <mesh position={[0, h + 0.1, 0]}><cylinderGeometry args={[0.045, 0.045, 0.13, 12]} /><meshBasicMaterial ref={flame} /></mesh>
      {[0, 1, 2, 3].map((n) => (
        <mesh key={n} position={[Math.cos(n * Math.PI / 2) * 0.05, h + 0.1, Math.sin(n * Math.PI / 2) * 0.05]} material={M.brass}>
          <cylinderGeometry args={[0.006, 0.006, 0.14, 4]} />
        </mesh>
      ))}
      <mesh position={[0, h + 0.17, 0]} geometry={cap} material={M.brass} />
      <pointLight ref={light} position={[0, h + 0.1, 0.25]} color="#ffb46b" distance={7} decay={1.3} />
    </group>
  );
}

const BIN = { w: 0.28, d: 0.3, h: 0.24, y: 0.14, z: Z_WALL + 0.2 };
const STOCK_MAX = { ore: 40, scrap: 40, plates: 30 };

/** Heap positions inside a bin, lowest first, so the pile grows upward as items are added. */
function heap(count: number, size: number, seed: number) {
  let a = seed;
  const rand = () => ((a = (a * 16807) % 2147483647) / 2147483647);
  const cols = 4, rows = 4, dx = (BIN.w - size) / (cols - 1), dz = (BIN.d - size) / (rows - 1);
  return Array.from({ length: count }, (_, n) => {
    const layer = Math.floor(n / (cols * rows)), cell = n % (cols * rows);
    // Each layer is a little smaller and offset, so the top rounds off into a heap.
    const shrink = 1 - layer * 0.12;
    return new THREE.Vector3(
      (-BIN.w / 2 + size / 2 + (cell % cols) * dx) * shrink + (rand() - 0.5) * size * 0.4,
      size / 2 + layer * size * 0.8 + rand() * size * 0.2,
      (-BIN.d / 2 + size / 2 + Math.floor(cell / cols) * dz) * shrink + (rand() - 0.5) * size * 0.4,
    );
  });
}

/**
 * Three wall-hung bins beside the boiler showing the stockpile: one lump per unit of ore, one
 * shard per unit of scrap, and a stack of copper plates.
 */
function Stockpile({ game }: { game: Game }) {
  const bins = useMemo(() => {
    const item = (geo: THREE.BufferGeometry, material: THREE.Material, n: number, place: (k: number) => THREE.Matrix4) => {
      const m = new THREE.InstancedMesh(geo, material, n);
      for (let k = 0; k < n; k++) m.setMatrixAt(k, place(k));
      m.count = 0;
      return m;
    };
    const tilt = new THREE.Euler();
    const ore = heap(STOCK_MAX.ore, 0.07, 11), scrap = heap(STOCK_MAX.scrap, 0.07, 23);
    return {
      ore: item(new THREE.DodecahedronGeometry(0.042), M.ore, STOCK_MAX.ore, (k) => new THREE.Matrix4().compose(ore[k], new THREE.Quaternion().setFromEuler(tilt.set(k, k * 2, k * 3)), new THREE.Vector3(1, 0.85, 1))),
      scrap: item(new THREE.BoxGeometry(0.08, 0.018, 0.035), M.steelScrap, STOCK_MAX.scrap, (k) => new THREE.Matrix4().compose(scrap[k], new THREE.Quaternion().setFromEuler(tilt.set(k * 1.7, k * 0.9, k * 2.3)), new THREE.Vector3(1, 1, 1))),
      plates: item(new THREE.BoxGeometry(0.22, 0.011, 0.24), M.copper, STOCK_MAX.plates, (k) => new THREE.Matrix4().compose(
        new THREE.Vector3((k % 3 - 1) * 0.004, 0.008 + k * 0.0125, ((k * 7) % 3 - 1) * 0.004), new THREE.Quaternion().setFromEuler(tilt.set(0, (k % 4 - 1.5) * 0.03, 0)), new THREE.Vector3(1, 1, 1))),
    };
  }, []);
  useFrame(() => {
    const r = game.resources;
    // Ore of every kind in one bin; plates and bars stacked together in another.
    bins.ore.count = Math.min(STOCK_MAX.ore, Math.floor(r.ore + r.ironOre + r.tiOre));
    bins.scrap.count = Math.min(STOCK_MAX.scrap, Math.floor(r.scrap));
    bins.plates.count = Math.min(STOCK_MAX.plates, Math.floor(r.plates + r.ironBars + r.tiBars));
  });
  return (
    <>
      {([['ore', -2.0], ['scrap', -1.68], ['plates', -1.36]] as const).map(([kind, x]) => (
        <group key={kind} position={[x, BIN.y, BIN.z]}>
          {/* An open-topped iron bin hung on two wall arms */}
          <mesh position={[0, -0.01, 0]} material={M.darkIron}><boxGeometry args={[BIN.w + 0.02, 0.02, BIN.d + 0.02]} /></mesh>
          {[-1, 1].map((sx) => <mesh key={`x${sx}`} position={[sx * (BIN.w / 2 + 0.005), BIN.h / 2, -0.06]} material={M.iron}><boxGeometry args={[0.01, BIN.h, BIN.d - 0.1]} /></mesh>)}
          {/* Full back, low front lip so the pile shows */}
          <mesh position={[0, BIN.h / 2, -(BIN.d / 2 + 0.005)]} material={M.iron}><boxGeometry args={[BIN.w + 0.02, BIN.h, 0.01]} /></mesh>
          <mesh position={[0, 0.03, BIN.d / 2 + 0.005]} material={M.iron}><boxGeometry args={[BIN.w + 0.02, 0.06, 0.01]} /></mesh>
          <mesh position={[0, 0.03, BIN.d / 2 + 0.012]} material={M.brass}><boxGeometry args={[0.1, 0.03, 0.006]} /></mesh>
          <group position={[-x, -BIN.y, -BIN.z]}>
            {[-0.09, 0.09].map((dx) => <WallArm key={dx} x={x + dx} y={BIN.y - 0.03} z={BIN.z - BIN.d / 2} />)}
          </group>
          <primitive object={bins[kind]} />
        </group>
      ))}
    </>
  );
}

/**
 * The starting base: a quantum-cored steam boiler hung off the back wall, under a raised landing
 * deck (see BaseModel). In the opening it rides a spinning drill bit down its shaft, then
 * deploys: the conveyor, shelf, stockpile bins, lamps and bulbs unfold round it. Pad rings show
 * which drones are docked (green), out (amber) or not yet in service (red).
 */
export function Base({ game }: { game: Game }) {
  const d = game.layout.depot;
  const geo = useMemo(() => {
    const festoon = Array.from({ length: 9 }, (_, n) => {
      const f = n / 8;
      return new THREE.Vector3(-1.42 + f * 1.97, 1.95 - f * 0.25 - Math.sin(f * Math.PI) * 0.25, -0.98 + f * 0.03);
    });
    const bit = new THREE.ConeGeometry(0.95, 0.82, 20);
    bit.rotateX(Math.PI);
    bit.translate(0, -0.41, 0);
    return {
      hopper: new RoundedBoxGeometry(0.3, 0.26, 0.28, 3, 0.04),
      festoon,
      wire: new THREE.TubeGeometry(new THREE.CatmullRomCurve3(festoon), 32, 0.004, 4, false),
      padRing: new THREE.TorusGeometry(0.15, 0.012, 6, 24),
      // A cable that came loose and hangs from the festoon hook.
      looseCable: new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
        new THREE.Vector3(-1.42, 1.93, -0.98), new THREE.Vector3(-1.5, 1.6, -0.95), new THREE.Vector3(-1.44, 1.32, -0.93), new THREE.Vector3(-1.52, 1.12, -0.92),
      ]), 24, 0.006, 4, false),
      bit,
    };
  }, []);
  const slots = useMemo(() => Array.from({ length: 4 }, (_, n) => {
    const s = dockSlot(d, n);
    return { x: s.x - d.x, y: s.y - d.y };
  }), [d]);
  const ref = {
    bulbs: useRef<THREE.Group>(null!), pads: useRef<THREE.Group>(null!), rollers: useRef<THREE.Group>(null!), lumps: useRef<THREE.Group>(null!),
    root: useRef<THREE.Group>(null!), drill: useRef<THREE.Group>(null!),
    conveyor: useRef<THREE.Group>(null!), shelf: useRef<THREE.Group>(null!), festoon: useRef<THREE.Group>(null!),
    lamps: useRef<THREE.Group>(null!), stock: useRef<THREE.Group>(null!),
  };
  /** Seconds into deployment: -1 while drilling, large once deployed. */
  const deployed = () => (game.intro.phase === 'done' ? 99 : game.intro.phase === 'deploy' ? game.intro.t : -1);
  // Stage times below are laid out for a 3s deployment and stretched to DEPLOY_TIME.
  const pace = DEPLOY_TIME / 3;
  const stage = (a: number, b: number) => clamp01((deployed() - a * pace) / ((b - a) * pace));
  /** Where the base stands now (it rides down its shaft in the opening), for the model's steam. */
  const at = useMemo(() => ({ x: d.x, y: d.y }), [d]);

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    // Opening: ride down the shaft on the drill, retract it, then unfold onto the wall.
    const intro = game.intro;
    ref.root.current.position.y = d.y + intro.offset;
    at.y = d.y + intro.offset;
    const drill = ref.drill.current;
    drill.rotation.y += dt * (intro.phase === 'drill' ? 18 : 4);
    grow(drill, intro.phase === 'drill' ? 1 : 1 - stage(0, 0.6));
    grow(ref.conveyor.current, easeOutBack(stage(0.9, 1.7)));
    grow(ref.shelf.current, easeOutBack(stage(1.2, 2.0)));
    grow(ref.festoon.current, easeOutBack(stage(1.6, 2.6)));
    grow(ref.lamps.current, easeOutBack(stage(1.4, 2.2)));
    grow(ref.stock.current, easeOutBack(stage(1.0, 1.8)));
    ref.bulbs.current.children.forEach((c, n) => {
      const on = Math.floor(t * 4) % 9 === n ? 1 : 0.35;
      ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setRGB(3 * on, 1.8 * on, 0.6 * on);
    });
    for (const r of ref.rollers.current.children) r.rotation.y = -t * 5;
    ref.lumps.current.children.forEach((l, n) => {
      const f = (t * 0.22 + n / 4) % 1;
      l.position.set(2.05 - f * 0.75, 0.46 + f * 0.2, 0);
      l.rotation.set(n, f * 4, n * 2);
      l.visible = f < 0.95;
    });
    // Pad and cradle rings: green while a drone is docked there, slow amber blink while it's out.
    const padNo = (pad: string) => (pad.startsWith('main:') ? Number(pad.slice(5)) : -1);
    const docked = new Set(game.bots.filter((b) => !b.dead && b.state === 'docked').map((b) => padNo(b.pad)));
    const out = new Set(game.bots.filter((b) => !b.dead && b.state !== 'docked').map((b) => padNo(b.pad)));
    const usable = game.padsAt(game.bases[0]);
    ref.pads.current.children.forEach((c, n) => {
      const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
      // Pads not yet in service (research more) glow a dim red.
      if (n >= usable) m.color.setRGB(0.35, 0.04, 0.03);
      else if (docked.has(n)) m.color.setRGB(0.3, 2.2, 0.6);
      else if (out.has(n)) m.color.setRGB(Math.sin(t * 3 + n) > 0 ? 2.4 : 0.3, Math.sin(t * 3 + n) > 0 ? 1.2 : 0.15, 0);
      else m.color.setRGB(0.12, 0.07, 0.05);
    });
  });

  return (
    <group ref={ref.root} position={[d.x, d.y, 0]}>
      {/* Drill bit the base rides down on: a fluted cone with teeth round the rim */}
      <group ref={ref.drill} position={[0, 0.08, Z_HUB]}>
        <mesh geometry={geo.bit} material={M.darkIron} />
        {[-0.15, -0.35, -0.55].map((y, n) => <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.brass}><torusGeometry args={[0.82 - n * 0.27, 0.025, 6, 32]} /></mesh>)}
        {Array.from({ length: 12 }, (_, n) => (
          <mesh key={n} position={[Math.cos(n * Math.PI / 6) * 0.92, -0.06, Math.sin(n * Math.PI / 6) * 0.92]} rotation={[0, -n * Math.PI / 6, 0.5]} material={M.iron}>
            <boxGeometry args={[0.08, 0.14, 0.06]} />
          </mesh>
        ))}
      </group>
      {/* The boiler house itself: the quantum-cored boiler hung off the back wall, its steam
          engine, AI brain, nixies and the raised landing deck (see BaseModel) */}
      <BaseModel game={game} at={at} />
      {/* Ore conveyor from a hopper into the boiler house */}
      <group ref={ref.conveyor}>
      <group position={[0, 0, Z_ACTORS + 0.12]}>
        <mesh position={[1.67, 0.52, 0]} rotation={[0, 0, -0.26]}><boxGeometry args={[0.8, 0.03, 0.16]} /><meshStandardMaterial color="#2a2522" roughness={0.95} /></mesh>
        <group ref={ref.rollers}>
          {[1.3, 2.05].map((x) => (
            <mesh key={x} position={[x, x < 1.5 ? 0.62 : 0.42, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.brass}><cylinderGeometry args={[0.035, 0.035, 0.2, 10]} /></mesh>
          ))}
        </group>
        <group position={[0, 0, -(Z_ACTORS + 0.12)]}>
          {[[1.35, 0.58], [1.95, 0.42], [2.22, 0.08]].map(([x, y]) => <WallArm key={x} x={x} y={y} z={Z_ACTORS + 0.12} />)}
        </group>
        <group ref={ref.lumps}>
          {Array.from({ length: 4 }, (_, n) => <mesh key={n} material={M.ore}><dodecahedronGeometry args={[0.035]} /></mesh>)}
        </group>
        <mesh geometry={geo.hopper} material={M.copper} position={[2.22, 0.2, 0]} />
        <mesh position={[2.22, 0.34, 0]} material={M.ore}><dodecahedronGeometry args={[0.1]} /></mesh>
      </group>
      </group>
      {/* Banded barrels on a wall shelf */}
      <group ref={ref.shelf}>
      <mesh position={[1.65, 0.6, Z_WALL + 0.14]} material={M.wood}><boxGeometry args={[0.5, 0.03, 0.26]} /></mesh>
      {[1.45, 1.85].map((x) => <WallArm key={x} x={x} y={0.57} z={Z_WALL + 0.24} />)}
      {[[1.55, Z_WALL + 0.13], [1.74, Z_WALL + 0.15]].map(([x, z]) => (
        <group key={x} position={[x, 0.755, z]}>
          <mesh material={M.wood}><cylinderGeometry args={[0.085, 0.085, 0.28, 16]} /></mesh>
          {[-0.09, 0.09].map((y) => <mesh key={y} position={[0, y, 0]} rotation={[Math.PI / 2, 0, 0]} material={M.darkIron}><torusGeometry args={[0.087, 0.008, 6, 20]} /></mesh>)}
        </group>
      ))}
      </group>
      {/* Pad status rings, one per landing pad */}
      <group ref={ref.pads}>
        {slots.map((s, n) => (
          <mesh key={n} geometry={geo.padRing} position={[s.x, HUB.h + 0.012, Z_ACTORS]} rotation={[Math.PI / 2, 0, 0]}>
            <meshBasicMaterial color="black" />
          </mesh>
        ))}
      </group>
      {/* Festoon of bulbs strung from a wall hook to the stack */}
      <group ref={ref.festoon}>
        <WallArm x={-1.42} y={1.95} z={-0.98} />
        <mesh geometry={geo.wire} material={M.black} />
        <mesh geometry={geo.looseCable} material={M.black} />
        <group ref={ref.bulbs}>
          {geo.festoon.map((p, n) => (
            <mesh key={n} position={[p.x, p.y - 0.03, p.z]}><sphereGeometry args={[0.022, 8, 6]} /><meshBasicMaterial /></mesh>
          ))}
        </group>
      </group>
      <group ref={ref.stock}><Stockpile game={game} /></group>
      <group ref={ref.lamps}>
        <Lantern x={-2.35} z={Z_ACTORS + 0.1} h={0.9} power={() => stage(1.4, 2.2)} />
        <Lantern x={2.62} z={Z_ACTORS + 0.1} h={1.05} power={() => stage(1.4, 2.2)} />
      </group>
      <pointLight position={[0, 1.6, 0.8]} intensity={2} distance={6} color="#ffcf99" />
    </group>
  );
}

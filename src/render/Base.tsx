import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { DEPTH } from '../config';
import { HUB, dockSlot } from '../game/base';
import { DEPLOY_TIME, type Game } from '../game/Game';
import { ParticleKind } from '../gpu/GpuSim';
import { rustMaterial } from './materials';
import { GlowRing, TeslaCoil, VacuumTube } from './electro';

const Z_HUB = -DEPTH * 0.62;
const R = 0.4;
/** The boiler's front surface, facing the camera. */
const FRONT = Z_HUB + R;
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
  if (radius > 0.1) {
    for (let n = 0; n < 5; n++) {
      const a = (n / 5) * Math.PI * 2;
      const h = new THREE.Path();
      h.absarc(Math.cos(a) * radius * 0.48, Math.sin(a) * radius * 0.48, radius * 0.15, 0, Math.PI * 2, true);
      shape.holes.push(h);
    }
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 1, curveSegments: 6 });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

/** A smooth pipe through the given points. */
function pipeGeometry(points: [number, number, number][], radius = 0.025) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'catmullrom', 0.2);
  return new THREE.TubeGeometry(curve, points.length * 12, radius, 10, false);
}

/** Lathe-turned profile (radius, height pairs), for domes, stacks and finials. */
function lathe(profile: [number, number][], segments = 24) {
  return new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), segments);
}

/** A ring of rivet heads around the boiler's front half at x. */
function Rivets({ x }: { x: number }) {
  return (
    <>
      {Array.from({ length: 9 }, (_, n) => {
        const a = -Math.PI / 2 + (n / 8) * Math.PI;
        return (
          <mesh key={n} position={[x, 0.48 + Math.sin(a) * (R + 0.02), Z_HUB + Math.cos(a) * (R + 0.02)]} material={M.brass}>
            <sphereGeometry args={[0.012, 6, 4]} />
          </mesh>
        );
      })}
    </>
  );
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
      {([['ore', -1.76], ['scrap', -1.44], ['plates', -1.12]] as const).map(([kind, x]) => (
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
 * The starting base, a steam-age boiler house. Its riveted boiler doubles as the landing deck
 * (brass pads on top). In the opening it rides a spinning drill bit down its shaft, then
 * deploys: brackets clamp onto the back wall, then the conveyor, shelf, lamps and bulbs unfold.
 * Idle animations: meshing gears, a crank-driven steam engine, a jittering pressure gauge,
 * flickering nixie tubes and gas lamps, a chasing festoon of bulbs, chimney smoke, a whistle
 * that vents now and then, and an ore conveyor.
 */
export function Base({ game }: { game: Game }) {
  const d = game.layout.depot;
  const geo = useMemo(() => {
    const festoon = Array.from({ length: 9 }, (_, n) => {
      const f = n / 8;
      return new THREE.Vector3(-1.42 + f * 1.97, 1.95 - f * 0.25 - Math.sin(f * Math.PI) * 0.25, -0.98 + f * 0.03);
    });
    // Triangular gusset bracket: drawn as (distance out from the wall, height), extruded sideways.
    const gussetShape = new THREE.Shape([
      new THREE.Vector2(0, 0.1), new THREE.Vector2(0.86, 0.1), new THREE.Vector2(0.86, 0.04), new THREE.Vector2(0, -0.42),
    ].map((v) => v));
    const gusset = new THREE.ExtrudeGeometry(gussetShape, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.005, bevelSegments: 1 });
    gusset.translate(0, 0, -0.025);
    gusset.rotateY(-Math.PI / 2);
    const bit = new THREE.ConeGeometry(0.95, 0.82, 20);
    bit.rotateX(Math.PI);
    bit.translate(0, -0.41, 0);
    const head = new THREE.SphereGeometry(R, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    head.scale(1, 0.32, 1);
    return {
      big: gearGeometry(0.19, 14, 0.04),
      small: gearGeometry(0.11, 8, 0.04),
      tiny: gearGeometry(0.07, 6, 0.035),
      fly: gearGeometry(0.15, 18, 0.035),
      deck: new RoundedBoxGeometry(1.75, 0.06, 0.82, 3, 0.02),
      backPlate: new RoundedBoxGeometry(2.1, 1.25, 0.04, 3, 0.02),
      gusset,
      hopper: new RoundedBoxGeometry(0.3, 0.26, 0.28, 3, 0.04),
      cylinder: new RoundedBoxGeometry(0.3, 0.13, 0.12, 3, 0.04),
      nixie: new RoundedBoxGeometry(0.42, 0.16, 0.06, 3, 0.025),
      dome: lathe([[0.001, 0.2], [0.05, 0.19], [0.1, 0.15], [0.12, 0.08], [0.12, 0.0], [0.14, -0.02]]),
      stack: lathe([[0.07, 0], [0.075, 0.5], [0.11, 0.6], [0.13, 0.66], [0.1, 0.68]], 16),
      head,
      finial: lathe([[0.001, 0.16], [0.03, 0.1], [0.045, 0.05], [0.02, 0.0]], 10),
      pipeA: pipeGeometry([[-0.12, 1.02, Z_HUB - 0.2], [-0.4, 1.25, Z_HUB - 0.2], [-0.95, 1.2, Z_HUB - 0.05], [-1.05, 0.7, Z_HUB + 0.15], [-0.95, 0.32, FRONT + 0.06]]),
      pipeB: pipeGeometry([[0.55, 0.95, Z_HUB - 0.18], [0.95, 1.05, Z_HUB - 0.3], [1.35, 0.9, Z_HUB - 0.4], [2.6, 0.95, Z_HUB - 0.45]], 0.03),
      pipeC: pipeGeometry([[0.03, 0.3, FRONT + 0.06], [0.15, 0.2, FRONT + 0.03], [0.3, 0.14, FRONT - 0.05], [0.55, 0.12, FRONT - 0.15]], 0.018),
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
    big: useRef<THREE.Mesh>(null!), small: useRef<THREE.Mesh>(null!), tiny: useRef<THREE.Mesh>(null!),
    fly: useRef<THREE.Mesh>(null!), rod: useRef<THREE.Mesh>(null!), crosshead: useRef<THREE.Mesh>(null!),
    needle: useRef<THREE.Group>(null!), nixies: useRef<THREE.Group>(null!), bulbs: useRef<THREE.Group>(null!),
    pads: useRef<THREE.Group>(null!), rollers: useRef<THREE.Group>(null!), lumps: useRef<THREE.Group>(null!),
    firebox: useRef<THREE.MeshBasicMaterial>(null!),
    root: useRef<THREE.Group>(null!), drill: useRef<THREE.Group>(null!), wall: useRef<THREE.Group>(null!),
    conveyor: useRef<THREE.Group>(null!), shelf: useRef<THREE.Group>(null!), festoon: useRef<THREE.Group>(null!),
    lamps: useRef<THREE.Group>(null!), stock: useRef<THREE.Group>(null!), pipes: useRef<THREE.Group>(null!),
  };
  /** Seconds into deployment: -1 while drilling, large once deployed. */
  const deployed = () => (game.intro.phase === 'done' ? 99 : game.intro.phase === 'deploy' ? game.intro.t : -1);
  // Stage times below are laid out for a 3s deployment and stretched to DEPLOY_TIME.
  const pace = DEPLOY_TIME / 3;
  const stage = (a: number, b: number) => clamp01((deployed() - a * pace) / ((b - a) * pace));
  const timers = useRef({ smoke: 0, whistle: 4 });

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    // Opening: ride down the shaft on the drill, retract it, then unfold onto the wall.
    const intro = game.intro;
    ref.root.current.position.y = d.y + intro.offset;
    const drill = ref.drill.current;
    drill.rotation.y += dt * (intro.phase === 'drill' ? 18 : 4);
    grow(drill, intro.phase === 'drill' ? 1 : 1 - stage(0, 0.6));
    grow(ref.wall.current, easeOutBack(stage(0.3, 1.1)));
    grow(ref.pipes.current, easeOutBack(stage(0.6, 1.4)));
    grow(ref.conveyor.current, easeOutBack(stage(0.9, 1.7)));
    grow(ref.shelf.current, easeOutBack(stage(1.2, 2.0)));
    grow(ref.festoon.current, easeOutBack(stage(1.6, 2.6)));
    grow(ref.lamps.current, easeOutBack(stage(1.4, 2.2)));
    grow(ref.stock.current, easeOutBack(stage(1.0, 1.8)));
    const w = t * 0.9;
    ref.big.current.rotation.z = w;
    ref.small.current.rotation.z = -w * (14 / 8) + 0.2;
    ref.tiny.current.rotation.z = -w * (14 / 6);
    // Crank: the flywheel's pin drives a connecting rod to a crosshead sliding toward the cylinder.
    const crank = t * 2.6, cr = 0.06, L = 0.26, cx = -0.62, cy = 0.3;
    ref.fly.current.rotation.z = crank;
    const pin = { x: cx + Math.cos(crank) * cr, y: cy + Math.sin(crank) * cr };
    const headX = pin.x + Math.sqrt(L * L - (pin.y - cy) ** 2);
    ref.crosshead.current.position.x = headX;
    ref.rod.current.position.set((pin.x + headX) / 2, (pin.y + cy) / 2, FRONT + 0.07);
    ref.rod.current.rotation.z = Math.atan2(cy - pin.y, headX - pin.x) - Math.PI / 2;
    // Boiler pressure: a slow swell with nervous jitter.
    ref.needle.current.rotation.z = 0.6 - (Math.sin(t * 0.3) * 0.5 + 0.5) * 1.6 + (Math.random() - 0.5) * 0.06;
    ref.nixies.current.children.forEach((c, n) => {
      // Tube 3 died years ago; tube 1 stutters.
      const on = n === 3 ? 0.02 : n === 1 && Math.sin(t * 23) * Math.sin(t * 3.1) > 0.6 ? 0.1 : 0.6 + 0.4 * Math.abs(Math.sin(t * (0.7 + n * 0.37) + n * 1.7));
      ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setRGB(3 * on, 0.9 * on, 0.15 * on);
    });
    ref.bulbs.current.children.forEach((c, n) => {
      const on = Math.floor(t * 4) % 9 === n ? 1 : 0.35;
      ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setRGB(3 * on, 1.8 * on, 0.6 * on);
    });
    ref.firebox.current.color.setRGB(2.6 + Math.sin(t * 7) * 0.3 + Math.random() * 0.2, 0.9 + Math.sin(t * 5) * 0.1, 0.15);
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
    const tm = timers.current;
    tm.smoke -= dt; tm.whistle -= dt;
    if (game.gpu && tm.smoke <= 0) {
      tm.smoke = 0.7 + Math.random() * 0.6;
      game.gpu.burst(d.x + 0.55, d.y + 1.6, 5, ParticleKind.Steam, 0.5, 0.05);
    }
    if (game.gpu && tm.whistle <= 0) {
      tm.whistle = 6 + Math.random() * 6;
      game.gpu.burst(d.x - 0.12, d.y + 1.24, 30, ParticleKind.Steam, 1.2, 0.03);
    }
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
      {/* Riveted back plate bolted to the cavern wall; gussets carry the deck the boiler sits on,
          so the whole works hangs off the wall rather than standing on the floor. */}
      <group ref={ref.wall}>
        <mesh geometry={geo.backPlate} material={M.rustDark} position={[0, 0.45, Z_WALL]} />
        {[-0.98, -0.33, 0.33, 0.98].flatMap((x) => [-0.1, 1.0].map((y) => (
          <mesh key={`${x}:${y}`} position={[x, y, Z_WALL + 0.03]} rotation={[Math.PI / 2, 0, 0]} material={M.brass}><cylinderGeometry args={[0.025, 0.025, 0.025, 6]} /></mesh>
        )))}
        {[-0.62, 0, 0.62].map((x) => <mesh key={x} geometry={geo.gusset} material={M.rustDark} position={[x, 0.0, Z_WALL]} />)}
      </group>
      <mesh geometry={geo.deck} material={M.rustDark} position={[0, 0.1, Z_HUB + 0.02]} />
      {[-0.5, 0.5].map((x) => (
        <mesh key={x} position={[x, 0.5, Z_HUB]} rotation={[0, Math.PI / 2, 0]} material={M.iron}>
          <cylinderGeometry args={[R + 0.04, R + 0.04, 0.06, 24, 1, true, Math.PI / 2, Math.PI]} />
        </mesh>
      ))}
      <mesh position={[0, 0.48, Z_HUB]} rotation={[0, 0, Math.PI / 2]} material={M.rustIron}><cylinderGeometry args={[R, R, 1.5, 32]} /></mesh>
      {[-1, 1].map((s) => <mesh key={s} geometry={geo.head} material={M.verdigris2} position={[s * 0.75, 0.48, Z_HUB]} rotation={[0, 0, -s * Math.PI / 2]} />)}
      {/* Riveted repair patches over old leaks */}
      {[[0.46, 0.28, -0.5], [-0.58, 0.66, 0.42]].map(([x, y, a]) => {
        const ang = Math.asin((y - 0.48) / R);
        return (
          <group key={x} position={[x, y, Z_HUB + Math.cos(ang) * (R + 0.006)]} rotation={[-ang, 0, a * 0.2]}>
            <mesh material={M.rustDark}><boxGeometry args={[0.14, 0.1, 0.008]} /></mesh>
            {[[-0.055, -0.035], [0.055, -0.035], [-0.055, 0.035], [0.055, 0.035]].map(([rx, ry]) => (
              <mesh key={`${rx}${ry}`} position={[rx, ry, 0.006]} material={M.brass}><sphereGeometry args={[0.009, 6, 4]} /></mesh>
            ))}
          </group>
        );
      })}
      {[-0.62, -0.2, 0.22, 0.62].map((x, n) => (
        <group key={x}>
          {/* Brass bands at the ends, field coils glowing round the middle */}
          {n % 3 ? <GlowRing radius={R + 0.008} tube={0.016} position={[x, 0.48, Z_HUB]} rotation={[0, Math.PI / 2, 0]} />
            : <mesh position={[x, 0.48, Z_HUB]} rotation={[0, Math.PI / 2, 0]} material={M.brass}><torusGeometry args={[R + 0.008, 0.016, 8, 40]} /></mesh>}
          <Rivets x={x} />
        </group>
      ))}
      {/* Tesla coils on the boiler's back, and a rack of valves by the gauge */}
      <TeslaCoil height={0.42} position={[-0.6, 0.84, Z_HUB - 0.22]} arcs={3} />
      <TeslaCoil height={0.32} position={[0.25, 0.86, Z_HUB - 0.24]} />
      {[0.5, 0.58, 0.66].map((x) => <VacuumTube key={x} height={0.09} position={[x, 0.1 + 0.03, Z_HUB + 0.36]} />)}
      {/* Portholes with firelight behind them, and the firebox hatch */}
      {[-0.42, 0.02].map((x) => (
        <group key={x} position={[x, 0.53, FRONT - 0.005]}>
          <mesh material={M.brass}><torusGeometry args={[0.075, 0.018, 8, 24]} /></mesh>
          <mesh><circleGeometry args={[0.072, 20]} /><meshBasicMaterial color={x < 0 ? [2.2, 1.0, 0.3] : [0.7, 0.3, 0.1]} /></mesh>
        </group>
      ))}
      <group position={[-0.2, 0.23, Z_HUB + 0.31]} rotation={[-0.68 + Math.PI / 2, 0, 0]}>
        <mesh material={M.darkIron}><cylinderGeometry args={[0.1, 0.1, 0.03, 20]} /></mesh>
        <mesh position={[0, 0.016, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[0.075, 16]} /><meshBasicMaterial ref={ref.firebox} /></mesh>
        {[-0.05, 0, 0.05].map((x) => <mesh key={x} position={[x, 0.02, 0]} material={M.darkIron}><boxGeometry args={[0.012, 0.008, 0.15]} /></mesh>)}
      </group>
      {/* Pressure gauge */}
      <group position={[0.36, 0.68, Z_HUB + 0.34]} rotation={[-0.5, 0, 0]}>
        <mesh rotation={[Math.PI / 2, 0, 0]} material={M.brass}><cylinderGeometry args={[0.085, 0.085, 0.03, 24]} /></mesh>
        <mesh position={[0, 0, 0.016]} material={M.enamel}><circleGeometry args={[0.07, 24]} /></mesh>
        <group ref={ref.needle} position={[0, 0, 0.02]}>
          <mesh position={[0, 0.03, 0]}><boxGeometry args={[0.008, 0.06, 0.004]} /><meshBasicMaterial color="#b3261e" /></mesh>
        </group>
      </group>
      {/* Nixie-tube readout in a wooden case, on the boiler's face below the landing pads */}
      <mesh geometry={geo.nixie} material={M.wood} position={[-0.2, 0.73, Z_HUB + 0.33]} rotation={[-0.62, 0, 0]} />
      <group ref={ref.nixies} position={[-0.36, 0.745, Z_HUB + 0.365]} rotation={[-0.62, 0, 0]}>
        {Array.from({ length: 5 }, (_, n) => (
          <mesh key={n} position={[n * 0.08, 0, 0]}><cylinderGeometry args={[0.018, 0.018, 0.09, 10]} /><meshBasicMaterial /></mesh>
        ))}
      </group>
      {/* Landing pads on the boiler */}
      {slots.map((s, n) => (
        <group key={n} position={[s.x, HUB.h - 0.005, Z_ACTORS]}>
          <mesh material={M.brass}><cylinderGeometry args={[0.17, 0.17, 0.025, 28]} /></mesh>
          <mesh position={[0, -0.06, 0]} material={M.darkIron}><cylinderGeometry args={[0.03, 0.04, 0.1, 10]} /></mesh>
        </group>
      ))}
      {/* Steam dome, whistle and smokestack */}
      <mesh geometry={geo.dome} material={M.brass} position={[-0.12, 0.84, Z_HUB - 0.2]} />
      <mesh position={[-0.12, 1.12, Z_HUB - 0.2]} material={M.brass}><cylinderGeometry args={[0.02, 0.025, 0.12, 10]} /></mesh>
      {/* The stack has settled a little crooked */}
      <mesh geometry={geo.stack} material={M.rustDark} position={[0.55, 0.86, Z_HUB - 0.18]} rotation={[0.03, 0, -0.07]} />
      {[0.95, 1.2].map((y) => <mesh key={y} position={[0.55, y, Z_HUB - 0.18]} rotation={[Math.PI / 2, 0, 0]} material={M.brass}><torusGeometry args={[0.078, 0.01, 6, 20]} /></mesh>)}
      {/* Steam pipes. The two that run out to the cavern walls unfold once the base has landed;
          on the way down they'd poke through the sides of the shaft. */}
      <group ref={ref.pipes}>
        <mesh geometry={geo.pipeA} material={M.copper} />
        <mesh geometry={geo.pipeB} material={M.verdigris} />
      </group>
      <mesh geometry={geo.pipeC} material={M.copper} />
      {/* Steam engine: flywheel, crank rod, crosshead and cylinder */}
      <mesh ref={ref.fly} geometry={geo.fly} material={M.darkIron} position={[-0.62, 0.3, FRONT + 0.06]} />
      <mesh position={[-0.62, 0.3, FRONT + 0.09]} rotation={[Math.PI / 2, 0, 0]} material={M.brass}><cylinderGeometry args={[0.025, 0.025, 0.03, 12]} /></mesh>
      <mesh ref={ref.rod} material={M.iron}><boxGeometry args={[0.018, 0.26, 0.015]} /></mesh>
      <mesh ref={ref.crosshead} position={[-0.36, 0.3, FRONT + 0.07]} rotation={[0, 0, Math.PI / 2]} material={M.brass}><cylinderGeometry args={[0.025, 0.025, 0.06, 10]} /></mesh>
      <mesh geometry={geo.cylinder} material={M.copper} position={[-0.12, 0.3, FRONT + 0.06]} />
      {[-0.22, -0.02].map((x) => <mesh key={x} position={[x, 0.3, FRONT + 0.06]} rotation={[0, Math.PI / 2, 0]} material={M.brass}><torusGeometry args={[0.066, 0.01, 6, 16]} /></mesh>)}
      {/* Gear train */}
      <mesh ref={ref.big} geometry={geo.big} material={M.brass} position={[0.48, 0.3, FRONT + 0.02]} />
      <mesh ref={ref.small} geometry={geo.small} material={M.copper} position={[0.74, 0.46, FRONT - 0.02]} />
      <mesh ref={ref.tiny} geometry={geo.tiny} material={M.brass} position={[0.69, 0.1, FRONT - 0.04]} />
      {[[0.48, 0.3, 0.02], [0.74, 0.46, -0.02], [0.69, 0.1, -0.04]].map(([x, y, z]) => (
        <mesh key={x + y} position={[x, y, FRONT + z + 0.03]} rotation={[Math.PI / 2, 0, 0]} material={M.darkIron}><cylinderGeometry args={[0.022, 0.022, 0.04, 10]} /></mesh>
      ))}
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
      <mesh position={[1.15, 0.6, Z_WALL + 0.14]} material={M.wood}><boxGeometry args={[0.5, 0.03, 0.26]} /></mesh>
      {[0.95, 1.35].map((x) => <WallArm key={x} x={x} y={0.57} z={Z_WALL + 0.24} />)}
      {[[1.05, Z_WALL + 0.13], [1.24, Z_WALL + 0.15]].map(([x, z]) => (
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

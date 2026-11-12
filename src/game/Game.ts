import RAPIER from '@dimforge/rapier2d-compat';
import type { WebGPURenderer } from 'three/webgpu';
import {
  CELL, CELLS, CHUNK, CH, COLLAPSE_DELAY, CRACK_SHIFT, CW, DIG_BIT, EXPLORED_BIT, Emit, H, ISO, MATERIALS, MAX_ACTIVE, MAX_EMITTERS,
  Mat, REACH_BIT, SKY_ROWS, STRESS_MASK, STRESS_MAX, STRESS_SHIFT, STRESS_WARN, W, cellCenter, cellIndex, chunkId, toCell,
} from '../config';
import { GpuSim, ParticleKind } from '../gpu/GpuSim';
import { chunkPolylines } from '../sim/contours';
import { ceilings, findCollapses } from '../sim/integrity';
import { GH, GW, findPath, floodNodes, nearFlooded } from '../sim/pathfind';
import { Terrain, type Yield } from '../sim/terrain';
import { EmitterDef, WorldGen, WorldLayout } from '../sim/worldgen';
import { ChunkStreamer, chunkRows, origin } from './chunks';
import { alarm, chirp, creak, rumble } from './audio';
import { DIG_RADIUS, DOCK_SLOTS, digCenter, dockSlot } from './base';
import { EMOTES, EmoteId } from './emotes';

export type Tool = 'select' | 'dig' | 'cancel' | 'strut' | 'smelter' | 'blast' | 'scrap';
export type Overlay = 0 | 1 | 2 | 3 | 4;
type Vec = { x: number; y: number };

const BOT_RADIUS = 0.14;
const BOT_SPEED = 2.2;
const DRILL_RATE = 3.2;
/** Mining-laser range. */
const DRILL_REACH = 1.2;
const CARGO_CAP = 6;
/** Drone battery (percent): drain per second flying, extra while the laser runs, charge per second on the pad. */
const BATTERY = { fly: 1.0, laser: 1.6, charge: 14, low: 25, launch: 70 };
const QUOTA = 30;
/** Tallest gap a single strut can brace, in cells. */
const MAX_STRUT_CELLS = 16;
/** Opening sequence: drill speed (m/s) down from the surface, then how long deploying takes (s). */
const DRILL_SPEED = 3;
export const DEPLOY_TIME = 5;
/** Collapses smaller than this just crumble to dust at once; anything that falls as a chunk is warned first. */
const MIN_WARNED_COLLAPSE = 4;

const COST = {
  strut: { scrap: 2 },
  smelter: { scrap: 8 },
  blast: { scrap: 1 },
  bot: { plates: 3 },
} as const;

// Collision groups: (membership << 16) | filter.
const G_TERRAIN = 1, G_BOT = 2, G_DEBRIS = 4;
const groups = (member: number, filter: number) => (member << 16) | filter;

const BOT_NAMES = ['Rivet', 'Sprocket', 'Gasket', 'Ratchet', 'Clunk', 'Widget', 'Dinky', 'Bolt', 'Grommet', 'Tinpot', 'Flange', 'Pinion'];

/** A mining quad-copter drone. Drones dock at the base, launch to fill dig orders, and land to unload. */
export interface Bot {
  id: number;
  name: string;
  /** Landing pad index (see dockSlot). */
  slot: number;
  /** Charge, 0-100. Drones head home to recharge when it runs low. */
  battery: number;
  lowBattery: boolean;
  body: RAPIER.RigidBody;
  hp: number;
  heat: number;
  cargo: { ore: number; scrap: number };
  state: 'docked' | 'idle' | 'toDig' | 'digging' | 'toDepot' | 'salute' | 'tantrum';
  target: number;
  path: Vec[];
  replanAt: number;
  stuck: number;
  progressPos: Vec;
  progressAt: number;
  stateTimer: number;
  emoteAt: Partial<Record<EmoteId, number>>;
  blacklist: Map<number, number>;
  drillPoint: Vec | null;
  drillFx: number;
  facing: number;
  dead: boolean;
}

export interface Debris {
  id: number;
  body: RAPIER.RigidBody;
  /** Local cell offsets (world units) relative to the body origin, plus material. */
  cells: { x: number; y: number; mat: number }[];
  restTime: number;
  prevSpeed: number;
  age: number;
  /** Set once the body is gone; renderers may still hold the object for a frame. */
  removed: boolean;
}

/**
 * A steel strut filling cells j0..j1 of column i. `broken` struts have been dug out past what they
 * can stretch to and no longer hold anything up; `atRisk` ones would be, once pending dig orders
 * are done.
 */
export interface Strut { id: number; i: number; j0: number; j1: number; broken: boolean; atRisk: boolean }
export interface Smelter { id: number; x: number; y: number; hp: number; smeltTimer: number; hotUntil: number }
export interface Blast { id: number; x: number; y: number; fuse: number }
export interface Critter { id: number; name: string; x: number; y: number; vx: number; health: number; happy: boolean; complaint: string; hop: number; dead: boolean }
export interface Bubble { id: number; text: string; bot?: Bot; x: number; y: number; ttl: number }
export interface LogEntry { id: number; time: number; text: string; kind: 'emote' | 'info' | 'warn' }
/** Unsupported rock that is cracking and will fall at `due` unless it gets braced first. */
export interface PendingCollapse { id: number; cells: number[]; start: number; due: number; x: number; y: number }
/** A ceiling in the drones' working area that is close to its safe span. */
export interface Unstable { key: string; x: number; y: number; ratio: number }

export interface Env { water: number; magma: number; o2: number; toxic: number; temp: number }

let nextId = 1;

/** One tutorial step: tour steps point at a UI area; objectives have a goal with progress text. */
export interface TutorialStep {
  title: string;
  text: string;
  /** CSS selector of the UI area to highlight. */
  focus?: string;
  goal?: (g: Game) => { done: boolean; progress: string };
}

export const TUTORIAL: TutorialStep[] = [
  { title: 'Welcome to Clankworks', text: 'Your base has dug in. Drones mine whatever rock you mark, and the base turns what they bring back into something useful. Take a quick look around first: drag with the right mouse button (or use WASD) to pan, and scroll the mouse wheel to zoom in and out.' },
  { title: 'Stockpiles', focus: '.topbar', text: 'Ore, scrap, plates and your drone count. The bins beside the base fill up to match. The quota on the right is the long-term goal: 30 copper plates.' },
  { title: 'Orders and buildings', focus: '.tools', text: 'Orders tell drones what to do: Dig, Cancel, Blast, Scrap. Buildings cost resources: struts hold up ceilings, smelters turn ore into plates, and Drone builds another drone. Hover any button for details.' },
  { title: 'Layers', focus: '.layers', text: 'Switch how the world is drawn: heat, oxygen, structural stress, or the Material layer, which colour-codes rock so ore is easy to spot.' },
  { title: 'Critters and log', focus: '.critters, .log', text: 'The critters live in a cave to the left of the base; keep them warm, breathing and dry. The log reports cave-ins, warnings and what the crew is up to. Hover anything in the world with the Select cursor to learn about it.' },
  {
    title: 'Mine some ore',
    text: 'Copper ore is the rusty rock to the right of the base (the Material layer shows it in orange). Pick Dig and paint over it; your drone will mine it and bring it home.',
    focus: '.tools',
    goal: (g) => ({ done: g.oreDelivered >= 5, progress: `Ore delivered ${Math.min(5, g.oreDelivered).toFixed(1)} / 5` }),
  },
  {
    title: 'Smelt plates',
    text: 'Build a Smelter on open floor near the base (it costs scrap). It turns each ore into a copper plate.',
    focus: '.tools',
    goal: (g) => ({ done: g.platesMade >= 3, progress: `${g.smelters.length ? 'Smelter built ✓' : 'Build a smelter'} · plates ${Math.min(3, g.platesMade)} / 3` }),
  },
  {
    title: 'Build a drone',
    text: 'A new drone costs 3 plates. Press Drone (or B) to build one; it takes the next free landing pad.',
    focus: '.tools',
    goal: (g) => {
      const n = g.bots.filter((b) => !b.dead).length;
      return { done: n >= 2, progress: `Drones ${n} / 2 · plates ${Math.floor(g.resources.plates)} / 3` };
    },
  },
];

export class Game {
  readonly layout: WorldLayout;
  readonly terrain: Terrain;
  readonly physics: RAPIER.World;
  gpu: GpuSim | null = null;

  time = 0;
  frames = 0;
  resources = { ore: 0, scrap: 14, plates: 0 };
  /** Ore drones have brought home over the whole shift. */
  oreDelivered = 0;
  /**
   * The tutorial: a short tour of the UI (steps 0..TOUR_STEPS-1), then objectives that advance by
   * themselves as they're met (see TUTORIAL). `step` past the end means it's finished.
   */
  tutorial = { step: 0, skipped: false };
  /**
   * Dig orders that would undermine these struts are on hold until the player confirms or cancels
   * them; drones leave orders near the struts alone meanwhile.
   */
  strutConfirm: { strutIds: number[] } | null = null;
  platesMade = 0;
  bots: Bot[] = [];
  debris: Debris[] = [];
  struts: Strut[] = [];
  smelters: Smelter[] = [];
  blasts: Blast[] = [];
  critters: Critter[] = [];
  bubbles: Bubble[] = [];
  log: LogEntry[] = [];
  pendingCollapses: PendingCollapse[] = [];
  unstable: Unstable[] = [];
  /** Incremented whenever entity lists change, so React can re-render the lists. */
  entityVersion = 0;
  shake = 0;
  /** The plain cursor ('select') only inspects; the others act on click. */
  tool: Tool = 'select';
  /** 0 normal, 1 heat, 2 oxygen, 3 structural integrity, 4 materials. */
  overlay: Overlay = 0;
  /** Materials the material layer shows, one bit per material id (all solids by default). */
  materialMask = 0b11111110;
  /** What the camera shows (world units), set by the renderer; drives chunk streaming. */
  view = { x: 0, y: 0, halfW: 12, halfH: 8 };
  readonly chunks: ChunkStreamer;
  /**
   * Opening sequence. The base starts on the surface and drills straight down to the start cavern
   * (`offset` is its height above its final resting place), then deploys; play starts after.
   */
  intro = { phase: 'drill' as 'drill' | 'deploy' | 'done', t: 0, offset: 0 };
  /** Initial / last-loaded fluid (water, magma, oxygen, toxic) and temperature per cell. */
  readonly fluidInit = new Float32Array(CELLS * 4);
  readonly tempInit = new Float32Array(CELLS);

  private readonly terrainBody: RAPIER.RigidBody;
  private readonly chunkColliders = new Map<number, RAPIER.Collider[]>();
  private readonly marked = new Set<number>();
  private readonly claims = new Map<number, number>();
  private structuralAt = 0;
  private readbackAt = 0;
  private emitterAt = 0;
  private critterTickAt = 0;
  private stressAt = 0;
  private stressCooldown = 0;
  private carlCooldown = 20;
  private cogCooldown = 0;
  private deepestY: number;
  private oreDeliveries: number[] = [];
  private caveIns: { time: number; x: number; y: number; botIds: number[]; checked: boolean }[] = [];
  private quotaAnnounced = false;
  private pendingCheckAt = 0;
  private rangeWarnAt = 0;
  /** Path nodes the drones can fly to from the base (see updateReachability). */
  private readonly access = new Uint8Array(GW * GH);
  private reachAt = 0;
  private chunkAt = 0;
  private revealAt = 0;
  private stressMapAt = 0;
  private stressVersion = -1;
  private readonly warnedUnstable = new Map<string, number>();
  private strutsVersion = -1;
  private drillY = 0;
  private drillFxAt = 0;

  static async create(seed?: number) {
    await RAPIER.init();
    return new Game(new WorldGen(seed));
  }

  private constructor(gen: WorldGen) {
    this.layout = gen.layout;
    this.terrain = new Terrain();
    this.physics = new RAPIER.World({ x: 0, y: -9.81 });
    this.terrainBody = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.chunks = new ChunkStreamer(this.terrain, gen, this.fluidInit, this.tempInit, {
      loaded: (id) => this.chunkLoaded(id),
      fields: (id) => ({
        fluid: chunkRows(this.gpu?.fluidSnapshot ?? this.fluidInit, id, 4),
        temp: chunkRows(this.gpu?.tempSnapshot ?? this.tempInit, id, 1),
      }),
      unloaded: (id) => this.chunkUnloaded(id),
    });
    const layout = this.layout;
    this.view = { x: layout.depot.x, y: layout.depot.y + 1, halfW: 12, halfH: 8 };
    this.intro.offset = layout.surfaceY - layout.depot.y;
    this.drillY = layout.surfaceY + 0.5;
    for (const id of this.wantedChunks()) this.chunks.loadNow(id);
    gen.locate(this.terrain);
    this.rebuildColliders();
    this.terrain.structuralDirty = null;
    this.deepestY = layout.depot.y;
    this.reveal(layout.depot.x, layout.depot.y + 1, 9);
    this.reveal(layout.terrarium.x, layout.terrarium.y + 1, 4);

    this.spawnBot(false);
    for (let n = 0; n < 4; n++) {
      const t = layout.terrarium;
      this.critters.push({
        id: nextId++, name: ['Mossbert', 'Pudding', 'Sir Squish', 'Lumen'][n],
        x: t.x + (n - 1.5) * 0.6, y: this.floorY(t.x + (n - 1.5) * 0.6, t.y), vx: (Math.random() - 0.5) * 0.4, health: 100, happy: true, complaint: '', hop: Math.random() * 6, dead: false,
      });
    }
    // The base cavern struts from worldgen become real struts.
    for (const i of layout.strutCols) {
      let j0 = -1, j1 = -1;
      for (let j = 0; j < H; j++) if (this.terrain.strut[cellIndex(i, j)]) { if (j0 < 0) j0 = j; j1 = j; }
      if (j0 >= 0) this.struts.push({ id: nextId++, i, j0, j1, broken: false, atRisk: false });
    }
    this.info('Drilling down to the dig site…');
  }

  attachGpu(renderer: WebGPURenderer) {
    this.gpu = new GpuSim(renderer, this.terrain, this.fluidInit, this.tempInit);
    for (const id of this.chunks.resident) this.gpu.activate(id);
    this.gpu.setEmitters(this.emitters());
  }

  // ---------------------------------------------------------------- chunk streaming

  /**
   * Chunks the game needs resident, most important first: the base and everything within dig
   * range, the drones and where they are headed, falling debris and cracking rock, then what
   * the camera sees (plus a margin), nearest the view centre first.
   */
  private wantedChunks() {
    const out: number[] = [];
    const seen = new Set<number>();
    const add = (x: number, y: number, rx: number, ry = rx) => {
      const ci0 = Math.max(0, Math.floor((x - rx) / (CHUNK * CELL))), ci1 = Math.min(CW - 1, Math.floor((x + rx) / (CHUNK * CELL)));
      const cj0 = Math.max(0, Math.floor((y - ry) / (CHUNK * CELL))), cj1 = Math.min(CH - 1, Math.floor((y + ry) / (CHUNK * CELL)));
      for (let cj = cj0; cj <= cj1; cj++) for (let ci = ci0; ci <= ci1; ci++) {
        const id = chunkId(ci, cj);
        if (!seen.has(id)) { seen.add(id); out.push(id); }
      }
    };
    const c = this.digCenter;
    add(c.x, c.y, DIG_RADIUS + 2);
    if (this.intro.phase !== 'done') {
      // The whole drill shaft, so it can be carved as the base descends.
      const d = this.layout.depot, top = this.layout.surfaceY + 1;
      add(d.x, (d.y + top) / 2, 2, (top - d.y) / 2 + 1);
    }
    for (const b of this.bots) {
      if (b.dead) continue;
      const p = b.body.translation();
      add(p.x, p.y, 3);
      if (b.target >= 0) add(cellCenter(b.target % W), cellCenter((b.target / W) | 0), 2);
    }
    for (const d of this.debris) { const p = d.body.translation(); add(p.x, p.y, 4); }
    for (const p of this.pendingCollapses) add(p.x, p.y, 4);
    for (const b of this.blasts) add(b.x, b.y, 3);
    const v = this.view, margin = CHUNK * CELL;
    const viewIds: number[] = [];
    const before = out.length;
    add(v.x, v.y, v.halfW + margin, v.halfH + margin);
    viewIds.push(...out.splice(before));
    const cx = (id: number) => ((id % CW) + 0.5) * CHUNK * CELL - v.x, cy = (id: number) => (Math.floor(id / CW) + 0.5) * CHUNK * CELL - v.y;
    viewIds.sort((a, b) => Math.hypot(cx(a), cy(a)) - Math.hypot(cx(b), cy(b)));
    return [...out, ...viewIds].slice(0, MAX_ACTIVE);
  }

  private chunkLoaded(id: number) {
    const t = this.terrain;
    const { i0, j0 } = origin(id);
    // Not a structural change: natural caves stay up until something disturbs them.
    t.markDirty(i0, j0, i0 + CHUNK - 1, j0 + CHUNK - 1, false);
    for (let j = j0; j < j0 + CHUNK; j++) for (let i = i0; i < i0 + CHUNK; i++) {
      const k = cellIndex(i, j);
      if (t.digMark[k] & DIG_BIT) this.marked.add(k);
    }
    if (this.gpu && !this.gpu.activate(id)) console.warn('No free GPU slot for chunk', id);
    this.gpu?.loadFields(i0, j0, CHUNK, chunkRows(this.fluidInit, id, 4), chunkRows(this.tempInit, id, 1));
    this.stressVersion = -1;
  }

  private chunkUnloaded(id: number) {
    const { i0, j0 } = origin(id);
    for (const c of this.chunkColliders.get(id) ?? []) this.physics.removeCollider(c, false);
    this.chunkColliders.delete(id);
    this.terrain.dirtyChunks.delete(id);
    this.gpu?.deactivate(id);
    // Placeholders replaced the chunk's rows; neighbours' meshes read across the border.
    this.terrain.solidRects.push({ i0, j0, i1: i0 + CHUNK - 1, j1: j0 + CHUNK - 1 });
    this.terrain.touchMarks(i0, j0, i0 + CHUNK - 1, j0 + CHUNK - 1);
    for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const ci = id % CW + di, cj = Math.floor(id / CW) + dj;
      if (ci >= 0 && cj >= 0 && ci < CW && cj < CH && this.chunks.isLoaded(chunkId(ci, cj))) this.terrain.meshDirty.add(chunkId(ci, cj));
    }
  }

  // ---------------------------------------------------------------- fog of war

  /** Mark cells within `radius` (world units) as explored. */
  reveal(x: number, y: number, radius: number) {
    const t = this.terrain, marks = t.digMark;
    const r = radius / CELL, ci = x / CELL, cj = y / CELL;
    let changed = false;
    for (let j = Math.max(0, Math.floor(cj - r)); j <= Math.min(H - 1, cj + r); j++) {
      for (let i = Math.max(0, Math.floor(ci - r)); i <= Math.min(W - 1, ci + r); i++) {
        const k = cellIndex(i, j);
        if (marks[k] & EXPLORED_BIT || Math.hypot(i + 0.5 - ci, j + 0.5 - cj) > r || !t.isLoadedCell(i, j)) continue;
        marks[k] |= EXPLORED_BIT;
        changed = true;
      }
    }
    if (changed) t.touchMarks(Math.floor(ci - r), Math.floor(cj - r), Math.ceil(ci + r), Math.ceil(cj + r));
  }

  // ---------------------------------------------------------------- structural stress

  /**
   * Stress map for the integrity overlay and early warnings. Each ceiling's span as a fraction of
   * what its weakest material holds, highest mid-span, is written into the ceiling and the rock
   * above it. Ceilings in the drones' working area that pass STRESS_WARN get a warning.
   */
  private updateStressMap() {
    if (this.time < this.stressMapAt || (this.stressVersion === this.terrain.version + this.struts.length)) return;
    this.stressMapAt = this.time + 1;
    this.stressVersion = this.terrain.version + this.struts.length;
    const t = this.terrain, marks = t.digMark;
    let i0 = W, j0 = H, i1 = 0, j1 = 0;
    for (const id of this.chunks.resident) {
      const o = origin(id);
      i0 = Math.min(i0, o.i0); j0 = Math.min(j0, o.j0); i1 = Math.max(i1, o.i0 + CHUNK - 1); j1 = Math.max(j1, o.j0 + CHUNK - 1);
    }
    if (i1 < i0) return;
    for (let j = j0; j <= j1; j++) for (let k = j * W + i0; k <= j * W + i1; k++) marks[k] &= ~STRESS_MASK;
    const unstable: Unstable[] = [];
    const c = this.digCenter;
    for (const ceil of ceilings(t, { i0, j0, i1, j1 })) {
      const ratio = ceil.span / ceil.maxSpan;
      if (ratio < 0.25) continue;
      const first = ceil.cols[0], mid = (first + ceil.cols[ceil.cols.length - 1]) / 2, half = Math.max(1, ceil.span / 2);
      for (const i of ceil.cols) {
        const centred = 1 - Math.abs(i - mid) / half;
        let s = Math.min(1, ratio * (0.6 + 0.4 * centred));
        for (let j = ceil.rowOf.get(i)!, n = 0; n < 5 && j < H && t.density[cellIndex(i, j)] > ISO; j++, n++, s *= 0.85) {
          const k = cellIndex(i, j);
          const q = Math.round(s * STRESS_MAX);
          if (q > ((marks[k] & STRESS_MASK) >> STRESS_SHIFT)) marks[k] = (marks[k] & ~STRESS_MASK) | (q << STRESS_SHIFT);
        }
      }
      const x = cellCenter(Math.round(mid)), y = cellCenter(ceil.rowOf.get(ceil.cols[Math.floor(ceil.cols.length / 2)])!);
      if (ratio >= STRESS_WARN && ratio <= 1 && dist({ x, y }, c) <= DIG_RADIUS + 3) {
        unstable.push({ key: `${Math.round(x / 2)}:${Math.round(y / 2)}`, x, y, ratio });
      }
    }
    t.touchMarks(i0, j0, i1, j1);
    for (const u of unstable) {
      if ((this.warnedUnstable.get(u.key) ?? -Infinity) > this.time - 60) continue;
      this.warnedUnstable.set(u.key, this.time);
      this.warn(`Structural warning: a ceiling is at ${Math.round(u.ratio * 100)}% of its safe span. Add a strut before it gives.`);
    }
    this.unstable = unstable;
  }

  // ---------------------------------------------------------------- opening sequence

  /** Drill down: carve the shaft ahead of the base, throw rock and sparks, then deploy. */
  private updateIntro(dt: number) {
    const intro = this.intro, d = this.layout.depot;
    intro.t += dt;
    if (intro.phase === 'drill') {
      intro.offset = Math.max(0, intro.offset - DRILL_SPEED * dt);
      this.carveShaft(d.y + intro.offset - 0.25);
      this.shake = Math.max(this.shake, 0.25);
      if (this.time >= this.drillFxAt && this.gpu) {
        this.drillFxAt = this.time + 0.05;
        const y = d.y + intro.offset - 0.3;
        const k = cellIndex(toCell(d.x), Math.max(0, toCell(y - 0.4)));
        this.gpu.burst(d.x + (Math.random() - 0.5) * 2, y, 24, this.terrain.material[k] || Mat.Dirt, 3, 0.3);
        this.gpu.burst(d.x + (Math.random() - 0.5) * 1.6, y, 8, ParticleKind.Spark, 4, 0.1);
        if (Math.random() < 0.15) rumble(0.6);
      }
      if (intro.offset === 0) {
        intro.phase = 'deploy';
        intro.t = 0;
        this.shake = 0.8;
        rumble(2.5);
        this.gpu?.burst(d.x, d.y + 0.1, 160, Mat.Dirt, 3, 1.1);
        this.gpu?.burst(d.x - 0.12, d.y + 1.24, 60, ParticleKind.Steam, 1.6, 0.05);
        this.info('Touchdown. Deploying the base.');
      }
    } else if (intro.phase === 'deploy' && intro.t >= DEPLOY_TIME) {
      this.finishIntro();
    }
  }

  /**
   * Carve the shaft from the last drilled height down to `y`, as wide as the base. It stops short
   * of the cavern floor: once the drill breaks into the cavern there is nothing left to cut.
   */
  private carveShaft(y: number) {
    const d = this.layout.depot;
    const lowest = d.y + 1.3;
    for (; this.drillY > Math.max(y, lowest); this.drillY -= 0.2) this.terrain.carve(d.x, this.drillY, 1.25, 4);
  }

  private finishIntro() {
    const d = this.layout.depot;
    this.carveShaft(d.y - 0.25);
    this.intro = { phase: 'done', t: 0, offset: 0 };
    // Drones rode down on their pads; make sure they're on them (skipping jumps the base down).
    for (const bot of this.bots) bot.body.setTranslation(this.slotOf(bot), true);
    this.reveal(d.x, d.y + 1, 9);
    this.entityVersion++;
    this.info('Shift started. Designate rock near the base and the drones will mine it. Oxygen is strictly optional.');
    this.info(`Quarterly quota: ${QUOTA} copper plates. Management believes in you, statistically.`);
  }

  /** Jump straight to the deployed base (the intro's skip button, and tests). */
  skipIntro() {
    if (this.intro.phase === 'done') return;
    for (const id of this.wantedChunks()) this.chunks.loadNow(id);
    this.finishIntro();
  }

  // ---------------------------------------------------------------- strut dig confirmation

  /**
   * The area around a strut whose dig orders are held while the player decides: its column
   * (± 1.5m) from 4m below its bottom plate to 4m above its top plate.
   */
  private strutArea(s: Strut) {
    const pad = 6;
    return { i0: s.i - pad, i1: s.i + pad, j0: Math.max(0, s.j0 - MAX_STRUT_CELLS - 2), j1: Math.min(H - 1, s.j1 + MAX_STRUT_CELLS + 2) };
  }

  private heldForStrut(k: number) {
    if (!this.strutConfirm) return false;
    const i = k % W, j = (k / W) | 0;
    return this.strutConfirm.strutIds.some((id) => {
      const s = this.struts.find((o) => o.id === id);
      if (!s) return false;
      const a = this.strutArea(s);
      return i >= a.i0 && i <= a.i1 && j >= a.j0 && j <= a.j1;
    });
  }

  /** The player's answer: dig anyway, or cancel the dig orders around the threatened struts. */
  resolveStrutConfirm(dig: boolean) {
    const confirm = this.strutConfirm;
    this.strutConfirm = null;
    if (!confirm || dig) return;
    const t = this.terrain, marks = t.digMark;
    for (const id of confirm.strutIds) {
      const s = this.struts.find((o) => o.id === id);
      if (!s) continue;
      const a = this.strutArea(s);
      for (let j = a.j0; j <= a.j1; j++) for (let i = Math.max(0, a.i0); i <= Math.min(W - 1, a.i1); i++) {
        const k = cellIndex(i, j);
        if (!(marks[k] & DIG_BIT)) continue;
        marks[k] &= ~(DIG_BIT | REACH_BIT);
        this.marked.delete(k);
      }
      t.touchMarks(a.i0, a.j0, a.i1, a.j1);
    }
    this.updateStruts(true);
    this.reachAt = 0;
    this.info('Cancelled the dig orders around the strut.');
  }

  // ---------------------------------------------------------------- tutorial

  skipTutorial() {
    this.tutorial = { step: TUTORIAL.length, skipped: true };
  }

  /** Advance the tour by hand, or the objectives when their goal is met. */
  tutorialNext() {
    if (this.tutorial.step < TUTORIAL.length) this.tutorial.step++;
  }

  private updateTutorial() {
    const step = TUTORIAL[this.tutorial.step];
    if (!step || this.intro.phase !== 'done' || !step.goal) return;
    if (step.goal(this).done) {
      this.tutorial.step++;
      chirp(1, 4);
      const next = TUTORIAL[this.tutorial.step];
      this.info(next ? `Objective complete. Next: ${next.title}.` : 'Tutorial complete. The quarry is yours.');
    }
  }

  // ---------------------------------------------------------------- strut upkeep

  /**
   * The open run of column i around a strut's cells, grown up and down until it hits rock (cells
   * with dig orders count as already dug when `withOrders` is set). `ok` when both ends are solid
   * within the strut's maximum length.
   */
  private strutSpan(s: Strut, withOrders: boolean) {
    const t = this.terrain;
    const open = (j: number) => t.isOpen(s.i, j) || (withOrders && (t.digMark[cellIndex(s.i, j)] & DIG_BIT) !== 0);
    let a = s.j0, b = s.j1;
    while (a > 0 && open(a - 1) && b - a < MAX_STRUT_CELLS) a--;
    while (b < H - 1 && open(b + 1) && b - a < MAX_STRUT_CELLS) b++;
    const ok = b - a + 1 <= MAX_STRUT_CELLS && !open(a - 1) && !open(b + 1) && t.isSolid(s.i, a - 1) && t.isSolid(s.i, b + 1);
    return { a, b, ok };
  }

  /**
   * Struts follow the rock: when the ground under a plate (or the rock above one) is dug away,
   * the strut telescopes to the new floor or ceiling. If that would take it past its maximum
   * length it gives up and stops supporting anything until the gap is short enough again.
   */
  private updateStruts(force = false) {
    const t = this.terrain;
    if (!force && this.strutsVersion === t.version) return;
    this.strutsVersion = t.version;
    for (const s of this.struts) {
      if (!t.isLoadedCell(s.i, s.j0)) continue;
      const span = this.strutSpan(s, false);
      if (span.ok) {
        if (span.a !== s.j0 || span.b !== s.j1 || s.broken) {
          for (let j = span.a; j <= span.b; j++) t.strut[cellIndex(s.i, j)] = 1;
          if (s.broken) this.info('A strut is braced again.');
          s.j0 = span.a; s.j1 = span.b; s.broken = false;
          this.entityVersion++;
        }
      } else if (!s.broken) {
        s.broken = true;
        for (let j = s.j0; j <= s.j1; j++) t.strut[cellIndex(s.i, j)] = 0;
        this.entityVersion++;
        this.warn('A strut was dug out and is no longer supporting the ceiling.');
        // Whatever it held up needs re-checking.
        const r = t.structuralDirty, i0 = s.i - 2, i1 = s.i + 2, j0 = s.j0 - 2, j1 = s.j1 + 2;
        t.structuralDirty = r ? { i0: Math.min(r.i0, i0), j0: Math.min(r.j0, j0), i1: Math.max(r.i1, i1), j1: Math.max(r.j1, j1) } : { i0, j0, i1, j1 };
      }
      s.atRisk = !s.broken && !this.strutSpan(s, true).ok;
    }
  }

  // ---------------------------------------------------------------- environment queries

  env(x: number, y: number): Env {
    const i = Math.min(W - 1, Math.max(0, toCell(x))), j = Math.min(H - 1, Math.max(0, toCell(y)));
    const k = cellIndex(i, j);
    const f = this.gpu?.fluidSnapshot ?? this.fluidInit;
    const t = this.gpu?.tempSnapshot ?? this.tempInit;
    return { water: f[k * 4], magma: f[k * 4 + 1], o2: f[k * 4 + 2], toxic: f[k * 4 + 3], temp: t[k] };
  }

  /** Height of the floor under x, searching from roughly height y. */
  floorY(x: number, y: number) {
    const i = toCell(x);
    let j = toCell(y + 0.3);
    while (j > 0 && this.terrain.isOpen(i, j - 1)) j--;
    while (j < H - 1 && this.terrain.isSolid(i, j)) j++;
    return j * CELL;
  }

  get quota() { return QUOTA; }
  canAfford(cost: Partial<Record<keyof Game['resources'], number>>) {
    return Object.entries(cost).every(([k, v]) => this.resources[k as keyof Game['resources']] >= (v ?? 0));
  }
  private pay(cost: Partial<Record<keyof Game['resources'], number>>) {
    if (!this.canAfford(cost)) return false;
    for (const [k, v] of Object.entries(cost)) this.resources[k as keyof Game['resources']] -= v ?? 0;
    return true;
  }

  // ---------------------------------------------------------------- logging & emotes

  private pushLog(text: string, kind: LogEntry['kind']) {
    this.log.push({ id: nextId++, time: this.time, text, kind });
    if (this.log.length > 40) this.log.shift();
  }
  info(text: string) { this.pushLog(text, 'info'); }
  warn(text: string) { this.pushLog(text, 'warn'); chirp(-1, 2); }

  emote(bot: Bot | undefined, id: EmoteId, cooldown = 0) {
    if (bot) {
      const last = bot.emoteAt[id] ?? -Infinity;
      if (this.time - last < cooldown) return;
      bot.emoteAt[id] = this.time;
    }
    const e = EMOTES[id];
    const pos = bot ? bot.body.translation() : { x: 0, y: 0 };
    this.bubbles.push({ id: nextId++, text: e.text, bot, x: pos.x, y: pos.y, ttl: 3.2 });
    this.pushLog(`${bot ? bot.name : 'Crew'}: "${e.text}"`, 'emote');
    chirp(e.mood, 4);
  }

  private randomBot(near?: Vec, radius = Infinity) {
    const alive = this.bots.filter((b) => !b.dead && (!near || dist(b.body.translation(), near) < radius));
    return alive[Math.floor(Math.random() * alive.length)];
  }

  // ---------------------------------------------------------------- player actions

  /** Apply the current tool at a world position. `drag` is true for painting while held. */
  useTool(x: number, y: number, drag: boolean) {
    if (this.intro.phase !== 'done') return;
    switch (this.tool) {
      case 'dig': this.designate(x, y, 0.7, true); break;
      case 'cancel': this.designate(x, y, 0.9, false); break;
      case 'strut': if (!drag) this.placeStrut(x, y); break;
      case 'smelter': if (!drag) this.placeSmelter(x, y); break;
      case 'blast': if (!drag) this.placeBlast(x, y); break;
      case 'scrap': if (!drag) this.scrapStrut(x, y); break;
    }
  }

  /** Centre of the drones' working range. */
  get digCenter() { return digCenter(this.layout.depot); }
  get digRadius() { return DIG_RADIUS; }
  inDigRange(x: number, y: number) { return dist({ x, y }, this.digCenter) <= DIG_RADIUS; }

  designate(x: number, y: number, radius: number, on: boolean) {
    const r = radius / CELL;
    const ci = x / CELL - 0.5, cj = y / CELL - 0.5;
    const marks = this.terrain.digMark;
    let changed = false, outOfRange = false;
    for (let j = Math.floor(cj - r); j <= cj + r; j++) for (let i = Math.floor(ci - r); i <= ci + r; i++) {
      if (!this.terrain.inBounds(i, j) || Math.hypot(i - ci, j - cj) > r) continue;
      const k = cellIndex(i, j);
      if (on && (this.terrain.density[k] <= ISO || this.terrain.material[k] === Mat.Bedrock || marks[k] & DIG_BIT)) continue;
      if (on && !this.inDigRange(cellCenter(i), cellCenter(j))) { outOfRange = true; continue; }
      if (!on && !(marks[k] & DIG_BIT)) continue;
      marks[k] = on ? marks[k] | DIG_BIT : marks[k] & ~(DIG_BIT | REACH_BIT);
      if (on) this.marked.add(k); else this.marked.delete(k);
      changed = true;
    }
    if (changed) {
      this.terrain.touchMarks(Math.floor(ci - r), Math.floor(cj - r), Math.ceil(ci + r), Math.ceil(cj + r));
      this.reachAt = 0;
      const risky = this.struts.filter((s) => s.atRisk).length;
      this.updateStruts(true);
      if (on && this.struts.filter((s) => s.atRisk).length > risky) {
        // Hold the risky orders and ask the player (see strutConfirm).
        const ids = new Set(this.strutConfirm?.strutIds ?? []);
        for (const st of this.struts) if (st.atRisk) ids.add(st.id);
        this.strutConfirm = { strutIds: [...ids] };
        this.warn(`This dig would undermine a strut: it can only stretch to ${MAX_STRUT_CELLS * CELL}m, then it stops holding up the ceiling.`);
      }
    }
    if (outOfRange && !changed && this.time >= this.rangeWarnAt) {
      this.rangeWarnAt = this.time + 3;
      this.warn(`Out of drone range. Dig orders must be within ${DIG_RADIUS}m of the base.`);
    }
  }

  /**
   * The floor-to-ceiling span a strut would fill for a click at (x, y), in the clicked column.
   * `error` says why it can't be built there (also used by the placement hologram, which draws
   * the span it found even when it is too tall).
   */
  strutSite(x: number, y: number): { i: number; j0: number; j1: number; error?: string } {
    const t = this.terrain;
    const i = toCell(x);
    const j = toCell(y);
    if (!t.isOpen(i, j)) return { i, j0: j, j1: j, error: 'Struts must be placed in open space.' };
    // Search a little past the limit so an over-tall gap reads as too tall, not as bottomless.
    const search = MAX_STRUT_CELLS * 2;
    let j0 = j, j1 = j;
    while (j0 > 0 && t.isOpen(i, j0 - 1) && j - j0 < search) j0--;
    while (j1 < H - 1 && t.isOpen(i, j1 + 1) && j1 - j < search) j1++;
    const site = { i, j0, j1 };
    if (j1 - j0 + 1 > MAX_STRUT_CELLS) return { ...site, error: `Too tall: a strut spans at most ${MAX_STRUT_CELLS * CELL}m.` };
    if (!t.isSolid(i, j0 - 1) || !t.isSolid(i, j1 + 1) || j1 >= H - SKY_ROWS - 1) {
      return { ...site, error: 'A strut needs both a floor and a ceiling to brace between.' };
    }
    if (t.strut[cellIndex(i, j)]) return { ...site, error: 'There is already a strut here.' };
    if (!this.canAfford(COST.strut)) return { ...site, error: 'Insufficient scrap for a strut (2).' };
    return site;
  }

  /** The strut under a world position (its column ±1 cell, plates included), if any. */
  strutAt(x: number, y: number) {
    const i = toCell(x);
    return this.struts.find((s) => Math.abs(s.i - i) <= 1 && y >= s.j0 * CELL - 0.2 && y <= (s.j1 + 1) * CELL + 0.2);
  }

  /** Take a strut down for half its scrap back. Whatever it held up is re-checked. */
  scrapStrut(x: number, y: number) {
    const s = this.strutAt(x, y);
    if (!s) return this.warn('No strut there to scrap.');
    const t = this.terrain;
    if (!s.broken) for (let j = s.j0; j <= s.j1; j++) t.strut[cellIndex(s.i, j)] = 0;
    this.struts = this.struts.filter((o) => o !== s);
    this.resources.scrap += 1;
    const r = t.structuralDirty, i0 = s.i - 2, i1 = s.i + 2, j0 = s.j0 - 2, j1 = s.j1 + 2;
    t.structuralDirty = r ? { i0: Math.min(r.i0, i0), j0: Math.min(r.j0, j0), i1: Math.max(r.i1, i1), j1: Math.max(r.j1, j1) } : { i0, j0, i1, j1 };
    this.pendingCheckAt = 0;
    this.entityVersion++;
    this.info('Strut scrapped (+1 scrap).');
    this.gpu?.burst((s.i + 0.5) * CELL, (s.j0 + s.j1 + 1) * CELL / 2, 40, ParticleKind.Spark, 2.5, 0.3);
  }

  placeStrut(x: number, y: number) {
    const t = this.terrain;
    const { i, j0, j1, error } = this.strutSite(x, y);
    if (error || !this.pay(COST.strut)) return this.warn(error ?? 'Insufficient scrap for a strut (2).');
    for (let j = j0; j <= j1; j++) t.strut[cellIndex(i, j)] = 1;
    this.struts.push({ id: nextId++, i, j0, j1, broken: false, atRisk: false });
    // A strut may have saved cracking rock; re-evaluate straight away.
    this.pendingCheckAt = 0;
    this.entityVersion++;
    this.info(`Steel strut installed (${((j1 - j0 + 1) * CELL).toFixed(1)}m).`);
  }

  /**
   * Where a smelter would stand for a click at (x, y): dropped to the floor below, centred on the
   * clicked column. `error` says why it can't be built there (also used by the placement hologram).
   */
  smelterSite(x: number, y: number): { x: number; y: number; error?: string } {
    const t = this.terrain;
    const i = toCell(x);
    let j = toCell(y);
    if (!t.isOpen(i, j)) return { x, y, error: 'Smelters must be placed in open space.' };
    while (j > 0 && t.isOpen(i, j - 1)) j--;
    const site = { x: cellCenter(i), y: j * CELL };
    for (let dj = 0; dj < 5; dj++) for (let di = -2; di <= 2; di++) {
      if (!t.isOpen(i + di, j + dj)) return { ...site, error: 'Not enough room for a smelter (needs 1.25m × 1.25m).' };
    }
    if (!this.canAfford(COST.smelter)) return { ...site, error: 'Insufficient scrap for a smelter (8).' };
    return site;
  }

  placeSmelter(x: number, y: number) {
    const site = this.smelterSite(x, y);
    if (site.error || !this.pay(COST.smelter)) return this.warn(site.error ?? 'Insufficient scrap for a smelter (8).');
    this.smelters.push({ id: nextId++, x: site.x, y: site.y, hp: 100, smeltTimer: 0, hotUntil: 0 });
    this.entityVersion++;
    this.info('Smelter online. Ore in, plates out.');
    this.emote(this.randomBot(), 'quarryMustGrow');
  }

  placeBlast(x: number, y: number) {
    if (!this.pay(COST.blast)) return this.warn('Insufficient scrap for a blast charge (1).');
    this.blasts.push({ id: nextId++, x, y, fuse: 2.5 });
    this.entityVersion++;
  }

  buildBot() {
    if (this.intro.phase !== 'done') return;
    if (this.bots.filter((b) => !b.dead).length >= DOCK_SLOTS) return this.warn('Every landing pad is taken.');
    if (!this.pay(COST.bot)) return this.warn('A new drone needs 3 plates.');
    const bot = this.spawnBot(true);
    this.emote(bot, 'strikeTheEarth');
  }

  // ---------------------------------------------------------------- entities

  /** Assemble a drone on the first free landing pad. */
  private spawnBot(announce: boolean) {
    const used = new Set(this.bots.filter((b) => !b.dead).map((b) => b.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const { x, y } = dockSlot(this.layout.depot, slot);
    // Rotors cancel gravity; only impulses (blasts, kicks) knock drones around.
    const body = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y).lockRotations().setLinearDamping(0.6).setCcdEnabled(true).setGravityScale(0),
    );
    this.physics.createCollider(
      RAPIER.ColliderDesc.ball(BOT_RADIUS).setFriction(0.3).setRestitution(0.1).setCollisionGroups(groups(G_BOT, G_TERRAIN | G_DEBRIS)),
      body,
    );
    const bot: Bot = {
      id: nextId++, name: BOT_NAMES[this.bots.length % BOT_NAMES.length] + (this.bots.length >= BOT_NAMES.length ? ' II' : ''),
      slot, battery: 100, lowBattery: false, body, hp: 100, heat: 0, cargo: { ore: 0, scrap: 0 }, state: 'docked', target: -1, path: [], replanAt: 0,
      stuck: 0, progressPos: { x, y }, progressAt: this.time, stateTimer: 0, emoteAt: {}, blacklist: new Map(),
      drillPoint: null, drillFx: 0, facing: 1, dead: false,
    };
    this.bots.push(bot);
    this.entityVersion++;
    if (announce) this.info(`${bot.name} has been deployed.`);
    return bot;
  }

  private destroyBot(bot: Bot, cause: string) {
    if (bot.dead) return;
    bot.dead = true;
    const p = bot.body.translation();
    this.physics.removeRigidBody(bot.body);
    this.releaseClaim(bot);
    this.gpu?.burst(p.x, p.y, 120, ParticleKind.Spark, 4, 0.2);
    this.resources.scrap += 1;
    this.warn(`${bot.name} ${cause}. Reclassified as scrap (+1).`);
    this.bubbles = this.bubbles.filter((b) => b.bot !== bot);
    this.entityVersion++;
    this.onLoss();
  }

  private onLoss() {
    const recentOre = this.oreDeliveries.filter((t) => this.time - t < 30).length;
    if (recentOre > 0) this.emote(this.randomBot(), 'losingIsOptimal');
  }

  // ---------------------------------------------------------------- main update

  update(dt: number) {
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    this.frames++;
    this.shake = Math.max(0, this.shake - dt * 2);

    if (this.intro.phase !== 'done') this.updateIntro(dt);
    this.updateBots(dt);
    this.updateBlasts(dt);
    this.physics.timestep = dt;
    this.physics.step();
    this.updateDebris(dt);
    this.updateSmelters(dt);
    this.updateCritters(dt);
    this.updateEvents();
    this.updatePendingCollapses(dt);
    this.updateReachability();
    if (this.time >= this.chunkAt) {
      this.chunkAt = this.time + 0.25;
      this.chunks.update(this.wantedChunks(), this.time);
    }
    if (this.time >= this.revealAt) {
      this.revealAt = this.time + 0.2;
      for (const b of this.bots) if (!b.dead) { const p = b.body.translation(); this.reveal(p.x, p.y, 3.5); }
      const d = this.layout.depot;
      if (this.intro.phase === 'done') this.reveal(d.x, d.y + 1, 9);
      else this.reveal(d.x, d.y + this.intro.offset + 0.5, 3.5);
    }
    this.updateStressMap();
    this.updateStruts();
    this.updateTutorial();
    if (this.strutConfirm) {
      this.strutConfirm.strutIds = this.strutConfirm.strutIds.filter((id) => this.struts.some((s) => s.id === id && s.atRisk));
      if (!this.strutConfirm.strutIds.length) this.strutConfirm = null;
    }

    if (this.terrain.structuralDirty && this.time >= this.structuralAt) {
      this.structuralAt = this.time + 0.15;
      const region = this.terrain.structuralDirty;
      this.terrain.structuralDirty = null;
      this.checkCollapses(region);
    }
    if (this.terrain.dirtyChunks.size) this.rebuildColliders();

    for (const b of this.bubbles) {
      b.ttl -= dt;
      if (b.bot && !b.bot.dead) { const p = b.bot.body.translation(); b.x = p.x; b.y = p.y; }
    }
    this.bubbles = this.bubbles.filter((b) => b.ttl > 0);

    if (this.gpu) {
      if (this.time >= this.emitterAt) { this.emitterAt = this.time + 0.25; this.gpu.setEmitters(this.emitters()); }
      this.gpu.update(dt);
      if (this.time >= this.readbackAt) { this.readbackAt = this.time + 0.5; void this.gpu.readback(); }
    }
  }

  /** GPU emitters: world features in loaded chunks (nearest the view first), plus live sources. */
  private emitters(): EmitterDef[] {
    const v = this.view;
    const list = this.layout.emitters
      .filter((e) => this.terrain.isLoadedCell(Math.floor(e.x), Math.floor(e.y)))
      .sort((a, b) => Math.hypot(a.x * CELL - v.x, a.y * CELL - v.y) - Math.hypot(b.x * CELL - v.x, b.y * CELL - v.y))
      .slice(0, MAX_EMITTERS - 1);
    const t = this.layout.terrarium;
    const alive = this.critters.filter((c) => !c.dead).length;
    list.push({ x: t.x / CELL, y: (t.y + 0.6) / CELL, radius: 7, type: Emit.Oxygen, rate: -0.0012 * alive });
    return list;
  }

  // ---------------------------------------------------------------- terrain colliders

  private rebuildColliders() {
    for (const key of this.terrain.dirtyChunks) {
      for (const c of this.chunkColliders.get(key) ?? []) this.physics.removeCollider(c, false);
      if (!this.terrain.loaded[key]) { this.chunkColliders.delete(key); continue; }
      const ci = key % CW, cj = Math.floor(key / CW);
      const colliders = chunkPolylines(this.terrain, ci, cj).map((line) =>
        this.physics.createCollider(
          RAPIER.ColliderDesc.polyline(new Float32Array(line)).setFriction(0.6).setCollisionGroups(groups(G_TERRAIN, G_BOT | G_DEBRIS)),
          this.terrainBody,
        ),
      );
      this.chunkColliders.set(key, colliders);
    }
    this.terrain.dirtyChunks.clear();
  }

  // ---------------------------------------------------------------- structural integrity

  private checkCollapses(region: { i0: number; j0: number; i1: number; j1: number }) {
    this.queueCollapses(findCollapses(this.terrain, region));
  }

  /**
   * New unsupported islands start cracking rather than falling at once, giving the player
   * COLLAPSE_DELAY seconds to brace them. Islands that grow out of an existing warning join it
   * and keep its deadline. Crumbs too small to matter fall straight away.
   */
  private queueCollapses(islands: number[][]) {
    const owner = new Map<number, PendingCollapse>();
    for (const p of this.pendingCollapses) for (const k of p.cells) owner.set(k, p);
    const taken = new Set<number>();
    for (const island of islands) {
      const fresh = island.filter((k) => !owner.has(k) && !taken.has(k));
      fresh.forEach((k) => taken.add(k));
      if (!fresh.length) continue;
      const joined = island.map((k) => owner.get(k)).find((p) => p !== undefined);
      if (joined) {
        joined.cells.push(...fresh);
        this.setCracking(fresh, joined.start);
        continue;
      }
      if (fresh.length < MIN_WARNED_COLLAPSE) { this.detach(fresh); continue; }
      const p: PendingCollapse = { id: nextId++, cells: fresh, start: this.time, due: this.time + COLLAPSE_DELAY, x: 0, y: 0 };
      this.centre(p);
      this.pendingCollapses.push(p);
      this.setCracking(fresh, p.start);
      // Cracking rock is never hidden: lift the fog around it.
      this.reveal(p.x, p.y, 2.5);
      creak(1);
      alarm();
      this.warn(`Cave-in warning! ${fresh.length} cells of rock are cracking. Brace them with struts within ${COLLAPSE_DELAY}s.`);
    }
  }

  /** Record (or with start = null, clear) the crack start time the terrain shader animates from. */
  private setCracking(cells: number[], start: number | null) {
    const marks = this.terrain.digMark;
    const stamp = start === null ? 0 : (Math.round(start * 10) + 1) << CRACK_SHIFT;
    for (const k of cells) marks[k] = (marks[k] & ((1 << CRACK_SHIFT) - 1)) | stamp;
    this.terrain.touchCells(cells);
  }

  private centre(p: PendingCollapse) {
    p.x = p.cells.reduce((s, k) => s + cellCenter(k % W), 0) / p.cells.length;
    p.y = p.cells.reduce((s, k) => s + cellCenter((k / W) | 0), 0) / p.cells.length;
  }

  /**
   * Cracking rock sheds dust and creaks. A few times a second the structure is re-evaluated:
   * cells that are now supported (a strut went in, or the drones dug them out) stop cracking,
   * and whatever is still unsupported at the deadline falls.
   */
  private updatePendingCollapses(dt: number) {
    const pending = this.pendingCollapses;
    if (!pending.length) return;
    const t = this.terrain;
    for (const p of pending) {
      const urgency = (this.time - p.start) / COLLAPSE_DELAY;
      if (Math.random() < dt * (3 + urgency * 12)) {
        const k = p.cells[Math.floor(Math.random() * p.cells.length)];
        this.gpu?.burst(cellCenter(k % W), cellCenter((k / W) | 0) - CELL * 0.5, 3 + urgency * 6, t.material[k], 0.4, 0.1);
      }
      if (Math.random() < dt * (0.3 + urgency)) creak(0.4 + urgency);
    }
    if (this.time < this.pendingCheckAt && !pending.some((p) => p.due <= this.time)) return;
    this.pendingCheckAt = this.time + 0.4;

    let i0 = W, j0 = H, i1 = 0, j1 = 0;
    for (const p of pending) for (const k of p.cells) {
      const i = k % W, j = (k / W) | 0;
      i0 = Math.min(i0, i); j0 = Math.min(j0, j); i1 = Math.max(i1, i); j1 = Math.max(j1, j);
    }
    const islands = findCollapses(t, { i0, j0, i1, j1 });
    const unsupported = new Set(islands.flat());
    for (const p of [...pending]) {
      const still = p.cells.filter((k) => t.density[k] > 0.5 && unsupported.has(k));
      const keep = new Set(still);
      const safe = p.cells.filter((k) => !keep.has(k));
      if (safe.length) this.setCracking(safe, null);
      p.cells = still;
      if (still.length < 4) {
        this.pendingCollapses = this.pendingCollapses.filter((o) => o !== p);
        this.setCracking(still, null);
        this.info('The cracking has stopped. The rock is holding.');
      } else if (this.time >= p.due) {
        this.pendingCollapses = this.pendingCollapses.filter((o) => o !== p);
        this.collapse(still);
      } else {
        this.centre(p);
      }
    }
    this.queueCollapses(islands);
  }

  private collapse(cells: number[]) {
    const c = this.detach(cells);
    rumble(Math.min(3, cells.length / 40));
    this.shake = Math.min(1.2, 0.2 + cells.length / 150);
    this.warn(`Cave-in! ${cells.length} cells of unsupported rock came loose.`);
    this.caveIns.push({ time: this.time, x: c.x, y: c.y, checked: false, botIds: this.bots.filter((b) => !b.dead && dist(b.body.translation(), c) < 6).map((b) => b.id) });
  }

  /** Remove cells from the grid and turn them into a falling rigidbody (or dust if tiny). */
  private detach(cells: number[]): Vec {
    const t = this.terrain;
    let sx = 0, sy = 0;
    const items = cells.map((k) => {
      const x = cellCenter(k % W), y = cellCenter((k / W) | 0);
      sx += x; sy += y;
      return { x, y, mat: t.material[k] };
    });
    const c = { x: sx / cells.length, y: sy / cells.length };
    for (const k of cells) { this.marked.delete(k); this.claims.delete(k); }
    t.clearCells(cells);
    if (cells.length < 4) {
      this.gpu?.burst(c.x, c.y, cells.length * 12, items[0].mat, 1.5, 0.2);
      return c;
    }
    const body = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(c.x, c.y).setCcdEnabled(true).setAngularDamping(0.4)
        .setAngvel((Math.random() - 0.5) * 0.6),
    );
    // Big islands use 2x2 blocks to keep the collider count reasonable.
    const block = cells.length > 160 ? 2 : 1;
    const blocks = new Map<string, Vec>();
    for (const it of items) {
      const bx = Math.floor(it.x / (CELL * block)), by = Math.floor(it.y / (CELL * block));
      blocks.set(`${bx},${by}`, { x: (bx + 0.5) * CELL * block, y: (by + 0.5) * CELL * block });
    }
    const half = (CELL * block) / 2 * 0.96;
    for (const p of blocks.values()) {
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(half, half).setTranslation(p.x - c.x, p.y - c.y).setDensity(2.5).setFriction(0.7)
          .setCollisionGroups(groups(G_DEBRIS, G_TERRAIN | G_BOT | G_DEBRIS)),
        body,
      );
    }
    this.debris.push({ id: nextId++, body, cells: items.map((it) => ({ x: it.x - c.x, y: it.y - c.y, mat: it.mat })), restTime: 0, prevSpeed: 0, age: 0, removed: false });
    this.entityVersion++;
    return c;
  }

  private updateDebris(dt: number) {
    for (const d of [...this.debris]) {
      d.age += dt;
      const v = d.body.linvel();
      const speed = Math.hypot(v.x, v.y);
      const p = d.body.translation();
      if (d.prevSpeed > 2.5 && d.prevSpeed - speed > 2) this.impact(d, d.prevSpeed);
      if (!this.debris.includes(d)) continue;
      d.prevSpeed = speed;
      if (p.y < -2) { this.removeDebris(d); continue; }
      // Resting (or just jittering in place on a slope) rubble merges back into the terrain.
      if (speed < 0.3 && Math.abs(d.body.angvel()) < 0.4) d.restTime += dt; else d.restTime = 0;
      if (d.restTime > 0.8 || d.age > 12) this.settle(d);
    }
  }

  private impact(d: Debris, speed: number) {
    const p = d.body.translation();
    const n = d.cells.length;
    const radius = Math.sqrt(n) * CELL * 0.6;
    const mat = dominantMaterial(d);
    this.gpu?.burst(p.x, p.y - radius * 0.5, Math.min(260, n * 4), mat, speed * 0.5, radius);
    rumble(Math.min(2, n / 60));
    this.shake = Math.min(1.2, this.shake + n / 300);
    const energy = speed * Math.sqrt(n);
    for (const b of this.bots) {
      if (b.dead) continue;
      const bp = b.body.translation();
      if (dist(bp, p) < radius + 0.5 && bp.y < p.y + radius * 0.5) {
        b.hp -= energy * 4;
        if (b.hp <= 0) this.destroyBot(b, 'was flattened by falling rock');
      }
    }
    for (const s of [...this.smelters]) {
      if (dist({ x: s.x, y: s.y + 0.6 }, p) < radius + 0.8) {
        s.hp -= energy * 3;
        if (s.hp <= 0) this.destroySmelter(s, 'was crushed by a cave-in');
      }
    }
    if (n < 10) this.removeDebris(d, true);
  }

  private removeDebris(d: Debris, shatter = false) {
    if (shatter) {
      const p = d.body.translation();
      this.gpu?.burst(p.x, p.y, d.cells.length * 10, dominantMaterial(d), 2, 0.3);
    }
    d.removed = true;
    this.physics.removeRigidBody(d.body);
    this.debris = this.debris.filter((o) => o !== d);
    this.entityVersion++;
  }

  /** A resting chunk merges back into the terrain as loose rubble (ore stays ore). */
  private settle(d: Debris) {
    const p = d.body.translation();
    const a = d.body.rotation();
    const cos = Math.cos(a), sin = Math.sin(a);
    const botCells = new Set(this.bots.filter((b) => !b.dead).map((b) => {
      const bp = b.body.translation();
      return cellIndex(toCell(bp.x), toCell(bp.y));
    }));
    // Loose rubble piles up: stamp lowest cells first and let each one drop onto support,
    // so settling never leaves a fresh overhang that would immediately collapse again.
    const targets = d.cells.map((c) => ({
      i: toCell(p.x + c.x * cos - c.y * sin), j: toCell(p.y + c.x * sin + c.y * cos),
      mat: c.mat === Mat.Copper || c.mat === Mat.Junk ? c.mat : Mat.Rubble,
    })).sort((a, b) => a.j - b.j);
    let i0 = W, j0 = H, i1 = 0, j1 = 0;
    for (const c of targets) {
      let j = c.j;
      while (j < H - 1 && this.terrain.isSolid(c.i, j)) j++;
      while (j > 0 && this.terrain.isOpen(c.i, j - 1)) j--;
      if (botCells.has(cellIndex(c.i, j)) || !this.terrain.stamp(c.i, j, c.mat)) continue;
      i0 = Math.min(i0, c.i); j0 = Math.min(j0, j); i1 = Math.max(i1, c.i); j1 = Math.max(j1, j);
    }
    if (i0 <= i1) this.terrain.markDirty(i0, j0, i1, j1);
    this.removeDebris(d);
  }

  // ---------------------------------------------------------------- blasts & machines

  private updateBlasts(dt: number) {
    for (const b of [...this.blasts]) {
      b.fuse -= dt;
      if (b.fuse > 0) continue;
      this.blasts = this.blasts.filter((o) => o !== b);
      this.entityVersion++;
      this.terrain.carve(b.x, b.y, 1.4, 3);
      this.gpu?.burst(b.x, b.y, 300, ParticleKind.Spark, 7, 0.3);
      this.gpu?.burst(b.x, b.y, 300, Mat.Dirt, 5, 0.8);
      this.gpu?.burst(b.x, b.y, 120, ParticleKind.Steam, 1.5, 0.8);
      rumble(3);
      this.shake = 1;
      for (const bot of this.bots) {
        if (bot.dead) continue;
        const bp = bot.body.translation();
        const d = dist(bp, b);
        if (d < 3) bot.body.applyImpulse({ x: (bp.x - b.x) / d * 1.2, y: (bp.y - b.y) / d * 1.2 + 0.6 }, true);
        if (d < 1.2) { bot.hp -= 70; if (bot.hp <= 0) this.destroyBot(bot, 'stood too close to the blast'); }
      }
      for (const d of this.debris) {
        const dp = d.body.translation();
        const r = dist(dp, b);
        if (r < 3.5) d.body.applyImpulse({ x: (dp.x - b.x) / r * 4 * d.cells.length * 0.05, y: 6 * d.cells.length * 0.05 }, true);
      }
      for (const s of [...this.smelters]) if (dist(s, b) < 1.8) this.destroySmelter(s, 'was caught in a blast');
    }
  }

  private updateSmelters(dt: number) {
    for (const s of [...this.smelters]) {
      s.smeltTimer += dt;
      if (s.smeltTimer >= 2.5 && this.resources.ore >= 1) {
        s.smeltTimer = 0;
        this.resources.ore -= 1;
        this.resources.plates += 1;
        this.platesMade++;
        s.hotUntil = this.time + 4;
        this.gpu?.burst(s.x, s.y + 1.4, 12, ParticleKind.Steam, 0.6, 0.1);
        this.gpu?.burst(s.x + 0.3, s.y + 0.4, 6, ParticleKind.Flame, 1, 0.05);
      }
      const e = this.env(s.x, s.y + 0.3);
      if (e.magma > 0.3) { s.hp -= dt * 30; if (s.hp <= 0) this.destroySmelter(s, 'melted into a puddle'); }
    }
    if (!this.quotaAnnounced && this.platesMade >= QUOTA) {
      this.quotaAnnounced = true;
      this.info('QUOTA MET. Management is mildly pleased. Please continue indefinitely.');
      this.emote(this.randomBot(), 'cogAndStone');
    }
  }

  private destroySmelter(s: Smelter, cause: string) {
    if (!this.smelters.includes(s)) return;
    this.smelters = this.smelters.filter((o) => o !== s);
    this.gpu?.burst(s.x, s.y + 0.5, 200, ParticleKind.Spark, 5, 0.4);
    this.entityVersion++;
    this.warn(`Smelter ${cause}.`);
    this.onLoss();
  }

  // ---------------------------------------------------------------- critters

  private updateCritters(dt: number) {
    const t = this.layout.terrarium;
    const tick = this.time >= this.critterTickAt;
    if (tick) this.critterTickAt = this.time + 0.5;
    for (const c of this.critters) {
      if (c.dead) continue;
      c.hop += dt * (c.happy ? 6 : 14);
      c.x += c.vx * dt;
      if (Math.abs(c.x - t.x) > t.w / 2 - 0.3) { c.vx = -c.vx; c.x = Math.max(t.x - t.w / 2 + 0.3, Math.min(t.x + t.w / 2 - 0.3, c.x)); }
      // Walk on the actual floor, which curves and can be dug away or buried.
      c.y += (this.floorY(c.x, c.y) - c.y) * Math.min(1, dt * 8);
      if (Math.random() < dt * 0.3) c.vx = (Math.random() - 0.5) * (c.happy ? 0.5 : 1.4);
      if (!tick) continue;
      const e = this.env(c.x, c.y + 0.15);
      const issues: [boolean, string, number][] = [
        [e.magma > 0.05, 'is being cooked by magma', 60],
        [e.temp > 38, 'is overheating', 6],
        [e.temp < 6, 'is freezing', 3],
        [e.o2 < 0.3, 'cannot breathe', 5],
        [e.toxic > 0.15, 'is choking on toxic gas', 8],
        [e.water > 0.5, 'is drowning', 8],
      ];
      const bad = issues.filter(([cond]) => cond);
      const wasHappy = c.happy;
      c.happy = bad.length === 0;
      c.complaint = bad[0]?.[1] ?? '';
      if (c.happy) {
        c.health = Math.min(100, c.health + 1);
      } else {
        c.health -= bad.reduce((s, b) => s + b[2], 0) * 0.5;
        // Critter alerts are switched off for now; the terrarium panel still shows how they're doing.
      }
      if (c.health <= 0) {
        c.dead = true;
        this.entityVersion++;
      }
    }
  }

  // ---------------------------------------------------------------- emergent events

  private updateEvents() {
    for (const ev of this.caveIns) {
      if (ev.checked || this.time - ev.time < 3) continue;
      ev.checked = true;
      const survivors = this.bots.filter((b) => ev.botIds.includes(b.id) && !b.dead);
      if (survivors.length > 0 && survivors.length === ev.botIds.length) this.emote(survivors[0], 'cogAndStone');
    }
    this.caveIns = this.caveIns.filter((e) => this.time - e.time < 15);

    if (this.time >= this.stressAt) {
      this.stressAt = this.time + 5;
      const t = this.layout.terrarium;
      const recentCaveIn = this.caveIns.some((e) => this.time - e.time < 10);
      let alarm = recentCaveIn;
      for (let dx = -12; dx <= 12 && !alarm; dx += 3) for (let dy = -8; dy <= 8 && !alarm; dy += 3) {
        const e = this.env(t.x + dx * CELL, t.y + dy * CELL);
        if (e.magma > 0.1 || e.temp > 34 || e.toxic > 0.2) alarm = true;
      }
      if (alarm && this.time > this.stressCooldown && this.critters.some((c) => !c.dead && c.happy)) {
        this.stressCooldown = this.time + 45;
        this.emote(this.randomBot(), 'stressNominal');
      }
    }
  }

  // ---------------------------------------------------------------- dig access

  private exposed(i: number, j: number) {
    const t = this.terrain;
    return t.isOpen(i - 1, j) || t.isOpen(i + 1, j) || t.isOpen(i, j - 1) || t.isOpen(i, j + 1);
  }

  /**
   * Flags which dig orders the drones can work on. A designated cell is directly reachable when
   * it borders open space and some path node connected to the base is within laser range of it.
   * Designated rock joined to a reachable cell through other designated rock counts too, since
   * the drones will tunnel their way to it.
   */
  private updateReachability() {
    if (this.time < this.reachAt) return;
    this.reachAt = this.time + 0.5;
    const t = this.terrain, marks = t.digMark, d = this.layout.depot;
    floodNodes(t, d.x, d.y + 0.6, this.access);
    const live = (k: number) => (marks[k] & DIG_BIT) !== 0 && t.density[k] > ISO;
    const reached = new Set<number>();
    const queue: number[] = [];
    for (const k of this.marked) {
      if (!live(k)) continue;
      const i = k % W, j = (k / W) | 0;
      if (this.exposed(i, j) && nearFlooded(this.access, cellCenter(i), cellCenter(j), DRILL_REACH - 0.1)) { reached.add(k); queue.push(k); }
    }
    for (let q = 0; q < queue.length; q++) {
      const k = queue[q], i = k % W;
      for (const n of [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, k - W, k + W]) {
        if (n >= 0 && n < marks.length && !reached.has(n) && live(n)) { reached.add(n); queue.push(n); }
      }
    }
    const changed: number[] = [];
    for (const k of this.marked) {
      const want = reached.has(k) ? REACH_BIT : 0;
      if ((marks[k] & REACH_BIT) !== want) { marks[k] = (marks[k] & ~REACH_BIT) | want; changed.push(k); }
    }
    t.touchCells(changed);
  }

  // ---------------------------------------------------------------- drones

  private updateBots(dt: number) {
    if (this.intro.phase !== 'done') {
      // Riding down on their pads.
      for (const bot of this.bots) {
        const slot = this.slotOf(bot);
        bot.body.setTranslation({ x: slot.x, y: slot.y + this.intro.offset }, true);
        bot.body.setLinvel({ x: 0, y: 0 }, true);
      }
      return;
    }
    for (const bot of this.bots) {
      if (bot.dead) continue;
      const p = bot.body.translation();
      const e = this.env(p.x, p.y);

      // Bots don't breathe, but magma still melts them.
      bot.heat = Math.max(0, bot.heat + (e.magma > 0.25 || e.temp > 500 ? 45 : -15) * dt);
      if (bot.heat > 100) { this.destroyBot(bot, 'melted'); continue; }
      if ((e.o2 < 0.08 || e.toxic > 0.3) && Math.random() < dt * 0.4) {
        const critterGasping = this.critters.some((c) => !c.dead && c.complaint.includes('breathe'));
        if (critterGasping || Math.random() < 0.4) this.emote(bot, 'oxygenNotIncluded', 40);
      }

      // Battery: drains in the air (more with the laser on), charges on the pad. Low drones drop
      // what they're doing and fly home; they won't launch again until they're well charged.
      if (bot.state === 'docked') {
        bot.battery = Math.min(100, bot.battery + BATTERY.charge * dt);
        if (bot.battery >= BATTERY.launch) bot.lowBattery = false;
      } else {
        bot.battery = Math.max(0, bot.battery - (BATTERY.fly + (bot.state === 'digging' ? BATTERY.laser : 0)) * dt);
        if (bot.battery < BATTERY.low && !bot.lowBattery) {
          bot.lowBattery = true;
          this.info(`${bot.name} is low on battery and heading home to recharge.`);
          if (bot.state !== 'toDepot') this.goDepot(bot);
        }
      }

      bot.stateTimer -= dt;
      bot.drillPoint = null;
      switch (bot.state) {
        case 'salute':
        case 'tantrum':
          this.steer(bot, null, dt);
          if (bot.stateTimer <= 0) bot.state = 'idle';
          continue;
        case 'docked': this.botDocked(bot, dt); break;
        case 'idle': this.botIdle(bot); break;
        case 'toDig':
        case 'toDepot': this.botTravel(bot, dt); break;
        case 'digging': this.botDig(bot, dt); break;
      }
      if (bot.state === 'idle' || bot.state === 'digging') this.steer(bot, null, dt);

      // Carl's alcove: a solemn salute for the obsolete predecessor.
      const carl = this.layout.carl;
      if (this.time > this.carlCooldown && dist(p, carl) < 1.8 && Math.random() < dt * 0.6) {
        this.carlCooldown = this.time + 50;
        bot.state = 'salute';
        bot.stateTimer = 2.2;
        this.emote(bot, 'forCarl');
      }

      // Stuck detection drives the tantrum.
      if (this.time - bot.progressAt > 2) {
        const moving = bot.state === 'toDig' || bot.state === 'toDepot';
        bot.stuck = moving && dist(p, bot.progressPos) < 0.25 ? bot.stuck + 2 : 0;
        bot.progressPos = { x: p.x, y: p.y };
        bot.progressAt = this.time;
        if (bot.stuck >= 6) this.tantrum(bot);
      }
    }
  }

  private slotOf(bot: Bot) { return dockSlot(this.layout.depot, bot.slot); }

  /** Sitting on the pad, rotors idle. Launch straight up when there is reachable work. */
  private botDocked(bot: Bot, dt: number) {
    const slot = this.slotOf(bot);
    this.steer(bot, slot, dt, true);
    if (this.time < bot.replanAt || bot.lowBattery) return;
    bot.replanAt = this.time + 0.6 + Math.random() * 0.4;
    if (this.findWork(bot)) {
      bot.path.unshift({ x: slot.x, y: slot.y + 0.45 });
      this.gpu?.burst(slot.x, slot.y - 0.05, 14, ParticleKind.Steam, 0.8, 0.12);
    }
  }

  /** Airborne with nothing claimed: take the next job, or fly home. */
  private botIdle(bot: Bot) {
    const load = bot.cargo.ore + bot.cargo.scrap;
    if (load >= CARGO_CAP || bot.lowBattery) return this.goDepot(bot);
    if (this.time < bot.replanAt) return;
    bot.replanAt = this.time + 0.6 + Math.random() * 0.4;
    if (!this.findWork(bot)) this.goDepot(bot);
  }

  /** Claim one of the nearest exposed designated cells and plan a route to it. */
  private findWork(bot: Bot) {
    const p = bot.body.translation();
    for (const k of this.exposedTargets(p, bot).slice(0, 4)) {
      const tx = cellCenter(k % W), ty = cellCenter((k / W) | 0);
      if (dist(p, { x: tx, y: ty }) <= DRILL_REACH) { this.startDig(bot, k); return true; }
      const path = findPath(this.terrain, p.x, p.y, tx, ty, DRILL_REACH - 0.1, 40000);
      if (path) {
        this.claim(bot, k);
        // The route ends near the cell, not at it; keep closing in until the laser reaches.
        bot.path = [...path, { x: tx, y: ty }];
        bot.state = 'toDig';
        return true;
      }
      bot.blacklist.set(k, this.time + 12);
    }
    return false;
  }

  private exposedTargets(p: Vec, bot: Bot) {
    const t = this.terrain;
    const out: { k: number; d: number }[] = [];
    for (const k of this.marked) {
      if (!t.isLoadedCell(k % W, (k / W) | 0)) continue;
      if (!(t.digMark[k] & DIG_BIT) || t.density[k] <= ISO) { this.marked.delete(k); continue; }
      const owner = this.claims.get(k);
      if (owner !== undefined && owner !== bot.id) continue;
      if (!(t.digMark[k] & REACH_BIT) || (bot.blacklist.get(k) ?? 0) > this.time || this.heldForStrut(k)) continue;
      const i = k % W, j = (k / W) | 0;
      if (!this.exposed(i, j)) continue;
      out.push({ k, d: Math.hypot(cellCenter(i) - p.x, cellCenter(j) - p.y) });
    }
    return out.sort((a, b) => a.d - b.d).map((o) => o.k);
  }

  private claim(bot: Bot, k: number) {
    this.releaseClaim(bot);
    bot.target = k;
    this.claims.set(k, bot.id);
  }

  private releaseClaim(bot: Bot) {
    if (bot.target >= 0 && this.claims.get(bot.target) === bot.id) this.claims.delete(bot.target);
    bot.target = -1;
  }

  private startDig(bot: Bot, k: number) {
    this.claim(bot, k);
    bot.state = 'digging';
    bot.path = [];
  }

  /** Fly back to this drone's landing pad, where it unloads and docks. */
  private goDepot(bot: Bot) {
    const p = bot.body.translation();
    const slot = this.slotOf(bot);
    this.releaseClaim(bot);
    const path = findPath(this.terrain, p.x, p.y, slot.x, slot.y, 0.6, 40000);
    if (path) { bot.path = [...path, slot]; bot.state = 'toDepot'; } else { bot.state = 'idle'; bot.replanAt = this.time + 2; }
  }

  private botTravel(bot: Bot, dt: number) {
    const p = bot.body.translation();
    if (bot.state === 'toDig') {
      const k = bot.target;
      if (k < 0 || this.terrain.density[k] <= ISO) { this.releaseClaim(bot); bot.state = 'idle'; return; }
      const target = { x: cellCenter(k % W), y: cellCenter((k / W) | 0) };
      if (dist(p, target) <= DRILL_REACH) return this.startDig(bot, k);
    }
    // Replan periodically: the terrain changes under everyone's feet.
    if (this.time >= bot.replanAt) {
      bot.replanAt = this.time + 3;
      const slot = this.slotOf(bot);
      const goal = bot.state === 'toDig'
        ? { x: cellCenter(bot.target % W), y: cellCenter((bot.target / W) | 0), r: DRILL_REACH - 0.1 }
        : { ...slot, r: 0.6 };
      const path = findPath(this.terrain, p.x, p.y, goal.x, goal.y, goal.r, 40000);
      if (path) bot.path = [...path, bot.state === 'toDepot' ? slot : goal];
    }
    while (bot.path.length && dist(p, bot.path[0]) < 0.3) bot.path.shift();
    if (!bot.path.length) {
      if (bot.state === 'toDepot') this.unload(bot);
      else bot.state = 'idle';
      this.steer(bot, null, dt);
      return;
    }
    this.steer(bot, bot.path[0], dt, bot.path.length === 1);
  }

  private botDig(bot: Bot, dt: number) {
    const t = this.terrain;
    const p = bot.body.translation();
    let k = bot.target;
    if (k < 0 || t.density[k] <= ISO) {
      // Continue on the next designated cell within reach, if any.
      const next = this.exposedTargets(p, bot).find((n) => dist(p, { x: cellCenter(n % W), y: cellCenter((n / W) | 0) }) <= DRILL_REACH);
      this.releaseClaim(bot);
      if (next === undefined || bot.cargo.ore + bot.cargo.scrap >= CARGO_CAP) { bot.state = 'idle'; return; }
      this.claim(bot, next);
      k = next;
    }
    const x = cellCenter(k % W), y = cellCenter((k / W) | 0);
    bot.facing = x >= p.x ? 1 : -1;
    bot.drillPoint = { x, y };
    const hardness = t.hardness(k);
    const yields: Yield = t.carve(x, y, 0.3, (dt * DRILL_RATE) / hardness);
    for (const [m, amount] of Object.entries(yields)) {
      const def = MATERIALS[Number(m)];
      bot.cargo.ore += (def.yields.ore ?? 0) * amount;
      bot.cargo.scrap += (def.yields.scrap ?? 0) * amount;
    }
    if (y < this.deepestY - 4) {
      this.deepestY = y;
      this.info(`New excavation depth: ${((this.layout.surfaceRow * CELL - y)).toFixed(0)}m below the surface.`);
      this.emote(bot, 'quarryMustGrow', 30);
    }
    bot.drillFx -= dt;
    if (bot.drillFx <= 0 && this.gpu) {
      bot.drillFx = 0.08;
      const m = t.material[k];
      this.gpu.burst(x, y, 4, m === Mat.Air ? Mat.Dirt : m, 2, 0.08);
      if (hardness > 1.4) this.gpu.burst(x, y, 2, ParticleKind.Spark, 3.5, 0.05);
    }
    if (bot.cargo.ore + bot.cargo.scrap >= CARGO_CAP && t.density[k] <= ISO + 0.2) this.goDepot(bot);
  }

  private unload(bot: Bot) {
    const ore = Math.floor(bot.cargo.ore * 10) / 10;
    this.resources.ore += bot.cargo.ore;
    this.oreDelivered += bot.cargo.ore;
    this.resources.scrap += bot.cargo.scrap;
    if (ore >= 1) this.oreDeliveries.push(this.time);
    this.oreDeliveries = this.oreDeliveries.filter((t) => this.time - t < 60);
    if (ore >= 3 && this.time > this.cogCooldown) { this.cogCooldown = this.time + 25; this.emote(bot, 'cogAndStone'); }
    bot.cargo = { ore: 0, scrap: 0 };
    bot.state = 'docked';
    bot.replanAt = this.time + 0.5;
  }

  private tantrum(bot: Bot) {
    bot.stuck = 0;
    if (bot.target >= 0) bot.blacklist.set(bot.target, this.time + 20);
    this.releaseClaim(bot);
    bot.path = [];
    bot.state = 'tantrum';
    bot.stateTimer = 1.6;
    this.emote(bot, 'tantrum');
    const p = bot.body.translation();
    // Kick the nearest boulder, or failing that, the wall.
    const boulder = this.debris.map((d) => ({ d, r: dist(d.body.translation(), p) })).sort((a, b) => a.r - b.r)[0];
    if (boulder && boulder.r < 2.5) {
      const bp = boulder.d.body.translation();
      const m = boulder.d.body.mass();
      boulder.d.body.applyImpulse({ x: Math.sign(bp.x - p.x || 1) * m * 3, y: m * 2 }, true);
    } else {
      this.terrain.carve(p.x + bot.facing * 0.35, p.y, 0.3, 0.7);
      this.gpu?.burst(p.x + bot.facing * 0.35, p.y, 20, Mat.Dirt, 2.5, 0.1);
    }
  }

  /** Rotor controller: chase a waypoint, or hover in place when target is null. */
  private steer(bot: Bot, target: Vec | null, dt: number, arrive = false) {
    const body = bot.body;
    const p = body.translation();
    const v = body.linvel();
    let desired = { x: 0, y: 0 };
    if (target) {
      const dx = target.x - p.x, dy = target.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      // A flat battery leaves just enough to limp home.
      const top = bot.battery > 0 ? BOT_SPEED : BOT_SPEED * 0.35;
      const speed = arrive ? Math.min(top, d * 3) : top;
      desired = { x: (dx / d) * speed, y: (dy / d) * speed };
      if (Math.abs(dx) > 0.05) bot.facing = Math.sign(dx);
    }
    const k = Math.min(1, dt * 7);
    body.setLinvel({ x: v.x + (desired.x - v.x) * k, y: v.y + (desired.y - v.y) * k }, true);
  }
}

function dist(a: Vec, b: Vec) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function dominantMaterial(d: Debris) {
  const counts = new Map<number, number>();
  for (const c of d.cells) counts.set(c.mat, (counts.get(c.mat) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

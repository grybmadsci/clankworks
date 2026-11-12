import RAPIER from '@dimforge/rapier2d-compat';
import type { WebGPURenderer } from 'three/webgpu';
import { CELL, CHUNK, COLLAPSE_DELAY, CRACK_SHIFT, DIG_BIT, Emit, REACH_BIT, H, ISO, Mat, MATERIALS, SKY_ROWS, W, cellCenter, cellIndex, toCell } from '../config';
import { GpuSim, ParticleKind } from '../gpu/GpuSim';
import { chunkPolylines } from '../sim/contours';
import { findCollapses } from '../sim/integrity';
import { GH, GW, findPath, floodNodes, nearFlooded } from '../sim/pathfind';
import type { Terrain, Yield } from '../sim/terrain';
import { EmitterDef, WorldLayout, generateWorld } from '../sim/worldgen';
import { chirp, creak, rumble } from './audio';
import { DIG_RADIUS, DOCK_SLOTS, digCenter, dockSlot } from './base';
import { EMOTES, EmoteId } from './emotes';

export type Tool = 'dig' | 'cancel' | 'strut' | 'smelter' | 'blast';
type Vec = { x: number; y: number };

const BOT_RADIUS = 0.14;
const BOT_SPEED = 3;
const DRILL_RATE = 3.2;
/** Mining-laser range. */
const DRILL_REACH = 1.2;
const CARGO_CAP = 6;
const QUOTA = 30;
/** Collapses smaller than this crumble at once instead of cracking first. */
const MIN_WARNED_COLLAPSE = 8;

const COST = {
  strut: { scrap: 2 },
  smelter: { scrap: 8 },
  blast: { scrap: 1 },
  bot: { plates: 3, goo: 2 },
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

export interface Strut { id: number; i: number; j0: number; j1: number }
export interface Smelter { id: number; x: number; y: number; hp: number; smeltTimer: number; hotUntil: number }
export interface Blast { id: number; x: number; y: number; fuse: number }
export interface Critter { id: number; name: string; x: number; y: number; vx: number; health: number; happy: boolean; complaint: string; hop: number; dead: boolean }
export interface Bubble { id: number; text: string; bot?: Bot; x: number; y: number; ttl: number }
export interface LogEntry { id: number; time: number; text: string; kind: 'emote' | 'info' | 'warn' }
/** Unsupported rock that is cracking and will fall at `due` unless it gets braced first. */
export interface PendingCollapse { id: number; cells: number[]; start: number; due: number; x: number; y: number }

export interface Env { water: number; magma: number; o2: number; toxic: number; temp: number }

let nextId = 1;

export class Game {
  readonly layout: WorldLayout;
  readonly terrain: Terrain;
  readonly physics: RAPIER.World;
  gpu: GpuSim | null = null;

  time = 0;
  frames = 0;
  resources = { ore: 0, scrap: 14, plates: 3, goo: 2 };
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
  /** Incremented whenever entity lists change, so React can re-render the lists. */
  entityVersion = 0;
  shake = 0;
  tool: Tool = 'dig';
  overlay: 0 | 1 | 2 = 0;

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

  static async create(seed?: number) {
    await RAPIER.init();
    return new Game(generateWorld(seed));
  }

  private constructor(layout: WorldLayout) {
    this.layout = layout;
    this.terrain = layout.terrain;
    this.physics = new RAPIER.World({ x: 0, y: -9.81 });
    this.terrainBody = this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    for (let cj = 0; cj * CHUNK < H; cj++) for (let ci = 0; ci * CHUNK < W; ci++) this.terrain.dirtyChunks.add(cj * 1000 + ci);
    this.rebuildColliders();
    this.terrain.structuralDirty = null;
    this.deepestY = layout.depot.y;

    for (let n = 0; n < 3; n++) this.spawnBot(false);
    for (let n = 0; n < 4; n++) {
      const t = layout.terrarium;
      this.critters.push({
        id: nextId++, name: ['Mossbert', 'Pudding', 'Sir Squish', 'Lumen'][n],
        x: t.x + (n - 1.5) * 0.6, y: this.floorY(t.x + (n - 1.5) * 0.6, t.y), vx: (Math.random() - 0.5) * 0.4, health: 100, happy: true, complaint: '', hop: Math.random() * 6, dead: false,
      });
    }
    // The base cavern struts from worldgen become real struts.
    for (const i of [56, 72]) {
      let j0 = -1, j1 = -1;
      for (let j = 0; j < H; j++) if (this.terrain.strut[cellIndex(i, j)]) { if (j0 < 0) j0 = j; j1 = j; }
      if (j0 >= 0) this.struts.push({ id: nextId++, i, j0, j1 });
    }
    this.info('Shift started. Designate rock near the base and the drones will mine it. Oxygen is strictly optional.');
    this.info(`Quarterly quota: ${QUOTA} copper plates. Management believes in you, statistically.`);
  }

  attachGpu(renderer: WebGPURenderer) {
    this.gpu = new GpuSim(renderer, this.terrain, this.layout.fluid, this.layout.temperature);
    this.gpu.setEmitters(this.emitters());
  }

  // ---------------------------------------------------------------- environment queries

  env(x: number, y: number): Env {
    const i = Math.min(W - 1, Math.max(0, toCell(x))), j = Math.min(H - 1, Math.max(0, toCell(y)));
    const k = cellIndex(i, j);
    const f = this.gpu?.fluidSnapshot ?? this.layout.fluid;
    const t = this.gpu?.tempSnapshot ?? this.layout.temperature;
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
    switch (this.tool) {
      case 'dig': this.designate(x, y, 0.7, true); break;
      case 'cancel': this.designate(x, y, 0.9, false); break;
      case 'strut': if (!drag) this.placeStrut(x, y); break;
      case 'smelter': if (!drag) this.placeSmelter(x, y); break;
      case 'blast': if (!drag) this.placeBlast(x, y); break;
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
    if (changed) { this.terrain.gpuDirty = true; this.reachAt = 0; }
    if (outOfRange && !changed && this.time >= this.rangeWarnAt) {
      this.rangeWarnAt = this.time + 3;
      this.warn(`Out of drone range. Dig orders must be within ${DIG_RADIUS}m of the base.`);
    }
  }

  placeStrut(x: number, y: number) {
    const t = this.terrain;
    const i = toCell(x);
    let j = toCell(y);
    if (!t.isOpen(i, j)) return this.warn('Struts must be placed in open space.');
    let j0 = j, j1 = j;
    while (j0 > 0 && t.isOpen(i, j0 - 1) && j - j0 < 48) j0--;
    while (j1 < H - 1 && t.isOpen(i, j1 + 1) && j1 - j < 48) j1++;
    if (!t.isSolid(i, j0 - 1) || !t.isSolid(i, j1 + 1) || j1 >= H - SKY_ROWS - 1) return this.warn('A strut needs both a floor and a ceiling within 12m.');
    if (!this.pay(COST.strut)) return this.warn('Insufficient scrap for a strut (2).');
    for (j = j0; j <= j1; j++) t.strut[cellIndex(i, j)] = 1;
    this.struts.push({ id: nextId++, i, j0, j1 });
    // A strut may have saved cracking rock; re-evaluate straight away.
    this.pendingCheckAt = 0;
    this.entityVersion++;
    this.info(`Steel strut installed (${((j1 - j0 + 1) * CELL).toFixed(1)}m).`);
  }

  placeSmelter(x: number, y: number) {
    const t = this.terrain;
    const i = toCell(x);
    let j = toCell(y);
    if (!t.isOpen(i, j)) return this.warn('Smelters must be placed in open space.');
    while (j > 0 && t.isOpen(i, j - 1)) j--;
    for (let dj = 0; dj < 5; dj++) for (let di = -2; di <= 2; di++) {
      if (!t.isOpen(i + di, j + dj)) return this.warn('Not enough room for a smelter (needs 1.25m × 1.25m).');
    }
    if (!this.pay(COST.smelter)) return this.warn('Insufficient scrap for a smelter (8).');
    this.smelters.push({ id: nextId++, x: cellCenter(i), y: j * CELL, hp: 100, smeltTimer: 0, hotUntil: 0 });
    this.entityVersion++;
    this.info('Smelter online. It runs hot. Keep it away from anything that breathes.');
    this.emote(this.randomBot(), 'quarryMustGrow');
  }

  placeBlast(x: number, y: number) {
    if (!this.pay(COST.blast)) return this.warn('Insufficient scrap for a blast charge (1).');
    this.blasts.push({ id: nextId++, x, y, fuse: 2.5 });
    this.entityVersion++;
  }

  buildBot() {
    if (this.bots.filter((b) => !b.dead).length >= DOCK_SLOTS) return this.warn('Every landing pad is taken.');
    if (!this.pay(COST.bot)) return this.warn('A new drone needs 3 plates and 2 critter goo.');
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
      slot, body, hp: 100, heat: 0, cargo: { ore: 0, scrap: 0 }, state: 'docked', target: -1, path: [], replanAt: 0,
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
      if (this.time >= this.readbackAt) { this.readbackAt = this.time + 0.3; void this.gpu.readback(); }
    }
  }

  private emitters(): EmitterDef[] {
    const list = [...this.layout.emitters];
    const t = this.layout.terrarium;
    const alive = this.critters.filter((c) => !c.dead).length;
    list.push({ x: t.x / CELL, y: (t.y + 0.6) / CELL, radius: 7, type: Emit.Oxygen, rate: -0.0012 * alive });
    for (const s of this.smelters) {
      if (this.time < s.hotUntil) list.push({ x: s.x / CELL, y: s.y / CELL + 2, radius: 7, type: Emit.Heat, rate: 420 });
    }
    return list;
  }

  // ---------------------------------------------------------------- terrain colliders

  private rebuildColliders() {
    for (const key of this.terrain.dirtyChunks) {
      for (const c of this.chunkColliders.get(key) ?? []) this.physics.removeCollider(c, false);
      const cj = Math.floor(key / 1000), ci = key % 1000;
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
      creak(1);
      this.warn(`Cave-in warning! ${fresh.length} cells of rock are cracking. Brace them with struts within ${COLLAPSE_DELAY}s.`);
    }
  }

  /** Record (or with start = null, clear) the crack start time the terrain shader animates from. */
  private setCracking(cells: number[], start: number | null) {
    const marks = this.terrain.digMark;
    const stamp = start === null ? 0 : (Math.round(start * 10) + 1) << CRACK_SHIFT;
    for (const k of cells) marks[k] = (marks[k] & ((1 << CRACK_SHIFT) - 1)) | stamp;
    this.terrain.gpuDirty = true;
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
        this.resources.goo += 0.02;
      } else {
        c.health -= bad.reduce((s, b) => s + b[2], 0) * 0.5;
        if (wasHappy) this.warn(`Critter ${c.name} ${c.complaint}!`);
      }
      if (c.health <= 0) {
        c.dead = true;
        this.warn(`Critter ${c.name} has expired. A memo has been filed.`);
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
    let changed = false;
    for (const k of this.marked) {
      const want = reached.has(k) ? REACH_BIT : 0;
      if ((marks[k] & REACH_BIT) !== want) { marks[k] = (marks[k] & ~REACH_BIT) | want; changed = true; }
    }
    if (changed) t.gpuDirty = true;
  }

  // ---------------------------------------------------------------- drones

  private updateBots(dt: number) {
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
    if (this.time < bot.replanAt) return;
    bot.replanAt = this.time + 0.6 + Math.random() * 0.4;
    if (this.findWork(bot)) {
      bot.path.unshift({ x: slot.x, y: slot.y + 0.45 });
      this.gpu?.burst(slot.x, slot.y - 0.05, 14, ParticleKind.Steam, 0.8, 0.12);
    }
  }

  /** Airborne with nothing claimed: take the next job, or fly home. */
  private botIdle(bot: Bot) {
    const load = bot.cargo.ore + bot.cargo.scrap;
    if (load >= CARGO_CAP) return this.goDepot(bot);
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
      const path = findPath(this.terrain, p.x, p.y, tx, ty, DRILL_REACH - 0.1, 12000);
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
      if (!(t.digMark[k] & DIG_BIT) || t.density[k] <= ISO) { this.marked.delete(k); continue; }
      const owner = this.claims.get(k);
      if (owner !== undefined && owner !== bot.id) continue;
      if (!(t.digMark[k] & REACH_BIT) || (bot.blacklist.get(k) ?? 0) > this.time) continue;
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
    const path = findPath(this.terrain, p.x, p.y, slot.x, slot.y, 0.6, 12000);
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
      const path = findPath(this.terrain, p.x, p.y, goal.x, goal.y, goal.r, 12000);
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
      const speed = arrive ? Math.min(BOT_SPEED, d * 3) : BOT_SPEED;
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

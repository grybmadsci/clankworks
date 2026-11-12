import type { WebGPURenderer } from 'three/webgpu';
import { IndirectStorageBufferAttribute, StorageInstancedBufferAttribute } from 'three/webgpu';
import { instanceIndex, storage, uniform } from 'three/tsl';
import { enabled } from '../debug';
import { CHUNK_CELLS, MAX_ACTIVE, MAX_BURSTS, MAX_EMITTERS, MAX_PARTICLES, W } from '../config';
import type { EmitterDef } from '../sim/worldgen';
import type { Rect, Terrain } from '../sim/terrain';
import { MESH_CAPACITY, SLOT_CAP, fluidStep, meshBegin, meshCell, meshEnd, particleSpawn, particleStep, thermalStep } from './kernels';

const STEP = 1 / 120;
const FREE = 0xffffffff;

export const enum ParticleKind {
  // Above the material ids (bursts of rock dust use the material id as their kind).
  Spark = 16,
  Steam = 17,
  Flame = 18,
}

// TSL node types are very loose in @types/three; keep the GPU boundary untyped.
type Node = any;

const ITEM_SIZE = { float: 1, uint: 1, vec4: 4 } as const;

/**
 * A GPU storage buffer. `toReadOnly()` on a TSL storage node mutates that node, so every use
 * gets its own node over the shared attribute: `rw()` for kernels that write, `ro()` otherwise.
 */
export class Buf {
  readonly attr: StorageInstancedBufferAttribute;
  constructor(data: Float32Array | Uint32Array | number, readonly type: keyof typeof ITEM_SIZE) {
    const size = ITEM_SIZE[type];
    this.attr = typeof data === 'number'
      ? new StorageInstancedBufferAttribute(new (type === 'uint' ? Uint32Array : Float32Array)(data * size), size)
      : new StorageInstancedBufferAttribute(data, size);
  }
  rw(): Node { return storage(this.attr, this.type, this.attr.count); }
  ro(): Node { return this.rw().toReadOnly(); }
  upload() { this.attr.needsUpdate = true; }
}

/** Row ranges covering a set of rectangles, merged per row: [start cell, count] pairs. */
function rowRanges(rects: Rect[]) {
  const rows = new Map<number, [number, number]>();
  for (const r of rects) for (let j = r.j0; j <= r.j1; j++) {
    const cur = rows.get(j);
    rows.set(j, cur ? [Math.min(cur[0], r.i0), Math.max(cur[1], r.i1)] : [r.i0, r.i1]);
  }
  return [...rows].map(([j, [a, b]]) => [j * W + a, b - a + 1] as const);
}

/**
 * Owns every GPU-resident simulation buffer and the compute dispatches that advance them.
 * Buffers cover the whole world, but fluids and heat are only stepped in active chunks, and the
 * terrain mesh only exists for them: each active chunk has a slot in the vertex buffer and its
 * own indirect draw args. Terrain is mirrored from the CPU (which stays authoritative for
 * physics) by uploading just the rows that changed; fluids, heat, the mesh and particles live on
 * the GPU and are read back occasionally for gameplay checks and for saving chunks.
 */
export class GpuSim {
  readonly solid: Buf;
  readonly mat: Buf;
  readonly digMark: Buf;
  readonly fluid: [Buf, Buf];
  readonly temp: [Buf, Buf];
  readonly meshPos: Buf;
  /** Per-slot indirect draw arguments for the terrain mesh, written entirely on the GPU. */
  readonly meshDrawArgs: IndirectStorageBufferAttribute;
  readonly pPos: Buf;
  readonly pVel: Buf;

  private readonly emitData = new Float32Array(MAX_EMITTERS * 8);
  private readonly emit: Buf;
  private readonly nEmit = uniform(0, 'uint');
  private readonly burstData = new Float32Array(MAX_BURSTS * 8);
  private readonly bursts: Buf;
  private readonly nBursts = uniform(0, 'uint');
  private readonly seed = uniform(0, 'float');
  private readonly dt = uniform(1 / 60, 'float');
  private burstCount = 0;
  private particleHead = 0;
  private accumulator = 0;

  /** Chunk ids of the active chunks, packed; the fluid and heat steps run over these. */
  private readonly simList = new Buf(new Uint32Array(MAX_ACTIVE), 'uint');
  private simCount = 0;
  /** Chunk id held by each mesh slot (0xffffffff when free), and the slots to rebuild. */
  private readonly slotChunkData = new Uint32Array(MAX_ACTIVE).fill(FREE);
  private readonly slotChunk = new Buf(this.slotChunkData, 'uint');
  private readonly dirtySlots = new Buf(new Uint32Array(MAX_ACTIVE), 'uint');
  private readonly pendingSlots = new Set<number>();
  private readonly chunkSlot = new Map<number, number>();

  readonly stepNodes: Node[];
  readonly meshNodes: Node[];
  readonly spawnNode: Node;
  readonly particleNode: Node;

  /** Latest CPU snapshot of the fluid/temperature fields (refreshed by readback()). */
  fluidSnapshot: Float32Array;
  tempSnapshot: Float32Array;
  private reading = false;

  constructor(readonly renderer: WebGPURenderer, private readonly terrain: Terrain, fluid0: Float32Array, temp0: Float32Array) {
    this.solid = new Buf(terrain.density, 'float');
    this.mat = new Buf(terrain.material, 'uint');
    this.digMark = new Buf(terrain.digMark, 'uint');
    this.fluid = [new Buf(fluid0, 'vec4'), new Buf(new Float32Array(fluid0), 'vec4')];
    this.temp = [new Buf(temp0, 'float'), new Buf(new Float32Array(temp0), 'float')];
    this.meshPos = new Buf(MESH_CAPACITY, 'vec4');
    const args = new Uint32Array(MAX_ACTIVE * 4);
    for (let s = 0; s < MAX_ACTIVE; s++) args.set([0, 1, s * SLOT_CAP, 0], s * 4);
    this.meshDrawArgs = new IndirectStorageBufferAttribute(args, 1);
    this.pPos = new Buf(MAX_PARTICLES, 'vec4');
    this.pVel = new Buf(MAX_PARTICLES, 'vec4');
    this.emit = new Buf(this.emitData, 'vec4');
    this.bursts = new Buf(this.burstData, 'vec4');
    this.fluidSnapshot = new Float32Array(fluid0);
    this.tempSnapshot = new Float32Array(temp0);

    const fluidStepNode = (a: number, b: number) =>
      fluidStep({ src: this.fluid[a].ro(), dst: this.fluid[b].rw(), solid: this.solid.ro(), temp: this.temp[a].ro(), emit: this.emit.ro(), chunks: this.simList.ro(), tid: instanceIndex, nEmit: this.nEmit }).compute(CHUNK_CELLS, [64]);
    const thermalStepNode = (a: number, b: number) =>
      thermalStep({ src: this.temp[a].ro(), dst: this.temp[b].rw(), fluid: this.fluid[b].ro(), solid: this.solid.ro(), mat: this.mat.ro(), emit: this.emit.ro(), chunks: this.simList.ro(), tid: instanceIndex, nEmit: this.nEmit }).compute(CHUNK_CELLS, [64]);
    // A→B then B→A, so buffer 0 always holds the current state between frames.
    this.stepNodes = [fluidStepNode(0, 1), thermalStepNode(0, 1), fluidStepNode(1, 0), thermalStepNode(1, 0)];
    const drawArgs = () => storage(this.meshDrawArgs, 'uint', MAX_ACTIVE * 4).toAtomic();
    this.meshNodes = [
      meshBegin({ drawArgs: drawArgs(), dirty: this.dirtySlots.ro(), tid: instanceIndex }).compute(1),
      meshCell({ solid: this.solid.ro(), mat: this.mat.ro(), outPos: this.meshPos.rw(), drawArgs: drawArgs(), slotChunk: this.slotChunk.ro(), dirty: this.dirtySlots.ro(), tid: instanceIndex }).compute(CHUNK_CELLS, [64]),
      meshEnd({ drawArgs: drawArgs(), dirty: this.dirtySlots.ro(), tid: instanceIndex }).compute(1),
    ];
    this.spawnNode = particleSpawn({ pos: this.pPos.rw(), vel: this.pVel.rw(), bursts: this.bursts.ro(), idx: instanceIndex, nBursts: this.nBursts, seed: this.seed }).compute(MAX_PARTICLES, [64]);
    this.particleNode = particleStep({ pos: this.pPos.rw(), vel: this.pVel.rw(), solid: this.solid.ro(), idx: instanceIndex, dt: this.dt }).compute(MAX_PARTICLES, [64]);
  }

  /** Byte offsets of every slot's draw args, for geometry.setIndirect. */
  get slotOffsets() { return Array.from({ length: MAX_ACTIVE }, (_, s) => s * 16); }

  /** Give a newly loaded chunk a mesh slot. Returns false when every slot is taken. */
  activate(id: number) {
    if (this.chunkSlot.has(id)) return true;
    const slot = this.slotChunkData.indexOf(FREE);
    if (slot < 0) return false;
    this.slotChunkData[slot] = id;
    this.chunkSlot.set(id, slot);
    this.pendingSlots.add(slot);
    this.syncSlots();
    return true;
  }

  /** Release an unloaded chunk's slot (its draw collapses to zero vertices on the next rebuild). */
  deactivate(id: number) {
    const slot = this.chunkSlot.get(id);
    if (slot === undefined) return;
    this.chunkSlot.delete(id);
    this.slotChunkData[slot] = FREE;
    this.pendingSlots.add(slot);
    this.syncSlots();
  }

  private syncSlots() {
    this.slotChunk.upload();
    const list = this.simList.attr.array as Uint32Array;
    this.simCount = 0;
    for (const id of this.chunkSlot.keys()) list[this.simCount++] = id;
    this.simList.upload();
  }

  /** Write a chunk's fluid and temperature into both ping-pong buffers. */
  loadFields(i0: number, j0: number, size: number, fluid: Float32Array, temp: Float32Array) {
    for (const buf of this.fluid) {
      const a = buf.attr.array as Float32Array;
      for (let r = 0; r < size; r++) {
        const k = (j0 + r) * W + i0;
        a.set(fluid.subarray(r * size * 4, (r + 1) * size * 4), k * 4);
        buf.attr.addUpdateRange(k * 4, size * 4);
      }
      buf.upload();
    }
    for (const buf of this.temp) {
      const a = buf.attr.array as Float32Array;
      for (let r = 0; r < size; r++) {
        const k = (j0 + r) * W + i0;
        a.set(temp.subarray(r * size, (r + 1) * size), k);
        buf.attr.addUpdateRange(k, size);
      }
      buf.upload();
    }
  }

  setEmitters(list: EmitterDef[]) {
    const n = Math.min(list.length, MAX_EMITTERS);
    for (let e = 0; e < n; e++) {
      const d = list[e];
      this.emitData.set([d.x, d.y, d.radius, d.type, d.rate, 0, 0, 0], e * 8);
    }
    this.nEmit.value = n;
    this.emit.upload();
  }

  /** Queue a particle burst for the next dispatch. Positions are world units. */
  burst(x: number, y: number, count: number, kind: number, speed = 2, radius = 0.1) {
    if (this.burstCount >= MAX_BURSTS) return;
    count = Math.min(Math.round(count), 2048);
    this.burstData.set([x, y, count, this.particleHead, speed, kind, radius, 0], this.burstCount * 8);
    this.particleHead = (this.particleHead + count) % MAX_PARTICLES;
    this.burstCount++;
  }

  /** Upload the terrain rows that changed since last frame. */
  private uploadTerrain() {
    const t = this.terrain;
    if (t.solidRects.length) {
      for (const [start, count] of rowRanges(t.solidRects)) {
        this.solid.attr.addUpdateRange(start, count);
        this.mat.attr.addUpdateRange(start, count);
      }
      t.solidRects.length = 0;
      this.solid.upload();
      this.mat.upload();
    }
    if (t.markRects.length) {
      for (const [start, count] of rowRanges(t.markRects)) this.digMark.attr.addUpdateRange(start, count);
      t.markRects.length = 0;
      this.digMark.upload();
    }
  }

  update(dt: number) {
    if (!enabled('sim')) return;
    const r = this.renderer;
    this.uploadTerrain();
    for (const id of this.terrain.meshDirty) {
      const slot = this.chunkSlot.get(id);
      if (slot !== undefined) this.pendingSlots.add(slot);
    }
    this.terrain.meshDirty.clear();
    if (this.pendingSlots.size) {
      const dirty = this.dirtySlots.attr.array as Uint32Array;
      let n = 0;
      for (const s of this.pendingSlots) dirty[n++] = s;
      this.pendingSlots.clear();
      this.dirtySlots.upload();
      const [begin, cells, end] = this.meshNodes;
      begin.count = n; cells.count = n * CHUNK_CELLS; end.count = n;
      for (const node of this.meshNodes) r.compute(node);
    }
    if (this.simCount > 0) {
      for (const node of this.stepNodes) node.count = this.simCount * CHUNK_CELLS;
      // Fixed-rate stepping, always in A→B→A pairs.
      this.accumulator = Math.min(this.accumulator + dt, STEP * 6);
      while (this.accumulator >= STEP * 2) {
        this.accumulator -= STEP * 2;
        for (const node of this.stepNodes) r.compute(node);
      }
    }
    if (this.burstCount > 0) {
      this.nBursts.value = this.burstCount;
      this.seed.value = Math.random() * 1000;
      this.bursts.upload();
      r.compute(this.spawnNode);
      this.burstCount = 0;
    }
    this.dt.value = Math.min(dt, 1 / 30);
    r.compute(this.particleNode);
  }

  /** Copy the GPU fluid and temperature state back for gameplay sampling (non-blocking). */
  async readback() {
    if (this.reading || !enabled('readback')) return;
    this.reading = true;
    try {
      const [f, t] = await Promise.all([
        this.renderer.getArrayBufferAsync(this.fluid[0].attr),
        this.renderer.getArrayBufferAsync(this.temp[0].attr),
      ]);
      this.fluidSnapshot = new Float32Array(f);
      this.tempSnapshot = new Float32Array(t);
    } finally {
      this.reading = false;
    }
  }
}

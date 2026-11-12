import { CHUNK, CHUNK_CELLS, CH, CW, Mat, W, chunkId } from '../config';
import type { Terrain } from '../sim/terrain';
import type { WorldGen } from '../sim/worldgen';

/** Everything that defines one chunk's state, row-major within the chunk. */
export interface ChunkData {
  density: Float32Array;
  material: Uint32Array;
  strut: Uint8Array;
  marks: Uint32Array;
  fluid: Float32Array;
  temp: Float32Array;
}

/**
 * Saved chunks: a small in-memory cache in front of IndexedDB. Each page load is a new game, so
 * the database is cleared on open. Without IndexedDB (private browsing, tests) everything stays
 * in memory.
 */
export class ChunkStore {
  private readonly memory = new Map<number, ChunkData>();
  private readonly saved = new Set<number>();
  private readonly writing = new Map<number, Promise<void>>();
  private db: Promise<IDBDatabase | null>;

  constructor(private readonly cacheSize = 96) {
    this.db = new Promise((resolve) => {
      try {
        const req = indexedDB.open('clankworks-chunks', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('chunks');
        req.onsuccess = () => {
          const db = req.result;
          const clear = db.transaction('chunks', 'readwrite').objectStore('chunks').clear();
          clear.onsuccess = () => resolve(db);
          clear.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  has(id: number) { return this.saved.has(id); }
  get memoryCount() { return this.memory.size; }

  put(id: number, data: ChunkData) {
    this.saved.add(id);
    this.memory.delete(id);
    this.memory.set(id, data);
    const write = this.db.then((db) => new Promise<void>((resolve) => {
      if (!db) return resolve();
      const tx = db.transaction('chunks', 'readwrite');
      tx.objectStore('chunks').put(data, id);
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    }));
    this.writing.set(id, write);
    void write.then(() => { if (this.writing.get(id) === write) this.writing.delete(id); this.evict(); });
  }

  /** Drop the least recently saved chunks from memory once they are safely on disk. */
  private evict() {
    void this.db.then((db) => {
      if (!db) return;
      for (const id of this.memory.keys()) {
        if (this.memory.size <= this.cacheSize) break;
        if (!this.writing.has(id)) this.memory.delete(id);
      }
    });
  }

  async get(id: number): Promise<ChunkData | undefined> {
    const hit = this.memory.get(id);
    if (hit) return hit;
    await this.writing.get(id);
    const db = await this.db;
    if (!db) return undefined;
    return new Promise((resolve) => {
      const req = db.transaction('chunks').objectStore('chunks').get(id);
      req.onsuccess = () => resolve(req.result as ChunkData | undefined);
      req.onerror = () => resolve(undefined);
    });
  }
}

export interface ChunkHooks {
  /** Real data is now in the arrays. */
  loaded(id: number): void;
  /** About to be replaced by placeholders; return the chunk's current fluid/temperature rows. */
  fields(id: number): { fluid: Float32Array; temp: Float32Array };
  unloaded(id: number): void;
}

const enum State { Unloaded, Loading, Loaded }

/**
 * Streams chunks in and out around whatever the game says it needs. New chunks come from the
 * world generator; chunks seen before come back from the store. Unloaded chunks are saved and
 * replaced by inert bedrock so physics, pathfinding and the GPU treat them as solid.
 */
export class ChunkStreamer {
  private readonly state = new Uint8Array(CW * CH);
  private readonly lastWanted = new Float64Array(CW * CH);
  readonly store = new ChunkStore();
  /** Chunk ids currently resident. */
  readonly resident = new Set<number>();

  constructor(
    private readonly terrain: Terrain,
    private readonly gen: WorldGen,
    private readonly fluid: Float32Array,
    private readonly temp: Float32Array,
    private readonly hooks: ChunkHooks,
  ) {}

  isLoaded(id: number) { return this.state[id] === State.Loaded; }

  /** Load a chunk immediately (used for the starting area). */
  loadNow(id: number) {
    if (this.state[id] !== State.Unloaded) return;
    this.gen.generate(id % CW, Math.floor(id / CW), this.terrain, this.fluid, this.temp);
    this.finishLoad(id);
  }

  /**
   * Bring wanted chunks in (at most `budget` per call, nearest first as ordered by the caller)
   * and drop chunks that have not been wanted for `linger` seconds.
   */
  update(wanted: number[], now: number, budget = 6, linger = 3) {
    for (const id of wanted) this.lastWanted[id] = now;
    let started = 0;
    for (const id of wanted) {
      if (this.state[id] !== State.Unloaded) continue;
      if (started++ >= budget) break;
      if (!this.store.has(id)) { this.loadNow(id); continue; }
      this.state[id] = State.Loading;
      void this.store.get(id).then((data) => {
        if (this.state[id] !== State.Loading) return;
        if (!data || now - this.lastWanted[id] > linger) {
          this.state[id] = State.Unloaded;
          if (!data) this.loadNow(id);
          return;
        }
        this.write(id, data);
        this.finishLoad(id);
      });
    }
    for (const id of [...this.resident]) {
      if (now - this.lastWanted[id] > linger) this.unload(id);
    }
  }

  private finishLoad(id: number) {
    this.state[id] = State.Loaded;
    this.terrain.loaded[id] = 1;
    this.resident.add(id);
    this.hooks.loaded(id);
  }

  private unload(id: number) {
    const fields = this.hooks.fields(id);
    this.store.put(id, { ...this.read(id), ...fields });
    const t = this.terrain;
    const { i0, j0 } = origin(id);
    for (let r = 0; r < CHUNK; r++) {
      const k = (j0 + r) * W + i0;
      t.density.fill(1, k, k + CHUNK);
      t.material.fill(Mat.Bedrock, k, k + CHUNK);
      t.strut.fill(0, k, k + CHUNK);
      t.digMark.fill(0, k, k + CHUNK);
    }
    t.loaded[id] = 0;
    this.state[id] = State.Unloaded;
    this.resident.delete(id);
    this.hooks.unloaded(id);
  }

  /** Copy a chunk's rows out of the world arrays. */
  read(id: number): Omit<ChunkData, 'fluid' | 'temp'> {
    const t = this.terrain;
    const { i0, j0 } = origin(id);
    const out = {
      density: new Float32Array(CHUNK_CELLS), material: new Uint32Array(CHUNK_CELLS),
      strut: new Uint8Array(CHUNK_CELLS), marks: new Uint32Array(CHUNK_CELLS),
    };
    for (let r = 0; r < CHUNK; r++) {
      const k = (j0 + r) * W + i0, o = r * CHUNK;
      out.density.set(t.density.subarray(k, k + CHUNK), o);
      out.material.set(t.material.subarray(k, k + CHUNK), o);
      out.strut.set(t.strut.subarray(k, k + CHUNK), o);
      out.marks.set(t.digMark.subarray(k, k + CHUNK), o);
    }
    return out;
  }

  private write(id: number, d: ChunkData) {
    const t = this.terrain;
    const { i0, j0 } = origin(id);
    for (let r = 0; r < CHUNK; r++) {
      const k = (j0 + r) * W + i0, o = r * CHUNK;
      t.density.set(d.density.subarray(o, o + CHUNK), k);
      t.material.set(d.material.subarray(o, o + CHUNK), k);
      t.strut.set(d.strut.subarray(o, o + CHUNK), k);
      t.digMark.set(d.marks.subarray(o, o + CHUNK), k);
      this.fluid.set(d.fluid.subarray(o * 4, (o + CHUNK) * 4), k * 4);
      this.temp.set(d.temp.subarray(o, o + CHUNK), k);
    }
  }
}

export function origin(id: number) {
  return { i0: (id % CW) * CHUNK, j0: Math.floor(id / CW) * CHUNK };
}

/** A chunk's rows out of a world-sized per-cell array (`stride` values per cell). */
export function chunkRows<T extends Float32Array>(src: T, id: number, stride: number): T {
  const { i0, j0 } = origin(id);
  const out = new (src.constructor as new (n: number) => T)(CHUNK_CELLS * stride);
  for (let r = 0; r < CHUNK; r++) {
    const k = ((j0 + r) * W + i0) * stride;
    out.set(src.subarray(k, k + CHUNK * stride), r * CHUNK * stride);
  }
  return out;
}

export { chunkId };

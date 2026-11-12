import { CELL, CELLS, CHUNK, CH, CW, H, ISO, MATERIALS, Mat, W, cellIndex, chunkId } from '../config';

export interface Rect { i0: number; j0: number; i1: number; j1: number }

export type Yield = Record<number, number>;

/**
 * Authoritative 2D voxel grid for the whole world. Density, material and flag arrays are shared
 * directly with the GPU storage buffers; changed rectangles are queued so only those rows are
 * uploaded. Chunks that are not loaded hold inert bedrock placeholders (see ChunkManager).
 */
export class Terrain {
  readonly density = new Float32Array(CELLS).fill(1);
  readonly material = new Uint32Array(CELLS).fill(Mat.Bedrock);
  /** Steel strut occupancy. Struts count as solid for structural checks but not for fluids. */
  readonly strut = new Uint8Array(CELLS);
  /** Per-cell flags: dig orders, reachability, fog of war, stress, cracking (see config). */
  readonly digMark = new Uint32Array(CELLS);
  /** 1 for chunks whose real data is resident, by chunkId. */
  readonly loaded = new Uint8Array(CW * CH);

  /** Chunks whose colliders need rebuilding. */
  readonly dirtyChunks = new Set<number>();
  /** Chunks whose GPU mesh needs rebuilding. */
  readonly meshDirty = new Set<number>();
  /** Rectangles whose density/material changed, and whose flags changed, awaiting GPU upload. */
  readonly solidRects: Rect[] = [];
  readonly markRects: Rect[] = [];
  /** Union of regions carved since the last structural check. */
  structuralDirty: Rect | null = null;
  version = 0;

  isLoadedCell(i: number, j: number) {
    return this.inBounds(i, j) && this.loaded[chunkId(Math.floor(i / CHUNK), Math.floor(j / CHUNK))] === 1;
  }

  /** Queue a flag-only change (dig orders, fog, stress, cracks) for upload. */
  touchMarks(i0: number, j0: number, i1: number, j1: number) {
    this.markRects.push({ i0: Math.max(0, i0), j0: Math.max(0, j0), i1: Math.min(W - 1, i1), j1: Math.min(H - 1, j1) });
  }

  /** touchMarks over the bounding box of a set of cells. */
  touchCells(cells: Iterable<number>) {
    let i0 = W, j0 = H, i1 = -1, j1 = -1;
    for (const k of cells) {
      const i = k % W, j = (k / W) | 0;
      if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
    }
    if (i1 >= 0) this.touchMarks(i0, j0, i1, j1);
  }

  inBounds(i: number, j: number) {
    return i >= 0 && j >= 0 && i < W && j < H;
  }

  /** Out-of-bounds below/sides is solid, above the map is open sky. */
  densityAt(i: number, j: number) {
    if (j >= H) return 0;
    if (i < 0 || i >= W || j < 0) return 1;
    return this.density[cellIndex(i, j)];
  }

  isSolid(i: number, j: number) {
    return this.densityAt(i, j) > ISO;
  }

  isOpen(i: number, j: number) {
    return this.inBounds(i, j) && this.density[cellIndex(i, j)] <= ISO;
  }

  /** Structural solidity: rock or strut. */
  isLoadBearing(i: number, j: number) {
    if (!this.inBounds(i, j)) return j < H;
    const k = cellIndex(i, j);
    return this.density[k] > ISO || this.strut[k] === 1;
  }

  /** Sample density bilinearly at a world position (cell centers are the sample points). */
  sample(x: number, y: number) {
    const fx = x / CELL - 0.5, fy = y / CELL - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy);
    const tx = fx - i, ty = fy - j;
    const a = this.densityAt(i, j), b = this.densityAt(i + 1, j);
    const c = this.densityAt(i, j + 1), d = this.densityAt(i + 1, j + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  markDirty(i0: number, j0: number, i1: number, j1: number, structural = true) {
    i0 = Math.max(0, i0); j0 = Math.max(0, j0);
    i1 = Math.min(W - 1, i1); j1 = Math.min(H - 1, j1);
    for (let cj = Math.floor((j0 - 1) / CHUNK); cj <= Math.floor((j1 + 1) / CHUNK); cj++) {
      for (let ci = Math.floor((i0 - 1) / CHUNK); ci <= Math.floor((i1 + 1) / CHUNK); ci++) {
        if (ci < 0 || cj < 0 || ci >= CW || cj >= CH) continue;
        const id = chunkId(ci, cj);
        if (!this.loaded[id]) continue;
        this.dirtyChunks.add(id);
        this.meshDirty.add(id);
      }
    }
    if (structural) {
      const r = this.structuralDirty;
      this.structuralDirty = r
        ? { i0: Math.min(r.i0, i0), j0: Math.min(r.j0, j0), i1: Math.max(r.i1, i1), j1: Math.max(r.j1, j1) }
        : { i0, j0, i1, j1 };
    }
    this.solidRects.push({ i0, j0, i1, j1 });
    this.markRects.push({ i0, j0, i1, j1 });
    this.version++;
  }

  /**
   * Subtract a smooth radial brush from the density field. `amount` is the density removed at
   * the brush center; returns the density removed per material so callers can award resources.
   */
  carve(x: number, y: number, radius: number, amount: number, out: Yield = {}): Yield {
    const ci = x / CELL - 0.5, cj = y / CELL - 0.5;
    const r = radius / CELL;
    const i0 = Math.floor(ci - r), i1 = Math.ceil(ci + r);
    const j0 = Math.floor(cj - r), j1 = Math.ceil(cj + r);
    let changed = false;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!this.inBounds(i, j)) continue;
        const k = cellIndex(i, j);
        const m = this.material[k];
        if (m === Mat.Bedrock) continue;
        const d = Math.hypot(i - ci, j - cj) / r;
        if (d >= 1) continue;
        const fall = 1 - d * d * (3 - 2 * d);
        const before = this.density[k];
        if (before <= 0) continue;
        const after = Math.max(0, before - amount * fall);
        this.density[k] = after;
        out[m] = (out[m] ?? 0) + (before - after);
        if (after <= ISO) this.digMark[k] = 0;
        if (after === 0) this.material[k] = Mat.Air;
        changed = true;
      }
    }
    if (changed) this.markDirty(i0, j0, i1, j1);
    return out;
  }

  /** Remove a whole set of cells (used when an island detaches into a rigidbody). */
  clearCells(cells: number[]) {
    let i0 = W, j0 = H, i1 = 0, j1 = 0;
    for (const k of cells) {
      const i = k % W, j = (k / W) | 0;
      this.density[k] = 0;
      this.material[k] = Mat.Air;
      this.digMark[k] = 0;
      i0 = Math.min(i0, i); j0 = Math.min(j0, j); i1 = Math.max(i1, i); j1 = Math.max(j1, j);
    }
    if (cells.length) this.markDirty(i0, j0, i1, j1, false);
  }

  /** Set a cell solid (debris settling back into terrain). Returns false if occupied. */
  stamp(i: number, j: number, mat: number) {
    if (!this.inBounds(i, j)) return false;
    const k = cellIndex(i, j);
    if (this.density[k] > ISO || this.strut[k]) return false;
    this.density[k] = 1;
    this.material[k] = mat;
    return true;
  }

  hardness(k: number) {
    return MATERIALS[this.material[k]].hardness;
  }
}

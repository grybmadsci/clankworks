import { CELLS, H, MATERIALS, Mat, W, cellIndex } from '../config';
import { Rect, Terrain } from './terrain';

/** Islands bigger than this are treated as wedged in place rather than simulated. */
const MAX_ISLAND = 2400;
const SLAB_THICKNESS = 3;

/** The anchoring flood only covers this many cells around the region being checked. */
const WINDOW = 48;

const visited = new Int32Array(CELLS);
let stamp = 0;
const queue = new Int32Array(CELLS);

/**
 * Find load-bearing cells that are no longer connected to support, plus ceiling slabs whose
 * unsupported span exceeds what their material can hold. Each returned array is one island.
 *
 * The flood that decides what is anchored starts from bedrock and from solid rock on the edge of
 * a window around the region. Rock reaching that far is treated as attached to the rest of the
 * world, which keeps the check local in a big world. Islands larger than MAX_ISLAND are ignored
 * anyway, so this only misses long, thin, fully detached slivers.
 */
export function findCollapses(t: Terrain, region: Rect): number[][] {
  stamp++;
  const anchored = stamp;
  const wi0 = Math.max(0, region.i0 - WINDOW), wi1 = Math.min(W - 1, region.i1 + WINDOW);
  const wj0 = Math.max(0, region.j0 - WINDOW), wj1 = Math.min(H - 1, region.j1 + WINDOW);
  const bears = (k: number) => t.density[k] > 0.5 || t.strut[k] === 1;
  let head = 0, tail = 0;
  for (let j = wj0; j <= wj1; j++) for (let i = wi0; i <= wi1; i++) {
    const k = cellIndex(i, j);
    const edge = i === wi0 || i === wi1 || j === wj0 || j === wj1;
    if (t.material[k] === Mat.Bedrock || (edge && bears(k))) { visited[k] = anchored; queue[tail++] = k; }
  }
  while (head < tail) {
    const k = queue[head++];
    const i = k % W, j = (k / W) | 0;
    if (i > wi0) visit(k - 1);
    if (i < wi1) visit(k + 1);
    if (j > wj0) visit(k - W);
    if (j < wj1) visit(k + W);
  }
  function visit(n: number) {
    if (visited[n] === anchored) return;
    if (bears(n)) { visited[n] = anchored; queue[tail++] = n; }
  }

  const islands: number[][] = [];
  // Unanchored islands touching the dirty region.
  const pad = 2;
  for (let j = Math.max(0, region.j0 - pad); j <= Math.min(H - 1, region.j1 + pad); j++) {
    for (let i = Math.max(0, region.i0 - pad); i <= Math.min(W - 1, region.i1 + pad); i++) {
      const k = cellIndex(i, j);
      if (visited[k] === anchored || visited[k] > anchored || t.density[k] <= 0.5) continue;
      const island = floodIsland(t, k);
      if (island.length <= MAX_ISLAND) islands.push(island);
    }
  }

  // Overhangs: ceilings whose unsupported width exceeds what their weakest material can hold.
  for (const c of ceilings(t, region)) if (c.span > c.maxSpan) islands.push(slab(t, c.cols, c.rowOf, c.maxSpan));
  return islands.filter((s) => s.length > 0);
}

function floodIsland(t: Terrain, start: number): number[] {
  stamp++;
  const mark = stamp;
  const out: number[] = [];
  let head = 0, tail = 0;
  queue[tail++] = start;
  visited[start] = mark;
  while (head < tail) {
    const k = queue[head++];
    if (t.density[k] > 0.5) out.push(k);
    const i = k % W, j = (k / W) | 0;
    const ns = [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, j > 0 ? k - W : -1, j < H - 1 ? k + W : -1];
    for (const n of ns) {
      if (n < 0 || visited[n] === mark) continue;
      if (t.density[n] > 0.5 || t.strut[n]) { visited[n] = mark; queue[tail++] = n; }
    }
  }
  // Leave the stamp past `anchored` so the caller skips cells it has already grouped.
  return out;
}

/** One stretch of ceiling: its columns, the ceiling row in each, and how far it may span. */
export interface Ceiling { cols: number[]; rowOf: Map<number, number>; span: number; maxSpan: number }

/**
 * Ceiling cells (load-bearing with open air below) link to neighbouring columns whose ceiling is
 * within two rows, so a flat or gently curved roof is measured across its full width while steep
 * arch sides break the span. Struts hold up the cell above them, so they split spans naturally.
 * Returns every ceiling that reaches into the region.
 */
export function ceilings(t: Terrain, region: Rect): Ceiling[] {
  const reach = 30;
  const i0 = Math.max(0, region.i0 - reach), i1 = Math.min(W - 1, region.i1 + reach);
  const j0 = Math.max(1, region.j0 - 4), j1 = Math.min(H - 1, region.j1 + 8);
  const isCeiling = (i: number, j: number) => {
    const k = cellIndex(i, j);
    return t.density[k] > 0.5 && t.material[k] !== Mat.Bedrock && !t.isLoadBearing(i, j - 1);
  };
  const seen = new Set<number>();
  const out: Ceiling[] = [];
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    if (!isCeiling(i, j) || seen.has(cellIndex(i, j))) continue;
    // Flood across columns, tracking one ceiling row per column.
    const rowOf = new Map<number, number>([[i, j]]);
    const stack = [[i, j]];
    seen.add(cellIndex(i, j));
    let weakest = MATERIALS[t.material[cellIndex(i, j)]].maxSpan;
    while (stack.length) {
      const [ci, cj] = stack.pop()!;
      for (const ni of [ci - 1, ci + 1]) {
        if (ni < i0 || ni > i1 || rowOf.has(ni)) continue;
        for (const dj of [0, -1, 1, -2, 2]) {
          const nj = cj + dj;
          if (nj < j0 || nj > j1 || !isCeiling(ni, nj)) continue;
          rowOf.set(ni, nj);
          seen.add(cellIndex(ni, nj));
          weakest = Math.min(weakest, MATERIALS[t.material[cellIndex(ni, nj)]].maxSpan);
          stack.push([ni, nj]);
          break;
        }
      }
    }
    const cols = [...rowOf.keys()].sort((a, b) => a - b);
    const touchesRegion = cols[0] <= region.i1 + 2 && cols[cols.length - 1] >= region.i0 - 2;
    if (touchesRegion) out.push({ cols, rowOf, span: cols[cols.length - 1] - cols[0] + 1, maxSpan: weakest });
  }
  return out;
}

/** The middle of an over-long ceiling drops as a slab a few cells thick. */
export const SLAB_DEPTH = SLAB_THICKNESS;

function slab(t: Terrain, cols: number[], rowOf: Map<number, number>, maxSpan: number): number[] {
  const margin = Math.max(1, Math.floor(maxSpan / 3));
  const out: number[] = [];
  for (const i of cols.slice(margin, cols.length - margin)) {
    const j = rowOf.get(i)!;
    for (let dj = 0; dj < SLAB_THICKNESS; dj++) {
      if (j + dj >= H) break;
      const k = cellIndex(i, j + dj);
      if (t.density[k] <= 0.5 || t.material[k] === Mat.Bedrock || t.strut[k]) break;
      out.push(k);
    }
  }
  return out;
}

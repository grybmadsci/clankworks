import { CELL, H, ISO, W, cellIndex } from '../config';
import { Terrain } from './terrain';

/** Path nodes are 2x2 cell blocks: big enough for a scrapbot to squeeze through. */
const N = 2;
export const GW = Math.ceil(W / N), GH = Math.ceil(H / N);
const NODE = CELL * N;

const gScore = new Float32Array(GW * GH);
const cameFrom = new Int32Array(GW * GH);
const closed = new Uint32Array(GW * GH);
let generation = 0;

export function nodeOpen(t: Terrain, gx: number, gy: number) {
  if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) return false;
  for (let dj = 0; dj < N; dj++) for (let di = 0; di < N; di++) {
    const i = gx * N + di, j = gy * N + dj;
    if (i >= W || j >= H) continue;
    const k = cellIndex(i, j);
    if (t.density[k] > ISO) return false;
  }
  return true;
}

export const toNode = (v: number) => Math.floor(v / NODE);
export const nodeCenter = (g: number) => (g + 0.5) * NODE;

/** Binary heap of node ids keyed by f-score. */
class Heap {
  ids: number[] = []; f: number[] = [];
  push(id: number, f: number) {
    let n = this.ids.length;
    this.ids.push(id); this.f.push(f);
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (this.f[p] <= this.f[n]) break;
      [this.ids[p], this.ids[n]] = [this.ids[n], this.ids[p]];
      [this.f[p], this.f[n]] = [this.f[n], this.f[p]];
      n = p;
    }
  }
  pop() {
    const top = this.ids[0];
    const lastId = this.ids.pop()!, lastF = this.f.pop()!;
    if (this.ids.length) {
      this.ids[0] = lastId; this.f[0] = lastF;
      let n = 0;
      for (;;) {
        const l = n * 2 + 1, r = l + 1;
        let m = n;
        if (l < this.ids.length && this.f[l] < this.f[m]) m = l;
        if (r < this.ids.length && this.f[r] < this.f[m]) m = r;
        if (m === n) break;
        [this.ids[m], this.ids[n]] = [this.ids[n], this.ids[m]];
        [this.f[m], this.f[n]] = [this.f[n], this.f[m]];
        n = m;
      }
    }
    return top;
  }
  get size() { return this.ids.length; }
}

/**
 * A* from a world position to any open node within `reach` of the goal point.
 * Returns world-space waypoints (excluding the start), or null if unreachable.
 */
export function findPath(t: Terrain, sx: number, sy: number, gx: number, gy: number, reach: number, maxExpand = 6000) {
  generation++;
  let start = toNode(sx) + toNode(sy) * GW;
  if (!nodeOpen(t, start % GW, (start / GW) | 0)) {
    // Bot is wedged against a wall; start from the nearest open neighbour.
    const sxN = toNode(sx), syN = toNode(sy);
    let found = -1;
    for (let r = 1; r <= 2 && found < 0; r++)
      for (let dy = -r; dy <= r && found < 0; dy++)
        for (let dx = -r; dx <= r && found < 0; dx++)
          if (nodeOpen(t, sxN + dx, syN + dy)) found = sxN + dx + (syN + dy) * GW;
    if (found < 0) return null;
    start = found;
  }
  const h = (id: number) => Math.hypot(nodeCenter(id % GW) - gx, nodeCenter((id / GW) | 0) - gy);
  const heap = new Heap();
  gScore[start] = 0;
  cameFrom[start] = -1;
  closed[start] = 0;
  const seen = new Map<number, number>([[start, generation]]);
  heap.push(start, h(start));
  let expanded = 0;
  while (heap.size && expanded++ < maxExpand) {
    const cur = heap.pop();
    if (closed[cur] === generation) continue;
    closed[cur] = generation;
    if (h(cur) <= reach) return reconstruct(cur);
    const cx = cur % GW, cy = (cur / GW) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (!nodeOpen(t, nx, ny)) continue;
      if (dx && dy && (!nodeOpen(t, cx + dx, cy) || !nodeOpen(t, cx, cy + dy))) continue;
      const id = nx + ny * GW;
      if (closed[id] === generation) continue;
      const g = gScore[cur] + (dx && dy ? 1.414 : 1) * NODE;
      if (seen.get(id) === generation && g >= gScore[id]) continue;
      seen.set(id, generation);
      gScore[id] = g;
      cameFrom[id] = cur;
      heap.push(id, g + h(id));
    }
  }
  return null;
}

function reconstruct(end: number) {
  const pts: { x: number; y: number }[] = [];
  for (let id = end; id >= 0; id = cameFrom[id]) pts.push({ x: nodeCenter(id % GW), y: nodeCenter((id / GW) | 0) });
  pts.reverse();
  return pts.slice(1);
}

import { CELL, H, ISO, W, cellIndex } from '../config';
import { Terrain } from './terrain';

/**
 * Path nodes are 2x2 cell blocks (big enough for a drone to squeeze through) placed on a 1-cell
 * stride, so blocks overlap and any tunnel two cells wide is navigable wherever it runs, not only
 * where it lines up with a coarse grid. Node (gx, gy) covers cells gx..gx+1, gy..gy+1.
 */
const N = 2;
export const GW = W - 1, GH = H - 1;
const NODE = CELL;

const gScore = new Float32Array(GW * GH);
const cameFrom = new Int32Array(GW * GH);
const closed = new Uint32Array(GW * GH);
let generation = 0;
/** While set, cells buildings stand in count as blocked (see findPath's `avoidBuildings`). */
let avoidBuildings = false;

export function nodeOpen(t: Terrain, gx: number, gy: number) {
  if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) return false;
  for (let dj = 0; dj < N; dj++) for (let di = 0; di < N; di++) {
    const i = gx + di, j = gy + dj;
    if (i >= W || j >= H) continue;
    const k = cellIndex(i, j);
    if (t.density[k] > ISO || (avoidBuildings && t.occupied[k])) return false;
  }
  return true;
}

export const toNode = (v: number) => Math.floor(v / CELL - 0.5);
export const nodeCenter = (g: number) => (g + 1) * CELL;

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

/** The node under a world position, or the nearest open one if that is blocked; -1 if enclosed. */
function startNode(t: Terrain, sx: number, sy: number) {
  const sxN = toNode(sx), syN = toNode(sy);
  for (let r = 0; r <= 3; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (nodeOpen(t, sxN + dx, syN + dy)) return sxN + dx + (syN + dy) * GW;
  return -1;
}

/** Whether A* may step from node (cx, cy) by (dx, dy): diagonals can't cut corners. */
function canStep(t: Terrain, cx: number, cy: number, dx: number, dy: number) {
  if (!nodeOpen(t, cx + dx, cy + dy)) return false;
  return !(dx && dy) || (nodeOpen(t, cx + dx, cy) && nodeOpen(t, cx, cy + dy));
}

const floodQueue = new Int32Array(GW * GH);

/** Mark (1) every node reachable from a world position, using the same moves as findPath (keeping earlier marks unless `reset`). */
export function floodNodes(t: Terrain, sx: number, sy: number, out: Uint8Array, reset = true) {
  if (reset) out.fill(0);
  const start = startNode(t, sx, sy);
  if (start < 0) return;
  let head = 0, tail = 0;
  floodQueue[tail++] = start;
  out[start] = 1;
  while (head < tail) {
    const cur = floodQueue[head++];
    const cx = cur % GW, cy = (cur / GW) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const id = cx + dx + (cy + dy) * GW;
      if ((dx || dy) && canStep(t, cx, cy, dx, dy) && !out[id]) { out[id] = 1; floodQueue[tail++] = id; }
    }
  }
}

/** True if some node marked by floodNodes is within `reach` of (x, y): findPath's goal test. */
export function nearFlooded(flood: Uint8Array, x: number, y: number, reach: number) {
  const r = Math.ceil(reach / NODE);
  const gx = toNode(x), gy = toNode(y);
  for (let ny = Math.max(0, gy - r); ny <= Math.min(GH - 1, gy + r); ny++)
    for (let nx = Math.max(0, gx - r); nx <= Math.min(GW - 1, gx + r); nx++)
      if (flood[nx + ny * GW] && Math.hypot(nodeCenter(nx) - x, nodeCenter(ny) - y) <= reach) return true;
  return false;
}

/**
 * A* from a world position to any open node within `reach` of the goal point.
 * Returns world-space waypoints (excluding the start), or null if unreachable.
 */
export function findPath(t: Terrain, sx: number, sy: number, gx: number, gy: number, reach: number, maxExpand = 24000, avoid = false) {
  avoidBuildings = avoid;
  try {
    return search(t, sx, sy, gx, gy, reach, maxExpand);
  } finally {
    avoidBuildings = false;
  }
}

/**
 * A route that goes around buildings if there is one, else the direct route (drones then fly
 * past in front of the building rather than through it).
 */
export function findRoute(t: Terrain, sx: number, sy: number, gx: number, gy: number, reach: number, maxExpand = 24000) {
  return findPath(t, sx, sy, gx, gy, reach, maxExpand, true) ?? findPath(t, sx, sy, gx, gy, reach, maxExpand, false);
}

function search(t: Terrain, sx: number, sy: number, gx: number, gy: number, reach: number, maxExpand: number) {
  generation++;
  const start = startNode(t, sx, sy);
  if (start < 0) return null;
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
      if (!canStep(t, cx, cy, dx, dy)) continue;
      const id = cx + dx + (cy + dy) * GW;
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

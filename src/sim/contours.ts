import { CELL, CHUNK, H, ISO, W } from '../config';
import { Terrain } from './terrain';

export type Polyline = number[]; // flat [x0, y0, x1, y1, ...] in world units

/**
 * Marching squares over one chunk of the density grid. Sample points are cell centers, so the
 * square (i, j) spans centers (i, j)..(i+1, j+1). Out-of-range squares use Terrain.densityAt's
 * boundary rules, which keeps neighbouring chunks' contours stitched together.
 */
export function chunkSegments(t: Terrain, ci: number, cj: number): number[] {
  const segs: number[] = [];
  const i0 = ci * CHUNK - (ci === 0 ? 1 : 0), j0 = cj * CHUNK - (cj === 0 ? 1 : 0);
  const i1 = Math.min((ci + 1) * CHUNK, W), j1 = Math.min((cj + 1) * CHUNK, H);
  const lerp = (a: number, b: number) => (ISO - a) / (b - a);
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      const d0 = t.densityAt(i, j), d1 = t.densityAt(i + 1, j);
      const d2 = t.densityAt(i + 1, j + 1), d3 = t.densityAt(i, j + 1);
      const c = (d0 > ISO ? 1 : 0) | (d1 > ISO ? 2 : 0) | (d2 > ISO ? 4 : 0) | (d3 > ISO ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const x = (i + 0.5) * CELL, y = (j + 0.5) * CELL;
      // Edge crossing points: bottom, right, top, left.
      const e = [
        [x + lerp(d0, d1) * CELL, y],
        [x + CELL, y + lerp(d1, d2) * CELL],
        [x + lerp(d3, d2) * CELL, y + CELL],
        [x, y + lerp(d0, d3) * CELL],
      ];
      const add = (a: number, b: number) => segs.push(e[a][0], e[a][1], e[b][0], e[b][1]);
      switch (c) {
        case 1: case 14: add(3, 0); break;
        case 2: case 13: add(0, 1); break;
        case 3: case 12: add(3, 1); break;
        case 4: case 11: add(1, 2); break;
        case 6: case 9: add(0, 2); break;
        case 7: case 8: add(3, 2); break;
        case 5: case 10: {
          const centerSolid = (d0 + d1 + d2 + d3) * 0.25 > ISO;
          if ((c === 5) === centerSolid) { add(3, 2); add(0, 1); } else { add(3, 0); add(1, 2); }
          break;
        }
      }
    }
  }
  return segs;
}

/** Join loose segments into polylines by matching endpoints. */
export function chainSegments(segs: number[]): Polyline[] {
  const key = (x: number, y: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;
  const n = segs.length / 4;
  const used = new Uint8Array(n);
  const byPoint = new Map<string, number[]>();
  for (let s = 0; s < n; s++) {
    for (const end of [0, 2]) {
      const k = key(segs[s * 4 + end], segs[s * 4 + end + 1]);
      let list = byPoint.get(k);
      if (!list) byPoint.set(k, (list = []));
      list.push(s);
    }
  }
  const lines: Polyline[] = [];
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const line = [segs[s * 4], segs[s * 4 + 1], segs[s * 4 + 2], segs[s * 4 + 3]];
    // Grow forward from the tail, then backward from the head.
    for (const forward of [true, false]) {
      for (;;) {
        const px = forward ? line[line.length - 2] : line[0];
        const py = forward ? line[line.length - 1] : line[1];
        const next = byPoint.get(key(px, py))?.find((o) => !used[o]);
        if (next === undefined) break;
        used[next] = 1;
        const a = [segs[next * 4], segs[next * 4 + 1]], b = [segs[next * 4 + 2], segs[next * 4 + 3]];
        const far = key(a[0], a[1]) === key(px, py) ? b : a;
        if (forward) line.push(far[0], far[1]); else line.unshift(far[0], far[1]);
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Ramer-Douglas-Peucker simplification. A closed loop (a cave wholly inside the chunk) is split at
 * its point farthest from the start first: with both ends on the same point, RDP would measure
 * every distance from a zero-length chord and collapse the loop to nothing.
 */
export function simplify(line: Polyline, epsilon: number): Polyline {
  const count = line.length / 2;
  if (count <= 2) return line;
  if (count > 3 && Math.abs(line[0] - line[line.length - 2]) < 1e-5 && Math.abs(line[1] - line[line.length - 1]) < 1e-5) {
    let far = 1, farD = -1;
    for (let p = 1; p < count - 1; p++) {
      const d = Math.hypot(line[p * 2] - line[0], line[p * 2 + 1] - line[1]);
      if (d > farD) { farD = d; far = p; }
    }
    const a = simplify(line.slice(0, far * 2 + 2), epsilon), b = simplify(line.slice(far * 2), epsilon);
    return [...a, ...b.slice(2)];
  }
  const keep = new Uint8Array(count);
  keep[0] = keep[count - 1] = 1;
  const stack: [number, number][] = [[0, count - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = line[a * 2], ay = line[a * 2 + 1], bx = line[b * 2], by = line[b * 2 + 1];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bestD = epsilon;
    for (let p = a + 1; p < b; p++) {
      const d = Math.abs((line[p * 2] - ax) * dy - (line[p * 2 + 1] - ay) * dx) / len;
      if (d > bestD) { bestD = d; best = p; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out: Polyline = [];
  for (let p = 0; p < count; p++) {
    if (!keep[p]) continue;
    // Drop zero-length segments; degenerate edges upset the physics engine.
    const n = out.length;
    if (n >= 2 && Math.abs(out[n - 2] - line[p * 2]) < 1e-5 && Math.abs(out[n - 1] - line[p * 2 + 1]) < 1e-5) continue;
    out.push(line[p * 2], line[p * 2 + 1]);
  }
  return out;
}

export function chunkPolylines(t: Terrain, ci: number, cj: number, epsilon = CELL * 0.12): Polyline[] {
  return chainSegments(chunkSegments(t, ci, cj)).map((l) => simplify(l, epsilon)).filter((l) => l.length >= 4);
}

// WGSL compute kernels, wrapped with three.js wgslFn(). Grid constants are baked into the
// source so the kernels stay branch-light; storage buffers arrive as pointer parameters.
import { wgslFn as wgslFnTyped } from 'three/tsl';
import { CELL, CHUNK, CHUNK_CELLS, CW, DEPTH, H, MAX_ACTIVE, MAX_PARTICLES, W } from '../config';

/** Terrain vertices per active-chunk mesh slot (12 per cell on average). */
export const SLOT_CAP = CHUNK_CELLS * 12;
export const MESH_CAPACITY = SLOT_CAP * MAX_ACTIVE;

// Includes are typed narrowly upstream; wgslFn nodes are valid includes at runtime.
const wgslFn = wgslFnTyped as (code: string, includes?: unknown[]) => any;

const f = (n: number) => n.toFixed(5);
const GRID = `let W = ${W}i; let H = ${H}i;`;

/**
 * Work is dispatched over lists of chunks: thread `tid` handles cell `tid % CHUNK_CELLS` of list
 * entry `tid / CHUNK_CELLS`. Chunk ids are cj * CW + ci; returns the cell's (i, j).
 */
const chunkCell = wgslFn(/* wgsl */ `
fn chunkCell(chunk: u32, local: u32) -> vec2i {
  return vec2i(i32((chunk % ${CW}u) * ${CHUNK}u + local % ${CHUNK}u), i32((chunk / ${CW}u) * ${CHUNK}u + local / ${CHUNK}u));
}
`);

/** Smooth 3D value noise, shared by the mesher. */
const noiseFns = wgslFn(/* wgsl */ `
fn vhash(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let t = fract(p);
  let u = t * t * (3.0 - 2.0 * t);
  let a = mix(mix(vhash(i), vhash(i + vec3f(1.0, 0.0, 0.0)), u.x),
              mix(vhash(i + vec3f(0.0, 1.0, 0.0)), vhash(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y);
  let b = mix(mix(vhash(i + vec3f(0.0, 0.0, 1.0)), vhash(i + vec3f(1.0, 0.0, 1.0)), u.x),
              mix(vhash(i + vec3f(0.0, 1.0, 1.0)), vhash(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y);
  return mix(a, b, u.z);
}
`);

/**
 * Signed 2D value noise in [-1, 1] for render shaders. An integer hash keeps it cheap per pixel,
 * which matters on software adapters.
 */
export const noise2 = wgslFn(/* wgsl */ `
fn noise2(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let t = fract(p);
  let u = t * t * (3.0 - 2.0 * t);
  let a = ihash(i);
  let b = ihash(i + vec2i(1, 0));
  let c = ihash(i + vec2i(0, 1));
  let d = ihash(i + vec2i(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}
`, [wgslFn(/* wgsl */ `
fn ihash(q: vec2i) -> f32 {
  var h = (u32(q.x) * 0x8da6b343u) ^ (u32(q.y) * 0xd8163841u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  return f32(h ^ (h >> 15u)) / 4294967295.0;
}
`)]);

/**
 * Cellular automaton for water (x), magma (y), oxygen (z) and toxic gas (w).
 * Written as a gather: every cell recomputes the transfers with its neighbours from the source
 * buffer using the same pairwise rules, so mass is conserved without atomics or races.
 */
export const fluidStep = wgslFn(/* wgsl */ `
fn fluidStep(src: ptr<storage, array<vec4f>, read>, dst: ptr<storage, array<vec4f>, read_write>,
             solid: ptr<storage, array<f32>, read>, temp: ptr<storage, array<f32>, read>,
             emit: ptr<storage, array<vec4f>, read>, chunks: ptr<storage, array<u32>, read>,
             tid: u32, nEmit: u32) -> void {
  ${GRID}
  let cell = chunkCell((*chunks)[tid / ${CHUNK_CELLS}u], tid % ${CHUNK_CELLS}u);
  let i = cell.x;
  let j = cell.y;
  let idx = u32(j * W + i);

  // 3x3 neighbourhood. 0 BL, 1 B, 2 BR, 3 L, 4 C, 5 R, 6 TL, 7 T, 8 TR.
  var s: array<vec4f, 9>;
  var o: array<f32, 9>;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let n = (dx + 1) + (dy + 1) * 3;
      let ni = i + dx;
      let nj = j + dy;
      if (ni < 0 || ni >= W || nj < 0 || nj >= H) {
        s[n] = vec4f(0.0);
        o[n] = 0.0;
      } else {
        let k = u32(nj * W + ni);
        s[n] = (*src)[k];
        o[n] = select(0.0, 1.0, (*solid)[k] <= 0.5);
      }
    }
  }
  let c = s[4];
  if (o[4] == 0.0) {
    (*dst)[idx] = vec4f(0.0);
    return;
  }
  var outv = c;

  // Liquids: fall first, then level out sideways using what is left after falling.
  for (var ch = 0; ch < 2; ch++) {
    let other = 1 - ch;
    let rate = select(0.35, 1.0, ch == 0);
    let k = select(0.05, 0.24, ch == 0);
    var rem: array<f32, 3>;
    for (var x = 0; x < 3; x++) {
      let a = s[3 + x][ch];
      let b = s[x];
      let space = max(0.0, 1.0 - b[ch] - b[other]);
      rem[x] = a - o[x] * min(a, space) * rate;
    }
    let spaceC = max(0.0, 1.0 - c[ch] - c[other]);
    let inflow = o[7] * min(s[7][ch], spaceC) * rate;
    var v = rem[1] + inflow;
    v += o[3] * k * (rem[0] - rem[1]);
    v += o[5] * k * (rem[2] - rem[1]);
    outv[ch] = max(v, 0.0);
  }

  // Gases diffuse; toxic gas is heavy and sinks.
  for (var ch = 2; ch < 4; ch++) {
    let D = 0.2;
    let B = select(0.0, 0.03, ch == 3);
    let g = c[ch];
    var v = g;
    v += o[3] * D * (s[3][ch] - g);
    v += o[5] * D * (s[5][ch] - g);
    v += o[7] * (D * (s[7][ch] - g) + B * s[7][ch]);
    v -= o[1] * (D * (g - s[1][ch]) + B * g);
    outv[ch] = max(v, 0.0);
  }

  // Boiling, quenching, and magma burning oxygen.
  let T = (*temp)[idx];
  if (T > 100.0) { outv.x = max(0.0, outv.x - 0.002 * (T - 100.0) / 100.0); }
  let q = min(outv.x, outv.y) * 0.15;
  outv.x -= q;
  outv.y -= q * 0.5;
  outv.z *= 1.0 - min(outv.y, 1.0) * 0.3;

  for (var e = 0u; e < nEmit; e++) {
    let p = (*emit)[e * 2u];
    let r = (*emit)[e * 2u + 1u];
    let d = length(vec2f(f32(i), f32(j)) - p.xy);
    if (d < p.z) {
      let fall = 1.0 - d / p.z;
      let t = i32(p.w);
      if (t == 0) { outv.z = clamp(outv.z + r.x * fall, 0.0, 1.2); }
      else if (t == 1) { outv.w = clamp(outv.w + r.x * fall, 0.0, 1.5); }
      else if (t == 2) { outv.x = min(outv.x + r.x * fall, 1.0); }
      else if (t == 3) { outv.y = min(outv.y + r.x * fall, 1.0); }
    }
  }

  // The sky is an infinite reservoir of fresh air.
  if (j >= H - 1) { outv.z = 1.0; outv.w = 0.0; }
  (*dst)[idx] = outv;
}
`, [chunkCell]);

/** Heat conduction through rock and fluids, with magma as a source and a geothermal baseline. */
export const thermalStep = wgslFn(/* wgsl */ `
fn thermalStep(src: ptr<storage, array<f32>, read>, dst: ptr<storage, array<f32>, read_write>,
               fluid: ptr<storage, array<vec4f>, read>, solid: ptr<storage, array<f32>, read>,
               mat: ptr<storage, array<u32>, read>, emit: ptr<storage, array<vec4f>, read>,
               chunks: ptr<storage, array<u32>, read>, tid: u32, nEmit: u32) -> void {
  ${GRID}
  let cell = chunkCell((*chunks)[tid / ${CHUNK_CELLS}u], tid % ${CHUNK_CELLS}u);
  let i = cell.x;
  let j = cell.y;
  let idx = u32(j * W + i);
  // Conductivity by material: air, dirt, granite, copper, ice, bedrock, rubble, junk, iron, titanium.
  var cond = array<f32, 10>(0.04, 0.10, 0.20, 0.24, 0.16, 0.20, 0.08, 0.12, 0.22, 0.14);
  var offs = array<vec2i, 4>(vec2i(-1, 0), vec2i(1, 0), vec2i(0, -1), vec2i(0, 1));

  let T = (*src)[idx];
  let fl = (*fluid)[idx];
  let open = (*solid)[idx] <= 0.5;
  let kc = select(cond[min((*mat)[idx], 9u)], 0.03 + 0.2 * min(fl.x + fl.y, 1.0), open);
  var v = T;
  for (var n = 0; n < 4; n++) {
    let ni = i + offs[n].x;
    let nj = j + offs[n].y;
    if (ni < 0 || ni >= W || nj < 0 || nj >= H) { continue; }
    let k = u32(nj * W + ni);
    let nf = (*fluid)[k];
    let kn = select(cond[min((*mat)[k], 9u)], 0.03 + 0.2 * min(nf.x + nf.y, 1.0), (*solid)[k] <= 0.5);
    v += min(kc, kn) * ((*src)[k] - T);
  }
  v = mix(v, 1150.0, clamp(fl.y * 0.3, 0.0, 1.0));
  if (fl.x > 0.05 && v > 20.0) { v = mix(v, 20.0, min(fl.x * 0.02, 1.0)); }
  let base = 14.0 + (1.0 - f32(j) / f32(H)) * 70.0;
  v += (base - v) * select(0.0004, 0.0015, open);

  for (var e = 0u; e < nEmit; e++) {
    let p = (*emit)[e * 2u];
    let r = (*emit)[e * 2u + 1u];
    if (i32(p.w) != 4) { continue; }
    let d = length(vec2f(f32(i), f32(j)) - p.xy);
    if (d < p.z) { v = mix(v, r.x, (1.0 - d / p.z) * 0.05); }
  }
  if (j >= H - 1) { v = 15.0; }
  (*dst)[idx] = v;
}
`, [chunkCell]);

/**
 * 2.5D terrain mesher. Each marching-squares cell emits a front cutaway cap (fan triangulated)
 * plus its contour segments extruded back along -Z in three noise-perturbed bands so walls look
 * craggy rather than flatly extruded. Vertices are (xyz, material id; +16 marks wall faces).
 * Each active chunk owns a slot of SLOT_CAP vertices and four indirect draw args. Cells build up
 * to 48 vertices locally, then reserve space in their chunk's slot with an atomic counter (stream
 * compaction); that counter doubles as the slot's indirect draw vertex count. Only chunks listed
 * in `dirty` are rebuilt.
 */
const meshHelpers = wgslFn(/* wgsl */ `
fn wallOffset(p: vec2f, z: f32, ring: i32, open: vec2f) -> vec2f {
  if (ring == 0) { return vec2f(0.0); }
  let q = vec3f(p * 2.3, z * 2.3);
  let amp = select(0.08, 0.13, ring == 3);
  let o = (vec2f(vnoise(q), vnoise(q + vec3f(17.3, 4.1, 9.7))) - 0.5) * 2.0 * amp;
  // Only ever back into the rock, never out into the open: a floor that bulged up at depth would
  // swallow the wheels of anything driving on the line the physics uses.
  return o - open * max(0.0, dot(o, open));
}
fn ringZ(r: i32) -> f32 {
  return -${f(DEPTH)} * select(select(select(1.0, 0.7, r == 2), 0.35, r == 1), 0.0, r == 0);
}
fn pushTri(verts: ptr<function, array<vec4f, 48>>, cnt: ptr<function, u32>, a: vec3f, b: vec3f, c: vec3f, m: f32) {
  if (*cnt + 3u > 48u) { return; }
  (*verts)[*cnt] = vec4f(a, m);
  (*verts)[*cnt + 1u] = vec4f(b, m);
  (*verts)[*cnt + 2u] = vec4f(c, m);
  *cnt = *cnt + 3u;
}
fn emitPoly(verts: ptr<function, array<vec4f, 48>>, cnt: ptr<function, u32>, poly: array<vec2f, 6>, edge: array<u32, 6>, opens: array<vec2f, 6>, n: u32, m: f32) {
  var pts = poly;
  var edges = edge;
  var nrm = opens;
  for (var t = 1u; t + 1u < n; t++) {
    pushTri(verts, cnt, vec3f(pts[0], 0.0), vec3f(pts[t], 0.0), vec3f(pts[t + 1u], 0.0), m);
  }
  for (var v = 0u; v < n; v++) {
    let w = (v + 1u) % n;
    if (edges[v] == 0u || edges[w] == 0u) { continue; }
    let a = pts[v];
    let b = pts[w];
    for (var r = 0; r < 3; r++) {
      let z0 = ringZ(r);
      let z1 = ringZ(r + 1);
      let a0 = vec3f(a + wallOffset(a, z0, r, nrm[v]), z0);
      let b0 = vec3f(b + wallOffset(b, z0, r, nrm[w]), z0);
      let a1 = vec3f(a + wallOffset(a, z1, r + 1, nrm[v]), z1);
      let b1 = vec3f(b + wallOffset(b, z1, r + 1, nrm[w]), z1);
      pushTri(verts, cnt, a0, b0, b1, m + 16.0);
      pushTri(verts, cnt, a0, b1, a1, m + 16.0);
    }
  }
}
fn nodeDensity(solid: ptr<storage, array<f32>, read>, i: i32, j: i32) -> f32 {
  ${GRID}
  return (*solid)[u32(clamp(j, 0, H - 1) * W + clamp(i, 0, W - 1))];
}
// Density gradient at a grid node (central differences): the same wherever it's asked from.
fn nodeGradient(solid: ptr<storage, array<f32>, read>, i: i32, j: i32) -> vec2f {
  return vec2f(nodeDensity(solid, i + 1, j) - nodeDensity(solid, i - 1, j), nodeDensity(solid, i, j + 1) - nodeDensity(solid, i, j - 1));
}
`, [noiseFns]);

export const meshCell = wgslFn(/* wgsl */ `
fn meshCell(solid: ptr<storage, array<f32>, read>, mat: ptr<storage, array<u32>, read>,
            outPos: ptr<storage, array<vec4f>, read_write>, drawArgs: ptr<storage, array<atomic<u32>>, read_write>,
            slotChunk: ptr<storage, array<u32>, read>, dirty: ptr<storage, array<u32>, read>, tid: u32) -> void {
  ${GRID}
  let C = ${f(CELL)};
  let ISO = 0.5;
  let slot = (*dirty)[tid / ${CHUNK_CELLS}u];
  let chunk = (*slotChunk)[slot];
  if (chunk == 0xffffffffu) { return; }
  let cell = chunkCell(chunk, tid % ${CHUNK_CELLS}u);
  let i = cell.x;
  let j = cell.y;
  let idx = u32(j * W + i);
  var verts: array<vec4f, 48>;
  var cnt = 0u;
  if (i < W - 1 && j < H - 1) {
    let k0 = idx;
    let k1 = idx + 1u;
    let k2 = idx + u32(W) + 1u;
    let k3 = idx + u32(W);
    let d = vec4f((*solid)[k0], (*solid)[k1], (*solid)[k2], (*solid)[k3]);
    let x = (f32(i) + 0.5) * C;
    let y = (f32(j) + 0.5) * C;
    var corner = array<vec2f, 4>(vec2f(x, y), vec2f(x + C, y), vec2f(x + C, y + C), vec2f(x, y + C));
    var ks = array<u32, 4>(k0, k1, k2, k3);
    var inside = array<bool, 4>(d.x > ISO, d.y > ISO, d.z > ISO, d.w > ISO);
    var dv = array<f32, 4>(d.x, d.y, d.z, d.w);
    let anyInside = inside[0] || inside[1] || inside[2] || inside[3];
    if (anyInside) {
      // Material comes from the densest corner.
      var best = 0u;
      for (var c = 1u; c < 4u; c++) { if (dv[c] > dv[best]) { best = c; } }
      let m = f32((*mat)[ks[best]]);

      // Walk the square counter-clockwise collecting inside corners and edge crossings.
      var poly: array<vec2f, 6>;
      var edge: array<u32, 6>;
      var opens: array<vec2f, 6>;
      var node = array<vec2i, 4>(vec2i(i, j), vec2i(i + 1, j), vec2i(i + 1, j + 1), vec2i(i, j + 1));
      var n = 0u;
      for (var c = 0u; c < 4u; c++) {
        let nx = (c + 1u) % 4u;
        if (inside[c] && n < 6u) { poly[n] = corner[c]; edge[n] = 0u; opens[n] = vec2f(0.0); n++; }
        if (inside[c] != inside[nx] && n < 6u) {
          let t = clamp((ISO - dv[c]) / (dv[nx] - dv[c]), 0.0, 1.0);
          poly[n] = mix(corner[c], corner[nx], t);
          edge[n] = 1u;
          // Which way is open air from this crossing: down the density gradient, taken between the
          // two grid nodes it lies on so neighbouring cells agree on it exactly.
          let g = mix(nodeGradient(solid, node[c].x, node[c].y), nodeGradient(solid, node[nx].x, node[nx].y), t);
          opens[n] = select(vec2f(0.0), -normalize(g), dot(g, g) > 1e-8);
          n++;
        }
      }
      let saddle = n == 6u && (inside[0] == inside[2]);
      let centerSolid = (d.x + d.y + d.z + d.w) * 0.25 > ISO;
      if (saddle && !centerSolid) {
        // Two separate corner triangles. With BL inside the walk is [c, e, e, c, e, e],
        // otherwise it starts on an edge: [e, c, e, e, c, e].
        let o = select(0u, 5u, inside[0]);
        var pa: array<vec2f, 6>;
        var ea: array<u32, 6>;
        var na: array<vec2f, 6>;
        ea[0] = 1u; ea[1] = 0u; ea[2] = 1u;
        for (var half = 0u; half < 2u; half++) {
          for (var q = 0u; q < 3u; q++) { pa[q] = poly[(o + half * 3u + q) % 6u]; na[q] = opens[(o + half * 3u + q) % 6u]; }
          emitPoly(&verts, &cnt, pa, ea, na, 3u, m);
        }
      } else {
        emitPoly(&verts, &cnt, poly, edge, opens, n, m);
      }
    }
  }
  if (cnt == 0u) { return; }
  let base = atomicAdd(&(*drawArgs)[slot * 4u], cnt);
  if (base + cnt > ${SLOT_CAP}u) { return; }
  for (var v = 0u; v < cnt; v++) {
    (*outPos)[slot * ${SLOT_CAP}u + base + v] = verts[v];
  }
}
`, [meshHelpers, chunkCell]);

/** Per-slot indirect draw args are (vertexCount, instanceCount, firstVertex, firstInstance). */
export const meshBegin = wgslFn(/* wgsl */ `
fn meshBegin(drawArgs: ptr<storage, array<atomic<u32>>, read_write>, dirty: ptr<storage, array<u32>, read>, tid: u32) -> void {
  let slot = (*dirty)[tid];
  atomicStore(&(*drawArgs)[slot * 4u], 0u);
  atomicStore(&(*drawArgs)[slot * 4u + 1u], 1u);
  atomicStore(&(*drawArgs)[slot * 4u + 2u], slot * ${SLOT_CAP}u);
  atomicStore(&(*drawArgs)[slot * 4u + 3u], 0u);
}
`);

/** Clamp a slot's vertex count in case its chunk overflowed the slot. */
export const meshEnd = wgslFn(/* wgsl */ `
fn meshEnd(drawArgs: ptr<storage, array<atomic<u32>>, read_write>, dirty: ptr<storage, array<u32>, read>, tid: u32) -> void {
  let slot = (*dirty)[tid];
  let n = atomicLoad(&(*drawArgs)[slot * 4u]);
  atomicStore(&(*drawArgs)[slot * 4u], min(n, ${SLOT_CAP}u));
}
`);

const particleHash = wgslFn(/* wgsl */ `
fn phash(n: f32) -> f32 {
  return fract(sin(n) * 43758.5453);
}
`);

/** Ring-buffer particle allocation: each burst owns [start, start + count) mod MAX_PARTICLES. */
export const particleSpawn = wgslFn(/* wgsl */ `
fn particleSpawn(pos: ptr<storage, array<vec4f>, read_write>, vel: ptr<storage, array<vec4f>, read_write>,
                 bursts: ptr<storage, array<vec4f>, read>, idx: u32, nBursts: u32, seed: f32) -> void {
  let P = ${MAX_PARTICLES}u;
  for (var b = 0u; b < nBursts; b++) {
    let a = (*bursts)[b * 2u];
    let c = (*bursts)[b * 2u + 1u];
    let rel = (idx + P - u32(a.w)) % P;
    if (rel < u32(a.z)) {
      let h = f32(idx) * 1.618 + seed;
      let ang = phash(h) * 6.2831853;
      let spd = c.x * (0.3 + 0.7 * phash(h + 1.3));
      let r = c.z * sqrt(phash(h + 2.7));
      var v = vec3f(cos(ang) * spd, sin(ang) * spd, (phash(h + 3.1) - 0.5) * spd * 0.6);
      if (c.y >= 17.0) { v.y = abs(v.y) * 0.4 + 0.4; }
      let z = -${f(DEPTH * 0.5)} + (phash(h + 4.2) - 0.5) * ${f(DEPTH * 0.8)};
      (*pos)[idx] = vec4f(a.x + cos(ang) * r, a.y + sin(ang) * r, z, 0.6 + phash(h + 5.9) * 1.4);
      (*vel)[idx] = vec4f(v, c.y);
    }
  }
}
`, [particleHash]);

/** Ballistic debris that bounces off the density field; steam and flames rise and fade. */
export const particleStep = wgslFn(/* wgsl */ `
fn particleStep(pos: ptr<storage, array<vec4f>, read_write>, vel: ptr<storage, array<vec4f>, read_write>,
                solid: ptr<storage, array<f32>, read>, idx: u32, dt: f32) -> void {
  ${GRID}
  let C = ${f(CELL)};
  var p = (*pos)[idx];
  if (p.w <= 0.0) { return; }
  var v = (*vel)[idx];
  let buoyant = v.w >= 17.0;
  if (buoyant) {
    v.y += 1.2 * dt;
    v.x *= 0.98;
  } else {
    v.y -= 9.8 * dt;
  }
  var np = p.xyz + v.xyz * dt;
  let ci = i32(floor(np.x / C));
  let cj = i32(floor(np.y / C));
  var hit = cj < H;
  if (ci >= 0 && ci < W && cj >= 0 && cj < H) { hit = (*solid)[u32(cj * W + ci)] > 0.5; }
  if (hit) {
    let oi = i32(floor(p.x / C));
    let oj = i32(floor(p.y / C));
    if (ci != oi) { v.x = -v.x * 0.3; }
    if (cj != oj) { v.y = -v.y * 0.25; v.x *= 0.6; }
    if (ci == oi && cj == oj) { v.y = abs(v.y) + 0.5; }
    np = p.xyz;
    if (buoyant) { p.w -= 0.3; }
  }
  if (np.z < -${f(DEPTH - 0.05)} || np.z > 0.35) {
    v.z = -v.z * 0.5;
    np.z = clamp(np.z, -${f(DEPTH - 0.05)}, 0.35);
  }
  (*pos)[idx] = vec4f(np, p.w - dt);
  (*vel)[idx] = v;
}
`, [particleHash]);

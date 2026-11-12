import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { CELL, COLLAPSE_DELAY, CRACK_SHIFT, DEPTH, DIG_BIT, EXPLORED_BIT, H, REACH_BIT, SKY_ROWS, STRESS_MAX, STRESS_SHIFT, W } from '../config';
import { enabled } from '../debug';
import { GpuSim } from '../gpu/GpuSim';
import { noise2 } from '../gpu/kernels';
import { quality } from './quality';
import { boundaryWarp, crackMask, rockSurface } from './rock';

type Node = any;
// TSL's TypeScript typings don't model swizzles on storage elements; keep the node graph untyped.
const {
  abs, clamp, cross, dFdx, dFdy, dot, float, floor, fwidth, instanceIndex, int, max, mix, normalize,
  positionLocal, positionView, positionWorld, select, sign, sin, smoothstep, time, uint, uniform, uniformArray,
  varying, vec2, vec3, vertexIndex,
} = TSL as any;
const noise = (p: Node) => noise2({ p });

/** Base albedo per material id: air, dirt, granite, copper, ice, bedrock, rubble, junk. */
const MATERIAL_COLORS = ['#000000', '#7a5236', '#6f6c6a', '#8a5a3a', '#9fc8dc', '#2b2a2e', '#6b5644', '#5f6450']
  .map((c) => new THREE.Color(c));
/** Particle colors: the materials, then spark, steam, flame (HDR values feed the bloom pass). */
const PARTICLE_COLORS = [...MATERIAL_COLORS, new THREE.Color(4, 2.2, 0.7), new THREE.Color(0.75, 0.78, 0.8), new THREE.Color(4, 1.4, 0.3)];

export const overlayMode = uniform(0, 'int');
/** Materials shown by the material layer, one bit per material id. */
export const materialMask = uniform(0xfe, 'uint');
/** High-contrast pastels for the material layer, by material id (also used by the HUD key). */
export const MATERIAL_KEY = [
  { id: 1, name: 'Dirt', color: '#f2d79a' },
  { id: 2, name: 'Granite', color: '#9db8ff' },
  { id: 3, name: 'Copper ore', color: '#ff9a6b' },
  { id: 4, name: 'Ice', color: '#a6f2ff' },
  { id: 5, name: 'Bedrock', color: '#c9c9d6' },
  { id: 6, name: 'Rubble', color: '#e2a8ff' },
  { id: 7, name: 'Junk', color: '#b4f59a' },
];
const PASTELS = Array.from({ length: 8 }, (_, id) => new THREE.Color(MATERIAL_KEY.find((m) => m.id === id)?.color ?? '#000000'));
/** Game clock (seconds), which crack start times in digMark are measured against. */
export const gameTime = uniform(0);
const surfaceY = (H - SKY_ROWS - 2) * CELL;

/** Storage-buffer index of the cell under a world position. */
function cellAt(p: Node) {
  const i = clamp(floor(p.x.div(CELL)), 0, W - 1);
  const j = clamp(floor(p.y.div(CELL)), 0, H - 1);
  return uint(j.mul(W).add(i));
}

/** Mean albedo per material for the low tier (linear; matches rockSurface's averages). */
const LOW_COLORS = [[0, 0, 0], [0.2, 0.12, 0.065], [0.16, 0.155, 0.15], [0.2, 0.1, 0.05], [0.5, 0.7, 0.8],
  [0.035, 0.033, 0.04], [0.22, 0.18, 0.14], [0.14, 0.15, 0.11]].map(([r, g, b]) => new THREE.Color(r, g, b));

/** Rock albedo (xyz) and bump height (w). The low tier swaps the 3D shading for two octaves of 2D noise. */
function rock(p: Node, mat: Node) {
  if (!quality.low) return rockSurface({ p, mat });
  const n = noise(p.xy.mul(2.3)).mul(0.65).add(noise(p.xy.mul(9.1)).mul(0.35));
  return TSL.vec4(uniformArray(LOW_COLORS, 'color').element(int(mat)).mul(n.mul(0.25).add(1)), 0);
}

function warpOffset(p: Node) {
  if (!quality.low) return boundaryWarp({ p });
  return vec2(noise(p.xy.mul(3)), noise(p.xy.mul(3).add(11.3))).mul(0.5);
}

/**
 * Perturbs the flat face normal by a procedural height field (world units), using screen-space
 * derivatives so no tangent frame or UVs are needed.
 */
function bumpNormal(height: Node) {
  const pv = positionView;
  const sx = dFdx(pv), sy = dFdy(pv);
  const n0 = normalize(cross(sx, sy));
  const n = select(dot(n0, pv).greaterThan(0), n0.negate(), n0);
  const r1 = cross(sy, n), r2 = cross(n, sx);
  const det = dot(sx, r1);
  const grad = r1.mul(dFdx(height)).add(r2.mul(dFdy(height))).mul(sign(det));
  return normalize(n.mul(abs(det)).sub(grad));
}

/**
 * Fog of war: 1 where explored, 0 in unexplored rock. Explored flags are blended bilinearly
 * between cell centres and the lookup point drifts with slow noise, so the edge reads as
 * wisps of haze rather than cell squares.
 */
function explored(gpu: GpuSim, p: Node) {
  const marks = gpu.digMark.ro();
  const drift = vec2(noise(p.xy.mul(0.9).add(time.mul(0.05))), noise(p.xy.mul(0.9).add(vec2(7.1, time.mul(0.04))))).mul(0.6);
  const q = p.xy.add(drift);
  const fx = q.x.div(CELL).sub(0.5), fy = q.y.div(CELL).sub(0.5);
  const i = clamp(floor(fx), 0, W - 2), j = clamp(floor(fy), 0, H - 2);
  const tx = clamp(fx.sub(i), 0, 1), ty = clamp(fy.sub(j), 0, 1);
  const at = (di: number, dj: number) =>
    select(marks.element(uint(j.add(dj).mul(W).add(i.add(di)))).bitAnd(uint(EXPLORED_BIT)).greaterThan(uint(0)), float(1), float(0));
  return smoothstep(0.05, 0.95, mix(mix(at(0, 0), at(1, 0), tx), mix(at(0, 1), at(1, 1), tx), ty));
}

/** Near-black for unexplored rock, with a faint cold haze glowing along the fog's edge. */
const FOG = vec3(0.004, 0.005, 0.007);
function fogHaze(p: Node, vis: Node) {
  return vec3(0.008, 0.01, 0.013).mul(vis.mul(vis.oneMinus()).mul(4)).mul(noise(p.xy.mul(1.4).add(time.mul(0.1))).mul(0.5).add(0.6));
}

/** 0 → 1 over the warning period of a cell that is cracking ahead of a cave-in; 0 when sound. */
function crackProgress(mark: Node) {
  const start = mark.shiftRight(uint(CRACK_SHIFT));
  const elapsed = gameTime.mul(10).sub(float(start).sub(1)).div(COLLAPSE_DELAY * 10);
  return select(start.greaterThan(uint(0)), clamp(elapsed, 0, 1), float(0));
}

export function terrainMaterial(gpu: GpuSim) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  m.flatShading = true;
  const slot = gpu.meshPos.ro().element(vertexIndex);
  m.positionNode = slot.xyz;
  const code = varying(slot.w).add(0.5).floor();
  if (!enabled('meshfx')) { m.colorNode = vec3(0.5, 0.4, 0.3); return m; }
  // Cracking rock trembles harder as its deadline approaches. Shared vertices sit in the same
  // cell, so neighbouring polygons move together and the surface never tears.
  const vpr = crackProgress(gpu.digMark.ro().element(cellAt(slot.xyz)));
  m.positionNode = slot.xyz.add(vec3(sin(time.mul(61).add(slot.x.mul(13))), sin(time.mul(47).add(slot.y.mul(17))), 0).mul(vpr.mul(vpr).mul(0.02)));

  const p = positionWorld;
  const isWall = code.greaterThanEqual(16);
  const own = select(isWall, code.sub(16), code);
  // Look the material up through a noisy offset so boundaries between rock types meander
  // instead of following the cell grid. Offsets that land in open air keep the cell's own material.
  const k = cellAt(p);
  const kw = cellAt(p.xy.add(warpOffset(p).mul(CELL * 1.4)));
  const warped = gpu.mat.ro().element(kw);
  const mid = select(warped.equal(0), uint(own), warped);
  const mark = gpu.digMark.ro().element(select(warped.equal(0), k, kw));
  const surf = rock(p, mid);
  let col: Node = surf.xyz;

  // Cutaway face shows faint sediment bedding; walls recede into shadow.
  const bedding = sin(p.y.mul(2.3).add(noise(p.xy.mul(0.4)).mul(3))).mul(0.5).add(0.5);
  col = select(isWall, col.mul(mix(1, 0.5, clamp(p.z.negate().div(DEPTH), 0, 1))), col.mul(mix(0.93, 1.05, bedding)));
  // Deeper is darker.
  col = col.mul(mix(0.55, 1, smoothstep(0, surfaceY, p.y)));

  // Dig orders: fine diagonal hatching, amber where drones can get at it, red where they can't
  // yet. fwidth keeps the lines anti-aliased and fades them to a flat tint when zoomed out.
  const u = p.x.add(p.y).mul(11);
  const hatch = smoothstep(float(0.35).sub(fwidth(u)), fwidth(u).add(0.35), abs(u.fract().sub(0.5)));
  const reachable = mark.bitAnd(uint(REACH_BIT)).greaterThan(uint(0));
  const orderTint = select(reachable, vec3(1.0, 0.72, 0.1), vec3(0.95, 0.12, 0.08));
  const ordered = mark.bitAnd(uint(DIG_BIT)).greaterThan(uint(0)).and(isWall.not());
  col = select(ordered, mix(col, orderTint, hatch.mul(0.6).add(0.12)), col);

  // Rock about to cave in pales with dust, then splits along dark fractures that glow faintly.
  // Visible from the first second: a clear set of fractures and a dust pall that both grow.
  const pr = crackProgress(mark);
  const cracking = select(mark.shiftRight(uint(CRACK_SHIFT)).greaterThan(uint(0)), float(1), float(0));
  const crack = quality.low
    ? select(pr.greaterThan(0), float(1).sub(smoothstep(0, mix(0.04, 0.12, pr), abs(noise(p.xy.mul(3))))), float(0))
    : crackMask({ p, progress: max(pr, 0.001).mul(cracking) });
  col = mix(col, col.mul(1.6).add(0.04), cracking.mul(pr.mul(0.25).add(0.15)));
  col = col.mul(crack.mul(-0.85).add(1));
  // Cracking rock always shows through the fog.
  const vis = max(explored(gpu, p), cracking);
  m.colorNode = mix(FOG, col, vis);
  if (!quality.low) m.normalNode = bumpNormal(surf.w.sub(crack.mul(0.012)));
  // Ice and copper flecks catch the light a little.
  m.roughnessNode = select(mid.equal(4), float(0.35), select(mid.equal(3), float(0.6), float(0.92)));

  const T = gpu.temp[0].ro().element(k);
  const pulse = sin(time.mul(pr.mul(12).add(3))).mul(0.45).add(0.55).mul(pr.mul(0.6).add(0.4)).mul(cracking);
  m.emissiveNode = vec3(1.0, 0.3, 0.06).mul(smoothstep(160, 900, T).mul(2.2))
    .add(vec3(1.0, 0.32, 0.05).mul(crack.mul(pulse).mul(0.9)))
    .add(vec3(0.35, 0.04, 0).mul(pulse.mul(0.5)))
    .mul(vis).add(fogHaze(p, vis));
  return m;
}

function fluidAt(gpu: GpuSim, p: Node) {
  // Bilinear sample between cell centers.
  const buf = gpu.fluid[0].ro();
  const fx = p.x.div(CELL).sub(0.5), fy = p.y.div(CELL).sub(0.5);
  const i = clamp(floor(fx), 0, W - 2), j = clamp(floor(fy), 0, H - 2);
  const tx = clamp(fx.sub(i), 0, 1), ty = clamp(fy.sub(j), 0, 1);
  const at = (di: number, dj: number) => buf.element(uint(j.add(dj).mul(W).add(i.add(di))));
  return mix(mix(at(0, 0), at(1, 0), tx), mix(at(0, 1), at(1, 1), tx), ty);
}

/** One translucent slice of the fluid volume; several are stacked through the diorama depth. */
export function fluidMaterial(gpu: GpuSim, layer: number) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const p = positionWorld;
  const wobble = vec2(noise(p.xy.mul(2).add(time.mul(0.4)).add(layer * 7)), 0).mul(0.06);
  const f = fluidAt(gpu, p.xy.add(wobble));
  const above = fluidAt(gpu, p.xy.add(vec2(0, CELL * 0.8)));

  const aw = smoothstep(0.03, 0.35, f.x).mul(0.45);
  const am = smoothstep(0.03, 0.3, f.y).mul(0.95);
  const at = smoothstep(0.02, 0.9, f.w).mul(0.3);
  const surface = smoothstep(0.25, 0.0, above.x).mul(aw).mul(1.6);
  const lava = noise(vec2(p.x.mul(3).add(time.mul(0.2)), p.y.mul(3).sub(time.mul(0.3))));
  const water = vec3(0.12, 0.42, 0.85).add(surface);
  const magma = mix(vec3(2.5, 0.6, 0.08), vec3(5, 2.2, 0.4), lava.mul(0.5).add(0.5));
  const toxic = vec3(0.45, 0.85, 0.2);
  const alpha = clamp(aw.add(am).add(at), 0, 1);
  m.colorNode = water.mul(aw).add(magma.mul(am)).add(toxic.mul(at)).div(max(alpha, 0.001));
  m.opacityNode = alpha.mul(explored(gpu, p));
  return m;
}

/** Diagnostic overlay drawn in front of the cutaway: 1 temperature, 2 oxygen, 3 structural integrity, 4 materials. */
export function overlayMaterial(gpu: GpuSim) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false });
  const p = positionWorld;
  const k = cellAt(p);
  const T = gpu.temp[0].ro().element(k);
  const f = gpu.fluid[0].ro().element(k);
  const solid = gpu.solid.ro().element(k).greaterThan(0.5);
  // Blue (freezing) → green (critter-comfortable 10–35°C) → yellow → red (100°C and up).
  let heat: Node = mix(vec3(0.15, 0.3, 1.0), vec3(0.1, 0.85, 0.35), smoothstep(0, 12, T));
  heat = mix(heat, vec3(1.0, 0.85, 0.1), smoothstep(32, 50, T));
  heat = mix(heat, vec3(1.0, 0.1, 0.05), smoothstep(60, 140, T));
  const o2 = mix(vec3(0.9, 0.1, 0.1), vec3(0.2, 0.7, 1.0), clamp(f.z, 0, 1));
  const tox = f.w.greaterThan(0.1);
  // Integrity: sound rock green, stressed ceilings through yellow to red, cracking rock flashing.
  const mark = gpu.digMark.ro().element(k);
  const stress = float(mark.shiftRight(uint(STRESS_SHIFT)).bitAnd(uint(STRESS_MAX))).div(STRESS_MAX);
  const cracking = mark.shiftRight(uint(CRACK_SHIFT)).greaterThan(uint(0));
  let integrity: Node = mix(vec3(0.15, 0.75, 0.3), vec3(1.0, 0.85, 0.1), smoothstep(0.3, 0.65, stress));
  integrity = mix(integrity, vec3(1.0, 0.12, 0.05), smoothstep(0.7, 0.95, stress));
  const flash = sin(time.mul(10)).mul(0.5).add(0.5);
  integrity = select(cracking, mix(vec3(1.0, 0.1, 0.4), vec3(1.0, 1.0, 1.0), flash.mul(0.5)), integrity);
  const integrityAlpha = select(solid, select(cracking, float(0.8), stress.mul(0.5).add(0.2)), float(0));
  // Materials: looked up through the same warp as the terrain so the colours match its boundaries.
  const warped = gpu.mat.ro().element(cellAt(p.xy.add(warpOffset(p).mul(CELL * 1.4))));
  const mat = select(warped.equal(uint(0)), gpu.mat.ro().element(k), warped);
  const shown = materialMask.shiftRight(mat).bitAnd(uint(1)).equal(uint(1));
  const materialColor = uniformArray(PASTELS, 'color').element(int(mat));
  const materialAlpha = select(solid.and(shown).and(mat.greaterThan(uint(0))), float(0.85), float(0));
  m.colorNode = select(overlayMode.equal(1), heat, select(overlayMode.equal(3), integrity, select(overlayMode.equal(4), materialColor,
    select(tox, vec3(0.5, 0.9, 0.1), o2))));
  const alpha = select(overlayMode.equal(0), float(0), select(overlayMode.equal(3), integrityAlpha, select(overlayMode.equal(4), materialAlpha,
    select(overlayMode.equal(2).and(solid), float(0.08), float(0.55)))));
  m.opacityNode = alpha.mul(explored(gpu, p));
  return m;
}

export function backWallMaterial(gpu: GpuSim) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  const p = positionWorld;
  const surf = rock(p, uint(1));
  const wall = surf.xyz.mul(0.7).mul(mix(0.4, 1, smoothstep(0, surfaceY, p.y)));
  const skyMix = smoothstep(surfaceY + 0.2, surfaceY + 0.8, p.y.add(noise(vec2(p.x.mul(0.5), 0)).mul(0.4)));
  const vis = explored(gpu, p);
  m.colorNode = mix(FOG, mix(wall, vec3(0), skyMix), vis);
  m.emissiveNode = mix(vec3(0), mix(vec3(0.75, 0.55, 0.4), vec3(0.3, 0.45, 0.75), smoothstep(surfaceY, surfaceY + 3, p.y)), skyMix)
    .mul(vis).add(fogHaze(p, vis));
  if (!quality.low) m.normalNode = bumpNormal(surf.w);
  return m;
}

/**
 * Weathered metal: blotchy rust patches, rust streaks running down from them, and pitting, over a
 * base colour. Rusty areas go rough and lose their shine. `tint` is the corrosion colour pair
 * (dark, light), e.g. orange-brown rust or green verdigris on copper.
 */
export function rustMaterial(base: string, amount = 0.5, tint: [string, string] = ['#5a2410', '#9a4a1c']) {
  const { color: tslColor } = TSL as any;
  const m = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld;
  const blotch = noise(p.xy.mul(3.3).add(p.z.mul(2.1))).mul(0.5).add(0.5).add(noise(p.xy.mul(13).add(p.z.mul(7))).mul(0.18));
  const patches = smoothstep(0.85 - amount * 0.6, 0.95 - amount * 0.5, blotch);
  // Drips: long thin noise along the vertical, strongest just below the patches.
  const drip = smoothstep(0.5, 0.85, noise(vec2(p.x.mul(30).add(p.z.mul(11)), p.y.mul(1.3))).mul(0.5).add(0.5)).mul(amount);
  const corrosion = clamp(patches.add(drip.mul(0.7)), 0, 1);
  const rustColor = mix(tslColor(tint[0]), tslColor(tint[1]), noise(p.xy.mul(45).add(p.z.mul(20))).mul(0.5).add(0.5));
  const pits = smoothstep(0.72, 0.9, noise(p.xy.mul(70).add(p.z.mul(31))).mul(0.5).add(0.5)).mul(0.35);
  m.colorNode = mix(tslColor(base), rustColor, corrosion).mul(pits.oneMinus());
  m.roughnessNode = mix(float(0.62), float(0.95), corrosion);
  m.metalnessNode = mix(float(0.45), float(0.05), corrosion);
  if (!quality.low) m.normalNode = bumpNormal(corrosion.mul(0.0015).sub(pits.mul(0.002)));
  return m;
}

/** Firebrick: staggered courses with recessed mortar, each brick a slightly different shade. */
export function brickMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const p = positionWorld;
  const rowH = 0.055, brickW = 0.11;
  const row = floor(p.y.div(rowH));
  const u = p.x.add(p.z).div(brickW).add(row.mul(0.5));
  const mortar = smoothstep(0.06, 0.1, abs(u.fract().sub(0.5)).mul(-1).add(0.5)).mul(smoothstep(0.06, 0.12, abs(p.y.div(rowH).fract().sub(0.5)).mul(-1).add(0.5)));
  const shade = noise(vec2(floor(u), row).mul(1.7)).mul(0.15).add(1);
  m.colorNode = mix(vec3(0.12, 0.11, 0.1), vec3(0.32, 0.12, 0.07).mul(shade), mortar);
  if (!quality.low) m.normalNode = bumpNormal(mortar.mul(0.004));
  return m;
}

/**
 * Grout poured under and over strut plates: mottled grey cement with faint horizontal pour lines.
 */
let grout: THREE.MeshStandardNodeMaterial | null = null;
export function groutMaterial() {
  if (grout) return grout;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const p = positionWorld;
  const mottle = noise(p.xy.mul(14).add(p.z.mul(9))).mul(0.5).add(noise(p.xy.mul(41)).mul(0.25));
  const pour = smoothstep(0.85, 1, sin(p.y.mul(90)).mul(0.5).add(0.5)).mul(0.06);
  m.colorNode = vec3(0.36, 0.35, 0.33).mul(mottle.mul(0.18).add(1).sub(pour));
  if (!quality.low) m.normalNode = bumpNormal(mottle.mul(0.004));
  grout = m;
  return m;
}

/**
 * See-through placement preview: rising scanlines, bright silhouette edges and a faint flicker,
 * drawn additively. Set `tint` to recolour it (cyan for a valid site, red for an invalid one).
 */
export function hologramMaterial() {
  const { color, normalView, positionViewDirection } = TSL as any;
  const tint = uniform(color('#5fe3ff'));
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const scan = smoothstep(0.55, 0.95, sin(positionWorld.y.mul(60).sub(time.mul(6))).mul(0.5).add(0.5));
  const rim = float(1).sub(abs(dot(normalView, positionViewDirection))).pow(2);
  const flicker = sin(time.mul(37)).mul(sin(time.mul(11))).mul(0.08).add(0.92);
  m.colorNode = tint.mul(1.4);
  m.opacityNode = scan.mul(0.35).add(rim.mul(0.6)).add(0.12).mul(flicker);
  return { material: m, tint };
}

export function particleMaterial(gpu: GpuSim) {
  // Particles don't write depth: thousands of specks in the depth buffer make ambient occlusion
  // smudge shadows over the rock wherever drones are drilling.
  const m = new THREE.MeshBasicNodeMaterial({ depthWrite: false });
  const pos = gpu.pPos.ro().element(instanceIndex);
  const vel = gpu.pVel.ro().element(instanceIndex);
  const kind = int(vel.w);
  const big = kind.greaterThanEqual(9);
  const size = select(pos.w.greaterThan(0), select(big, float(0.09), float(0.045)).mul(clamp(pos.w.mul(2), 0, 1)), float(0));
  m.positionNode = positionLocal.mul(size).add(pos.xyz);
  m.colorNode = uniformArray(PARTICLE_COLORS, 'color').element(kind);
  return m;
}

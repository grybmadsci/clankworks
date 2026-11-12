import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { CELL, DEPTH, H, SKY_ROWS, W } from '../config';
import { enabled } from '../debug';
import { GpuSim } from '../gpu/GpuSim';
import { noise2 } from '../gpu/kernels';
import { quality } from './quality';

type Node = any;
// TSL's TypeScript typings don't model swizzles on storage elements; keep the node graph untyped.
const {
  abs, clamp, cross, dFdx, dFdy, float, floor, instanceIndex, int, max, mix, normalize,
  positionLocal, positionWorld, pow, select, sin, smoothstep, time, uint, uniform, uniformArray, varying,
  vec2, vec3, vertexIndex,
} = TSL as any;
const noise = (p: Node) => noise2({ p });

/** Base albedo per material id: air, dirt, granite, copper, ice, bedrock, rubble, junk. */
const MATERIAL_COLORS = ['#000000', '#7a5236', '#6f6c6a', '#8a5a3a', '#9fc8dc', '#2b2a2e', '#6b5644', '#5f6450']
  .map((c) => new THREE.Color(c));
/** Particle colors: the materials, then spark, steam, flame (HDR values feed the bloom pass). */
const PARTICLE_COLORS = [...MATERIAL_COLORS, new THREE.Color(4, 2.2, 0.7), new THREE.Color(0.75, 0.78, 0.8), new THREE.Color(4, 1.4, 0.3)];

export const overlayMode = uniform(0, 'int');
const surfaceY = (H - SKY_ROWS - 2) * CELL;

/** Storage-buffer index of the cell under a world position. */
function cellAt(p: Node) {
  const i = clamp(floor(p.x.div(CELL)), 0, W - 1);
  const j = clamp(floor(p.y.div(CELL)), 0, H - 1);
  return uint(j.mul(W).add(i));
}

/** Procedural rock texture projected along X, Y and Z and blended by the surface normal. */
function triplanar(p: Node, n: Node, seed: Node) {
  if (quality.low) return noise(p.xy.mul(3.1).add(seed));
  const w0 = pow(abs(n), vec3(4));
  const w = w0.div(w0.x.add(w0.y).add(w0.z));
  const tex = (a: Node, b: Node) => noise(vec2(a, b).mul(3.1).add(seed));
  return tex(p.y, p.z).mul(w.x).add(tex(p.x, p.z).mul(w.y)).add(tex(p.x, p.y).mul(w.z));
}

export function terrainMaterial(gpu: GpuSim) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  m.flatShading = true;
  const slot = gpu.meshPos.ro().element(vertexIndex);
  m.positionNode = slot.xyz;
  const code = varying(slot.w).add(0.5).floor();
  if (!enabled('meshfx')) { m.colorNode = vec3(0.5, 0.4, 0.3); return m; }

  const p = positionWorld;
  const isWall = code.greaterThanEqual(16);
  const mid = select(isWall, code.sub(16), code);
  const n = normalize(cross(dFdx(p), dFdy(p)));
  const base = uniformArray(MATERIAL_COLORS, 'color').element(int(mid));
  const tex = triplanar(p, n, mid.mul(7.3));
  let col: Node = base.mul(tex.mul(0.35).add(0.85));

  // Cutaway face shows sediment strata like an ant farm; walls recede into shadow.
  const strata = sin(p.y.mul(9).add(noise(p.xy.mul(0.7)).mul(5))).mul(0.5).add(0.5);
  col = select(isWall, col.mul(mix(1, 0.5, clamp(p.z.negate().div(DEPTH), 0, 1))), col.mul(mix(0.8, 1.1, strata)));
  // Copper glints and fossil junk speckles.
  if (!quality.low) {
    const speck = smoothstep(0.55, 0.75, noise(p.xy.mul(14).add(p.z.mul(9))));
    col = select(mid.equal(3), mix(col, vec3(1.0, 0.55, 0.25), speck), col);
    col = select(mid.equal(7), mix(col, vec3(0.35, 0.6, 0.55), speck), col);
  }
  // Deeper is darker.
  col = col.mul(mix(0.55, 1, smoothstep(0, surfaceY, p.y)));

  const k = cellAt(p);
  const dig = gpu.digMark.ro().element(k);
  const stripes = smoothstep(0.45, 0.55, abs(p.x.add(p.y).mul(3).fract().sub(0.5)).mul(2));
  col = select(dig.greaterThan(0).and(isWall.not()), mix(col, vec3(0.95, 0.75, 0.15), stripes.mul(0.55)), col);
  m.colorNode = col;

  const T = gpu.temp[0].ro().element(k);
  m.emissiveNode = vec3(1.0, 0.3, 0.06).mul(smoothstep(160, 900, T).mul(2.2));
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
  m.opacityNode = alpha;
  return m;
}

/** Diagnostic overlay drawn in front of the cutaway: 1 = temperature, 2 = oxygen. */
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
  m.colorNode = select(overlayMode.equal(1), heat, select(tox, vec3(0.5, 0.9, 0.1), o2));
  m.opacityNode = select(overlayMode.equal(0), float(0), select(overlayMode.equal(2).and(solid), float(0.08), float(0.55)));
  return m;
}

export function backWallMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  const p = positionWorld;
  const tex = triplanar(p, vec3(0, 0, 1), float(1.7));
  const rock = vec3(0.2, 0.17, 0.15).mul(tex.mul(0.4).add(0.8)).mul(mix(0.4, 1, smoothstep(0, surfaceY, p.y)));
  const skyMix = smoothstep(surfaceY + 0.2, surfaceY + 0.8, p.y.add(noise(vec2(p.x.mul(0.5), 0)).mul(0.4)));
  m.colorNode = mix(rock, vec3(0), skyMix);
  m.emissiveNode = mix(vec3(0), mix(vec3(0.75, 0.55, 0.4), vec3(0.3, 0.45, 0.75), smoothstep(surfaceY, surfaceY + 3, p.y)), skyMix);
  return m;
}

export function particleMaterial(gpu: GpuSim) {
  const m = new THREE.MeshBasicNodeMaterial();
  const pos = gpu.pPos.ro().element(instanceIndex);
  const vel = gpu.pVel.ro().element(instanceIndex);
  const kind = int(vel.w);
  const big = kind.greaterThanEqual(9);
  const size = select(pos.w.greaterThan(0), select(big, float(0.09), float(0.045)).mul(clamp(pos.w.mul(2), 0, 1)), float(0));
  m.positionNode = positionLocal.mul(size).add(pos.xyz);
  m.colorNode = uniformArray(PARTICLE_COLORS, 'color').element(kind);
  return m;
}

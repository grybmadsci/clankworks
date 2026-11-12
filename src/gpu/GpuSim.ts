import type { WebGPURenderer } from 'three/webgpu';
import { IndirectStorageBufferAttribute, StorageInstancedBufferAttribute } from 'three/webgpu';
import { instanceIndex, storage, uniform } from 'three/tsl';
import { enabled } from '../debug';
import { CELLS, MAX_BURSTS, MAX_EMITTERS, MAX_PARTICLES } from '../config';
import type { EmitterDef } from '../sim/worldgen';
import type { Terrain } from '../sim/terrain';
import { MESH_CAPACITY, fluidStep, meshBegin, meshCell, meshEnd, particleSpawn, particleStep, thermalStep } from './kernels';

const STEP = 1 / 120;

export const enum ParticleKind {
  Spark = 8,
  Steam = 9,
  Flame = 10,
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

/**
 * Owns every GPU-resident simulation buffer and the compute dispatches that advance them.
 * Terrain density/material are mirrored from the CPU (which stays authoritative for physics);
 * fluids, heat, the render mesh, and particles live only on the GPU and are read back
 * occasionally for gameplay checks.
 */
export class GpuSim {
  readonly solid: Buf;
  readonly mat: Buf;
  readonly digMark: Buf;
  readonly fluid: [Buf, Buf];
  readonly temp: [Buf, Buf];
  readonly meshPos: Buf;
  /** Indirect draw arguments for the terrain mesh, written entirely on the GPU. */
  readonly meshDrawArgs = new IndirectStorageBufferAttribute(new Uint32Array([0, 1, 0, 0]), 1);
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
    this.pPos = new Buf(MAX_PARTICLES, 'vec4');
    this.pVel = new Buf(MAX_PARTICLES, 'vec4');
    this.emit = new Buf(this.emitData, 'vec4');
    this.bursts = new Buf(this.burstData, 'vec4');
    this.fluidSnapshot = new Float32Array(fluid0);
    this.tempSnapshot = new Float32Array(temp0);

    const fluidStepNode = (a: number, b: number) =>
      fluidStep({ src: this.fluid[a].ro(), dst: this.fluid[b].rw(), solid: this.solid.ro(), temp: this.temp[a].ro(), emit: this.emit.ro(), idx: instanceIndex, nEmit: this.nEmit }).compute(CELLS, [64]);
    const thermalStepNode = (a: number, b: number) =>
      thermalStep({ src: this.temp[a].ro(), dst: this.temp[b].rw(), fluid: this.fluid[b].ro(), solid: this.solid.ro(), mat: this.mat.ro(), emit: this.emit.ro(), idx: instanceIndex, nEmit: this.nEmit }).compute(CELLS, [64]);
    // A→B then B→A, so buffer 0 always holds the current state between frames.
    this.stepNodes = [fluidStepNode(0, 1), thermalStepNode(0, 1), fluidStepNode(1, 0), thermalStepNode(1, 0)];
    const drawArgs = () => storage(this.meshDrawArgs, 'uint', 4).toAtomic();
    this.meshNodes = [
      meshBegin({ drawArgs: drawArgs() }).compute(1),
      meshCell({ solid: this.solid.ro(), mat: this.mat.ro(), outPos: this.meshPos.rw(), drawArgs: drawArgs(), idx: instanceIndex }).compute(CELLS, [64]),
      meshEnd({ drawArgs: drawArgs() }).compute(1),
    ];
    this.spawnNode = particleSpawn({ pos: this.pPos.rw(), vel: this.pVel.rw(), bursts: this.bursts.ro(), idx: instanceIndex, nBursts: this.nBursts, seed: this.seed }).compute(MAX_PARTICLES, [64]);
    this.particleNode = particleStep({ pos: this.pPos.rw(), vel: this.pVel.rw(), solid: this.solid.ro(), idx: instanceIndex, dt: this.dt }).compute(MAX_PARTICLES, [64]);
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

  update(dt: number) {
    if (!enabled('sim')) return;
    const r = this.renderer;
    if (this.terrain.gpuDirty) {
      this.terrain.gpuDirty = false;
      this.solid.upload();
      this.mat.upload();
      this.digMark.upload();
      for (const node of this.meshNodes) r.compute(node);
    }
    // Fixed-rate stepping, always in A→B→A pairs.
    this.accumulator = Math.min(this.accumulator + dt, STEP * 6);
    while (this.accumulator >= STEP * 2) {
      this.accumulator -= STEP * 2;
      for (const node of this.stepNodes) r.compute(node);
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

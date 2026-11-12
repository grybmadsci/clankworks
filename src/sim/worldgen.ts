import { CELL, CHUNK, EXPLORED_BIT, Emit, H, Mat, SKY_ROWS, W, cellIndex } from '../config';
import { makeNoise2, mulberry32 } from './rng';
import { Terrain } from './terrain';

/** Emitter position and radius are in cell units; rate is per GPU step (or target °C for heat). */
export interface EmitterDef { x: number; y: number; radius: number; type: Emit; rate: number }

/** Fluid channel indices: water, magma, oxygen, toxic gas. */
const WATER = 0, MAGMA = 1, OXYGEN = 2, TOXIC = 3;

/**
 * World features are planned once from the seed, then applied to each chunk as it is generated,
 * in plan order, so a chunk comes out the same no matter when or in what order it is built.
 */
type Feature =
  | { kind: 'ellipse'; ci: number; cj: number; rx: number; ry: number; shell?: Mat; fill?: number }
  /** Flatten a floor: solid rock below `floorJ`, open air for a few rows above it. */
  | { kind: 'floor'; i0: number; i1: number; j0: number; floorJ: number; openI0: number; openI1: number }
  | { kind: 'ore'; i0: number; i1: number; j0: number; j1: number; threshold: number };

export interface WorldLayout {
  seed: number;
  surfaceRow: number;
  startJ: number;
  /** Row of the start cavern's flat floor (first open row). */
  floorJ: number;
  depot: { x: number; y: number };
  carl: { x: number; y: number };
  terrarium: { x: number; y: number; w: number; h: number };
  strutCols: number[];
  emitters: EmitterDef[];
  /** Height (world units) of the ground surface above the base, where the intro drill starts. */
  surfaceY: number;
}

/** Background rock temperature by row: cool near the surface, hot near the bedrock. */
export function geotherm(j: number) {
  return 14 + (1 - j / H) * 70;
}

const wx = (i: number) => (i + 0.5) * CELL;

export class WorldGen {
  readonly layout: WorldLayout;
  private readonly features: (Feature & { box: [number, number, number, number] })[] = [];
  private readonly nA: (x: number, y: number) => number;
  private readonly nB: (x: number, y: number) => number;
  private readonly nC: (x: number, y: number) => number;
  private readonly nD: (x: number, y: number) => number;

  constructor(seed = 1337) {
    const rand = mulberry32(seed);
    this.nA = makeNoise2(seed + 1); this.nB = makeNoise2(seed + 2); this.nC = makeNoise2(seed + 3); this.nD = makeNoise2(seed + 4);
    const surfaceRow = H - SKY_ROWS - 2;
    const i0 = W / 2;
    // The base drills its own shaft down to the start cavern (see Game's intro), 30m deep.
    const startJ = surfaceRow - 120;
    const floorJ = startJ - 4;
    const terrJ = startJ + 1;
    const emitters: EmitterDef[] = [];
    const ellipse = (ci: number, cj: number, rx: number, ry: number, shell?: Mat, fill?: number) =>
      this.add({ kind: 'ellipse', ci, cj, rx, ry, shell, fill });
    const tunnel = (ia: number, ja: number, ib: number, jb: number, r: number, fill?: number) => {
      const steps = Math.ceil(Math.hypot(ib - ia, jb - ja));
      for (let s = 0; s <= steps; s++) ellipse(ia + (ib - ia) * (s / steps), ja + (jb - ja) * (s / steps), r, r, undefined, fill);
    };

    // Starting cavern with a flat floor, and Carl's alcove.
    ellipse(i0, startJ, 15, 7, Mat.Granite);
    this.add({ kind: 'floor', i0: i0 - 12, i1: i0 + 12, j0: startJ - 9, floorJ, openI0: i0 - 11, openI1: i0 + 11 });
    ellipse(i0 - 17, startJ - 2, 4, 3);
    this.add({ kind: 'ore', i0: i0 + 18, i1: i0 + 32, j0: startJ - 10, j1: startJ + 8, threshold: 0.45 });
    // The critters' cave, joined to Carl's alcove by a narrow tunnel. Kept narrow enough (18 cells
    // under a granite roof that holds 26) that the start area raises no structural warnings.
    ellipse(i0 - 42, terrJ, 9, 5, Mat.Granite, OXYGEN);
    tunnel(i0 - 30, terrJ - 2, i0 - 20, startJ - 2, 1.6, OXYGEN);
    emitters.push({ x: i0 - 42, y: terrJ, radius: 5, type: Emit.Oxygen, rate: 0.02 });
    // Toxic pocket under the terrarium and an aquifer with an ice rim to the right.
    ellipse(i0 - 38, terrJ - 24, 8, 4, Mat.Granite, TOXIC);
    emitters.push({ x: i0 - 38, y: terrJ - 24, radius: 3, type: Emit.Toxic, rate: 0.01 });
    ellipse(i0 + 36, startJ - 40, 11, 6, Mat.Ice, WATER);
    emitters.push({ x: i0 + 36, y: startJ - 40, radius: 3, type: Emit.Water, rate: 0.01 });

    // The wider world: voids, ore veins, aquifers, gas pockets, and magma at depth.
    // Keep random features clear of the start and of the column the base drills down.
    const nearStart = (ci: number, cj: number, r: number) =>
      Math.hypot(ci - i0, cj - startJ) < r || (Math.abs(ci - i0) < 24 && cj > startJ);
    const spot = (jLo: number, jHi: number, keepOut: number) => {
      for (;;) {
        const ci = 16 + rand() * (W - 32), cj = jLo + rand() * (jHi - jLo);
        if (!nearStart(ci, cj, keepOut)) return [ci, cj];
      }
    };
    for (let n = 0; n < 16; n++) {
      const [ci, cj] = spot(40, surfaceRow - 30, 70);
      this.add({ kind: 'ore', i0: Math.round(ci - 8), i1: Math.round(ci + 8), j0: Math.round(cj - 10), j1: Math.round(cj + 10), threshold: 0.45 });
    }
    for (let n = 0; n < 110; n++) {
      const [ci, cj] = spot(30, surfaceRow - 16, 48);
      ellipse(ci, cj, 3 + rand() * 6, 2 + rand() * 3.5, Mat.Granite);
    }
    for (let n = 0; n < 7; n++) {
      const [ci, cj] = spot(200, surfaceRow - 60, 60);
      ellipse(ci, cj, 7 + rand() * 6, 4 + rand() * 3, Mat.Ice, WATER);
      emitters.push({ x: ci, y: cj, radius: 3, type: Emit.Water, rate: 0.01 });
    }
    for (let n = 0; n < 8; n++) {
      const [ci, cj] = spot(120, surfaceRow - 50, 60);
      ellipse(ci, cj, 5 + rand() * 5, 3 + rand() * 2, Mat.Granite, TOXIC);
      emitters.push({ x: ci, y: cj, radius: 3, type: Emit.Toxic, rate: 0.01 });
    }
    for (let n = 0; n < 12; n++) {
      const [ci, cj] = spot(18, 240, 0);
      ellipse(ci, cj, 8 + rand() * 14, 5 + rand() * 4, Mat.Granite, MAGMA);
      emitters.push({ x: ci, y: cj - 3, radius: 4, type: Emit.Magma, rate: 0.006 });
    }

    this.layout = {
      seed, surfaceRow, startJ, floorJ,
      depot: { x: wx(i0), y: floorJ * CELL },
      // Refined once the start chunks exist (see locate()).
      carl: { x: wx(i0 - 17), y: (startJ - 5) * CELL },
      terrarium: { x: wx(i0 - 42), y: (terrJ - 5) * CELL, w: 2.8, h: 2.2 },
      strutCols: [i0 - 8, i0 + 8],
      emitters,
      surfaceY: (surfaceRow + Math.round((this.nA(i0 * 0.05, 3.7) - 0.5) * 5) + 1) * CELL,
    };
  }

  private add(f: Feature) {
    const pad = 5;
    const box: [number, number, number, number] = f.kind === 'ellipse'
      ? [f.ci - f.rx - pad, f.cj - f.ry - pad, f.ci + f.rx + pad, f.cj + f.ry + pad]
      : f.kind === 'floor' ? [f.i0, f.j0, f.i1, f.floorJ + 3] : [f.i0, f.j0, f.i1, f.j1];
    this.features.push({ ...f, box });
  }

  /** Fill one chunk of the terrain, fluid and temperature arrays. */
  generate(ci: number, cj: number, t: Terrain, fluid: Float32Array, temp: Float32Array) {
    const I0 = ci * CHUNK, J0 = cj * CHUNK, I1 = I0 + CHUNK - 1, J1 = J0 + CHUNK - 1;
    const { nA, nB, nC, nD } = this;
    const { surfaceRow, startJ, floorJ } = this.layout;
    for (let j = J0; j <= J1; j++) {
      for (let i = I0; i <= I1; i++) {
        const k = cellIndex(i, j);
        fluid.fill(0, k * 4, k * 4 + 4);
        t.strut[k] = 0;
        const surf = surfaceRow + Math.round((nA(i * 0.05, 3.7) - 0.5) * 5);
        if (j > surf) { t.density[k] = 0; t.material[k] = Mat.Air; t.digMark[k] = EXPLORED_BIT; continue; }
        t.digMark[k] = 0;
        const depth = surf - j;
        t.density[k] = 1;
        const strata = nB(i * 0.04, j * 0.09);
        let m: Mat;
        if (depth < 18) m = Mat.Dirt;
        else if (depth < 60) m = strata > 0.55 ? Mat.Granite : Mat.Dirt;
        else m = strata < 0.3 ? Mat.Dirt : Mat.Granite;
        const ore = nC(i * 0.09, j * 0.09);
        if (depth > 12 && ore > 0.74 - Math.min(depth, 150) * 0.0006) m = Mat.Copper;
        const ice = nD(i * 0.07, j * 0.07);
        if (depth > 50 && depth < 400 && ice > 0.78) m = Mat.Ice;
        if (depth > 4 && depth < 300 && nD(i * 0.21 + 40, j * 0.21) > 0.83) m = Mat.Junk;
        if (j < 3 || i < 2 || i >= W - 2) m = Mat.Bedrock;
        t.material[k] = m;
      }
    }

    for (const f of this.features) {
      const [bi0, bj0, bi1, bj1] = f.box;
      if (bi1 < I0 || bi0 > I1 || bj1 < J0 || bj0 > J1) continue;
      const fi0 = Math.max(I0, Math.floor(bi0)), fi1 = Math.min(I1, Math.ceil(bi1));
      const fj0 = Math.max(J0, Math.floor(bj0)), fj1 = Math.min(J1, Math.ceil(bj1));
      for (let j = fj0; j <= fj1; j++) for (let i = fi0; i <= fi1; i++) {
        const k = cellIndex(i, j);
        if (t.material[k] === Mat.Bedrock) continue;
        if (f.kind === 'ellipse') {
          const wobble = (nA(i * 0.2, j * 0.2) - 0.5) * 0.25;
          const e = Math.hypot((i - f.ci) / f.rx, (j - f.cj) / f.ry) + wobble;
          const target = Math.min(1, Math.max(0, 0.5 + (e - 1) * Math.min(f.rx, f.ry) * 0.6));
          if (target < t.density[k]) t.density[k] = target;
          if (t.density[k] <= 0.5) {
            if (f.fill !== undefined) fluid[k * 4 + f.fill] = 1;
            if (t.density[k] === 0) t.material[k] = Mat.Air;
          } else if (f.shell !== undefined && e < 1 + 4 / Math.min(f.rx, f.ry)) {
            t.material[k] = f.shell;
          }
        } else if (f.kind === 'floor') {
          if (j < f.floorJ) { t.density[k] = 1; t.material[k] = Mat.Granite; fluid.fill(0, k * 4, k * 4 + 4); }
          else if (i >= f.openI0 && i <= f.openI1) { t.density[k] = 0; t.material[k] = Mat.Air; }
        } else if (t.density[k] > 0.5 && nC(i * 0.3, j * 0.3) > f.threshold) {
          t.material[k] = Mat.Copper;
        }
      }
    }

    for (let j = J0; j <= J1; j++) {
      for (let i = I0; i <= I1; i++) {
        const k = cellIndex(i, j);
        const open = t.density[k] <= 0.5;
        // Caves near the surface start breathable unless they hold toxic gas.
        if (open && j >= startJ - 8 && fluid[k * 4 + TOXIC] === 0) fluid[k * 4 + OXYGEN] = 1;
        temp[k] = fluid[k * 4 + MAGMA] > 0 ? 1100 : geotherm(j);
        if (open && this.layout.strutCols.includes(i) && j >= floorJ && j < startJ + 8) t.strut[k] = 1;
      }
    }
  }

  /** Settle positions that depend on the generated terrain, once the start chunks exist. */
  locate(t: Terrain) {
    const floorBelow = (i: number, j: number) => { while (j > 0 && t.isOpen(i, j - 1)) j--; return j; };
    const { startJ } = this.layout;
    const i0 = W / 2;
    this.layout.carl = { x: wx(i0 - 17), y: floorBelow(i0 - 17, startJ - 2) * CELL };
    this.layout.terrarium.y = floorBelow(i0 - 42, startJ + 1) * CELL;
  }
}

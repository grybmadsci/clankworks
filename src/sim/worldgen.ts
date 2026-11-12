import { CELL, CELLS, Emit, H, Mat, SKY_ROWS, W, cellIndex } from '../config';
import { makeNoise2, mulberry32 } from './rng';
import { Terrain } from './terrain';

/** Emitter position and radius are in cell units; rate is per GPU step (or target °C for heat). */
export interface EmitterDef { x: number; y: number; radius: number; type: Emit; rate: number }

export interface WorldLayout {
  terrain: Terrain;
  /** Initial GPU fluid state: (water, magma, oxygen, toxic) per cell. */
  fluid: Float32Array;
  /** Initial temperature (°C) per cell. */
  temperature: Float32Array;
  emitters: EmitterDef[];
  depot: { x: number; y: number };
  carl: { x: number; y: number };
  terrarium: { x: number; y: number; w: number; h: number };
  botSpawns: { x: number; y: number }[];
  surfaceRow: number;
}

/** World-space position of a cell center. */
const wx = (i: number) => (i + 0.5) * CELL;

export function generateWorld(seed = 1337): WorldLayout {
  const t = new Terrain();
  const rand = mulberry32(seed);
  const nA = makeNoise2(seed + 1), nB = makeNoise2(seed + 2), nC = makeNoise2(seed + 3), nD = makeNoise2(seed + 4);
  const surfaceRow = H - SKY_ROWS - 2;
  const surfaceAt = (i: number) => surfaceRow + Math.round((nA(i * 0.05, 3.7) - 0.5) * 5);

  // --- base strata -------------------------------------------------------------------------
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = cellIndex(i, j);
      const surf = surfaceAt(i);
      if (j > surf) { t.density[k] = 0; t.material[k] = Mat.Air; continue; }
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
      if (depth > 50 && depth < 110 && ice > 0.78) m = Mat.Ice;
      if (depth > 4 && depth < 70 && nD(i * 0.21 + 40, j * 0.21) > 0.83) m = Mat.Junk;
      if (j < 3 || i < 2 || i >= W - 2) m = Mat.Bedrock;
      t.material[k] = m;
    }
  }

  // --- caves & set pieces ------------------------------------------------------------------
  const fluid = new Float32Array(CELLS * 4);
  const carveEllipse = (ci: number, cj: number, rx: number, ry: number, shell?: Mat, fill?: (k: number) => void) => {
    for (let j = Math.floor(cj - ry - 4); j <= cj + ry + 4; j++) {
      for (let i = Math.floor(ci - rx - 4); i <= ci + rx + 4; i++) {
        if (!t.inBounds(i, j)) continue;
        const k = cellIndex(i, j);
        if (t.material[k] === Mat.Bedrock) continue;
        const wobble = (nA(i * 0.2, j * 0.2) - 0.5) * 0.25;
        const e = Math.hypot((i - ci) / rx, (j - cj) / ry) + wobble;
        const target = Math.min(1, Math.max(0, 0.5 + (e - 1) * Math.min(rx, ry) * 0.6));
        if (target < t.density[k]) t.density[k] = target;
        if (t.density[k] <= 0.5) { fill?.(k); if (t.density[k] === 0) t.material[k] = Mat.Air; }
        else if (shell !== undefined && e < 1 + 4 / Math.min(rx, ry)) t.material[k] = shell;
      }
    }
  };
  const tunnel = (i0: number, j0: number, i1: number, j1: number, r: number, fill?: (k: number) => void) => {
    const steps = Math.ceil(Math.hypot(i1 - i0, j1 - j0));
    for (let s = 0; s <= steps; s++) {
      const f = s / steps;
      carveEllipse(i0 + (i1 - i0) * f, j0 + (j1 - j0) * f, r, r, undefined, fill);
    }
  };
  const setFluid = (channel: number, v: number) => (k: number) => { fluid[k * 4 + channel] = v; };

  // Starting cavern, surface shaft, and Carl's alcove.
  const startJ = surfaceRow - 26;
  carveEllipse(64, startJ, 15, 6, Mat.Granite);
  tunnel(64, startJ + 4, 64, surfaceRow + 3, 2.6);
  carveEllipse(47, startJ - 2, 4, 3);
  // Rich copper vein to the right of base.
  for (let j = startJ - 10; j < startJ + 8; j++) {
    for (let i = 82; i < 96; i++) {
      const k = cellIndex(i, j);
      if (t.density[k] > 0.5 && nC(i * 0.3, j * 0.3) > 0.45) t.material[k] = Mat.Copper;
    }
  }

  // Terrarium chamber, joined to Carl's alcove by a narrow tunnel.
  const terrJ = startJ + 1;
  carveEllipse(22, terrJ, 11, 5, Mat.Granite, setFluid(2, 1));
  tunnel(34, terrJ - 2, 44, startJ - 2, 1.6, setFluid(2, 1));

  // Toxic gas pocket under the terrarium.
  carveEllipse(26, terrJ - 24, 8, 4, Mat.Granite, setFluid(3, 1));
  // Aquifer to the right, with an ice rim.
  carveEllipse(100, startJ - 40, 11, 6, Mat.Ice, setFluid(0, 1));
  // Magma chambers at depth.
  carveEllipse(62, 28, 22, 8, Mat.Granite, setFluid(1, 1));
  carveEllipse(104, 70, 7, 5, Mat.Granite, setFluid(1, 1));
  // A few empty natural voids.
  for (let n = 0; n < 7; n++) {
    const ci = 14 + rand() * (W - 28), cj = 45 + rand() * (startJ - 70);
    carveEllipse(ci, cj, 3 + rand() * 4, 2 + rand() * 2.5, Mat.Granite);
  }

  // Sky has oxygen; connected surface caves start breathable.
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = cellIndex(i, j);
      if (t.density[k] <= 0.5 && j >= startJ - 8 && fluid[k * 4 + 3] === 0 && i > 36) fluid[k * 4 + 2] = 1;
    }
  }

  // --- temperature: geothermal gradient plus hot magma ----------------------------------
  const temperature = new Float32Array(CELLS);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = cellIndex(i, j);
      temperature[k] = geotherm(j);
      if (fluid[k * 4 + 1] > 0) temperature[k] = 1100;
    }
  }

  // Pre-built struts holding up the start cavern.
  for (const si of [56, 72]) {
    for (let j = startJ - 8; j < startJ + 8; j++) if (t.isOpen(si, j)) t.strut[cellIndex(si, j)] = 1;
  }

  const floorBelow = (i: number, j: number) => { while (j > 0 && t.isOpen(i, j - 1)) j--; return j; };
  const depotJ = floorBelow(64, startJ);
  const carlJ = floorBelow(47, startJ - 2);
  return {
    terrain: t,
    fluid,
    temperature,
    emitters: [
      { x: 22, y: terrJ, radius: 5, type: Emit.Oxygen, rate: 0.02 },
      { x: 26, y: terrJ - 24, radius: 3, type: Emit.Toxic, rate: 0.01 },
      { x: 100, y: startJ - 40, radius: 3, type: Emit.Water, rate: 0.01 },
      { x: 62, y: 24, radius: 4, type: Emit.Magma, rate: 0.006 },
    ],
    depot: { x: wx(64), y: depotJ * CELL },
    carl: { x: wx(47), y: carlJ * CELL },
    terrarium: { x: wx(22), y: floorBelow(22, terrJ) * CELL, w: 3.2, h: 2.2 },
    botSpawns: [{ x: wx(60), y: depotJ * CELL + 0.4 }, { x: wx(64), y: depotJ * CELL + 0.8 }, { x: wx(68), y: depotJ * CELL + 0.4 }],
    surfaceRow,
  };
}

/** Background rock temperature by row: cool near the surface, hot near the bedrock. */
export function geotherm(j: number) {
  return 14 + (1 - j / H) * 70;
}

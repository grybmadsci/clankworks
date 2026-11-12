// World dimensions and material table shared by the CPU simulation and the GPU kernels.

/** Cells across / up. The world is a vertical slice, taller than it is wide. */
export const W = 128;
export const H = 192;
export const CELLS = W * H;
/** World units per cell. */
export const CELL = 0.25;
/** Depth of the playable diorama slice (world units, along -Z). */
export const DEPTH = 1.25;
/** Collider chunk size in cells (colliders are rebuilt per dirty chunk). */
export const CHUNK = 32;
/** Rows at the top of the map that are open sky. */
export const SKY_ROWS = 10;

export const ISO = 0.5;

/**
 * Per-cell flags shared with the GPU (Terrain.digMark): bit 0 is a dig designation, bit 1 says
 * drones can currently get at it, and the bits from CRACK_SHIFT up hold 1 + the game time (in
 * tenths of a second) when the cell began cracking ahead of a cave-in, or 0 when it is sound.
 */
export const DIG_BIT = 1;
export const REACH_BIT = 2;
export const CRACK_SHIFT = 8;
/** Seconds between unsupported rock starting to crack and it falling. */
export const COLLAPSE_DELAY = 6;

export const enum Mat {
  Air = 0,
  Dirt = 1,
  Granite = 2,
  Copper = 3,
  Ice = 4,
  Bedrock = 5,
  Rubble = 6,
  Junk = 7,
}

export interface MaterialDef {
  name: string;
  /** Seconds of drilling per unit of density at the standard drill rate. */
  hardness: number;
  /** Max horizontal span (cells) a ceiling of this material can hold without support. */
  maxSpan: number;
  /** Resource yield per unit of density removed. */
  yields: { ore?: number; scrap?: number };
}

export const MATERIALS: MaterialDef[] = [
  { name: 'air', hardness: 0, maxSpan: 999, yields: {} },
  { name: 'soft dirt', hardness: 0.6, maxSpan: 9, yields: { scrap: 0.02 } },
  { name: 'granite', hardness: 2.2, maxSpan: 26, yields: { scrap: 0.08 } },
  { name: 'copper ore', hardness: 1.5, maxSpan: 16, yields: { ore: 1 } },
  { name: 'ice', hardness: 1.0, maxSpan: 12, yields: {} },
  { name: 'bedrock', hardness: Infinity, maxSpan: 999, yields: {} },
  { name: 'rubble', hardness: 0.4, maxSpan: 4, yields: { scrap: 0.05 } },
  { name: 'fossilized junk', hardness: 0.9, maxSpan: 10, yields: { scrap: 1 } },
];

/** Emitter types understood by the GPU fluid/thermal kernels. */
export const enum Emit {
  Oxygen = 0,
  Toxic = 1,
  Water = 2,
  Magma = 3,
  Heat = 4,
}
export const MAX_EMITTERS = 16;
export const MAX_PARTICLES = 16384;
export const MAX_BURSTS = 32;

export const cellIndex = (i: number, j: number) => j * W + i;
export const toCell = (v: number) => Math.floor(v / CELL);
export const cellCenter = (i: number) => (i + 0.5) * CELL;

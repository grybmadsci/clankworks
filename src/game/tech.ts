import type { Resource } from '../config';

export type Cost = Partial<Record<Resource, number>>;

/** A smelter recipe: what one batch takes, what it makes, and how long it cooks. */
export interface Recipe { id: string; name: string; input: Cost; output: Cost; time: number }

export const RECIPES: Recipe[] = [
  { id: 'copper', name: 'Copper plates', input: { ore: 1 }, output: { plates: 1 }, time: 2.5 },
  { id: 'iron', name: 'Iron bars', input: { ironOre: 1 }, output: { ironBars: 1 }, time: 4 },
  { id: 'titanium', name: 'Titanium bars', input: { tiOre: 1 }, output: { tiBars: 1 }, time: 6 },
];

/** One research project. `requires` is the project before it in its branch. */
export interface Tech { id: string; branch: string; name: string; effect: string; cost: Cost; requires?: string }

/**
 * The tech tree: four short branches. Each starts with a copper-plate project and continues with
 * one that needs metal from further afield, so research pulls the player outward.
 */
export const TECHS: Tech[] = [
  { id: 'pads3', branch: 'Fleet', name: 'Third landing pad', effect: '+1 drone capacity at the base (3)', cost: { plates: 6 } },
  { id: 'pads4', branch: 'Fleet', name: 'Fourth landing pad', effect: '+1 drone capacity at the base (4)', cost: { ironBars: 5 }, requires: 'pads3' },
  { id: 'laser1', branch: 'Lasers', name: 'Focused lasers', effect: 'Drones mine 50% faster', cost: { plates: 8 } },
  { id: 'laser2', branch: 'Lasers', name: 'Arc lasers', effect: 'Mine twice as fast, and cut titanium ore', cost: { ironBars: 6 }, requires: 'laser1' },
  { id: 'rotor1', branch: 'Rotors', name: 'Tuned rotors', effect: 'Drones fly 25% faster', cost: { plates: 6 } },
  { id: 'rotor2', branch: 'Rotors', name: 'Titanium rotors', effect: 'Drones fly 50% faster', cost: { tiBars: 4 }, requires: 'rotor1' },
  { id: 'cell1', branch: 'Batteries', name: 'Bigger cells', effect: 'Drone batteries last 50% longer', cost: { plates: 6 } },
  { id: 'cell2', branch: 'Batteries', name: 'Iron-core cells', effect: 'Drone batteries last twice as long', cost: { ironBars: 5 }, requires: 'cell1' },
];

/** An outpost: a satellite base with two landing pads and its own dig range. */
export const OUTPOST = {
  cost: { plates: 10, ironBars: 8 } as Cost,
  /** Closest an outpost may be to any other base (world units). */
  minDistance: 20,
  /** Footprint, in world units: it needs this much flat floor. */
  width: 2,
  height: 0.85,
  pads: 2,
};

import { CELL } from '../config';

type Vec = { x: number; y: number };

/** Drones only take dig orders within this distance (world units) of the base. */
export const DIG_RADIUS = 11;
/** Hub building size; its roof doubles as the main landing deck. */
/** The base's footprint: its width, and the height of its landing deck (drones dock just above). */
export const HUB = { w: 2.3, h: 1.035 };
/** One landing pad per drone, on top of the boiler. */
export const DOCK_SLOTS = 4;

export function digCenter(depot: Vec): Vec {
  return { x: depot.x, y: depot.y + 4 * CELL };
}

/** Where drone `n` sits when docked, relative to the base resting at `depot`. */
export function dockSlot(depot: Vec, n: number): Vec {
  return { x: depot.x - 0.6 + n * 0.4, y: depot.y + HUB.h + 0.1 };
}

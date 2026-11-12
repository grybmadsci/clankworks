import { CELL } from '../config';

type Vec = { x: number; y: number };

/** Drones only take dig orders within this distance (world units) of the base. */
export const DIG_RADIUS = 11;
/** Hub building size; its roof doubles as the main landing deck. */
export const HUB = { w: 1.7, h: 0.9 };
/** One landing pad per drone: four on the hub roof, eight cradles on the rack tower beside it. */
export const DOCK_SLOTS = 12;

export function digCenter(depot: Vec): Vec {
  return { x: depot.x, y: depot.y + 4 * CELL };
}

/** Where drone `n` sits when docked. */
export function dockSlot(depot: Vec, n: number): Vec {
  if (n < 4) return { x: depot.x - 0.6 + n * 0.4, y: depot.y + HUB.h + 0.1 };
  const m = n - 4;
  return { x: depot.x - 1.62 + (m % 2) * 0.4, y: depot.y + 0.32 + Math.floor(m / 2) * 0.42 };
}

import { CELL, COLLAPSE_DELAY, CRACK_SHIFT, DEPTH, DIG_BIT, EXPLORED_BIT, H, ISO, MATERIALS, Mat, REACH_BIT, STRESS_MAX, STRESS_SHIFT, W, cellIndex } from '../config';
import { DOCK_SLOTS, HUB } from './base';
import type { Bot, Game } from './Game';

/** Where the cursor ray crosses depth z (the scene's things sit at different depths). */
export type RayAt = (z: number) => { x: number; y: number };

/** What was inspected (the tutorial watches for some of these), its name, and a few facts. */
export interface Inspection { kind: string; title: string; lines: string[] }

// Depths the renderer draws things at (see render/Entities.tsx and render/Base.tsx).
const Z_ACTORS = -DEPTH * 0.45, Z_CRITTER = -DEPTH * 0.35, Z_STRUT = -DEPTH * 0.72, Z_HUB = -DEPTH * 0.62, Z_DEBRIS = -DEPTH * 0.5;

const pct = (v: number) => `${Math.round(v)}%`;
const near = (a: { x: number; y: number }, b: { x: number; y: number }, r: number) => Math.hypot(a.x - b.x, a.y - b.y) <= r;

function droneStatus(b: Bot) {
  if (b.state === 'docked') return b.battery < 99.5 ? 'Docked, charging' : 'Docked, ready';
  if (b.lowBattery) return 'Low battery: returning to recharge';
  switch (b.state) {
    case 'toDig': return 'Flying to a dig order';
    case 'digging': return 'Mining';
    case 'toDepot': return b.cargo.ore + b.cargo.scrap > 0.5 ? 'Returning to unload' : 'Returning to base';
    case 'tantrum': return 'Having a tantrum';
    case 'salute': return 'Saluting Carl';
    default: return 'Looking for work';
  }
}

/** What the cursor is over, nearest the camera first: machines and creatures, then the rock. */
export function inspect(game: Game, at: RayAt): Inspection | null {
  if (game.intro.phase !== 'done') return null;

  const pa = at(Z_ACTORS);
  for (const b of game.bots) {
    if (b.dead || !near(b.body.translation(), pa, 0.25)) continue;
    return {
      kind: 'drone',
      title: `Drone ${b.name}`,
      lines: [
        droneStatus(b),
        `Battery ${pct(b.battery)}`,
        `Cargo ${(b.cargo.ore).toFixed(1)} ore, ${(b.cargo.scrap).toFixed(1)} scrap`,
        `Hull ${pct(b.hp)}${b.heat > 20 ? `, overheating ${pct(b.heat)}` : ''}`,
      ],
    };
  }
  for (const s of game.smelters) {
    if (Math.abs(pa.x - s.x) > 0.45 || pa.y < s.y || pa.y > s.y + 1.1) continue;
    return {
      kind: 'smelter',
      title: 'Smelter',
      lines: [game.time < s.hotUntil ? 'Smelting ore into plates' : game.resources.ore >= 1 ? 'Loading ore' : 'Waiting for ore', `Integrity ${pct(s.hp)}`, `${game.platesMade} plates made so far`],
    };
  }
  for (const b of game.blasts) {
    if (!near(b, at(Z_ACTORS + 0.2), 0.2)) continue;
    return { kind: 'blast', title: 'Blast charge', lines: [`Detonates in ${Math.max(0, b.fuse).toFixed(1)}s`, 'Stand clear'] };
  }
  const pc = at(Z_CRITTER);
  for (const c of game.critters) {
    if (!near({ x: c.x, y: c.y + 0.1 }, pc, 0.2)) continue;
    return { kind: 'critter', title: c.name, lines: [c.dead ? 'Expired' : c.happy ? 'Thriving' : `Unhappy: ${c.complaint}`, `Health ${pct(Math.max(0, c.health))}`, 'Cave critter'] };
  }

  const d = game.layout.depot, ph = at(Z_HUB);
  if (Math.abs(ph.x - d.x) < HUB.w / 2 + 0.15 && ph.y > d.y && ph.y < d.y + HUB.h + 0.3) {
    const docked = game.bots.filter((b) => !b.dead && b.state === 'docked').length;
    const r = game.resources;
    return {
      kind: 'base',
      title: 'Base (boiler house)',
      lines: [`${docked} of ${DOCK_SLOTS} drones docked`, `Stores: ${r.ore.toFixed(1)} ore, ${Math.floor(r.scrap)} scrap, ${Math.floor(r.plates)} plates`, `Dig range ${game.digRadius}m`],
    };
  }
  const pd = at(Z_DEBRIS);
  if (near(game.layout.carl, pd, 0.3)) return { kind: 'carl', title: 'Carl', lines: ['Obsolete predecessor model', 'Still blinking, bless him'] };
  for (const deb of game.debris) {
    if (!near(deb.body.translation(), pd, Math.sqrt(deb.cells.length) * CELL * 0.6)) continue;
    return { kind: 'debris', title: 'Falling rock', lines: [`${deb.cells.length} cells of rock`, 'Crushes anything below it'] };
  }
  const ps = at(Z_STRUT);
  for (const s of game.struts) {
    if (Math.abs(ps.x - (s.i + 0.5) * CELL) > 0.2 || ps.y < s.j0 * CELL - 0.15 || ps.y > (s.j1 + 1) * CELL + 0.15) continue;
    return {
      kind: 'strut',
      title: 'Steel strut',
      lines: [
        `${((s.j1 - s.j0 + 1) * CELL).toFixed(1)}m of 4m maximum`,
        s.broken ? 'Not supporting: dug out past its reach' : s.atRisk ? 'At risk: pending digs would undermine it' : 'Supporting the ceiling',
      ],
    };
  }

  // The rock (or open cave) on the cutaway face.
  const p = at(0);
  const i = Math.floor(p.x / CELL), j = Math.floor(p.y / CELL);
  if (i < 0 || j < 0 || i >= W || j >= H) return null;
  const t = game.terrain, k = cellIndex(i, j);
  if (!t.isLoadedCell(i, j)) return null;
  const marks = t.digMark[k];
  if (!(marks & EXPLORED_BIT)) return { kind: 'unexplored', title: 'Unexplored', lines: ['Send drones nearby to see what is here'] };
  const env = game.env(p.x, p.y);
  const temp = `${Math.round(env.temp)}°C`;
  if (t.density[k] <= ISO) {
    const lines = [`Air ${pct(Math.min(1, env.o2) * 100)} oxygen, ${temp}`];
    if (env.toxic > 0.1) lines.push(`Toxic gas ${pct(Math.min(1, env.toxic) * 100)}`);
    if (env.water > 0.1) lines.push(`Water ${pct(Math.min(1, env.water) * 100)}`);
    if (env.magma > 0.1) lines.push(`Magma ${pct(Math.min(1, env.magma) * 100)}`);
    return { kind: 'open', title: j * CELL > game.layout.surfaceY ? 'Sky' : 'Open cave', lines };
  }
  const m = t.material[k];
  const def = MATERIALS[m];
  const name = def.name[0].toUpperCase() + def.name.slice(1);
  const lines: string[] = [];
  if (m === Mat.Bedrock) lines.push('Cannot be dug');
  else lines.push(`${def.hardness <= 1 ? 'Quick' : def.hardness <= 3 ? 'Slow' : 'Very slow'} to dig${def.yields.ore ? ', yields ore' : def.yields.scrap && def.yields.scrap >= 0.5 ? ', yields scrap' : ''}`);
  lines.push(`Holds a ${(def.maxSpan * CELL).toFixed(1)}m span · ${temp}`);
  if (marks & DIG_BIT) lines.push(marks & REACH_BIT ? 'Dig order: drones can reach it' : 'Dig order: no access yet');
  const stress = ((marks >> STRESS_SHIFT) & STRESS_MAX) / STRESS_MAX;
  if (stress > 0.05) lines.push(`Stress ${pct(stress * 100)}${stress >= 0.8 ? ' — near its limit' : ''}`);
  const crack = marks >>> CRACK_SHIFT;
  if (crack) lines.push(`Cracking: falls in ${Math.max(0, COLLAPSE_DELAY - (game.time - (crack - 1) / 10)).toFixed(0)}s`);
  return { kind: 'rock', title: name, lines };
}

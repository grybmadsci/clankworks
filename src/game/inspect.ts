import { CELL, COLLAPSE_DELAY, CRACK_SHIFT, DEPTH, DIG_BIT, EXPLORED_BIT, H, ISO, MATERIALS, Mat, REACH_BIT, STRESS_MAX, STRESS_SHIFT, W, cellIndex } from '../config';
import { DIG_RADIUS, HUB } from './base';
import { bucketTotal, cargoTotal, type Bot, type Game } from './Game';
import { DEPOT, OUTPOST, RECIPES, VEHICLE } from './tech';

/** Where the cursor ray crosses depth z (the scene's things sit at different depths). */
export type RayAt = (z: number) => { x: number; y: number };

/**
 * What was inspected (the tutorial watches for some of these), its name and a few facts, plus
 * for machines the progress of the current job (0..1) and the recipe it runs.
 */
export interface Inspection {
  kind: string;
  title: string;
  lines: string[];
  progress?: { value: number; label: string };
  recipe?: { input: Record<string, number>; output: Record<string, number>; seconds: number };
}

// Depths the renderer draws things at (see render/Entities.tsx and render/Base.tsx).
const Z_ACTORS = -DEPTH * 0.45, Z_CRITTER = -DEPTH * 0.35, Z_STRUT = -DEPTH * 0.72, Z_HUB = -DEPTH * 0.62, Z_DEBRIS = -DEPTH * 0.5;

const pct = (v: number) => `${Math.round(v)}%`;
const CARGO_NAME: Record<string, string> = { ore: 'copper ore', ironOre: 'iron ore', tiOre: 'titanium ore', scrap: 'scrap' };
const near = (a: { x: number; y: number }, b: { x: number; y: number }, r: number) => Math.hypot(a.x - b.x, a.y - b.y) <= r;

function droneStatus(b: Bot) {
  if (b.state === 'docked') return b.battery < 99.5 ? 'Docked, charging' : 'Docked, ready';
  if (b.lowBattery) return 'Low battery: returning to recharge';
  switch (b.state) {
    case 'toDig': return 'Flying to a dig order';
    case 'digging': return 'Mining';
    case 'toDepot': return cargoTotal(b) > 0.5 ? 'Returning to unload' : 'Returning to base';
    case 'toVehicle': return 'Flying to pick up from a vehicle';
    case 'loading': return 'Loading from a vehicle\'s bucket';
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
        `Cargo ${cargoTotal(b).toFixed(1)} / 6${Object.entries(b.cargo).filter(([, n]) => (n ?? 0) > 0.05).map(([r, n]) => ` · ${n!.toFixed(1)} ${CARGO_NAME[r] ?? r}`).join('')}`,
        `Hull ${pct(b.hp)}${b.heat > 20 ? `, overheating ${pct(b.heat)}` : ''}`,
      ],
    };
  }
  for (const v of game.vehicles) {
    if (!near(v.body.translation(), pa, 0.5)) continue;
    const load = bucketTotal(v);
    const held = Object.entries(v.bucket).filter(([, n]) => n >= 0.1).map(([m, n]) => `${n.toFixed(1)} ${MATERIALS[Number(m)].name}`);
    return {
      kind: 'vehicle',
      title: `Mining vehicle ${v.name}`,
      lines: [
        v === game.driving ? (v.drilling ? 'Drilling' : v.unloading ? 'Unloading at the depot' : 'You are driving') : 'Parked: click it with Select to drive',
        ...(v.pickup ? [`Pickup requested: ${game.bots.filter((b) => !b.dead && b.pickup === v.id).length} drones on the way`] : []),
        `Bucket ${load.toFixed(1)} / ${game.bucketSize} cells${held.length ? ` · ${held.join(', ')}` : ''}`,
        'Empties into the stockpiles at its depot',
      ],
    };
  }
  for (const s of game.smelters) {
    if (Math.abs(pa.x - s.x) > 0.45 || pa.y < s.y || pa.y > s.y + 1.1) continue;
    // The batch in progress, or the one it would start next.
    const next = game.nextRecipe();
    const recipe = RECIPES[s.crafting ? s.recipe : Math.max(0, next)];
    const f = s.crafting ? s.smeltTimer / recipe.time : 0;
    return {
      kind: 'smelter',
      title: 'Smelter',
      lines: [`Integrity ${pct(s.hp)} · ${game.platesMade} plates made so far`],
      progress: {
        value: f,
        label: s.crafting ? `${recipe.name}… ${Math.max(0, recipe.time - s.smeltTimer).toFixed(1)}s left` : next >= 0 ? 'Loading ore' : 'Idle: waiting for ore',
      },
      recipe: { input: recipe.input as Record<string, number>, output: recipe.output as Record<string, number>, seconds: recipe.time },
    };
  }
  const pc = at(Z_CRITTER);
  for (const c of game.critters) {
    if (!near({ x: c.x, y: c.y + 0.1 }, pc, 0.2)) continue;
    return { kind: 'critter', title: c.name, lines: [c.dead ? 'Expired' : c.happy ? 'Thriving' : `Unhappy: ${c.complaint}`, `Health ${pct(Math.max(0, c.health))}`, 'Cave critter'] };
  }

  const d = game.layout.depot, ph = at(Z_HUB);
  const dockedAt = (id: string) => game.bots.filter((b) => !b.dead && b.state === 'docked' && b.pad.startsWith(`${id}:`)).length;
  if (Math.abs(ph.x - d.x) < HUB.w / 2 + 0.15 && ph.y > d.y && ph.y < d.y + HUB.h + 0.3) {
    const main = game.bases[0];
    return {
      kind: 'base',
      title: 'Base (boiler house)',
      lines: [`${dockedAt('main')} drones docked · ${game.padsAt(main)} of 4 pads in use`, `Drone capacity ${game.droneCapacity} across ${game.bases.length} base${game.bases.length > 1 ? 's' : ''}`, `Dig range ${DIG_RADIUS}m`],
    };
  }
  for (const b of game.bases) {
    if (b.kind !== 'outpost') continue;
    const po = at(Z_ACTORS);
    if (Math.abs(po.x - b.x) > OUTPOST.width / 2 || po.y < b.y || po.y > b.y + OUTPOST.height + 0.4) continue;
    return { kind: 'outpost', title: 'Outpost', lines: [`${dockedAt(b.id)} of ${OUTPOST.pads} pads in use`, `Dig range ${DIG_RADIUS}m around it`, `${Math.round(Math.hypot(b.x - d.x, b.y - d.y))}m from the main base`] };
  }
  for (const dp of game.depots) {
    if (Math.abs(pa.x - dp.x) > DEPOT.width / 2 || pa.y < dp.y || pa.y > dp.y + DEPOT.height + 0.2) continue;
    const v = game.vehicles.find((o) => o.depotId === dp.id);
    const base = game.bases.find((b) => b.id === dp.baseId);
    return {
      kind: 'depot',
      title: 'Vehicle depot',
      lines: [
        v ? `Its vehicle: ${v.name}` : `No vehicle out: press Vehicle (V) to build one (${VEHICLE.cost.plates} plates)`,
        `Serves the ${base?.kind === 'outpost' ? 'outpost' : 'main base'} (one depot per base)`,
        'Vehicles unload here',
      ],
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

  const pg = at(0);
  const g = game.girderAt(pg.x, pg.y);
  if (g && Math.floor(pg.y / CELL) === g.j) {
    return { kind: 'girder', title: 'Steel girder', lines: [`${((g.i1 - g.i0 + 1) * CELL).toFixed(2).replace(/\.?0+$/, '')}m long`, 'A floor to build and drive on; drones fly around it'] };
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
  else {
    const gives = Object.entries(def.yields).filter(([, n]) => (n ?? 0) >= 0.5).map(([r]) => CARGO_NAME[r] ?? r);
    lines.push(`${def.hardness <= 1 ? 'Quick' : def.hardness <= 3 ? 'Slow' : 'Very slow'} to dig${gives.length ? `, yields ${gives.join(', ')}` : ''}`);
    if (m === Mat.Titanium && !game.canCutTitanium) lines.push('Needs Arc lasers (research) to cut');
  }
  lines.push(`Holds a ${(def.maxSpan * CELL).toFixed(1)}m span · ${temp}`);
  if (marks & DIG_BIT) lines.push(marks & REACH_BIT ? 'Dig order: drones can reach it' : 'Dig order: no access yet');
  const stress = ((marks >> STRESS_SHIFT) & STRESS_MAX) / STRESS_MAX;
  if (stress > 0.05) lines.push(`Stress ${pct(stress * 100)}${stress >= 0.8 ? ' — near its limit' : ''}`);
  const crack = marks >>> CRACK_SHIFT;
  if (crack) lines.push(`Cracking: falls in ${Math.max(0, COLLAPSE_DELAY - (game.time - (crack - 1) / 10)).toFixed(0)}s`);
  return { kind: 'rock', title: name, lines };
}

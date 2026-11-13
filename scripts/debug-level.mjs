// The debug level and the vehicle turning around: loads the debug level from the main menu,
// checks its start (stock, buildings, a braced cavern), then drives a vehicle both ways and
// screenshots a turn part-way through.
//
//   node scripts/win.mjs scripts/debug-level.mjs     (WSL: Windows Chrome on the real GPU)
import { baseUrl, gotoApp, launchBrowser, newPage } from './browser.mjs';

const server = baseUrl ? null : await (await import('vite')).createServer({ server: { port: 5288, strictPort: true }, logLevel: 'error' });
await server?.listen();
const browser = await launchBrowser();
const page = await newPage(browser);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed = true; };
const fastForward = (seconds) => page.evaluate(async (s) => {
  const g = window.__game;
  for (let n = 0; n < s * 30; n++) { g.update(1 / 30); if (n % 5 === 0) await new Promise((r) => setTimeout(r, 20)); }
}, seconds);
const vehicle = () => page.evaluate(() => { const g = window.__game, v = g.vehicles[0]; return { facing: v.facing, turning: !!v.turn, x: v.body.translation().x - g.layout.depot.x }; });

try {
  await gotoApp(page, baseUrl ?? 'http://localhost:5288/');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Load debug level' }).click();
  await page.waitForURL(/level=debug/);
  await page.waitForFunction(() => window.__ready === true && window.__game?.debug, null, { timeout: 60000 });
  const start = await page.evaluate(() => {
    const g = window.__game, t = g.terrain, d = g.layout.depot, i0 = Math.floor(d.x / 0.25), j0 = Math.round(d.y / 0.25);
    // Open cells straight up from the floor, across the cavern.
    const heights = [];
    for (let i = i0 - 23; i <= i0 + 22; i++) { let n = 0; while (n < 20 && t.density[(j0 + n) * 512 + i] <= 0.5) n++; heights.push(n); }
    // Width of the open floor, and of the room half-way up its rounded ends.
    const width = (j) => { let a = i0, b = i0; while (t.density[j * 512 + a - 1] <= 0.5) a--; while (t.density[j * 512 + b + 1] <= 0.5) b++; return b - a + 1; };
    return { floorW: width(j0), topW: width(j0 + 11), phase: g.intro.phase, res: { ...g.resources }, smelters: g.smelters.length, depots: g.depots.length, struts: g.struts.length, minH: Math.min(...heights) };
  });
  console.log('start', JSON.stringify(start));
  check(start.phase === 'done' && Object.values(start.res).every((n) => n >= 98), `the debug level starts deployed with 100 of every resource (the smelter may already be at work: ${JSON.stringify(start.res)})`);
  check(start.smelters === 1 && start.depots === 1, 'a smelter and a vehicle depot stand in the start cavern');
  check(start.floorW >= 60 && start.floorW <= 68 && start.minH >= 12, `the start cavern is about 16m wide (${start.floorW * 0.25}m) and 3m tall across its middle 12m`);
  check(start.topW < start.floorW - 8, `its ends round over into the roof (${start.topW * 0.25}m wide at the top)`);
  await fastForward(8);
  const settled = await page.evaluate(() => ({ unstable: window.__game.unstable.length, broken: window.__game.struts.filter((s) => s.broken || s.atRisk).length, struts: window.__game.struts.length }));
  check(settled.unstable === 0 && settled.broken === 0 && settled.struts >= 6, `its struts brace the roof: nothing unstable (${settled.struts} struts)`);
  await page.screenshot({ path: 'smoke-debug-level.png' });

  // Drive left: the vehicle turns round in place first, then drives off drill first.
  await page.keyboard.press('v');
  await fastForward(1);
  const parked = await vehicle();
  await page.keyboard.down('a');
  await fastForward(0.5);
  const mid = await vehicle();
  await fastForward(1.5);
  await page.keyboard.up('a');
  const left = await vehicle();
  console.log('turn', JSON.stringify({ parked, mid, left }));
  check(parked.facing === 1 && mid.turning && Math.abs(mid.x - parked.x) < 0.05, 'driving the other way turns the vehicle round while it holds still');
  check(left.facing === -1 && !left.turning && left.x < parked.x - 0.5, 'then it drives off with the drill leading');

  // A turn part-way through, for a look.
  await page.evaluate(() => { const g = window.__game, p = g.vehicles[0].body.translation(); g.paused = true; window.__view.goto(p.x, p.y + 0.2); });
  await page.mouse.move(640, 400);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(30); }
  await page.waitForTimeout(800);
  for (const t of [0.2, 0.55, 0.9]) {
    await page.evaluate((t) => { const v = window.__game.vehicles[0]; v.turn = { t, to: 1 }; v.facing = t >= 0.55 ? 1 : -1; }, t);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `smoke-turn-${t}.png` });
  }
  await page.evaluate(() => { const g = window.__game; g.vehicles[0].turn = null; g.paused = false; });
  check(errors.length === 0, `no console errors (${errors.length})`);
  if (errors.length) console.log(errors.join('\n'));
} finally {
  await browser.close();
  await server?.close();
}
process.exit(failed ? 1 : 0);

// End-to-end smoke test: boots the game in Chromium with WebGPU, fast-forwards the simulation
// through digging and a cave-in, checks GPU-produced state, and saves screenshots.
//
//   npm run smoke:win             (WSL: Windows Chrome on the real GPU, headless)
//   npm run smoke                 (Linux Chromium, headed; under WSL this is SwiftShader)
//   HEADLESS=1 npm run smoke      (for machines where headless WebGPU presentation works)
import { baseUrl, gotoApp, launchBrowser, newPage } from './browser.mjs';

// With BASE_URL set, the caller (scripts/win.mjs) is already serving the app.
const server = baseUrl ? null : await (await import('vite')).createServer({ server: { port: 5288, strictPort: true }, logLevel: 'error' });
await server?.listen();
const browser = await launchBrowser();
const page = await newPage(browser);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));

let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) failed = true; };
/** Advance the game with fixed 1/30s steps, yielding so readbacks and rendering can happen. */
const fastForward = (seconds) => page.evaluate(async (s) => {
  const g = window.__game;
  for (let n = 0; n < s * 30; n++) {
    g.update(1 / 30);
    if (n % 10 === 0) await new Promise((r) => setTimeout(r, 30));
  }
}, seconds);
const shot = async (name) => { await page.waitForTimeout(600); await page.screenshot({ path: `smoke-${name}.png` }); };

try {
  await gotoApp(page, baseUrl ?? 'http://localhost:5288/');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  // Opening: the base drills down from the surface and deploys. Watch it land, then carry on.
  const intro = await page.evaluate(async () => {
    const g = window.__game, d = g.layout.depot;
    const start = g.intro.offset;
    const shaftCell = () => g.terrain.density[Math.floor((d.y + start / 2) / 0.25) * 512 + Math.floor(d.x / 0.25)];
    const before = shaftCell();
    for (let n = 0; n < 30 * 24 && g.intro.phase !== 'done'; n++) { g.update(1 / 30); if (n % 10 === 0) await new Promise((r) => setTimeout(r, 20)); }
    return { start, before, after: shaftCell(), phase: g.intro.phase, toolbar: [...document.querySelectorAll('.tool-group h4')].map((h) => h.firstChild.textContent) };
  });
  console.log('intro', JSON.stringify(intro));
  check(intro.start > 25 && intro.before > 0.5 && intro.after < 0.5 && intro.phase === 'done',
    `base drilled ${intro.start.toFixed(0)}m down its own shaft and deployed`);
  await page.waitForTimeout(400);
  const groups = await page.evaluate(() => ({
    toolbar: [...document.querySelectorAll('.tool-group h4')].map((h) => h.firstChild.textContent),
    layers: [...document.querySelectorAll('.layers button')].map((b) => b.textContent),
    stacked: (() => { const b = [...document.querySelectorAll('.layers button')].map((e) => e.getBoundingClientRect()); return b.every((r, n) => n === 0 || r.top > b[n - 1].top); })(),
  }));
  check(groups.toolbar.join(',') === 'Orders,Buildings' && groups.layers.length === 5 && groups.stacked,
    `toolbar split into ${groups.toolbar.join(' / ')}, with ${groups.layers.length} layers stacked in their own panel`);
  console.log('quality:', await page.evaluate(() => document.querySelector('canvas')?.dataset.quality ?? 'high'));
  console.log('adapter:', await page.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter();
    return `${a.info.vendor} ${a.info.architecture}${a.info.isFallbackAdapter ? ' (fallback)' : ''}`;
  }));
  await fastForward(4);
  await shot('1-start');

  const gpu = await page.evaluate(async () => {
    const g = window.__game;
    await g.gpu.readback();
    const f = g.gpu.fluidSnapshot, f0 = g.fluidInit, t = g.gpu.tempSnapshot, t0 = g.tempInit;
    let changed = 0, nan = 0, maxRockT = 0;
    for (let k = 0; k < t.length; k++) {
      if (Math.abs(f[k * 4 + 2] - f0[k * 4 + 2]) > 1e-3 || Math.abs(t[k] - t0[k]) > 1e-2) changed++;
      if (!Number.isFinite(t[k]) || !Number.isFinite(f[k * 4]) || !Number.isFinite(f[k * 4 + 2])) nan++;
      if (g.terrain.density[k] > 0.5) maxRockT = Math.max(maxRockT, t[k]);
    }
    const args = new Uint32Array(await g.gpu.renderer.getArrayBufferAsync(g.gpu.meshDrawArgs));
    let meshVerts = 0, slots = 0;
    for (let s = 0; s < args.length; s += 4) if (args[s]) { meshVerts += args[s]; slots++; }
    return { changed, nan, maxRockT, meshVerts, slots };
  });
  console.log('gpu', JSON.stringify(gpu));
  check(gpu.changed > 1000, `GPU fluid/thermal kernels evolved the state (${gpu.changed} cells changed)`);
  check(gpu.nan === 0, 'no NaNs in GPU fluid/thermal state');
  // Magma lies deep in the big world: stream a chamber in and let it heat the rock around it.
  const magma = await page.evaluate(async () => {
    const g = window.__game;
    const e = g.layout.emitters.find((m) => m.type === 3);
    window.__view.goto(e.x * 0.25, e.y * 0.25);
    for (let n = 0; n < 150; n++) { g.update(1 / 30); await new Promise((r) => setTimeout(r, 20)); }
    await g.gpu.readback();
    const t = g.gpu.tempSnapshot, ci = Math.floor(e.x), cj = Math.floor(e.y);
    let maxRockT = 0;
    for (let j = cj - 40; j <= cj + 40; j++) for (let i = ci - 60; i <= ci + 60; i++) {
      const k = j * 512 + i;
      if (g.terrain.isLoadedCell(i, j) && g.terrain.density[k] > 0.5 && g.terrain.material[k] !== 5) maxRockT = Math.max(maxRockT, t[k]);
    }
    window.__view.goto(g.layout.depot.x, g.layout.depot.y + 1);
    for (let n = 0; n < 30; n++) { g.update(1 / 30); await new Promise((r) => setTimeout(r, 20)); }
    return maxRockT;
  });
  check(magma > 200, `magma conducts heat into surrounding rock (max rock ${magma.toFixed(0)}°C)`);
  check(gpu.meshVerts > 50000 && gpu.slots > 10, `GPU mesher built ${gpu.meshVerts} terrain vertices across ${gpu.slots} chunk slots`);

  const startup = await page.evaluate(() => ({
    warnings: window.__game.log.filter((l) => /structural warning|cave-in/i.test(l.text)).length,
    goo: 'goo' in window.__game.resources || /goo/i.test(document.querySelector('.topbar').textContent),
    terrarium: /terrarium/i.test(document.body.textContent),
  }));
  check(startup.warnings === 0, `the starting caves raise no structural warnings (${startup.warnings})`);
  check(!startup.goo && !startup.terrarium, 'no goo and no terrarium in the game or HUD');
  const docked = await page.evaluate(() => window.__game.bots.map((b) => b.state));
  check(docked.length === 1 && docked[0] === 'docked', `the shift starts with one drone, docked at the base (${docked.join(',')})`);

  // Tutorial: a checklist per step that ticks itself as you do things, then moves on. Do each
  // step for real (pan, zoom, hover, hotkeys, clicks) and watch it advance.
  const tut = () => page.evaluate(() => ({
    step: window.__game.tutorial.step,
    title: document.querySelector('.tutorial h4')?.textContent ?? '',
    items: document.querySelectorAll('.checklist li').length,
    ticked: document.querySelectorAll('.checklist li.done').length,
    pointers: Math.min(document.querySelectorAll('.tut-focus').length, document.querySelectorAll('.tut-lines line').length),
  }));
  const toScreen = (x, y, z) => page.evaluate(([x, y, z]) => {
    const cam = window.__view.camera, e = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left + ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * r.width, y: r.top + (-(e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5 + 0.5) * r.height };
  }, [x, y, z]);
  const tutorialLog = [];
  // Do the step's actions, check its items all ticked, then wait for it to move on by itself.
  // (The HUD redraws a few times a second, so give it a moment before reading it.)
  const doStep = async (act) => {
    await page.waitForTimeout(350);
    const before = await tut();
    await act();
    // Wait for the ticks to show; if the step already moved on, count what the game ticked.
    await page.waitForFunction((n) => document.querySelectorAll('.checklist li.done').length >= n, before.items, { timeout: 2000 }).catch(() => {});
    const shown = await tut();
    const ticked = shown.step === before.step ? shown.ticked : before.items;
    await page.waitForFunction((s) => window.__game.tutorial.step > s, before.step, { timeout: 8000 }).catch(() => {});
    const after = await tut();
    tutorialLog.push({ title: before.title, items: before.items, ticked, pointers: before.pointers, advanced: after.step === before.step + 1 });
  };
  const d0 = await page.evaluate(() => window.__game.layout.depot);
  await page.mouse.move(640, 420);
  await doStep(async () => {
    await page.keyboard.down('d'); await page.waitForTimeout(500); await page.keyboard.up('d');
    for (let n = 0; n < 3; n++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(60); }
  });
  await page.evaluate((d) => window.__view.goto(d.x, d.y + 1), d0);
  await page.waitForTimeout(400);
  await doStep(async () => { await page.hover('.topbar .quota'); await page.waitForTimeout(300); });
  await doStep(async () => { for (const k of ['1', '3', 'Escape']) { await page.keyboard.press(k); await page.waitForTimeout(150); } });
  await doStep(async () => {
    await page.getByRole('button', { name: 'Material' }).click();
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'Granite' }).click();
    await page.getByRole('button', { name: 'Granite' }).click();
    await page.getByRole('button', { name: 'Normal' }).click();
  });
  // Objectives: no pointer lines and no way to skip.
  await page.waitForTimeout(400);
  const objectiveUi = await page.evaluate(() => ({
    title: document.querySelector('.tutorial h3')?.textContent,
    skips: [...document.querySelectorAll('.tutorial button')].filter((b) => /skip/i.test(b.textContent)).length,
    lines: document.querySelectorAll('.tut-lines line').length,
  }));
  check(/Objective 1/.test(objectiveUi.title) && objectiveUi.skips === 0 && objectiveUi.lines === 0, `objectives can't be skipped and draw no pointer lines (${objectiveUi.title})`);
  await page.evaluate((d) => window.__view.goto(d.x, d.y + 1), d0);
  await doStep(() => page.evaluate(() => {
    const g = window.__game, t = g.terrain, d = g.layout.depot;
    // Order a dig on the nearest copper ore in range, and pretend the drone has brought ore home.
    for (let r = 4; r < 44; r++) for (let j = Math.floor(d.y / 0.25) - r; j <= Math.floor(d.y / 0.25) + r; j++) for (const i of [Math.floor(d.x / 0.25) - r, Math.floor(d.x / 0.25) + r]) {
      const k = j * 512 + i;
      if (t.material[k] === 3 && t.density[k] > 0.5 && g.inDigRange((i + 0.5) * 0.25, (j + 0.5) * 0.25)) {
        g.designate((i + 0.5) * 0.25, (j + 0.5) * 0.25, 0.2, true);
        window.__copperOrder = { x: (i + 0.5) * 0.25, y: (j + 0.5) * 0.25 };
        r = 99; break;
      }
    }
    g.oreDelivered = 5;
  }));
  // Withdraw that order again so it doesn't skew the mining checks below.
  await page.evaluate(() => { const o = window.__copperOrder; if (o) window.__game.designate(o.x, o.y, 0.3, false); });
  await doStep(() => page.evaluate(() => {
    const g = window.__game, d = g.layout.depot;
    g.resources.scrap += 8;
    g.placeSmelter(d.x - 3.2, d.y + 0.5);
    g.platesMade = 3;
  }));
  await doStep(async () => {
    await page.evaluate(() => { window.__game.resources.plates = 3; });
    await page.waitForTimeout(300);
    await page.keyboard.press('b');
  });
  await page.waitForTimeout(400);
  const tutorial = { steps: tutorialLog, done: !(await page.evaluate(() => !!document.querySelector('.tutorial'))), drones: await page.evaluate(() => window.__game.bots.length) };
  console.log('tutorial', JSON.stringify(tutorial));
  check(tutorial.steps.length === 7 && tutorial.steps.every((s) => s.items > 0 && s.ticked === s.items && s.advanced),
    `tutorial checklists tick as each action is done and move on by themselves (${tutorial.steps.map((s) => `${s.ticked}/${s.items}`).join(' ')})`);
  check(tutorial.steps.slice(1, 4).every((s) => s.pointers > 0), 'tutorial steps about the HUD highlight it and draw a line to it');
  check(tutorial.done && tutorial.drones === 2, 'tutorial finishes after building a drone');
  // Buildings need flat ground, and drones route around them (or past them when they must).
  const build = await page.evaluate(() => {
    const g = window.__game, d = g.layout.depot, t = g.terrain;
    const x = d.x + 3.2, y = d.y + 0.5;
    const flat = g.smelterSite(x, y).error ?? 'ok';
    const ci = Math.floor(x / 0.25), cj = Math.floor(d.y / 0.25) - 1, k = cj * 512 + ci + 2;
    const keep = [t.density[k], t.material[k]];
    t.density[k] = 0; t.material[k] = 0;
    const bumpy = g.smelterSite(x, y).error ?? 'ok';
    t.density[k] = keep[0]; t.material[k] = keep[1];
    const s = g.smelters[0];
    const occupiedAlong = (path) => (path ?? []).filter((p) => g.buildingAt(p.x, p.y)).length;
    const around = g.route(s.x - 1.2, s.y + 0.4, s.x + 1.0, s.y + 0.4, 0.3);
    // Wall the smelter in with "building" cells up to the ceiling: now there is no way around.
    const saved = [];
    for (let j = Math.floor(s.y / 0.25); j < Math.floor(s.y / 0.25) + 14; j++) for (let i = Math.floor((s.x - 0.45) / 0.25); i <= Math.floor((s.x + 0.45) / 0.25); i++) { saved.push([j * 512 + i, t.occupied[j * 512 + i]]); t.occupied[j * 512 + i] = 1; }
    const past = g.route(s.x - 1.2, s.y + 0.4, s.x + 1.0, s.y + 0.4, 0.3);
    for (const [k2, v] of saved) t.occupied[k2] = v;
    return { flat, bumpy, around: around ? { len: around.length, through: occupiedAlong(around) } : null, past: past ? { len: past.length, through: occupiedAlong(past) } : null };
  });
  console.log('buildings', JSON.stringify(build));
  check(build.flat === 'ok' && /flat ground/i.test(build.bumpy), 'smelters need flat ground');
  check(build.around && build.around.through === 0 && build.past && build.past.through > 0, 'drones route around buildings, and straight past them when there is no way around');

  // A third drone for the mining tests below.
  await page.evaluate(() => { const g = window.__game; g.resources.plates += 3; g.buildBot(); });

  // Dig orders outside the drones' range are refused.
  const range = await page.evaluate(() => {
    const g = window.__game;
    const c = g.digCenter;
    const count = () => g.terrain.digMark.reduce((n, v) => n + (v & 1), 0);
    const n0 = count();
    g.designate(c.x + g.digRadius + 2, c.y - 2, 0.7, true);
    return { added: count() - n0, warned: /out of drone range/i.test(g.log.at(-1).text) };
  });
  check(range.added === 0 && range.warned, 'dig orders beyond the range ring are refused');

  // Designate a strip of rock beside the base and let the drones work. Density is summed over
  // the strip's surroundings only: elsewhere, chunks streaming out turn into solid placeholders.
  await page.evaluate(() => {
    window.stripDensity = (g) => {
      const d = g.layout.depot;
      let s = 0;
      for (let y = d.y - 0.4; y < d.y + 1.8; y += 0.25) for (let x = d.x + 4.2; x < d.x + 8.6; x += 0.25) s += g.terrain.density[Math.floor(y / 0.25) * 512 + Math.floor(x / 0.25)];
      return s;
    };
  });
  const before = await page.evaluate(() => {
    const g = window.__game;
    const d = g.layout.depot;
    for (let x = 0; x < 2.4; x += 0.3) g.designate(d.x + 5.2 + x, d.y + 0.6, 0.7, true);
    // Snapshot the rock around the strip that is NOT ordered dug: lasers must leave it alone.
    const t = g.terrain;
    window.__untouched = [];
    for (let y = d.y - 0.6; y < d.y + 2.0; y += 0.25) for (let x = d.x + 4.0; x < d.x + 8.8; x += 0.25) {
      const k = Math.floor(y / 0.25) * 512 + Math.floor(x / 0.25);
      if (t.density[k] > 0.5 && !(t.digMark[k] & 1)) window.__untouched.push([k, t.density[k]]);
    }
    return { density: stripDensity(g), resources: { ...g.resources } };
  });
  // An order sealed inside solid rock is flagged unreachable; the strip beside the base is not.
  await page.evaluate(() => {
    const g = window.__game, d = g.layout.depot;
    for (let f = 0; f <= 1; f += 0.1) g.designate(d.x - 6.5 + f * 1.5, d.y - 5 - f, 0.7, true);
  });
  await fastForward(4);
  const marks = () => page.evaluate(() => {
    const g = window.__game, d = g.layout.depot, m = g.terrain.digMark;
    const out = { strip: 0, stripReach: 0, sealed: 0, sealedReach: 0 };
    for (let k = 0; k < m.length; k++) {
      if (!(m[k] & 1)) continue;
      const x = (k % 512 + 0.5) * 0.25, key = x > d.x ? 'strip' : 'sealed';
      out[key]++;
      if (m[k] & 2) out[key + 'Reach']++;
    }
    return out;
  });
  const m0 = await marks();
  check(m0.strip > 0 && m0.stripReach === m0.strip && m0.sealed > 0 && m0.sealedReach === 0,
    `dig orders flagged reachable vs unreachable (${m0.stripReach}/${m0.strip} reachable beside the base, ${m0.sealedReach}/${m0.sealed} sealed in rock)`);
  const launched = await page.evaluate(() => window.__game.bots.filter((b) => b.state !== 'docked').length);
  check(launched > 0, `drones launched from the base for the dig orders (${launched} airborne)`);
  // Batteries: a drone running low abandons its job, flies home, and recharges on its pad.
  const battery = await page.evaluate(async () => {
    const g = window.__game;
    const b = g.bots.find((o) => o.state !== 'docked');
    if (!b) return null;
    b.battery = 24.9;
    for (let n = 0; n < 15; n++) g.update(1 / 30);
    const heading = b.state;
    for (let n = 0; n < 30 * 20 && b.state !== 'docked'; n++) { g.update(1 / 30); if (n % 10 === 0) await new Promise((r) => setTimeout(r, 20)); }
    const landed = b.battery;
    for (let n = 0; n < 30 * 2; n++) g.update(1 / 30);
    return { heading, docked: b.state, landed, charged: b.battery, log: g.log.some((l) => /low on battery/.test(l.text)) };
  });
  console.log('battery', JSON.stringify(battery));
  check(battery && battery.heading === 'toDepot' && battery.docked === 'docked' && battery.charged > battery.landed + 20 && battery.log,
    `a low-battery drone flies home and recharges (${battery?.landed.toFixed(0)}% → ${battery?.charged.toFixed(0)}%)`);
  await fastForward(26);
  const m1 = await marks();
  check(m1.stripReach === 0, `drones finished every reachable dig order (${m1.stripReach} left)`);
  const after = await page.evaluate(() => {
    const g = window.__game;
    return {
      density: stripDensity(g),
      resources: g.resources,
      cargo: g.bots.reduce((s, b) => s + b.cargo.ore + b.cargo.scrap, 0),
      states: g.bots.map((b) => b.state),
      critters: g.critters.map((c) => `${c.name}:${c.happy ? 'happy' : c.complaint}`),
    };
  });
  console.log('after dig', JSON.stringify(after));
  check(after.density < before.density - 15, `bots excavated terrain (Δdensity ${(before.density - after.density).toFixed(1)})`);
  const eroded = await page.evaluate(() => window.__untouched.filter(([k, d0]) => { const d = window.__game.terrain.density[k]; return d > 0.01 && d < d0 - 1e-4; }).length);
  check(eroded === 0, `mining lasers only cut rock that is ordered dug (${eroded} unordered cells nicked)`);
  check(after.cargo + after.resources.ore + after.resources.scrap > before.resources.ore + before.resources.scrap, 'mining yielded cargo or resources');
  check(after.critters.some((c) => c.endsWith('happy')), 'at least one critter is comfortable');
  await shot('2-digging');

  // Hollow out the rock under a slab to provoke a cave-in and falling rigidbodies: build a block
  // of soft dirt beside the base and cut two holes side by side, leaving an over-long ceiling.
  await page.evaluate(() => {
    const g = window.__game, d = g.layout.depot, t = g.terrain, x = d.x + 9.5, y = d.y - 4;
    const ci = Math.floor(x / 0.25), cj = Math.floor(y / 0.25);
    for (let j = cj - 8; j <= cj + 12; j++) for (let i = ci - 14; i <= ci + 14; i++) { t.density[j * 512 + i] = 1; t.material[j * 512 + i] = 1; }
    t.markDirty(ci - 15, cj - 9, ci + 15, cj + 13, false);
    t.carve(x - 1, y, 1.4, 3);
    t.carve(x + 1, y, 1.4, 3);
  });
  await fastForward(3.5);
  const warning = await page.evaluate(() => {
    const g = window.__game;
    return {
      pending: g.pendingCollapses.length,
      cracking: g.terrain.digMark.filter((v) => v >> 8).length,
      debris: g.debris.length,
      log: g.log.slice(-10).map((l) => l.text),
    };
  });
  console.log('after undermining', JSON.stringify(warning));
  check(warning.pending > 0 && warning.cracking > 0 && warning.log.some((l) => /cave-in warning/i.test(l)),
    `undermined rock cracks with a warning (${warning.cracking} cells)`);
  // The HUD re-renders a few times a second; give the banner a moment to appear.
  await page.waitForFunction(() => document.querySelectorAll('.alerts button').length > 0, null, { timeout: 2000 }).catch(() => {});
  const alerts = await page.evaluate(() => ({ banner: document.querySelectorAll('.alerts button').length, tags: document.querySelectorAll('.bubble.collapse').length }));
  check(alerts.banner > 0 && alerts.tags > 0, `cave-in warnings shown as an alert banner and countdown tags (${alerts.banner} / ${alerts.tags})`);
  await shot('3-cracking');
  await fastForward(16);
  const cave = await page.evaluate(() => {
    const g = window.__game;
    return { debris: g.debris.length, log: g.log.slice(-10).map((l) => l.text) };
  });
  check(cave.debris > 0 || cave.log.some((l) => /came loose/i.test(l)), 'unbraced rock collapsed when the warning ran out');
  await shot('3-cavein');
  // Settled rubble re-triggers structural checks, so collapses can chain; they must converge.
  let remaining = -1;
  for (let n = 0; n < 45 && remaining !== 0; n++) {
    await fastForward(2);
    remaining = await page.evaluate(() => window.__game.debris.length + window.__game.pendingCollapses.length);
  }
  check(remaining === 0, `collapse chain converged and rubble merged back into terrain (${remaining} bodies/warnings left)`);

  // A strut placed during the warning saves the ceiling. Hollow out a room in soft rock whose
  // roof spans too far, then brace the middle as soon as it starts cracking.
  const braced = await page.evaluate(async () => {
    const g = window.__game, d = g.layout.depot;
    const cx = d.x + 4.5, cy = d.y - 2.2;
    for (let x = -1.6; x <= 1.6; x += 0.2) for (let y = 0; y <= 0.8; y += 0.2) g.terrain.carve(cx + x, cy + y, 0.3, 4);
    for (let n = 0; n < 30 && !g.pendingCollapses.length; n++) g.update(1 / 30);
    const warned = g.pendingCollapses.length;
    g.resources.scrap += 2;
    g.placeStrut(cx, cy + 0.3);
    for (let n = 0; n < 30 * 8; n++) { g.update(1 / 30); if (n % 10 === 0) await new Promise((r) => setTimeout(r, 30)); }
    return { warned, pending: g.pendingCollapses.length, debris: g.debris.length, log: g.log.slice(-4).map((l) => l.text) };
  });
  console.log('braced', JSON.stringify(braced));
  check(braced.warned > 0 && braced.pending === 0 && braced.debris === 0 && braced.log.some((l) => /cracking has stopped/i.test(l)),
    'a strut placed during the warning stopped the cave-in');

  // A ceiling just under its safe span gets an early structural warning. Build a dirt block below
  // the base and hollow out a room 8 cells wide under it (dirt holds 9).
  const strain = await page.evaluate(async () => {
    const g = window.__game, d = g.layout.depot, t = g.terrain, W = 128 * 4;
    const ci = Math.floor((d.x + 4.5) / 0.25), cj = Math.floor((d.y - 3) / 0.25);
    for (let j = cj - 2; j <= cj + 5; j++) for (let i = ci - 8; i <= ci + 8; i++) {
      const open = j >= cj && j <= cj + 1 && i >= ci - 4 && i <= ci + 3;
      t.density[j * W + i] = open ? 0 : 1;
      t.material[j * W + i] = open ? 0 : 1;
    }
    t.markDirty(ci - 9, cj - 3, ci + 9, cj + 6);
    for (let n = 0; n < 60; n++) { g.update(1 / 30); if (n % 10 === 0) await new Promise((r) => setTimeout(r, 30)); }
    const stress = (t.digMark[(cj + 2) * W + ci] >> 3) & 31;
    return { unstable: g.unstable.map((u) => Math.round(u.ratio * 100)), stress, pending: g.pendingCollapses.length, warned: g.log.some((l) => /structural warning/i.test(l.text)) };
  });
  console.log('strain', JSON.stringify(strain));
  check(strain.warned && strain.unstable.length > 0 && strain.stress >= 24 && strain.pending === 0,
    `near-collapse ceiling flagged before it fails (stress ${strain.stress}/31, ${strain.unstable.join(',')}%)`);
  await page.evaluate(() => { window.__game.overlay = 3; });
  await shot('3b-integrity');
  await page.evaluate(() => { window.__game.overlay = 0; });

  // Fog of war: the base is explored, deep rock is not.
  const fog = await page.evaluate(() => {
    const g = window.__game, d = g.layout.depot, m = g.terrain.digMark, W = 512;
    const at = (x, y) => m[Math.floor(y / 0.25) * W + Math.floor(x / 0.25)] & 4;
    return { base: !!at(d.x, d.y + 0.5), deep: !!at(d.x, d.y - 30) };
  });
  check(fog.base && !fog.deep, 'fog of war: the base is explored and deep rock is not');

  // Chunk streaming: carve a hole far from the base, fly away so its chunk is saved and unloaded,
  // then come back and check the hole is still there.
  const away = await page.evaluate(async () => {
    const g = window.__game, d = g.layout.depot;
    const x = d.x - 40, y = d.y - 60;
    window.__view.goto(x, y);
    for (let n = 0; n < 60; n++) { g.update(1 / 30); await new Promise((r) => setTimeout(r, 20)); }
    const id = Math.floor(y / 8) * 16 + Math.floor(x / 8);
    const loadedFar = g.chunks.isLoaded(id);
    g.terrain.carve(x, y, 0.8, 3);
    const sum = () => { let s = 0; const i0 = (id % 16) * 32, j0 = Math.floor(id / 16) * 32; for (let j = j0; j < j0 + 32; j++) for (let i = i0; i < i0 + 32; i++) s += g.terrain.density[j * 512 + i]; return s; };
    const carved = sum();
    window.__view.goto(d.x, d.y + 1);
    for (let n = 0; n < 150; n++) { g.update(1 / 30); await new Promise((r) => setTimeout(r, 20)); }
    const unloaded = !g.chunks.isLoaded(id), placeholder = sum();
    window.__view.goto(x, y);
    for (let n = 0; n < 60; n++) { g.update(1 / 30); await new Promise((r) => setTimeout(r, 20)); }
    const restored = sum();
    window.__view.goto(d.x, d.y + 1);
    for (let n = 0; n < 20; n++) { g.update(1 / 30); await new Promise((r) => setTimeout(r, 20)); }
    return { loadedFar, carved, unloaded, placeholder, restored, resident: g.chunks.resident.size };
  });
  console.log('streaming', JSON.stringify(away));
  check(away.loadedFar && away.unloaded && away.placeholder === 1024 && Math.abs(away.restored - away.carved) < 1e-3 && away.carved < 1020,
    `far chunk streamed in, saved on unload and restored with the player's changes (${away.resident} resident)`);

  // Struts follow the rock: build a dirt chamber 2m tall with a strut in it, then dig under it.
  const telescope = await page.evaluate(async () => {
    const g = window.__game, d = g.layout.depot, t = g.terrain, W = 512;
    const run = async (s) => { for (let n = 0; n < s * 30; n++) { g.update(1 / 30); if (n % 10 === 0) await new Promise((r) => setTimeout(r, 20)); } };
    const ci = Math.floor((d.x + 6) / 0.25), cj = Math.floor((d.y + 2) / 0.25);
    const set = (i, j, open) => { t.density[j * W + i] = open ? 0 : 1; t.material[j * W + i] = open ? 0 : 1; t.digMark[j * W + i] &= 4; };
    for (let j = cj - 30; j <= cj + 12; j++) for (let i = ci - 6; i <= ci + 6; i++) set(i, j, j >= cj && j < cj + 8 && Math.abs(i - ci) <= 4);
    t.markDirty(ci - 7, cj - 31, ci + 7, cj + 13, false);
    g.resources.scrap += 2;
    const n0 = g.struts.length;
    g.placeStrut((ci + 0.5) * 0.25, (cj + 3) * 0.25);
    const s = g.struts[n0];
    const placed = s ? s.j1 - s.j0 + 1 : 0;
    // Dig 1m out from under the bottom plate: the strut stretches down to the new floor.
    for (let j = cj - 4; j < cj; j++) for (let i = ci - 1; i <= ci + 1; i++) set(i, j, true);
    t.markDirty(ci - 2, cj - 5, ci + 2, cj);
    await run(0.5);
    const stretched = s.j1 - s.j0 + 1, brokenAfterStretch = s.broken;
    // Order a dig another 2m down: that would take it past 4m, so it warns and asks first.
    const order = () => { for (let y = (cj - 5) * 0.25; y > (cj - 12) * 0.25; y -= 0.2) g.designate((ci + 0.5) * 0.25, y, 0.3, true); };
    // (The log keeps the last 40 entries, so compare entry ids rather than its length.)
    const lastId = g.log.at(-1)?.id ?? 0;
    g.tool = 'dig';
    order();
    const warned = g.log.some((l) => l.id > lastId && /undermine a strut/i.test(l.text));
    const atRisk = s.atRisk;
    await new Promise((r) => setTimeout(r, 350));
    const asked = !!document.querySelector('.confirm');
    // The question sits by the held dig orders, not at a fixed spot on screen.
    window.__view.goto(g.strutConfirm.x, g.strutConfirm.y + 1);
    await new Promise((r) => setTimeout(r, 400));
    const anchored = (() => {
      const c = g.strutConfirm, cam = window.__view.camera, box = document.querySelector('.confirm')?.getBoundingClientRect();
      if (!c || !box) return false;
      const e = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
      const w = e[3] * c.x + e[7] * c.y + e[15];
      const sx = ((e[0] * c.x + e[4] * c.y + e[12]) / w * 0.5 + 0.5) * innerWidth, sy = (-(e[1] * c.x + e[5] * c.y + e[13]) / w * 0.5 + 0.5) * innerHeight;
      return sx >= box.left - 20 && sx <= box.right + 20 && Math.min(Math.abs(sy - box.top), Math.abs(sy - box.bottom)) < 60;
    })();
    window.__view.goto(d.x, d.y + 1);
    const held = !g.exposedTargets({ x: (ci + 0.5) * 0.25, y: (cj - 5) * 0.25 }, g.bots[0]).some((k) => Math.abs((k % W) - ci) <= 6);
    // Cancel: the orders around the strut go and it is safe again.
    document.querySelector('.confirm button:last-child').click();
    const marksLeft = (() => { let n = 0; for (let j = cj - 12; j < cj; j++) n += t.digMark[j * W + ci] & 1; return n; })();
    const safe = !s.atRisk && !g.strutConfirm;
    // Order it again and dig anyway.
    order();
    g.resolveStrutConfirm(true);
    // Dig it for real: the strut gives up and stops supporting anything.
    for (let j = cj - 12; j < cj - 4; j++) for (let i = ci - 1; i <= ci + 1; i++) set(i, j, true);
    t.markDirty(ci - 2, cj - 13, ci + 2, cj - 4);
    await run(0.5);
    const broken = s.broken, bitsCleared = t.strut[(cj + 2) * W + ci] === 0;
    const tag = !!document.querySelector('.bubble.strut.broken');
    g.designate((ci + 0.5) * 0.25, (cj - 8) * 0.25, 3, false);
    return { placed, stretched, brokenAfterStretch, warned, atRisk, asked, anchored, held, marksLeft, safe, broken, bitsCleared, tag };
  });
  console.log('telescope', JSON.stringify(telescope));
  check(telescope.placed === 8 && telescope.stretched === 12 && !telescope.brokenAfterStretch, `a strut stretches when the floor under it is dug out (${telescope.placed} → ${telescope.stretched} cells)`);
  check(telescope.warned && telescope.atRisk && telescope.asked && telescope.held, 'a dig order that would undermine a strut is held and asks for confirmation');
  check(telescope.anchored, 'the confirmation is pinned beside the dig orders in question');
  check(telescope.marksLeft === 0 && telescope.safe, 'cancelling from the confirmation clears the digs around the strut');
  check(telescope.broken && telescope.bitsCleared && telescope.tag, 'a strut dug out past its limit stops supporting and is flagged');

  // The Scrap tool takes a strut down for 1 scrap back.
  const scrapped = await page.evaluate(() => {
    const g = window.__game, s = g.struts.find((o) => !o.broken);
    const n = g.struts.length, scrap = g.resources.scrap;
    g.tool = 'scrap';
    g.useTool((s.i + 0.5) * 0.25, (s.j0 + s.j1 + 1) * 0.125, false);
    g.tool = 'dig';
    return { removed: n - g.struts.length, refund: g.resources.scrap - scrap, bits: g.terrain.strut[((s.j0 + s.j1) >> 1) * 512 + s.i] };
  });
  check(scrapped.removed === 1 && scrapped.refund === 1 && scrapped.bits === 0, 'Scrap tool removes a strut and refunds 1 scrap');

  // Struts are limited in height: the shaft above the base is far too tall to brace.
  const tall = await page.evaluate(() => {
    const g = window.__game, d = g.layout.depot;
    const before = g.struts.length;
    g.resources.scrap += 2;
    const site = g.strutSite(d.x, d.y + 6);
    g.placeStrut(d.x, d.y + 6);
    return { error: site.error ?? '', span: (site.j1 - site.j0 + 1) * 0.25, placed: g.struts.length - before };
  });
  check(/too tall/i.test(tall.error) && tall.placed === 0, `struts refuse gaps over their height limit (${tall.span}m gap: "${tall.error}")`);

  // Plain cursor: the default tool, and hovering things describes them.
  const project = (x, y, z) => page.evaluate(([x, y, z]) => {
    const cam = window.__view.camera, e = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left + ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * r.width, y: r.top + (-(e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5 + 0.5) * r.height };
  }, [x, y, z]);
  const hover = async (x, y, z) => {
    const p = await project(x, y, z);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(400);
    return page.evaluate(() => { const el = document.querySelector('.inspector'); return el.style.display === 'block' ? el.textContent : ''; });
  };
  await page.evaluate(() => { window.__game.tool = 'select'; });
  const base = await page.evaluate(() => window.__game.layout.depot);
  // The default cursor is plain: hovering shows nothing. The Info tool (I) describes things.
  const plain = await hover(base.x, base.y + 0.45, -0.775);
  await page.keyboard.press('i');
  const tool0 = await page.evaluate(() => window.__game.tool);
  const hoverBase = await hover(base.x, base.y + 0.45, -0.775);
  const hoverRock = await hover(base.x, base.y - 1.2, 0);
  const icons = await page.evaluate(() => [...document.querySelectorAll('.tools button, .layers > button')].every((b) => b.querySelector('svg')));
  console.log('hover', JSON.stringify({ tool0, hoverBase, hoverRock }));
  check(plain === '' && tool0 === 'info' && /Base/.test(hoverBase) && /drones docked/.test(hoverBase) && /dig|Cannot be dug/i.test(hoverRock), 'the plain cursor is plain; the Info tool describes what it hovers (the base, the rock)');
  check(icons, 'every tool and layer button has an icon');

  // Smelters craft in batches: ore in, plate out; the Info card shows a progress ring and recipe.
  const craft = await page.evaluate(async () => {
    const g = window.__game, s = g.smelters[0];
    g.resources.ore += 2;
    const plates0 = g.platesMade;
    for (let n = 0; n < 30; n++) g.update(1 / 30);
    const mid = { crafting: s.crafting, f: s.smeltTimer / 2.5 };
    for (let n = 0; n < 60; n++) g.update(1 / 30);
    return { mid, made: g.platesMade - plates0, x: s.x, y: s.y };
  });
  const smelterCard = await page.evaluate(async ({ x, y }) => {
    window.__game.resources.ore += 1;
    for (let n = 0; n < 20; n++) window.__game.update(1 / 30);
    window.__view.goto(x, y + 0.5);
    return null;
  }, craft);
  await page.waitForTimeout(400);
  const card2 = await hover(craft.x - 0.1, craft.y + 0.4, -1.25 * 0.45);
  const cardHtml = await page.evaluate(() => document.querySelector('.inspector').innerHTML);
  check(craft.mid.crafting && craft.mid.f > 0.2 && craft.made >= 1, `smelter takes ore and makes plates in batches (${craft.made} made)`);
  check(/Smelter/.test(card2) && /class="ring"/.test(cardHtml) && /class="recipe"/.test(cardHtml) && /\/min/.test(card2),
    'the smelter Info card shows job progress and its recipe');
  await page.evaluate(() => { const d = window.__game.layout.depot; window.__view.goto(d.x, d.y + 1); });
  await page.evaluate(() => { window.__game.tool = 'dig'; });
  await hover(base.x + 3.5, base.y + 1.2, 0);
  await shot('8-dig-cursor');

  // Square brush paints more of a square than the round one does.
  const brush = await page.evaluate(() => {
    const g = window.__game, d = g.layout.depot, t = g.terrain;
    const count = () => t.digMark.reduce((n, v) => n + (v & 1), 0);
    const paint = (sq, x) => { g.brushSquare = sq; const n0 = count(); g.designate(x, d.y - 3, 0.7, true); const n = count() - n0; g.designate(x, d.y - 3, 0.9, false); return n; };
    const out = { round: paint(false, d.x - 1.5), square: paint(true, d.x + 1.5) };
    g.brushSquare = false;
    return out;
  });
  check(brush.square > brush.round, `square brush covers a square (${brush.square} cells vs ${brush.round} round)`);

  // Resource icons in the top bar, and cost cards on priced buttons.
  const resIcons = await page.evaluate(() => document.querySelectorAll('.topbar .res svg').length);
  await page.getByRole('button', { name: /Smelter/ }).hover();
  await page.waitForTimeout(250);
  const card = await page.evaluate(() => { const c = document.querySelector('.cost-card'); return c ? { bar: c.querySelector('.cost-bar').textContent, icons: c.querySelectorAll('.cost-bar svg').length } : null; });
  await page.mouse.move(640, 300);
  check(resIcons === 4 && card && /8/.test(card.bar) && card.icons === 1, `resources have icons, and building cards lead with their cost (${card?.bar})`);

  // Esc from the plain cursor opens the main menu and pauses; Settings can switch alerts off.
  await page.evaluate(() => { window.__game.tool = 'select'; });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const t0 = await page.evaluate(() => window.__game.time);
  await page.waitForTimeout(500);
  const paused = await page.evaluate((t0) => ({ menu: !!document.querySelector('.modal.menu'), frozen: window.__game.time === t0 && window.__game.paused }), t0);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel(/Invalid actions and hints/).uncheck();
  const silenced = await page.evaluate(() => {
    const g = window.__game, n = g.log.length, last = g.log.at(-1)?.id;
    g.placeStrut(0.5, 0.5);
    return { hints: g.alerts.hints, logged: g.log.at(-1)?.id !== last, saved: JSON.parse(localStorage.getItem('clankworks-settings')).alerts.hints };
  });
  await page.getByLabel(/Invalid actions and hints/).check();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const resumed = await page.evaluate(() => ({ menu: !!document.querySelector('.modal'), paused: window.__game.paused }));
  check(paused.menu && paused.frozen, 'Esc from the plain cursor opens the main menu and pauses the game');
  check(silenced.hints === false && !silenced.logged && silenced.saved === false && !resumed.menu && !resumed.paused, 'Settings switch an alert category off (and Esc backs out of the dialogs)');

  // Real input path: toolbar button, canvas click, and hotkeys.
  const ui = await page.evaluate(() => {
    const g = window.__game;
    g.resources.scrap += 10; g.resources.plates += 3;
    g.tool = 'dig';
    const d = g.layout.depot;
    const v = { x: d.x - 2.5, y: d.y + 1.2, z: 0 };
    const cam = window.__view.camera;
    // Project the world point to CSS pixels.
    const m = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse);
    const e = m.elements;
    const w = e[3] * v.x + e[7] * v.y + e[11] * v.z + e[15];
    const nx = (e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12]) / w;
    const ny = (e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13]) / w;
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left + (nx * 0.5 + 0.5) * r.width, y: r.top + (-ny * 0.5 + 0.5) * r.height, struts: g.struts.length, bots: g.bots.length };
  });
  await page.getByRole('button', { name: /Strut/ }).click();
  await page.mouse.click(ui.x, ui.y);
  await page.keyboard.press('b');
  await page.waitForTimeout(300);
  const uiAfter = await page.evaluate(() => ({ struts: window.__game.struts.length, bots: window.__game.bots.length, tool: window.__game.tool }));
  check(uiAfter.tool === 'strut' && uiAfter.struts === ui.struts + 1, `toolbar + canvas click placed a strut (${ui.struts} → ${uiAfter.struts})`);
  check(uiAfter.bots === ui.bots + 1, 'B hotkey built a new drone');
  await fastForward(1);
  await shot('4-ui');

  await page.evaluate(() => { window.__game.overlay = 1; });
  await shot('5-heat');
  await page.evaluate(() => { window.__game.overlay = 2; });
  await shot('6-oxygen');
  // Material layer with a clickable key: hiding a material clears its bit.
  await page.evaluate(() => { window.__game.overlay = 4; });
  await page.waitForTimeout(400);
  const key = await page.evaluate(() => [...document.querySelectorAll('.legend button')].map((b) => b.textContent));
  await page.getByRole('button', { name: 'Granite' }).click();
  const mask = await page.evaluate(() => window.__game.materialMask);
  check(key.length === 7 && ((mask >> 2) & 1) === 0 && ((mask >> 1) & 1) === 1, `material layer key lists ${key.length} materials and toggles them (mask ${mask.toString(2)})`);
  await shot('7-materials');
  await page.getByRole('button', { name: 'Granite' }).click();
  await page.evaluate(() => { window.__game.overlay = 0; });
} catch (e) {
  check(false, `exception: ${e.message}`);
}

const serious = errors.filter((e) => !/Failed to load resource/.test(e));
check(serious.length === 0, `no console errors (${serious.length})`);
for (const e of [...new Set(serious)].slice(0, 10)) console.log('  ' + e.slice(0, 400));
await browser.close();
await server?.close();
process.exit(failed ? 1 : 0);

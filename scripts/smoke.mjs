// End-to-end smoke test: boots the game in Chromium with WebGPU, fast-forwards the simulation
// through digging, a blast and a cave-in, checks GPU-produced state, and saves screenshots.
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
    const f = g.gpu.fluidSnapshot, f0 = g.layout.fluid, t = g.gpu.tempSnapshot, t0 = g.layout.temperature;
    let changed = 0, nan = 0, maxRockT = 0;
    for (let k = 0; k < t.length; k++) {
      if (Math.abs(f[k * 4 + 2] - f0[k * 4 + 2]) > 1e-3 || Math.abs(t[k] - t0[k]) > 1e-2) changed++;
      if (!Number.isFinite(t[k]) || !Number.isFinite(f[k * 4]) || !Number.isFinite(f[k * 4 + 2])) nan++;
      if (g.terrain.density[k] > 0.5) maxRockT = Math.max(maxRockT, t[k]);
    }
    const args = new Uint32Array(await g.gpu.renderer.getArrayBufferAsync(g.gpu.meshDrawArgs));
    return { changed, nan, maxRockT, meshVerts: args[0] };
  });
  console.log('gpu', JSON.stringify(gpu));
  check(gpu.changed > 1000, `GPU fluid/thermal kernels evolved the state (${gpu.changed} cells changed)`);
  check(gpu.nan === 0, 'no NaNs in GPU fluid/thermal state');
  check(gpu.maxRockT > 200, `magma conducts heat into surrounding rock (max rock ${gpu.maxRockT.toFixed(0)}°C)`);
  check(gpu.meshVerts > 50000, `GPU mesher compacted ${gpu.meshVerts} terrain vertices`);

  const docked = await page.evaluate(() => window.__game.bots.map((b) => b.state));
  check(docked.length === 3 && docked.every((s) => s === 'docked'), `drones start docked at the base (${docked.join(',')})`);

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

  // Designate a strip of rock beside the base and let the drones work.
  const before = await page.evaluate(() => {
    const g = window.__game;
    const d = g.layout.depot;
    for (let x = 0; x < 2.4; x += 0.3) g.designate(d.x + 4.2 + x, d.y + 0.6, 0.7, true);
    return { density: g.terrain.density.reduce((a, b) => a + b, 0), resources: { ...g.resources } };
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
      const x = (k % 128 + 0.5) * 0.25, key = x > d.x ? 'strip' : 'sealed';
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
  await fastForward(26);
  const m1 = await marks();
  check(m1.stripReach === 0, `drones finished every reachable dig order (${m1.stripReach} left)`);
  const after = await page.evaluate(() => {
    const g = window.__game;
    return {
      density: g.terrain.density.reduce((a, b) => a + b, 0),
      resources: g.resources,
      cargo: g.bots.reduce((s, b) => s + b.cargo.ore + b.cargo.scrap, 0),
      states: g.bots.map((b) => b.state),
      critters: g.critters.map((c) => `${c.name}:${c.happy ? 'happy' : c.complaint}`),
    };
  });
  console.log('after dig', JSON.stringify(after));
  check(after.density < before.density - 15, `bots excavated terrain (Δdensity ${(before.density - after.density).toFixed(1)})`);
  check(after.cargo + after.resources.ore + after.resources.scrap > before.resources.ore + before.resources.scrap, 'mining yielded cargo or resources');
  check(after.critters.some((c) => c.endsWith('happy')), 'at least one critter is comfortable');
  await shot('2-digging');

  // Blast the rock under a slab to provoke a cave-in and falling rigidbodies.
  const blast = await page.evaluate(() => {
    const g = window.__game;
    const d = g.layout.depot;
    g.resources.scrap += 5;
    g.tool = 'blast';
    // Two charges side by side in the soft dirt below the surface leave an over-long ceiling.
    const y = (g.layout.surfaceRow - 9) * 0.25;
    g.useTool(d.x - 7, y, false);
    g.useTool(d.x - 9, y, false);
    g.tool = 'dig';
    return g.blasts.length;
  });
  check(blast === 2, 'blast charges placed');
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
  console.log('after blast', JSON.stringify(warning));
  check(warning.pending > 0 && warning.cracking > 0 && warning.log.some((l) => /cave-in warning/i.test(l)),
    `blast left unsupported rock cracking with a warning (${warning.cracking} cells)`);
  await shot('3-cracking');
  await fastForward(7);
  const cave = await page.evaluate(() => {
    const g = window.__game;
    return { debris: g.debris.length, log: g.log.slice(-10).map((l) => l.text) };
  });
  check(cave.debris > 0 || cave.log.some((l) => /came loose/i.test(l)), 'unbraced rock collapsed when the warning ran out');
  await shot('3-cavein');
  // Settled rubble re-triggers structural checks, so collapses can chain; they must converge.
  let remaining = -1;
  for (let n = 0; n < 20 && remaining !== 0; n++) {
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

  // Real input path: toolbar button, canvas click, and hotkeys.
  const ui = await page.evaluate(() => {
    const g = window.__game;
    g.resources.scrap += 10; g.resources.plates += 3; g.resources.goo += 2;
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

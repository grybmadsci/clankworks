// Debug helper: node scripts/inspect.mjs [query] [seconds] — logs console output with timestamps
// and samples game state once per second. Expects `npm run dev` on port 5287, or run it through
// scripts/win.mjs.
import { baseUrl, gotoApp, launchBrowser, newPage } from './browser.mjs';

const [query = '', seconds = '8'] = process.argv.slice(2);
const browser = await launchBrowser();
const page = await newPage(browser);
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
page.on('console', (m) => console.log(`${stamp()} [${m.type()}] ${m.text().slice(0, 600)}`));
page.on('pageerror', (e) => console.log(`${stamp()} [pageerror] ${e.message.slice(0, 600)}`));
await gotoApp(page, new URL(query, baseUrl ?? 'http://localhost:5287/').href);
for (let s = 0; s < Number(seconds); s++) {
  await page.waitForTimeout(1000);
  const info = await page.evaluate(() => {
    const g = window.__game, c = document.querySelector('canvas');
    return g && { t: g.time.toFixed(1), frames: g.frames, low: c?.dataset.quality, canvas: c && `${c.width}x${c.height}`, bots: g.bots.map((b) => b.state).join(',') };
  }).catch((e) => 'eval failed ' + e.message);
  console.log(`${stamp()} state ${JSON.stringify(info)}`);
}
await page.screenshot({ path: 'smoke-inspect.png' });
await browser.close();

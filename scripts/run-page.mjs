// Usage: node scripts/run-page.mjs <url> [waitMs] [screenshot.png]
// Opens a page with WebGPU enabled and prints console output. Relative URLs resolve against the
// dev server, or against BASE_URL when run through scripts/win.mjs.
import { baseUrl, launchBrowser, newPage } from './browser.mjs';

const [url, waitMs = '8000', shot] = process.argv.slice(2);
const browser = await launchBrowser();
const page = await newPage(browser);
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(new URL(url, baseUrl ?? 'http://localhost:5287/').href);
await page.waitForFunction(() => window.__done === true, null, { timeout: Number(waitMs) }).catch(() => {});
if (shot) await page.screenshot({ path: shot });
await browser.close();

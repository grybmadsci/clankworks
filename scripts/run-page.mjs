// Usage: node scripts/run-page.mjs <url> [waitMs] [screenshot.png]
// Opens a page in headless Chromium with WebGPU enabled and prints console output.
import { chromium } from 'playwright';

const [url, waitMs = '8000', shot] = process.argv.slice(2);
const browser = await chromium.launch({ headless: process.env.HEADLESS === '1', channel: 'chromium', args: ['--enable-unsafe-webgpu', ...(process.env.CHROME_ARGS ?? '').split(' ').filter(Boolean)] });
const [vw, vh] = (process.env.VIEWPORT ?? '1280x800').split('x').map(Number);
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => window.__done === true, null, { timeout: Number(waitMs) }).catch(() => {});
if (shot) await page.screenshot({ path: shot });
await browser.close();

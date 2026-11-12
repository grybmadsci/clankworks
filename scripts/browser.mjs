// Shared browser launch for the test scripts.
//
// Under WSL, Linux Chromium only gets the SwiftShader (CPU) WebGPU adapter and can't present WebGPU
// canvases headless. scripts/win.mjs reruns a script with Windows Node so Playwright drives the
// Windows install of Chrome on the real GPU; that path runs headless by default.
import { chromium } from 'playwright';

export const onWindows = process.platform === 'win32';
export const baseUrl = process.env.BASE_URL;

export function launchBrowser() {
  const headless = process.env.HEADLESS ? process.env.HEADLESS === '1' : onWindows;
  const args = ['--enable-unsafe-webgpu', ...(process.env.CHROME_ARGS ?? '').split(' ').filter(Boolean)];
  return chromium.launch({ headless, channel: onWindows ? 'chrome' : 'chromium', args });
}

export async function newPage(browser) {
  const [width, height] = (process.env.VIEWPORT ?? '1280x800').split('x').map(Number);
  return browser.newPage({ viewport: { width, height } });
}

/** page.goto that rides out the moment before WSL starts forwarding a freshly opened port. */
export async function gotoApp(page, url) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.goto(url);
    } catch (e) {
      if (attempt >= 20 || !/ERR_CONNECTION_REFUSED/.test(e.message)) throw e;
      await page.waitForTimeout(500);
    }
  }
}

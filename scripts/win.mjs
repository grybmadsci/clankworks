// Usage (from WSL): node scripts/win.mjs <script.mjs> [args...]
// Serves the app from WSL on 127.0.0.1:5288 (reachable from Windows through WSL localhost
// forwarding) and runs the script with Windows Node, so Playwright drives Windows Chrome on the
// real GPU. HEADLESS, VIEWPORT and CHROME_ARGS are passed through.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const [script, ...args] = process.argv.slice(2);
if (!script) { console.error('usage: node scripts/win.mjs <script.mjs> [args...]'); process.exit(2); }

const server = await createServer({ server: { host: '127.0.0.1', port: 5288, strictPort: true }, logLevel: 'error' });
await server.listen();
const env = {
  ...process.env,
  BASE_URL: 'http://127.0.0.1:5288/',
  WSLENV: ['BASE_URL', 'HEADLESS', 'VIEWPORT', 'CHROME_ARGS', process.env.WSLENV].filter(Boolean).join(':'),
};
const child = spawn('node.exe', [script, ...args], { stdio: 'inherit', env });
const code = await new Promise((resolve) => {
  child.on('exit', (c) => resolve(c ?? 1));
  child.on('error', (e) => { console.error(`could not start node.exe: ${e.message}`); resolve(1); });
});
await server.close();
process.exit(code);

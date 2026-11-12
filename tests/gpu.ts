// Kernel harness: builds the real starting world and dispatches the compute kernels in stages,
// reporting whether the GPU device survives and whether outputs look sane.
import { WebGPURenderer } from 'three/webgpu';
import { Game } from '../src/game/Game';

const out = document.createElement('pre');
document.body.append(out);
const log = (s: string) => { out.textContent += s + '\n'; console.log(s); };
const only = new URLSearchParams(location.search).get('only');

(async () => {
  const renderer = new WebGPURenderer();
  await renderer.init();
  const device = (renderer.backend as any).device as GPUDevice;
  let lost = false;
  device.lost.then((i) => { lost = true; log('DEVICE LOST: ' + i.message); });
  const game = await Game.create();
  game.attachGpu(renderer);
  const gpu = game.gpu!;
  const kernels: [string, () => void][] = [
    ['mesh+sim', () => gpu.update(1 / 60)],
    ['spawn', () => { gpu.burst(game.layout.depot.x, game.layout.depot.y + 1, 100, 1); gpu.update(0); }],
    ['particles', () => renderer.compute(gpu.particleNode)],
  ];
  for (const [name, run] of kernels) {
    if (only && only !== name) continue;
    run();
    await device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 300));
    log(`${name}: ${lost ? 'LOST' : 'ok'}`);
    if (lost) break;
  }
  const mode = new URLSearchParams(location.search).get('loop');
  if (mode && !lost) {
    const t0 = performance.now();
    let frames = 0;
    while (performance.now() - t0 < 4000 && !lost) {
      gpu.update(1 / 60);
      if (mode === 'readback' && frames % 10 === 0) await gpu.readback();
      await device.queue.onSubmittedWorkDone();
      frames++;
    }
    log(`loop(${mode}): ${frames} frames in 4s, ${lost ? 'LOST' : 'ok'}`);
  }
  if (!lost) {
    const args = new Uint32Array(await renderer.getArrayBufferAsync(gpu.meshDrawArgs));
    let verts = 0, slots = 0;
    for (let s = 0; s < args.length; s += 4) if (args[s]) { verts += args[s]; slots++; }
    log(`mesh: ${verts / 3} triangles across ${slots} chunk slots`);
  }
  (window as any).__done = true;
})().catch((e) => { log('ERROR ' + e.message); (window as any).__done = true; });

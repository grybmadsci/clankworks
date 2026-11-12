// Kernel harness: builds the real world and dispatches each compute kernel in isolation,
// reporting whether the GPU device survives and whether outputs look sane.
import { WebGPURenderer } from 'three/webgpu';
import { GpuSim } from '../src/gpu/GpuSim';
import { generateWorld } from '../src/sim/worldgen';

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
  const world = generateWorld();
  const gpu = new GpuSim(renderer, world.terrain, world.fluid, world.temperature);
  const kernels: [string, () => void][] = [
    ['fluid', () => renderer.compute(gpu.stepNodes[0])],
    ['thermal', () => renderer.compute(gpu.stepNodes[1])],
    ['mesh', () => gpu.meshNodes.forEach((n) => renderer.compute(n))],
    ['spawn', () => { gpu.burst(10, 40, 100, 1); (gpu as any).update(0); }],
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
    log(`mesh draw args: ${Array.from(args).join(',')} (${args[0] / 3} triangles)`);
  }
  (window as any).__done = true;
})().catch((e) => { log('ERROR ' + e.message); (window as any).__done = true; });

import { Canvas } from '@react-three/fiber';
import { useEffect, useState } from 'react';
import * as THREE from 'three/webgpu';
import { Game } from './game/Game';
import { chooseQuality } from './render/quality';
import { Scene } from './render/Scene';
import { Hud } from './ui/Hud';

declare global {
  interface Window { __game?: Game; __ready?: boolean }
}

const gpuHandles: unknown[] = [];

export function App() {
  const [game, setGame] = useState<Game | null>(null);
  const [gpuReady, setGpuReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!navigator.gpu) { setError('This game needs WebGPU (compute shaders). Try a recent Chrome or Edge.'); return; }
    Game.create().then((g) => { window.__game = g; setGame(g); }, (e) => setError(String(e)));
  }, []);

  if (error) return <div className="splash error">{error}</div>;
  if (!game) return <div className="splash">Booting scrapbots…</div>;
  return (
    <>
      <Canvas
        camera={{ fov: 38, near: 0.1, far: 120, position: [16, 40, 16] }}
        dpr={new URLSearchParams(location.search).get('quality') === 'low' ? 0.75 : [1, 2]}
        gl={async (props) => {
          // Request the device ourselves and keep the adapter referenced for the page's lifetime;
          // some Chromium builds drop the GPU instance when only the device is held.
          const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
          const device = await adapter!.requestDevice({
            requiredLimits: { maxStorageBufferBindingSize: adapter!.limits.maxStorageBufferBindingSize, maxBufferSize: adapter!.limits.maxBufferSize },
          });
          gpuHandles.push(adapter, device);
          if (chooseQuality(adapter)) (props as { canvas: HTMLCanvasElement }).canvas.dataset.quality = 'low';
          const renderer = new THREE.WebGPURenderer({ ...(props as object), antialias: true, device } as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
          await renderer.init();
          if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
            setError('WebGPU is unavailable, so the compute shaders cannot run.');
          }
          renderer.toneMapping = THREE.ACESFilmicToneMapping;
          game.attachGpu(renderer);
          setGpuReady(true);
          window.__ready = true;
          return renderer;
        }}
      >
        {gpuReady && <Scene game={game} />}
      </Canvas>
      {gpuReady && <Hud game={game} />}
    </>
  );
}

import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { CELL, DEPTH, H, MAX_PARTICLES, W } from '../config';
import type { Game } from '../game/Game';
import { quality } from './quality';
import { backWallMaterial, fluidMaterial, overlayMaterial, particleMaterial, terrainMaterial } from './materials';

const WORLD_W = W * CELL, WORLD_H = H * CELL;

/**
 * Terrain mesh produced by the GPU mesher. Vertex positions come from a storage buffer and the
 * vertex count from GPU-written indirect draw args, so the CPU never sees the mesh.
 */
export function TerrainMesh({ game }: { game: Game }) {
  const mesh = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    geo.setIndirect(game.gpu!.meshDrawArgs);
    const m = new THREE.Mesh(geo, terrainMaterial(game.gpu!));
    m.frustumCulled = false;
    return m;
  }, [game]);
  return <primitive object={mesh} />;
}

/** Fluids as translucent slices stacked through the diorama depth, pooling against the back wall. */
export function Fluids({ game }: { game: Game }) {
  const meshes = useMemo(() => (quality.low ? [-0.55] : [-0.12, -0.55, -1.0]).map((z, layer) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W, WORLD_H), fluidMaterial(game.gpu!, layer));
    m.position.set(WORLD_W / 2, WORLD_H / 2, z);
    m.renderOrder = 2 + layer;
    return m;
  }), [game]);
  const overlay = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W, WORLD_H), overlayMaterial(game.gpu!));
    m.position.set(WORLD_W / 2, WORLD_H / 2, 0.05);
    m.renderOrder = 10;
    return m;
  }, [game]);
  return <>{meshes.map((m, n) => <primitive key={n} object={m} />)}<primitive object={overlay} /></>;
}

export function Particles({ game }: { game: Game }) {
  const mesh = useMemo(() => {
    // Tetrahedral chips: 12 vertices each keeps 16k instances cheap.
    const chip = new THREE.TetrahedronGeometry(0.8);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', chip.getAttribute('position'));
    geo.setAttribute('normal', chip.getAttribute('normal'));
    geo.instanceCount = MAX_PARTICLES;
    const m = new THREE.Mesh(geo, particleMaterial(game.gpu!));
    m.frustumCulled = false;
    return m;
  }, [game]);
  return <primitive object={mesh} />;
}

/** Back wall of the cavity, plus a sky backdrop above the surface. */
export function BackWall() {
  const mesh = useMemo(() => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W + 40, WORLD_H + 30), backWallMaterial());
    m.position.set(WORLD_W / 2, WORLD_H / 2 + 10, -DEPTH - 0.01);
    return m;
  }, []);
  return <primitive object={mesh} />;
}

/** Dark out-of-focus rock framing the foreground and the world edges, for parallax depth. */
export function Foreground() {
  const rocks = useMemo(() => {
    const out: { x: number; y: number; z: number; w: number; h: number; r: number }[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // Edge pillars that frame the diorama.
    for (const x of [-1.2, WORLD_W + 1.2]) out.push({ x, y: WORLD_H / 2 - 4, z: 1.2, w: 2.6, h: WORLD_H, r: 0 });
    // Slim stalactite silhouettes hugging the world edges, close to the camera.
    for (let n = 0; n < 26; n++) {
      const side = n % 2 ? -0.3 - rnd() * 0.8 : WORLD_W + 0.3 + rnd() * 0.8;
      out.push({ x: side, y: rnd() * (WORLD_H - 6), z: 1.6 + rnd() * 1.2, w: 0.15 + rnd() * 0.3, h: 0.8 + rnd() * 2.2, r: (rnd() - 0.5) * 0.5 });
    }
    // Solid rock beyond the side and bottom walls.
    out.push({ x: -12, y: WORLD_H / 2 - 6, z: -0.4, w: 24, h: WORLD_H + 12, r: 0 });
    out.push({ x: WORLD_W + 12, y: WORLD_H / 2 - 6, z: -0.4, w: 24, h: WORLD_H + 12, r: 0 });
    out.push({ x: WORLD_W / 2, y: -6, z: -0.4, w: WORLD_W + 48, h: 12, r: 0 });
    return out;
  }, []);
  return (
    <group>
      {rocks.map((r, n) => (
        <mesh key={n} position={[r.x, r.y, r.z]} rotation={[0, 0, r.r]}>
          <boxGeometry args={[r.w, r.h, n < 28 ? 0.6 : 1.5]} />
          <meshStandardMaterial color={n < 28 ? '#141110' : '#2a2421'} roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

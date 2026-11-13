import { useMemo } from 'react';
import * as THREE from 'three/webgpu';
import { DEPTH } from '../config';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ELECTRO } from './electro';
import { rustMaterial } from './materials';

/**
 * How buildings stand in the cavern: like the main base, they hang off the back wall rather than
 * standing on the floor. A riveted plate is bolted to the wall and triangular gussets reach out
 * from it to carry the building's deck. Every building uses this (pass its own `material` for
 * placement holograms).
 */
const MOUNT_MATS = { plate: rustMaterial('#25221f', 0.5), deck: rustMaterial('#2c2724', 0.45) };

/** The cavern's back wall, as a z offset from a building whose origin is at `z` (world). */
export const wallZ = (z: number) => -DEPTH + 0.03 - z;

function gussetGeometry(reach: number, top: number, drop: number) {
  // Drawn as (distance out from the wall, height), extruded sideways, then turned so "out" is +z.
  const g = new THREE.ExtrudeGeometry(new THREE.Shape([
    new THREE.Vector2(0, top), new THREE.Vector2(reach, top), new THREE.Vector2(reach, top - 0.04), new THREE.Vector2(0, top - drop),
  ]), { depth: 0.035, bevelEnabled: false });
  g.translate(0, 0, -0.0175);
  g.rotateY(-Math.PI / 2);
  return g;
}

/**
 * A wall mount for a building whose origin is at world depth `z`: a back plate `width` × `height`
 * (bottom at `bottom`), a deck `deckWidth` wide whose top is at `deckTop` and which reaches from the
 * wall out to `front` (local z), and `gussets` brackets under it. Omit `deckWidth` for no deck;
 * pass `plate={false}` for a further deck on a plate already mounted.
 */
export function WallMount({ z, width, height, bottom = -0.1, deckWidth, deckTop = 0.1, front = 0.3, gussets = 2, plate = true, material }: {
  z: number; width: number; height: number; bottom?: number; deckWidth?: number; deckTop?: number; front?: number; gussets?: number; plate?: boolean; material?: THREE.Material;
}) {
  const m = (own: THREE.Material) => material ?? own;
  const wz = wallZ(z), reach = front - wz;
  const geo = useMemo(() => ({
    plate: new RoundedBoxGeometry(width, height, 0.04, 3, 0.02),
    gusset: gussetGeometry(reach - 0.04, deckTop - 0.04, Math.max(0.12, deckTop + 0.3)),
  }), [width, height, reach, deckTop]);
  const bolts = [-1, 1].flatMap((sx) => [bottom + 0.08, bottom + height - 0.08].map((y) => [sx * (width / 2 - 0.07), y] as const));
  const gx = Array.from({ length: gussets }, (_, n) => (gussets === 1 ? 0 : -(deckWidth ?? width) / 2 + 0.08 + (n * ((deckWidth ?? width) - 0.16)) / (gussets - 1)));
  return (
    <>
      {plate && <mesh geometry={geo.plate} material={m(MOUNT_MATS.plate)} position={[0, bottom + height / 2, wz]} />}
      {plate && bolts.map(([x, y]) => (
        <mesh key={`${x}:${y}`} position={[x, y, wz + 0.03]} rotation={[Math.PI / 2, 0, 0]} material={m(ELECTRO.brass)}><cylinderGeometry args={[0.022, 0.022, 0.025, 6]} /></mesh>
      ))}
      {deckWidth !== undefined && (
        <>
          <mesh position={[0, deckTop - 0.02, wz + reach / 2]} material={m(MOUNT_MATS.deck)}><boxGeometry args={[deckWidth, 0.04, reach]} /></mesh>
          {gx.map((x) => <mesh key={x} geometry={geo.gusset} material={m(MOUNT_MATS.plate)} position={[x, 0, wz]} />)}
        </>
      )}
    </>
  );
}

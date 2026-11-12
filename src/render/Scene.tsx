import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { float, mix, pass, screenUV, vec4 } from 'three/tsl';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { CELL, H, SKY_ROWS, W } from '../config';
import { enabled } from '../debug';
import { unlockAudio } from '../game/audio';
import type { Game } from '../game/Game';
import { Entities, SmelterBody, StrutBody, Z_ACTORS } from './Entities';
import { gameTime, hologramMaterial, materialMask, overlayMode } from './materials';
import { quality } from './quality';
import { BackWall, Fluids, Foreground, Particles, TerrainMesh } from './World';

const WORLD_W = W * CELL, WORLD_H = H * CELL;

/** Shared with the DOM HUD, which projects speech bubbles itself. */
export const view = {
  camera: null as THREE.PerspectiveCamera | null,
  /** Where the pointer meets the cutaway face (z = 0), or null when it is off the canvas. */
  cursor: null as { x: number; y: number } | null,
  /** The pointer's ray, refreshed every frame so it stays right while the camera moves. */
  ray: null as THREE.Ray | null,
  /** Pointer position in CSS pixels, for HUD tooltips. */
  mouse: { x: 0, y: 0 },
  /** Centre the camera on a world position (set up by the camera rig). */
  goto: (_x: number, _y: number) => {},
};
(window as unknown as { __view: typeof view }).__view = view;

export function Scene({ game }: { game: Game }) {
  const setDpr = useThree((s) => s.setDpr);
  useEffect(() => { if (quality.low) setDpr(0.75); }, [setDpr]);
  useFrame((_, dt) => {
    game.update(dt);
    overlayMode.value = game.overlay;
    materialMask.value = game.materialMask;
    gameTime.value = game.time;
  }, -1);
  return (
    <>
      <color attach="background" args={['#050506']} />
      <fog attach="fog" args={['#050506', 22, 55]} />
      {/* Underground: barely any ambient light, so lamps, glowing machinery and magma do the work. */}
      <hemisphereLight args={['#8a96aa', '#2a1e16', 0.32]} />
      <directionalLight position={[8, 20, 14]} intensity={0.3} color="#ffe9cf" />
      <directionalLight position={[-10, 4, 6]} intensity={0.08} color="#8fb4ff" />
      <BackWall game={game} />
      {enabled('mesh') && <TerrainMesh game={game} />}
      {enabled('fluid') && <Fluids game={game} />}
      {enabled('particles') && <Particles game={game} />}
      {enabled('entities') && <Entities game={game} />}
      <Foreground />
      <DigRange game={game} />
      <SmelterHologram game={game} />
      <StrutHologram game={game} />
      <ScrapHighlight game={game} />
      <Cursor game={game} />
      <CameraRig game={game} />
      {enabled('post') && !quality.low && <PostFx />}
    </>
  );
}

/**
 * Cabinet-style perspective camera: WASD / arrow keys or right-drag to pan, wheel to zoom.
 * Left mouse applies the active tool on the z=0 cutaway plane.
 */
function CameraRig({ game }: { game: Game }) {
  const { camera, gl } = useThree();
  const state = useRef({ x: game.layout.depot.x, y: game.layout.depot.y + 1, dist: 16, following: true, ndc: null as THREE.Vector2 | null, recast: null as null | (() => void), keys: new Set<string>(), painting: false, panning: null as null | { x: number; y: number } });

  useEffect(() => {
    view.camera = camera as THREE.PerspectiveCamera;
    const el = gl.domElement;
    const s = state.current;
    view.goto = (x, y) => { s.x = x; s.y = y; };
    const raycaster = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const toWorld = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = new THREE.Vector3();
      return raycaster.ray.intersectPlane(plane, hit) ? { x: hit.x, y: hit.y } : null;
    };
    // Re-cast the pointer every frame (the camera pans, zooms and shakes under a still mouse).
    s.recast = () => {
      if (!s.ndc) { view.cursor = null; view.ray = null; return; }
      raycaster.setFromCamera(s.ndc, camera);
      const hit = new THREE.Vector3();
      view.ray = raycaster.ray.clone();
      view.cursor = raycaster.ray.intersectPlane(plane, hit) ? { x: hit.x, y: hit.y } : null;
    };
    const track = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      view.mouse = { x: e.clientX, y: e.clientY };
      const over = e.target === el && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      s.ndc = over ? new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1) : null;
    };
    const down = (e: PointerEvent) => {
      unlockAudio();
      if (e.button === 2 || e.button === 1) { s.panning = { x: e.clientX, y: e.clientY }; return; }
      const p = toWorld(e);
      if (!p) return;
      s.painting = true;
      el.setPointerCapture(e.pointerId);
      game.useTool(p.x, p.y, false);
    };
    const move = (e: PointerEvent) => {
      track(e);
      const p = toWorld(e);
      if (s.panning) {
        const scale = s.dist * 0.0012;
        s.x -= (e.clientX - s.panning.x) * scale;
        s.y += (e.clientY - s.panning.y) * scale;
        s.panning = { x: e.clientX, y: e.clientY };
      } else if (s.painting && p) {
        game.useTool(p.x, p.y, true);
      }
    };
    const up = () => { s.painting = false; s.panning = null; };
    const wheel = (e: WheelEvent) => { e.preventDefault(); s.dist = Math.min(42, Math.max(6, s.dist * (1 + Math.sign(e.deltaY) * 0.1))); };
    const key = (e: KeyboardEvent) => {
      if (e.type === 'keydown') s.keys.add(e.key.toLowerCase()); else s.keys.delete(e.key.toLowerCase());
    };
    const menu = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', menu);
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    return () => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', menu);
      window.removeEventListener('keydown', key);
      window.removeEventListener('keyup', key);
    };
  }, [camera, gl, game]);

  useFrame((_, dt) => {
    const s = state.current;
    // Follow the base down its shaft, and land on it when the intro ends (or is skipped).
    if (game.intro.phase !== 'done' || s.following) {
      const d = game.layout.depot;
      s.x = d.x;
      s.y = d.y + game.intro.offset + 0.9;
      s.dist += (11 - s.dist) * Math.min(1, dt * 2);
      s.keys.clear();
      s.following = game.intro.phase !== 'done';
    }
    const speed = s.dist * 0.9 * dt;
    if (s.keys.has('a') || s.keys.has('arrowleft')) s.x -= speed;
    if (s.keys.has('d') || s.keys.has('arrowright')) s.x += speed;
    if (s.keys.has('w') || s.keys.has('arrowup')) s.y += speed;
    if (s.keys.has('s') || s.keys.has('arrowdown')) s.y -= speed;
    s.x = Math.min(WORLD_W, Math.max(0, s.x));
    s.y = Math.min(WORLD_H - SKY_ROWS * CELL * 0.5, Math.max(0, s.y));
    const shake = game.shake * 0.15;
    const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake;
    // Slightly above and looking down into the diorama, cabinet style.
    camera.position.set(s.x + sx, s.y + s.dist * 0.16 + sy, s.dist);
    camera.lookAt(s.x + sx * 0.5, s.y + sy * 0.5, -0.6);
    camera.updateMatrixWorld();
    s.recast?.();
    // Tell the game what is on screen, so it can stream the chunks in.
    const cam = camera as THREE.PerspectiveCamera;
    const halfH = (s.dist + 0.6) * Math.tan((cam.fov * Math.PI) / 360);
    game.view = { x: s.x, y: s.y, halfW: halfH * cam.aspect, halfH };
  });
  return null;
}

/**
 * What the active tool will touch. Dig and Cancel show their brush as a disc hatched like the
 * dig orders themselves (amber to dig, red to erase or when out of the drones' range), other
 * placement tools a small ring; the plain cursor, Strut and Smelter (which have holograms) none.
 */
function Cursor({ game }: { game: Game }) {
  const ring = useRef<THREE.Mesh>(null!);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null!);
  const { disc, square, tint } = useMemo(() => {
    const { abs, color, fract, fwidth, positionWorld, smoothstep, uniform } = TSL as any;
    const tint = uniform(color('#ffbe2e'));
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    const u = positionWorld.x.add(positionWorld.y).mul(11);
    const hatch = smoothstep(float(0.35).sub(fwidth(u)), fwidth(u).add(0.35), abs(fract(u).sub(0.5)));
    m.colorNode = tint;
    m.opacityNode = hatch.mul(0.55).add(0.12);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48), m);
    disc.renderOrder = 19;
    // Square brush: a 4-sided circle turned 45° is a square with half-side 1/√2, so scale by √2.
    const square = new THREE.Mesh(new THREE.CircleGeometry(Math.SQRT2, 4, Math.PI / 4), m);
    square.renderOrder = 19;
    return { disc, square, tint };
  }, []);
  const squareRing = useRef<THREE.Mesh>(null!);
  useFrame(() => {
    const c = view.cursor;
    const brush = game.tool === 'dig' || game.tool === 'cancel';
    const marker = game.tool === 'scrap';
    const sq = brush && game.brushSquare;
    ring.current.visible = !!c && (brush || marker) && !sq;
    squareRing.current.visible = !!c && sq;
    disc.visible = !!c && brush && !sq;
    square.visible = !!c && sq;
    if (!c) return;
    const r = game.tool === 'dig' ? 0.7 : game.tool === 'cancel' ? 0.9 : 0.25;
    const bad = game.tool === 'cancel' || (game.tool === 'dig' && !game.inDigRange(c.x, c.y));
    const col = bad ? '#ff5544' : '#ffd23f';
    ring.current.position.set(c.x, c.y, 0.08);
    ring.current.scale.setScalar(r);
    ringMat.current.color.set(col);
    disc.position.set(c.x, c.y, 0.07);
    disc.scale.setScalar(r * 0.95);
    square.position.set(c.x, c.y, 0.07);
    square.scale.setScalar(r * 0.95);
    squareRing.current.position.set(c.x, c.y, 0.08);
    squareRing.current.scale.setScalar(r);
    (squareRing.current.material as THREE.MeshBasicMaterial).color.set(col);
    tint.value.set(bad ? '#ff5544' : '#ffbe2e');
  });
  return (
    <>
      <primitive object={disc} />
      <primitive object={square} />
      <mesh ref={squareRing} renderOrder={20}>
        <ringGeometry args={[Math.SQRT2 * 0.95, Math.SQRT2, 4, 1, Math.PI / 4]} />
        <meshBasicMaterial transparent opacity={0.85} depthTest={false} />
      </mesh>
      <mesh ref={ring} renderOrder={20}>
        <ringGeometry args={[0.92, 1, 40]} />
        <meshBasicMaterial ref={ringMat} transparent opacity={0.85} depthTest={false} />
      </mesh>
    </>
  );
}

/**
 * With the Smelter tool, a hologram of the building follows the cursor, snapped to where it
 * would actually stand: cyan when it can be built there, red when it can't.
 */
function SmelterHologram({ game }: { game: Game }) {
  const group = useRef<THREE.Group>(null!);
  const { material, tint } = useMemo(hologramMaterial, []);
  useFrame(() => {
    const c = view.cursor;
    const show = game.tool === 'smelter' && !!c;
    group.current.visible = show;
    if (!show) return;
    const site = game.smelterSite(c.x, c.y);
    group.current.position.set(site.x, site.y, Z_ACTORS);
    tint.value.set(site.error ? '#ff4a3a' : '#5fe3ff');
  });
  return (
    <group ref={group} visible={false} renderOrder={15}>
      <SmelterBody material={material} />
      <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]} material={material}><ringGeometry args={[0.5, 0.56, 32]} /></mesh>
    </group>
  );
}

/**
 * With the Strut tool, a hologram of the strut spans the gap under the cursor, floor to ceiling:
 * cyan when it can be built, red when it can't (too tall, no floor or ceiling, no scrap).
 */
function StrutHologram({ game }: { game: Game }) {
  const { material, tint } = useMemo(hologramMaterial, []);
  const [site, setSite] = useState<{ i: number; j0: number; j1: number; key: string } | null>(null);
  useFrame(() => {
    const c = view.cursor;
    const s = game.tool === 'strut' && c ? game.strutSite(c.x, c.y) : null;
    // Nothing to preview when pointing into rock.
    const next = s && s.j1 > s.j0 ? { i: s.i, j0: s.j0, j1: s.j1, key: `${s.i}:${s.j0}:${s.j1}` } : null;
    if (s) tint.value.set(s.error ? '#ff4a3a' : '#5fe3ff');
    if (next?.key !== site?.key) setSite(next);
  });
  return site ? <group key={site.key} renderOrder={15}><StrutBody strut={site} material={material} /></group> : null;
}

/** With the Scrap tool, the strut under the cursor lights up red. */
function ScrapHighlight({ game }: { game: Game }) {
  const { material, tint } = useMemo(hologramMaterial, []);
  const [target, setTarget] = useState<{ i: number; j0: number; j1: number; key: string } | null>(null);
  useMemo(() => tint.value.set('#ff5a2a'), [tint]);
  useFrame(() => {
    const c = view.cursor;
    const s = game.tool === 'scrap' && c ? game.strutAt(c.x, c.y) : undefined;
    const next = s ? { i: s.i, j0: s.j0, j1: s.j1, key: `${s.id}:${s.j0}:${s.j1}` } : null;
    if (next?.key !== target?.key) setTarget(next);
  });
  return target ? <group key={target.key} renderOrder={15}><StrutBody strut={target} material={material} /></group> : null;
}

/** Dashed ring marking how far from the base the drones will dig; brighter with the Dig tools. */
function DigRange({ game }: { game: Game }) {
  const { mesh, opacity } = useMemo(() => {
    const { atan, positionLocal, step, time, uniform } = TSL as any;
    const opacity = uniform(0.2);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false });
    m.colorNode = TSL.color('#7fd8ff');
    // 90 dashes that creep slowly around the ring.
    const dash = step(0.45, atan(positionLocal.y, positionLocal.x).mul(90 / (2 * Math.PI)).add(time.mul(0.6)).fract());
    m.opacityNode = dash.mul(opacity);
    const r = game.digRadius;
    const mesh = new THREE.Mesh(new THREE.RingGeometry(r - 0.05, r, 360), m);
    mesh.position.set(game.digCenter.x, game.digCenter.y, 0.06);
    mesh.renderOrder = 19;
    return { mesh, opacity };
  }, [game]);
  useFrame(() => { opacity.value = game.tool === 'dig' || game.tool === 'cancel' ? 0.75 : 0.18; });
  return <primitive object={mesh} />;
}

/** Screen-space ambient occlusion (GTAO from depth) and bloom for magma, sparks and lamps. */
function PostFx() {
  const { gl, scene, camera } = useThree();
  const pipeline = useMemo(() => {
    const renderer = gl as unknown as THREE.WebGPURenderer;
    const p = new THREE.RenderPipeline(renderer);
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const aoPass = ao(depth, null as never, camera);
    aoPass.resolutionScale = 0.5;
    const occlusion = mix(float(0.35), float(1), aoPass.getTextureNode().sample(screenUV).r);
    const lit = vec4(color.rgb.mul(occlusion), color.a);
    p.outputNode = lit.add(bloom(lit, 0.55, 0.35, 0.85));
    return p;
  }, [gl, scene, camera]);
  useEffect(() => () => pipeline.dispose(), [pipeline]);
  useFrame(() => pipeline.render(), 1);
  return null;
}

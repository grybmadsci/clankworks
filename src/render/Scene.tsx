import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { float, mix, pass, screenUV, vec4 } from 'three/tsl';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { CELL, H, SKY_ROWS, W } from '../config';
import { enabled } from '../debug';
import { unlockAudio } from '../game/audio';
import type { Game } from '../game/Game';
import { Entities } from './Entities';
import { gameTime, overlayMode } from './materials';
import { quality } from './quality';
import { BackWall, Fluids, Foreground, Particles, TerrainMesh } from './World';

const WORLD_W = W * CELL, WORLD_H = H * CELL;

/** Shared with the DOM HUD, which projects speech bubbles itself. */
export const view = { camera: null as THREE.PerspectiveCamera | null, cursor: null as { x: number; y: number } | null };
(window as unknown as { __view: typeof view }).__view = view;

export function Scene({ game }: { game: Game }) {
  const setDpr = useThree((s) => s.setDpr);
  useEffect(() => { if (quality.low) setDpr(0.75); }, [setDpr]);
  useFrame((_, dt) => {
    game.update(dt);
    overlayMode.value = game.overlay;
    gameTime.value = game.time;
  }, -1);
  return (
    <>
      <color attach="background" args={['#0c0b0d']} />
      <fog attach="fog" args={['#0c0b0d', 24, 60]} />
      <hemisphereLight args={['#b9c4d6', '#3a2a20', 1.1]} />
      <directionalLight position={[8, 20, 14]} intensity={1.6} color="#ffe9cf" />
      <directionalLight position={[-10, 4, 6]} intensity={0.35} color="#8fb4ff" />
      <BackWall />
      {enabled('mesh') && <TerrainMesh game={game} />}
      {enabled('fluid') && <Fluids game={game} />}
      {enabled('particles') && <Particles game={game} />}
      {enabled('entities') && <Entities game={game} />}
      <Foreground />
      <DigRange game={game} />
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
  const state = useRef({ x: game.layout.depot.x, y: game.layout.depot.y + 1, dist: 16, keys: new Set<string>(), painting: false, panning: null as null | { x: number; y: number } });

  useEffect(() => {
    view.camera = camera as THREE.PerspectiveCamera;
    const el = gl.domElement;
    const s = state.current;
    const raycaster = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const toWorld = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = new THREE.Vector3();
      return raycaster.ray.intersectPlane(plane, hit) ? { x: hit.x, y: hit.y } : null;
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
      const p = toWorld(e);
      view.cursor = p;
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
  });
  return null;
}

/** Brush preview ring that follows the mouse. */
function Cursor({ game }: { game: Game }) {
  const ref = useRef<THREE.Mesh>(null!);
  const mat = useRef<THREE.MeshBasicMaterial>(null!);
  useFrame(() => {
    const c = view.cursor;
    ref.current.visible = !!c;
    if (!c) return;
    ref.current.position.set(c.x, c.y, 0.08);
    const r = game.tool === 'dig' ? 0.7 : game.tool === 'cancel' ? 0.9 : 0.25;
    ref.current.scale.setScalar(r);
    const outOfRange = game.tool === 'dig' && !game.inDigRange(c.x, c.y);
    mat.current.color.set(game.tool === 'cancel' || outOfRange ? '#ff5544' : game.tool === 'blast' ? '#ff2222' : '#ffd23f');
  });
  return (
    <mesh ref={ref} renderOrder={20}>
      <ringGeometry args={[0.92, 1, 40]} />
      <meshBasicMaterial ref={mat} transparent opacity={0.8} depthTest={false} />
    </mesh>
  );
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

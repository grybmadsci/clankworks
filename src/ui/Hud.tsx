import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { DEPTH } from '../config';
import type { Game, Tool } from '../game/Game';
import { unlockAudio } from '../game/audio';
import { view } from '../render/Scene';

const TOOLS: { id: Tool; key: string; label: string; hint: string }[] = [
  { id: 'dig', key: '1', label: 'Dig', hint: 'Paint rock for the drones to mine (within the dashed range ring)' },
  { id: 'cancel', key: '2', label: 'Cancel', hint: 'Erase dig designations' },
  { id: 'strut', key: '3', label: 'Strut', hint: 'Floor-to-ceiling steel support; braces cracking rock (2 scrap)' },
  { id: 'smelter', key: '4', label: 'Smelter', hint: 'Turns ore into plates. Runs hot (8 scrap)' },
  { id: 'blast', key: '5', label: 'Blast', hint: 'Demolition charge, 2.5s fuse (1 scrap)' },
];
const OVERLAYS = ['Normal view', 'Heat overlay', 'Oxygen overlay'];

/** DOM overlay: resources, tools, critter status, the status log, and emote speech bubbles. */
export function Hud({ game }: { game: Game }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 200);
    const key = (e: KeyboardEvent) => {
      unlockAudio();
      const tool = TOOLS.find((t) => t.key === e.key);
      if (tool) game.tool = tool.id;
      if (e.key === 'b') game.buildBot();
      if (e.key === 't') game.overlay = ((game.overlay + 1) % 3) as 0 | 1 | 2;
      force((n) => n + 1);
    };
    window.addEventListener('keydown', key);
    return () => { clearInterval(id); window.removeEventListener('keydown', key); };
  }, [game]);

  const r = game.resources;
  const alive = game.bots.filter((b) => !b.dead);
  const fmt = (v: number) => (v < 10 ? v.toFixed(1) : Math.floor(v).toString());
  return (
    <div className="hud">
      <header className="topbar">
        <div className="title">CLANKWORKS <span>Rustbucket Logistics</span></div>
        <Res label="Ore" value={fmt(r.ore)} color="#d9844a" />
        <Res label="Scrap" value={fmt(r.scrap)} color="#9aa3ad" />
        <Res label="Plates" value={fmt(r.plates)} color="#f0b84a" />
        <Res label="Goo" value={fmt(r.goo)} color="#8fd65a" />
        <Res label="Drones" value={`${alive.length}`} color="#7fd8ff" />
        <div className="quota">
          <div>Quota {game.platesMade}/{game.quota} plates</div>
          <div className="bar"><div style={{ width: `${Math.min(100, (game.platesMade / game.quota) * 100)}%` }} /></div>
        </div>
      </header>

      <nav className="tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={game.tool === t.id ? 'active' : ''} title={t.hint} onClick={() => { game.tool = t.id; force((n) => n + 1); }}>
            <kbd>{t.key}</kbd>{t.label}
          </button>
        ))}
        <button className="build" title="3 plates + 2 critter goo" onClick={() => { unlockAudio(); game.buildBot(); force((n) => n + 1); }}>
          <kbd>B</kbd>Build drone
        </button>
        <button onClick={() => { game.overlay = ((game.overlay + 1) % 3) as 0 | 1 | 2; force((n) => n + 1); }}>
          <kbd>T</kbd>{OVERLAYS[game.overlay]}
        </button>
      </nav>

      <aside className="panel critters">
        <h3>Terrarium</h3>
        {game.critters.map((c) => (
          <div key={c.id} className={c.dead ? 'dead' : c.happy ? 'happy' : 'sad'}>
            <span>{c.name}</span>
            <span>{c.dead ? 'expired' : c.happy ? 'thriving' : c.complaint}</span>
            <meter min={0} max={100} value={Math.max(0, c.health)} />
          </div>
        ))}
      </aside>

      <aside className="panel log">
        {game.log.slice(-8).map((l) => <div key={l.id} className={l.kind}>{l.text}</div>)}
      </aside>

      <div className="help">Left-click: use tool · Right-drag / WASD: pan · Wheel: zoom</div>
      <Bubbles game={game} />
    </div>
  );
}

function Res({ label, value, color }: { label: string; value: string; color: string }) {
  return <div className="res"><i style={{ background: color }} />{label}<b>{value}</b></div>;
}

/** Floating emote speech bubbles, projected from world space every animation frame. */
function Bubbles({ game }: { game: Game }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const els = new Map<number, HTMLDivElement>();
    const v = new THREE.Vector3();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cam = view.camera, host = root.current;
      if (!cam || !host) return;
      const live = new Set<number>();
      for (const b of game.bubbles) {
        live.add(b.id);
        let el = els.get(b.id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'bubble';
          el.textContent = b.text;
          host.appendChild(el);
          els.set(b.id, el);
        }
        v.set(b.x, b.y + 0.45, -DEPTH * 0.45).project(cam);
        el.style.transform = `translate(-50%, -100%) translate(${(v.x * 0.5 + 0.5) * host.clientWidth}px, ${(-v.y * 0.5 + 0.5) * host.clientHeight}px)`;
        el.style.opacity = String(Math.min(1, b.ttl * 2));
      }
      // Countdown tags over rock that is cracking ahead of a cave-in.
      for (const p of game.pendingCollapses) {
        const id = -p.id;
        live.add(id);
        let el = els.get(id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'bubble collapse';
          host.appendChild(el);
          els.set(id, el);
        }
        el.textContent = `⚠ Cave-in ${Math.max(0, p.due - game.time).toFixed(1)}s`;
        v.set(p.x, p.y, 0).project(cam);
        el.style.transform = `translate(-50%, -50%) translate(${(v.x * 0.5 + 0.5) * host.clientWidth}px, ${(-v.y * 0.5 + 0.5) * host.clientHeight}px)`;
      }
      for (const [id, el] of els) if (!live.has(id)) { el.remove(); els.delete(id); }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [game]);
  return <div ref={root} className="bubbles" />;
}

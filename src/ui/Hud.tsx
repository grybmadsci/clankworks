import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { DEPTH } from '../config';
import type { Game, Overlay, Tool } from '../game/Game';
import { MATERIAL_KEY } from '../render/materials';
import { unlockAudio } from '../game/audio';
import { view } from '../render/Scene';

interface ToolDef { id: Tool; key: string; label: string; hint: string }
const ORDERS: ToolDef[] = [
  { id: 'dig', key: '1', label: 'Dig', hint: 'Paint rock for the drones to mine, inside the dashed range ring. Amber hatching: drones can reach it. Red: no access yet' },
  { id: 'cancel', key: '2', label: 'Cancel', hint: 'Erase dig designations' },
  { id: 'blast', key: '3', label: 'Blast', hint: 'Demolition charge, 2.5s fuse (1 scrap)' },
  { id: 'scrap', key: 'X', label: 'Scrap', hint: 'Take down a strut for 1 scrap back. Whatever it was holding up may come down' },
];
const BUILDINGS: ToolDef[] = [
  { id: 'strut', key: '4', label: 'Strut', hint: 'Floor-to-ceiling steel support up to 4m; stretches when its ends are dug out; braces cracking rock (2 scrap)' },
  { id: 'smelter', key: '5', label: 'Smelter', hint: 'Turns ore into plates (8 scrap). Shows a hologram where it would go' },
];
const TOOLS = [...ORDERS, ...BUILDINGS];
const LAYERS = [
  { label: 'Normal', hint: 'Plain view' },
  { label: 'Heat', hint: 'Temperature: blue freezing, green comfortable, red hot' },
  { label: 'Oxygen', hint: 'Breathable air in blue, none in red, toxic gas in green' },
  { label: 'Integrity', hint: 'Structural stress: green sound, yellow to red near its limit, flashing when cracking' },
  { label: 'Material', hint: 'What the ground is made of, in high-contrast colours. Click the key to show or hide each material' },
];

/** DOM overlay: resources, tools, critter status, the status log, and emote speech bubbles. */
export function Hud({ game }: { game: Game }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 200);
    const key = (e: KeyboardEvent) => {
      unlockAudio();
      if (game.intro.phase !== 'done') {
        if (e.key === ' ') game.skipIntro();
        return;
      }
      const tool = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (tool) game.tool = tool.id;
      if (e.key === 'b') game.buildBot();
      if (e.key === 't') game.overlay = ((game.overlay + 1) % LAYERS.length) as Overlay;
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

      {game.intro.phase !== 'done' ? (
        <div className="intro">
          <div>{game.intro.phase === 'drill' ? `Drilling to the dig site — ${game.intro.offset.toFixed(0)}m to go` : 'Touchdown. Deploying the base…'}</div>
          <button onClick={() => { unlockAudio(); game.skipIntro(); force((n) => n + 1); }}><kbd>Space</kbd>Skip</button>
        </div>
      ) : (
        <nav className="tools">
          <ToolGroup title="Orders">
            {ORDERS.map((t) => <ToolButton key={t.id} t={t} game={game} onPick={() => force((n) => n + 1)} />)}
          </ToolGroup>
          <ToolGroup title="Buildings">
            {BUILDINGS.map((t) => <ToolButton key={t.id} t={t} game={game} onPick={() => force((n) => n + 1)} />)}
            <button className="build" title="A mining drone: 3 plates + 2 critter goo (one per landing pad)" onClick={() => { unlockAudio(); game.buildBot(); force((n) => n + 1); }}>
              <kbd>B</kbd>Drone
            </button>
          </ToolGroup>
        </nav>
      )}

      {game.intro.phase === 'done' && (
        <aside className="panel layers">
          <h3>Layers <span>T cycles</span></h3>
          {LAYERS.map((l, n) => (
            <button key={l.label} title={l.hint} className={game.overlay === n ? 'active' : ''} onClick={() => { game.overlay = n as Overlay; force((k) => k + 1); }}>
              {l.label}
            </button>
          ))}
          {game.overlay === 4 && (
            <div className="legend">
              {MATERIAL_KEY.map((m) => {
                const on = (game.materialMask >> m.id) & 1;
                return (
                  <button key={m.id} className={on ? 'on' : 'off'} title={`${on ? 'Hide' : 'Show'} ${m.name.toLowerCase()}`}
                    onClick={() => { game.materialMask ^= 1 << m.id; force((k) => k + 1); }}>
                    <i style={{ background: m.color }} />{m.name}
                  </button>
                );
              })}
            </div>
          )}
        </aside>
      )}

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

      {game.pendingCollapses.length > 0 && (
        <div className="alerts">
          {game.pendingCollapses.slice(0, 3).map((p) => (
            <button key={p.id} onClick={() => view.goto(p.x, p.y)} className={p.due - game.time < 5 ? 'urgent' : ''}>
              ⚠ CAVE-IN in {Math.max(0, p.due - game.time).toFixed(0)}s — place a strut under the cracking rock
            </button>
          ))}
        </div>
      )}

      <aside className="panel log">
        {game.log.slice(-8).map((l) => <div key={l.id} className={l.kind}>{l.text}</div>)}
      </aside>

      <div className="help">Left-click: use tool · Right-drag / WASD: pan · Wheel: zoom</div>
      <Bubbles game={game} />
    </div>
  );
}

function ToolGroup({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="tool-group">
      <h4>{title}{hint && <span>{hint}</span>}</h4>
      <div>{children}</div>
    </section>
  );
}

function ToolButton({ t, game, onPick }: { t: ToolDef; game: Game; onPick: () => void }) {
  return (
    <button className={game.tool === t.id ? 'active' : ''} title={t.hint} onClick={() => { game.tool = t.id; onPick(); }}>
      <kbd>{t.key}</kbd>{t.label}
    </button>
  );
}

function Res({ label, value, color }: { label: string; value: string; color: string }) {
  return <div className="res"><i style={{ background: color }} />{label}<b>{value}</b></div>;
}

/** Floating emote speech bubbles, projected from world space every animation frame. */
function Bubbles({ game }: { game: Game }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const els = new Map<number | string, HTMLDivElement>();
    const v = new THREE.Vector3();
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const cam = view.camera, host = root.current;
      if (!cam || !host) return;
      const live = new Set<number | string>();
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
      // Countdown tags over rock that is cracking ahead of a cave-in. Off-screen ones stick to the
      // screen edge with an arrow pointing at the danger; clicking a tag jumps the camera there.
      const W = host.clientWidth, H = host.clientHeight;
      for (const p of game.pendingCollapses) {
        const id = -p.id;
        live.add(id);
        let el = els.get(id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'bubble collapse';
          el.title = 'Jump to the cracking rock';
          el.onclick = () => view.goto(p.x, p.y);
          host.appendChild(el);
          els.set(id, el);
        }
        const left = Math.max(0, p.due - game.time);
        v.set(p.x, p.y, 0).project(cam);
        let sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
        const inset = { x: 90, top: 70, bottom: 110 };
        const off = sx < inset.x || sx > W - inset.x || sy < inset.top || sy > H - inset.bottom;
        let arrow = '⚠';
        if (off) {
          const cx = W / 2, cy = H / 2, dx = sx - cx, dy = sy - cy;
          const k = Math.min((W / 2 - inset.x) / Math.max(Math.abs(dx), 1e-3), (H / 2 - (dy < 0 ? inset.top : inset.bottom)) / Math.max(Math.abs(dy), 1e-3));
          sx = cx + dx * k; sy = cy + dy * k;
          arrow = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'][(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
        }
        el.textContent = `${arrow} Cave-in ${left.toFixed(1)}s`;
        el.classList.toggle('offscreen', off);
        el.classList.toggle('urgent', left < 5);
        el.style.transform = `translate(-50%, -50%) translate(${sx}px, ${sy}px)`;
      }
      // Struts that were dug out, or would be by pending dig orders.
      for (const s of game.struts) {
        if (!s.broken && !s.atRisk) continue;
        const id = `s${s.id}`;
        live.add(id);
        let el = els.get(id);
        if (!el) {
          el = document.createElement('div');
          host.appendChild(el);
          els.set(id, el);
        }
        el.className = `bubble strut ${s.broken ? 'broken' : 'risk'}`;
        el.textContent = s.broken ? '⚠ Strut not supporting' : '⚠ Dig will undermine strut';
        v.set((s.i + 0.5) * 0.25, ((s.j0 + s.j1 + 1) / 2) * 0.25, 0).project(cam);
        el.style.transform = `translate(-50%, -50%) translate(${(v.x * 0.5 + 0.5) * W}px, ${(-v.y * 0.5 + 0.5) * H}px)`;
      }
      // Early warnings over ceilings close to their safe span.
      for (const u of game.unstable) {
        const id = 'u' + u.key;
        live.add(id);
        let el = els.get(id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'bubble unstable';
          host.appendChild(el);
          els.set(id, el);
        }
        el.textContent = `⚠ Unstable ${Math.round(u.ratio * 100)}%`;
        v.set(u.x, u.y, 0).project(cam);
        el.style.transform = `translate(-50%, -50%) translate(${(v.x * 0.5 + 0.5) * host.clientWidth}px, ${(-v.y * 0.5 + 0.5) * host.clientHeight}px)`;
      }
      for (const [id, el] of els) if (!live.has(id)) { el.remove(); els.delete(id); }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [game]);
  return <div ref={root} className="bubbles" />;
}

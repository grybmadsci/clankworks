import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three/webgpu';
import { DEPTH } from '../config';
import { ALERTS, COST, TUTORIAL, type AlertKind, type Game, type Overlay, type Tool } from '../game/Game';
import { MATERIAL_KEY } from '../render/materials';
import { inspect } from '../game/inspect';
import { Icon, cursorFor } from './icons';
import { setVolume, unlockAudio } from '../game/audio';
import { view } from '../render/Scene';

interface ToolDef { id: Tool; key: string; label: string; hint: string }
const ORDERS: ToolDef[] = [
  { id: 'select', key: 'Esc', label: 'Select', hint: 'Plain cursor. Press Esc again for the menu' },
  { id: 'info', key: 'I', label: 'Info', hint: 'Hover anything in the world to see what it is' },
  { id: 'dig', key: '1', label: 'Dig', hint: 'Paint rock for the drones to mine, inside the dashed range ring. Amber hatching: drones can reach it. Red: no access yet' },
  { id: 'cancel', key: '2', label: 'Cancel', hint: 'Erase dig designations' },
  { id: 'scrap', key: 'X', label: 'Scrap', hint: 'Take down a strut for 1 scrap back. Whatever it was holding up may come down' },
];
const BUILDINGS: ToolDef[] = [
  { id: 'strut', key: '3', label: 'Strut', hint: 'Floor-to-ceiling steel support up to 4m; stretches when its ends are dug out; braces cracking rock (2 scrap)' },
  { id: 'smelter', key: '4', label: 'Smelter', hint: 'Turns ore into plates (8 scrap). Shows a hologram where it would go' },
];
const TOOLS = [...ORDERS, ...BUILDINGS];
const LAYERS = [
  { label: 'Normal', icon: 'normal', hint: 'Plain view' },
  { label: 'Heat', icon: 'heat', hint: 'Temperature: blue freezing, green comfortable, red hot' },
  { label: 'Oxygen', icon: 'oxygen', hint: 'Breathable air in blue, none in red, toxic gas in green' },
  { label: 'Integrity', icon: 'integrity', hint: 'Structural stress: green sound, yellow to red near its limit, flashing when cracking' },
  { label: 'Material', icon: 'material', hint: 'What the ground is made of, in high-contrast colours. Click the key to show or hide each material' },
];

/** DOM overlay: resources, tools, critter status, the status log, and emote speech bubbles. */
export function Hud({ game }: { game: Game }) {
  const [, force] = useState(0);
  // Main menu / settings dialog. The game is paused while either is open.
  const [menuState, setMenuState] = useState<null | 'main' | 'settings'>(null);
  const menu = useRef(menuState);
  const setMenu = (m: null | 'main' | 'settings') => { menu.current = m; game.paused = m !== null; setMenuState(m); };
  useEffect(() => { applySettings(game, loadSettings()); }, [game]);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 200);
    const key = (e: KeyboardEvent) => {
      unlockAudio();
      // Esc: close a dialog, else drop back to the plain cursor, else open the menu.
      if (e.key === 'Escape') {
        if (menu.current) setMenu(menu.current === 'settings' ? 'main' : null);
        else if (game.tool !== 'select' && game.intro.phase === 'done') game.tool = 'select';
        else setMenu('main');
        force((n) => n + 1);
        return;
      }
      if (menu.current) return;
      if (game.intro.phase !== 'done') {
        if (e.key === ' ') game.skipIntro();
        return;
      }
      const tool = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (tool) game.tool = tool.id;
      if (e.key === 'b') game.buildBot();
      if (e.key === 'q') game.brushSquare = !game.brushSquare;
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
      <header className="topbar" onMouseEnter={() => game.tutorialNote('hover:topbar')}>
        <div className="title">CLANKWORKS <span>Rustbucket Logistics</span></div>
        <Res icon="ore" label="Ore" value={fmt(r.ore)} />
        <Res icon="nut" label="Scrap" value={fmt(r.scrap)} />
        <Res icon="plates" label="Plates" value={fmt(r.plates)} />
        <Res icon="drone" label="Drones" value={`${alive.length}`} />
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
          {(game.tool === 'dig' || game.tool === 'cancel') && (
            <div className="brush">
              <span>Brush</span>
              {[false, true].map((sq) => (
                <button key={String(sq)} className={game.brushSquare === sq ? 'active' : ''} data-tip={sq ? 'Square brush: paint neat rooms and straight tunnels' : 'Round brush'}
                  onClick={() => { game.brushSquare = sq; force((n) => n + 1); }}>
                  <Icon name={sq ? 'square' : 'circle'} size={14} />{sq ? 'Square' : 'Round'}
                </button>
              ))}
              <kbd>Q</kbd>
            </div>
          )}
          <ToolGroup title="Orders">
            {ORDERS.map((t) => <ToolButton key={t.id} t={t} game={game} onPick={() => force((n) => n + 1)} />)}
          </ToolGroup>
          <ToolGroup title="Buildings">
            {BUILDINGS.map((t) => <ToolButton key={t.id} t={t} game={game} onPick={() => force((n) => n + 1)} />)}
            <button className="build" onClick={() => { unlockAudio(); game.buildBot(); force((n) => n + 1); }}
              onMouseEnter={(e) => costCard.show(e.currentTarget, 'drone', 'Drone', 'A mining drone. It takes the next free landing pad on the base; there are four.')} onMouseLeave={() => costCard.hide()}>
              <Icon name="drone" /><span>Drone</span><kbd>B</kbd>
            </button>
          </ToolGroup>
        </nav>
      )}

      {game.intro.phase === 'done' && (
        <aside className="panel layers">
          <h3>Layers <span>T cycles</span></h3>
          {LAYERS.map((l, n) => (
            <button key={l.label} data-tip={l.hint} className={game.overlay === n ? 'active' : ''} onClick={() => { game.overlay = n as Overlay; force((k) => k + 1); }}>
              <Icon name={l.icon} />{l.label}
            </button>
          ))}
          {game.overlay === 4 && (
            <div className="legend">
              {MATERIAL_KEY.map((m) => {
                const on = (game.materialMask >> m.id) & 1;
                return (
                  <button key={m.id} className={on ? 'on' : 'off'} data-tip={`${on ? 'Hide' : 'Show'} ${m.name.toLowerCase()}`}
                    onClick={() => { game.materialMask ^= 1 << m.id; force((k) => k + 1); }}>
                    <i style={{ background: m.color }} />{m.name}
                  </button>
                );
              })}
            </div>
          )}
          <p className="help">Left-click: use tool · Right-drag / WASD: pan · Wheel: zoom</p>
        </aside>
      )}

      {game.pendingCollapses.length > 0 && game.alerts.caveIn && (
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
      {game.strutConfirm && <StrutConfirm game={game} onDone={() => force((n) => n + 1)} />}
      {menuState === 'main' && <MainMenu onResume={() => setMenu(null)} onSettings={() => setMenu('settings')} />}
      {menuState === 'settings' && <Settings game={game} onBack={() => setMenu('main')} />}

      {game.intro.phase === 'done' && <Tutorial game={game} onChange={() => force((n) => n + 1)} />}

      <Bubbles game={game} />
      <Inspector game={game} />
      <CostCard game={game} />
    </div>
  );
}

/**
 * Tutorial: a short tour that highlights each part of the HUD, then objectives (mine ore, smelt
 * plates, build a drone) that tick over by themselves as you play.
 */
function Tutorial({ game, onChange }: { game: Game; onChange: () => void }) {
  const step = TUTORIAL[game.tutorial.step];
  const focus = step?.focus;
  const panel = useRef<HTMLElement>(null);
  const lines = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!focus) return;
    const els = [...document.querySelectorAll(focus)];
    els.forEach((e) => e.classList.add('tut-focus'));
    // An indicator line from the panel to each highlighted area, kept up to date every frame.
    let raf = 0;
    const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const svg = lines.current, p = panel.current?.getBoundingClientRect();
      if (!svg || !p) return;
      const pc = { x: p.left + p.width / 2, y: p.top + p.height / 2 };
      svg.innerHTML = els.map((e) => {
        const r = e.getBoundingClientRect();
        const tc = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        // From the panel's edge nearest the target to the target's edge nearest the panel.
        const a = { x: clamp(tc.x, p.left, p.right), y: clamp(tc.y, p.top, p.bottom) };
        const b = { x: clamp(pc.x, r.left - 6, r.right + 6), y: clamp(pc.y, r.top - 6, r.bottom + 6) };
        return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" marker-end="url(#tut-arrow)" /><circle cx="${a.x}" cy="${a.y}" r="3.5" />`;
      }).join('') + '<defs><marker id="tut-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" /></marker></defs>';
    };
    draw();
    return () => { cancelAnimationFrame(raf); els.forEach((e) => e.classList.remove('tut-focus')); if (lines.current) lines.current.innerHTML = ''; };
  }, [focus]);
  if (!step) return null;
  const tour = !step.objective;
  const objectives = TUTORIAL.filter((t) => t.objective);
  const n = objectives.indexOf(step);
  const t = game.tutorial;
  const complete = t.doneAt !== null;
  return (
    <>
    <svg ref={lines} className="tut-lines" />
    <aside ref={panel} className={`panel tutorial ${tour ? 'tour' : 'quest'}${complete ? ' complete' : ''}`}>
      <h3>{tour ? `Tutorial ${t.step + 1} / ${TUTORIAL.length - objectives.length}` : `Objective ${n + 1} / ${objectives.length}`}</h3>
      <h4>{step.title}</h4>
      <p>{step.text}</p>
      {/* Items tick themselves as you do them; the step moves on once they're all ticked. */}
      <ul className="checklist">
        {step.items.map((item, k) => (
          <li key={k} className={t.checked[k] ? 'done' : ''}>
            <i aria-hidden="true" />
            <span>{item.label}</span>
            {item.progress && !t.checked[k] && <em>{item.progress(game)}</em>}
          </li>
        ))}
      </ul>
      <div className="buttons">
        <span className="status">{complete ? '✓ Done!' : ''}</span>
        {tour && <button className="quiet" onClick={() => { game.tutorialNext(); onChange(); }}>Skip step</button>}
        {tour && <button className="quiet" onClick={() => { game.skipTutorial(); onChange(); }}>Skip tutorial</button>}
      </div>
    </aside>
    </>
  );
}

/**
 * The "this dig would undermine a strut" question, pinned to the held dig orders in the world
 * (it follows them as the camera moves, and points at them).
 */
function StrutConfirm({ game, onDone }: { game: Game; onDone: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const v = new THREE.Vector3();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const c = game.strutConfirm, cam = view.camera, box = el.current;
      if (!c || !cam || !box) return;
      v.set(c.x, c.y, 0).project(cam);
      const W = innerWidth, H = innerHeight, w = box.offsetWidth, h = box.offsetHeight;
      const px = (v.x * 0.5 + 0.5) * W, py = (-v.y * 0.5 + 0.5) * H;
      // Sit above the orders (below them if there's no room), kept on screen.
      const above = py - h - 24 > 50;
      const x = Math.min(W - w - 8, Math.max(8, px - w / 2));
      const y = above ? py - h - 24 : Math.min(H - h - 8, py + 24);
      box.style.transform = `translate(${x}px, ${y}px)`;
      box.style.setProperty('--tip-x', `${Math.min(w - 16, Math.max(16, px - x))}px`);
      box.classList.toggle('below', !above);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [game]);
  return (
    <div ref={el} className="confirm panel">
      <h3>⚠ This dig would undermine a strut</h3>
      <p>A strut can only stretch to 4m. Dig here and it stops holding up the ceiling. The drones are holding off on these orders until you decide.</p>
      <div>
        <button className="danger" onClick={() => { game.resolveStrutConfirm(true); onDone(); }}>Dig anyway</button>
        <button onClick={() => { game.resolveStrutConfirm(false); onDone(); }}>Cancel these digs</button>
      </div>
    </div>
  );
}

/** Settings kept in the browser between sessions. */
interface SettingsData { volume: number; alerts: Record<AlertKind, boolean> }
const SETTINGS_KEY = 'clankworks-settings';
function loadSettings(): SettingsData {
  const defaults: SettingsData = { volume: 0.8, alerts: Object.fromEntries(Object.keys(ALERTS).map((k) => [k, true])) as Record<AlertKind, boolean> };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<SettingsData> | null;
    return { volume: saved?.volume ?? defaults.volume, alerts: { ...defaults.alerts, ...saved?.alerts } };
  } catch {
    return defaults;
  }
}
function applySettings(game: Game, s: SettingsData) {
  setVolume(s.volume);
  game.alerts = { ...s.alerts };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage unavailable: settings last this session */ }
}

/** Main menu: opened with Esc from the plain cursor. The game is paused behind it. */
function MainMenu({ onResume, onSettings }: { onResume: () => void; onSettings: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal panel menu">
        <h2>Clankworks</h2>
        <p className="sub">Paused</p>
        <button autoFocus onClick={onResume}>Resume</button>
        <button onClick={onSettings}>Settings</button>
        <button className="quiet" onClick={() => location.reload()}>Restart shift</button>
      </div>
    </div>
  );
}

/** Settings: master volume, and which kinds of alert to show. */
function Settings({ game, onBack }: { game: Game; onBack: () => void }) {
  const [s, setS] = useState(loadSettings);
  const update = (next: SettingsData) => { setS(next); applySettings(game, next); };
  return (
    <div className="modal-backdrop">
      <div className="modal panel settings">
        <h2>Settings</h2>
        <label className="row">
          <span>Volume</span>
          <input type="range" min={0} max={100} value={Math.round(s.volume * 100)} onChange={(e) => update({ ...s, volume: Number(e.target.value) / 100 })} />
          <b>{Math.round(s.volume * 100)}%</b>
        </label>
        <h3>Alerts</h3>
        {(Object.keys(ALERTS) as AlertKind[]).map((k) => (
          <label key={k} className="row check">
            <input type="checkbox" checked={s.alerts[k]} onChange={(e) => update({ ...s, alerts: { ...s.alerts, [k]: e.target.checked } })} />
            <span>{ALERTS[k]}</span>
          </label>
        ))}
        <div className="buttons"><button onClick={onBack}>Back</button></div>
      </div>
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

/** What each priced tool costs (or refunds, for Scrap). */
const PRICES: Partial<Record<Tool | 'drone', { cost: Record<string, number>; refund?: boolean }>> = {
  strut: { cost: COST.strut },
  smelter: { cost: COST.smelter },
  drone: { cost: COST.bot },
  scrap: { cost: { scrap: 1 }, refund: true },
};

/**
 * Hover card for priced tools and buildings: a bar of resource chips across the top shows the
 * cost at a glance (red when you can't afford it, green for a refund), then the description.
 */
const costCard = { show: (_el: HTMLElement, _id: string, _title: string, _hint: string) => {}, hide: () => {} };
function CostCard({ game }: { game: Game }) {
  const [card, setCard] = useState<{ rect: DOMRect; id: string; title: string; hint: string } | null>(null);
  costCard.show = (el, id, title, hint) => setCard({ rect: el.getBoundingClientRect(), id, title, hint });
  costCard.hide = () => setCard(null);
  if (!card) return null;
  const price = PRICES[card.id as Tool | 'drone'];
  if (!price) return null;
  const r = game.resources as Record<string, number>;
  return (
    <div className="cost-card" style={{ left: card.rect.left, top: card.rect.top - 8 }}>
      <div className="cost-bar">
        <span>{price.refund ? 'Refund' : 'Cost'}</span>
        {Object.entries(price.cost).map(([res, n]) => {
          const short = !price.refund && (r[res] ?? 0) < n;
          return (
            <b key={res} className={price.refund ? 'refund' : short ? 'short' : ''} style={{ color: price.refund || short ? undefined : RESOURCE_COLOR[res] }}>
              <Icon name={RESOURCE_ICON[res] ?? res} size={15} />{price.refund ? '+' : ''}{n}
            </b>
          );
        })}
      </div>
      <h4>{card.title}</h4>
      <p>{card.hint}</p>
    </div>
  );
}

function ToolButton({ t, game, onPick }: { t: ToolDef; game: Game; onPick: () => void }) {
  const priced = !!PRICES[t.id];
  return (
    <button className={game.tool === t.id ? 'active' : ''} data-tip={priced ? undefined : t.hint} onClick={() => { game.tool = t.id; onPick(); }}
      onMouseEnter={priced ? (e) => costCard.show(e.currentTarget, t.id, t.label, t.hint) : undefined} onMouseLeave={priced ? () => costCard.hide() : undefined}>
      <Icon name={t.id} /><span>{t.label}</span><kbd>{t.key}</kbd>
    </button>
  );
}

/**
 * Hover card for the plain cursor: what's under the pointer (a drone, a strut, the base, a
 * critter, or the rock itself) with a few facts about it. Also keeps the canvas cursor matched
 * to the active tool.
 */
function Inspector({ game }: { game: Game }) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0, next = 0, tool = '';
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const canvas = document.querySelector('canvas');
      if (canvas && tool !== game.tool) {
        tool = game.tool;
        // Strut and Smelter show holograms; the rest get an icon cursor.
        canvas.style.cursor = tool === 'strut' || tool === 'smelter' ? 'crosshair' : cursorFor(tool, tool === 'cancel' ? '#ff9a85' : tool === 'scrap' ? '#ffb38a' : '#ffe2a8');
      }
      const el = card.current, ray = view.ray;
      if (!el) return;
      if (game.tool !== 'info' || game.paused || !ray || !view.cursor) { el.style.display = 'none'; return; }
      el.style.transform = `translate(${view.mouse.x + 18}px, ${view.mouse.y + 14}px)`;
      if (now < next) return;
      next = now + 100;
      const info = inspect(game, (z) => {
        const t = (z - ray.origin.z) / ray.direction.z;
        return { x: ray.origin.x + ray.direction.x * t, y: ray.origin.y + ray.direction.y * t };
      });
      if (!info) { el.style.display = 'none'; return; }
      game.tutorialNote(`saw:${info.kind}`);
      el.style.display = 'block';
      el.replaceChildren(Object.assign(document.createElement('h4'), { textContent: info.title }),
        ...info.lines.map((l) => Object.assign(document.createElement('div'), { textContent: l })));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [game]);
  return <div ref={card} className="inspector" />;
}

/** Colour for each resource's icon, wherever it appears. */
export const RESOURCE_COLOR: Record<string, string> = { ore: '#e08a4f', nut: '#a9b2bc', scrap: '#a9b2bc', plates: '#f0b84a', drone: '#7fd8ff' };
/** Icon for each resource key. */
const RESOURCE_ICON: Record<string, string> = { ore: 'ore', scrap: 'nut', plates: 'plates' };

function Res({ icon, label, value }: { icon: string; label: string; value: string }) {
  return <div className="res" style={{ color: RESOURCE_COLOR[icon] }}><Icon name={icon} size={15} /><span>{label}</span><b>{value}</b></div>;
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
        if ((!s.broken && !s.atRisk) || !game.alerts.strut) continue;
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
      for (const u of game.alerts.structural ? game.unstable : []) {
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

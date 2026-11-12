# Clankworks: Rustbucket Logistics

A vertical-slice prototype of the colony sim described in [`design.md`](design.md), built with
React Three Fiber, three.js `WebGPURenderer`, and Rapier 2D. Every parallel per-cell workload
runs as a WGSL compute kernel, written with three.js `wgslFn()`.

```sh
npm install
npm run dev        # http://localhost:5287 — needs a WebGPU browser (recent Chrome / Edge)
npm run smoke      # end-to-end test in Chromium (see Testing)
npm run smoke:win  # same test from WSL, in Windows Chrome on the real GPU
npm run build
```

## Playing

The world is 128m wide and 192m deep. A shift opens with your steam-age base drilling its own
shaft from the surface down to a flat-floored cavern 30m underground, then deploying: brackets
clamp it to the back wall, and the conveyor, shelf, lamps and bulbs unfold (`Space` skips). Everything you haven't explored is hidden under fog of war; the drones' lamps and
the base push it back as they go. Underground there is very little ambient light, so the base's
gas lamps, the drones' headlamps, glowing machinery and magma provide most of it.

A short tutorial follows: a tour of the HUD (each area is highlighted as it is described), then
three objectives that tick over as you play: deliver 5 ore, smelt 3 plates, and build a second
drone. You start with one drone and no plates. Skip it any time.

Mining drones wait on the four brass landing pads on top of the base's boiler, so the fleet tops
out at four. Each drone has a battery gauge on its flanks: green, then yellow, then blinking
red. Flying drains it, and the mining laser drains it faster. Below 25% a drone drops its job
and flies home to recharge on its pad, and it won't launch again until it's back above 70%. A
drone that runs flat limps home slowly. When you designate rock, they launch, cut it with their lasers, and fly home to
unload and dock. Dig orders only work inside the dashed ring 11m around the base. Orders show
as fine hatching. Amber means the drones can reach it: it borders space they can fly to from
the base, or it joins such rock through other orders, so they will tunnel in. Red means nothing
can get at it yet, such as a pocket sealed in solid rock. Dirt digs quickly; granite and copper ore take about twice as long as they used to. A smelter
turns ore into plates. New drones cost plates plus goo from the terrarium critters. The
quarterly quota is 30 plates.

Structural warnings come in two stages:
- **Near collapse:** a ceiling in the drones' working area that reaches 80% of its safe span
  gets a log warning and an "⚠ Unstable" tag, while there is still time to add a strut.
- **Collapsing:** rock that loses support pales with dust, cracks along glowing fractures,
  trembles and creaks, an alarm sounds, and a countdown tag appears over it (pinned to the screen
  edge with an arrow if it is off-screen) along with an alert under the top bar. Click either to
  jump there. You get 15 seconds to brace it with a strut. If the rock is still unsupported when
  the countdown ends, it collapses.

Struts stand on poured grout bases, like steel columns: a tapered concrete plinth fills any gap
between each plate and the floor or ceiling, so plates never hang in the air over uneven or
partly dug rock. Struts
follow the rock. Dig out the floor under a strut's bottom plate (or the rock above its
top plate) and it stretches to the new floor or ceiling, up to its 4m limit. Ordering a dig
that would take it past that warns you first, and the strut gets an "⚠ Dig will undermine
strut" tag. The drones hold off on the orders around that strut, and a panel asks whether to dig
anyway or cancel the dig orders near the strut. If the dig goes ahead anyway, the strut stops supporting the ceiling, goes dark
and rusty, and shows "⚠ Strut not supporting" until the gap is short enough to brace again.

The integrity layer shows the stress map: green rock is sound, and ceilings turn yellow,
then red, as they approach their limit. Cracking rock flashes.

Every tool and layer has an icon, and the canvas cursor changes to match the active tool.
The toolbar has three sections:

| Section | Input | Action |
| --- | --- | --- |
| Orders | `Esc` Select | The default plain cursor: hover anything (a drone, strut, the base, a critter, rock or open cave) for a card of basic facts about it |
| Orders | `1` Dig / `2` Cancel | Paint or erase dig designations (left-drag). The brush shows as a hatched disc: amber to dig, red to erase or when out of range, with a pickaxe or eraser cursor |
| Orders | `3` Blast | Demolition charge with a 2.5 s fuse (1 scrap) |
| Orders | `X` Scrap | Take down the strut under the cursor (highlighted red) for 1 scrap back. Whatever it held up is re-checked |
| Buildings | `4` Strut | Floor-to-ceiling steel support, up to 4m, hung with small lamps (2 scrap). A hologram previews the span. Wide ceilings collapse without them; one placed under cracking rock saves it |
| Buildings | `5` Smelter | Ore → plates (8 scrap). A hologram previews where it will stand: cyan if it fits, red if not |
| Buildings | `B` Drone | Build a drone (3 plates + 2 goo), one per landing pad |
| Layers (top right) | `T` cycles, or click | Normal, heat, oxygen, structural integrity and material views. The material view shows each material in a high-contrast pastel, with a key you can click to hide or show each one |
| | Right-drag / WASD, wheel | Pan, zoom |

The critters need 6–38 °C, oxygen, no toxic gas and dry feet (their alerts are switched off for
now; the terrarium panel shows how they're doing). Breaching the toxic pocket under
the terrarium or flooding it from the aquifer will cost you critters. Drones shout the emotes from the design doc when their triggers fire (cave-in
survivors, Carl's alcove, stuck drones, losses that still increased ore output, and so on).

## Architecture

The simulation is split between a CPU-authoritative 2D voxel grid and GPU-resident fields.

**Chunks (`src/game/chunks.ts`, `src/sim/worldgen.ts`).** The 512×768-cell world is split into
32×32-cell chunks (8m square). `WorldGen` plans every cave, vein, aquifer, gas pocket and magma
chamber from the seed up front, then generates any chunk on demand by applying the features that
overlap it, so chunks come out identical whatever order they are built in. `ChunkStreamer` keeps
resident the chunks the game needs: everything within dig range of the base, around each drone
and its target, falling debris, cracking rock, and what the camera sees plus a margin, up to 128.
Chunks that haven't been needed for 3 seconds are saved and unloaded. The save holds density,
material, struts, flags, and the fluid and temperature read back from the GPU. Saves go to an
in-memory cache backed by IndexedDB. An unloaded chunk's cells become inert bedrock, so physics,
pathfinding and the GPU treat it as solid. Revisiting the chunk restores it from the save. Each
page load starts a new world and clears the old saves; entities and resources are not saved.

**CPU (`src/sim`, `src/game`).** These parts need synchronous answers for physics and AI:
- `terrain.ts`: world-sized arrays of density, material, struts and per-cell flags (dig orders,
  reachability, fog of war, stress, cracking). Changes are queued as rectangles, so only the
  rows that changed are uploaded to the GPU. Carving subtracts a smoothstep radial brush, so
  tunnels are organic rather than square.
- `contours.ts`: per-chunk marching squares, then Ramer-Douglas-Peucker simplification, then
  Rapier polyline colliders for resident chunks. Only dirty chunks are rebuilt.
- `integrity.ts`: a flood from bedrock and from rock at the edge of a window around the change
  finds islands that are no longer anchored. Keeping the window local keeps the check cheap in
  a big world. "Ceiling components" measure unsupported spans against each material's limit
  (dirt 9 cells, granite 26). The same ceilings feed the stress map behind the integrity
  overlay and the near-collapse warnings. `Game.queueCollapses` turns new failures into pending collapses. Their crack start time
  goes into spare bits of the per-cell `digMark` buffer, so the terrain shader animates the
  cracks and tremble from a game-time uniform with no per-frame uploads. A recheck every 0.4s
  drops cells that are supported again. At the deadline, whatever is still unsupported detaches
  into Rapier rigidbodies that tumble, crush things, shatter on impact, and then settle back into
  the grid as rubble. Settling can trigger further collapses (the domino effect).
- `pathfind.ts`: A* for the hovering drones. Nodes are 2×2-cell blocks on a 1-cell stride, so
  any tunnel two cells wide is navigable wherever it runs.
- `game/base.ts`: dig range and landing-pad layout, shared by the drone AI and the base model
  (`render/Base.tsx`).

**GPU (`src/gpu/kernels.ts`, all `wgslFn` compute kernels).**
- Every kernel is dispatched over lists of chunks: fluids and heat are only stepped in resident
  chunks, and unloaded neighbours read as solid rock.
- `fluidStep`: a cellular automaton for water, magma, oxygen and toxic gas. It is written as a
  *gather* (every cell recomputes its pairwise transfers from the source buffer), so mass is
  conserved with no atomics or races. It includes boiling, quenching and emitters.
- `thermalStep`: heat conduction with per-material conductivity, magma as a heat source, and a
  geothermal baseline.
- `meshCell`: the 2.5D terrain mesher. Each cell runs marching squares and emits a fan-triangulated
  front cutaway cap plus contour walls extruded along −Z in three noise-displaced bands. Each
  resident chunk owns a slot in the vertex buffer and its own indirect draw args, and only
  changed chunks are rebuilt. Cells reserve space in their slot with `atomicAdd` (stream
  compaction). That counter is also the slot's `drawIndirect` vertex count, so the CPU never
  touches the mesh. All slots draw from one geometry, one indirect draw each.
- `particleSpawn` / `particleStep`: ring-buffer debris, spark and steam particles that bounce
  off the density field.
- Fluids, temperature glow, dig marks, fog of war and the overlays are drawn by reading the
  same storage buffers in TSL fragment shaders. Fog edges blend the explored flags between cells
  and drift with noise, so they look like haze rather than squares. Gameplay reads a snapshot of
  the fluid and temperature fields asynchronously twice a second.

**Render (`src/render`).** Procedural rock evaluated in world-space 3D (`rock.ts`): gradient-noise
fBm plus Worley cells give each material its own grain (granite crystals, copper flecks and
malachite veins, soil pebbles, ice cracks, rubble chunks), with a matching height field for
derivative bump mapping. It needs no UVs and has no triplanar seams. Material boundaries are
looked up through a noise warp so they meander instead of following the cell grid. The low tier
swaps all this for two octaves of 2D noise. Also: layered fluid slices in the diorama cavity, parallax foreground silhouettes, GTAO ambient occlusion with bloom, and
a velocity-driven fake Z tilt on the 2D bodies.

`GpuSim.Buf` exists because TSL's `storage(...).toReadOnly()` mutates the node it is called on.
Each kernel gets its own storage node over the shared attribute.

## Testing

- `npm run smoke` boots the game in Chromium, watches the base drill down and deploy, checks the
  toolbar sections, and fast-forwards the simulation through drone
  mining, the dig range limit, a blast, a cave-in warning and collapse chain, a strut saving a
  cracking ceiling, a strut stretching, warning about and then losing its footing, a
  near-collapse warning, fog of war, streaming a far chunk out and back in
  with its changes intact, a magma chamber heating rock, and real toolbar, canvas and hotkey
  input. It checks that the GPU
  kernels changed the state (no NaNs, heat spreading into rock, compacted mesh size) and saves
  `smoke-*.png` screenshots.
- `tests/gpu.html` (served by `npm run dev`) builds the starting world and dispatches the
  kernels in stages. `?only=spawn` runs one stage; `?loop=readback` stress-tests the full update.
- Debug flags: `?no=post,mesh,fluid,particles,entities,sim,readback,meshfx,lamps,laser` disables
  subsystems.
  `?quality=low|high` overrides the automatic quality tier. Software adapters such as
  SwiftShader get the low tier: cheaper shading, one fluid slice, no post-processing.

**WSL:** Linux Chromium under WSL only gets the SwiftShader (CPU) WebGPU adapter, and headless
it cannot present WebGPU canvases at all. Run browser scripts through `scripts/win.mjs` instead:

```sh
npm run smoke:win
node scripts/win.mjs scripts/inspect.mjs "?quality=low" 10
node scripts/win.mjs scripts/run-page.mjs "tests/gpu.html?only=mesh"
```

`win.mjs` serves the app from WSL on `127.0.0.1:5288`, which Windows reaches through WSL
localhost forwarding. It then runs the script with Windows Node (`node.exe`), so Playwright
drives the Windows install of Chrome (`channel: 'chrome'`) on the real GPU, headless by default.
`HEADLESS`, `VIEWPORT` and `CHROME_ARGS` pass through. Run directly in WSL (`npm run smoke`),
the scripts launch a headed Chromium through WSLg instead.

## Not yet built (relative to the design doc)

- Only the world streams: drones, buildings, resources and the log are not saved, so reloading
  the page starts a new game.
- Logistics are global stockpiles: no pipes, pneumatic chutes, power routing or multi-stage
  chemistry yet.
- The terrain uses extruded marching squares with Z noise, not true 3D marching cubes or surface
  nets.
- Fluids render as translucent slices rather than surface meshes.
- Insulation, ice melting, and magma solidifying into rock are not simulated.
- Carving and structural checks run on the CPU because Rapier needs their results in the same
  frame.

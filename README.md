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

The world is 128m wide and 192m deep. Your steam-age base sits in a flat-floored cavern near
the surface. Everything you haven't explored is hidden under fog of war; the drones' lamps and
the base push it back as they go. Underground there is very little ambient light, so the base's
gas lamps, the drones' headlamps, glowing machinery and magma provide most of it.

Mining drones wait on brass landing pads on the base's boiler (four) and on the cradle tower
beside it (eight). When you designate rock, they launch, cut it with their lasers, and fly home to
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
  trembles and creaks, and a countdown tag appears over it. You get 15 seconds to brace it with
  a strut. If the rock is still unsupported when the countdown ends, it collapses.

The integrity overlay (`T`) shows the stress map: green rock is sound, and ceilings turn yellow,
then red, as they approach their limit. Cracking rock flashes.

| Input | Action |
| --- | --- |
| `1` Dig / `2` Cancel | Paint or erase dig designations (left-drag) |
| `3` Strut | Floor-to-ceiling steel support with a hanging lantern (2 scrap). Wide ceilings collapse without them; one placed under cracking rock saves it |
| `4` Smelter | Ore → plates (8 scrap). A hologram previews where it will stand: cyan if it fits, red if not |
| `5` Blast | Demolition charge with a 2.5 s fuse (1 scrap) |
| `B` | Build a drone (3 plates + 2 goo) |
| `T` | Cycle the heat, oxygen and structural integrity overlays |
| Right-drag / WASD, wheel | Pan, zoom |

The critters need 6–38 °C, oxygen, no toxic gas and dry feet. Breaching the toxic pocket under
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

- `npm run smoke` boots the game in Chromium and fast-forwards the simulation through drone
  mining, the dig range limit, a blast, a cave-in warning and collapse chain, a strut saving a
  cracking ceiling, a near-collapse warning, fog of war, streaming a far chunk out and back in
  with its changes intact, a magma chamber heating rock, and real toolbar, canvas and hotkey
  input. It checks that the GPU
  kernels changed the state (no NaNs, heat spreading into rock, compacted mesh size) and saves
  `smoke-*.png` screenshots.
- `tests/gpu.html` (served by `npm run dev`) builds the starting world and dispatches the
  kernels in stages. `?only=spawn` runs one stage; `?loop=readback` stress-tests the full update.
- Debug flags: `?no=post,mesh,fluid,particles,entities,sim,readback,meshfx` disables subsystems.
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

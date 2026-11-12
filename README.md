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

Scrapbots dig wherever you designate rock and haul ore back to the depot. A smelter turns ore
into plates, and new bots cost plates plus goo from the terrarium critters. The quarterly quota
is 30 plates.

| Input | Action |
| --- | --- |
| `1` Dig / `2` Cancel | Paint or erase dig designations (left-drag) |
| `3` Strut | Floor-to-ceiling steel support (2 scrap). Wide ceilings collapse without them |
| `4` Smelter | Ore → plates. It runs hot, so keep it away from the critters (8 scrap) |
| `5` Blast | Demolition charge with a 2.5 s fuse (1 scrap) |
| `B` | Build a scrapbot (3 plates + 2 goo) |
| `T` | Cycle the heat and oxygen overlays |
| Right-drag / WASD, wheel | Pan, zoom |

The critters need 6–38 °C, oxygen, no toxic gas and dry feet. Breaching the toxic pocket under
the terrarium, flooding it from the aquifer, or parking a smelter next to it will cost you
critters. Bots shout the emotes from the design doc when their triggers fire (cave-in
survivors, Carl's alcove, stuck bots, losses that still increased ore output, and so on).

## Architecture

The simulation is split between a CPU-authoritative 2D voxel grid and GPU-resident fields.

**CPU (`src/sim`, `src/game`).** These parts need synchronous answers for physics and AI:
- `terrain.ts`: a 128×192 grid of density, material, struts and dig marks. Carving subtracts a
  smoothstep radial brush, so tunnels are organic rather than square.
- `contours.ts`: per-chunk (32×32) marching squares, then Ramer-Douglas-Peucker simplification,
  then Rapier polyline colliders. Only dirty chunks are rebuilt.
- `integrity.ts`: a BFS from bedrock finds islands that are no longer anchored. "Ceiling
  components" measure unsupported spans against each material's limit (dirt 9 cells, granite
  26). Both kinds of failure detach into Rapier rigidbodies that tumble, crush things, shatter
  on impact, and then settle back into the grid as rubble. Settling can trigger further
  collapses (the domino effect).
- `pathfind.ts`: A* on 2×2-cell nodes for the thruster-hovering scrapbots.

**GPU (`src/gpu/kernels.ts`, all `wgslFn` compute kernels).**
- `fluidStep`: a cellular automaton for water, magma, oxygen and toxic gas. It is written as a
  *gather* (every cell recomputes its pairwise transfers from the source buffer), so mass is
  conserved with no atomics or races. It includes boiling, quenching and emitters.
- `thermalStep`: heat conduction with per-material conductivity, magma as a heat source, and a
  geothermal baseline.
- `meshCell`: the 2.5D terrain mesher. Each cell runs marching squares and emits a fan-triangulated
  front cutaway cap plus contour walls extruded along −Z in three noise-displaced bands. Cells
  reserve output space with `atomicAdd` (stream compaction). That counter is also the
  `drawIndirect` vertex count, so the CPU never touches the mesh.
- `particleSpawn` / `particleStep`: ring-buffer debris, spark and steam particles that bounce
  off the density field.
- Fluids, temperature glow, dig marks and the overlays are drawn by reading the same storage
  buffers in TSL fragment shaders. Gameplay reads a snapshot of the fluid and temperature
  fields asynchronously about three times a second.

**Render (`src/render`).** Triplanar procedural rock with cutaway strata, layered fluid slices
in the diorama cavity, parallax foreground silhouettes, GTAO ambient occlusion with bloom, and
a velocity-driven fake Z tilt on the 2D bodies.

`GpuSim.Buf` exists because TSL's `storage(...).toReadOnly()` mutates the node it is called on.
Each kernel gets its own storage node over the shared attribute.

## Testing

- `npm run smoke` boots the game in Chromium and fast-forwards the simulation through mining,
  a blast, a cave-in chain, and real toolbar, canvas and hotkey input. It checks that the GPU
  kernels changed the state (no NaNs, heat spreading into rock, compacted mesh size) and saves
  `smoke-*.png` screenshots.
- `tests/gpu.html` (served by `npm run dev`) dispatches each kernel in isolation.
  `?only=mesh` runs one kernel; `?loop=readback` stress-tests the full update.
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

- The world is a fixed 128×192 map, not streaming chunks.
- Logistics are global stockpiles: no pipes, pneumatic chutes, power routing or multi-stage
  chemistry yet.
- The terrain uses extruded marching squares with Z noise, not true 3D marching cubes or surface
  nets.
- Fluids render as translucent slices rather than surface meshes.
- Insulation, ice melting, and magma solidifying into rock are not simulated.
- Carving and structural checks run on the CPU because Rapier needs their results in the same
  frame.

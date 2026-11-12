# Game Design Document: Clankworks: Rustbucket Logistics

## 1. High-Level Concept
* **Title:** Clankworks: Rustbucket Logistics
* **Genre:** Vertical Underground Colony Sim & Process Automation
* **Visual Style:** 2.5D Cabinet-Style Diorama with a goofy, tactile, *Wall-E*-inspired scrapbot aesthetic
* **Core Inspirations:** *Hammerting* (vertical cross-section perspective), *Factorio* (complex process logistics), *Oxygen Not Included* (environmental hazards, fluids/gases, and life support), *Dwarf Fortress* (catastrophic chain reactions), and *Deep Rock Galactic* (subterranean workplace camaraderie).

### Steam Store Short Description
> Command a crew of clunky scrapbots in a vertical underground colony sim. Automate complex mining operations, stabilize fragile critter habitats, and survive catastrophic cave-ins. Nothing runs smoothly, everything is over-engineered, and oxygen is strictly optional.

---

## 2. Core Gameplay Pillars

### A. Scrapbot Process Management
* **Minimal Conveyor Belts:** Rather than relying solely on endless belt buses, players manage multi-step refining, piping, pneumatic chutes, and autonomous scrapbot haulers.
* **Escalating Complexity:** Simple ore extraction quickly branches into multi-stage chemical processing, thermal regulation, and power routing where single bottlenecks cascade across the facility.

### B. Environmental Chaos & Structural Integrity
* **Dynamic Hazards:** Pocketed magma, pressurized gas vents, flooding aquifers, and unstable rock strata constantly threaten carefully laid infrastructure.
* **Domino Mishaps:** Unchecked heat or poorly supported excavations trigger structural cave-ins that crush machinery and force frantic emergency rerouting.

### C. Biological Critter Caretaking
* **Delicate Subterranean Ecology:** Scrapbots do not need oxygen or comfortable temperatures, but the fragile biological critters housed in underground terrariums do.
* **Dual-Axis Difficulty:** Players must balance dirty, high-heat industrial extraction with clean, climate-controlled life-support chambers to keep critters thriving and productive.

---

## 3. Tone, Humor & In-Game Emotes
The world contrasts deadpan corporate logistics with expressive, clumsy scrapbots that celebrate small victories and panic comically during meltdowns. Emotes appear as floating speech bubbles, synthesized chirps, and status log entries.

| Emote / Cheer | Trigger Condition | Inspirational Nod |
| :--- | :--- | :--- |
| **"Cog and Stone!"** | Squad finishes mining a rich mineral vein or survives a cave-in together. | *Deep Rock Galactic* |
| **"Strike the Earth!"** | Deploying new scrapbots onto an unexcavated rock layer. | *Dwarf Fortress* |
| **"Losing Is Optimal!"** | A catastrophic chain reaction destroys half the base while somehow increasing ore output. | *Dwarf Fortress* + *Factorio* |
| **"The Quarry Must Grow!"** | Automating a new processing loop or expanding a vertical shaft. | *Factorio* |
| **"Oxygen Not Included!"** | A bot enters a vacuum or toxic gas pocket without caring, right before a critter panics. | *Oxygen Not Included* |
| **"For Carl!"** | A bot solemnly salutes an obsolete, broken-down Roomba-style predecessor. | *Deep Rock Galactic* |
| **"Tantrum Protocol Initiated!"** | Logic buffer overflows, causing a bot to aggressively kick a nearby boulder. | *Dwarf Fortress* |
| **"Stress Level: Nominal-ish!"** | Alarms blare and magma rises, yet a single biological critter is still happily eating snacks. | *Oxygen Not Included* |

---

## 4. Technical Architecture: Freeform Voxel World & 2.5D Rendering
To keep simulation math fast and deterministic while achieving rich, tactile depth, the game decouples a **2D freeform voxel simulation layer** from a **3D cabinet-style visual reconstruction layer**.

### 4.1 Core Simulation Layer (2D Freeform Voxel Data)
* **High-Resolution 2D Density Field:** The world is stored as streaming 2D chunks (e.g., `64x64` cells) where each cell holds a continuous density value (`0.0` for empty air to `1.0` for solid rock), a material ID (granite, soft dirt, copper ore, ice), and temperature data.
* **Sub-Grid Freeform Carving:** Drills and explosions subtract smooth radial falloff brushes from cell density values rather than deleting rigid square tiles, producing organic tunnels and craters.
* **Lightweight 2D Physics Colliders:** Dirty chunks run the **Marching Squares** algorithm to extract clean 2D contour edges, simplified via Ramer-Douglas-Peucker so the 2D physics engine calculates low-cost polygon/edge colliders.

### 4.2 Dynamic Structural Integrity & Cave-Ins
* **Connected-Component Flood Fill:** Whenever terrain is carved, a fast breadth-first search (BFS) or union-find check detects islands of high-density rock no longer anchored to bedrock or structural support beams.
* **Detaching Terrain into Rigidbodies:** Unsupported floating voxel islands convert into standalone **2D dynamic rigidbodies**—generating a matching 3D mesh for the falling chunk—so cave-ins physically tumble, crush machinery, and shatter into smaller debris on impact.
* **Material Hardness & Load Limits:** Soft dirt collapses easily when undercut, whereas reinforced steel struts constructed by bots allow wide, stable subterranean chambers.

### 4.3 Fluids, Gases & Thermal Bleed
* **Cellular Automata Overlay:** A lightweight 2D cellular simulation runs on the same chunk grid for water, magma, and breathable oxygen, using `0.0` density cells as open pathways and solid cells as containment walls.
* **Thermal Propagation:** Voxel cells conduct heat, allowing magma pockets to warm adjacent rock walls and threaten nearby temperature-sensitive critter habitats unless insulated or vented.

### 4.4 2.5D Cabinet-Style Visual Reconstruction
* **3D Marching Cubes Extrusion:** The 2D density grid feeds a **3D Marching Cubes** or **Surface Nets** mesher across a shallow Z-depth slice (3–5 voxels deep), perturbed with subtle 3D Perlin noise along the Z-axis so excavated walls look naturally craggy rather than flatly extruded.
* **Cutaway Cross-Section Cap:** The front Z-plane where the diorama meets the camera is clamped into a crisp, slightly beveled cutaway face that displays material strata (ore veins, fossilized junk, layered sediment) like an ant farm.
* **Triplanar Texture Mapping:** Rock, dirt, and ore textures project onto the 3D terrain mesh from X, Y, and Z axes simultaneously, preventing UV stretching on newly carved vertical surfaces.
* **Multi-Layer Parallax & Z-Depth Stacking:** Dark, slightly out-of-focus rock struts frame the foreground camera plane, while recessed 3D cavern walls, distant machinery, and atmospheric fog sit behind the playable Z-slice.
* **Selling 3D Volume on 2D Bodies:** Full 3D meshes attach to 2D rigidbodies (scrapbots, boulders, falling chunks) with subtle fake Z-axis tilt driven by 2D velocity, supported by real-time 3D directional lighting, screen-space ambient occlusion (SSAO), and 3D particle debris.
* **3D Fluid & Gas Presentation:** Cellular fluids and gases render via layered volumetric shaders or 3D surface meshes inside the recessed diorama cavity so water and gas visibly pool against the back wall.

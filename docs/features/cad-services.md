# CAD Services

Cascadia provides two complementary CAD processing pipelines: a **conversion service** that transforms existing STEP/IGES files into web-viewable formats (STL, GLB), and a **generation service** that creates new CAD geometry — AI-written FreeCAD scripts run headlessly, or parametric templates. Both pipelines integrate with the PLM vault for file storage and the background job system for asynchronous processing.

## CAD Conversion Service

The conversion service is a standalone Python microservice at `cascadia-workers-cad/`. It reads STEP and IGES files, tessellates the B-Rep geometry, and produces STL meshes and GLB files with per-face color preservation.

### Architecture

The converter runs as a separate process from the main Node.js application. It connects to the same PostgreSQL database and RabbitMQ broker, consuming job messages from the `jobs.conversion.cad.#` routing pattern.

```
Main App (Node.js)                     CAD Converter (Python)
+---------------------+               +---------------------+
| POST /api/v1/files/    |               |                     |
|   :fileId/convert   |               |  RabbitMQ Consumer  |
|         |           |               |         |           |
|   JobService.submit |   RabbitMQ    |  _process_message   |
|   'conversion.cad.  | ---------->   |         |           |
|    step-to-stl'     |  jobs.topic   |  _execute_conversion|
|                     |   exchange    |         |           |
+---------------------+               |  converter.py       |
                                       |  colors.py          |
                                       |  gltf_writer.py     |
                                       |  assembly.py        |
                                       |  thumbnail.py       |
                                       |         |           |
                                       |  Vault storage      |
                                       |  + DB records       |
                                       +---------------------+
```

Key design decisions:

- **Separate process**: pythonocc-core (the Python binding for OpenCASCADE) is a large native library that does not run in Node.js. Running it as a standalone service also isolates C++ crashes from the main application.
- **Subprocess isolation for XDE**: The color extraction code path uses OpenCASCADE's XDE (Extended Data Framework), which can crash with `Standard_NullObject` on certain STEP files. The converter runs XDE operations in a child process via `multiprocessing.Process` so that crashes do not kill the worker.
- **Direct database access**: The converter uses `psycopg` (not Drizzle) to read job records and write vault file entries directly. This avoids a dependency on the Node.js ORM while keeping the data in the same database.

### STEP File Reading

STEP files (`.step`, `.stp`) are the primary input format. The converter uses two different readers depending on the operation:

**Simple reader** (`STEPControl_Reader`): Used for basic STL conversion. Reads the STEP file and returns a single compound `TopoDS_Shape`. This path is reliable and handles all valid STEP files.

```python
reader = STEPControl_Reader()
status = reader.ReadFile(file_path)
reader.TransferRoots()
shape = reader.OneShape()
```

**XDE reader** (`STEPCAFControl_Reader`): Used for color extraction and assembly decomposition. Reads STEP files into an XDE document that preserves the assembly tree, part names, transformations, and color assignments.

```python
reader = STEPCAFControl_Reader()
reader.SetNameMode(True)
reader.SetColorMode(True)
status = reader.ReadFile(input_path)
reader.Transfer(doc)
```

### IGES File Reading

IGES files (`.iges`, `.igs`) are supported via `IGESControl_Reader`. The reading process is identical to the simple STEP reader: read file, transfer roots, extract compound shape. IGES files do not support color extraction or assembly decomposition through the converter.

### STL Output

The converter produces STL mesh files from tessellated B-Rep geometry. Tessellation is performed by `BRepMesh_IncrementalMesh` with configurable quality presets:

| Quality    | Linear Deflection | Angular Deflection | Use Case                      |
| ---------- | ----------------- | ------------------ | ----------------------------- |
| `preview`  | 0.5 mm            | 1.0 rad            | Quick previews, low detail    |
| `standard` | 0.1 mm            | 0.5 rad            | Default, good balance         |
| `high`     | 0.01 mm           | 0.1 rad            | Detailed inspection, printing |

Both binary and ASCII STL output are supported. Binary is the default (smaller file size, faster writes). The converter records polygon counts by reading the STL header (binary) or counting `facet normal` lines (ASCII).

After writing the STL, the converter computes the axis-aligned bounding box using `Bnd_Box` and stores both polygon count and bounding box dimensions in the vault file's `cad_metadata` JSONB column.

### GLB Output

For STEP files, the converter attempts to produce a GLB (binary glTF 2.0) file alongside the STL. GLB output preserves per-face colors from the original STEP file, making it suitable for 3D viewers that support PBR materials.

The GLB pipeline works in four stages:

1. **XDE document creation**: The STEP file is re-read using `STEPCAFControl_Reader` to access the assembly tree and color metadata.
2. **Color extraction**: `colors.py` walks the XDE label hierarchy using `XCAFDoc_ColorTool`, extracting surface colors (`XCAFDoc_ColorSurf`) with fallback to general colors (`XCAFDoc_ColorGen`). Colors are inherited from parent labels when not directly assigned. The result is a map from `shape.HashCode()` to RGB color.
3. **Face grouping**: `gltf_writer.py` iterates over all faces in the tessellated shape, looks up each face's color from the hash map, and groups triangles by color. Face orientation (winding order) is corrected for reversed faces.
4. **GLB binary writing**: The grouped triangles are packed into a glTF 2.0 binary file with separate materials for each color group. Each material uses PBR metallic-roughness with `metallicFactor: 0.3` and `roughnessFactor: 0.5`. Vertices, normals, and indices are packed into a single binary buffer with 4-byte alignment.

#### Flat and structured GLB

The four stages above describe a **flat** GLB: one mesh, its triangles grouped by colour. That is what a single part gets, and it means an assembly written this way has no internal structure at all — an eighty-part assembly arrives as about six primitives, and two identically-anodized brackets at opposite ends of an arm are literally the same one. Nothing in the file can be selected, because there is nothing in the file to select.

When the XDE document turns out to describe more than one leaf part, `write_structured_glb` is used instead. It emits **one glTF node per leaf part** under the same Z-up to Y-up root node, each carrying:

- `name` — the node key: the part's instance path from the assembly root (`TDJ-25/ARM-ASSY/BRACKET`), with `#2`, `#3` … disambiguating repeats. Unique within the file and stable across re-conversions while the CAD structure is, which is what lets a saved node → part-item link outlive the file it was made against.
- `extras.cascadiaNodeKey`, `extras.cascadiaPartName`, `extras.cascadiaPath` — the same identity, where `GLTFLoader` will hand it to the viewer as `object.userData`.
- `matrix` — the part's placement, composed down the assembly tree by `collect_placed_parts` in `assembly.py`.

Two details are load-bearing and both fail quietly if got wrong:

- **Placement is composed, not read off the leaf.** `_collect_parts` (used by decomposition) resolves each component to its prototype label and discards the instance location on the way, which is harmless when writing one file per part and fatal when writing one file for the whole assembly: every occurrence of a repeated part would render at the prototype's origin, piled on top of the others. `collect_placed_parts` carries an accumulated `TopLoc_Location` down instead, the way OCCT's own presentation traversal does.
- **Geometry stays in part-local coordinates, with the transform on the node.** Not just an optimisation: face colours are looked up from a document-wide map keyed by face hash, and an OCCT 7.8+ hash folds in the shape's location — so a _moved_ face misses every entry in that map and the assembly comes out in the default steel blue. glTF node matrices are also column-major while `gp_Trsf.Value(row, col)` is row-major, so `_location_to_gltf_matrix` is a transpose; getting that wrong reads as the inverse rotation, which looks almost plausible.

The node manifest is stored on the GLB's `vault_files.cad_metadata.nodes`, and its presence is what tells the viewer a model can be taken apart. See [visualization.md](./visualization.md#assembly-part-selection) for what the viewer then does with it.

An assembly converted before this existed keeps its flat GLB; re-running the conversion is what gives it structure.

The entire XDE/GLB pipeline runs in a subprocess with a 3-minute timeout. If it crashes or times out, the STL output is still available. This makes the GLB path strictly additive and non-blocking.

The default color for faces without color data is steel-blue `(0.45, 0.50, 0.56)`.

### Color Extraction from STEP Files

Color data in STEP files is stored as XDE metadata associated with assembly labels. The extraction process in `colors.py`:

1. Obtains `XCAFDoc_ColorTool` from the document root.
2. For each free shape label, walks the assembly tree recursively.
3. For each shape, tries `XCAFDoc_ColorSurf` (surface color, most common in STEP) first, then `XCAFDoc_ColorGen` (general color) as fallback.
4. If no color is found on a label, walks up the hierarchy to inherit from parent assembly labels.
5. Assigns the resolved color to the shape hash code and to all child face hash codes.
6. Computes a "dominant color" by counting rounded RGB values across all shapes. This dominant color is stored in the job result for use as a part preview color.

### Assembly Decomposition

For multi-part STEP assemblies, the converter can decompose the file into individual part STL/GLB files. This is triggered by setting `decompose: true` in the job payload.

The decomposition uses XDE to:

- Walk the assembly tree and collect all leaf parts (simple shapes, not sub-assemblies).
- Extract part names from `TDataStd_Name` attributes.
- Capture 4x4 transformation matrices from `TopLoc_Location` for each part's position.
- Extract per-label colors for individual part rendering.

Each part is tessellated and written as a separate STL file (and GLB if colors are available). The results include a manifest with part names, polygon counts, bounding boxes, transforms, and color data.

Duplicate part names are automatically deduplicated with numeric suffixes (`part_1`, `part_2`).

### Thumbnail Generation

The converter generates PNG thumbnail images from B-Rep geometry before tessellation (for smooth, high-quality output). Thumbnails are rendered using pythonocc's offscreen `Viewer3d`:

- Resolution: 512x512 pixels
- Background: light gray gradient
- Rendering: solid shaded with 4x MSAA anti-aliasing
- Camera: isometric view, auto-fit to shape bounds
- Requires Xvfb virtual framebuffer (started by `entrypoint.sh`)

Thumbnails are stored in the vault with `file_category: 'thumbnail'` and linked to the source CAD file and all output files via `thumbnail_file_id`.

### RabbitMQ Integration

The worker connects to RabbitMQ and declares the following topology:

| Component    | Name                                | Type    | Purpose              |
| ------------ | ----------------------------------- | ------- | -------------------- |
| Exchange     | `jobs.topic`                        | topic   | Main job routing     |
| Exchange     | `jobs.dlx`                          | fanout  | Dead letter exchange |
| Queue        | `jobs.dead-letter`                  | durable | Failed job storage   |
| Worker Queue | `cad-worker-{hostname}-{timestamp}` | durable | Per-instance queue   |

The worker queue binds to `jobs.conversion.cad.#` on the topic exchange. Messages are priority-enabled (max priority 10) and include dead letter routing.

Worker behavior:

- **Prefetch**: Configurable via `WORKER_CONCURRENCY` (default 2).
- **ACK policy**: Always ACK after processing (retries are handled via database status, not requeue).
- **Graceful shutdown**: On SIGTERM/SIGINT, stops consuming, waits up to 30 seconds for active jobs, then closes connections.
- **Reconnection**: On connection failure, retries every 5 seconds.
- **Health check**: HTTP endpoint on port 3003 (configurable via `HEALTH_PORT`) returning worker status as JSON.

### Docker Deployment

The converter Dockerfile uses a two-stage build:

**Stage 1 (build)**: Uses `condaforge/miniforge3` to create a conda environment with `pythonocc-core >= 7.7` and Python dependencies (`pika`, `psycopg`, `pydantic`, `pydantic-settings`). The environment is packed into a portable tarball using `conda-pack`.

**Stage 2 (runtime)**: Uses `debian:bookworm-slim` with only the runtime libraries needed for OpenCASCADE and offscreen rendering:

- `libgl1`, `libglib2.0-0`, `libgomp1` (OpenCASCADE runtime)
- `libx11-6`, `libxext6`, `libxrender1`, `xauth`, `xvfb` (offscreen rendering)

The `entrypoint.sh` script starts Xvfb on display `:99` before launching the Python worker, and handles signal forwarding for clean container shutdown.

The worker runs as a non-root user (`cadworker`) with the vault mounted at `/vault`.

### Environment Variables

| Variable                    | Default                                                  | Description                                      |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| `DATABASE_URL`              | `postgresql://postgres:postgres@localhost:5432/cascadia` | PostgreSQL connection string                     |
| `RABBITMQ_URL`              | `amqp://localhost:5672`                                  | RabbitMQ connection URL                          |
| `WORKER_CONCURRENCY`        | `2`                                                      | Max concurrent jobs                              |
| `JOB_TIMEOUT`               | `600000`                                                 | Job timeout in ms (10 min)                       |
| `CLAIM_RETRY_DELAY_SECONDS` | `5`                                                      | Pause before requeueing an unclaimable delivery  |
| `POISON_EXIT_GRACE_MS`      | `60000`                                                  | Grace after a timeout before the worker restarts |
| `EXIT_ON_HUNG_JOB`          | `true`                                                   | Restart the worker on a job hung past that grace |
| `HEALTH_PORT`               | `3003`                                                   | Health check HTTP port                           |
| `VAULT_ROOT`                | `/vault`                                                 | Root path for vault file storage                 |
| `STL_FORMAT`                | `binary`                                                 | STL output format (binary/ascii)                 |

## AI CAD Generation (FreeCAD)

The generation pipeline at `cascadia-design-engine/src/cad-generation/` creates new STEP files for parts that have no parametric template. It is used by the collaborative design engine during the CAD Generation stage, and by the part detail page's **Generate CAD** action.

### How it works

There is no external text-to-CAD service. The instance's AI provider — the same one the chatbot and the design engine's drafting stages resolve through `loadProviderConfig` — writes a **FreeCAD Python script** for the part; a Python worker runs the script in **headless FreeCAD**; the model reads the worker's report and revises the script until the geometry is valid or its attempt budget is spent. Every attempt is inspectable: the script, the traceback, the geometry summary. Typical parts take one to three attempts of tens of seconds to a few minutes each.

```
Design engine / jobs worker (Node.js)             FreeCAD runner (Python)
+------------------------------------+            +----------------------------+
| freecad-agent.ts                   |            |  RabbitMQ consumer         |
|   loadProviderConfig(programId)    |            |    jobs.generation.cad.    |
|   chat(): the model writes a       |            |    freecad.#               |
|     script and calls the tool      |            |                            |
|     run_freecad_script ----------- JobService -> |  guard.py   static checks  |
|       (generation.cad.freecad,     |  RabbitMQ  |  runner.py  child process: |
|        persist: false)             |  + jobs    |    scrubbed env, limits,   |
|     <---- report: ok / traceback / |    row     |    deadline kill           |
|           geometry summary         |            |  harness.py exec, validate |
|   ...revise, repeat...             |            |    `result`, export STEP   |
|   accepted script run once more    |            |                            |
|     with persist: true ----------> |            |  STEP -> vault + DB record |
+------------------------------------+            +----------------------------+
```

### The agent (`freecad-agent.ts`)

`generatePartWithFreecad()` runs one tool-calling conversation per part:

1. **Settings and provider.** Reads the admin settings (`resolveCadGenerationSettings`) and resolves the AI provider for the part's program — the same chokepoint every other AI surface uses, so the monthly token budget applies.
2. **Prompt.** The system prompt (`freecad-system-prompt.ts`) carries the execution contract, the slice of FreeCAD's `Part` API that reliably builds manufacturable solids headless, and the modelling habits that keep boolean operations from failing (overshooting cutters, fillets last, no coplanar faces). The user turn is the part specification from `buildCadPrompt` (below), the attempt budget, and — on regeneration — the previous script and the feedback.
3. **One tool.** `run_freecad_script` takes a complete script. Each call is one attempt: the script goes to the FreeCAD worker as a `generation.cad.freecad` job with `persist: false`, and the tool returns the report — the exception and trimmed traceback and the harness's validation issues, or the geometry summary (solid count, face and edge counts, volume, bounding box and size) and the tails of stdout/stderr — plus a line of guidance on what to do next.
4. **Acceptance.** When the model stops calling the tool after an `ok` run, the last `ok` script is accepted and run once more with `persist: true`. That is the only run that writes a vault file: a dozen attempts leave one STEP behind, not a dozen.
5. **Result.** The vault file id, bounding box, accepted script and attempt count. The script is stored on the BOM node (`cadGeneration.generationScript`) and in the vault file's `cad_metadata`; a regeneration hands it back to the model to revise, so a small piece of feedback yields a small change.

A run ends without geometry when every attempt failed or the budget ran out (the failure carries the last report's error), when the worker could not run a script at all (the conversation is torn down at once rather than letting the model spend tokens retrying against an outage), or when the caller aborts. Transient provider failures retry the request; a provider failure _after_ a valid geometry costs the summary, not the part. A model that answers with a fenced script instead of calling the tool gets that script run once.

Metering follows `AssemblyPlanner`: the caller owns the `UsageAccumulator` and writes one usage row per run — a stage generating eight parts in parallel is one run, however many requests it takes.

### Settings

An admin configures generation at **Admin → AI Assistant** (`/admin/ai`), **CAD Generation** section. The values live in the `cad_generation` blob of the `settings` table (`settings-types.ts`):

| Setting                | Default | Range  | Meaning                                                                            |
| ---------------------- | ------- | ------ | ---------------------------------------------------------------------------------- |
| `enabled`              | `true`  |        | Master switch for the agent. Parametric templates and mechanisms are not affected. |
| `maxIterations`        | 6       | 1–12   | Script attempts per part                                                           |
| `scriptTimeoutSeconds` | 120     | 15–300 | Wall-clock budget for one FreeCAD run (FreeCAD's own start-up excluded)            |

There is no API key of its own: the agent uses the AI provider configured above it, and the card says so when none is. `CAD_GENERATION_CONCURRENCY` (default 3) bounds how many parts a stage run generates at once. The **Test FreeCAD worker** button runs a ten-millimetre cube through the whole pipeline (`POST /api/v1/admin/cad-settings/test`) and reports the FreeCAD version and timing — or a timeout naming the queue, when no worker is consuming it.

The hosted-demo provisioning writes `{ enabled: false }` so a prospect's tenant never spends model tokens on geometry.

### Part specification

The prompt builder (`prompt-builder.ts`) synthesizes part context into the specification the model works from. The key principle is to lead with the feature tree rather than just the part name:

1. **Geometry description**: Part name and description with key dimensions extracted from interface definitions.
2. **Material**: Material specification if available.
3. **Interface features**: The most important section. Each interface is described with its geometry (shape, dimensions, count, pattern, spacing) and location hint.
4. **Detailed geometry specification**: The `cadGenerationHint` the BOM stage authored, when present.
5. **Manufacturing constraints and DFM rules**: FDM, laser-cut, CNC or manual-cut constraints from the toolset, with the matching design-for-manufacture rules.
6. **Assembly context**: Parent assembly name and purpose, plus sibling part names and bounding boxes for proportioning.
7. **User feedback**: Additional requirements for regeneration attempts.

### Parametric Generation Assessment

Before starting the agent, Cascadia can assess whether a part matches a parametric template (`assessment.ts`). An LLM evaluates the part against available templates:

| Template                | Parameters                                                   |
| ----------------------- | ------------------------------------------------------------ |
| `bushing`               | od, id, length                                               |
| `spacer`                | od, id, length                                               |
| `tube`                  | od, wall_thickness, length                                   |
| `plate`                 | width, height, thickness, corner_radius                      |
| `plate_with_holes`      | width, height, thickness, hole_diameter, corner_radius, etc. |
| `block`                 | width, depth, height, corner_radius                          |
| `bracket_l`             | leg1_length, leg2_length, width, thickness, etc.             |
| `bracket_u`             | base_length, leg_height, width, thickness, etc.              |
| `extrusion_rectangular` | width, height, length, wall_thickness                        |
| `extrusion_circular`    | diameter, length, wall_thickness                             |

Parts matching a template are dispatched to the CadQuery worker via the `generation.cad.parametric` job type, which generates STEP files in approximately 1–2 seconds. Parts with complex geometry go to the FreeCAD agent.

### Design Engine Integration

The CAD generation stage (`cascadia-design-engine/src/design-engine/stages/cad-generation.ts`) is the primary consumer of the generation pipeline. It runs after materialization (which creates actual PLM items) and before assembly composition.

The stage:

1. Builds a `tempId` to `itemId` mapping from the materialization result.
2. Collects all leaf Manufacture parts from the BOM tree that need CAD generation.
3. Generates in parallel under a concurrency pool (default 3, `CAD_GENERATION_CONCURRENCY`): parametric parts and mechanisms through the CadQuery worker, everything else through the FreeCAD agent. The agent's per-attempt progress lines are relayed to the client while the part is still generating.
4. Lets the workers write the STEP files into the vault (the CadQuery worker for parametric and mechanism parts, the FreeCAD runner for agent parts).
5. Tracks per-part status (complete/failed), the generation method, the attempt count and the accepted script on the BOM node's `cadGeneration` property, persisting each part the moment it finishes so an interrupted run resumes without regenerating.
6. Supports single-part regeneration with optional user feedback text; the previous script is handed back for revision.

When a part is regenerated, `cascade-recompose.ts` identifies all ancestor assemblies and marks them as stale for recomposition.

### The FreeCAD runner (`cascadia-workers-freecad-runner/`)

A Python worker, deployed beside the CAD converter and the CadQuery generator, that consumes `generation.cad.freecad` jobs. It is the only place FreeCAD runs.

**Consumer.** Same three-phase structure as the CadQuery generator (`tests/test_worker_claim.py` pins the wiring in both): a stable shared queue `freecad-runner` bound to `jobs.generation.cad.freecad.#`, an atomic claim, and settlement by database status. The one difference is deliberate: **a script that fails is a completed job with `ok: false`**, never a failed job. The job system's retry ledger exists for infrastructure faults — a lost database, a FreeCAD that will not import — and re-running a script that raised would only reach the same traceback. The agent that submitted it is the retry.

**Static guard (`guard.py`).** Refuses, before FreeCAD is started, what cannot work or must not run: `FreeCADGui`; imports outside an allowlist (FreeCAD's modules plus pure standard-library modules such as `math`); `open()`, `exec()`, `eval()`, `__import__`; `exit()`/`sys.exit` (which would end the harness before it reports); `input()`/`breakpoint()`; dunder introspection. Violations name the line and say what is available, so the model can act on them.

**Process isolation (`runner.py`).** Each script runs in its own interpreter process — the environment's Python, which can `import FreeCAD` because conda-forge builds FreeCAD with `INSTALL_TO_SITEPACKAGES` — with:

- a **scrubbed environment**: built from scratch, so `DATABASE_URL` and `RABBITMQ_URL` never reach a model-written script;
- its own working directory as `HOME`, `TMPDIR` and `FREECAD_USER_HOME`;
- **resource limits** on POSIX: no core dumps, a 512 MB file-size cap, a CPU-time backstop, an optional address-space cap (`SCRIPT_MEMORY_MB`), and its own session so the whole process group is killed at once;
- a **wall-clock deadline**: the payload's `timeoutMs` (clamped to `MAX_SCRIPT_TIMEOUT_MS`) plus a start-up allowance for importing the kernel; a runaway script is killed and reported as such.

**Harness (`harness.py`).** Runs inside the FreeCAD process with a restricted set of builtins and a guarded `__import__` enforcing the same allowlist at run time. It executes the script with `FreeCAD`, `App` and `Part` pre-imported, then validates `result`: it must be a `Part.Shape` (a document object's `Shape` and lists of shapes are accepted), non-null, with at least one solid, `isValid()`, non-zero volume, and extents that look like millimetres. Fatal findings fail the run with an actionable message; advisories (several solids, a very large part) ride along in `issues`. On success it exports the STEP and records the geometry summary. The **report file** is the source of truth; the harness leaves through `os._exit` after writing it, so FreeCAD's known crash-on-exit and a script's stray `SystemExit` cannot turn a result into a failure or vice versa.

**Persisting.** With `persist: true` the STEP is copied into the vault under `cad-output/<job_id>/` and a `vault_files` row is inserted (`file_category: 'cad_model'`) with `cad_metadata` carrying `software: "freecad"`, the FreeCAD version, the bounding box and volume, and the script itself with its SHA-256 — the script _is_ the parametric record of the part.

**Health.** `GET /health` on port 3005 reports the worker state and whether FreeCAD imports (`freecad.available`, `freecad.version`); a worker whose FreeCAD is broken answers 503 rather than silently failing every job.

**Docker image.** Two-stage build like the other Python workers: a conda-forge environment (`environment.yml`: `freecad>=1.0`, pika, psycopg, pydantic) packed with `conda-pack` onto `debian:bookworm-slim` with the OpenGL, X11 and Qt runtime libraries FreeCAD links even headless. `gmsh` — a FreeCAD run dependency for FEM meshing, and GPL-2.0-or-later — is removed from the environment after the solve, since this worker never meshes; the build fails if `import FreeCAD, Part` does not succeed in the finished image. Attribution is in `THIRD-PARTY-NOTICES` and `/app/licenses`. The image is large (FreeCAD pulls Qt) and is built locally from `cascadia-workers-freecad-runner/Dockerfile`; no prebuilt image is published yet.

**Local use.** `npm run freecad:worker:dev` builds and starts it under compose (`freecad-runner-dev`, profiles `dev` and `cad`); `npm run workers:dev` includes it. `python -m freecad_runner.main run part.py -o out/` runs one script through the guard and harness by hand, and `python -m freecad_runner.main probe` reports whether FreeCAD imports.

### Environment Variables (FreeCAD runner)

| Variable                    | Default                                                  | Description                                                                                  |
| --------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | `postgresql://postgres:postgres@localhost:5432/cascadia` | PostgreSQL connection string                                                                 |
| `RABBITMQ_URL`              | `amqp://localhost:5672`                                  | RabbitMQ connection URL                                                                      |
| `WORKER_CONCURRENCY`        | `2`                                                      | Max concurrent scripts (each is a FreeCAD process)                                           |
| `JOB_TIMEOUT`               | `420000`                                                 | Job timeout in ms (7 min); the watchdog fires only on a wedged worker                        |
| `SCRIPT_TIMEOUT_MS`         | `120000`                                                 | Script budget when the payload names none                                                    |
| `MAX_SCRIPT_TIMEOUT_MS`     | `300000`                                                 | Ceiling applied to the payload's `timeoutMs`                                                 |
| `FREECAD_PYTHON`            | (this interpreter)                                       | Interpreter that can `import FreeCAD`; set for a system or AppImage FreeCAD                  |
| `FREECAD_LIB_DIR`           | (none)                                                   | Extra `sys.path` entries for FreeCAD installs outside site-packages (`/usr/lib/freecad/lib`) |
| `SCRIPT_MEMORY_MB`          | `0`                                                      | Address-space cap for the script process; 0 = unlimited                                      |
| `OUTPUT_CAPTURE_CHARS`      | `8000`                                                   | Tail of the script's stdout/stderr kept in the report                                        |
| `CLAIM_RETRY_DELAY_SECONDS` | `5`                                                      | Pause before requeueing an unclaimable delivery                                              |
| `POISON_EXIT_GRACE_MS`      | `60000`                                                  | Grace after a timeout before the worker restarts                                             |
| `EXIT_ON_HUNG_JOB`          | `true`                                                   | Restart the worker on a job hung past that grace                                             |
| `HEALTH_PORT`               | `3005`                                                   | Health check HTTP port                                                                       |
| `VAULT_ROOT`                | `/vault`                                                 | Root path for vault file storage                                                             |

### Standalone generation from a part

`POST /api/v1/parts/:id/generate-cad` with `method: "freecad"` submits a `generation.cad.ai` job, which runs the same agent on the Node jobs worker for a part that was not born in a design session, resolving the AI provider through the part's program. The dialog polls the job; the agent's progress lines drive the progress bar and land in the job log. `method: "parametric"` still submits `generation.cad.parametric` directly. The request is refused with a 400 when the admin switch is off, so a disabled instance answers at once rather than minutes later inside the job.

## Assembly Composition

After individual part STEP files are generated, assemblies are composed by positioning child parts relative to each other. Composition has three parts: an LLM **plans** placements, the plan is serialized to a **FreeCAD assembly script** as a portable artifact, and the CadQuery/OCCT worker **renders** the composed STEP file into the vault.

### Assembly script

`assembly-script.ts` serializes a plan to a FreeCAD Python script that reads each child STEP file, applies its placement transform, and collects the result into one compound. It is stored on the BOM node (`assemblyComposition.assemblyScript`) as the plan's human-readable record; actual geometry rendering happens in-house via the OCCT worker (below), from the same placements, so the two can never disagree about a transform.

A generated script looks like:

```python
# Assembly: motor-mount-assy
# Auto-generated by Cascadia Design Engine — FreeCAD 1.x, headless-safe.
import FreeCAD as App
import Part
from FreeCAD import Base


def place(shape, rx, ry, rz, tx, ty, tz):
    """rotateX -> rotateY -> rotateZ about the global origin (degrees),
    then translate -- the convention the generation.cad.assemble worker
    applies, so this script reproduces its output."""
    origin = Base.Vector(0, 0, 0)
    if rx:
        shape.rotate(origin, Base.Vector(1, 0, 0), rx)
    if ry:
        shape.rotate(origin, Base.Vector(0, 1, 0), ry)
    if rz:
        shape.rotate(origin, Base.Vector(0, 0, 1), rz)
    if tx or ty or tz:
        shape.translate(Base.Vector(tx, ty, tz))
    return shape


doc = App.newDocument("motor_mount_assy")
shapes = []

# Base Plate (tempId part-1)
base_plate = place(Part.read("vault-file-id-abc.step"), 0, 0, 0, 0, 0, 0)
base_plate_obj = doc.addObject("Part::Feature", "base_plate")
base_plate_obj.Shape = base_plate
shapes.append(base_plate)

# Motor Bracket (tempId part-2)
motor_bracket = place(Part.read("vault-file-id-def.step"), 0, 0, 90, 50, 0, 25)
motor_bracket_obj = doc.addObject("Part::Feature", "motor_bracket")
motor_bracket_obj.Shape = motor_bracket
shapes.append(motor_bracket)

doc.recompute()
result = Part.makeCompound(shapes)
```

### Assembly Planning

The `AssemblyPlanner` class (`assembly-planner.ts`) uses an LLM to determine how child parts should be positioned. It receives:

- Child part bounding boxes (from CAD generation results).
- Interface definitions (shape, dimensions, location hints).
- Interface mappings (which interfaces on which parts connect to each other).
- Design context (product description, assembly purpose).

The LLM produces a JSON response with:

- `reasoning`: explanation of the assembly strategy.
- `placements`: list of transforms (translation + rotation) for each child.

The `placements` list is the engine-agnostic source of truth: each entry carries a `Transform3D` (translation in mm, rotation as Euler XYZ in degrees) plus the child's vault STEP file key. The assembly script is one serialization of it; the OCCT render consumes it directly. The model is never asked to write code.

### STEP Rendering (OCCT Worker)

After planning, the stage submits a `generation.cad.assemble` job (`cascadia-design-engine/src/cad-generation/assembly-render.ts`) to the CadQuery worker at `cascadia-workers-cad-generator/`, which:

1. Resolves each child STEP from the vault by file ID (`get_vault_file()` in the worker's `db.py` — the workers' only vault _read_ path; everything else is write-only).
2. Imports each child with `cq.importers.importStep()` and applies the placement transform (`assembly.py`).
3. Combines the transformed shapes into a structured `cq.Assembly` with deduplicated part names, exported via XDE so the CAD converter's decomposer can read the output back.
4. Stores the composed STEP in the vault and returns `{ vaultFileId, fileName, boundingBox }`.

On success the BOM node gets `assemblyComposition = { status: 'complete', assemblyStepFileKey, boundingBox, ... }`. The bounding box feeds the _parent_ assembly's planning and overlap validation — this is what makes multi-level composition work, since sub-assemblies have no `cadGeneration.boundingBox` of their own.

**Rotation convention** (pinned by `cascadia-workers-cad-generator/tests/test_assembly.py`): rotateX → rotateY → rotateZ, each about the **global** axis through the origin, in degrees, followed by translation — identical to the serialization in `assembly-script.ts`. Transforms are baked into each shape before it joins the assembly, so the exported XDE holds identity locations plus part names.

Two deliberate fallbacks:

- The stage re-keys every placement's `stepFileKey` from its own child data before submission — LLM-echoed file keys are never trusted.
- If the assembly has no materialized item or ECO branch to attach a file to, the node falls back to `status: 'code_only'` (plan + script retained, no geometry). `code_only` nodes are not skipped on re-run, so they gain geometry once the context exists.

`quantity > 1` placements currently render a single instance (the plan carries one transform per placement); the worker logs a warning when this happens.

### Bottom-Up Assembly Order

Multi-level assemblies are processed bottom-up via post-order traversal (`assembly-order.ts`). Leaf sub-assemblies are composed first so their STEP files are available when the parent assembly is planned.

The order computation:

1. Post-order traversal of the BOM tree.
2. Only assembly nodes (those with children) are included.
3. For each assembly, checks readiness: all child Manufacture parts must have `cadGeneration.status === 'complete'`, and all child sub-assemblies must have `assemblyComposition.status === 'complete'`.

### Validation

Before and after assembly planning, validators check for issues:

**Pre-planning** (`validateAssemblyReadiness`):

- All Manufacture children have generated STEP files.
- All sub-assemblies have been composed.
- All children have interface mappings (warning if not).

**Post-planning** (`validateAssemblyPlan`):

- At least one placement exists.
- At least one part is near the origin (within 100mm).
- No parts are placed more than 10 meters from origin.
- No bounding box overlaps between placed parts (AABB check).

### Interface Propagation

When a sub-assembly is composed, not all child interfaces are consumed by internal connections. `interface-propagation.ts` computes which interfaces are "exposed" (not referenced in any interface mapping) and available for the parent assembly to use for positioning.

## Integration with PLM

### Vault File Storage

All generated and converted CAD files are stored in the Cascadia vault system. The Python workers write directly to the vault filesystem and insert `vault_files` records via SQL.

File categories used:

- `cad_model`: STEP, STL, and GLB files.
- `thumbnail`: PNG preview images linked to their source files.

Each vault file record includes:

- Standard metadata: name, size, MIME type, SHA-256 hash.
- `cad_metadata` JSONB: polygon count and bounding box for converted files (`software: "pythonocc-core"`, `hasColors` for GLB); template and parameters for parametric parts (`software: "cadquery"`); the generating script, its hash, the FreeCAD version, bounding box and volume for agent parts (`software: "freecad"`).
- `thumbnail_file_id`: links to the associated thumbnail.

### Background Job Processing

CAD operations use these job types registered in the background job system:

**`conversion.cad.step-to-stl`**: Converts existing STEP/IGES files to STL + GLB.

- Routing key: `jobs.conversion.cad`
- Timeout: 10 minutes
- Max attempts: 2
- Retry delays: 60s, 120s
- Consumed by the Python CAD converter worker.

**`generation.cad.parametric`**: Generates STEP files from parametric templates.

- Routing key: `jobs.generation.cad.parametric`
- Timeout: 1 minute
- Max attempts: 3
- Retry delays: 5s, 15s, 30s
- Consumed by the CadQuery worker (`cascadia-workers-cad-generator/`).

**`generation.cad.mechanism`**: Generates coordinated multi-part mechanisms (e.g. rack-and-pinion via cq-gears), one STEP per role.

- Routing key: `jobs.generation.cad.mechanism`
- Consumed by the CadQuery worker.

**`generation.cad.assemble`**: Composes child STEP files into one structured assembly STEP from planned placements.

- Routing key: `jobs.generation.cad.assemble`
- Timeout: 3 minutes
- Max attempts: 3
- Retry delays: 5s, 15s, 30s
- Consumed by the CadQuery worker.

**`generation.cad.freecad`**: Runs one FreeCAD Python script and reports what it built; with `persist: true`, stores the STEP in the vault.

- Routing key: `jobs.generation.cad.freecad`
- Timeout: 7 minutes (above the largest script budget an admin can set, plus FreeCAD start-up)
- Max attempts: 2 (for the worker dying under the job — a script error is a completed job with `ok: false`, never retried)
- Retry delays: 5s
- Consumed by the FreeCAD runner (`cascadia-workers-freecad-runner/`).

**`generation.cad.ai`**: Runs the FreeCAD agent for one existing part (the part page's **Generate CAD** action), submitting `generation.cad.freecad` jobs for each attempt.

- Routing key: `jobs.generation.cad.ai`
- Timeout: 30 minutes (sized for the maximum budget, twelve attempts of up to five minutes)
- Max attempts: 2
- Retry delays: 30s
- Consumed by the Node.js jobs worker.

Jobs are submitted via `JobService.submit()` and tracked in the `jobs` table with progress updates, log entries, and result storage.

### API Endpoints

**`POST /api/v1/files/:fileId/convert`**: Submits a CAD conversion job for an existing vault file. Validates that the file extension is a supported CAD format (`.step`, `.stp`, `.iges`, `.igs`). Accepts optional `meshQuality`, `decompose`, and `targetItemId` parameters. Returns `202 Accepted` with the job ID.

**`POST /api/v1/parts/:id/generate-cad`**: Submits generation for a Manufacture part — `method: "parametric"` with a template and parameters, or `method: "freecad"` for the agent. Returns `201 Created` with the job ID. **`/assess`** asks the LLM whether a template fits; **`/convert`** submits the follow-up STEP-to-STL conversion.

**`GET`/`POST /api/v1/admin/cad-settings`**: Read and write the AI CAD generation settings (switch, attempt budget, script timeout). **`POST /api/v1/admin/cad-settings/test`**: Run the FreeCAD worker smoke test.

## Source Files

### CAD Converter (Python)

| File                                                    | Purpose                                       |
| ------------------------------------------------------- | --------------------------------------------- |
| `cascadia-workers-cad/src/cad_converter/main.py`        | Entry point: CLI mode or RabbitMQ worker      |
| `cascadia-workers-cad/src/cad_converter/worker.py`      | RabbitMQ consumer and job orchestration       |
| `cascadia-workers-cad/src/cad_converter/converter.py`   | STEP/IGES reading, tessellation, STL writing  |
| `cascadia-workers-cad/src/cad_converter/colors.py`      | XDE color extraction from STEP files          |
| `cascadia-workers-cad/src/cad_converter/gltf_writer.py` | GLB binary glTF output with per-face colors   |
| `cascadia-workers-cad/src/cad_converter/assembly.py`    | Assembly decomposition into individual parts  |
| `cascadia-workers-cad/src/cad_converter/thumbnail.py`   | Offscreen PNG thumbnail rendering via Xvfb    |
| `cascadia-workers-cad/src/cad_converter/models.py`      | Pydantic models for payloads, results, config |
| `cascadia-workers-cad/src/cad_converter/db.py`          | PostgreSQL operations (jobs, vault_files)     |
| `cascadia-workers-cad/src/cad_converter/config.py`      | Environment variable configuration            |
| `cascadia-workers-cad/src/cad_converter/health.py`      | HTTP health check endpoint                    |
| `cascadia-workers-cad/Dockerfile`                       | Two-stage Docker build with conda-pack        |
| `cascadia-workers-cad/entrypoint.sh`                    | Xvfb + Python worker startup                  |
| `cascadia-workers-cad/environment.yml`                  | Conda environment spec                        |

### CAD Generation (TypeScript)

| File                                                                 | Purpose                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| `cascadia-design-engine/src/cad-generation/freecad-agent.ts`         | The FreeCAD script agent: model ↔ worker iteration, persist   |
| `cascadia-design-engine/src/cad-generation/freecad-execute.ts`       | Submit a `generation.cad.freecad` job and wait for its report |
| `cascadia-design-engine/src/cad-generation/freecad-system-prompt.ts` | System prompt and task prompt for the agent                   |
| `cascadia-design-engine/src/cad-generation/part-generator.ts`        | Parallel STEP generation for Manufacture parts                |
| `cascadia-design-engine/src/cad-generation/progress-channel.ts`      | Relays agent progress out of the concurrency pool             |
| `cascadia-design-engine/src/cad-generation/prompt-builder.ts`        | Part specification from PLM context                           |
| `cascadia-design-engine/src/cad-generation/settings-types.ts`        | Settings shape, defaults and limits (client-safe)             |
| `cascadia-design-engine/src/cad-generation/settings.ts`              | Server-side settings resolver                                 |
| `cascadia-design-engine/src/cad-generation/assessment.ts`            | LLM-based parametric vs. agent routing                        |
| `cascadia-design-engine/src/cad-generation/assembly-planner.ts`      | LLM-based assembly planning                                   |
| `cascadia-design-engine/src/cad-generation/assembly-order.ts`        | Bottom-up traversal order computation                         |
| `cascadia-design-engine/src/cad-generation/assembly-validator.ts`    | Pre/post assembly plan validation                             |
| `cascadia-design-engine/src/cad-generation/assembly-script.ts`       | FreeCAD assembly script generation from assembly plans        |
| `cascadia-design-engine/src/cad-generation/assembly-render.ts`       | Assembly STEP render job submission + polling                 |
| `cascadia-design-engine/src/cad-generation/interface-propagation.ts` | Exposed interface computation                                 |
| `cascadia-design-engine/src/cad-generation/cascade-recompose.ts`     | Stale assembly detection on part regeneration                 |
| `cascadia-design-engine/src/cad-generation/types.ts`                 | Shared type definitions                                       |

### Job Configuration (TypeScript)

| File                                                                          | Purpose                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------- |
| `cascadia-api/src/jobs/definitions/conversion/config.ts`                      | `conversion.cad.step-to-stl` job type config |
| `cascadia-api/src/jobs/definitions/conversion/types.ts`                       | Payload and result Zod schemas               |
| `cascadia-design-engine/src/jobs/definitions/parametric-generation/config.ts` | `generation.cad.parametric` job type config  |
| `cascadia-design-engine/src/jobs/definitions/parametric-generation/types.ts`  | Payload and result Zod schemas               |
| `cascadia-design-engine/src/jobs/definitions/mechanism-generation/config.ts`  | `generation.cad.mechanism` job type config   |
| `cascadia-design-engine/src/jobs/definitions/mechanism-generation/types.ts`   | Payload and result Zod schemas               |
| `cascadia-design-engine/src/jobs/definitions/assembly-composition/config.ts`  | `generation.cad.assemble` job type config    |
| `cascadia-design-engine/src/jobs/definitions/assembly-composition/types.ts`   | Payload and result Zod schemas               |
| `cascadia-design-engine/src/jobs/definitions/freecad-script/config.ts`        | `generation.cad.freecad` job type config     |
| `cascadia-design-engine/src/jobs/definitions/freecad-script/types.ts`         | Payload and report Zod schemas               |
| `cascadia-design-engine/src/jobs/definitions/ai-generation/config.ts`         | `generation.cad.ai` job type config          |
| `cascadia-design-engine/src/jobs/definitions/ai-generation/types.ts`          | Payload and result Zod schemas               |
| `cascadia-design-engine/src/jobs/node-handlers/ai-generation.ts`              | Node handler running the agent for one part  |

### CAD Generator (Python)

| File                                                                     | Purpose                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------ |
| `cascadia-workers-cad-generator/src/cad_generator/worker.py`             | RabbitMQ consumer: parametric/mechanism/assemble |
| `cascadia-workers-cad-generator/src/cad_generator/templates/`            | CadQuery parametric part templates               |
| `cascadia-workers-cad-generator/src/cad_generator/mechanism_generators/` | Multi-part mechanism generators (cq-gears)       |
| `cascadia-workers-cad-generator/src/cad_generator/assembly.py`           | Placement transforms + structured STEP assembly  |
| `cascadia-workers-cad-generator/src/cad_generator/export.py`             | STEP export and bounding box computation         |
| `cascadia-workers-cad-generator/src/cad_generator/models.py`             | Pydantic models for payloads and results         |
| `cascadia-workers-cad-generator/src/cad_generator/db.py`                 | PostgreSQL operations (jobs, vault_files)        |
| `cascadia-workers-cad-generator/tests/test_assembly.py`                  | Rotation-convention and STEP round-trip tests    |

### FreeCAD Runner (Python)

| File                                                            | Purpose                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| `cascadia-workers-freecad-runner/src/freecad_runner/worker.py`  | RabbitMQ consumer: `generation.cad.freecad`, vault persistence  |
| `cascadia-workers-freecad-runner/src/freecad_runner/guard.py`   | Static script checks and the import allowlist                   |
| `cascadia-workers-freecad-runner/src/freecad_runner/runner.py`  | Child-process execution: scrubbed env, limits, deadline, report |
| `cascadia-workers-freecad-runner/src/freecad_runner/harness.py` | Runs inside FreeCAD: restricted builtins, validation, export    |
| `cascadia-workers-freecad-runner/src/freecad_runner/models.py`  | Pydantic models mirroring the TypeScript schemas                |
| `cascadia-workers-freecad-runner/src/freecad_runner/main.py`    | Entry point: worker, `run` one script, `probe`                  |
| `cascadia-workers-freecad-runner/tests/test_guard.py`           | What the guard refuses and admits                               |
| `cascadia-workers-freecad-runner/tests/test_runner.py`          | Process contract against a fake FreeCAD (no conda needed)       |
| `cascadia-workers-freecad-runner/tests/test_worker_claim.py`    | Delivery settlement, including failed-script-is-completed       |
| `cascadia-workers-freecad-runner/Dockerfile`                    | conda-forge FreeCAD, gmsh removed, import check at build        |

### Design Engine Stages

| File                                                                      | Purpose                              |
| ------------------------------------------------------------------------- | ------------------------------------ |
| `cascadia-design-engine/src/design-engine/stages/cad-generation.ts`       | CAD generation stage processor       |
| `cascadia-design-engine/src/design-engine/stages/assembly-composition.ts` | Assembly composition stage processor |

### API Routes

| File                                                       | Purpose                                          |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `cascadia-api/src/server/routes/files.ts`                  | POST endpoint to submit conversion jobs          |
| `cascadia-design-engine/src/server/routes/parts-cad.ts`    | Generate/assess/convert actions on a part        |
| `cascadia-design-engine/src/server/routes/cad-settings.ts` | Admin settings and the FreeCAD worker smoke test |

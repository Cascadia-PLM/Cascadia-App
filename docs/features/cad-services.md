# CAD Services

Cascadia provides two complementary CAD processing pipelines: a **conversion service** that transforms existing STEP/IGES files into web-viewable formats (STL, GLB), and a **generation service** that creates new CAD geometry from natural language descriptions or parametric templates. Both pipelines integrate with the PLM vault for file storage and the background job system for asynchronous processing.

## CAD Conversion Service

The conversion service is a standalone Python microservice at `workers/cad-converter/`. It reads STEP and IGES files, tessellates the B-Rep geometry, and produces STL meshes and GLB files with per-face color preservation.

### Architecture

The converter runs as a separate process from the main Node.js application. It connects to the same PostgreSQL database and RabbitMQ broker, consuming job messages from the `jobs.conversion.cad.#` routing pattern.

```
Main App (Node.js)                     CAD Converter (Python)
+---------------------+               +---------------------+
| POST /api/files/    |               |                     |
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

| Variable             | Default                                                  | Description                      |
| -------------------- | -------------------------------------------------------- | -------------------------------- |
| `DATABASE_URL`       | `postgresql://postgres:postgres@localhost:5432/cascadia` | PostgreSQL connection string     |
| `RABBITMQ_URL`       | `amqp://localhost:5672`                                  | RabbitMQ connection URL          |
| `WORKER_CONCURRENCY` | `2`                                                      | Max concurrent jobs              |
| `JOB_TIMEOUT`        | `600000`                                                 | Job timeout in ms (10 min)       |
| `HEALTH_PORT`        | `3003`                                                   | Health check HTTP port           |
| `VAULT_ROOT`         | `/vault`                                                 | Root path for vault file storage |
| `STL_FORMAT`         | `binary`                                                 | STL output format (binary/ascii) |

## CAD Generation (Zoo Text-to-CAD API)

The generation pipeline at `src/lib/cad-generation/` creates new STEP files from natural language descriptions. It is used by the collaborative design engine to generate geometry for new Manufacture parts during the CAD Generation stage.

### Text-to-CAD Concept

The idea is straightforward: describe a part in plain English and receive a STEP file. The Zoo API (`https://api.zoo.dev`) provides this capability as a cloud service. Cascadia wraps it with prompt engineering that incorporates PLM context (interface geometry, assembly relationships, material specs) to produce more accurate results.

### Zoo API Integration

The `ZooClient` class (`zoo-client.ts`) handles communication with the Zoo API:

1. **Submit**: `POST /ai/text-to-cad/{format}` with a text prompt. Returns a request ID.
2. **Poll**: `GET /async/operations/{requestId}` to check status. Uses exponential backoff starting at 5 seconds, capping at 60 seconds.
3. **Extract**: When status is `completed`, the response includes an `outputs` map of filename to base64-encoded file content. The client decodes the first output file.

Configuration:

- `ZOO_API_KEY` (required): API key for authentication.
- `ZOO_TEXT_TO_CAD_TIMEOUT_MS` (optional): Maximum wait time, default 600 seconds (10 minutes).
- `ZOO_TEXT_TO_CAD_CONCURRENCY` (optional): Max parallel Zoo API calls, default 3.

### Prompt Construction

The prompt builder (`prompt-builder.ts`) synthesizes part context into an effective Zoo prompt. The key principle is to lead with the feature tree rather than just the part name:

1. **Geometry description**: Part name and description with key dimensions extracted from interface definitions.
2. **Material**: Material specification if available.
3. **Interface features**: The most important section. Each interface is described with its geometry (shape, dimensions, count, pattern, spacing) and location hint.
4. **Assembly context**: Parent assembly name and purpose, plus sibling part names and bounding boxes for proportioning.
5. **User feedback**: Additional requirements for regeneration attempts.

### Parametric Generation Assessment

Before calling the Zoo API, Cascadia can assess whether a part matches a parametric template (`assessment.ts`). An LLM evaluates the part against available templates:

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

Parts matching a template are dispatched to a CadQuery worker via the `generation.cad.parametric` job type, which generates STEP files in approximately 1-2 seconds. Parts with complex geometry fall through to the Zoo API, which takes approximately 5-10 minutes.

### Design Engine Integration

The CAD generation stage (`src/lib/design-engine/stages/cad-generation.ts`) is the primary consumer of the generation pipeline. It runs after materialization (which creates actual PLM items) and before assembly composition.

The stage:

1. Builds a `tempId` to `itemId` mapping from the materialization result.
2. Collects all leaf Manufacture parts from the BOM tree that need CAD generation.
3. Generates STEP files in parallel with concurrency control (default 3 concurrent Zoo calls).
4. Uploads each STEP file to the vault via `FileService.uploadFile()`.
5. Tracks per-part status (complete/failed) on the BOM node's `cadGeneration` property.
6. Supports single-part regeneration with optional user feedback text.

When a part is regenerated, `cascade-recompose.ts` identifies all ancestor assemblies and marks them as stale for recomposition.

## Assembly Composition (KCL)

After individual part STEP files are generated, assemblies must be composed by positioning child parts relative to each other.

### KCL (KittyCAD Language)

KCL is a domain-specific language for describing CAD assemblies. Cascadia generates KCL code that imports child STEP files and applies spatial transforms (translation, rotation).

A generated KCL project looks like:

```kcl
// Assembly: motor-mount-assy
// Auto-generated by Cascadia Design Engine

let base_plate = import("vault-file-id-abc.step")
  |> translate([0, 0, 0], %)

let motor_bracket = import("vault-file-id-def.step")
  |> rotateZ(90, %)
  |> translate([50, 0, 25], %)

let mounting_bolt = import("vault-file-id-ghi.step")
  |> translate([25, 15, 0], %)

// mounting_bolt x4
let mounting_bolt_2 = clone(mounting_bolt)
let mounting_bolt_3 = clone(mounting_bolt)
let mounting_bolt_4 = clone(mounting_bolt)
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
- `kclCode`: KCL assembly code.

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

All generated and converted CAD files are stored in the Cascadia vault system. The converter writes directly to the vault filesystem and inserts `vault_files` records via SQL. The generation pipeline uses `FileService.uploadFile()` from the Node.js application.

File categories used:

- `cad_model`: STEP, STL, and GLB files.
- `thumbnail`: PNG preview images linked to their source files.

Each vault file record includes:

- Standard metadata: name, size, MIME type, SHA-256 hash.
- `cad_metadata` JSONB: polygon count, bounding box dimensions, `software: "pythonocc-core"`, `hasColors` flag for GLB files.
- `thumbnail_file_id`: links to the associated thumbnail.

### Background Job Processing

CAD operations use two job types registered in the background job system:

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
- Consumed by a CadQuery worker.

Jobs are submitted via `JobService.submit()` and tracked in the `jobs` table with progress updates, log entries, and result storage.

### API Endpoints

**`POST /api/files/:fileId/convert`**: Submits a CAD conversion job for an existing vault file. Validates that the file extension is a supported CAD format (`.step`, `.stp`, `.iges`, `.igs`). Accepts optional `meshQuality`, `decompose`, and `targetItemId` parameters. Returns `202 Accepted` with the job ID.

## Source Files

### CAD Converter (Python)

| File                                                     | Purpose                                       |
| -------------------------------------------------------- | --------------------------------------------- |
| `workers/cad-converter/src/cad_converter/main.py`        | Entry point: CLI mode or RabbitMQ worker      |
| `workers/cad-converter/src/cad_converter/worker.py`      | RabbitMQ consumer and job orchestration       |
| `workers/cad-converter/src/cad_converter/converter.py`   | STEP/IGES reading, tessellation, STL writing  |
| `workers/cad-converter/src/cad_converter/colors.py`      | XDE color extraction from STEP files          |
| `workers/cad-converter/src/cad_converter/gltf_writer.py` | GLB binary glTF output with per-face colors   |
| `workers/cad-converter/src/cad_converter/assembly.py`    | Assembly decomposition into individual parts  |
| `workers/cad-converter/src/cad_converter/thumbnail.py`   | Offscreen PNG thumbnail rendering via Xvfb    |
| `workers/cad-converter/src/cad_converter/models.py`      | Pydantic models for payloads, results, config |
| `workers/cad-converter/src/cad_converter/db.py`          | PostgreSQL operations (jobs, vault_files)     |
| `workers/cad-converter/src/cad_converter/config.py`      | Environment variable configuration            |
| `workers/cad-converter/src/cad_converter/health.py`      | HTTP health check endpoint                    |
| `workers/cad-converter/Dockerfile`                       | Two-stage Docker build with conda-pack        |
| `workers/cad-converter/entrypoint.sh`                    | Xvfb + Python worker startup                  |
| `workers/cad-converter/environment.yml`                  | Conda environment spec                        |

### CAD Generation (TypeScript)

| File                                              | Purpose                                        |
| ------------------------------------------------- | ---------------------------------------------- |
| `src/lib/cad-generation/zoo-client.ts`            | Zoo Text-to-CAD API client                     |
| `src/lib/cad-generation/part-generator.ts`        | Parallel STEP generation for Manufacture parts |
| `src/lib/cad-generation/prompt-builder.ts`        | Prompt construction from PLM context           |
| `src/lib/cad-generation/assessment.ts`            | LLM-based parametric vs. Zoo routing           |
| `src/lib/cad-generation/assembly-planner.ts`      | LLM-based assembly planning                    |
| `src/lib/cad-generation/assembly-order.ts`        | Bottom-up traversal order computation          |
| `src/lib/cad-generation/assembly-validator.ts`    | Pre/post assembly plan validation              |
| `src/lib/cad-generation/kcl-generator.ts`         | KCL project generation from assembly plans     |
| `src/lib/cad-generation/interface-propagation.ts` | Exposed interface computation                  |
| `src/lib/cad-generation/cascade-recompose.ts`     | Stale assembly detection on part regeneration  |
| `src/lib/cad-generation/types.ts`                 | Shared type definitions                        |

### Job Configuration (TypeScript)

| File                                                       | Purpose                                      |
| ---------------------------------------------------------- | -------------------------------------------- |
| `src/lib/jobs/definitions/conversion/config.ts`            | `conversion.cad.step-to-stl` job type config |
| `src/lib/jobs/definitions/conversion/types.ts`             | Payload and result Zod schemas               |
| `src/lib/jobs/definitions/parametric-generation/config.ts` | `generation.cad.parametric` job type config  |
| `src/lib/jobs/definitions/parametric-generation/types.ts`  | Payload and result Zod schemas               |

### Design Engine Stages

| File                                                   | Purpose                              |
| ------------------------------------------------------ | ------------------------------------ |
| `src/lib/design-engine/stages/cad-generation.ts`       | CAD generation stage processor       |
| `src/lib/design-engine/stages/assembly-composition.ts` | Assembly composition stage processor |

### API Routes

| File                                      | Purpose                                 |
| ----------------------------------------- | --------------------------------------- |
| `src/routes/api/files/$fileId/convert.ts` | POST endpoint to submit conversion jobs |

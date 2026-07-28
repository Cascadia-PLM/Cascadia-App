# CAD Services

Cascadia's CAD conversion service transforms existing STEP/IGES files into web-viewable formats (STL, GLB). It integrates with the PLM vault for file storage and the background job system for asynchronous processing.

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

## Integration with PLM

### Vault File Storage

Converted CAD files are stored in the Cascadia vault system. The converter writes directly to the vault filesystem and inserts `vault_files` records via SQL.

File categories used:

- `cad_model`: STEP, STL, and GLB files.
- `thumbnail`: PNG preview images linked to their source files.

Each vault file record includes:

- Standard metadata: name, size, MIME type, SHA-256 hash.
- `cad_metadata` JSONB: polygon count, bounding box dimensions, `software: "pythonocc-core"`, `hasColors` flag for GLB files.
- `thumbnail_file_id`: links to the associated thumbnail.

### Background Job Processing

CAD operations use these job types registered in the background job system:

**`conversion.cad.step-to-stl`**: Converts existing STEP/IGES files to STL + GLB.

- Routing key: `jobs.conversion.cad`
- Timeout: 10 minutes
- Max attempts: 2
- Retry delays: 60s, 120s
- Consumed by the Python CAD converter worker.

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

### Job Configuration (TypeScript)

| File                                                       | Purpose                                      |
| ---------------------------------------------------------- | -------------------------------------------- |
| `src/lib/jobs/definitions/conversion/config.ts`            | `conversion.cad.step-to-stl` job type config |
| `src/lib/jobs/definitions/conversion/types.ts`             | Payload and result Zod schemas               |

### API Routes

| File                                      | Purpose                                 |
| ----------------------------------------- | --------------------------------------- |
| `src/server/routes/files.ts`              | POST endpoint to submit conversion jobs |

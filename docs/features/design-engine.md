# Collaborative Design Engine

## Overview

The Collaborative Design Engine is an AI-assisted product design workflow that transforms a natural-language product description into fully materialized PLM items -- requirements, a hierarchical Bill of Materials (BOM), individual CAD files, and assembled geometry. The process is human-in-the-loop: the AI drafts each artifact, the user reviews, edits, and confirms before the engine advances to the next stage.

The engine runs as a multi-stage pipeline:

```
Description
  -> Requirements Drafting -> Requirements Review
  -> BOM Drafting          -> BOM Review
  -> Materialization
  -> CAD Generation        -> CAD Review
  -> Assembly Composition  -> Assembly Review
  -> Complete
```

Each transition is explicit. The user must confirm a review stage before the engine moves forward. At any drafting stage, the AI may ask clarification questions; the user answers, and the stage resumes with enriched context.

**Key entry point**: The user navigates to `/designs/collaborative/$sessionId` to open the workspace, or initiates a session from the AI chatbot via the `initiate_collaborative_design` tool.

## Design Stages

### Stage 1: Requirements Drafting

**Stage key**: `requirements_drafting`

The LLM analyzes the product description and produces structured requirements. It uses tool-calling to interact with the PLM system and build requirements incrementally.

**What happens**:

1. The engine loads the AI provider configuration for the session's program.
2. A system prompt is constructed containing the product description, any prior clarification answers, user guidance messages, and (on resume) already-proposed requirements.
3. The LLM is given four tools: `search_existing_designs`, `search_parts_library`, `propose_requirement`, and `ask_clarification`.
4. As the LLM calls `propose_requirement`, each requirement is streamed to the client as an `artifact_update` event and persisted to the database.
5. If the LLM calls `ask_clarification`, the stream pauses. The session stays at `requirements_drafting` so that when the user answers, the stage resumes with the answer incorporated.
6. When the LLM finishes without requesting clarification, the stage transitions to `requirements_review`.

**Requirement structure** (each `RequirementDraft`):

| Field                | Type   | Description                                                     |
| -------------------- | ------ | --------------------------------------------------------------- |
| `tempId`             | UUID   | Temporary ID for cross-referencing before materialization       |
| `name`               | string | Short requirement name                                          |
| `description`        | string | Detailed description with acceptance criteria                   |
| `requirementType`    | enum   | `Functional`, `Performance`, `Interface`, `Constraint`, `Other` |
| `priority`           | enum   | `low`, `medium`, `high`, `critical`                             |
| `verificationMethod` | enum   | `Analysis`, `Inspection`, `Test`, `Demonstration`               |
| `rationale`          | string | Why this requirement is needed                                  |
| `confidence`         | number | 0--1 confidence score                                           |
| `source`             | enum   | `ai` or `user`                                                  |

**Guidelines baked into the prompt**:

- Aim for 5--15 requirements for a typical component
- Cover both functional and non-functional requirements
- Consider manufacturability, testability, and cost constraints
- Mark uncertain requirements with lower confidence scores

### Stage 2: Requirements Review

**Stage key**: `requirements_review`

The user reviews AI-generated requirements in the left panel of the workspace. They can:

- **Edit** any requirement field (name, description, type, priority, verification method, rationale)
- **Remove** requirements that are not relevant
- **Add** new requirements manually (these are marked `source: 'user'`)
- **Send a message** to provide additional guidance -- if the stage is still in drafting mode, this re-invokes the LLM with the new context

When satisfied, the user clicks **Confirm Requirements** to advance to BOM drafting.

### Stage 3: BOM Drafting

**Stage key**: `bom_drafting`

The LLM decomposes the product into a hierarchical BOM tree, using confirmed requirements as input. This is the most tool-intensive stage with ten available tools (see [BOM Drafting Tools](#bom-drafting-tools) below).

**What happens**:

1. A system prompt is built containing the product description, confirmed requirements list, clarification history, user messages, and (on resume) the partial BOM tree.
2. The LLM works through three phases guided by the prompt:
   - **Phase 1 -- Structure**: Build the complete tree top-down. Create the root assembly, decompose into sub-assemblies (Phantom type), search for existing parts, propose new parts, and link requirements.
   - **Phase 2 -- Interfaces**: Define mechanical interface features on every Manufacture part (mounting holes, mating faces, shafts, etc.).
   - **Phase 3 -- Assembly Mappings**: Define how children connect within each assembly node.
3. After the initial LLM call completes, a **gap detection** pass runs. If it finds undecomposed assemblies, parts without interfaces, or assemblies without mappings, it triggers up to 3 **continuation passes** with targeted prompts.
4. After all passes complete, the BOM is validated (see [Validation](#bom-validation)).
5. The stage transitions to `bom_review`.

**BOM node structure** (each `BomNodeDraft`):

| Field                 | Type                       | Description                                      |
| --------------------- | -------------------------- | ------------------------------------------------ |
| `tempId`              | UUID                       | Temporary ID                                     |
| `name`                | string                     | Part/assembly name                               |
| `existingItemId`      | string?                    | PLM item ID if reusing an existing part          |
| `isNew`               | boolean                    | Whether this is a new part or reused             |
| `quantity`            | number                     | Quantity in parent assembly                      |
| `findNumber`          | number?                    | Position identifier within parent                |
| `children`            | BomNodeDraft[]             | Child nodes                                      |
| `requirementTempIds`  | string[]                   | Linked requirement tempIds                       |
| `partType`            | enum?                      | `Manufacture`, `Purchase`, `Software`, `Phantom` |
| `material`            | string?                    | Material specification                           |
| `rationale`           | string                     | Why this part exists                             |
| `confidence`          | number                     | 0--1 confidence score                            |
| `parametricSpec`      | ParametricPartSpec?        | Spec for instant parametric CAD generation       |
| `interfaces`          | InterfaceIntent[]?         | Mechanical interface definitions                 |
| `interfaceMappings`   | InterfaceMapping[]?        | How children connect (assemblies only)           |
| `cadGeneration`       | CadGenerationStatus?       | Per-node CAD generation status                   |
| `assemblyComposition` | AssemblyCompositionStatus? | Per-node assembly status                         |

### Stage 4: BOM Review

**Stage key**: `bom_review`

The user reviews the BOM tree in the left panel. The panel displays:

- An expandable tree view with quantity, part type badges, and interface indicators
- Validation issues (errors block confirmation, warnings are informational)
- A **Requirements Coverage** matrix showing which requirements are linked to which parts
- Badges indicating parametric specs and interface counts per node

When satisfied, the user clicks **Confirm BOM** to advance to materialization.

### Stage 5: Materialization

**Stage key**: `materialization`

This stage converts the draft BOM into real PLM data. It has two phases: preview and execution.

**Preview** (automatic on entering the stage): The `MaterializationService.preview()` method walks the BOM tree and counts:

- New parts to create
- Existing parts to reuse
- New requirements to create
- BOM relationships to establish
- Whether an ECO is required (based on branch protection)

The preview is shown in the `MaterializationPreview` component with summary cards and a scrollable item list.

**Execution** (on user confirmation): The `MaterializationService.execute()` method:

1. Creates or resolves the target Design
2. Checks branch protection and creates an ECO with workflow if needed
3. Creates Requirement items (mapping priority and type enums to PLM equivalents)
4. Creates Part items depth-first (leaves before parents) so BOM relationships can be established bottom-up
5. Creates BOM relationships between parent and child parts
6. Updates the session with the materialization result

The materialization result is persisted in `artifacts.materializationResult` and provides the `tempId -> itemId` mapping needed by subsequent CAD generation.

### Stage 6: CAD Generation

**Stage key**: `cad_generation`

Generates individual STEP files for each new Manufacture leaf part. Two generation paths are available:

**Parametric generation** (fast, ~1 second): Parts with a `parametricSpec` are dispatched to the CadQuery worker via RabbitMQ. Available shape templates:

| Template                | Required Parameters                                |
| ----------------------- | -------------------------------------------------- |
| `bushing`, `spacer`     | `od`, `id`, `length`                               |
| `tube`                  | `od`, `wall_thickness`, `length`                   |
| `plate`                 | `width`, `height`, `thickness`                     |
| `plate_with_holes`      | `width`, `height`, `thickness`, `hole_diameter`    |
| `block`                 | `width`, `depth`, `height`                         |
| `bracket_l`             | `leg1_length`, `leg2_length`, `width`, `thickness` |
| `bracket_u`             | `base_length`, `leg_height`, `width`, `thickness`  |
| `extrusion_rectangular` | `width`, `height`, `length`                        |
| `extrusion_circular`    | `diameter`, `length`                               |

**Zoo Text-to-CAD generation** (slow, ~10 minutes): Parts without a parametric spec are sent to Zoo's Text-to-CAD API. The prompt is built from:

- Part name, description, and material
- Interface definitions (mounting features, dimensions)
- Parent assembly context and sibling part information
- Overall product description

**Concurrency**: Parts are generated in parallel with a configurable concurrency limit (default 3, controlled by `ZOO_TEXT_TO_CAD_CONCURRENCY` env var).

**Flow**:

1. Walk the BOM tree to collect all new Manufacture leaf parts
2. For each part, dispatch to either parametric or Zoo generation
3. Upload resulting STEP files to the vault via `FileService`
4. Stream progress events (`[n/total] Part CAD generated/failed`)
5. Update `cadGeneration` status on each BOM node
6. Transition to `cad_review`

### Stage 7: CAD Review

**Stage key**: `cad_review`

The user reviews generated CAD files in the `CadReviewPanel`. For each part:

- A status icon shows success (checkmark), failure (alert), or pending
- A **generation method badge** distinguishes parametric vs AI-generated parts
- A **Regenerate** button allows re-generating with optional user feedback text

**Regeneration** invokes `regeneratePartCad()`, which:

1. Re-generates the STEP file (parametric via job, or Zoo with the feedback appended to the prompt)
2. Uploads the replacement file to the vault
3. Marks ancestor assemblies as **stale** via `cascade-recompose`, since the child geometry changed

When satisfied, the user clicks **Confirm CAD & Proceed to Assembly**.

### Stage 8: Assembly Composition

**Stage key**: `assembly_composition`

Composes assemblies bottom-up using LLM-planned transforms and KCL code generation.

**Processing order**: Assemblies are processed via post-order traversal (deepest sub-assemblies first, root last) computed by `computeAssemblyOrder()`.

**For each assembly node**:

1. **Readiness check**: All child Manufacture parts must have CAD complete; all child sub-assemblies must have composition complete.
2. **Composable geometry check**: Skip assemblies where no children have STEP files (e.g., all Purchase parts).
3. **Assembly planning**: The `AssemblyPlanner` sends the assembly node's children (with bounding boxes, interfaces, and interface mappings) to the LLM. The LLM produces:
   - A reasoning section explaining the strategy
   - Placement transforms (translation + rotation) for each child
   - KCL code that imports each child STEP file and applies transforms
4. **Plan validation**: `validateAssemblyPlan()` checks for collisions, out-of-bounds placements, and missing children.
5. **KCL project generation**: `generateKclProject()` produces a multi-file KCL project from the plan.
6. **Interface propagation**: `computeExposedInterfaces()` determines which child interfaces are not consumed by internal mappings and propagates them up for parent-level use.

### Stage 9: Assembly Review

**Stage key**: `assembly_review`

The user reviews the composed assemblies in the `AssemblyReviewPanel`. They can:

- View the assembly composition status for each node
- Trigger **recomposition** if changes are needed
- Click **Confirm Assembly** to complete the session

On confirmation, the session transitions to `complete` and its status is set to `completed`.

## BOM Drafting Tools

The BOM stage provides ten LLM-callable tools:

### Data retrieval tools

| Tool               | Purpose                                                |
| ------------------ | ------------------------------------------------------ |
| `search_parts`     | Search existing parts in PLM by query, type, and limit |
| `get_existing_bom` | Get the BOM structure of an existing part              |
| `get_item_details` | Get full details of a specific item                    |

### BOM construction tools

| Tool                       | Purpose                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `propose_new_part`         | Create a new part node with name, type, material, rationale, requirement links, and optional `parametricSpec`. Returns a `tempId`. |
| `add_existing_to_bom`      | Add an existing PLM item to the BOM tree. Returns a `tempId`.                                                                      |
| `set_bom_parent`           | Move/re-parent a node after creation                                                                                               |
| `link_requirement_to_part` | Link a requirement to a BOM node for coverage tracking                                                                             |

### Interface definition tools

| Tool                              | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `set_part_interfaces`             | Define mechanical interface features on a Manufacture part |
| `set_assembly_interface_mappings` | Define how children connect within an assembly             |

### Interaction tools

| Tool                    | Purpose                                                   |
| ----------------------- | --------------------------------------------------------- |
| `ask_bom_clarification` | Ask the user a clarification question (pauses the stream) |

**Key constraint for interface mappings**: `set_assembly_interface_mappings` can only reference **direct children** of the assembly node. Cross-assembly connections must be defined on the shared parent assembly. The tool validates this and returns an error with the child list if invalid references are provided.

## Session Persistence

### Database Schema

Design sessions are stored in the `design_sessions` table:

```
design_sessions
  id              UUID (PK, auto-generated)
  user_id         UUID (FK -> users, NOT NULL)
  ai_chat_session_id  UUID (FK -> ai_chat_sessions, nullable)
  program_id      UUID (FK -> programs, NOT NULL)
  design_id       UUID (FK -> designs, nullable)
  title           VARCHAR(255)
  stage           VARCHAR(50), default 'idle'
  status          VARCHAR(20), default 'active'
  description     TEXT
  artifacts       JSONB (DesignArtifacts)
  llm_history     JSONB (Array<LlmHistoryEntry>)
  created_at      TIMESTAMPTZ
  updated_at      TIMESTAMPTZ
  completed_at    TIMESTAMPTZ
  materialized_design_id  UUID (FK -> designs, nullable)
  error_message   TEXT
```

**Indexes**: `user_id`, `program_id`, `status`.

**Relations**: Links to `users`, `programs`, `designs`, and `ai_chat_sessions`.

### Artifacts JSONB Structure

The `artifacts` column stores all working data for the session as a single JSONB document:

```typescript
interface DesignArtifacts {
  description: string
  requirements: Array<RequirementDraft>
  bom: BomDraft | null
  clarifications: Array<ClarificationEntry>
  userMessages: Array<UserMessage>
  pendingClarificationId?: string
  materializationResult?: MaterializationResult
  cadGenerationState?: CadGenerationState
}
```

This design keeps all stage data in one place, avoids extra tables/joins, and allows the engine to resume from any point by reloading the session.

### Session Service

`DesignSessionService` provides CRUD operations:

- `create(userId, input)` -- Create a new session with initial artifacts
- `getById(id)` -- Fetch a session
- `updateArtifacts(id, artifacts)` -- Update the artifacts JSONB
- `updateStage(id, stage)` -- Transition to a new stage
- `updateStatus(id, status, errorMessage?)` -- Set session status
- `saveLlmHistory(id, history)` -- Persist LLM conversation history
- `getUserSessions(userId)` -- List all sessions for a user
- `getUserActiveSessionsForProgram(userId, programId)` -- Active sessions in a program
- `setMaterializedDesign(id, designId)` -- Mark session as materialized

### Session Statuses

| Status      | Meaning                              |
| ----------- | ------------------------------------ |
| `active`    | Session is in progress               |
| `paused`    | User paused the session              |
| `completed` | All stages finished and materialized |
| `failed`    | An error occurred                    |

### Session Stages

| Stage                   | Description                      |
| ----------------------- | -------------------------------- |
| `idle`                  | Session created, not yet started |
| `requirements_drafting` | LLM is generating requirements   |
| `requirements_review`   | User is reviewing requirements   |
| `bom_drafting`          | LLM is building the BOM          |
| `bom_review`            | User is reviewing the BOM        |
| `materialization`       | Preview/execute materialization  |
| `cad_generation`        | STEP files being generated       |
| `cad_review`            | User is reviewing generated CAD  |
| `assembly_composition`  | Assemblies being composed        |
| `assembly_review`       | User is reviewing assemblies     |
| `complete`              | Session finished                 |
| `error`                 | Terminal error state             |

## SSE Streaming

The design engine uses Server-Sent Events (SSE) for real-time streaming of stage execution to the client.

### Architecture

```
Client (useDesignEngineStream)
  |
  |-- POST /api/design-engine/sessions/:id/stream
  |     body: { action, questionId?, answer?, message?, tempId?, feedback? }
  |
  v
Server (stream.ts)
  |-- Validates action
  |-- Dispatches to engine method (runRequirementsStage, runBomStage, etc.)
  |-- Creates ReadableStream from AsyncGenerator<StageEvent>
  |-- Encodes as SSE: "event: stage_event\ndata: {...}\n\n"
  |-- Returns Response with Content-Type: text/event-stream
  |
  v
Client
  |-- Reads stream with ReadableStream reader
  |-- Parses SSE events from text buffer
  |-- Dispatches StageEvent to handleStageEvent reducer
  |-- Updates React state (artifacts, stage, events, errors)
```

### Stream Actions

| Action                       | Type          | Description                                      |
| ---------------------------- | ------------- | ------------------------------------------------ |
| `start_requirements`         | Streaming     | Start requirements drafting                      |
| `start_bom`                  | Streaming     | Start BOM drafting                               |
| `start_cad_generation`       | Streaming     | Start CAD file generation                        |
| `start_assembly_composition` | Streaming     | Start assembly composition                       |
| `regenerate_part`            | Streaming     | Regenerate a single part's CAD                   |
| `resume`                     | Streaming     | Resume whatever stage was in progress            |
| `answer_clarification`       | Streaming     | Answer a clarification question and resume       |
| `send_message`               | Streaming     | Send user guidance and resume drafting           |
| `confirm_requirements`       | Non-streaming | Advance from requirements_review to bom_drafting |
| `confirm_bom`                | Non-streaming | Advance from bom_review to materialization       |
| `confirm_cad`                | Non-streaming | Advance from cad_review to assembly_composition  |
| `confirm_assembly`           | Non-streaming | Advance from assembly_review to complete         |

### Stage Events

All events are typed as a discriminated union (`StageEvent`):

| Event Type             | Payload                              | Purpose                             |
| ---------------------- | ------------------------------------ | ----------------------------------- |
| `stage_change`         | `{ stage }`                          | Notify stage transition             |
| `artifact_update`      | `{ artifacts }`                      | Partial artifact update             |
| `llm_text`             | `{ text }`                           | Streamed LLM text output (delta)    |
| `tool_call`            | `{ toolName, args }`                 | LLM invoked a tool                  |
| `tool_result`          | `{ toolName, result }`               | Tool returned a result              |
| `clarification_needed` | `{ questionId, question, options? }` | LLM is asking the user a question   |
| `stage_complete`       | `{ stage, summary }`                 | Stage finished with summary message |
| `error`                | `{ message }`                        | Error occurred                      |
| `paused`               | `{ reason }`                         | Stream paused (awaiting user input) |
| `user_message`         | `{ id, text }`                       | User sent a message                 |

### Client Hook: `useDesignEngineStream`

The `useDesignEngineStream` hook manages the SSE connection lifecycle:

- Maintains React state: `events`, `isStreaming`, `currentStage`, `artifacts`, `error`
- Provides `sendAction(action, extra?)` to trigger streaming and non-streaming actions
- Provides `sendMessage(text)` for user guidance
- Provides `pause()` to abort the current stream
- Provides `initializeArtifacts(artifacts, stage)` to restore state from a loaded session
- Handles `AbortController` for stream cancellation on unmount or re-invocation

## Requirements Coverage Matrix

The requirements coverage matrix tracks which requirements are satisfied by which BOM parts. It is computed continuously during BOM drafting and displayed during BOM review.

**Data structure**:

```typescript
interface BomDraft {
  // ...
  requirementsCoverage: Record<string, Array<string>> // reqTempId -> [partTempIds]
  uncoveredRequirements: Array<string> // reqTempIds with no linked parts
}
```

The coverage map is rebuilt every time a BOM tool modifies the tree (via the `rebuildAndNotify()` callback). When the BOM is validated, uncovered requirements generate warning-level validation issues.

**UI**: The `RequirementsCoverage` component renders:

- A coverage ratio (`N of M requirements covered`)
- A progress bar (green when 100%, yellow otherwise)
- A list of uncovered requirement names

## Materialization Preview

Before committing changes to the database, the materialization stage shows a preview of what will be created. The `MaterializationPreview` component displays:

- **Summary cards**: New parts count, reused parts count, requirements count, BOM relationships count
- **ECO notice**: If the target design has released items, an ECO will be auto-created (shown with a branch icon and explanation)
- **Items list**: Scrollable list of all items to be created, each with name, type badge, and NEW/existing item number badge
- **Two-step confirmation**: "Review & Materialize" button reveals a detailed warning and "Confirm & Create" / "Cancel" buttons

After execution, the `MaterializationResult` component shows what was created with links to navigate to the design and ECO.

## Interface Definitions

Interfaces are the bridge between BOM structure and CAD assembly. They describe physical connection features that parts use to mate with each other.

### InterfaceIntent (per-part)

Defined on Manufacture parts via `set_part_interfaces`:

```typescript
interface InterfaceIntent {
  id: string // Unique within the part
  description: string // "4x M4 mounting holes on bottom face"
  mateType:
    | 'coaxial'
    | 'coincident'
    | 'concentric'
    | 'insert'
    | 'parallel_offset'
    | 'tangent'
    | 'fixed_offset'
  geometry: {
    shape: 'circular' | 'rectangular' | 'linear' | 'planar' | 'cylindrical'
    nominalDimensions: Record<string, number> // { diameter: 6, depth: 12 }
    units: 'mm' | 'in'
    count?: number
    patternType?: 'linear' | 'circular' | 'rectangular_grid'
    patternSpacing?: number
  }
  locationHint: string // "bottom face", "left side"
}
```

### InterfaceMapping (per-assembly)

Defined on assembly nodes via `set_assembly_interface_mappings`:

```typescript
interface InterfaceMapping {
  id: string // Unique within the assembly
  partATempId: string // First child part
  interfaceAId: string // Interface on part A
  partBTempId: string // Second child part
  interfaceBId: string // Interface on part B
  mateType: string // How they connect
  positioningIntent: string // LLM's natural-language description
}
```

### Interface Propagation

When a sub-assembly is composed, interfaces consumed by internal mappings are marked as used. Remaining "exposed" interfaces are propagated up for the parent assembly to use. This is computed by `computeExposedInterfaces()` in `src/lib/cad-generation/interface-propagation.ts`.

### Cascade Recomposition

When a part's CAD is regenerated, all ancestor assemblies become stale and need recomposition. `findAffectedAssemblies()` walks up from the changed part, and `markAssembliesStale()` resets their composition status.

## BOM Validation

The `validateBomDraft()` function runs after BOM drafting completes and checks for:

**Errors (block confirmation)**:

- Root assembly has no name
- Circular references in the tree
- Quantity <= 0 on any node
- New parts with no name
- Parametric spec parameters that are not positive numbers
- Interface dimensions that are not positive numbers
- Interface mappings referencing non-children

**Warnings (informational)**:

- Duplicate find numbers within a parent
- Phantom nodes with no children (incomplete decomposition)
- Manufacture parts with no interfaces or parametric spec
- Interface mappings referencing interface IDs not found on the part
- Children with no interface mappings in an assembly
- Uncovered requirements

## UI Workspace

### Route

`/designs/collaborative/$sessionId` -- Full-page workspace loaded via the route at `src/routes/designs/collaborative/$sessionId.tsx`. The route loader fetches the session from the API and passes it to `CollaborativeWorkspace`.

### Layout

The workspace is a full-height two-panel layout:

```
+-------------------------------------------------------+
| [icon] Session Title    [Stage Indicator]  [Pause] [X] |
+---------------------------+---------------------------+
|                           |                           |
|   Left Panel:             |   Right Panel:            |
|   Artifacts               |   Activity Feed           |
|                           |                           |
|   - Description (edit)    |   - Start button          |
|   - Requirements list     |   - LLM text stream       |
|   - BOM tree              |   - Tool call/results      |
|   - Materialization       |   - Clarification Q&A      |
|   - CAD review            |   - User messages          |
|   - Assembly review       |   - Error display          |
|                           |                           |
+---------------------------+---------------------------+
```

**Column ratio**: 3:2 (left panel wider for artifact display).

### Stage Indicator

The `StageIndicator` component renders a horizontal stepper with five stages: Requirements, BOM, Materialize, CAD, Assembly. Each stage shows:

- Completed (cyan checkmark) if the current stage index is past it
- Active (cyan ring + dot) if the current stage falls within it
- Pending (gray) otherwise

Connecting lines between stages are cyan (completed) or gray (pending).

### Components by Stage

| Stage                   | Left Panel Component                                | Right Panel                         |
| ----------------------- | --------------------------------------------------- | ----------------------------------- |
| `idle`                  | `ArtifactPanel` (description only)                  | Start Requirements button           |
| `requirements_drafting` | `ArtifactPanel` (requirements appearing)            | ActivityFeed with LLM stream        |
| `requirements_review`   | `ArtifactPanel` (editable requirements)             | ActivityFeed                        |
| `bom_drafting`          | `ArtifactPanel` (BOM tree building)                 | ActivityFeed with LLM stream        |
| `bom_review`            | `ArtifactPanel` (BOM tree + coverage + confirm)     | ActivityFeed                        |
| `materialization`       | `MaterializationPreview` or `MaterializationResult` | ActivityFeed                        |
| `cad_generation`        | `CadGenerationPanel` (progress)                     | ActivityFeed with generation stream |
| `cad_review`            | `CadReviewPanel` (per-part review + regenerate)     | ActivityFeed                        |
| `assembly_composition`  | `AssemblyPanel` (progress)                          | ActivityFeed                        |
| `assembly_review`       | `AssemblyReviewPanel` (confirm)                     | ActivityFeed                        |

## API Endpoints

### Session Management

| Method  | Endpoint                          | Description                             |
| ------- | --------------------------------- | --------------------------------------- |
| `GET`   | `/api/design-engine/sessions`     | List current user's sessions            |
| `POST`  | `/api/design-engine/sessions`     | Create a new session                    |
| `GET`   | `/api/design-engine/sessions/:id` | Get session by ID                       |
| `PATCH` | `/api/design-engine/sessions/:id` | Update description, artifacts, or stage |

**POST body** for creating a session:

```json
{
  "description": "A portable widget for...",
  "programId": "uuid",
  "designId": "uuid (optional)",
  "aiChatSessionId": "uuid (optional)"
}
```

### Streaming

| Method | Endpoint                                 | Description                        |
| ------ | ---------------------------------------- | ---------------------------------- |
| `POST` | `/api/design-engine/sessions/:id/stream` | Send action and receive SSE stream |

### Materialization

| Method | Endpoint                                      | Description             |
| ------ | --------------------------------------------- | ----------------------- |
| `GET`  | `/api/design-engine/sessions/:id/materialize` | Generate preview        |
| `POST` | `/api/design-engine/sessions/:id/materialize` | Execute materialization |

All endpoints require authentication. Session access is restricted to the owning user.

## Source File Map

| Area                  | Path                                                       |
| --------------------- | ---------------------------------------------------------- |
| Engine orchestrator   | `src/lib/design-engine/engine.ts`                          |
| Type definitions      | `src/lib/design-engine/types.ts`                           |
| Session service       | `src/lib/design-engine/session-service.ts`                 |
| Materialization       | `src/lib/design-engine/materialize.ts`                     |
| Requirements stage    | `src/lib/design-engine/stages/requirements.ts`             |
| BOM stage             | `src/lib/design-engine/stages/bom.ts`                      |
| CAD generation stage  | `src/lib/design-engine/stages/cad-generation.ts`           |
| Assembly stage        | `src/lib/design-engine/stages/assembly-composition.ts`     |
| Requirements tools    | `src/lib/design-engine/tools/requirements-tools.ts`        |
| BOM tools             | `src/lib/design-engine/tools/bom-tools.ts`                 |
| Requirements prompt   | `src/lib/design-engine/prompts/requirements-prompt.ts`     |
| BOM prompt            | `src/lib/design-engine/prompts/bom-prompt.ts`              |
| BOM validator         | `src/lib/design-engine/validation/bom-validator.ts`        |
| DB schema             | `src/lib/db/schema/design-engine.ts`                       |
| Part generator        | `src/lib/cad-generation/part-generator.ts`                 |
| Assembly planner      | `src/lib/cad-generation/assembly-planner.ts`               |
| KCL generator         | `src/lib/cad-generation/kcl-generator.ts`                  |
| Assembly order        | `src/lib/cad-generation/assembly-order.ts`                 |
| Interface propagation | `src/lib/cad-generation/interface-propagation.ts`          |
| Cascade recompose     | `src/lib/cad-generation/cascade-recompose.ts`              |
| Zoo client            | `src/lib/cad-generation/zoo-client.ts`                     |
| SSE hook              | `src/hooks/useDesignEngineStream.ts`                       |
| Workspace component   | `src/components/design-engine/CollaborativeWorkspace.tsx`  |
| Workspace route       | `src/routes/designs/collaborative/$sessionId.tsx`          |
| Stream API            | `src/routes/api/design-engine/sessions/$id/stream.ts`      |
| Session API           | `src/routes/api/design-engine/sessions.ts`                 |
| Materialize API       | `src/routes/api/design-engine/sessions/$id/materialize.ts` |

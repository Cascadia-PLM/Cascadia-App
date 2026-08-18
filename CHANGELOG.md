# Changelog

All notable changes to Cascadia PLM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

#### Physical Traceability

Identity and genealogy for real material, without crossing into quantity or value —
no inventory balances, no costing. See
[docs/features/physical-parts-and-traceability.md](./docs/features/physical-parts-and-traceability.md).

- **PhysicalPart item type** — A physical instance of a Part: a serialized **unit** or an identified **lot**. Non-versioned (Tool pattern). It accumulates documents in the vault (material certs, test reports, CoCs), carries requirement evidence, and anchors genealogy. Numbered `PP-000001` as a stable handle; the display identity is the serial or lot number, unique per part lineage
- **Work Orders promoted to an item type** — Previously a standalone table. As items they hold vault attachments and participate in `item_relationships`, and keep the same `WO-000001` numbering so migrated and new numbers are indistinguishable
- **Consumption, production, and evidence as edges** — `Consumes`, `Produces`, and `Evidences` records in `item_relationships`, with the work order or physical part always the edge source. Consumption pins quantity to the consumed revision
- **Derived genealogy** — Never stored. `GenealogyService` walks the edges on demand, so it cannot drift from the records it summarizes. Forward (`/:id/genealogy`) and reverse (`/physical-parts/recall`) traversal
- **Qualification rollup** — `GET /api/v1/work-orders/:id/qualification` answers "were these requirements satisfied?" for a build: requirements in scope via `Satisfies` edges from the built part and every consumed material's lineage, satisfied where an `Evidences` edge matches, plus a gap list of consumed instances carrying neither evidence nor documents
- **Approved Manufacturer List** — `manufacturer_parts` and `part_manufacturer_parts`, bound to the part `masterId` so the AML survives revisions. Replaces the unwired COTS tables
- **Part `trackingMode`** — `none`, `lot`, or `serial`, the policy that decides whether a part's instances are tracked and how

#### Work Instruction Traveler

- **Work instructions are templates, never executed directly.** A work order instantiates them as traveler lines (`work_order_instructions`), each a frozen content snapshot with a `requiredCount` of runs; executions (`instruction_executions`) record runs of lines, and sign-offs ride executions. Line status is derived from countable runs, work-order completion is gated on the traveler, and skip-with-reason is the audited escape hatch. Snapshots freeze permanently once a line has executions

#### Software Management

Firmware and software configuration items versioned alongside the hardware they
ship with. See [docs/features/software-management.md](./docs/features/software-management.md).

- **Software item type** — `softwareType` (firmware, application, library, configuration, fpga), target hardware, toolchain, and a build-artifact slot in the vault. Shares the Part lifecycle, so it is ECO-controlled like any other released engineering item
- **Content-addressed source store** — `software_blobs` plus immutable `software_manifests`. The `manifestId` pointer rides the item version, so branch isolation and time travel work with no special cases
- **Checkout-gated editing** — Edits accumulate in `draftManifestId` and are promoted by an explicit commit, which records per-file `source`-category field changes. Drafts are never copied to new versions and never appear in field history
- **Per-file conflict granularity** — `ConflictDetectionService` sharpens software manifest conflicts from "the manifest changed" to the specific files that diverged

#### Optional Package Framework

- **Package framework** — The mechanism by which separately-licensed functionality is gated, via the `CASCADIA_PACKAGES` environment variable, read once at process start. `PackageRegistry` answers entitlement, `requirePackage()` gates server-side with a 403, and `/admin` lists holdings read-only. There is deliberately no in-app toggle. The framework ships in this edition; the packages that plug into it are licensed separately. See [docs/development/adding-packages.md](./docs/development/adding-packages.md)

### Changed

- **This repository is now generated.** Both editions are built from a single upstream tree in which this AGPL edition is one package, and publishing copies that package here. Contributions are still made by pull request against this repository — see [CONTRIBUTING.md](./CONTRIBUTING.md) for how an accepted pull request reaches `main`
- **Requirements are versionable and ECO-actionable.** The minimal seed now creates `Requirement - Default Lifecycle` (Driven, same Draft → Released → Superseded/Obsolete shape as Part/Document, driven by both ECO workflows) and a Requirement item-type config. Requirements on Designs can be added to change orders, checked out to ECO branches, and receive revision letters at merge — previously the release/revise/obsolete actions were rejected because no lifecycle row existed. The deprecated code-defined fallback states now mirror the shared Driven set instead of advertising a manual Proposed/Approved flow
- **ECO state change has one mechanism.** `executeWorkflowTransition()` is the single entry point; `ChangeOrderService.approve()`/`reject()` and the AI transition tool no longer bypass the close() orchestration, which had left ECOs stranded. `definitionType` is retired in favour of `lifecycleType`
- **The item-state lifecycle is enforced server-side**, not merely presented in the UI. The drivers allow-list is enforced, and lifecycle-editor saves now persist `lifecycleType`, `drivers`, `changeActionMappings`, `revisionScheme`, and `phases` — the routes had been dropping all of them
- **Backward transitions supersede approval votes rather than deleting them.** A transition is backward when its target can reach its source through the effective structure; votes on the target and everything reachable from it are marked `supersededAt` after the CAS write wins. Deleting them would contradict the append-only approval record
- **Approval requirements are real on flexible instances** — `{ requiredCount }` enforced as distinct active approved votes at the source state, composing with named approvers
- New error code: `PACKAGE_NOT_LICENSED` (403), raised when a request needs a package this instance does not have
- **`db:generate` writes migration SQL into the app's own `drizzle/` directory**
  (`apps/cascadia/drizzle`) instead of the repository root, keeping the generated
  baseline next to the composed schema (`modules.schema.ts`) that produced it

### Removed

- **Collaborative Design Engine** — The multi-stage AI design workflow (toolset
  establishment, requirements drafting, BOM drafting, materialization, and their
  review gates), its `design_sessions` / `design_session_snapshots` tables, the
  `/api/v1/design-engine/*` endpoints, and the `/designs/collaborative` workspace
  have been removed from the AGPL distribution. Per
  [LICENSING.md](./LICENSING.md), the Design Engine is now a commercial-edition
  capability. Previously published AGPL versions remain available under the AGPL
  in this repository's history.
- **Generative CAD** — Zoo Text-to-CAD generation, KCL-based assembly
  composition, the CadQuery parametric/mechanism generator worker
  (`workers/cad-generator/`), the associated job types
  (`generation.cad.zoo`, `generation.cad.parametric`, `generation.cad.mechanism`,
  `generation.cad.assemble`), the part "Generate CAD" dialog, and the
  `/api/v1/admin/cad-settings` provider configuration. The `ZOO_API_KEY`
  environment variable is no longer read.
- **`initiate_collaborative_design` AI tool** — Removed from the chatbot's tool
  set and system prompt.

- **Committed drizzle migrations.** Pre-1.0, every environment — dev, CI, and
  compose — is `db:push` + seeds, so the migration files had no consumer.
  `db:generate` mints the `0000` baseline at the first release; until then it is
  unused
- **Dead workflow knobs** — stored `transition_driven_item` actions,
  `lifecycleEffects`, the panel's TDI editor, and `validateLifecycleTransition`,
  none of which the engine enforced

CAD **conversion** is unaffected: `workers/cad-converter/` (STEP/IGES → STL/GLB),
the `conversion.cad.step-to-stl` job, `POST /api/v1/files/:fileId/convert`, and
the in-browser 3D viewer all remain. The bring-your-own-API-key AI chatbot and
its read/write PLM tools also remain.

### Fixed

- **An item's design can no longer be cleared or reassigned through update.**
  `ItemService.update()` wrote `designId` straight through whenever the key was
  present, so a request carrying `"designId": null` detached the item from its
  design while its branch rows, commits and BOM structure stayed behind, and
  reassigning it landed the item in a design whose branches had never tracked
  it. Both now raise `VALIDATION_FAILED` (400). The guard lives in the service,
  so the type-specific update routes, the batch update, the AI update tool and
  the import paths share it. An echoed unchanged value is still accepted —
  whole-object form saves send one — and assigning a design to an item that has
  none is still allowed, being the one direction that adds history rather than
  orphaning it

### Security

- **An unset `ENCRYPTION_KEY` stores provider API keys as plaintext, and now
  says so.** AI provider keys entered in the admin UI are encrypted with
  AES-256-GCM only when `ENCRYPTION_KEY` is set. Without it they are written to
  the database in the clear, and nothing surfaced that: a working integration
  looks identical either way. The storage behaviour is unchanged; what changed
  is that the plaintext path now logs a warning naming the provider (never the
  key), and the variable is documented in SECURITY.md, both compose files, and
  the env examples. Keys saved before `ENCRYPTION_KEY` was configured stay
  plaintext — re-save them once it is set

## [0.1.0] - 2026-04-13

Initial open-source release under AGPL v3.

### Added

#### Core PLM

- **10 Item Types** — Part, Document, ChangeOrder, Requirement, Task, WorkInstruction, Issue, TestPlan, TestCase, Tool with unified two-table architecture and full CRUD via ItemService
- **BOM Management** — Hierarchical bill of materials with quantities, find numbers, reference designators, where-used queries, multi-level expansion, and cross-design references
- **File Vault** — Enterprise document control with check-in/check-out, versioning, branch-aware storage, and pluggable backends (local filesystem or S3-compatible)
- **Work Instructions** — Rich step-by-step manufacturing instructions with operations, parametric blocks, image blocks, data field capture, part attachments, change alerts, and execution tracking with sign-off
- **Import/Export** — Excel (.xlsx/.xls) and CSV import with column auto-mapping, BOM hierarchy parsing, validation preview, and bulk creation
- **Enterprise Search** — Full-text search across all item types with type-specific filtering, state filtering, and pagination
- **Reporting Engine** — JSON-based report definitions with execution, preview, and CSV export

#### Change Management

- **ECO-as-Branch** — Git-style branching for engineering changes: create ECO, checkout items to isolated branch, make changes, approve and merge to main with automatic revision letter assignment
- **Change Actions** — Release, Revise, Obsolete, Add to BOM, Remove from BOM, Promote
- **Conflict Detection** — Identifies when multiple ECOs modify the same items
- **Impact Assessment** — Recursive where-used traversal, cross-design impact, definition-usage chains

#### Versioning

- **Git-Style** — Branches, commits, tags, merge commits, master/instance pattern, and design history graphs
- **Branch Isolation** — Checkout/checkin workflow with changes invisible until merged
- **Revision Letters** — A, B, C... assigned only on ECO release, not during work
- **Change History** — Per-item edit history with field-level diffs and relationship change tracking

#### Workflow Engine

- **Lifecycle Management** — Configurable states, transitions, phases, revision schemes, and per-phase revision reset
- **Approval Workflows** — Multi-approver voting, comments on transitions, auto-start on ECO creation
- **Default Workflows** — Part lifecycle, Document lifecycle, ECO workflow included

#### Organization

- **Program & Design Hierarchy** — Organizations, programs (permission boundaries), designs (version containers), design families, clone support
- **Cross-Design References** — Read-only links to items in other designs with branch tracking

#### Security & Auth

- **Authentication** — Email/password with session management, account lockout, GitHub OAuth
- **RBAC** — Role-based access control with program-level isolation (Administrator, Engineer, Viewer)
- **Security Hardening** — CSRF protection, CORS configuration, security headers, input validation, file upload hardening
- **Encryption** — Optional encryption at rest for sensitive data (API keys)

#### Collaborative Design Engine

- **Multi-Stage Workflow** — Requirements drafting, requirements review, BOM drafting, BOM review, materialization, CAD generation, CAD review, assembly composition, assembly review
- **AI-Assisted BOM Drafting** — LLM tool-calling with part search, reuse detection, requirement mapping
- **Materialization** — Creates actual PLM items, relationships, and ECO from draft artifacts
- **SSE Streaming** — Real-time stage updates via server-sent events

#### CAD Integration

- **3D Viewer** — In-browser STL/OBJ/GLB rendering with orbit controls, wireframe mode, material presets, and standard views
- **CAD Conversion** — Python microservice (pythonocc-core) for STEP/IGES to STL/GLB with per-face color preservation
- **CAD Generation** — Text-to-CAD via Zoo API with KCL-based assembly composition (optional, requires API key)

#### AI Assistant (Optional)

- **Chat Panel** — LLM-powered chatbot with read/write PLM tools, confirmation flows, session persistence
- **Provider Support** — Anthropic (Claude) and OpenAI (GPT) via TanStack AI adapters
- **Admin Settings** — Configure provider, model, and API keys through the UI

#### API & Integration

- **REST API** — Comprehensive endpoints for all item types, relationships, files, workflows, search, reports, batch operations, and administration
- **OpenAPI Specification** — Full API documentation
- **SysML v2 API** — Standards-based interoperability with projects, branches, commits, and elements endpoints
- **Batch Operations** — Bulk create/update/delete items and relationships with per-item error handling

#### Background Jobs

- **RabbitMQ Integration** — Job type registry, priority levels, retry logic with exponential backoff, dead letter queue, progress tracking, cancellation
- **Job Types** — CAD file conversion, design clone, work instruction change alerts
- **Admin Dashboard** — Job list, detail view, cancel, retry

#### Deployment

- **Docker Support** — Multi-stage Dockerfiles for app, vault, jobs worker, CAD converter, and CAD generator
- **Docker Compose** — Development and production configurations
- **Deployment Guides** — Single-server, distributed, cloud database, and Kubernetes documentation
- **Health Check** — `/api/v1/health` endpoint for load balancer integration

#### Testing

- **Unit/Integration Tests** — Vitest with test database helper and test data builder
- **E2E Tests** — Playwright with page object model pattern
- **CI/CD** — GitHub Actions workflows for lint, unit tests, E2E tests, and builds

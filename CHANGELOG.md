# Changelog

All notable changes to Cascadia PLM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Nothing yet.

## [0.5.0] - 2026-08-25

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

#### Release Readiness

- **Migration baselines and a real upgrade path** — the edition ships its `0000` baseline under `apps/cascadia/drizzle/`. The new `npm run db:baseline` stamps a pre-0.5, push-created database — after verifying its schema actually matches — so `npm run db:migrate` takes over from there; running it on a database that is not at the baseline refuses loudly. CI gains a drift gate: a schema change cannot land without its committed migration. See [docs/deployment/upgrading.md](./docs/deployment/upgrading.md)
- **The running version is identifiable** — `GET /api/v1/health` reports it, the admin page shows it on a System card, and images carry `org.opencontainers.image.version`/`.revision` labels from build args. Previously the version existed only in package.json, making a deployed instance impossible to identify from outside
- **XLSX import templates** — `format=xlsx` on the parts/documents/issues template endpoints returns a real workbook; an unrecognized format is a 400 instead of a silent CSV fallback

#### File Preview

- **SVG drawings preview in the app** — The vault has always accepted `.svg` uploads but refused to render them, because an SVG is a scripting host and preview bytes are served from the app's own origin. SVG is now its own `PreviewKind` with a zoom/rotate/pan/fullscreen viewer, and three properties hold that boundary together, all of which have to be true at once: the server labels the bytes `text/plain` rather than `image/svg+xml`, so a browser reaching the endpoint directly renders source; the viewer draws through an `<img>`, which the SVG spec puts in secure static mode; and the `<img>` source is a `data:` URL rather than an object URL, which would carry the app's origin into a new tab. Nothing is sanitized and nothing needs to be — a hostile drawing's `<script>` and its external `<image href>` both survive in the source and neither executes nor fetches. Thumbnails and the gallery still refuse SVG outright
- **Per-format preview ceilings** — `PreviewFormat` gains an optional `maxBytes`. SVG caps at 8 MB against the global 50 MB, because the data URL roughly doubles the source and has to be built as a single JavaScript string, so past that point the viewer rather than the transfer is what gives out

#### User Management

- **Password change from the profile page** — A signed-in user with a local account can change their own password (`PUT /api/v1/auth/password`). The current password is verified first, the request is rate-limited like a login attempt, and API-key callers are refused outright — a key must not be able to replace the interactive credential of its owner. Every other session is signed out in the same transaction as the change, keeping only the one that made it, and a `password_changed` auth event is recorded. Contributed by [Artur Klujewski](https://github.com/Kujoo25) in [Cascadia-App#71](https://github.com/Cascadia-PLM/Cascadia-App/pull/71)

### Changed

- **`docker-compose.yml` no longer exposes infrastructure by default.** Postgres, RabbitMQ (AMQP and management UI), and pgAdmin bind to `127.0.0.1` — override per service via `POSTGRES_BIND`/`RABBITMQ_BIND`/`PGADMIN_BIND` to expose deliberately. `POSTGRES_PASSWORD` and `PGADMIN_PASSWORD` lost their compose defaults entirely: the stack refuses to start without them. **Upgrading operators must set both in `.env`** — see `.env.docker.example`
- **v1 API semantics are written down before the freeze.** PUT-with-partial-semantics (no PATCH in v1), listing through `/api/v1/items` rather than per-type roots, and snapshot-authoritative per-endpoint pagination defaults — see "v1 semantics worth knowing" in [docs/api/README.md](./docs/api/README.md). `/api/v1/files` and `/api/v1/workflows` now validate `limit`/`offset` instead of `parseInt`-ing them into NaN; their defaults are unchanged
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
- **The shipped lifecycles are defined in one place.** `default-lifecycles.ts` now carries both change-order workflows in their shipped shape, the state/transition/definition descriptions the lifecycle editor shows, and computed editor positions for every definition, so a fresh database opens with every default already laid out. `seed-minimal.ts` calls the module and keeps only what is genuinely policy — the Driven defaults' `drivers` allow-list, now applied only where nothing has chosen yet, so an admin's own list survives a re-seed

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

- **BOM line quantities are editable, defaulted, and honest on branches.** Four related defects, found in release testing: the add dialog showed "1" as a placeholder but submitted nothing, so untouched BOM lines were created with a null quantity (lines now start at a real 1 and require a positive decimal — the column is numeric(10,3)); quantities could not be edited at all afterward (a new edit dialog drives `PUT /api/v1/relationships/:id`); in a branch context the relationship read returned the union of the working copy's and main's edges, so a line deleted on the ECO branch reappeared as main's row — deleting that one tripped `BRANCH_PROTECTED`, and with a quantity set the failure looked like it had merely cleared the quantity (the read now follows the merge's authority rule: the working copy's edges are the structure); and the confirm dialog dismissed the very error alert a failing action had just opened, so rejections now stay visible and carry the server's reason
- **Every version row carries its BOM edges.** Working copies minted by a field-only first save or a rebase carried no relationship rows and leaned on a zero-edge fallback to main — which made an intentionally emptied structure indistinguishable from an unpopulated copy: deleting the last BOM line resurfaced it read-only, and releasing re-shipped it. Every copy path now carries relationships the way it already carried files, the fallback is gone, and no edges means no edges: an emptied structure reads and releases as empty

- **The password dialogs always failed.** `PUT /users/:id/password` requires the current password, but both UI callers sent only the new one, so every attempt was a 400 — including the change README and SECURITY.md instruct operators to make to the default admin credential. Admin password-setting now goes through `reset-password` (the operation that never needs the target's current password), self-service goes through the new `/api/v1/auth/password`, and `docs/deployment/single-server.md` no longer claims the default password is `admin` (the seed creates `Cascadia`)
- **The E2E lifecycle suite can no longer pass by vacancy.** Eight lifecycle tests skipped themselves when no design was seeded, so a seeding regression produced a green suite that had tested nothing. Global setup now guarantees a selectable design and the specs assert it
- **`analyze_change_impact` failed on every item it was asked about**, over
  both the in-app chatbot and the MCP server. The tool includes related change
  orders by default, and having no current ECO to exclude it passed `''` as
  one; `findRelatedChanges` renders that argument into a uuid comparison, so
  Postgres rejected the whole statement (`22P02`) rather than matching nothing.
  Only `includeRelatedChanges: false` ever returned an answer.
  `currentChangeOrderId` is now optional and the `!=` predicate is dropped when
  it is absent — which is what "no current change order" should have meant all
  along: every open ECO touching the item

- **The dev MCP server's docs and database tools resolve against the repository
  root again.** `REPO_ROOT` counted `..` segments up from
  `lib/mcp/dev-tools.ts`, which reached the repository root before the
  `packages/core` move and `packages/core` after it. The failure was silent:
  `search_docs` reported `filesSearched: 0` for every query, `read_doc`
  returned ENOENT for every path, and the `db_*` tools would have run their
  npm scripts from a directory holding no `scripts/`. The root is now found by
  walking up to the manifest declaring `workspaces`, which identifies it by
  what it is rather than by how deep the file sits. The corrected root also
  exposed `db_push` running bare `npx drizzle-kit push`, which fails on a
  missing config because drizzle-kit must be launched from the edition's app
  directory — it goes through `npm run db:push` like every other database
  tool. Separately, `instance_status` read `process.env` before anything
  imported dotenv, so it reported `DATABASE_URL` unset in the same response as
  a successful database connection; the entry point now loads the root `.env`
  first, resolved from the repository root rather than the working directory
  an MCP client happens to choose

- **The AI and MCP write tools no longer advertise field values the server
  rejects.** `create_item`'s `requirementType` enum offered `Interface`,
  `Constraint` and `Other` — none of which the Requirement item type accepts —
  while hiding four it does (`Non-Functional`, `Security`, `Usability`,
  `Business`). The handler copies the value straight into the item, so a
  request for any of the three failed validation inside `ItemService` and
  surfaced as a bare `Validation failed` carrying no field name and no
  accepted values, which an agent cannot self-correct from. Every enum in the
  write tools is now the Zod enum exported by the item type that validates the
  write — the derivation `itemType` already used — which also caught task
  `priority` (advertised lowercase against a capitalized enum, so every value
  was rejected by `create_item` and written unvalidated by `update_item`) and
  `changeType` (missing `XCO`, which the UI has always offered). A failed
  write now names the offending field instead of reporting a bare
  `Validation failed`

- **`@xyflow/react` pinned to `12.11.2`.** `12.11.4` imports
  `handleAttributionWarning` from `@xyflow/system`, which its own pinned
  `@xyflow/system@0.0.80` does not export, so a fresh install resolving the
  previous `^12.9.3` range could not build the client bundle

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
- **The requirement derive hierarchy follows revisions.** `parent_requirement_id` names one version row of the parent — whichever was current when the child was derived — and nothing ever re-points it, so once a parent had been revised through a change order both directions inverted: the current parent row returned no children at all, the row it superseded returned every historical row of every child, and a current, Released child reported a superseded, Draft parent. Both reads now resolve through shared lineage primitives in `lib/items/version-lineage.ts`, so the relationship edge table and this pointer column answer to one rule rather than two. Derived numbering also takes the highest `-D<n>` already used rather than the count, which was only ever right while nothing had left the tree
- **Item links resolve through the route map instead of naive pluralization.** Twelve components built item URLs by appending "s" to the lowercased item type, which is wrong for 7 of the 13 types — Software linked to `/softwares` while the route is `/software`, and change orders, test plans, test cases, work instructions, work orders and physical parts all 404'd the same way. Each carried its own partial copy of the map and invented a different fallback for the types it did not cover: either a route that does not exist, or a parts page rendered against a foreign id, which loads and is therefore harder to notice than a 404. A new `ItemLink` component now carries the "link when routable, plain text otherwise" policy, and the few non-link sites drop their View entry when there is no route. An item type added without a detail page renders unlinked rather than pointing at a parts page
- **The 3D viewer no longer fetches its environment map from a third-party CDN.** It rendered a drei `<Environment preset>`, which resolves the preset name to an HDR hosted on a public CDN and fetches 1–2 MB at runtime — in an app expected to run air-gapped. The failure also outlived itself: `useLoader` memoizes a rejection exactly as permanently as a result, so one unreachable fetch made every later mount of the viewer re-throw during render, past `<Suspense>` — which catches suspension, not errors — and into the root error boundary, replacing a part's Details page with "Something went wrong" until a full reload. The environment is now a local rig of `<Lightformer>` panels, which renders a cube map in place and leaves no fetch path to fail, and the canvas has its own error boundary so a scene that cannot draw costs the preview rather than the page
- **A failed file preview reports the error instead of a literal "[object Object]".** The error body was read as `{ error, details }` when the envelope is `{ error: { code, message } }`, and the `details` it surfaced is the internal vault path on a storage miss
- **Re-seeding no longer downgrades an already-upgraded lifecycle.** `seed-minimal.ts` hand-wrote most of the shipped lifecycles at version 1 with unconditional upserts and only then called the module. A fresh reset came out right, because the module's newer rows won afterwards, but a plain re-seed over an existing database handed an already-upgraded row its old shape while leaving the version number in place — after which the module's upgrade-only gate refused to repair it
- **A lookup by item number no longer answers from an arbitrary design.**
  `ItemService.findByNumber` was an unordered `LIMIT 1` with no design scope,
  and item numbers are not unique — creating an MBOM copies an engineering
  design's items into a Manufacturing design keeping their numbers, and a usage
  repeats its definition's number in every design that uses it. Which row came
  back was whatever the query planner reached first, in practice the
  manufacturing copy: `get_item_details {"itemNumber": "USV-1900"}` returned the
  empty revision `-` Draft shadow instead of rev B Released, so an assistant
  asked what was in the harness answered "nothing", with nothing in the response
  to suggest it had been handed the wrong row. Matching rows are now put in a
  total order — engineering before library before manufacturing, then released
  lineage before drafts, then newest, then id — so the same database always
  yields the same item; release state is asked of `LifecycleService` rather than
  compared against a literal. `findByNumber` and `get_item_details` take an
  optional `designId` (a UUID or design code, as `search_items` already
  accepts), and where a number is still ambiguous the runners-up come back as
  `otherMatches`, each named by its design, so an assistant can ask which design
  was meant instead of guessing silently. Every `get_item_details` response now
  also carries the design's code, name and type

- **Password reset from the admin user pages works.** The reset dialog posted
  to the verified-change endpoint, which demands the account's current
  password; the dialog never collected one, so every attempt was rejected as
  invalid credentials and an administrator could not reset any password at all.
  Reset is now its own endpoint — `POST /api/v1/users/:id/reset-password`,
  gated on `users:manage` and rate-limited like a login — the dialog calls it,
  every session of the target account is revoked, and a `password_reset` auth
  event records the acting administrator. Contributed by
  [Artur Klujewski](https://github.com/Kujoo25) in
  [Cascadia-App#71](https://github.com/Cascadia-PLM/Cascadia-App/pull/71)
- **Deleting a user no longer fails once the account has any history.**
  `deleteUser` removed the role links, then the user row — and every other
  reference, including the auth events written by simply logging in, raised a
  foreign-key violation that surfaced as an unhandled 500, so no account that
  had ever been used could actually be deleted. Deletion now runs in a
  transaction that locks the row, clears the account's own auth history, and
  lets the account-owned rows cascade; when business records still reference
  the user, it rolls back and deactivates the account instead — sessions
  revoked, history intact — and reports which of the two happened, so the UI
  can say so. Contributed by [Artur Klujewski](https://github.com/Kujoo25) in
  [Cascadia-App#71](https://github.com/Cascadia-PLM/Cascadia-App/pull/71)

### Security

- **Assistant tool errors no longer hand the model the failed SQL and its
  bound parameters.** Both surfaces that run PLM tools — TanStack AI for the
  chatbot, the MCP server for external agents — put a thrown message straight
  into the tool result the model reads, and drizzle's query wrapper _is_ the
  statement plus every parameter value. Database failures now collapse to a
  generic sentence and keep their detail in the server log. Not-found,
  validation and permission messages survive untouched, being exactly what the
  model needs to correct course

- **An unset `ENCRYPTION_KEY` stores provider API keys as plaintext, and now
  says so.** AI provider keys entered in the admin UI are encrypted with
  AES-256-GCM only when `ENCRYPTION_KEY` is set. Without it they are written to
  the database in the clear, and nothing surfaced that: a working integration
  looks identical either way. The storage behaviour is unchanged; what changed
  is that the plaintext path now logs a warning naming the provider (never the
  key), and the variable is documented in SECURITY.md, both compose files, and
  the env examples. Keys saved before `ENCRYPTION_KEY` was configured stay
  plaintext — re-save them once it is set
- **Item-number lookups are scoped to the designs the caller can read.**
  `get_item_details` applied no design scope when resolving an item number, so
  naming a number was the one way to read an item out of a program you are not a
  member of — `search_items` has always filtered by accessible design. The
  by-number path now goes through the same `accessScopeCondition` helper the item
  lists, search and report execution use, which also keeps the new `otherMatches`
  list from becoming a way to enumerate items in designs the caller cannot reach.
  Lookup by an explicit item id is unchanged

- **User reads no longer carry credential material.** Every user object
  leaving `UserService` — lists, detail reads, create and update returns — now
  omits `passwordHash` and `failedLoginAttempts` at the type level rather than
  by caller discipline. Password changes and resets write `auth_events` rows
  naming the actor where one account acted on another, and session revocation
  happens in the same transaction as the credential update, so a failure
  cannot leave a new password live alongside sessions it should have ended.
  Contributed by [Artur Klujewski](https://github.com/Kujoo25) in
  [Cascadia-App#71](https://github.com/Cascadia-PLM/Cascadia-App/pull/71)

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

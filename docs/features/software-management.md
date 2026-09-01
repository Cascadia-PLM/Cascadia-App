# Proposal: Software as a First-Class Item Type

**Status**: Phases 1-2 implemented. Phase 1: Software item type, content-addressed source store, import + read-only viewer. Phase 2: checkout-gated in-app editing with draft manifests, per-file `source` history rows, revision/line diff views, per-file conflict sharpening, build-artifact slot. External items can record a repository URL, pinned ref, and optional commit SHA manually. Provider-backed repository connections, ref resolution, mirroring, and drift alerts from Phases 3-4 have not yet started.
**Scope**: Firmware/embedded software management inside Cascadia — in-app code viewing and editing, full participation in the Design/Part/Document versioning model, and integration with external repositories (GitHub, Bitbucket, GitLab).

---

## 1. Where Software Stands Today

Cascadia currently acknowledges software in exactly one place: `parts.partType` may be `'Software'`. That makes software a _BOM placeholder_ — it can occupy a line in a product structure, carry a cost, and be affected by an ECO — but it has:

- No content. There is nothing behind the part number: no source, no binary, no version manifest.
- No code-aware behavior. No viewer, no diff, no editing, no build artifact management.
- No connection to where software actually lives (GitHub, Bitbucket, etc.).

Meanwhile, everything software _needs_ already exists in the platform:

| Need                                  | Existing mechanism                                                  |
| ------------------------------------- | ------------------------------------------------------------------- |
| Immutable version history             | `items` master/instance pattern (`masterId` + new row per revision) |
| Parallel change isolation             | ECO-as-branch, `branchItems`, `VersionResolver` overlay resolution  |
| Controlled release + revision letters | `ChangeOrderMergeService.merge()` assigns revisions at merge time   |
| Field-level audit                     | `commits` + `itemVersions` + `itemFieldChanges`                     |
| Time travel                           | Commit-ancestry resolution at any branch/commit/tag context         |
| Binary storage with branch isolation  | Vault (`vault_files.branchId`, promotion on merge)                  |
| Async work (sync, import, builds)     | RabbitMQ job system (`JobTypeRegistry`, workers)                    |
| Extensibility                         | Two-table pattern + `ItemTypeRegistry`                              |

The thesis of this proposal: **software should be a new item type that rides the existing versioning machinery unchanged**, with two software-specific additions — a content-addressed source store (for in-app code) and a repository-link subsystem (for external code). Nothing in branching, merging, conflict detection, or version resolution needs per-type changes; that is exactly what the two-table pattern was designed for.

---

## 2. Conceptual Model

### 2.1 A `Software` item type, not a heavier Part

Introduce `Software` as a tenth registered item type (alongside Part, Document, ChangeOrder, …):

```
Organization → Program → Design
                           ├── Part  P-014  "Main Controller PCB"      (partType: Manufacture)
                           ├── Part  P-021  "TDJ-25 Firmware"          (partType: Software)  ← BOM line
                           └── Software SW-001 "TDJ-25 Motor Firmware" ← the actual configuration item
                                 │
                                 ├── source manifest (internal code tree)  OR  pinned external repo ref
                                 ├── build artifacts (vault files: .bin/.hex/.elf/.exe)
                                 └── metadata: semver, target hardware, toolchain
```

**Why a new item type rather than extending the `parts` table?**

- Software carries a substantially different field set (source mode, manifest pointer, repo link, target hardware, toolchain, build artifact). Stuffing those into `parts` bloats every Part row and violates the "type-specific integrity" benefit of the two-table pattern.
- A distinct type gets its own lifecycle, numbering scheme (`SW-###`), permissions, search fields, and UI components via `ItemTypeRegistry` — all for free.
- It mirrors how the system already separates "the thing in the BOM" from "the content behind it" (Part ↔ Document).

**BOM participation.** Keep the existing convention: a Part with `partType: 'Software'` is the BOM node (it is what manufacturing consumes — a flashable unit with a part number and revision). Link it to the Software configuration item with a new relationship type:

```typescript
// added to partRelationships in packages/core/src/lib/items/types/part.ts
{
  type: 'Software',
  label: 'Software',
  targetTypes: ['Software'],
  allowMultiple: true,   // a software part may aggregate bootloader + app image
}
```

This is deliberately parallel to how Documents attach to Parts today. It also means `ImpactAssessmentService` traversal picks up hardware→firmware impact automatically: revising the controller PCB on an ECO flags the linked firmware as impacted, and vice versa.

> Alternative considered: allowing `Software` items directly as BOM children (adding `'Software'` to BOM `targetTypes`). Rejected for v1 — it would ripple into MBOM derivation, work instruction part attachments, and BOM costing, all of which assume Part semantics. The relationship approach touches none of that. It can be revisited later without schema changes.

### 2.2 Two source modes

Every Software item declares a `sourceMode`:

| Mode       | Source of truth for development | What Cascadia stores                                                | Typical use                                                                     |
| ---------- | ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `internal` | Cascadia itself                 | Full source tree (content-addressed blobs + manifest)               | Firmware configs, PLC programs, small embedded code owned by hardware engineers |
| `external` | GitHub / Bitbucket / GitLab     | A pinned ref (tag/SHA) + metadata snapshot + optional mirrored tree | Application firmware developed by a software team in a real repo                |

The two modes share the viewer, the versioning behavior, and the release semantics. `external` items are read-only in-app (editing happens in the real repo); `internal` items are editable in-app. A hybrid is naturally expressible later (external repo + internal overlay), but is out of scope for v1.

The key philosophical stance for `external` mode: **Cascadia does not attempt to mirror git history. The external repo is the source of truth for _development_; Cascadia is the source of truth for _what is released onto the product_.** An external Software item pins exactly one commit per Cascadia revision. When ECO-042 releases "firmware v2.3.0 onto Rev C of the controller board," the merge freezes the pinned SHA into the released item version — permanently and immutably, exactly like a released Part's weight.

The currently implemented lightweight external mode records the repository URL,
the selected ref, and an optional full commit SHA directly on the Software item.
Those fields participate in ordinary checkout/ECO versioning and history, but
they are not verified or synchronized with the provider. The repository-link
subsystem described below remains the target for Phase 3.

---

## 3. Data Model

### 3.1 The `software` extension table

Standard two-table extension (`packages/core/src/lib/db/schema/items.ts` or a new `software.ts` schema file):

```typescript
export const software = pgTable('software', {
  itemId: uuid('item_id')
    .primaryKey()
    .references(() => items.id, { onDelete: 'cascade' }),
  description: text('description'),
  softwareType: varchar('software_type', { length: 30 }), // 'firmware' | 'application' | 'library' | 'configuration' | 'fpga'
  sourceMode: varchar('source_mode', { length: 20 })
    .notNull()
    .default('internal'), // 'internal' | 'external'

  // Version metadata (user-managed, distinct from the PLM revision letter)
  version: varchar('version', { length: 50 }), // e.g. '2.3.0' semver
  targetHardware: varchar('target_hardware', { length: 200 }), // e.g. 'STM32F407, board rev C'
  toolchain: varchar('toolchain', { length: 200 }), // e.g. 'arm-none-eabi-gcc 13.2, CMake'

  // Internal mode: pointer to the immutable source-tree snapshot for THIS item version
  manifestId: uuid('manifest_id').references(() => softwareManifests.id),

  // External mode: pointer to the repo link (pin details live there)
  repoLinkId: uuid('repo_link_id').references(() => softwareRepoLinks.id),

  // Primary build artifact (vault file: .bin/.hex/.elf/.exe/.zip) — vault handles branch isolation
  buildArtifactFileId: uuid('build_artifact_file_id'),
})
```

Because each item _version_ is a separate `items` row (master/instance pattern), and `ItemService` copies the extension row on checkout, **`manifestId` is naturally version-pinned**: Rev A's `software` row points at Rev A's manifest, the ECO working copy points at the draft manifest, and time travel through `VersionResolver` lands on exactly the right source tree with zero new resolution logic.

### 3.2 Content-addressed source store (internal mode)

Two tables, modeled on git's blob/tree split but radically simplified for firmware-scale trees (tens to a few hundred files, mostly small text):

```typescript
// Deduplicated file contents, keyed by SHA-256. Shared across versions, items, designs.
export const softwareBlobs = pgTable('software_blobs', {
  hash: varchar('hash', { length: 64 }).primaryKey(), // sha256 of content
  content: text('content'), // text files stored inline
  vaultFileId: uuid('vault_file_id'), // large/binary files spill to vault instead
  size: integer('size').notNull(),
  isBinary: boolean('is_binary').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

// An immutable snapshot of an entire source tree.
export const softwareManifests = pgTable('software_manifests', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Flat path list — no directory objects needed at this scale.
  entries: jsonb('entries')
    .$type<Array<{ path: string; hash: string; size: number }>>()
    .notNull(),
  fileCount: integer('file_count').notNull(),
  totalSize: bigint('total_size', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
})
```

Properties this buys, all matching existing system invariants:

- **Immutability**: manifests and blobs are never mutated, mirroring commits/itemVersions. A "save" during editing creates new blobs + a new manifest and repoints the _working copy's_ `software.manifestId` (working copies are already the one mutable surface in the system).
- **Free deduplication**: editing one file in a 200-file tree stores one new blob and one new manifest row; 199 entries reuse existing hashes. Storage cost is proportional to change, like git.
- **Cheap diffs**: comparing two revisions = set-diff of two `entries` arrays (added/removed/changed paths), then line-diff the changed blobs on demand.
- **Branch isolation without new machinery**: isolation lives at the `items`/`branchItems` layer, which already works. The manifest is just data hanging off the item version.

Size guardrails: inline text blobs capped (e.g. 1 MB/file, ~2,000 files/manifest); anything larger or binary is stored as a vault file referenced from the blob row. Build outputs (`.bin`, `.hex`, map files) never enter the blob store — they are vault files on the item, which already get branch isolation and merge promotion.

> **Alternative considered — embed real git** (bare repos server-side via isomorphic-git/libgit2, one repo per Software item). Rejected: it creates a second source of truth for branching that must be bidirectionally mapped onto ECO branches, breaks the "resolve any item at any context through one code path" property of `VersionResolver`, complicates S3-backed deployments, and buys nothing at firmware scale. The manifest/blob model is git-_shaped_ enough that a future "expose a Software item as a git remote" bridge remains possible (see §8).

### 3.3 External repository linking

```typescript
// Provider credentials, scoped to a program (permission boundary) or org-wide.
export const repoConnections = pgTable('repo_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  programId: uuid('program_id').references(() => programs.id), // null = org-wide
  provider: varchar('provider', { length: 20 }).notNull(), // 'github' | 'bitbucket' | 'gitlab'
  baseUrl: text('base_url'), // for self-hosted GHE / Bitbucket Server
  authType: varchar('auth_type', { length: 20 }).notNull(), // 'pat' | 'oauth' | 'app'
  encryptedCredentials: text('encrypted_credentials').notNull(), // AES-GCM via ENCRYPTION_KEY-derived key
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

// One row per Software item version that links out (copied on checkout like all extension data).
export const softwareRepoLinks = pgTable('software_repo_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => repoConnections.id),
  repoOwner: varchar('repo_owner', { length: 200 }).notNull(),
  repoName: varchar('repo_name', { length: 200 }).notNull(),
  defaultBranch: varchar('default_branch', { length: 200 }),

  // The pin — what this item version means
  pinnedRefType: varchar('pinned_ref_type', { length: 20 }), // 'tag' | 'commit' | 'branch'
  pinnedRef: varchar('pinned_ref', { length: 300 }), // 'v2.3.0' or branch name
  pinnedCommitSha: varchar('pinned_commit_sha', { length: 64 }), // always resolved & frozen
  pinnedAt: timestamp('pinned_at', { withTimezone: true }),
  pinMetadata: jsonb('pin_metadata'), // commit message, author, CI status at pin time

  // Optional mirrored snapshot for in-app viewing + audit independence from the provider
  mirroredManifestId: uuid('mirrored_manifest_id').references(
    () => softwareManifests.id,
  ),

  // Upstream drift tracking (populated by sync job / webhooks)
  upstreamHeadSha: varchar('upstream_head_sha', { length: 64 }),
  upstreamAheadBy: integer('upstream_ahead_by'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  syncStatus: varchar('sync_status', { length: 20 }).default('idle'), // 'idle' | 'syncing' | 'error'
})
```

Note the elegant convergence: **a mirrored external repo is just a manifest**. The same viewer, differ, and time-travel code path serves both modes. Pinning `v2.3.0` optionally imports the tree at that tag into the blob store, so the released firmware source is viewable in-app forever — even if the GitHub repo is later force-pushed, renamed, or deleted. For regulated industries (the audience for a PLM), that audit independence is a headline feature, not an implementation detail.

### 3.4 Provider abstraction

```typescript
// packages/core/src/lib/scm/types.ts
export interface ScmProvider {
  readonly name: 'github' | 'bitbucket' | 'gitlab'
  getRepo(link: RepoRef): Promise<RepoInfo>
  listRefs(link: RepoRef, type: 'tags' | 'branches'): Promise<Array<ScmRef>>
  resolveRef(
    link: RepoRef,
    ref: string,
  ): Promise<{ sha: string; meta: CommitMeta }>
  getTree(
    link: RepoRef,
    sha: string,
  ): Promise<Array<{ path: string; size: number; sha: string }>>
  getBlob(link: RepoRef, sha: string): Promise<Buffer>
  compare(link: RepoRef, base: string, head: string): Promise<CompareResult>
  verifyWebhook(headers: Headers, body: string, secret: string): boolean
}
```

Implementations live in `packages/core/src/lib/scm/providers/` (`github.ts` first — plain REST v3, no SDK dependency needed; `bitbucket.ts`, `gitlab.ts` later). All network work runs in background jobs, never in request handlers:

| Job type                | Trigger                          | Work                                                    |
| ----------------------- | -------------------------------- | ------------------------------------------------------- |
| `software.repo.resolve` | user pins a ref                  | resolve ref → SHA, snapshot commit metadata             |
| `software.repo.mirror`  | pin with "import source" checked | fetch tree + blobs → manifest, set `mirroredManifestId` |
| `software.repo.sync`    | cron + webhook                   | update `upstreamHeadSha`/`aheadBy`, raise drift alerts  |

These follow the existing `JobTypeRegistry` pattern verbatim (config in `definitions/`, handler in `node-handlers/`).

### 3.5 Source-level change tracking

Add a fifth `fieldCategory` to `itemFieldChanges`: **`source`**. When `CheckoutService.computeFieldChanges()` sees a Software item whose `manifestId` changed, it expands the manifest diff into per-file rows:

```
itemFieldChanges:
  fieldCategory: 'source'
  fieldName:     'modified'                    // 'added' | 'modified' | 'deleted'
  fieldPath:     'src/motor/pid_controller.c'
  oldValue:      { hash: 'ab12…', size: 4821 }
  newValue:      { hash: 'cd34…', size: 4977 }
```

The existing History tab renders these with a source-aware renderer (click → line diff). The commit/audit trail for code changes is therefore the _same_ trail as for weight changes — one history, one UI, one mental model. For external items, the pin change is a `type`-category change (`pinnedCommitSha: abc123 → def456`) whose renderer links to the provider's compare view and, when mirrored, to the in-app diff.

### 3.6 Conflict detection

No new machinery required for v1: two ECOs touching the same Software item already trigger `cross_eco` / `concurrent_modification` warnings at the item level. Phase 2 sharpens `field_conflict` to per-file granularity by comparing manifest diffs from each branch's base — same-path-changed-on-both-sides → warning listing the overlapping files. True line-level merge is explicitly out of scope (that is what external repos are for; internal mode targets small, owner-operated firmware trees where item-level locking via checkout is the natural workflow).

---

## 4. Versioning Semantics (walkthrough)

The entire ECO flow works untouched. Concretely, for an internal-mode firmware item:

```
1. SW-001 Rev A (Released) on main — manifest M1, artifact fw-a.bin
2. Engineer creates ECO-042 "Fix PID windup", adds SW-001 as affected item
3. Checkout SW-001 to eco/ECO-042
     → branchItems row created; working copy item row + software row copied (manifestId = M1)
4. Open in-app editor, modify pid_controller.c, save
     → new blob, new manifest M2 (draft), working copy manifestId → M2
5. Commit "Clamp integrator on saturation"
     → CommitService commit on ECO branch; itemFieldChanges: source rows (1 modified)
6. Upload rebuilt fw-b.bin to the working copy (vault, branch-scoped)
7. ECO approved → transition to final state → ChangeOrderMergeService.merge()
     → new item version SW-001 Rev B (Released) on main, manifestId = M2
     → Rev A marked Superseded; vault file promoted; merge commit records revisionsAssigned
8. Time travel to the PDR baseline tag → VersionResolver returns Rev A → viewer renders M1
```

For an external-mode item, steps 4–5 become "pin new ref `v2.3.1` (job resolves SHA, optionally mirrors tree)" — one field change instead of file edits — and everything else is identical. Revision letters, baselines, branch locking on submit, concurrent-ECO revision resolution: all inherited.

This also composes with change management correctly in the hardware→software direction: because the Part↔Software relationship exists, an ECO revising the controller PCB surfaces the firmware in impact assessment, prompting the engineer to add SW-001 to the same ECO — hardware and firmware then release _atomically in one merge commit_, which is precisely the co-versioning story traditional PLM struggles to tell.

---

## 5. UI

### 5.1 Code viewer (read-only, all contexts)

Route: `packages/core/src/routes/software/$id.tsx`, plus a "Source" tab on the Software item detail.

- **Layout**: file tree sidebar (from the manifest, folders derived from paths) + editor pane + breadcrumb showing the active version context (`Rev B` / `eco/ECO-042` / commit / tag), reusing the existing version-context URL params so time travel is uniform with the rest of the app.
- **Editor component**: **CodeMirror 6** (`@codemirror/view`, `@codemirror/state`, `@codemirror/language` + per-language packages). Chosen over Monaco: ~10× smaller, tree-shakeable per language, no web-worker deployment complexity in the Vite SPA, and read/edit/diff are all first-class. Firmware-relevant languages first: C/C++, Python, JSON/YAML/TOML, Makefile/CMake, plain text/Markdown; hex viewer stub for small binaries.
- **Diff view**: `@codemirror/merge` side-by-side, driven by manifest comparison. Entry points: History tab (this commit vs parent), Compare Revisions (Rev A vs Rev B), and ECO review ("what does this ECO do to the firmware?" — base manifest vs branch manifest). The ECO review diff is the killer view for approvers.
- **External items**: identical viewer over `mirroredManifestId`; un-mirrored links show pin metadata card (repo, ref, SHA, commit message, pinned-at) with deep links out to the provider.

### 5.2 Editing (internal mode, checkout-gated)

Editing obeys the exact rules items already obey — the editor is enabled only when: the user holds the checkout, the context is an unlocked non-main branch (or unprotected pre-release main), and the item state permits modification. Otherwise it renders read-only with the standard "checked out by / locked" affordances from `lock-status`.

- Multi-file editing with a dirty-file list; **Save Draft** persists blobs + a draft manifest (auto-save on interval); **Commit** promotes the draft with a required message through the normal commit flow. This two-step mirrors the existing edit→commit model of item fields.
- File operations: create, rename (manifest path change), delete, upload files/zip into a folder (zip import is also the bulk-ingest path for getting an existing firmware tree into a new item).
- No concurrent-editor CRDT ambitions: the checkout lock _is_ the concurrency model, consistent with the vault and item editing.

### 5.3 Repo linking UX

- Admin/program settings: "Repository Connections" panel (provider, base URL, PAT or OAuth via the existing Arctic setup, test-connection button).
- On a Software item: "Link repository" → pick connection → repo → browse tags/branches → **Pin** (with "Mirror source into Cascadia" checkbox, default on).
- Drift surfacing: when sync detects the upstream default branch or a newer tag ahead of the pin, show a non-blocking banner ("upstream is 14 commits ahead — v2.4.0 available") with a one-click "Start ECO to update pin" action. Pattern and table shape borrowed from `workInstructionChangeAlerts`.

---

## 6. API Surface (all under existing conventions)

New route module `packages/core/src/server/routes/software.ts` (`tagged('Software')`), mounted at `/api/v1/software`:

```
GET    /software/:id/tree?branchId=|commitId=|tagId=      → manifest (resolved via VersionResolver)
GET    /software/:id/file?path=…&<context>                → blob content (+ EOL/lang metadata)
PUT    /software/:id/file                                  → save one file to draft manifest (requires checkout)
POST   /software/:id/files                                 → upload files / zip import (requires checkout)
DELETE /software/:id/file?path=…                           → delete from draft manifest (requires checkout)
POST   /software/:id/commit                                → commit draft manifest { message }
GET    /software/:id/diff?fromRev=&toRev=|fromCommit=…     → manifest-level diff (+ per-file on demand)

POST   /software/:id/repo-link                             → create link + submit resolve/mirror jobs
POST   /software/:id/repo-link/pin                         → pin ref (requires checkout — a pin IS a change)
POST   /software/:id/repo-link/sync                        → manual sync trigger
GET    /repo-connections / POST /repo-connections          → connection management (program-scoped perms)
GET    /repo-connections/:id/repos|refs                    → provider browsing (proxied, cached)

POST   /integrations/scm/webhook/:provider                 → { public: true } + signature verification
```

Item CRUD itself needs **no new routes** — `ItemService` + the generic items/parts patterns handle Software once it is registered. Permission model: standard `['software', 'read'|'update'|…]` resources; repo connections gated to program admins; webhook route public but signature-verified and rate-limited. Run `npm run openapi:snapshot` after mounting.

---

## 7. Implementation Plan

Each phase is independently shippable and useful.

**Phase 1 — Software item type + source store + viewer (read path)**
Schema (`software`, `software_blobs`, `software_manifests`) + migration; Zod type in `packages/core/src/lib/items/types/software.ts`; registration in `item-type-definitions.ts` + both `registerItemTypes.*` (icon `Cpu`, table `'software'`, numbering `SW-###`, part-lifecycle); `SoftwareSourceService` (manifest CRUD, blob store, zip import, tree/file/diff reads through `VersionResolver` contexts); routes; file-tree + CodeMirror read-only viewer + Part↔Software relationship; zip/file bulk import. _Tests (three-gate: data integrity)_: manifest immutability, blob dedup, version-pinned manifest across checkout→commit→merge, release assigns revision with correct manifest.

**Phase 2 — Editing + history (write path)**
Checkout-gated editor, draft manifests, save/commit flow; `source` fieldCategory in `CheckoutService.computeFieldChanges()` + History tab renderer; diff views (revision compare, ECO review diff); build-artifact slot (vault); per-file `field_conflict` sharpening in `ConflictDetectionService`. _Tests_: source field-change expansion, per-file cross-ECO conflict detection, checkout gating (security gate).

**Phase 3 — GitHub integration**
`repo_connections` + `software_repo_links` schema; `ScmProvider` interface + GitHub REST implementation; credential encryption; resolve/mirror/sync jobs; pin UX + external item detail; mirrored-manifest viewing; release-freezes-pin semantics. _Tests_: pin immutability after release, webhook signature verification (security gate).

**Phase 4 — Drift + more providers**
Webhook receiver + drift alerts + "start ECO from upstream tag"; Bitbucket and GitLab providers; provider compare-view deep links; program-level dashboard card ("3 firmware items behind upstream").

Rough effort ordering: Phases 1–2 are the bulk (~2/3), and are pure in-platform work with no external dependencies; Phase 3+ is additive.

---

## 8. Future Directions (explicitly out of scope, but the design leaves the door open)

- **Git remote bridge**: because internal storage is content-addressed blobs + tree manifests, a read/write git HTTP endpoint (`git clone https://cascadia/…/SW-001.git`) mapping ECO branches ↔ git branches is implementable later without schema changes — manifests become git trees, blobs are already blobs.
- **CI hooks**: accept build-artifact uploads from GitHub Actions via the existing API-key auth (`api-keys` schema), attaching binaries to the working copy so "pin + binary" land together.
- **PR ↔ ECO traceability**: link a provider pull request to an ECO; surface PR status in the ECO view.
- **SBOM**: software composition (library Software items as children of application Software items via relationships) already falls out of the model; an SPDX export would formalize it.
- **Direct BOM membership** for Software items, if the Part-placeholder indirection proves annoying in practice.

---

## 9. Summary of Design Decisions

| Decision                       | Choice                                                            | Chief alternative rejected                          |
| ------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------- |
| Representation                 | New `Software` item type (two-table)                              | More fields on `parts`                              |
| BOM participation              | Part (`partType: Software`) placeholder + `Software` relationship | Software items directly in BOM                      |
| Internal source storage        | Content-addressed blobs + immutable JSONB manifests               | Embedded real git repos; vault-file-per-source-file |
| Versioning                     | 100% inherited: manifest pointer rides the item version           | Parallel version system for code                    |
| External repos                 | Pin-and-freeze refs + optional mirrored snapshot                  | Live mirroring of git history                       |
| Editor                         | CodeMirror 6                                                      | Monaco                                              |
| Concurrency (internal editing) | Existing checkout locks; per-file conflict _detection_ only       | Line-level merge, collaborative editing             |
| Binaries / build artifacts     | Vault (existing branch isolation + promotion)                     | Blob store                                          |

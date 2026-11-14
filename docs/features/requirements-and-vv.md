# Requirements and V&V

Requirements in Cascadia are items under the same change control as parts:
revisioned through change orders, read across revisions, and tied to the
things that satisfy and verify them by trace links that know when they have
gone stale. This document is the map of that surface — what a requirement
is, how trace links behave across revisions and branches, how verification
status is derived, and where the traceability reports live. The item's
columns and endpoints are in [Item Types](./item-types.md#4-requirement).

## Requirements under change control

A requirement is a Driven-lifecycle item: it is created and edited on main
only while its design is pre-release, and after that through a change order,
on the change order's branch, released with a new revision letter. Every read
of a requirement — its page, its trace panels, the matrix — resolves the
master to the row that answers for it in the current context: main's
released row, the branch's working copy, or the row a tag or commit holds.

Derived requirements hang off their parent through
`requirements.parent_requirement_id`, written at derive time and never
re-pointed; the parent is read through the version lineage, so a child still
finds its parent after the parent revises, and the design clone re-points the
hierarchy inside the clone.

## Trace links

Four edge types carry the trace, declared once in
`cascadia-commons/src/items/relationships/catalog.ts` (the architecture's
two, `DECOMPOSES` and `REALIZED_BY`, are described under
[The system architecture](#the-system-architecture)):

| Edge           | From → to                                             | Meaning                                      |
| -------------- | ----------------------------------------------------- | -------------------------------------------- |
| `ALLOCATED_TO` | Requirement → Part, Software, Document, SystemElement | The requirement is allocated to this element |
| `SATISFIES`    | Part, Software, Document → Requirement                | This element satisfies the requirement       |
| `VERIFIED_BY`  | TestCase → Requirement                                | This test case verifies the requirement      |
| `VALIDATES`    | TestCase → Part                                       | This test case validates the part            |

An edge names two **version rows**, and a revision moves only the referring
item's own side of it: a checkout copies an item's outgoing edges onto its
working copy and the release rebuilds them on the released row, while every
edge pointing _at_ the item keeps naming the row the release superseded. Two
rules correct for that on every read (`cascadia-api/src/items/version-lineage.ts`):

- **Incoming — who names me?** The current row inherits the claims made
  against the rows it succeeded, and claims a revision of the _source_ left
  behind are dropped: the new revision carries its own copy whenever it still
  means the claim, so following the old row's claim forward would re-assert a
  link the change order may have dropped on purpose.
- **Outgoing — what do I name?** A stale reference is followed forward to the
  row that replaced it. The statement is the referring item's own content and
  still means what it says.

A working copy's claims are visible on its branch and nowhere else; nothing
on main or another branch ever inherits from one. That is the branch
isolation guarantee.

### Suspect links

Every trace edge records which rows it was last **affirmed** against
(`metadata.affirmed`: the source and target rows, by whom, when). A claim is
born affirmed by its author against the rows it names, and reads as
**suspect** once either end has revised since: `source_revised` when the edge
hangs off a copy nobody has looked at, `target_revised` when the row it points
at has been superseded. Affirming (`POST /api/v1/relationships/:id/affirm`, or
`POST /api/v1/relationships/affirm` for a batch) records that the claim still
holds; it is outside the edit lock, so a released part's claims can be
re-affirmed after a requirement revises without a change order on the part.

Suspect claims are flagged on every panel that lists a trace link, counted in
requirements coverage, listed as `suspect_requirement` gaps in the gap
analysis, and previewed in the change-order transition dialog: the preview
lists the claims a release will leave suspect, computed by the same rule the
readers apply afterwards. See the design discussion in
[Change Management](./change-management.md).

## Verification

### Test cases and executions

A test case's lifecycle is Draft / Active / Obsolete. A result is never a
state: `POST /api/v1/test-cases/:id/execute` records a run in the execution
history and the latest result on the test case (`Passed`, `Failed`, `Blocked`;
null until the first run), and publishes `test.executed`.

### Derived verification status

A requirement's `verification_status` is derived, never set by hand
(`cascadia-api/src/services/verification-rollup.ts`). Recording an execution
and every change to a `VERIFIED_BY` link recompute it for every requirement
the test case verifies, in the same transaction, from the latest execution of
each verifying test case:

| Latest executions of the verifying test cases | Status       |
| --------------------------------------------- | ------------ |
| any `Failed`                                  | `Failed`     |
| every one `Passed` (at least one test case)   | `Passed`     |
| any execution at all, `Blocked` included      | `InProgress` |
| no verifying test case, or none has run       | `NotStarted` |

The one exception is manual: `POST /api/v1/requirements/:id/waive` records a
waiver (`verification_waiver`: `{ note, waivedBy, waivedAt }`) and sets
`Waived`, which wins over the derivation until
`DELETE /api/v1/requirements/:id/waive` clears it and recomputes. Every
change of the status publishes `requirement.verification_changed`, with its
cause.

### The one rule for "verified"

Wherever coverage reports it — requirements coverage, test coverage, the
verification gaps, the gap analysis, the matrix and the program rollup —
**verified** means the derived status is `Passed` or `Waived` **and** no
verifying claim is suspect. A claim under review is not evidence: a revision
of the requirement leaves its verifying claims suspect, and the requirement
reads as unverified until someone affirms them.

## The system architecture

A requirement needs somewhere to land before the design has parts. The
`SystemElement` item type is that place: a logical element — the system, a
segment, a subsystem, a module — versioned and ECO-controlled like a part,
with three edges of its own in the catalog:

| Edge          | From → to                      | Meaning                                                         |
| ------------- | ------------------------------ | --------------------------------------------------------------- |
| `DECOMPOSES`  | SystemElement → SystemElement  | The architecture tree. Not the BOM, on purpose.                 |
| `REALIZED_BY` | SystemElement → Part, Software | The element is implemented by this item — a trace claim         |
| `CONNECTS`    | SystemElement → SystemElement  | An interface between two elements — a line in the block diagram |

`ALLOCATED_TO` accepts a system element as its target, so an allocation can be
made to a subsystem on day one and the requirements matrix reads it as
allocated with no part in sight. Once the element is realized, the matrix
shows both hops on the allocation — requirement → element → realizing part —
and the realization is judged like any other claim: it reads suspect when the
element or the item revises until someone affirms it. `DECOMPOSES` cannot go
stale (it is structure, not a claim), and the relationship service refuses a
link that would close a loop, through the element's own endpoints and the
generic relationship write alike.

All three edges ride a change order the way a BOM line does: a checkout copies the
element's edges onto its working copy, the release rebuilds them on the
released row, and a child placed or a realization made on the branch shows on
the branch and nowhere else until the merge.

`GET /api/v1/designs/:id/architecture?branch=|tag=|commit=` is the
`DECOMPOSES` forest of a design at a context — each element with the items
that realize it and the requirements allocated to it — resolved by the rules
the matrix applies (`RequirementsMatrixService` and `SystemElementService`
share them), so the Architecture tab and the Requirements tab never disagree
about which row answers for an item at a tag. An element placed under two
parents appears under the first by item number, and a loop that reached the
store despite the guard is broken at the edge that closes it, so the answer
is always a forest. The design page's Architecture tab renders it as a tree
(the BOM tree view with its own columns), as a graph, and as an editable
block diagram (below); the element's own page lists its children, its
realizations and its allocated requirements.

### The block diagram editor

The Architecture tab's **Block diagram** view draws the same answer as nested
boxes — an element with children is a container and its children sit inside
it — with the `CONNECTS` edges as lines between them, and it is edited in
place:

- **Add block** creates a system element (its number is assigned
  automatically); with a block selected, the new one is created inside it,
  which also writes the `DECOMPOSES` edge.
- **Dragging from a dot on one block to another** draws a connection. It can
  be given a name ("28 V bus") and a kind — power, data, mechanical, fluid,
  thermal or other — which colours the line. Clicking a line renames or
  deletes it. A connection may cross levels of the tree and may form loops;
  one connection is kept per pair of elements in each direction, so drawing
  the same line again edits it.
- **Dragging a block** moves it, and a container grows to fit what is inside
  it. **Auto-arrange** forgets the saved positions.

Two kinds of data are being written, under two different rules:

| What             | Where it lives                                                                | Change control                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocks and lines | Items and `item_relationships` (a connection's name and kind in its metadata) | The same as the tree: freely on main before the design's first release; afterwards inside a change order, with the element a line starts from checked out to that branch. |
| Block positions  | `architecture_layouts`, one row per design, keyed by element master id        | None. Layout is presentation: unversioned, shared by main, every branch and every tag, and saved without a checkout.                                                      |

At a tag or a commit the diagram is read-only. `connections` and `layout`
are part of the `GET /designs/:id/architecture` answer; connections are
written through `POST /system-elements/:id/connections` and
`PUT|DELETE /system-elements/connections/:relationshipId`, and the layout
through `PUT|DELETE /designs/:id/architecture/layout`. Not in this version:
named ports on a block, re-parenting a block by dragging it into another
(use the element's page), and deleting a block from the diagram.

## The traceability reports

### Requirements traceability matrix (RTM) and VCRM

`GET /api/v1/designs/:id/rtm?branch=|tag=|commit=` is the matrix: one row per
requirement that exists at the context, with what it is allocated to (an
allocation to a system element carries `realizedBy`, the items that realize
the element there), what satisfies it and what verifies it (each verifying
test with its latest result), the derived verification status, the one-rule `verified` flag, the
number of suspect claims, and the row's gaps — `not_allocated`,
`not_satisfied`, `not_verified`, as independent flags. The totals count rows.

The design page's **Requirements tab** renders it as a grid with coverage
cards above, filters by gap, priority and suspect, text filters on the
columns, CSV export of the filtered rows, and an _Affirm all suspect_ action.
The **VCRM** is the verification-columns view of the same rows: method,
verifying tests with results, last run, status.

Both follow the page's version picker:

- **main** (no context) — the current rows, as every live coverage read
  counts them;
- a **branch** — the branch's overlay: its working copies and their claims,
  main's rows for everything it has not touched;
- a **tag** or **commit** — the compliance snapshot. Rows are the ones the
  snapshot holds, and a claim is judged against them: suspect when its
  affirmation names a row the snapshot's row superseded (the claim predates
  that revision and nobody has looked at it since), not when it names that
  row or a later one — an affirmation made after the baseline does not make
  the baseline suspect in hindsight. "Compare the RTM at the PDR baseline
  with now" is two calls.

### Program rollup

`GET /api/v1/programs/:id/requirements-rollup` sums each design's matrix at
main: one line per design (requirements, allocated, satisfied, verified,
suspect, gaps) and the open gaps across the program, most important first.
The program page's **Requirements** card renders it, each line drilling down
to the design's Requirements tab.

### Coverage, gaps and impact

- `GET /api/v1/designs/:id/requirements-coverage` — counts and percentages,
  the suspect links, and one gap per requirement (the first of not allocated,
  not satisfied, not verified that applies).
- `GET /api/v1/designs/:id/test-coverage` and `/verification-gaps` — the
  verification side on its own.
- `GET /api/v1/designs/:id/gap-analysis` — the cross-domain gap analysis,
  `suspect_requirement` included, with its dialog on the design page.
- Impact analysis (`POST /api/v1/items/:id/impact`) walks `SATISFIES`,
  `VERIFIED_BY`, `VALIDATES` and `EBOM_SOURCE` through the version lineage, so
  a test case that still names the revision a release superseded is found
  from the current requirement, and a claim a revision of the source left
  behind is not reported.

## Interchange

A design's requirements travel as a sheet. `POST /api/v1/import/requirements`
takes CSV or XLSX through the same wizard as parts, documents and issues:
column auto-mapping on the requirement fields, a validation preview, any
number of rows, custom attributes from unmapped columns, and the hierarchy in one
sheet — each row names its parent by item number, another row of the sheet
or a requirement the design already holds, in any order. A loop, a
self-parent or a parent nobody holds fails that row alone and the rest still
imports. `GET /api/v1/designs/:id/requirements-export` writes the same sheet
back, so a design round-trips: export, import into another design, export
again, identical. Both live on the design page's Requirements tab (_Import_,
_Export sheet_) and the import on the requirements list page; the matrix
grid's own _Export_ is the RTM report. See [Import/Export](./import-export.md)
for the fields, the aliases and the hierarchy rules.

ReqIF stays deferred until a customer names DOORS or Polarion.

## Events

| Event                              | When                                             |
| ---------------------------------- | ------------------------------------------------ |
| `test.executed`                    | A test execution is recorded                     |
| `requirement.verification_changed` | A requirement's derived status moved, with cause |
| `relationship.added` / `removed`   | A trace link is made or dropped                  |

## Key files

- `cascadia-api/src/services/RequirementService.ts` — links, coverage, waivers
- `cascadia-api/src/services/RequirementsMatrixService.ts` — the RTM and the rollup, and the context resolvers the architecture shares
- `cascadia-api/src/services/SystemElementService.ts` — the architecture: the tree, realizations, the design's forest at a context
- `cascadia-api/src/services/verification-rollup.ts` — the derivation and the one rule
- `cascadia-api/src/services/VerificationService.ts` — executions, test coverage
- `cascadia-api/src/services/TraceImpactService.ts` — the release preview
- `cascadia-api/src/items/trace-affirmation.ts` — the affirmation arithmetic
- `cascadia-api/src/items/version-lineage.ts` — the two lineage rules
- `cascadia-web/src/components/designs/RequirementsTab.tsx` — the tab
- `cascadia-web/src/components/designs/ArchitectureTab.tsx` — the Architecture tab: tree, block diagram and graph
- `cascadia-web/src/components/designs/block-diagram/` — the block diagram editor: layout, the block node, the dialogs
- `cascadia-web/src/components/programs/ProgramRequirementsCard.tsx` — the rollup card
- `cascadia-web/src/components/items/suspect-links.tsx` — badges and affirm actions
- `cascadia-commons/src/import/requirement-hierarchy.ts` — the sheet's hierarchy, planned and previewed
- `cascadia-commons/src/import/field-configs/requirement-fields.ts` — the import fields and their aliases

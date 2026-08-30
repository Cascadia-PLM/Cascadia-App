# Physical Parts, AML & Material Traceability

**Status:** Implemented (Phases 0–5 + thread swim-lane follow-up, see §8)
**Date:** 2026-07-28
**Scope:** New PhysicalPart item type (serialized units + lots), Approved Manufacturer List, Work Order promotion to item type, material consumption/production edges, genealogy, and qualification evidence rollup.

---

## 1. Motivation

Cascadia targets HMLV (high-mix, low-volume) SMB engineering/manufacturing companies as a
**PLM+MES**, paired with an ERP (QuickBooks, Odoo) that owns purchasing and financials.
Traditional PLM draws its boundary at engineering data and leaves manufacturing execution
to separate MES/ERP silos; that split is one of the biggest sources of pain for the target
customer. Cascadia deliberately crosses it — while still refusing to become an ERP.

The boundary rule this proposal implements:

> **Cascadia owns the identity and genealogy of material. The ERP owns quantity and value.**

Cascadia records _which_ physical things exist (serials, lots), _what happened to them_
(consumed by / produced by which work order), and _what documents attach to them_
(material certs, test reports). It never owns on-hand quantities, valuations, locations,
or purchase orders. Quantity is always a derived or advisory number; where a live count
is wanted, it is a read-through from the ERP integration (deferred), never dual-mastered.

### The acceptance story (verbatim customer ask)

> "Could you explain if Cascadia PLM does Qualification management? I.e. tracking parts
> and their requirements and ensuring those are met later down the line with material
> certification and manufacturing details? If I record that I have X feedstock that has
> '1.2.3' certifications, then later on project Y I indicate that I used X feedstock.
> If I ever looked up project Y again I could see that 1.2.3 certifications have been
> satisfied?"

End state: receive feedstock X, register its lot in seconds and attach the 1.2.3 cert
PDFs; project Y's work order scans the lot at the bench; a year later, opening project Y
walks requirement → part → work order → that exact lot → those exact PDFs in the digital
thread, and a qualification rollup answers "satisfied" — or flags the one consumed batch
nobody certified.

This proposal delivers **evidence traceability with human-asserted satisfaction and
automatic gap flagging**. Automated verification (parsing certs and matching them to
requirement criteria) is explicitly out of scope.

---

## 2. Design principles

1. **Nouns become items; verbs become tables or edges.** Things that persist and
   accumulate documentation (a serialized unit, a lot of feedstock, a work order) become
   item types. Events (a consumption, an execution, a sign-off) stay relational rows.
2. **Item-hood ≠ versioning.** The item system has two separable layers: an
   identity/documentation layer (numbering, search, vault attachments, relationships,
   lifecycle states, permissions) and a versioning layer that only engages via `designId`.
   Tools already prove this: no `designId`, Free lifecycle, in-place updates, zero
   branch/revision semantics. PhysicalPart and WorkOrder follow the Tool pattern.
   The deciding constraint: `vault_files.itemId` is NOT NULL — **only items can hold
   files**, and units, lots, and work orders all accumulate documents.
3. **Quantity is a query, not a field.** A record that wants both "quantity: 1200" and a
   list of serial numbers is two concepts fused. Serialized parts count unit rows; lots
   are identity records whose consumed quantity is the sum of consumption edges; bulk
   material is consumption events only. No stored on-hand scalar anywhere.
4. **Operational items are always the edge source.** Verified against
   `ChangeOrderMergeService`: merge reads, deletes, and re-points `item_relationships`
   scoped by `sourceId` (the versioned item being released). Edges whose source is a
   non-versioned operational item are never touched by versioning machinery, and an edge
   _targeting_ a part version row stays pinned to that exact version forever — which is
   precisely the as-built semantic. The convention "WO/PhysicalPart is the source;
   versioned items appear only as targets" makes consumption/production edges safe in
   `item_relationships` with no special cases.
5. **No financials, ever.** Cost fields on parts remain engineering estimates. POs,
   valuation, and stock accounting stay in the ERP.

---

## 3. Concept model

```
Requirement ──(existing satisfies/verifies links)── Part (EBOM/MBOM, versioned)
                                                     │
                             part_manufacturer_parts │ (AML, masterId-bound)
                                                     │
                          ManufacturerPart ──────────┘        (side table, not an item)

Part.trackingMode: 'none' | 'lot' | 'serial'         (engineering-owned policy)

WorkOrder (item, Free lifecycle, no designId)
  ├── builds → partId (a specific part version row)
  ├── ─Consumes→ PhysicalPart (unit|lot)             (item_relationships edge, qty)
  ├── ─Consumes→ Part version row                    (bulk material, qty)
  └── ─Produces→ PhysicalPart (unit)                 (created at completion)

PhysicalPart (item, Free lifecycle, no designId)
  ├── instanceKind: 'unit' (serialNumber) | 'lot' (lotNumber)
  ├── partMasterId → the Part it instantiates
  ├── asBuiltItemId → exact part version row it was built as (units)
  ├── producingWorkOrderId → the WO that made it (units)
  ├── vault files: material certs, test reports, CoCs, photos
  └── ─Evidences→ Requirement                        (qualification evidence edge)
```

Genealogy is **derived, never stored**: unit → producing WO → Consumes edges →
consumed units/lots → their producing WOs → … recursively. V1 precision is WO-level
(all materials consumed by a WO attribute to all units it produced); per-unit allocation
is a documented later refinement, acceptable at HMLV quantities.

### Lifecycles (both Free, no ECO)

- **PhysicalPart:** `Available → Consumed`, `Available → In Service`, `Available/In Service → Scrapped`.
- **WorkOrder:** `Not Started → In Progress → Complete`, any → `Cancelled` (state names
  preserved from the current `work_orders.status` values so migration is a rename-free copy).

### Rejected alternatives (and why)

- **Inventory Item as a versioned item type** — stock mutates many times a day, needs no
  ECO/branches/revisions; would either be exempted from everything (a table wearing an
  item costume) or drown history in stock movements.
- **Quantity fields on lots** — see principle 3; consumed quantity derives from edges.
- **Thin `lots` side table** — fatal counterexample: a mill cert is a PDF attached to a
  _batch_, and only items can hold files. Lots fold into PhysicalPart.
- **`work_order_materials` side table for consumption** — viable fallback, but edges in
  `item_relationships` make genealogy, recall queries, and the graph view read one table
  the thread machinery already understands. Kept as fallback if edge semantics grow
  DB-constraint needs that service-level enforcement can't cover.
- **Separate ManufacturerPart item type** — AML entries are master data attached to a
  part master; a side table with qualification status covers SMB needs. ECO-gated AML
  changes are a later upgrade path.

---

## 4. Schema

### 4.1 `parts` (modified)

```
trackingMode varchar(10) NOT NULL DEFAULT 'none'   -- 'none' | 'lot' | 'serial'
```

Engineering-owned policy: decides what `WorkOrderMaterialService.consume()` requires and
what WO completion creates. Rides part revisions like any other part field.

### 4.2 `manufacturer_parts` (new; replaces unwired `cots_components`)

```
id uuid PK
manufacturer text NOT NULL
mpn text NOT NULL                      -- manufacturer part number
description text
specs jsonb                            -- flexible technical attributes
datasheetUrl text
supplierLinks jsonb                    -- [{supplier, sku, url, price?, leadTimeDays?}]
notes text
createdAt/createdBy, modifiedAt/modifiedBy
UNIQUE (manufacturer, mpn)
```

`supplierLinks` keeps the manufacturer/supplier distinction deliberate: Yamaha is a
manufacturer; Digi-Key is a supplier of Yamaha's part. (AVL-as-sub-rows of AML.)

### 4.3 `part_manufacturer_parts` (new; replaces `part_cots_mapping`)

```
id uuid PK
partMasterId uuid NOT NULL             -- items.masterId, NOT a version row
manufacturerPartId uuid NOT NULL → manufacturer_parts
qualificationStatus varchar(20) NOT NULL DEFAULT 'proposed'  -- proposed|approved|obsolete
isPreferred boolean DEFAULT false
notes text
createdAt/createdBy
UNIQUE (partMasterId, manufacturerPartId)
```

**Decision:** binds to `masterId` so the AML survives revisions and stays a side table.
ECO-controlled AML is a future upgrade; `qualificationStatus` covers SMB workflows now.

The old `cots_components`/`part_cots_mapping` tables are dropped — verified referenced
nowhere in `src/` outside schema exports and one prompt mention, and seeded by nothing.

### 4.4 `physical_parts` (new item type table)

```
itemId uuid PK → items.id ON DELETE CASCADE
instanceKind varchar(10) NOT NULL      -- 'unit' | 'lot'
partMasterId uuid NOT NULL             -- items.masterId of the Part
serialNumber varchar(200)              -- required iff kind='unit'
lotNumber varchar(200)                 -- required iff kind='lot'
manufacturerPartId uuid → manufacturer_parts   -- which approved source this actually is
asBuiltItemId uuid → items.id          -- exact part version row (units, set at production)
producingWorkOrderId uuid → items.id   -- WO item that produced it
erpRef varchar(200)                    -- future ERP reconciliation handle
notes text
CHECK (one of serialNumber/lotNumber per kind)
UNIQUE (partMasterId, serialNumber), UNIQUE (partMasterId, lotNumber)
```

Serials are unique **per part master, not globally** — real serials collide across
manufacturers. `itemNumber` is a generated `PP-######` (display identity is the
serial/lot number; item number is the stable handle). Item name convention:
`<part name> · SN <serial>` / `· Lot <lot>`.

### 4.5 `work_orders` (migrated to item type table)

New shape, keyed by `itemId`:

```
itemId uuid PK → items.id ON DELETE CASCADE
partId uuid → items.id                 -- the part version this WO builds
quantity integer NOT NULL DEFAULT 1
quantityCompleted integer NOT NULL DEFAULT 0
priority varchar(10) NOT NULL DEFAULT 'Normal'
dueDate timestamptz
customerOrder varchar(200)
assignedTo jsonb
requiresSignOff boolean NOT NULL DEFAULT false
completedAt timestamptz
notes text
```

Migration reuses the existing `work_orders.id` as the new `items.id` (and `masterId`),
so `work_instruction_executions.workOrderId` needs **no data rewrite** — only its FK
target changes. `workOrderNumber → items.itemNumber`, `status → items.state` (state
names preserved), `createdBy/modifiedBy/timestamps → items` columns, revision `'A'`.

### 4.6 Edges in `item_relationships` (no new table)

| relationshipType | source         | target                  | semantics                               |
| ---------------- | -------------- | ----------------------- | --------------------------------------- |
| `Consumes`       | WorkOrder item | PhysicalPart (unit/lot) | qty=1 for units; qty for lots           |
| `Consumes`       | WorkOrder item | Part **version row**    | bulk material (trackingMode 'none')     |
| `Produces`       | WorkOrder item | PhysicalPart (unit)     | created at WO completion                |
| `Evidences`      | PhysicalPart   | Requirement item        | metadata: `{fileId?, assertedBy, note}` |

Safety argument (verified): merge/checkout relationship copying is `sourceId`-scoped to
the versioned item being processed; operational-sourced edges are invisible to it, and
version-row targets stay pinned. Invariants (double-consume, qty=1 for units, kind
checks) are **service-enforced** — all writes go through `WorkOrderMaterialService`.

---

## 5. Registry & permissions

- `item-type-definitions.ts`: `PhysicalPart` (icon `Box`, table `physical_parts`,
  searchable: itemNumber, name, serialNumber, lotNumber; displayField itemNumber) and
  `WorkOrder` (icon `Factory`, table `work_orders`, searchable: itemNumber, name,
  customerOrder). Type handlers in `type-handlers/physical-part.ts` / `work-order.ts`.
- `LIFECYCLE_IDS`: `physicalPart: …113`, `workOrder: …114` + seeded workflow definitions
  (`…112` is claimed by ChangeOrderService.test.ts as its private test workflow id).
- Permissions: new `physical_parts` resource added to the union and role matrices
  (grants mirror `work_orders`, which already exists).
- Neither type carries `designId`; both are excluded from BOM pickers, design structure,
  and ECO affected-item selection. In the UI, Physical Parts are visually distinct from
  Parts (serial/lot-first display) and never share a picker with them.

---

## 6. Phases

Each phase is one PR: branch from `main` → implement → migrate → local lint/tests →
`openapi:snapshot` when routes change → PR → merge. Every new table goes into
`ALL_TABLES` in `scripts/truncate-all.ts`.

### Phase 0 — Tracking policy + permissions groundwork

`trackingMode` column + Part zod/type-handler/PartForm select; `physical_parts`
permission resource. No tests (no gate). **Acceptance:** a part can be marked
serial/lot-tracked and the choice persists through the normal part edit flow.

### Phase 1 — AML (manufacturer parts)

Tables §4.2/§4.3 (drop cots tables after confirming empty in dev/demo DBs),
`ManufacturerPartService` (CRUD, list-by-part-master), routes
(`/api/v1/manufacturer-parts` + part-scoped list), AML section on the part detail page
(table + add/edit dialog, qualification status badges, preferred toggle). No tests
(CRUD, no gate). **Acceptance:** a part shows its approved sources with status; the
Yamaha-350XYZ single-source case is one AML row, not a mirror item.

### Phase 2 — PhysicalPart item type

Table §4.4, lifecycle + seed, registry entry, type handler,
`PhysicalPartService.register(partMasterId, {serialNumber|lotNumber}, opts)` with
find-or-create semantics validating `trackingMode`, `PP-######` numbering, routes
(`/api/v1/physical-parts`: register, get, search by serial/lot/part, state transition),
Form/Table/Detail components, `/physical-parts` pages, sidebar entry (Manufacturing
group). **Tests (data-integrity gate):** register is atomic across `items` +
`physical_parts`; concurrent/repeated register yields exactly one record per
(partMaster, serial). **Acceptance:** the customer's day-one flow — create lot for
feedstock X, drag cert PDFs onto it — works end to end.

### Phase 2.5 — Work Order promotion (parallel with 1–2)

Migration per §4.5 (SQL data migration inside the drizzle migration: insert `items`
rows reusing WO ids, move fields, drop old columns/table shape, re-point executions FK).
`WorkOrderService` becomes a facade over `ItemService` + type handler; routes and UI
(`WorkOrderTable/Form/StatusActions`, pages) updated; status transitions ride the
lifecycle. Registry entry per §5. **Tests:** the migration is exercised against seeded
legacy rows (data-integrity gate: no orphaned executions, numbers/states preserved).
**Acceptance:** existing WO list/detail/status flows work unchanged; WOs now hold vault
attachments; `GET /api/v1/thread/:itemId` accepts a WO id without erroring.

### Phase 3 — Consumption (the MES verb)

`WorkOrderMaterialService.consume(workOrderItemId, entry, userId)` — transactional,
branched on the part's `trackingMode`:

- `serial` → `PhysicalPartService.register` (register-on-consumption: the serial springs
  into existence at first scan), reject if state ≠ Available, transition → Consumed,
  create `Consumes` edge qty=1.
- `lot` → find-or-create lot PhysicalPart, create/increment `Consumes` edge with qty.
- `none` → `Consumes` edge WO → current part version row with qty.
  Plus `remove()` (delete edge, revert unit state). Endpoints:
  `GET/POST/DELETE /api/v1/work-orders/:id/materials`. Materials section on the WO page,
  scan-first entry (part picker → serial/lot input → qty where applicable).
  **Tests (mandatory, data-integrity gate):** double-consume of a serial rejected; exactly
  one PhysicalPart per (part, serial) ever exists; remove restores Available; edge + state
  change are atomic (crash between = neither). **Acceptance:** "project Y indicates it
  used feedstock X" is a 10-second scan at the bench.

### Phase 4 — Production + genealogy

WO completion flow: for serial-tracked built parts, completing units prompts bulk serial
entry → `PhysicalPartService` creates units with `producingWorkOrderId`,
`asBuiltItemId` = the part version resolved via `VersionResolver` at completion, and
`Produces` edges. `GenealogyService`: recursive derived traversal (both directions),
where-used/recall endpoints (`/api/v1/physical-parts/:id/genealogy`,
`/api/v1/physical-parts/where-used?serial=…&lot=…`). Genealogy tab on PhysicalPart
detail; Units tab on part detail. **Tests (complex-algorithm gate):** traversal
invariants over a fixture chain (feedstock lot → component WO → component units →
assembly WO → assembly unit); recall query returns every ancestor end-item.
**Acceptance:** "which end items contain lot L?" is one query.

### Phase 5 — Digital thread + qualification rollup

`ThreadService`: add `physical` domain — WO and PhysicalPart nodes, Consumes/Produces
edge traversal, domain mapping; fifth swim lane in `DigitalThreadNavigator`. `Evidences`
edges: attach/review flow on PhysicalPart detail linking a cert file to a Requirement.
**Qualification rollup view** (per design or per WO): every requirement flowing into
consumed materials, satisfied where an Evidences edge exists, **flagged where a consumed
material carries no evidence**. Optional: seed expected materials from `MbomService`
for expected-vs-actual display. One Playwright E2E: create WO → consume serial + lot →
complete with produced serials → verify genealogy page and qualification rollup.
**Acceptance:** the customer story, verbatim, demonstrated in the graph view.

---

## 7. Deferred (deliberately out of scope)

- ERP integration: read-through on-hand quantities, serial/lot reconciliation (Odoo
  first — QuickBooks Online cannot track serials/lots natively, which is exactly why
  capture-at-execution lives in Cascadia), `erpRef` population.
- Explicit receiving/import flow (v1: manual lot registration + register-on-consumption).
- Per-unit material allocation within a multi-unit WO.
- ECO-gated AML changes; automated cert-to-requirement verification.
- Field-service events / full unit history records beyond state + attachments.

## 8. Implementation record

Shipped as one pull request per phase — the proposal, then Phases 0 through 4,
with Phase 5 folded into the closing one. Deviations from the plan as written:

- **Lifecycle ids:** `…112` was already claimed by ChangeOrderService.test.ts
  as a private test workflow id; PhysicalPart took `…113`, WorkOrder `…114`.
- **Free-lifecycle transitions:** the workflow-engine remediation (merged
  mid-flight) closed direct `state` writes through `ItemService.update`.
  UI-driven transitions ride `LifecycleService.transitionFreeItem`; the
  consumption compare-and-set is an engine-level write in the same class as
  change-order release, documented in `WorkOrderMaterialService`, and the
  transition endpoint's state adoption reconciles it.
- **Migrations:** committed migrations returned in v0.5 (they are the
  upgrade path for released installs); during this effort all schema changes
  ship in `schema.ts` + `seed-minimal.ts`, and the dev DB was transformed in
  place (WO ids reused as item ids, so execution rows needed no rewrite).
- **Thread swim lane:** deferred out of Phase 5 (`ThreadNode` hard-required
  design context that design-less WOs and PhysicalParts lack), then landed
  as the follow-up. The contract now carries nullable design fields and a
  fifth `physical` ThreadDomain. Traversal: from a Part focal item, bulk
  `Consumes` edges targeting any lineage version row (re-pointed onto the
  focal node) plus the lineage's instances (synthetic `INSTANCE_OF` edges),
  then each instance's producing/consuming WOs; from a WO or PhysicalPart
  focal item, both directions plus a synthetic `BUILDS`/`INSTANCE_OF`
  bridge into the design lanes; `Evidences` edges pull requirements when
  that domain is requested — the verbatim requirement → lot walk. Context
  threads carry an empty physical lane (physical reality does not
  time-travel), so ECO comparisons are unaffected. The navigator renders
  the lane (emerald) and is now mounted on WO and PhysicalPart pages;
  material/evidence writes invalidate cached threads (awaited, so the bench
  flow reads its own writes — this also surfaced and fixed a latent
  serialization bug that had silently prevented thread caching from ever
  persisting). Per-unit as-designed vs as-built shipped with it:
  `GET /api/v1/physical-parts/:id/as-built-comparison` diffs the BOM at
  the unit's as-built pin (version-row-pinned, no commit walk needed)
  against the producing WO's consumption at batch-level quantity precision.
- **E2E landed with the thread follow-up:**
  `tests/e2e/workflows/physical-traceability.spec.ts` — create WO, consume
  a serial and a lot, record produced serials, then verify the genealogy
  page, the qualification rollup flagging the uncertified lot, and the
  thread's physical lane on the built part. Service-level integration
  tests (27 across Phases 2–5, plus the thread traversal suite) cover the
  flows underneath.

## 9. Risks & notes

- `items` unique constraint `(itemNumber, revision, designId, itemType)` does not bind
  when `designId` IS NULL (Postgres NULLs-distinct). Tasks/Issues already live with
  this; PhysicalPart/WorkOrder numbering is sequence-generated, so collisions are
  practically excluded. Revisit with `NULLS NOT DISTINCT` if it ever bites.
- Consumption edges rely on service-level invariant enforcement (generic edge table has
  no typed constraints). All writes must flow through `WorkOrderMaterialService`;
  reviews should reject direct `item_relationships` writes for these types.
- WO-level genealogy precision (documented above) is a known v1 simplification.
- `docs/development/adding-item-types.md` predates the `item-type-definitions.ts` +
  `type-handlers/` registration pattern; update it alongside Phase 2.

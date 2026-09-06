# Product Variants: Implementation Plan

**Status:** executed 2026-09-05 as six commits on one branch; see
[`docs/features/product-variants.md`](../features/product-variants.md). Kept
as the record of the sequencing and the field lists that had to be swept.

Everything lands in `packages/core`. Six pull requests, each shippable on its
own, each a schema _addition_ that changes nothing for a design that never
creates an option family.

| PR  | Delivers                                                                | Size     |
| --- | ----------------------------------------------------------------------- | -------- |
| 0   | `startAt` on numeric revision schemes                                   | ½ day    |
| 1   | `item_relationships.option` and every path that copies or reads a line  | 2–3 days |
| 2   | `parts.option_model`, `parts.makes`, condition validation, `lint`       | 2 days   |
| 3   | UI: BOM row popover, Option column, Variants tab, Configurable badge    | 3–4 days |
| 4   | Resolver, `resolve` endpoint, live preview, save-as-make, per-make view | 2–3 days |
| 5   | MBOM derivation with a configuration                                    | 2 days   |

Roughly three weeks of focused work. PRs 1 and 2 are backend-only and can be
reviewed without running the UI. PR 3 is the first thing a user sees.

---

## Ground rules that apply to every PR

- **Schema change workflow** (`docs/development/database-patterns.md`): edit
  the schema, `npm run db:push`, then mint migrations for _both_ editions and
  commit both `apps/*/drizzle/` directories:

  ```bash
  npm run db:generate
  CASCADIA_APP=cascadia npm run db:generate
  ```

  Both editions are at `0003_software_external_source`; PR 1 mints `0004_*`.
  `npm run test:db:push` after every schema change or the suite fails locally.

- **Route changes** regenerate the OpenAPI snapshot and the generated client
  types, both CI gates:

  ```bash
  npm run openapi:snapshot
  ```

- **Hand-maintained field lists are the risk.** The reports below name every
  allowlist that would silently drop the new columns. Each PR's checklist is
  the list of those sites; a PR is not done until every one is touched or
  explicitly confirmed generic.

- **Tests follow the three-gate rule.** Each PR names the invariant tests it
  owes. UI and delegating routes get none.

- **Component size** (`docs/development/ui-components.md`): `StructureTab.tsx`
  is 1362 lines and `PartDetail.tsx` is 964. Touching either means extracting
  the region touched, not adding to it.

- **Vocabulary in code.** `option` (the condition on a line), `optionModel`
  (families and constraints on a part), `makes` (named configurations),
  `selections` (a flat map in flight), `configuration` (selections plus the
  make code they came from, as recorded on an MBOM). No "variant" identifier
  anywhere except the UI tab label and `VariantService`.

---

## PR 0: `startAt` on numeric revision schemes

Independent of everything else; take the contributor's change with tests.

| File                                                                | Change                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/core/src/lib/types/lifecycle.ts:53-57`                    | `numeric` and `prefixed-numeric` arms gain `startAt?: number`                  |
| `packages/core/src/lib/api/schemas.ts:732-737`                      | `revisionSchemeSchema` arms gain `startAt: z.number().int().min(0).optional()` |
| `packages/core/src/lib/services/RevisionService.ts:36-70`           | `getInitialRevision` and the two numeric `next*` helpers honour it             |
| `packages/core/src/components/workflows/RevisionSchemeSelector.tsx` | A "Start at" number input beside the prefix; preview uses it                   |
| `RevisionService.test.ts`                                           | `R0 → R1 → R2` and default-unchanged cases                                     |

Default stays 1. No migration.

---

## PR 1: the `option` column on BOM lines

### Schema

`packages/core/src/lib/db/schema/items.ts`, `itemRelationships` (line 645):

```ts
option: jsonb('option').$type<OptionCondition>(),   // null = fixed line
```

`OptionCondition` is declared in a new `packages/core/src/lib/types/variants.ts`
with **no database imports**, so both bundles can use it:

```ts
export interface OptionCondition {
  all: Array<{ family: string; values: Array<string> }>
}
```

**Uniqueness.** The current constraint at `items.ts:693` is
`unique(sourceId, targetId, relationshipType)`. Postgres never collides NULLs,
so simply appending `option` would let two fixed lines duplicate. Replace it
with two partial unique indexes:

```ts
uniqueIndex('item_relationships_fixed_edge_unique')
  .on(table.sourceId, table.targetId, table.relationshipType)
  .where(sql`${table.option} IS NULL`),
uniqueIndex('item_relationships_option_edge_unique')
  .on(table.sourceId, table.targetId, table.relationshipType, table.option)
  .where(sql`${table.option} IS NOT NULL`),
```

Both names keep the `item_relationships_` prefix that
`isUniqueViolation(error, { table: 'item_relationships' })`
(`packages/core/src/lib/errors/pg.ts:147`) matches on. `db:push` does not
rewrite predicate-only index changes on a long-lived dev database; the minted
migration carries the explicit `DROP`/`CREATE`, and the dev workflow note in
`database-patterns.md` covers applying it by hand.

**Canonical form.** Equality on a jsonb index is byte-for-byte, so the service
normalises every condition before write: families sorted by code, values
sorted and de-duplicated, empty families rejected. `normalizeOptionCondition()`
lives beside the type and is the only writer path.

### Write paths (allowlists to extend)

| Site                                                                                                 | Change                                                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ItemRelationshipService.addRelationship` (`:586-646`)                                               | `data.option?`; duplicate pre-check compares normalised option too                   |
| `ItemRelationshipService.addRelationshipBatch` (`:729-853`)                                          | per-line `option`; `edgeKey` (`:464-478`) includes the canonical JSON                |
| `ItemRelationshipService.updateRelationship` (`:1105-1147`)                                          | `option` updatable (null clears); field-change bookkeeping (`:1180-1240`) records it |
| `ItemService.addRelationship` (`:1179-1199`)                                                         | pass-through                                                                         |
| `routes/items/detail.ts` `addRelationshipSchema` (`:617-631`)                                        | `option: optionConditionSchema.nullish()`                                            |
| `routes/relationships.ts` `relationshipDataSchema` (`:30-45`), `relationshipEditSchema` (`:405-412`) | same                                                                                 |

`optionConditionSchema` is a Zod schema in `lib/types/variants.ts` with the
normalising transform. PR 1 validates shape only; PR 2 adds "family exists on
the parent".

### Copy paths (would otherwise drop the column)

| Site                                                                | Nature                                    |
| ------------------------------------------------------------------- | ----------------------------------------- |
| `ItemRelationshipService.copyRelationshipsToItem` (`:545-574`)      | checkout, revise, rebase, pull: hand list |
| `ChangeOrderMergeService` (`:2146-2157`)                            | release onto released item: hand list     |
| `MbomService.copyEbomStructureInternal` (`:529-546` and `:550-566`) | two inserts, hand list                    |
| `UsageService.createUsageSubtree` (`:663-688`)                      | hand list                                 |
| `jobs/node-handlers/design-clone.ts` (`:404-437`)                   | two branches, hand list                   |

Add `option: rel.option` to each. A short test in `ChangeOrderMergeService`'s
suite asserts the invariant: a conditioned line on an ECO branch is still
conditioned on the released revision.

### Conflict detection

`packages/core/src/lib/services/item-structure.ts:44-50`: the signature becomes
`targetId:quantity:findNumber:canonicalOption`. Without this, an option-only
edit on two branches merges silently. Test: two branches setting different
conditions on the same line report a `BOM structure` conflict (data-integrity
gate).

### Read paths

| Site                                                                                   | Change                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/core/src/lib/types/bom.ts:20-58` `BOMTreeNode`                               | `option?: OptionCondition \| null` per child                       |
| `routes/designs.ts` structure endpoint (`:2313-2322`, `:2367-2375`, `:2504-2509`)      | thread `option` through `childrenMap` into `buildNode`             |
| `EcoStructureService` (`:438-443`, `:472-520`)                                         | same                                                               |
| `lib/query/options/relationships.ts` `buildTreeNode` (`:226`)                          | same                                                               |
| `ItemRelationshipService.getRelationshipsWithDetails` (`:190-222`)                     | already `select()`; only the TypeScript `Relationship` type widens |
| `GraphService` edge data (`:77-91`, `:688-712`, `:929`)                                | carry `option`                                                     |
| `ThreadComparisonService` (`:709-719`)                                                 | diff `option` alongside quantity                                   |
| `components/bom/exportBomTree.ts`                                                      | `option` column rendered as `color=black; display=yes`             |
| AI `get_bom` (`ai/tools/definitions.ts:171-210`, `handlers.ts:~432`)                   | children carry `option`                                            |
| AI `create_relationship` (`write-definitions.ts:264-290`, `write-handlers.ts:783-794`) | accepts `option`                                                   |

### Import

| Site                                                                                       | Change                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `lib/import/field-configs/part-fields.ts` (after `:240`)                                   | `option` column, aliases `option`, `condition`, `applies to` |
| `lib/import/types.ts` `BomRelationship` (`:117-126`), `bomRelationshipSchema` (`:228-234`) | `option?: string`                                            |
| `lib/import/bom-parser.ts` (`:104-126`, `:174-189`)                                        | read `mappedData.option`                                     |
| `routes/import.ts` (`:529-540`)                                                            | parse the text form into a condition and pass it             |

Text form for CSV and chips: `color=black; display=yes,no`. Families separated
by `;`, values by `,`. One parser in `lib/types/variants.ts`,
`parseOptionText()` / `formatOptionText()`, used by import, export and the UI.

### Explicitly unchanged in PR 1

Where-used, ancestors, impact assessment, `WorkOrderInstructionService.populate`
and the ERP connector read the 150 % BOM. That is the intended conservative
default until PR 4 gives them a configuration to resolve against.

### Tests owed

- `item-structure.test.ts`: signature differs when only `option` differs.
- `ChangeOrderMergeService` suite: option survives checkout and release.
- `ItemRelationshipService` suite: two lines, same child, different options,
  both insert; same child, same option, rejected; fixed duplicate rejected.

---

## PR 2: option model and makes on the Part

### Schema

`packages/core/src/lib/db/schema/items.ts`, `parts` (line 150):

```ts
optionModel: jsonb('option_model').$type<OptionModel>(),
makes: jsonb('makes').$type<Array<Make>>(),
```

Shapes and Zod in `lib/types/variants.ts` (already created in PR 1):

```ts
interface OptionModel {
  families: Array<{
    code: string
    name: string
    required: boolean
    values: Array<{ code: string; label: string }>
  }>
  constraints: Array<{
    when: OptionCondition
    require: OptionCondition
    message: string
  }>
}
interface Make {
  code: string
  name: string
  selections: Record<string, string>
  active: boolean
}
```

Family and value codes: `^[a-z0-9][a-z0-9_-]*$`, lower-cased on save, unique
within their scope. Make codes: free text, unique per part, trimmed. Nothing
enforces `MK`.

### Part plumbing (all hand-maintained)

| Site                                                                              | Change                                                                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `lib/items/types/part.ts` `Part` interface (`:19-35`) and `partSchema` (`:38-50`) | `optionModel`, `makes` optional                                              |
| `lib/api/schemas.ts` `partUpdateSchema` (`:82-106`)                               | both, `.nullable().optional()`                                               |
| `lib/items/type-handlers/part.ts` `insert` (`:12-29`), `update` (`:41-66`)        | both columns; the merge write-back and `revise()` go through these           |
| `jobs/node-handlers/design-clone.ts` (`:530-548`)                                 | both columns (this list also omits `trackingMode` today; fix in passing)     |
| `lib/items/type-handlers/copy.ts`                                                 | generic, nothing to do; confirm in review                                    |
| `ConflictDetectionService`                                                        | generic `JSON.stringify` compare; the normalised write order keeps it stable |

Writes go through the ordinary `PUT /api/v1/items/:id` with `partUpdateSchema`,
so the edit guard, checkout requirement and commit field-change bookkeeping
apply with no new route. The proposal's separate `option-model` and `makes`
endpoints collapse into this.

### Validation on write

- `partUpdateSchema` refinement: family codes unique; every constraint and
  every make references declared families and values; a make with `active`
  and missing required families is rejected.
- `ItemRelationshipService.addRelationship` / `updateRelationship`: when
  `option` is non-null, load the **source part's** `optionModel` and require
  every family and value to be declared there. A part with no option model
  cannot carry conditioned lines. `ValidationError` with `field: 'option'`.
- Removing a family or value that a line still uses is rejected by the same
  check run in reverse from `partUpdateSchema`'s service-side validator
  (`ItemService.update` for Parts): query outgoing BOM lines with a non-null
  option and diff. This is what keeps the model and the lines consistent
  without a foreign key.

### `VariantService` (new, `packages/core/src/lib/services/VariantService.ts`)

PR 2 ships two of its methods; PR 4 adds `resolve`.

```ts
static async validateSelections(itemId, selections, tx?): Promise<{ errors; warnings }>
static async lint(itemId, tx?): Promise<Array<LintFinding>>
```

`lint` findings: undeclared family on a line (should be unreachable after the
write check, kept as a safety net), declared value used by no line and no
constraint, make incomplete or constraint-invalid, child configurable declares
a family the top-level model never sets (needs the BOM walk; PR 2 implements
it non-recursively for direct children and PR 4 extends it).

### Routes (new file `packages/core/src/server/routes/variants.ts`, tag `Variants`)

```text
POST /api/v1/parts/:id/variants/validate   { selections }          permission parts:read
GET  /api/v1/parts/:id/variants/lint                                 permission parts:read
```

Mounted in `server/index.ts` under `/api/v1/parts`. Both are read-only and
resolve the part at the caller's branch context using the same query params
the relationships endpoints accept.

### Tests owed

- `VariantService.test.ts`: `validateSelections` for required-missing,
  out-of-domain, constraint violation, warning severity.
- `ItemRelationshipService` suite: conditioned line rejected when the parent
  has no model or lacks the family; accepted otherwise.
- `ItemService` suite: removing a used family is rejected.

---

## PR 3: UI

Nothing here appears until a part has an option model, except the one icon.

### BOM row icon and popover

- `components/items/part-relationships/TableView.tsx:231` `actions` column
  gains a third ghost button (`SlidersHorizontal` icon, tooltip "Option
  condition"). It opens `OptionConditionPopover` (new,
  `components/variants/OptionConditionPopover.tsx`, built on `ui/Popover.tsx`
  and the `MultiSelectFilterContent` pattern from `ui/ColumnFilter.tsx`).
- The popover lists the parent part's families as sections with value chips.
  A "New family" row creates one inline: code, name, values. Saving the first
  family calls `PUT /items/:id` with `optionModel` and then
  `PUT /relationships/:id` with `option`. Both go through
  `useResourceMutation` with `invalidates: ['relationships', 'parts']`.
- `EditRelationshipDialog.tsx:24` `EditableRelationship` widens with
  `option`; the dialog shows the current condition read-only with a link to
  the popover, so the two editors never disagree.
- Read-only mode (`readOnly` on `PartRelationshipsPanel`) shows chips only.

### Option column

- `TableView.tsx`: new `option` column between `referenceDesignator` and
  `actions`, `filterType: 'multiSelect'` over the distinct family=value pairs
  plus a `fixed` pseudo-value. Chips via `ui/Badge.tsx`, text form from
  `formatOptionText()`.
- `components/items/part-relationships/BomView.tsx:43` (tree, per-part page):
  same column through `BomTreeView`'s `ColumnDefinition`.
- `components/designs/StructureTab.tsx:355`: **refactor-on-touch.** Extract the
  column definitions into `StructureTabColumns.tsx` and add the Option column
  there; the 1362-line file shrinks rather than grows.
- Column is hidden when no line in the table has an option and the part has
  no model.

### Variants tab on the part page

- `components/parts/PartDetail.tsx:116` `PART_DETAIL_TABS` gains `'variants'`;
  `tabGridCols` accounts for it; the trigger is gated on
  `currentPart.optionModel` the way `hasGallery` gates the gallery tab.
- **Refactor-on-touch:** extract the Relationships tab body (`:859-904`) into
  `PartRelationshipsTab.tsx` in the same PR, and add the new tab as
  `components/variants/PartVariantsTab.tsx` from the start.
- PR 3's tab shows: the option model editor (families, values, constraints,
  using `ui/view-edit-field.tsx` conventions and the same edit-mode gating as
  `PartManufacturingCard`), the makes list (code, name, selections, active),
  and lint findings from `GET .../variants/lint`. Preview and resolution
  arrive in PR 4.

### Badges

- Header (`PartDetail.tsx:530-565`): `Badge variant="outline"` "Configurable"
  when `optionModel` is present.
- `PartTable.tsx:135`: a `configurable` boolean column, `filterType: 'select'`,
  rendered as the same badge; the list query already returns part fields.

### Query layer

No new resources. `parts` already invalidates `relationships` and `mbom`;
`relationships` already reaches `parts`, `designs`, `items`. The lint and
validate endpoints use `qk.sub('parts', id, 'variants', ...)` keys in a new
`lib/query/options/variants.ts`.

### Tests owed

None. Everything here delegates.

---

## PR 4: resolution

### `VariantService.resolve`

```ts
static async resolve(
  itemId: string,
  selections: Record<string, string>,
  context: { branchId?: string; commitId?: string },
  tx?,
): Promise<ResolvedBom>
```

1. `VersionResolver.getItemAtContext` for the root; `validateSelections`
   first, return errors without a tree if any are `error` severity.
2. Load outgoing BOM lines at context via
   `ItemRelationshipService.getRelationshipsWithDetailsForBranch` (`:353-455`).
3. Keep a line iff `option` is null or every `all` entry's family is in
   `selections` with a value in its list. An absent family fails.
4. Recurse into each kept child with the **same** `selections`. A child with
   its own `optionModel` validates the map against its own required families;
   a failure there is reported as a finding on the child, not thrown.
5. Depth cap reuses the structure endpoint's `maxDepth`. Cycle guard by
   master id, as `findAncestorChain` does.
6. Return `ResolvedBom`: a `BOMTreeNode` tree where every node carries
   `admittedBy: OptionCondition | null`, plus `findings`.

Pure function core: `filterLines(lines, selections)` in `lib/types/variants.ts`
with no I/O, so the unit tests need no database.

### Routes

```text
POST /api/v1/parts/:id/variants/resolve   { selections } | { makeCode }, ?branch, ?commit
```

`makeCode` looks the make up on the part at context and uses its selections.

### UI

- `PartVariantsTab.tsx`: one `ui/Select.tsx` per family, live
  `validate` on change, live `resolve` rendered with `BomTreeView` (reusing
  `BomView`'s columns plus an "Admitted by" column), **Save as make** (appends
  to `makes` through `PUT /items/:id`), **Load make**, and a **Create MBOM**
  button that opens `CreateMbomDialog` prefilled (wired in PR 5).
- `TableView.tsx` Option column filter gains "Show make…" which applies
  `filterLines` client-side to the flat list.

### Tests owed (complex-algorithm gate)

`variants.test.ts` on `filterLines`: fixed lines kept; single family match;
AND across families; OR within a family; absent family fails; empty
selections keep only fixed lines. `VariantService.test.ts` on `resolve`:
recursion passes the flat map; child model finding reported; branch context
respected (a condition edited on an ECO branch resolves differently on main).

---

## PR 5: MBOM derivation with a configuration

### Schema

`packages/core/src/lib/db/schema/designs.ts`:

```ts
configuration: jsonb('configuration').$type<{
  rootItemId: string; makeCode: string | null; selections: Record<string, string>
}>(),
```

Folded into the single `0004_product_variants` migration with the PR 1 and PR 2 columns.

### Service

`MbomService.createMbomSchema` (`:35-50`) gains:

```ts
configuration: z.object({
  rootItemId: z.string().uuid(),
  makeCode: z.string().optional(),
  selections: z.record(z.string(), z.string()).optional(),
}).optional()
```

In `createFromEbom`:

- Resolve `selections` from `makeCode` if given (the make must exist on the
  root part at the source commit). `validateSelections`; errors fail the
  request with `ValidationError` before any write.
- Store `configuration` on the `designs` insert (`:163-178`).
- In `copyEbomStructureInternal` (`:460-568`): after the BOM select at
  `:490-498`, run `filterLines` per source part. Kept lines insert with
  `option: null`, `derivationMethod: 'direct'`, and `derivationNotes` set to
  the text form of the admitting condition. Dropped lines are counted and
  returned in the result as `linesFiltered`. Items that become unreachable
  after filtering are still copied (the MBOM owner may want them); a follow-up
  can prune.
- Copied `parts` rows get `optionModel: null` and `makes: null`.
- `renumberItemNumber` (`:291-301`) accepts an optional suffix; when a
  `makeCode` is present the root item is renumbered `${itemNumber}${makeCode}`
  after the existing suffix rewrite. Nothing else is renumbered by make.

### Upstream changes

`notifyDerivedMboms` (`:799-834`) is unchanged: it records the changed items.
`getPendingUpstreamChanges` (`:692-743`) gains, for a design with a
`configuration`, a re-run of `resolve` at the new commit and a per-change
`stillSelected: boolean` so the review UI can say "this line changed but your
make never used it".

### UI

- `CreateMbomDialog.tsx:38` props gain `configuration?`; when present the
  dialog shows a read-only "Configuration" block (make code and selections)
  and sends it in the POST body (`:92`). Launched prefilled from the Variants
  tab; the design page's existing launch sends none.
- The design page for a Manufacturing design shows its configuration in the
  header next to the source tag.

### Tests owed (data-integrity gate)

`MbomService.test.ts`: derived design contains exactly the fixed lines plus the
admitted lines, all with `option` null; `derivationNotes` names the
condition; `parts.optionModel` is null on copies; `designs.configuration` is
recorded; an invalid selection fails before any row is written.

---

## Follow-ups after PR 5, not scheduled

- **Work orders on a configurable EBOM part.** `WorkOrderInstructionService.populate`
  (`:212-241`) walks the 150 % BOM. Either require a `makeCode` on the work
  order for configurable parts or point work orders at the MBOM. Decide when
  a user hits it.
- **AI resolve tool.** `resolve_variant` on the read registry, thin over
  `VariantService.resolve`.
- **Pruning unreachable items** in a configured MBOM.
- **Ad-hoc saved configurations** that are not makes (order bookmarks), a
  master-keyed table outside ECO control.
- **Docs:** `docs/features/product-variants.md` written with PR 3, linked from
  `docs/README.md` and `cascadia-feature-list.md`; the BOM import section of
  `docs/features/import-export.md` gains the `option` column with PR 1.

# Product Variants

Product variants let one Part describe a family of products that share most
of their structure and differ in a few selectable options: a touch switch in
black or white, with or without a display. The Part's BOM holds every line
the family can use (a "150 % BOM"); each line is either fixed or carries an
**option condition** saying which selections put it in the product. A named,
complete set of selections is a **make**. Resolving selections against the
BOM yields the 100 % BOM of one product, transiently for preview, or
persistently as a Manufacturing design.

Nothing here adds a new versioned object. The option model and makes ride the
Part version, conditions ride the BOM line, and both already get checkout,
ECO merge, conflict detection and time travel. Two makes of one Part can never
show different revisions because there is only one revisioned thing.

Design rationale and the decisions behind this shape are in
[`docs/proposals/product-variants.md`](../proposals/product-variants.md).

---

## Vocabulary

| Term                 | Meaning                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **Option family**    | A named variable with a value domain, e.g. `color ∈ {black, white}`. Declared on a Part.    |
| **Option model**     | A Part's families plus constraints between them. A Part with one is _configurable_.         |
| **Option condition** | On a BOM line: the selections that admit it. Null means the line is fixed (always present). |
| **Selections**       | One flat map of family code → value code, e.g. `{ color: 'black', display: 'yes' }`.        |
| **Make**             | A named, complete, constraint-valid set of selections stored on the Part.                   |
| **Constraint**       | "When these selections are made, these others are required."                                |
| **Resolve**          | Filter the 150 % BOM by selections into the 100 % BOM, recursively.                         |
| **Configuration**    | Selections plus the make they came from, as recorded on a Manufacturing design.             |

Family and value codes are lower-case identifiers (`^[a-z0-9][a-z0-9_-]*$`).
Make codes are free text. Nothing enforces any particular numbering scheme.

## Data model

Three nullable columns on existing tables; no new tables:

```text
parts.option_model            jsonb   families and constraints
parts.makes                   jsonb   named selections
item_relationships.option     jsonb   condition on a BOM line; null = fixed
designs.configuration         jsonb   how a Manufacturing design was resolved
```

Shapes (`packages/core/src/lib/types/variants.ts`):

```ts
interface OptionCondition {
  // ALL families must match; within a family ANY listed value matches.
  all: Array<{ family: string; values: Array<string> }>
}

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

Conditions are stored in canonical form (families sorted by code, values
sorted and de-duplicated), so two equal conditions serialise identically. The
text form used by CSV import and export, tooltips and the AI tools is
`color=black; display=yes,no`: families separated by `;`, values by `,`.

### Edge identity

A BOM edge is `(source, target, type, option)`. One child may appear on a
parent's BOM under two different conditions with different quantities; it
still cannot appear twice as a fixed line or twice under the same condition.
Postgres never equates NULLs, so this is two partial unique indexes on
`item_relationships` rather than one constraint:

- `item_relationships_fixed_edge_unique` on `(source, target, type) WHERE option IS NULL`
- `item_relationships_option_edge_unique` on `(source, target, type, option) WHERE option IS NOT NULL`

### What travels with a condition

A condition is a column on the line, so it goes wherever the line goes:
checkout and revise (`copyRelationshipsToItem`), ECO release, MBOM
derivation, usage copy, design clone. It is part of the BOM structure
signature that conflict detection and the merge pre-flight compare, so an
option-only edit on two branches is a structure conflict. It appears in the
design structure endpoint, the change-order structure, the relationship
graph, the digital thread and its comparison, the CSV export, and the
`get_bom` AI tool.

### Write rules

- A line's condition may only name families and values its **parent part
  declares**. A part with no option model cannot carry conditioned lines.
- An option-model write that would strand a conditioned line (removing a
  family or value a line uses, or removing the model) is refused.
- A make must be complete (every required family selected), in-domain and
  constraint-valid, or the write is refused.
- All three are content edits of the Part, so they need the same checkout and
  branch protection as a quantity edit.

## Resolution

`VariantService.resolve(itemId, selections, { branchId? })` walks the BOM at
the given branch context and keeps a line iff its condition is null or every
family in it has its selected value in the family's list. A family absent from
the selections fails the condition, so an incomplete configuration resolves to
the fixed lines plus whatever it does name.

The same flat map is used at every level. A configurable child validates the
map against its own model, seeing only the families it declares; family codes
are a design-wide vocabulary by convention (`color` on the switch means
`color` on its board). `lint` warns when a child requires a family the root
never sets.

Where-used, impact assessment and the ordinary BOM views read the 150 % BOM.
That is the conservative default: a change to the white housing reaches the
switch, which is correct, because a white make exists.

## Deriving a Manufacturing design

`POST /api/v1/mbom` accepts a `configuration`:

```json
{ "rootItemId": "…", "makeCode": "MK1" }
{ "rootItemId": "…", "selections": { "color": "black" } }
```

The selections are validated before any row is written. During the copy,
lines the selections do not admit are left out and counted as
`linesFiltered`; admitted lines are copied as fixed lines with the admitting
condition kept as the line's `derivationNotes`. The root part's item number
gets the make code appended (`P3001V1` + `MK1` → `P3001V1MK1`), which is where
a make becomes a manufacturable part number; nothing else is renumbered by
make. The design records its `configuration`, and upstream-change review on
such a design marks each changed item with `stillSelected`, so a change to a
line the make never used is visibly not its concern.

The EBOM-to-MBOM mapping is one to many: one Manufacturing design per make,
or per order for a configure-to-order shop. Both are the pattern Cascadia
already has for engineer-to-order; only the count differs.

## UI

A design without variants sees exactly one new thing: an option icon on each
BOM row of the relationships table. Its popover ticks the parent part's
option families onto the line, and can create a family inline, which is what
makes a part configurable. After that:

- **Option column** in the relationships table, the BOM tree and the design
  structure grid, as chips; a "Show BOM as" selector views the table as a
  make would resolve it, or fixed lines only.
- **Variants tab** on the part page: a configurator (one selector per
  family, live validation, live resolved-BOM preview, save-as-make, load a
  make, create an MBOM from the selections), the option model editor, the
  makes editor, and the lint findings.
- **Configurable badge** in the part header and the part table.
- The **MBOM dialog** shows the configuration it will derive with; the design
  header shows it afterwards.

Editing follows the click-Edit policy: the editors are read-only until the
page holds the edit lock.

## API

| Method | Path                                  | Purpose                                                      |
| ------ | ------------------------------------- | ------------------------------------------------------------ |
| PUT    | `/api/v1/relationships/:id`           | Existing; accepts `option` (null makes the line fixed again) |
| POST   | `/api/v1/items/:id/relationships`     | Existing; accepts `option`                                   |
| POST   | `/api/v1/relationships/batch-create`  | Existing; per-line `option`                                  |
| PUT    | `/api/v1/parts/:id`                   | Existing; accepts `optionModel` and `makes`                  |
| POST   | `/api/v1/parts/:id/variants/validate` | Check selections against the part's model                    |
| POST   | `/api/v1/parts/:id/variants/resolve`  | Resolve selections or a make code to a 100 % BOM             |
| GET    | `/api/v1/parts/:id/variants/lint`     | Consistency findings over model, makes and lines             |
| POST   | `/api/v1/mbom`                        | Existing; accepts `configuration`                            |

BOM import accepts an **Option Condition** column in text form; see
[Import/Export](./import-export.md#bom-import-fields).

## Modelling guidance

The system does not care whether a product line is one configurable Part with
several families or several Parts with one family each; the resolver treats
both alike. The split is a modelling choice about revisions:

- An option becomes its **own Part** when it changes engineering content that
  revisions on its own, carries its own files or certification, or needs its
  own lifecycle. A different PCB is usually a different Part.
- An option stays a **make** when it is a selection among already-engineered
  alternatives. Colour is usually a make.

The choice is not locked in: splitting later is an ECO that creates the new
Part and moves lines onto it, and merging is the reverse.

## Code map

| Concern                         | Where                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Types, canonical form, matching | `packages/core/src/lib/types/variants.ts`                                                                                               |
| Validation, lint, resolve       | `packages/core/src/lib/services/VariantService.ts`                                                                                      |
| Line write rules                | `ItemRelationshipService.assertOptionDeclared`, `edgeKey`                                                                               |
| Part write rules                | `VariantService.assertPartVariantWrite` (called from `ItemService.update`)                                                              |
| MBOM derivation                 | `MbomService.createFromEbom`, `copyEbomStructureInternal`                                                                               |
| Routes                          | `packages/core/src/server/routes/variants.ts`                                                                                           |
| UI                              | `packages/core/src/components/variants/`                                                                                                |
| Tests                           | `variants.test.ts`, `VariantService.test.ts`, `ItemRelationshipService.option.test.ts`, `item-structure.test.ts`, `MbomService.test.ts` |

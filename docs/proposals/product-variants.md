# Product Variants and Configure-to-Order

**Status:** implemented 2026-09-05; see
[`docs/features/product-variants.md`](../features/product-variants.md) for the
feature as shipped. Kept as the record of the reasoning.
**Prompted by:** public discussion
[Cascadia-App#95](https://github.com/Cascadia-PLM/Cascadia-App/discussions/95)
and the contributor's `feature/product-variants` branch (Kujoo25, commit
`234c76c`, 32 files).

## Summary

A **variant** is an ordinary revisioned Part whose BOM is a 150 % BOM: fixed
lines plus lines that carry an **option condition**. A **make** is a named
configuration of that Part, a set of selected option values, stored on the
Part version alongside its option model. Resolving a configuration filters the
150 % BOM down to a 100 % BOM, transiently for preview or persistently as a
**Manufacturing design** derived from the Engineering design with the
configuration applied. Nothing new is versioned: the option model and makes
ride the Part's extension row, the conditions ride the BOM edge, and both
already get checkout, ECO merge, conflict detection and time travel.

This dissolves the discussion's hardest rule (two makes of a variant must never
show different revisions) by construction: there is one revisioned thing.

Decisions taken, in order of the discussion that produced them:

| #   | Decision                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The option condition lives on the existing `BOM` edge as a nullable column. Null means fixed. No new edge type.                                   |
| 2   | The condition is a small structured value (all-of families, any-of values), not a single tag and not an expression language.                      |
| 3   | Option model and makes live on the Part version as jsonb on `parts`. No new part type. UI is gated on their presence.                             |
| 4   | A configuration is one flat map of family code to value; every configurable part in the tree reads the same map.                                  |
| 5   | Persisting a configuration means deriving a Manufacturing design. EBOM to MBOM is one to many; for configure-to-order that is one MBOM per order. |

---

## The request

The discussion describes a glass touch-switch product line: one housing in two
colours, one bottom PCB shared by every build, two top-PCB types (with and
without display), four glass front panels. That yields four variants (V1–V4,
differing in PCBs and glass) and, per variant, two makes (MK1 black, MK2
white). The customer's designation is `P3001 V1 R2 MK1`: family, variant,
revision, make. The PCBs repeat the pattern (`B3004 R2 MK1`: board revision,
population make). Their central rule: **the revision belongs to the variant,
not the make.**

Their thirteen requirements are checked against this model at the end of
[The model](#requirements-check).

## Vocabulary

The discussion's terms do not line up with Cascadia's. Mapping used throughout:

| Discussion term       | Cascadia term                                                                   |
| --------------------- | ------------------------------------------------------------------------------- |
| Project / Product     | Design (`Glass Touch Switch`)                                                   |
| Family (`P3001`)      | Not a thing. It is the item-number prefix the customer gives the variant parts. |
| Variant (`V1`)        | A Part, item number `P3001V1`, revisioned normally                              |
| Revision (`R2`)       | The Part's revision; `prefixed-numeric`, prefix `R`, with `startAt: 0`          |
| Make / Execution (MK) | A named configuration on the variant Part: selected option values               |
| Common BOM            | Fixed BOM lines (`option` is null)                                              |
| MK additions          | BOM lines with an option condition                                              |
| Resolved BOM          | A transient resolution, or a Manufacturing design when persisted                |

---

## What Cascadia has today

**BOM edges** live in `item_relationships` (`relationshipType = 'BOM'`) with
`quantity`, `findNumber`, `referenceDesignator`, and an unused `metadata`
jsonb. Edges hang off an item _version_. `copyRelationshipsToItem` (checkout)
and the ECO merge re-pointing both filter by source item only, not by type, so
**anything stored on a BOM line inherits branching, merge, conflict detection
and time travel.** The duplicate-edge check is on source, target and type.
Thirty-eight call sites in twenty files filter on the literal `'BOM'`,
including impact assessment, the conflict signature (`bomStructureOf`), the
same-design scope rule, usage copy, MBOM derivation and the ERP connector.

**BOM target scope** (`ItemRelationshipService.assertBomTargetScope`): a BOM
line may target a Part in the same design or in a Library design only.

**Manufacturing designs** (`MbomService.createFromEbom`) derive a whole design
from an Engineering design at a tag, copying items and BOM edges, recording an
`EBOM_SOURCE` relationship per item and a `derivationMethod` per line, and
tracking later EBOM releases in `upstream_changes` for accept/reject/defer
review. This is the existing "BOM derived from a BOM by rule" mechanism.

**Phantom parts** are a `partType` value with no special behaviour.

**Revision** is per item master, assigned at ECO merge, scheme per lifecycle.
Item numbers are free text; there is no numbering engine.

Nothing in the code or docs mentions variants, option models, or
configure-to-order.

---

## The model

### Data model

Three additive schema changes, all on existing tables:

```text
parts.option_model   jsonb  null   -- families, values, constraints
parts.makes          jsonb  null   -- named configurations
item_relationships.option  jsonb  null   -- condition; null = fixed line
```

Plus one constraint change: the duplicate-edge check (and any unique index)
becomes source, target, type **and option**, so one child can appear twice
with different quantities under different conditions.

Why the Part _version_ and not the master: the discussion requires that
changing a make is an ECO and that a released make is not editable without a
trace. Putting the option model and the makes on `parts` makes them content of
the variant Part. They are copied with the extension row on checkout, diffed
by field on merge, and a change to MK1's selections is a revision of
`P3001V1`, which is precisely the customer's rule. Ad-hoc saved configurations
(order bookmarks, quotes) are a different, later thing: a master-keyed table
that is deliberately not ECO-controlled. Not in scope here.

Shapes (Zod-validated, `packages/core/src/lib/items/types/part.ts`):

```ts
interface OptionModel {
  families: Array<{
    code: string // 'color', design-wide vocabulary
    name: string
    values: Array<{ code: string; label: string }>
    required: boolean
  }>
  constraints: Array<{
    // Same shape as a line condition: if `when` matches, `require` must too
    when: Condition
    require: Condition
    message: string
  }>
}

interface Condition {
  // ALL families must match; within a family ANY listed value matches.
  all: Array<{ family: string; values: Array<string> }>
}

interface Make {
  code: string // 'MK1'
  name: string // 'black'
  selections: Record<string, string> // family code -> value code
  active: boolean
}
```

`Condition` is deliberately tiny: AND across families, OR within one. It is
what a chip picker builds and it needs no parser. OR across families is a
second line. NOT is
"list the allowed values". A line's condition must reference only families
declared by the nearest configurable ancestor's option model; the save path
validates that and rejects unknown families or values.

### The 150 % BOM

```text
P3001V1  (option_model: color ∈ {black, white})
├─ B3001   bottom PCB               qty 1   option: null
├─ B3004   top PCB with display     qty 1   option: null
├─ H-100-BLK  housing, black        qty 1   option: { color: [black] }
├─ H-100-WHT  housing, white        qty 1   option: { color: [white] }
├─ G-D8-BLK   glass D8, black       qty 1   option: { color: [black] }
└─ G-D8-WHT   glass D8, white       qty 1   option: { color: [white] }

makes: MK1 { color: black }, MK2 { color: white }
```

`V2` is a different Part (`P3001V2`) with `B3004` and 7-button glass; `V3`/`V4`
carry `B3042`. The discussion's variants are separate Parts because they differ
in _design_ (which PCB), and its makes are configurations because they differ
in _selection_ (which colour). A customer who wanted `display` as an option
too would collapse V1–V4 into one Part with two families. Both are valid and
the model does not care.

`B3004` is itself configurable (population makes) with its own `option_model`
and its own conditioned lines, and it reads the same selection map.

### Resolution

`VariantService.resolve(itemId, selections, context)`:

1. Load the Part at the branch/commit context via `VersionResolver`.
2. Validate `selections` against the option model: required families present,
   values in domain, constraints satisfied. Return errors and warnings; never
   throw for user input.
3. Walk the BOM. A line with `option = null` is kept. A line with a condition
   is kept iff every family in `all` has its selected value in that family's
   list. A family absent from `selections` fails the condition.
4. Recurse into children. A configurable child evaluates its own lines against
   the **same flat map**. Family codes are a design-wide vocabulary by
   convention (`color` means the same thing on the switch and the board); the
   lint below flags a child family that the top-level model never sets.
5. Return the 100 % BOM tree with each kept line's quantity and the condition
   that admitted it.

`VariantService.lint(itemId)`: every condition references declared families
and values; every declared value is used by at least one line or constraint;
every make is complete and constraint-valid; no child family is unreachable
from the top-level model.

Where-used and impact assessment are unchanged and see the 150 % BOM. That is
the conservative default: a change to the white housing reaches `P3001V1`,
which is correct, because MK2 is a make of it. Quantity rollups and costing
also see 150 % unless given a configuration; the resolve endpoint is what
gives a per-make rollup.

### Persisting a configuration: the MBOM

`createMbomSchema` gains an optional `configuration`:

```ts
configuration?: {
  makeCode?: string                    // use a named make from the top part
  selections?: Record<string, string>  // or an explicit map (per-order CTO)
  rootItemId: string                   // the variant Part to resolve from
}
```

During the copy in `MbomService.createFromEbom`, for every copied BOM edge:
a null option copies as today; a satisfied condition copies with `option`
nulled, `derivationMethod = 'direct'` and a `derivationNotes` line naming the
condition that admitted it; an unsatisfied condition is dropped. The copied
`parts` rows have `option_model` and `makes` nulled. The Manufacturing design
records the selections (`designs.configuration` jsonb) and the source make
code, so `upstream_changes` review can re-run the resolution when the EBOM
releases a new revision and show which lines the make gains or loses.

The EBOM to MBOM mapping is one to many. Eight makes give eight MBOMs. A
configure-to-order shop gives one MBOM per order, each a full design with a
main branch and an initial commit, exactly the pattern Cascadia already has for
engineer-to-order; the "many" is simply larger.

The MBOM's top-level part is renumbered as today (`renumberItems`), with the
make code available to the numbering, which is where `P3001V1R2MK1` finally
becomes a real item number on a real manufacturable part. Work orders,
physical parts, and ERP connectors all attach to that part with no changes.

### Designation

On the Engineering side the designation is derived, never stored: item number,
revision, make code, `DRAFT` for an unreleased working copy. Take the
contributor's `startAt` change so `prefixed-numeric` can run `R0 → R1 → R2`.

### UI

Gated on presence, so a design with no variants sees nothing new:

- **BOM table, per row:** one icon, "add option condition". Its popover lists
  the families of the nearest configurable ancestor and lets the user create a
  family and values inline. Creating the first family is what makes the parent
  Part configurable. After that the BOM table shows an **Option** column with
  the condition as chips, filterable to "fixed only" (the 50 % BOM) or to a
  make.
- **Part page, when `option_model` exists:** a **Variants** panel with one
  selector per family, live validation, a live resolved-BOM preview, a list of
  named makes with **Save as make** and **Load**, and **Create MBOM** which
  opens the existing MBOM creation dialog with the configuration filled in.
  Lint results appear here. A `Configurable` badge appears in the part header
  and in part tables.
- **MBOM design page:** shows the configuration it was derived from.

Both panels register as slots.

### API

```text
PUT    /api/v1/relationships/:id                     already exists; accepts `option`
PUT    /api/v1/items/:id                             already exists; accepts `optionModel`, `makes`
POST   /api/v1/parts/:id/variants/validate           { selections }
POST   /api/v1/parts/:id/variants/resolve            { selections | makeCode, branch?, commit? }
GET    /api/v1/parts/:id/variants/lint
POST   /api/v1/mbom                                  already exists; accepts `configuration`
```

Option-model and make writes are ordinary item edits through the existing
item update route: same checkout and branch protection as any other Part
field. See [the implementation plan](./product-variants-implementation-plan.md).

### Delivery slices

| Slice | Delivers                                                                                                                        | Test gate                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1     | `startAt`; `item_relationships.option`; dedupe/unique on option; `bomStructureOf` hashes option; BOM row icon and Option column | data integrity (conflict signature) |
| 2     | `parts.option_model`, `parts.makes`, Zod shapes, validate, lint, Variants panel with preview                                    | complex algorithm (resolver)        |
| 3     | `resolve` with recursion and the flat map; per-make rollups                                                                     | complex algorithm                   |
| 4     | MBOM derivation with `configuration`; `designs.configuration`; upstream-change re-resolution                                    | data integrity                      |

Each slice ships on its own and every one is a schema addition, never a
change to existing rows. Existing installs see no behaviour change until a
user creates the first option family.

### Requirements check

Against the discussion's list:

| #    | Requirement                                       | This model                                                                                                                                                                                                        |
| ---- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Variant has stable identity and revision history  | It is a Part.                                                                                                                                                                                                     |
| 2    | Make belongs to a variant, no own revision        | It is a named configuration on the Part version.                                                                                                                                                                  |
| 3    | New variant revision applies to all active makes  | By construction; makes are content of the revision.                                                                                                                                                               |
| 4    | Full designation                                  | Derived on the EBOM; a real item number on the MBOM.                                                                                                                                                              |
| 5    | `R0 → R1 → R2`                                    | `startAt` on prefixed-numeric, from the contributor's branch.                                                                                                                                                     |
| 6    | Changing the common BOM needs a new revision      | Fixed lines are ordinary BOM edges under branch protection.                                                                                                                                                       |
| 7    | Changing a make is ECO-controlled                 | Makes are on `parts`; editing one is an item edit.                                                                                                                                                                |
| 8    | Where-used and impact on the resolved BOM         | On the 150 % BOM by default (conservative); per make via `resolve`.                                                                                                                                               |
| 9–11 | Impact reaches exactly the variants using a child | Unchanged behaviour; each variant is a Part with its own lines.                                                                                                                                                   |
| 12   | Migrate existing `P3001V1MK1` parts               | Existing make parts are already valid MBOM-style parts. Modelling the variant is: create `P3001V1`, move shared lines onto it, add colour lines with conditions, define two makes, in one ECO. No data migration. |
| 13   | Tests                                             | Per the slice table; three-gate rule applies.                                                                                                                                                                     |

---

## Assessment of the contributor branch

`feature/product-variants` adds four tables in core (`part_families`,
`part_variants`, `part_variant_executions`,
`part_variant_execution_bom_lines`), an 800-line `PartVariantService`, eight
routes, a 660-line panel, and touches checkout, merge, revise, conflict
detection, impact assessment and BOM structure comparison. The write-up is
careful and the author clearly read the merge and checkout code. It should
still not be merged, for four structural reasons:

1. **A second BOM store.** Make-specific lines live in a side table. Every BOM
   consumer must union two sources. The branch patches three of the thirty-odd
   and leaves the BOM tree, MBOM derivation, usage copy, clone, export, the
   ERP connector, the AI tools and reports silently blind to make lines. This
   proposal keeps one store and one column.
2. **Makes are not items and not content.** An execution is a snapshot row per
   variant _version_, copied by a new handler hook that every future
   version-creating path must remember. Because a make is not a Part, it
   cannot be work-ordered, serialised or sent to an ERP; the branch lists that
   as future work. Here the make is content of the variant Part, and the MBOM
   is where it becomes a manufacturable Part.
3. **Additive only.** A make can add lines but never replace one. The driving
   example only works because the housing is kept out of the common BOM. A
   condition per line expresses substitution directly.
4. **One company's nomenclature in core schema** as `^V…`/`^MK…` CHECK
   constraints. Here make codes are free text.

Worth taking on its own: **`startAt` on numeric revision schemes**. His
`revise()` change (copying relationships onto a new revision) is right for the
callers in his repository; here `revise()` is only called from the ECO merge,
which copies relationships itself, so it is unnecessary.

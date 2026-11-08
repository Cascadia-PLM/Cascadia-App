# Relationships API

The Relationships API manages parent-child and other typed relationships between items. Relationships form the Bill of Materials (BOM) structure and traceability links in Cascadia PLM.

## Endpoints

This page explains behaviour; it is not an endpoint inventory. Three generated
surfaces carry that, and none of them can drift from the routes the way a
hand-written table does:

- `GET /api/docs` — the interactive Scalar UI
- `GET /openapi.json` — the live spec, regenerated from route metadata per request
- [`openapi.v1.json`](./openapi.v1.json) — the frozen v1 contract, the one external
  consumers should build against

See [the API README](./README.md) for the versioning policy that governs all three.

## List Relationships by Design

```
GET /api/v1/relationships
```

Returns all relationships for items within a design. Auth required.

### Query Parameters

| Parameter  | Type   | Required | Description                                            |
| ---------- | ------ | -------- | ------------------------------------------------------ |
| `designId` | UUID   | Yes      | Design to scope relationships                          |
| `type`     | string | No       | Filter by relationship type (e.g., `bom`, `reference`) |

### Response

```json
{
  "data": {
    "relationships": [
      {
        "id": "rel-uuid",
        "sourceId": "parent-item-uuid",
        "targetId": "child-item-uuid",
        "relationshipType": "bom"
      }
    ]
  }
}
```

## List Relationships for an Item

```
GET /api/v1/items/:id/relationships
```

Returns all relationships where the item is the source (parent). Supports branch-aware queries.

### Query Parameters

| Parameter | Type   | Required | Description                               |
| --------- | ------ | -------- | ----------------------------------------- |
| `type`    | string | No       | Filter by relationship type               |
| `branch`  | UUID   | No       | Branch ID for version-aware relationships |

### Response

Relationships include full details of both source and target items:

```json
{
  "data": {
    "relationships": [
      {
        "id": "rel-uuid",
        "sourceId": "parent-uuid",
        "targetId": "child-uuid",
        "relationshipType": "bom",
        "quantity": 4,
        "findNumber": 1,
        "referenceDesignator": "R1,R2,R3,R4",
        "sourceItem": {
          "id": "parent-uuid",
          "itemNumber": "ASM-001",
          "name": "Main Assembly"
        },
        "targetItem": {
          "id": "child-uuid",
          "itemNumber": "PRT-003",
          "name": "Resistor 10K"
        }
      }
    ]
  }
}
```

### Example

```bash
# Get BOM children for an assembly
curl /api/v1/items/PARENT_UUID/relationships?type=bom

# Get branch-specific BOM
curl /api/v1/items/PARENT_UUID/relationships?type=bom&branch=BRANCH_UUID
```

## Create Relationship

```
POST /api/v1/items/:id/relationships
```

Creates a new relationship from the specified item (source) to a target item. Auth required.

### Request Body

| Field                 | Type    | Required | Description                                             |
| --------------------- | ------- | -------- | ------------------------------------------------------- |
| `targetId`            | UUID    | Yes      | Target (child) item ID                                  |
| `relationshipType`    | string  | Yes      | Relationship type (e.g., `bom`, `reference`, `derived`) |
| `quantity`            | number  | No       | Quantity of child in parent (BOM)                       |
| `findNumber`          | integer | No       | Find number for BOM ordering                            |
| `referenceDesignator` | string  | No       | Reference designator(s), comma-separated                |
| `metadata`            | object  | No       | Free-form JSON (see [Metadata](#metadata))              |

### Example

```bash
curl -X POST /api/v1/items/PARENT_UUID/relationships \
  -H "Content-Type: application/json" \
  -d '{
    "targetId": "child-item-uuid",
    "relationshipType": "bom",
    "quantity": 4,
    "findNumber": 1,
    "referenceDesignator": "R1,R2,R3,R4"
  }'
```

### Response

**Status:** `201 Created`

```json
{
  "data": {
    "success": true
  }
}
```

**Status:** `409 Conflict` — the edge already exists (see
[Edge identity](#edge-identity)). Change the existing relationship with
`PUT /api/v1/relationships/:relationshipId` instead.

```json
{
  "error": {
    "code": "RESOURCE_ALREADY_EXISTS",
    "message": "Relationship 'parent-uuid → child-uuid (BOM)' already exists"
  }
}
```

## Update Relationship

```
PUT /api/v1/relationships/:relationshipId
```

Updates relationship properties. Auth required.

### Request Body

All fields are optional. An absent field leaves the column alone; `null`
clears it.

| Field                 | Type    | Description                                                               |
| --------------------- | ------- | ------------------------------------------------------------------------- |
| `quantity`            | number  | Updated quantity                                                          |
| `findNumber`          | integer | Updated find number                                                       |
| `referenceDesignator` | string  | Updated reference designator(s)                                           |
| `metadata`            | object  | Replaces the edge's metadata keys as a whole (see [Metadata](#metadata))  |
| `option`              | object  | Product variants: the option condition; `null` makes the line fixed again |
| `targetMakeCode`      | string  | Active execution of the target Part revision; `null` clears the pin       |

### Example

```bash
curl -X PUT /api/v1/relationships/REL_UUID \
  -H "Content-Type: application/json" \
  -d '{
    "quantity": 6,
    "referenceDesignator": "R1,R2,R3,R4,R5,R6",
    "metadata": { "supplierRef": "DK-311-10.0KCRCT-ND" }
  }'
```

### Response

```json
{
  "data": {
    "relationship": {
      "id": "rel-uuid",
      "sourceId": "parent-uuid",
      "targetId": "child-uuid",
      "relationshipType": "bom",
      "quantity": "6",
      "findNumber": 1,
      "referenceDesignator": "R1,R2,R3,R4,R5,R6"
    }
  }
}
```

## Delete Relationship

```
DELETE /api/v1/relationships/:relationshipId
```

Removes a relationship. Auth required.

### Response

```json
{
  "data": {
    "success": true,
    "message": "Relationship deleted successfully"
  }
}
```

## Batch Create Relationships

```
POST /api/v1/relationships/batch-create
```

Create multiple relationships in a single request. Limited to 500 relationships per batch. Supports optional replacement of existing relationships.

### Request Body

| Field             | Type    | Required | Description                                                                             |
| ----------------- | ------- | -------- | --------------------------------------------------------------------------------------- |
| `relationships`   | array   | Yes      | Array of relationship objects                                                           |
| `replaceExisting` | boolean | No       | If true, delete existing relationships of the same type for each source before creating |

Each relationship object:

| Field                 | Type    | Required | Description               |
| --------------------- | ------- | -------- | ------------------------- |
| `sourceId`            | UUID    | Yes      | Source (parent) item ID   |
| `targetId`            | UUID    | Yes      | Target (child) item ID    |
| `relationshipType`    | string  | Yes      | Relationship type         |
| `quantity`            | number  | No       | Quantity                  |
| `referenceDesignator` | string  | No       | Reference designator(s)   |
| `findNumber`          | integer | No       | Find number               |
| `metadata`            | object  | No       | See [Metadata](#metadata) |

### Example

```bash
curl -X POST /api/v1/relationships/batch-create \
  -H "Content-Type: application/json" \
  -d '{
    "relationships": [
      {
        "sourceId": "asm-uuid",
        "targetId": "prt-001-uuid",
        "relationshipType": "bom",
        "quantity": 2,
        "findNumber": 1
      },
      {
        "sourceId": "asm-uuid",
        "targetId": "prt-002-uuid",
        "relationshipType": "bom",
        "quantity": 1,
        "findNumber": 2
      }
    ],
    "replaceExisting": true
  }'
```

### Response

Returns `201` (all succeeded), `207` (partial success), or `400` (all failed):

```json
{
  "data": {
    "created": 2,
    "skipped": 0,
    "errors": []
  }
}
```

With partial failures — lines that name no `sourceId`, `targetId` or
`relationshipType`. The rejection says which line and why, and never carries
the database's query text:

```json
{
  "data": {
    "created": 1,
    "skipped": 0,
    "errors": [
      {
        "relationship": {
          "sourceId": "asm-uuid",
          "targetId": "",
          "relationshipType": "bom"
        },
        "error": "Missing required fields (sourceId, targetId, or relationshipType)"
      }
    ]
  }
}
```

A batch that repeats an edge is rejected whole, with the standard error
envelope rather than the per-line shape above:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "A relationship may appear only once per source, target, type, option condition, target execution and (on a BOM line) reference designators; combine the duplicate lines and sum their quantities",
    "fieldErrors": [
      {
        "field": "relationships[2]",
        "message": "Duplicates relationships[1]: asm-uuid → screw-uuid (bom)",
        "code": "DUPLICATE_RELATIONSHIP"
      }
    ]
  }
}
```

### Behavior Notes

- **Edge identity**: see [Edge identity](#edge-identity) — a batch listing the
  same line twice is rejected with `DUPLICATE_RELATIONSHIP` before anything is
  written. The same child at two reference designators is two lines.
- **All or nothing**: validation runs over the whole request before the first
  write, and replacement shares one transaction with the insert. A rejected
  batch changes nothing — in particular it does not leave a parent whose BOM
  was deleted and not rebuilt.
- **Duplicate detection**: If `replaceExisting` is false (default), relationships already stored with the same [edge identity](#edge-identity) are skipped (counted in `skipped`) and keep their stored quantity and find number — a skip is not an update.
- **Replace mode**: If `replaceExisting` is true, existing relationships are deleted for each (source, type) pair the batch actually writes, before creating the new ones. This is useful for rebuilding a BOM. A source whose every line was rejected is left alone.
- **Cycle detection**: Creating a relationship that would form a circular reference results in a `422` error with code `ITEM_RELATIONSHIP_CYCLE`.

## Edge identity

A relationship is identified by
`(sourceId, targetId, relationshipType, option, targetMakeCode)` and, on a
**BOM** line, its `referenceDesignator` — the `item_relationships_edge_unique`
index. So one child may sit on a parent's BOM several times, as long as each
line differs in its option condition, its target execution or its reference
designators:

| Lines for one parent → one child         | Allowed? |
| ---------------------------------------- | -------- |
| `R1` and `R2`                            | Yes      |
| `R1` and no designator                   | Yes      |
| `R1` and `R1 ` (padding)                 | No       |
| no designator and `""` (blank)           | No       |
| no designator, twice, different find no. | No       |
| `color=black` and `color=white`          | Yes      |

Designators are stored trimmed, with a blank as none, and compared as text:
`R1, R2` and `R2, R1` are two different values, and nothing checks that two
lines' lists do not overlap. Lines that differ only in find number are one
line twice — give them designators, or carry a single line with the summed
quantity.

On every other relationship type the designator does not take part, so a trace
link (`SATISFIES`, `VERIFIED_BY`, …) stays one per pair whatever the field
says.

Every consumer that groups lines — the merge, conflict detection, structure
trees, thread comparison, MBOM derivation and design clone — keys them on this
same identity (`ItemRelationshipService.edgeKey` server side,
`referenceDesignatorKey` in `@cascadia/commons/types/bom` for the designator
part), so a line that the index admits is never folded into its sibling.

## Metadata

Every relationship carries a `metadata` JSON object for whatever its own
columns do not hold: a supplier's line reference, a note on an evidence link,
an integration's correlation id. It is written on create (single or batch) and
on `PUT`, and returned on every read.

- **Replaced, not merged.** A `PUT` that sends `metadata` sets the edge's keys
  to exactly that object; send the full set, not just the key that changed.
  `null` clears them. A `PUT` that omits `metadata` leaves it alone.
- **Server-maintained keys are not writable.** The server keeps its own
  bookkeeping in the same object — `affirmed`, the review record of a trace
  link (see [suspect links](../features/requirements-and-vv.md#suspect-links)). A value
  sent under such a key is ignored and the stored one kept, so a client may
  send back what it read without forging or erasing a trace link's
  affirmation, and clearing `metadata` never clears it.
- **Versioned with the item.** Metadata rides the edge, so it is copied onto a
  working copy at checkout and released with the change order like the line's
  other fields. A change is recorded in the item's history
  (`bom_metadata_changed`) and named in the `relationship.updated` event's
  `changedFields` as `metadata`; the event does not carry the value.
- Unlike `referenceDesignator`, which tells a line from its siblings, it is
  not part of the BOM's conflict signature: two change orders that both edit
  one line's metadata do not conflict, and the one released second carries
  its own branch's value.

## Relationship Types

| Type              | Description                    | Typical Use           |
| ----------------- | ------------------------------ | --------------------- |
| `bom`             | Bill of Materials parent-child | Assembly to component |
| `reference`       | Reference/traceability link    | Requirement to part   |
| `derived`         | Derived-from relationship      | New revision from old |
| `cross_reference` | Cross-design reference         | Library part usage    |

## Where-Used Queries

To find all items that use a specific item (reverse BOM lookup), query relationships where the item is the target:

```bash
# Get all assemblies containing part PRT-001
curl /api/v1/items/PRT_001_UUID/relationships?type=bom
```

Note: The current API returns relationships where the item is the source. For true where-used (item as target), use the item graph endpoint:

```bash
GET /api/v1/items/:id/graph
```

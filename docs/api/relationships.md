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

All fields are optional:

| Field                 | Type    | Description                     |
| --------------------- | ------- | ------------------------------- |
| `quantity`            | number  | Updated quantity                |
| `findNumber`          | integer | Updated find number             |
| `referenceDesignator` | string  | Updated reference designator(s) |

### Example

```bash
curl -X PUT /api/v1/relationships/REL_UUID \
  -H "Content-Type: application/json" \
  -d '{
    "quantity": 6,
    "referenceDesignator": "R1,R2,R3,R4,R5,R6"
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

| Field                 | Type    | Required | Description             |
| --------------------- | ------- | -------- | ----------------------- |
| `sourceId`            | UUID    | Yes      | Source (parent) item ID |
| `targetId`            | UUID    | Yes      | Target (child) item ID  |
| `relationshipType`    | string  | Yes      | Relationship type       |
| `quantity`            | number  | No       | Quantity                |
| `referenceDesignator` | string  | No       | Reference designator(s) |
| `findNumber`          | integer | No       | Find number             |
| `metadata`            | object  | No       | Arbitrary metadata      |

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
    "message": "A relationship may appear only once per (sourceId, targetId, relationshipType); combine the duplicate lines and sum their quantities",
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
  same child twice is rejected with `DUPLICATE_RELATIONSHIP` before anything is
  written.
- **All or nothing**: validation runs over the whole request before the first
  write, and replacement shares one transaction with the insert. A rejected
  batch changes nothing — in particular it does not leave a parent whose BOM
  was deleted and not rebuilt.
- **Duplicate detection**: If `replaceExisting` is false (default), relationships already stored with the same source/target/type are skipped (counted in `skipped`) and keep their stored quantity and find number — a skip is not an update.
- **Replace mode**: If `replaceExisting` is true, existing relationships are deleted for each (source, type) pair the batch actually writes, before creating the new ones. This is useful for rebuilding a BOM. A source whose every line was rejected is left alone.
- **Cycle detection**: Creating a relationship that would form a circular reference results in a `422` error with code `ITEM_RELATIONSHIP_CYCLE`.

## Edge identity

A relationship is identified by `(sourceId, targetId, relationshipType)`, which
`item_relationships` enforces with a unique constraint. One parent therefore
has **one line per child per relationship type**: a BOM that would list the same
screw under two find numbers ("4 here, 12 there") has to carry a single line
with the summed quantity, and `referenceDesignator` for where they go.

This is what every consumer of the structure assumes — merge, conflict
detection, impact analysis and where-used all treat a parent/child pair as one
edge — so the constraint is deliberate rather than incidental. Splitting a child
across lines would need those consumers to agree on a line identity first.

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

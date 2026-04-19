# Relationships API

The Relationships API manages parent-child and other typed relationships between items. Relationships form the Bill of Materials (BOM) structure and traceability links in Cascadia PLM.

## Endpoints Overview

| Method | Endpoint                             | Description                     |
| ------ | ------------------------------------ | ------------------------------- |
| GET    | `/api/relationships`                 | List relationships for a design |
| GET    | `/api/items/:id/relationships`       | List relationships for an item  |
| POST   | `/api/items/:id/relationships`       | Create a relationship           |
| PUT    | `/api/relationships/:relationshipId` | Update relationship properties  |
| DELETE | `/api/relationships/:relationshipId` | Delete a relationship           |
| POST   | `/api/relationships/batch-create`    | Batch create relationships      |

## List Relationships by Design

```
GET /api/relationships
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
GET /api/items/:id/relationships
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
curl /api/items/PARENT_UUID/relationships?type=bom

# Get branch-specific BOM
curl /api/items/PARENT_UUID/relationships?type=bom&branch=BRANCH_UUID
```

## Create Relationship

```
POST /api/items/:id/relationships
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
curl -X POST /api/items/PARENT_UUID/relationships \
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

## Update Relationship

```
PUT /api/relationships/:relationshipId
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
curl -X PUT /api/relationships/REL_UUID \
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
DELETE /api/relationships/:relationshipId
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
POST /api/relationships/batch-create
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
curl -X POST /api/relationships/batch-create \
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

With partial failures:

```json
{
  "data": {
    "created": 1,
    "skipped": 0,
    "errors": [
      {
        "relationship": {
          "sourceId": "asm-uuid",
          "targetId": "invalid-uuid",
          "relationshipType": "bom"
        },
        "error": "Failed to create relationship",
        "details": "Foreign key constraint violation"
      }
    ]
  }
}
```

### Behavior Notes

- **Duplicate detection**: If `replaceExisting` is false (default), existing relationships with the same source/target/type are skipped (counted in `skipped`).
- **Replace mode**: If `replaceExisting` is true, all existing relationships of the same type for each unique source ID are deleted before creating new ones. This is useful for rebuilding a BOM.
- **Cycle detection**: Creating a relationship that would form a circular reference results in a `422` error with code `ITEM_RELATIONSHIP_CYCLE`.

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
curl /api/items/PRT_001_UUID/relationships?type=bom
```

Note: The current API returns relationships where the item is the source. For true where-used (item as target), use the item graph endpoint:

```bash
GET /api/items/:id/graph
```

# Items API

The Items API provides CRUD operations for all PLM item types (Part, Document, Requirement, Task, ChangeOrder, etc.). Items are the fundamental data objects in Cascadia and follow a two-table pattern: shared fields in the `items` table and type-specific fields in dedicated tables (`parts`, `documents`, etc.).

## Endpoints Overview

| Method | Endpoint                    | Description                     |
| ------ | --------------------------- | ------------------------------- |
| GET    | `/api/items`                | List items with version context |
| POST   | `/api/items`                | Create an item                  |
| GET    | `/api/items/:id`            | Get item by ID                  |
| PUT    | `/api/items/:id`            | Update an item                  |
| DELETE | `/api/items/:id`            | Delete an item                  |
| GET    | `/api/items/:id/at-context` | Get item at a specific version  |
| GET    | `/api/items/:id/history`    | Get version history             |
| GET    | `/api/items/search`         | Search items                    |
| POST   | `/api/items/batch-create`   | Batch create items              |
| POST   | `/api/items/batch-update`   | Batch update items              |
| POST   | `/api/items/batch-delete`   | Batch delete items              |
| GET    | `/api/parts/:id`            | Get part by ID                  |
| PUT    | `/api/parts/:id`            | Update a part                   |
| DELETE | `/api/parts/:id`            | Delete a part                   |

## List Items

```
GET /api/items
```

Lists items with optional version context (branch, commit, or tag). Requires authentication.

### Query Parameters

| Parameter        | Type    | Required    | Default | Description                                                              |
| ---------------- | ------- | ----------- | ------- | ------------------------------------------------------------------------ |
| `designId`       | UUID    | Recommended | -       | Design scope. Required for version-aware queries.                        |
| `branch`         | string  | No          | -       | Branch name (e.g., `main`, `eco/ECO-2024-001`)                           |
| `commit`         | UUID    | No          | -       | View items at a specific commit                                          |
| `tag`            | UUID    | No          | -       | View items at a tagged version                                           |
| `itemType`       | string  | No          | -       | Filter by type: `Part`, `Document`, `Requirement`, `Task`, `ChangeOrder` |
| `state`          | string  | No          | -       | Filter by lifecycle state                                                |
| `search`         | string  | No          | -       | Full-text search query                                                   |
| `includeDeleted` | boolean | No          | `false` | Include soft-deleted items                                               |
| `limit`          | integer | No          | `100`   | Maximum results (1-500)                                                  |
| `offset`         | integer | No          | `0`     | Pagination offset                                                        |

### Response

```json
{
  "data": {
    "items": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "masterId": "660e8400-e29b-41d4-a716-446655440000",
        "itemNumber": "PRT-001",
        "revision": "A",
        "name": "Motor Housing",
        "itemType": "Part",
        "state": "Released",
        "designId": "770e8400-e29b-41d4-a716-446655440000",
        "createdBy": "user-uuid",
        "createdAt": "2025-01-15T10:30:00.000Z",
        "modifiedAt": "2025-01-16T14:00:00.000Z"
      }
    ],
    "total": 42,
    "context": {
      "type": "branch",
      "branchName": "main",
      "description": "Latest on main"
    }
  }
}
```

### Examples

```bash
# List all parts in a design on the main branch
curl /api/items?designId=UUID&branch=main&itemType=Part

# List items on an ECO branch
curl /api/items?designId=UUID&branch=eco/ECO-2024-001

# Search across all items in a design
curl /api/items?designId=UUID&search=motor&limit=20

# Without designId, falls back to legacy search
curl /api/items?itemType=Part&search=motor
```

## Create Item

```
POST /api/items
```

Creates a new item. Auth required; permission check based on item type.

### Request Body

| Field                  | Type   | Required | Description                                              |
| ---------------------- | ------ | -------- | -------------------------------------------------------- |
| `itemType`             | string | Yes      | `Part`, `Document`, `Requirement`, `Task`, `ChangeOrder` |
| `itemNumber`           | string | Yes      | Unique item number                                       |
| `revision`             | string | Yes      | Revision letter (max 10 chars)                           |
| `name`                 | string | No       | Display name (max 500 chars)                             |
| `designId`             | UUID   | Yes\*    | Design context (\*optional for Tasks)                    |
| `description`          | string | No       | Description (max 5000-10000 chars)                       |
| `branchId`             | UUID   | No       | Branch to create on (for ECO workflow)                   |
| `commitMessage`        | string | No       | Commit message if creating on branch                     |
| _type-specific fields_ | varies | No       | See type-specific fields below                           |

### Response

Without `branchId` (direct creation on main):

```json
{
  "data": {
    "item": {
      "id": "new-uuid",
      "itemNumber": "PRT-001",
      "revision": "A",
      "itemType": "Part",
      "state": "In Work",
      ...
    }
  }
}
```

With `branchId` (creation on an ECO branch):

```json
{
  "data": {
    "item": { ... },
    "commit": {
      "id": "commit-uuid",
      "message": "Created Part PRT-001",
      "branchId": "branch-uuid",
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  }
}
```

**Status:** `201 Created`

### Example

```bash
curl -X POST /api/items \
  -H "Content-Type: application/json" \
  -d '{
    "itemType": "Part",
    "itemNumber": "PRT-001",
    "revision": "A",
    "name": "Motor Housing",
    "designId": "design-uuid",
    "partType": "Manufacture",
    "material": "Aluminum 6061",
    "branchId": "eco-branch-uuid",
    "commitMessage": "Added motor housing"
  }'
```

## Get Item

```
GET /api/items/:id
```

Retrieves a single item by ID with optional version context.

### Query Parameters

| Parameter | Type   | Required | Description              |
| --------- | ------ | -------- | ------------------------ |
| `branch`  | string | No       | View item on this branch |
| `commit`  | UUID   | No       | View item at this commit |
| `tag`     | UUID   | No       | View item at this tag    |

### Response

```json
{
  "data": {
    "item": {
      "id": "item-uuid",
      "masterId": "master-uuid",
      "itemNumber": "PRT-001",
      "revision": "A",
      "name": "Motor Housing",
      "itemType": "Part",
      "state": "In Work",
      "designId": "design-uuid",
      "usageCount": 3,
      "lockedBy": null,
      "lockedAt": null,
      ...
    }
  }
}
```

When version context is provided:

```json
{
  "data": {
    "item": { ... },
    "context": {
      "type": "branch",
      "branchName": "eco/ECO-2024-001",
      "description": "ECO-2024-001 branch"
    }
  }
}
```

## Update Item

```
PUT /api/items/:id
```

Updates an item. When `branchId` is provided, changes are saved on that branch via the checkout/commit workflow.

### Query Parameters

| Parameter  | Type | Required | Description               |
| ---------- | ---- | -------- | ------------------------- |
| `branchId` | UUID | No       | Branch to save changes on |

### Request Body

All fields are optional (PATCH-style update):

```json
{
  "name": "Motor Housing v2",
  "description": "Updated housing with improved cooling",
  "commitMessage": "Improved cooling channels"
}
```

### Response

Without `branchId`:

```json
{
  "data": {
    "item": { ... }
  }
}
```

With `branchId`:

```json
{
  "data": {
    "item": { ... },
    "commit": {
      "id": "commit-uuid",
      "message": "Updated PRT-001"
    }
  }
}
```

## Delete Item

```
DELETE /api/items/:id
```

Deletes an item. With `branchId`, performs a soft-delete on the branch (item marked as deleted, recoverable until merge).

### Query Parameters

| Parameter       | Type   | Required | Description                        |
| --------------- | ------ | -------- | ---------------------------------- |
| `branchId`      | UUID   | No       | Branch to delete on                |
| `commitMessage` | string | No       | Commit message for branch deletion |

### Response

```json
{
  "data": {
    "success": true,
    "commit": { "id": "commit-uuid", ... }
  }
}
```

## Get Item at Version Context

```
GET /api/items/:id/at-context
```

Returns the item as it existed at a specific version (commit, tag, or branch HEAD). Useful for comparing versions.

### Query Parameters

| Parameter  | Type    | Description                            |
| ---------- | ------- | -------------------------------------- |
| `commitId` | UUID    | View at this commit                    |
| `tagId`    | UUID    | View at this tag's commit              |
| `branchId` | UUID    | View at this branch's HEAD             |
| `released` | boolean | Resolve to the released (main) version |

### Response

```json
{
  "data": {
    "item": { ... },
    "existsAtContext": true,
    "resolvedItemId": "version-specific-uuid"
  }
}
```

If the item did not exist at the requested version:

```json
{
  "error": "Item did not exist at this version",
  "data": {
    "item": null,
    "existsAtContext": false
  }
}
```

## Item Version History

```
GET /api/items/:id/history
```

Returns the version history for an item across commits.

### Query Parameters

| Parameter  | Type | Description                          |
| ---------- | ---- | ------------------------------------ |
| `commitId` | UUID | Show history up to this commit       |
| `tagId`    | UUID | Show history up to this tag's commit |
| `branchId` | UUID | Show history on this branch          |

### Response

```json
{
  "data": {
    "history": [
      {
        "commit": {
          "id": "commit-uuid",
          "message": "Updated weight specification",
          "createdBy": "user-uuid",
          "createdAt": "2025-01-16T14:00:00.000Z"
        },
        "author": {
          "id": "user-uuid",
          "name": "Jane Smith"
        },
        "changeType": "modified",
        "changes": { "weight": { "old": "2.5", "new": "2.3" } }
      }
    ]
  }
}
```

## Search Items

```
GET /api/items/search
```

Search for items with autocomplete and type filtering.

### Query Parameters

| Parameter         | Type    | Description                             |
| ----------------- | ------- | --------------------------------------- |
| `q`               | string  | Autocomplete search by item number/name |
| `types`           | string  | Comma-separated item types (with `q`)   |
| `itemType`        | string  | Single item type filter (without `q`)   |
| `query`           | string  | Search query (without `q`)              |
| `state`           | string  | State filter                            |
| `limit`           | integer | Max results (default 50)                |
| `designScope`     | string  | `current`, `all`, or `library`          |
| `contextDesignId` | UUID    | Current design (for `isExternal` flag)  |
| `designIds`       | string  | Comma-separated design IDs              |

### Response

```json
{
  "data": {
    "items": [
      {
        "id": "item-uuid",
        "itemNumber": "PRT-001",
        "name": "Motor Housing",
        "itemType": "Part",
        "designId": "design-uuid",
        "designCode": "WIDGET",
        "designName": "Widget Assembly",
        "isExternal": false
      }
    ],
    "total": 5
  }
}
```

## Batch Create

```
POST /api/items/batch-create
```

Create multiple items in a single request. Limited to 100 items per batch.

### Request Body

```json
{
  "items": [
    {
      "itemType": "Part",
      "data": {
        "itemNumber": "PRT-001",
        "revision": "A",
        "designId": "design-uuid",
        "partType": "Manufacture"
      }
    },
    {
      "itemType": "Document",
      "data": {
        "itemNumber": "DOC-001",
        "revision": "A",
        "designId": "design-uuid"
      }
    }
  ],
  "bypassBranchProtection": false
}
```

### Response

Returns `201` (all succeeded), `207` (partial success), or `400` (all failed):

```json
{
  "data": {
    "created": [
      { "id": "new-uuid-1", "itemNumber": "PRT-001", ... }
    ],
    "errors": [
      {
        "itemNumber": "DOC-001",
        "error": "Failed to create item",
        "details": "Item number already exists"
      }
    ]
  }
}
```

## Type-Specific Fields

### Part Fields

| Field          | Type    | Description                                      |
| -------------- | ------- | ------------------------------------------------ |
| `partType`     | enum    | `Manufacture`, `Purchase`, `Software`, `Phantom` |
| `material`     | string  | Material specification (max 100)                 |
| `weight`       | string  | Weight value                                     |
| `weightUnit`   | string  | Weight unit (default: `kg`)                      |
| `cost`         | string  | Cost value                                       |
| `costCurrency` | string  | 3-letter currency code (default: `USD`)          |
| `leadTimeDays` | integer | Lead time in days                                |

### Document Fields

| Field      | Type    | Description           |
| ---------- | ------- | --------------------- |
| `fileId`   | UUID    | Associated vault file |
| `fileName` | string  | Original file name    |
| `fileSize` | integer | File size in bytes    |
| `mimeType` | string  | MIME type             |

### Requirement Fields

| Field                | Type   | Description                                       |
| -------------------- | ------ | ------------------------------------------------- |
| `requirementType`    | string | Type category                                     |
| `priority`           | enum   | `low`, `medium`, `high`, `critical`               |
| `verificationMethod` | enum   | `inspection`, `analysis`, `demonstration`, `test` |
| `acceptanceCriteria` | string | Criteria text (max 10000)                         |
| `rationale`          | string | Rationale text (max 5000)                         |

### Task Fields

| Field      | Type   | Description                         |
| ---------- | ------ | ----------------------------------- |
| `taskType` | string | Type category                       |
| `priority` | enum   | `low`, `medium`, `high`, `critical` |
| `dueDate`  | date   | Due date                            |
| `assignee` | UUID   | Assigned user ID                    |

### Change Order Fields

| Field                | Type   | Description                         |
| -------------------- | ------ | ----------------------------------- |
| `changeType`         | enum   | `ECO`, `ECN`, `Deviation`, `MCO`    |
| `priority`           | enum   | `low`, `medium`, `high`, `critical` |
| `reasonForChange`    | string | Reason text (max 10000)             |
| `impactDescription`  | string | Impact text (max 10000)             |
| `implementationDate` | date   | Target date                         |
| `riskLevel`          | enum   | `low`, `medium`, `high`, `critical` |

## Type-Specific Endpoints

Individual item types have shortcut endpoints:

```
GET    /api/parts/:id         # permission: parts.read
PUT    /api/parts/:id         # permission: parts.update
DELETE /api/parts/:id         # permission: parts.delete

GET    /api/documents/:id     # permission: documents.read
PUT    /api/documents/:id     # permission: documents.update
DELETE /api/documents/:id     # permission: documents.delete

GET    /api/change-orders/:id # permission: change_orders.read
PUT    /api/change-orders/:id # permission: change_orders.update
DELETE /api/change-orders/:id # permission: change_orders.delete
```

These follow the same patterns as the generic `/api/items/:id` endpoints but enforce type-specific permissions.

## Branch-Aware Operations

Cascadia's versioning model means items can exist on multiple branches simultaneously. Key behaviors:

1. **Without `branchId`**: Operations target the item directly (pre-release or legacy mode).
2. **With `branchId`**: Operations create commits on the specified branch, preserving full history.
3. **Main branch protection**: Once a design has released items, direct edits on main are blocked. Changes must go through ECO branches.
4. **Version resolution**: When querying with `branch`, `commit`, or `tag` parameters, the API resolves the item to the version that existed at that point.

# Search API

Cascadia provides two search mechanisms: enterprise-wide search across all item types, and type-specific item search with design scoping.

## Endpoints

This page explains behaviour; it is not an endpoint inventory. Three generated
surfaces carry that, and none of them can drift from the routes the way a
hand-written table does:

- `GET /api/docs` — the interactive Scalar UI
- `GET /openapi.json` — the live spec, regenerated from route metadata per request
- [`openapi.v1.json`](./openapi.v1.json) — the frozen v1 contract, the one external
  consumers should build against

See [the API README](./README.md) for the versioning policy that governs all three.

## Enterprise Search

```
GET /api/v1/enterprise-search
```

Searches every item type the caller may read simultaneously and returns results grouped by type. Two gates apply, as they do on the results endpoint below: RBAC decides which item types are searched at all, and program membership decides which rows come back, so only items in accessible designs and library designs are returned. Auth required.

### Query Parameters

| Parameter | Type    | Required | Default | Description                                      |
| --------- | ------- | -------- | ------- | ------------------------------------------------ |
| `q`       | string  | Yes      | -       | Search query (searches item numbers and names)   |
| `limit`   | integer | No       | 50      | Maximum results per type; 1-100, otherwise a 400 |

### Response

```json
{
  "data": {
    "results": [
      {
        "itemType": "Part",
        "label": "Parts",
        "icon": "box",
        "items": [
          {
            "id": "item-uuid",
            "itemNumber": "PRT-001",
            "name": "Motor Housing",
            "revision": "B",
            "state": "Released",
            "itemType": "Part",
            "designId": "design-uuid",
            "designCode": "WIDGET",
            "designName": "Widget Assembly"
          }
        ],
        "total": 3
      },
      {
        "itemType": "Document",
        "label": "Documents",
        "icon": "file-text",
        "items": [...],
        "total": 1
      }
    ]
  }
}
```

### Example

```bash
# Search for "motor" across all item types
curl /api/v1/enterprise-search?q=motor

# Search with limited results
curl /api/v1/enterprise-search?q=PRT-001&limit=10
```

### Behavior

- Searches item numbers and names using prefix/substring matching.
- Results are grouped by item type; types with zero results are omitted.
- Only item types the caller holds `read` on are searched — a withheld type contributes no group at all, and a caller with no read grants gets an empty `results`.
- The `limit` is distributed across all types (e.g., limit=50 with 5 types gives ~10 per type).
- Items are enriched with design metadata (`designCode`, `designName`).
- Only items in the user's accessible designs (via program membership) and library designs are included.
- Errors searching individual types are caught silently; other types still return results.

## Item Search

```
GET /api/v1/items/search
```

Provides two search modes: autocomplete search by item number/name (`q` parameter), or structured search with type filtering (`itemType` parameter). Auth required.

### Autocomplete Mode

For real-time search/autocomplete in the UI. Uses the `q` parameter.

#### Query Parameters

| Parameter         | Type    | Required | Default   | Description                                     |
| ----------------- | ------- | -------- | --------- | ----------------------------------------------- |
| `q`               | string  | Yes      | -         | Search query (prefix match on item number/name) |
| `types`           | string  | No       | All types | Comma-separated item types to search            |
| `limit`           | integer | No       | 50        | Maximum results                                 |
| `designScope`     | string  | No       | -         | `current`, `all`, or `library`                  |
| `contextDesignId` | UUID    | No       | -         | Current design context (sets `isExternal` flag) |
| `designIds`       | string  | No       | -         | Comma-separated design IDs to scope search      |

#### Response

```json
{
  "data": {
    "items": [
      {
        "id": "item-uuid",
        "itemNumber": "PRT-001",
        "name": "Motor Housing",
        "revision": "A",
        "state": "Released",
        "itemType": "Part",
        "designId": "design-uuid",
        "designCode": "WIDGET",
        "designName": "Widget Assembly",
        "isExternal": false
      }
    ]
  }
}
```

The `isExternal` flag is `true` when an item belongs to a different design than `contextDesignId`, useful for identifying cross-design references in the UI.

### Structured Search Mode

For filtered, paginated lists. Uses the `itemType` parameter.

#### Query Parameters

| Parameter         | Type    | Required | Default | Description                                    |
| ----------------- | ------- | -------- | ------- | ---------------------------------------------- |
| `itemType`        | string  | Yes      | -       | Item type to search (`Part`, `Document`, etc.) |
| `query`           | string  | No       | -       | Search query                                   |
| `state`           | string  | No       | -       | Lifecycle state filter                         |
| `limit`           | integer | No       | 50      | Maximum results                                |
| `designScope`     | string  | No       | -       | `current`, `all`, or `library`                 |
| `contextDesignId` | UUID    | No       | -       | Current design context                         |
| `designIds`       | string  | No       | -       | Comma-separated design IDs                     |

#### Response

```json
{
  "data": {
    "items": [...],
    "total": 42
  }
}
```

### Examples

```bash
# Autocomplete search for "PRT" across all types
curl /api/v1/items/search?q=PRT

# Search for parts only, with autocomplete
curl /api/v1/items/search?q=motor&types=Part

# Search within current design
curl /api/v1/items/search?q=housing&designScope=current&contextDesignId=DESIGN_UUID

# Search library parts only
curl /api/v1/items/search?q=resistor&types=Part&designScope=library

# Search across all accessible designs
curl /api/v1/items/search?q=PRT&designScope=all

# Structured search for released parts
curl /api/v1/items/search?itemType=Part&state=Released&limit=20

# Search within specific designs
curl /api/v1/items/search?q=motor&designIds=UUID1,UUID2
```

### Design Scope Options

| Scope             | Behavior                                                           |
| ----------------- | ------------------------------------------------------------------ |
| `current`         | Only search within `contextDesignId`                               |
| `all`             | Search all designs the user has access to (via program membership) |
| `library`         | Search only the Standard Library design                            |
| _(not specified)_ | No design filtering applied                                        |

When `designIds` is provided, it takes precedence over `designScope`.

A scope the caller asked for is honoured even when it resolves to no designs:
`library` on an instance with no Standard Library, or `all` for a user who
belongs to no program, returns **no results** rather than falling back to an
unfiltered search.

## Response Format Notes

### Item Fields in Search Results

All search results include these base fields:

| Field        | Type     | Description                     |
| ------------ | -------- | ------------------------------- |
| `id`         | UUID     | Item ID                         |
| `masterId`   | UUID     | Master item ID (for versioning) |
| `itemNumber` | string   | Item number                     |
| `name`       | string   | Display name                    |
| `revision`   | string   | Revision letter                 |
| `state`      | string   | Lifecycle state                 |
| `itemType`   | string   | Item type name                  |
| `designId`   | UUID     | Design ID                       |
| `createdAt`  | datetime | Creation timestamp              |

Enriched fields added by search endpoints:

| Field        | Type    | Description                                                |
| ------------ | ------- | ---------------------------------------------------------- |
| `designCode` | string  | Design code (e.g., `WIDGET`)                               |
| `designName` | string  | Design display name                                        |
| `isExternal` | boolean | Whether item is from a different design (item search only) |

### Pagination

Enterprise search does not support offset-based pagination; it returns up to `limit` results per type. For paginated results, use the structured item search mode or the `/api/v1/items` list endpoint which supports `limit` and `offset`.

## Client-Side Usage

```typescript
import { apiGet } from '@/lib/api/client'

// Enterprise search
const { data } = await apiGet<{
  data: { results: Array<{ itemType: string; items: any[]; total: number }> }
}>('/api/v1/enterprise-search?q=motor')

// Access results
const partResults = data.data.results.find((r) => r.itemType === 'Part')
const parts = partResults?.items ?? []

// Item autocomplete search
const { data: searchData } = await apiGet<{ data: { items: any[] } }>(
  '/api/v1/items/search?q=PRT&types=Part,Document&limit=10',
)
const items = searchData.data.items
```

Note the double `.data` -- the outer `data` is from the fetch response, the inner `.data` is the API response envelope.

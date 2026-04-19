# Search

Cascadia PLM provides a layered search system that ranges from a global
enterprise search bar to type-specific, server-side filtered grids. All search
operations respect the user's program memberships and design access, so results
never leak data across permission boundaries.

---

## Enterprise Search

The enterprise search bar lives in the top navigation and is accessible from any
page via **Cmd+K** (macOS) or **Ctrl+K** (Windows/Linux).

When you type at least two characters the bar fires a debounced request to the
enterprise search API, which fans out across every registered item type in
parallel (Part, Document, ChangeOrder, Requirement, Task, TestPlan, TestCase,
Issue, etc.). Results are grouped by type and rendered in a dropdown with
keyboard navigation (arrow keys + Enter).

Each result displays:

- Item number (monospace)
- Name
- Lifecycle state badge
- Originating design code and name (when searching across designs)

Selecting a result navigates directly to the item detail page.

### How It Works

1. The client calls `GET /api/enterprise-search?q=<query>&limit=20`.
2. The server resolves which designs the current user can access (from their
   program memberships plus any Library-type designs).
3. For each registered item type, `ItemService.searchByItemNumber()` is called
   concurrently, scoped to the accessible design IDs.
4. Results are enriched with design metadata (design code, design name) before
   being returned.

### Access Scoping

Enterprise search only returns items from designs the user can access:

- Designs belonging to programs the user is a member of
- Designs with `designType = 'Library'` (e.g., the Standard Library)

Items in designs outside the user's program memberships are excluded.

---

## Type-Specific Search

Each item listing page (Parts, Documents, Requirements, etc.) uses the
`GET /api/items/search` endpoint with the `itemType` parameter. This provides
richer filtering than the enterprise search bar and is backed by
`ItemSearchService.search()`.

### Search Criteria

The following criteria can be combined in a single request:

| Parameter           | Type           | Description                                             |
| ------------------- | -------------- | ------------------------------------------------------- |
| `query`             | string         | Legacy text search (not typically used by current UI)   |
| `state`             | string         | Exact lifecycle state match (e.g., `Draft`, `Released`) |
| `createdBy`         | UUID           | Filter to items created by a specific user              |
| `designId`          | UUID           | Restrict to a single design                             |
| `designIds`         | UUID[]         | Restrict to multiple designs (cross-design search)      |
| `currentOnly`       | boolean        | Only return `isCurrent=true` items (default: `true`)    |
| `definitionsOnly`   | boolean        | Exclude usage items, show only definitions              |
| `includeUsageCount` | boolean        | Include count of usages for each definition             |
| `globalSearch`      | string         | ILIKE search across `itemNumber` and `name`             |
| `columnFilters`     | object         | Column-level filters (see below)                        |
| `sortField`         | string         | Column to sort by                                       |
| `sortDirection`     | `asc` / `desc` | Sort direction                                          |
| `limit`             | number         | Page size (default: 50)                                 |
| `offset`            | number         | Pagination offset                                       |

### Global Search

The `globalSearch` parameter performs a case-insensitive ILIKE match against both
`itemNumber` and `name`:

```
GET /api/items/search?itemType=Part&globalSearch=motor
```

This returns any Part whose item number or name contains "motor" (case-insensitive).

### Column Filters

Column filters allow fine-grained filtering on individual fields. Three filter
modes are supported:

**Text filter** -- string value, performs ILIKE `%value%`:

```json
{ "columnFilters": { "name": "bracket" } }
```

**Multi-select filter** -- array of exact values, performs SQL `IN`:

```json
{ "columnFilters": { "state": ["Draft", "In Review"] } }
```

**Range filter** -- object with `min` and/or `max`, performs `>=` / `<=`:

```json
{ "columnFilters": { "weight": { "min": 0.5, "max": 10 } } }
```

#### Filterable Columns

Base item columns available for all types:

| Column       | Filter Modes       |
| ------------ | ------------------ |
| `itemNumber` | text               |
| `name`       | text               |
| `state`      | text, multi-select |
| `revision`   | text               |

Part-specific columns:

| Column         | Filter Modes       |
| -------------- | ------------------ |
| `description`  | text               |
| `partType`     | text, multi-select |
| `material`     | text               |
| `weight`       | range              |
| `cost`         | range              |
| `leadTimeDays` | range              |

> **Note:** Column filter support for Document, Requirement, Task, ChangeOrder,
> and other types is recognized in the `hasTypeSpecificFilters` method but the
> `buildColumnFilterCondition` method currently only maps Part-specific columns.
> See the [issues log](../issues/search-and-reporting.md) for details.

### Server-Side Sorting

Pass `sortField` and `sortDirection` to sort results at the database level:

```
GET /api/items/search?itemType=Part&sortField=cost&sortDirection=desc&limit=25
```

Sortable fields for all types: `itemNumber`, `name`, `state`, `revision`,
`createdAt`, `modifiedAt`.

Additional sort fields for Parts: `description`, `partType`, `material`,
`weight`, `cost`, `leadTimeDays`.

When no sort is specified, results default to `createdAt` descending.

### Pagination

All search endpoints support offset-based pagination:

```
GET /api/items/search?itemType=Part&limit=25&offset=50
```

The response includes:

```json
{
  "data": {
    "items": [...],
    "total": 142
  }
}
```

The `total` field reflects the full count matching the current filters, so the
UI can calculate page count and render pagination controls. The DataGrid
component supports both client-side and server-side pagination modes.

---

## Autocomplete Search

The autocomplete endpoint is used by dialogs that need to link items -- for
example, the Affected Items Manager on change orders, the Add Part to Design
dialog, and the BOM child picker.

```
GET /api/items/search?q=MTR-001&types=Part,Document&limit=10
```

This calls `ItemSearchService.searchByItemNumber()` which:

- Requires at least 2 characters in the query
- Searches with ILIKE on both `itemNumber` and `name`
- Returns only `isCurrent=true` items by default
- Optionally filters by item types and design IDs
- Enriches each result with type-specific data
- Results ordered by `itemNumber`

### Design Scope

The `designScope` query parameter controls which designs are searched:

| Value       | Behavior                                       |
| ----------- | ---------------------------------------------- |
| `current`   | Only the design specified by `contextDesignId` |
| `library`   | Only the Standard Library design               |
| `all`       | All designs accessible to the user             |
| _(omitted)_ | No design filter applied                       |

An explicit `designIds` parameter (comma-separated UUIDs) overrides the scope.

---

## Design Metadata Enrichment

Search results are enriched with design metadata when returned through the API:

```json
{
  "id": "abc-123",
  "itemNumber": "PRT-001",
  "name": "Motor Bracket",
  "designCode": "WIDGET",
  "designName": "Widget Assembly",
  "isExternal": false
}
```

The `isExternal` flag is `true` when the item belongs to a design different from
the `contextDesignId` parameter, which the UI uses to visually distinguish items
from other designs.

---

## VersionResolver Filtering

For design-scoped views (the structure tab, BOM trees, ECO affected item lists),
filtering is handled by `VersionResolver.applyFilters()` rather than
`ItemSearchService`. This method operates on an in-memory item list that has
already been resolved for a specific branch, commit, or tag.

It supports the same filter vocabulary:

- `itemType` -- exact type match
- `state` -- exact state match
- `search` / `globalSearch` -- case-insensitive substring match on
  `itemNumber` and `name`
- `columnFilters` -- text, multi-select, and range filters
- `limit` / `offset` -- pagination
- `sortField` / `sortDirection` -- sorting
- `includeDeleted` -- whether to include soft-deleted items

---

## Search API Reference

### `GET /api/enterprise-search`

Cross-type search for the navigation bar.

| Parameter | Required | Description                        |
| --------- | -------- | ---------------------------------- |
| `q`       | yes      | Search query (minimum 1 character) |
| `limit`   | no       | Max results per type (default: 50) |

**Response:**

```json
{
  "data": {
    "results": [
      {
        "itemType": "Part",
        "label": "Parts",
        "icon": "Package",
        "items": [...],
        "total": 3
      },
      {
        "itemType": "Document",
        "label": "Documents",
        "icon": "FileText",
        "items": [...],
        "total": 1
      }
    ]
  }
}
```

### `GET /api/items/search`

Type-specific search with full filtering, sorting, and pagination.

**Autocomplete mode** (when `q` is present):

| Parameter         | Required | Description                      |
| ----------------- | -------- | -------------------------------- |
| `q`               | yes      | Search text (min 2 chars)        |
| `types`           | no       | Comma-separated item types       |
| `limit`           | no       | Max results (default: 50)        |
| `designScope`     | no       | `current`, `all`, or `library`   |
| `contextDesignId` | no       | Design UUID for scope/enrichment |
| `designIds`       | no       | Comma-separated design UUIDs     |

**Full search mode** (when `q` is absent):

| Parameter         | Required | Description                      |
| ----------------- | -------- | -------------------------------- |
| `itemType`        | yes      | Item type to search              |
| `query`           | no       | Search query                     |
| `state`           | no       | Lifecycle state filter           |
| `limit`           | no       | Page size (default: 50)          |
| `designScope`     | no       | `current`, `all`, or `library`   |
| `contextDesignId` | no       | Design UUID for scope/enrichment |
| `designIds`       | no       | Comma-separated design UUIDs     |

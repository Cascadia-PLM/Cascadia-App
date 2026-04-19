# Reporting

Cascadia PLM includes a built-in report engine that lets users define, execute,
and export tabular reports against any item type. Reports are configured through
a visual builder and stored in the database as reusable definitions that can be
shared with other users or roles.

---

## Concepts

A **report definition** describes which item type to query, which columns to
display, which filters to apply, and how to sort the results. Definitions are
persisted across five database tables:

| Table               | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `reports`           | Report metadata (name, description, item type, visibility)        |
| `report_columns`    | Ordered list of columns to display                                |
| `report_filters`    | Saved filter conditions                                           |
| `report_sorts`      | Multi-level sort configuration                                    |
| `report_executions` | Audit log of every execution (timing, row count, success/failure) |
| `report_exports`    | Record of CSV exports                                             |

A **report execution** runs the definition's query against the live database and
returns rows, column metadata, and pagination info. Executions are logged in
`report_executions` for auditing.

---

## Report Definitions

### Structure

A report definition contains:

```json
{
  "name": "High-Cost Parts",
  "description": "Parts with cost exceeding $100",
  "itemType": "Part",
  "isPublic": false,
  "columns": [
    {
      "fieldPath": "itemNumber",
      "label": "Item Number",
      "displayOrder": 0,
      "isVisible": true
    },
    {
      "fieldPath": "name",
      "label": "Name",
      "displayOrder": 1,
      "isVisible": true
    },
    {
      "fieldPath": "parts.cost",
      "label": "Cost",
      "displayOrder": 2,
      "isVisible": true,
      "formatType": "currency"
    },
    {
      "fieldPath": "parts.material",
      "label": "Material",
      "displayOrder": 3,
      "isVisible": true
    },
    {
      "fieldPath": "state",
      "label": "State",
      "displayOrder": 4,
      "isVisible": true
    }
  ],
  "filters": [
    {
      "fieldPath": "parts.cost",
      "operator": "gte",
      "value": "100",
      "displayOrder": 0
    }
  ],
  "sorts": [{ "fieldPath": "parts.cost", "direction": "desc", "priority": 0 }]
}
```

### Supported Item Types

Reports can be created for any of the following item types:

- Part
- Document
- ChangeOrder
- Requirement
- Task

### Column Configuration

Each column specifies:

| Property       | Required | Description                                                                 |
| -------------- | -------- | --------------------------------------------------------------------------- |
| `fieldPath`    | yes      | Dot-notation path to the field (e.g., `itemNumber` or `parts.cost`)         |
| `label`        | yes      | Display name in the report header                                           |
| `displayOrder` | yes      | Column position (0-indexed)                                                 |
| `isVisible`    | yes      | Whether the column appears in output (hidden columns are excluded from CSV) |
| `formatType`   | no       | Value formatter (see below)                                                 |
| `width`        | no       | Column width in pixels                                                      |

#### Field Paths

Base fields (available for all item types) use a single name:

- `itemNumber`, `name`, `revision`, `state`, `createdAt`, `modifiedAt`

Type-specific fields use dot notation with the table name:

- **Part:** `parts.description`, `parts.partType`, `parts.material`,
  `parts.weight`, `parts.cost`, `parts.leadTimeDays`, `parts.quantityOnHand`,
  `parts.location`
- **Document:** `documents.description`, `documents.fileName`,
  `documents.fileSize`, `documents.mimeType`
- **ChangeOrder:** `change_orders.changeType`, `change_orders.priority`,
  `change_orders.reasonForChange`, `change_orders.riskLevel`
- **Requirement:** `requirements.description`, `requirements.type`,
  `requirements.priority`, `requirements.status`, `requirements.category`
- **Task:** `tasks.description`, `tasks.priority`, `tasks.dueDate`,
  `tasks.estimatedHours`, `tasks.actualHours`

#### Format Types

| Format       | Behavior                         |
| ------------ | -------------------------------- |
| `text`       | Raw string (default)             |
| `number`     | Locale-formatted number          |
| `currency`   | USD currency formatting          |
| `date`       | Date only                        |
| `datetime`   | Date and time                    |
| `boolean`    | "Yes" / "No"                     |
| `percentage` | Multiply by 100, append "%"      |
| `email`      | Plain text (no special handling) |
| `url`        | Plain text (no special handling) |

### Filter Configuration

Each filter specifies a condition that rows must satisfy:

| Property       | Required    | Description                                               |
| -------------- | ----------- | --------------------------------------------------------- |
| `fieldPath`    | yes         | Field to filter on                                        |
| `operator`     | yes         | Comparison operator                                       |
| `value`        | conditional | Comparison value (not needed for `is_null`/`is_not_null`) |
| `value2`       | conditional | End value for `between` operator                          |
| `displayOrder` | yes         | Filter position                                           |

#### Filter Operators

| Operator      | Description                       | Value Required |
| ------------- | --------------------------------- | -------------- |
| `eq`          | Equals                            | yes            |
| `ne`          | Not equals                        | yes            |
| `gt`          | Greater than                      | yes            |
| `lt`          | Less than                         | yes            |
| `gte`         | Greater than or equal             | yes            |
| `lte`         | Less than or equal                | yes            |
| `like`        | Contains (case-insensitive ILIKE) | yes            |
| `not_like`    | Does not contain                  | yes            |
| `in`          | In comma-separated list           | yes            |
| `not_in`      | Not in comma-separated list       | yes            |
| `is_null`     | Field is null                     | no             |
| `is_not_null` | Field is not null                 | no             |
| `starts_with` | Starts with (case-insensitive)    | yes            |
| `ends_with`   | Ends with (case-insensitive)      | yes            |
| `between`     | Between two values (inclusive)    | value + value2 |

### Sort Configuration

Reports support multi-level sorting:

| Property    | Required | Description                 |
| ----------- | -------- | --------------------------- |
| `fieldPath` | yes      | Field to sort by            |
| `direction` | yes      | `asc` or `desc`             |
| `priority`  | yes      | Sort precedence (0 = first) |

When no sorts are configured, the engine defaults to `modifiedAt` descending.

---

## Visibility and Sharing

Reports have four levels of access:

| Mechanism             | Description                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------- |
| **Creator**           | The user who created the report always has access                                         |
| **Public**            | When `isPublic = true`, all authenticated users can see the report                        |
| **Shared with roles** | `sharedWithRoles` is a JSON array of role names; users with any matching role gain access |
| **Shared with users** | `sharedWithUsers` is a JSON array of user UUIDs who gain access                           |

The `ReportService.list()` method evaluates all four conditions with `OR` logic,
so a report is visible if any one of them matches.

---

## Report Execution

Executing a report runs the underlying query against the database and returns
structured results.

### Execution Flow

1. Load the report definition (columns, filters, sorts).
2. Merge saved filters with any runtime filter overrides.
3. Build the SQL query: `items` table joined with the type-specific table
   (e.g., `parts`), with WHERE conditions from filters, ORDER BY from sorts.
4. Execute the query with `limit + 1` rows to detect whether more data exists.
5. Transform raw row data into flat objects keyed by `fieldPath`.
6. Log the execution in `report_executions` (duration, row count, success).
7. Return columns, rows, and pagination metadata.

### Runtime Filter Overrides

When executing a report, callers can pass `runtimeFilters` to add conditions
that supplement (not replace) the saved filters. This enables parameterized
reports:

```json
{
  "limit": 50,
  "offset": 0,
  "runtimeFilters": [
    { "fieldPath": "state", "operator": "eq", "value": "Released" }
  ]
}
```

Runtime filters use the same operator vocabulary as saved filters.

### Execution Result

```json
{
  "data": {
    "result": {
      "reportId": "uuid",
      "reportName": "High-Cost Parts",
      "executedAt": "2026-03-27T12:00:00Z",
      "durationMs": 42,
      "totalRows": 15,
      "columns": [
        {
          "fieldPath": "itemNumber",
          "label": "Item Number",
          "displayOrder": 0,
          "isVisible": true
        }
      ],
      "rows": [
        {
          "itemNumber": "PRT-001",
          "name": "Motor Bracket",
          "parts.cost": 150.0
        }
      ],
      "pagination": {
        "limit": 100,
        "offset": 0,
        "hasMore": false
      }
    }
  }
}
```

### Execution Audit Trail

Every execution is logged in `report_executions`:

- `reportId` -- which report was run
- `executedBy` -- user UUID
- `executedAt` -- timestamp
- `rowCount` -- number of rows returned
- `durationMs` -- query time in milliseconds
- `parameters` -- the execution options that were passed
- `success` -- whether execution completed without error
- `errorMessage` -- error details if execution failed

---

## CSV Export

Reports can be exported to CSV via the export endpoint. The flow is:

1. Execute the report (same as a normal execution).
2. Pass the execution result through `ReportService.exportToCSV()`.
3. Return the CSV as a downloadable file with `Content-Disposition: attachment`.

CSV formatting rules:

- Only visible columns are included.
- Column headers use the configured `label`.
- Values are formatted according to the column's `formatType`.
- Values containing commas, quotes, or newlines are wrapped in double quotes.
- Internal double quotes are escaped as `""`.

The generated filename follows the pattern `report-<id>-<YYYY-MM-DD>.csv`.

Export records are tracked in the `report_exports` table with file size and
storage path metadata.

---

## UI Components

### Report Builder (`/reports/new`, `/reports/:id/edit`)

The `ReportBuilder` component provides a visual form for defining reports:

- **Report Information** -- name, description, item type, public/private toggle
- **Columns** -- add, remove, reorder (up/down), select field and format type
- **Filters** -- add, remove, select field, operator, and value(s)
- **Sorting** -- add, remove, select field and direction with priority ordering

When the item type changes, columns, filters, and sorts are reset to prevent
field path mismatches.

### Report Viewer (`/reports/:id/view`)

The `ReportViewer` component:

- Automatically executes the report on mount
- Displays summary cards (total rows, column count, execution time, active
  filters)
- Renders the result in a table with formatted values
- Provides a Refresh button to re-execute
- Provides an Export CSV button
- Shows pagination info and a "more results available" indicator
- Displays active filter and sort summaries

### Report List (`/reports`)

The `ReportTable` component renders all accessible reports in a DataGrid with:

- Clickable report names linking to the viewer
- Visibility badges (Public/Private)
- Column and filter counts
- Row actions: Run, Edit, Delete

Reports are grouped by item type with summary statistics (total, public,
private, type count).

---

## Report API Reference

### `GET /api/reports`

List all reports accessible to the current user.

| Parameter  | Required | Description                        |
| ---------- | -------- | ---------------------------------- |
| `itemType` | no       | Filter by item type                |
| `limit`    | no       | Page size (default: 100, max: 500) |
| `offset`   | no       | Pagination offset                  |

**Response:**

```json
{
  "data": {
    "reports": [...],
    "total": 12
  }
}
```

### `POST /api/reports`

Create a new report. Body must conform to the `reportSchema` (see
[Report Definitions](#report-definitions) for the full structure). At least one
column is required.

**Response:** `201 Created`

```json
{
  "data": {
    "report": { ... }
  }
}
```

### `GET /api/reports/:id`

Get a single report definition with its columns, filters, and sorts.

**Response:**

```json
{
  "data": {
    "report": { ... }
  }
}
```

### `PUT /api/reports/:id`

Update a report definition. Accepts a partial body -- only the fields included
are updated. When columns, filters, or sorts are provided, they fully replace
the existing set (delete-and-reinsert).

### `DELETE /api/reports/:id`

Delete a report and all its associated columns, filters, sorts, executions, and
exports (cascade).

**Response:**

```json
{
  "data": {
    "success": true
  }
}
```

### `POST /api/reports/:id/execute`

Execute a report and return results.

**Request body (optional):**

```json
{
  "limit": 100,
  "offset": 0,
  "runtimeFilters": [
    { "fieldPath": "state", "operator": "eq", "value": "Released" }
  ]
}
```

**Response:** See [Execution Result](#execution-result) above.

### `POST /api/reports/:id/export`

Execute a report and return the result as a CSV file download.

**Request body (optional):** Same as the execute endpoint. The default limit
for exports is 1000 rows.

**Response:** `200 OK` with `Content-Type: text/csv` and
`Content-Disposition: attachment; filename="report-<id>-<date>.csv"`.

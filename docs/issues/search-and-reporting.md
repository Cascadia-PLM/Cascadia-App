# Issues: Search and Reporting

Issues discovered during documentation of the search and reporting features.

---

## Search Issues

No open search issues at this time. Previously tracked issues (column filter/sort
support, full-text search, enterprise search limit distribution) have been resolved.

---

## Reporting Issues

### R-2: Export endpoint does not record to `report_exports` table

**Location:** `src/routes/api/reports/$id/export.ts`

**Description:** The `report_exports` table exists in the schema
(`src/lib/db/schema/reports.ts`) with columns for export metadata (format,
fileName, fileSize, storagePath), but the export endpoint never inserts a record
into this table. It executes the report and returns CSV directly.

**Impact:** There is no audit trail of exports. The `report_exports` table is
effectively unused.

**Suggested fix:** After generating the CSV, insert a record into
`report_exports` with the report ID, execution ID, format, filename, and file
size.

---

### R-3: ReportBuilder defines fields for "Project" type but service does not support it

**Location:** `src/components/reports/ReportBuilder.tsx`, lines 164-201

**Description:** The `getAvailableFields()` function defines field paths for a
"Project" item type (e.g., `projects.description`, `projects.budget`,
`projects.startDate`), but:

1. "Project" is not in the `itemTypes` dropdown (so users cannot select it).
2. `ReportService.typeTableMap` does not include a `projects` entry.
3. There is no `projects` table in the database schema.

**Impact:** Dead code. No user-facing impact since the type cannot be selected,
but it adds confusion for developers.

**Suggested fix:** Either remove the "Project" field definitions from
`getAvailableFields()`, or add Project support throughout the stack if it is a
planned item type.

---

### R-4: Report types missing TestPlan, TestCase, and Issue support

**Description:** `ItemSearchService` supports TestPlan, TestCase, and Issue
item types for search. However, `ReportService.typeTableMap` only maps Part,
Document, ChangeOrder, Requirement, and Task. Reports cannot be created for
TestPlan, TestCase, or Issue items.

Similarly, the `ReportBuilder` component's `itemTypes` dropdown only lists Part,
Document, Change Order, Requirement, and Task.

**Impact:** Users cannot create reports for test plans, test cases, or issues.

**Suggested fix:** Add `TestPlan`, `TestCase`, and `Issue` to
`ReportService.typeTableMap` and to the `ReportBuilder` itemTypes list, with
corresponding field definitions in `getAvailableFields()`.

---

### R-5: Report list pagination is client-side

**Location:** `src/routes/api/reports.ts`, line 33

**Description:** The `GET /api/reports` endpoint fetches all accessible reports
from `ReportService.list()`, then slices the result in memory for pagination:

```typescript
const reports = allReports.slice(offset, offset + limit)
```

**Impact:** For organizations with many saved reports, every list request loads
all reports from the database. This is inefficient but unlikely to be a problem
until the report count grows large.

**Suggested fix:** Push `limit` and `offset` into the database query inside
`ReportService.list()`.

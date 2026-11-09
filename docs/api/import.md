# Import API

Bulk data import endpoints for creating items from external sources (CSV, XLSX, or direct JSON). Supports parts, documents, requirements and issues with branch-aware creation for post-release designs.

## Overview

| Endpoint                                | Method | Auth          | Description                                   |
| --------------------------------------- | ------ | ------------- | --------------------------------------------- |
| `/api/v1/import/parts`                  | POST   | Auth required | Bulk import parts (with optional BOM)         |
| `/api/v1/import/documents`              | POST   | Auth required | Bulk import documents                         |
| `/api/v1/import/requirements`           | POST   | Auth required | Bulk import requirements (with the hierarchy) |
| `/api/v1/import/issues`                 | POST   | Auth required | Bulk import issues                            |
| `/api/v1/import/templates/parts`        | GET    | Public        | Download parts CSV template                   |
| `/api/v1/import/templates/documents`    | GET    | Public        | Download documents CSV template               |
| `/api/v1/import/templates/requirements` | GET    | Public        | Download requirements CSV template            |
| `/api/v1/import/templates/issues`       | GET    | Public        | Download issues CSV template                  |

## How an import runs

An import is a **background job** on the jobs worker. There is no row limit:
the rows are written by the job, not inside the HTTP request that sends them.

1. `POST` the rows. The route checks everything that can be checked up front
   — the body's shape, the `create` permission for the item type, access to
   the design and branch, the Administrator role for `bypassBranchProtection`
   and `importAsReleased`, and the post-release branch requirement — and
   refuses the whole request if any fails. Nothing is queued for a refused
   request.
2. An admitted request answers **`202 Accepted`** with the job's id, and a
   `Location` header naming where to watch it:

   ```json
   { "data": { "jobId": "uuid" } }
   ```

3. Poll `GET /api/v1/jobs/{jobId}` (the submitter, or a holder of
   `system:manage`, may read it). It reports `status` (`queued`, `running`,
   `completed`, `failed`, `cancelled`), `progress` (0–100) and a
   `progressMessage` such as `Processed 1,200 of 4,000 rows`.
4. When `status` is `completed`, the job's `result` is the import's
   row-by-row outcome — the object each section below describes. A row that
   fails is reported in `result.failedRows` and the rest of the sheet still
   imports, so a completed job may still carry failures.

A few things follow from running as a job:

- **The jobs worker must be running.** When the job queue (RabbitMQ) cannot
  be reached, the `POST` answers `503` with `EXTERNAL_SERVICE_UNAVAILABLE` and
  nothing is queued. When the queue is up but no worker is consuming it, the
  job stays `queued` until one starts.
- **An import is never retried.** A run that fails part-way has already
  created rows, and a second run would only fail them again as duplicates.
  The job ends `failed`, and its `progressMessage` says how far it got.
- **Rows already created are kept** when a run stops — a cancel from the
  admin jobs page, or the job's one-hour run time running out. Each row is
  its own transaction; the run stops between rows.

## POST /api/v1/import/parts

Bulk-create parts from an array of row data. Optionally includes BOM relationships that wire up parent-child links between the newly created parts and/or existing parts in the design.

### Request Body

```json
{
  "designId": "uuid",
  "branchId": "uuid",
  "rows": [
    {
      "name": "Aluminum Housing",
      "itemNumber": "PN-000001",
      "partType": "Manufacture",
      "description": "Main housing for the motor assembly",
      "material": "Aluminum 6061-T6",
      "weight": "2.5",
      "weightUnit": "kg",
      "cost": "125.00",
      "costCurrency": "USD",
      "leadTimeDays": 14,
      "revision": "-",
      "attributes": { "finish": "anodized" }
    }
  ],
  "bomRelationships": [
    {
      "parentItemNumber": "ASM-001",
      "childItemNumber": "PN-000001",
      "quantity": 2,
      "findNumber": 1,
      "referenceDesignator": "R1, R2"
    }
  ],
  "bypassBranchProtection": false,
  "importAsReleased": false
}
```

### Parameters

#### Top-level fields

| Field                    | Type    | Required    | Description                                                                                |
| ------------------------ | ------- | ----------- | ------------------------------------------------------------------------------------------ |
| `designId`               | UUID    | Yes         | Target design for the imported parts                                                       |
| `branchId`               | UUID    | Conditional | Required for post-release designs unless bypass or formal baseline import is enabled       |
| `rows`                   | Array   | Yes         | Part rows to import: at least one, no upper limit                                          |
| `bomRelationships`       | Array   | No          | BOM parent-child relationships to create after parts are imported                          |
| `bypassBranchProtection` | boolean | No          | If true, create directly on main even for post-release designs (default: false)            |
| `importAsReleased`       | boolean | No          | Administrator-only import of existing formal revisions directly onto main (default: false) |

#### Row fields

| Field          | Type    | Required | Constraints                                      | Description                             |
| -------------- | ------- | -------- | ------------------------------------------------ | --------------------------------------- |
| `name`         | string  | Yes      | 1-500 chars                                      | Part name                               |
| `itemNumber`   | string  | No       | Max 100 chars                                    | Item number (auto-generated if omitted) |
| `revision`     | string  | No       | 1-10 chars                                       | Revision letter (default: `-`)          |
| `description`  | string  | No       | Max 5000 chars                                   | Part description                        |
| `partType`     | enum    | No       | `Manufacture`, `Purchase`, `Software`, `Phantom` | Part sourcing type                      |
| `material`     | string  | No       | Max 100 chars                                    | Material specification                  |
| `weight`       | string  | No       | -                                                | Weight value                            |
| `weightUnit`   | string  | No       | Max 10 chars                                     | Weight unit (e.g., `kg`, `lb`)          |
| `cost`         | string  | No       | -                                                | Unit cost                               |
| `costCurrency` | string  | No       | Exactly 3 chars                                  | ISO 4217 currency code (e.g., `USD`)    |
| `leadTimeDays` | integer | No       | >= 0                                             | Procurement lead time in days           |
| `attributes`   | object  | No       | string keys/values                               | Custom attributes from unmapped columns |

#### BOM relationship fields

| Field                 | Type    | Required | Default | Description                    |
| --------------------- | ------- | -------- | ------- | ------------------------------ |
| `parentItemNumber`    | string  | Yes      | -       | Item number of parent assembly |
| `childItemNumber`     | string  | Yes      | -       | Item number of child component |
| `quantity`            | number  | No       | 1       | Quantity per assembly (>= 0)   |
| `findNumber`          | integer | No       | -       | Find number / sequence in BOM  |
| `referenceDesignator` | string  | No       | -       | Reference designator(s)        |

### Response

**202 Accepted** -- The import is queued; see [How an import runs](#how-an-import-runs).

The completed job's `result` (from `GET /api/v1/jobs/{jobId}`):

```json
{
  "totalRows": 5,
  "successCount": 4,
  "errorCount": 1,
  "createdItems": [
    { "rowNumber": 2, "itemId": "uuid", "itemNumber": "P-1001" },
    { "rowNumber": 3, "itemId": "uuid", "itemNumber": "P-1002" }
  ],
  "failedRows": [{ "rowNumber": 6, "errors": ["Name is required"] }],
  "relationshipsCreated": 3,
  "relationshipsFailed": 0,
  "failedRelationships": []
}
```

### Branch-aware import

The import behavior depends on the design's lifecycle phase:

| Design Phase | `branchId` provided | Bypass | Formal baseline | Behavior                                                     |
| ------------ | ------------------- | ------ | --------------- | ------------------------------------------------------------ |
| Pre-release  | No                  | -      | false           | Creates directly on main                                     |
| Pre-release  | Yes                 | -      | false           | Creates on specified branch                                  |
| Post-release | Yes                 | false  | false           | Creates on specified branch via `ItemService.createOnBranch` |
| Post-release | No                  | false  | false           | **Error**: Branch ID required                                |
| Post-release | No                  | true   | false           | Creates directly, bypassing branch protection                |
| Any          | No                  | -      | true            | Creates an existing formal release directly on main          |
| Any          | Yes                 | -      | true            | **Error**: formal baseline imports cannot target a branch    |

### Importing an existing formal release

Set `importAsReleased` to `true` when migrating Parts or Documents whose
release already happened in the source system. This mode is restricted to the
`Administrator` role. It is not a shortcut for ordinary revision changes.

- Every row must provide a formal `revision`; the ordinary `-` default is
  rejected.
- The revision must match the revision scheme active in the lifecycle's
  release state, for example `R4` for an `R`-prefixed numeric scheme.
- The item is created in the lifecycle state targeted by its `release` action,
  directly on main, as the current formal version.
- `branchId` must be omitted. No placeholder ECO or intermediate revisions are
  created.
- A later normal revise action continues from the imported value (for example,
  `R4` becomes `R5`). The revision is not encoded in the Item Number.

### BOM relationship resolution

When `bomRelationships` are provided, the endpoint:

1. Builds a map from item numbers to item IDs using newly created items
2. Searches existing items in the design to resolve parent references not in the import batch
3. Processes each relationship, creating `BOM` type links via `ItemService.addRelationship`
4. Reports relationship successes and failures separately in the response

A parent lists a child once per distinct line: two rows naming the same child
are two lines only when they differ in reference designators, option
condition or target execution. Otherwise the file has one edge to give — the
first line is created and each later one is reported in `failedRelationships`,
named by both item numbers; combine the lines and sum their quantities, or
give each its own designators. See
[Edge identity](./relationships.md#edge-identity). The import wizard flags
this in the validation preview, before anything is uploaded.

---

## POST /api/v1/import/documents

Bulk-create documents. Follows the same branch-aware pattern as parts import. Additionally enforces design access and branch access checks, and requires the `Administrator` role to use `bypassBranchProtection`.

### Request Body

```json
{
  "designId": "uuid",
  "branchId": "uuid",
  "rows": [
    {
      "name": "Motor Assembly Drawing",
      "itemNumber": "DOC-001",
      "description": "Assembly drawing for the motor housing",
      "docType": "Drawing",
      "fileName": "motor-assy.pdf",
      "mimeType": "application/pdf"
    }
  ],
  "bypassBranchProtection": false,
  "importAsReleased": false
}
```

### Row fields

| Field         | Type   | Required | Constraints                                                          | Description                             |
| ------------- | ------ | -------- | -------------------------------------------------------------------- | --------------------------------------- |
| `name`        | string | Yes      | 1-500 chars                                                          | Document name                           |
| `itemNumber`  | string | No       | Max 100 chars                                                        | Item number (auto-generated if omitted) |
| `revision`    | string | No       | 1-10 chars                                                           | Revision letter (default: `-`)          |
| `description` | string | No       | Max 5000 chars                                                       | Document description                    |
| `docType`     | enum   | No       | `Specification`, `Drawing`, `Procedure`, `Manual`, `Report`, `Other` | Document category                       |
| `fileName`    | string | No       | Max 500 chars                                                        | Associated file name                    |
| `mimeType`    | string | No       | Max 100 chars                                                        | MIME type of associated file            |
| `attributes`  | object | No       | string keys/values                                                   | Custom attributes                       |

### Response

**202 Accepted**, as for parts. The completed job's `result` has the same
structure as the parts import's, without the BOM relationship fields.
Documents also support the Administrator-only `importAsReleased` mode
described above.

---

## POST /api/v1/import/issues

Bulk-create issues. Issues use a free lifecycle (`Open` state) and do not require design or branch context. They can optionally be associated with a program.

### Request Body

```json
{
  "programId": "uuid",
  "rows": [
    {
      "name": "Motor overheating under load",
      "severity": "High",
      "priority": "Critical",
      "category": "Design",
      "reportedDate": "2025-01-15",
      "description": "Motor temperature exceeds 95C after 30 minutes at full load",
      "rootCause": "Insufficient heatsink surface area"
    }
  ]
}
```

### Parameters

| Field       | Type  | Required | Description                              |
| ----------- | ----- | -------- | ---------------------------------------- |
| `programId` | UUID  | No       | Associate imported issues with a program |
| `rows`      | Array | Yes      | Issue rows: at least one, no upper limit |

### Row fields

| Field          | Type   | Required | Constraints                                                         | Description                             |
| -------------- | ------ | -------- | ------------------------------------------------------------------- | --------------------------------------- |
| `name`         | string | Yes      | 1-500 chars                                                         | Issue title                             |
| `itemNumber`   | string | No       | Max 100 chars                                                       | Item number (auto-generated if omitted) |
| `description`  | string | No       | Max 10000 chars                                                     | Issue description                       |
| `severity`     | enum   | No       | `Critical`, `High`, `Medium`, `Low`                                 | Issue severity                          |
| `priority`     | enum   | No       | `Critical`, `High`, `Medium`, `Low`                                 | Issue priority                          |
| `category`     | enum   | No       | `Design`, `Manufacturing`, `Quality`, `Customer`, `Safety`, `Other` | Issue category                          |
| `reportedDate` | string | No       | ISO date string                                                     | Date the issue was reported             |
| `resolution`   | string | No       | Max 10000 chars                                                     | Resolution description                  |
| `rootCause`    | string | No       | Max 10000 chars                                                     | Root cause analysis                     |
| `attributes`   | object | No       | string keys/values                                                  | Custom attributes                       |

### Response

**202 Accepted**, as for parts. The completed job's `result` has the same
structure as the parts import's, without the BOM relationship fields.

---

## GET /api/v1/import/templates/:type

Download a CSV template with headers and an example row for the specified item type.

### Endpoints

| URL                                  | File name                       |
| ------------------------------------ | ------------------------------- |
| `/api/v1/import/templates/parts`     | `parts-import-template.csv`     |
| `/api/v1/import/templates/documents` | `documents-import-template.csv` |
| `/api/v1/import/templates/issues`    | `issues-import-template.csv`    |

### Query Parameters

| Parameter | Type   | Default | Description                                                                   |
| --------- | ------ | ------- | ----------------------------------------------------------------------------- |
| `format`  | string | `csv`   | Template format. Currently only `csv` is supported; `xlsx` falls back to CSV. |

### Response

Returns a CSV file download with:

- Row 1: Column headers (human-readable labels)
- Row 2: Example values

```
Item Number,Name,Revision,Description,Type,Material,Weight,Weight Unit,Cost,Currency,Lead Time (Days)
PN-000001,Aluminum Housing,-,Main housing for the motor assembly,Manufacture,Aluminum 6061-T6,2.5,kg,125.00,USD,14
```

---

## Error responses

All import endpoints use the standard Cascadia error envelope:

**422 Validation Error** (request body fails schema validation):

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Name is required; Design ID is required"
  }
}
```

**403 Forbidden** -- the caller may not create this item type, may not reach
the design or branch, or sent `bypassBranchProtection`/`importAsReleased`
without the Administrator role. Nothing is queued.

**503 Service Unavailable** (`EXTERNAL_SERVICE_UNAVAILABLE`) -- the job queue
cannot be reached, so the import cannot run. Nothing is queued.

Row failures are not HTTP errors: they are reported in the completed job's
`result`. A sheet whose every row failed is a completed job with
`successCount: 0`:

```json
{
  "totalRows": 2,
  "successCount": 0,
  "errorCount": 2,
  "createdItems": [],
  "failedRows": [
    {
      "rowNumber": 2,
      "errors": ["Part number 'PN-000001' already exists"]
    },
    { "rowNumber": 3, "errors": ["Name is required"] }
  ]
}
```

Per-row and per-relationship messages are always ours. An error the service
layer did not classify is logged and reported as `Failed to create <type>`
rather than passed through: the underlying text is the database driver's, and
its message is the statement that failed together with every bound parameter.

## Limits

| Constraint                 | Value                               |
| -------------------------- | ----------------------------------- |
| Maximum rows per import    | None (one hour of run time per job) |
| Maximum item number length | 100 characters                      |
| Maximum name length        | 500 characters                      |
| Maximum description length | 5000 characters (10000 for issues)  |

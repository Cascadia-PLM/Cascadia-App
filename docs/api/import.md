# Import API

Bulk data import endpoints for creating items from external sources (CSV, XLSX, or direct JSON). Supports parts, documents, and issues with branch-aware creation for post-release designs.

## Overview

| Endpoint                          | Method | Auth          | Description                           |
| --------------------------------- | ------ | ------------- | ------------------------------------- |
| `/api/import/parts`               | POST   | Auth required | Bulk import parts (with optional BOM) |
| `/api/import/documents`           | POST   | Auth required | Bulk import documents                 |
| `/api/import/issues`              | POST   | Auth required | Bulk import issues                    |
| `/api/import/templates/parts`     | GET    | Public        | Download parts CSV template           |
| `/api/import/templates/documents` | GET    | Public        | Download documents CSV template       |
| `/api/import/templates/issues`    | GET    | Public        | Download issues CSV template          |

## POST /api/import/parts

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
  "bypassBranchProtection": false
}
```

### Parameters

#### Top-level fields

| Field                    | Type    | Required    | Description                                                                     |
| ------------------------ | ------- | ----------- | ------------------------------------------------------------------------------- |
| `designId`               | UUID    | Yes         | Target design for the imported parts                                            |
| `branchId`               | UUID    | Conditional | Required for post-release designs (unless `bypassBranchProtection` is true)     |
| `rows`                   | Array   | Yes         | 1-500 part rows to import                                                       |
| `bomRelationships`       | Array   | No          | BOM parent-child relationships to create after parts are imported               |
| `bypassBranchProtection` | boolean | No          | If true, create directly on main even for post-release designs (default: false) |

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

**201 Created** -- All rows imported successfully.

**207 Multi-Status** -- Some rows succeeded, some failed.

**400 Bad Request** -- All rows failed or validation error.

```json
{
  "data": {
    "result": {
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
  }
}
```

### Branch-aware import

The import behavior depends on the design's lifecycle phase:

| Design Phase | `branchId` provided | `bypassBranchProtection` | Behavior                                                     |
| ------------ | ------------------- | ------------------------ | ------------------------------------------------------------ |
| Pre-release  | No                  | -                        | Creates directly on main                                     |
| Pre-release  | Yes                 | -                        | Creates on specified branch                                  |
| Post-release | Yes                 | false                    | Creates on specified branch via `ItemService.createOnBranch` |
| Post-release | No                  | false                    | **Error**: Branch ID required                                |
| Post-release | No                  | true                     | Creates directly, bypassing branch protection                |

### BOM relationship resolution

When `bomRelationships` are provided, the endpoint:

1. Builds a map from item numbers to item IDs using newly created items
2. Searches existing items in the design to resolve parent references not in the import batch
3. Processes each relationship, creating `BOM` type links via `ItemService.addRelationship`
4. Reports relationship successes and failures separately in the response

---

## POST /api/import/documents

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
  "bypassBranchProtection": false
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

Same structure as parts import (without BOM relationship fields).

---

## POST /api/import/issues

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
| `rows`      | Array | Yes      | 1-500 issue rows to import               |

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

Same structure as parts import (without BOM relationship fields).

---

## GET /api/import/templates/:type

Download a CSV template with headers and an example row for the specified item type.

### Endpoints

| URL                               | File name                       |
| --------------------------------- | ------------------------------- |
| `/api/import/templates/parts`     | `parts-import-template.csv`     |
| `/api/import/templates/documents` | `documents-import-template.csv` |
| `/api/import/templates/issues`    | `issues-import-template.csv`    |

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

**400 Bad Request** (all rows failed):

```json
{
  "data": {
    "result": {
      "totalRows": 2,
      "successCount": 0,
      "errorCount": 2,
      "createdItems": [],
      "failedRows": [
        { "rowNumber": 2, "errors": ["Duplicate item number"] },
        { "rowNumber": 3, "errors": ["Name is required"] }
      ]
    }
  }
}
```

## Limits

| Constraint                 | Value                              |
| -------------------------- | ---------------------------------- |
| Maximum rows per request   | 500                                |
| Maximum item number length | 100 characters                     |
| Maximum name length        | 500 characters                     |
| Maximum description length | 5000 characters (10000 for issues) |

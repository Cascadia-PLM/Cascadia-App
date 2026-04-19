# Import/Export

Bulk data import from spreadsheets with intelligent column mapping and BOM structure parsing. Cascadia supports importing Parts, Documents, and Issues from Excel and CSV files through a multi-step wizard UI or direct API calls.

## Overview

The import system is designed for migrating data from other PLM systems, ERP exports, or engineering spreadsheets. It handles the full pipeline from file parsing through validation to item creation, with BOM (Bill of Materials) relationship support for parts.

**Key capabilities:**

- Parse Excel (.xlsx, .xls) and CSV files up to 10 MB
- Auto-detect column mappings from header names using alias matching
- Validate every row against Zod schemas before import
- Create up to 500 items per import batch
- Detect and import BOM structure from level-based, parent-child, or flat formats
- Branch-aware import: create items on ECO branches for post-release designs
- Collect unmapped columns as custom attributes on the created items

**Supported item types:** Part, Document, Issue

### Architecture

The import system is organized into these layers:

| Layer         | Location                        | Responsibility                                                   |
| ------------- | ------------------------------- | ---------------------------------------------------------------- |
| Parser        | `src/lib/import/parser.ts`      | File reading, Excel/CSV parsing, cell value extraction           |
| Mapper        | `src/lib/import/mapper.ts`      | Column auto-detection, mapping application, attribute collection |
| Validator     | `src/lib/import/validator.ts`   | Row validation, duplicate detection, BOM structure validation    |
| BOM Parser    | `src/lib/import/bom-parser.ts`  | BOM format detection, relationship extraction                    |
| Field Configs | `src/lib/import/field-configs/` | Per-type field definitions with aliases                          |
| Types         | `src/lib/import/types.ts`       | Zod schemas, TypeScript interfaces                               |
| API Routes    | `src/routes/api/import/`        | Server-side endpoints for bulk creation                          |
| UI Components | `src/components/import/`        | Multi-step wizard dialog                                         |

---

## Excel Import (.xlsx, .xls)

Excel files are parsed using ExcelJS. The parser reads the first worksheet, extracts headers from the first row, and converts all subsequent rows into key-value objects.

**Supported features:**

- `.xlsx` (Office Open XML) and `.xls` (legacy Excel) formats
- Multi-sheet workbooks (first sheet is used)
- Column positions are preserved even with empty cells
- Maximum file size: 10 MB
- Maximum rows: 500 (after header row, excluding empty rows)

### Rich Text Handling

Excel cells containing rich text (mixed formatting within a single cell) are automatically flattened to plain text. The parser concatenates all `richText` segments:

```typescript
// ExcelJS rich text cell: { richText: [{ text: "Bold" }, { text: " normal" }] }
// Extracted value: "Bold normal"
```

This means formatting is stripped, but all text content is preserved.

### Formula Result Extraction

Cells containing formulas are resolved to their calculated result values, not the formula strings. The parser reads `CellFormulaValue.result`:

```typescript
// Cell contains: =A1*B1 (result: 42)
// Extracted value: 42
```

If a formula has not been calculated (no cached result), the raw formula object may be returned.

### Other Cell Types

| Cell Type                      | Handling                                 |
| ------------------------------ | ---------------------------------------- |
| Hyperlinks                     | Extracts display text, falls back to URL |
| Dates                          | Returned as JavaScript `Date` objects    |
| Error values (`#REF!`, `#N/A`) | Returned as empty string                 |
| Null/undefined                 | Returned as empty string                 |
| Numbers, strings, booleans     | Returned as-is                           |

---

## CSV Import

CSV files are parsed using a built-in RFC 4180-compliant parser. The parser handles:

- Comma-separated fields
- Quoted fields (double-quote delimited)
- Escaped quotes within quoted fields (`""` represents a literal `"`)
- Windows (`\r\n`) and Unix (`\n`) line endings
- Empty lines are skipped

**Example of supported CSV:**

```csv
Part Number,Name,Description,Type,Quantity
PN-001,"Aluminum Housing","Main housing, 6061-T6",Manufacture,1
PN-002,"Hex Bolt, M6x20","Standard hex bolt with ""washer face""",Purchase,12
PN-003,PCB Assembly,Main control board,Manufacture,1
```

The CSV parser does not use ExcelJS for CSV files. Instead, it decodes the file as UTF-8 text and runs a character-by-character state machine parser.

---

## Column Auto-Mapping

When a file is uploaded, headers are automatically matched to target fields using an alias-based similarity algorithm. Each field has a list of known aliases that represent common column names used across different PLM systems and ERP exports.

### How Matching Works

1. Each file header is normalized: lowercased, separators converted to spaces, special characters removed.
2. The normalized header is compared against all aliases and the field label for every unmapped field.
3. A similarity score (0.0 to 1.0) is calculated using:
   - **Exact match**: score 1.0
   - **Substring containment**: score 0.7-0.9 (proportional to length ratio)
   - **Word overlap**: score 0.5-0.8 (proportional to shared word count)
4. The best match above the 0.5 threshold is selected.
5. Each target field can only be mapped once (first-come, first-served by column order).

### Part Field Aliases

| Target Field     | Recognized Headers                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Item Number      | `item number`, `part number`, `pn`, `part#`, `sku`, `item#`, `number`, `id`                                 |
| Name             | `name`, `part name`, `title`, `description`, `item name`, `component`, `component name`                     |
| Revision         | `revision`, `rev`, `version`, `ver`, `release`                                                              |
| Description      | `description`, `desc`, `details`, `notes`, `comments`, `remarks`, `specification`, `spec`                   |
| Type             | `part type`, `make buy`, `make/buy`, `manufacture`, `purchase`, `procurement`, `source`, `sourcing`, `type` |
| Material         | `material`, `mat`, `materials`, `raw material`, `substance`, `composition`                                  |
| Weight           | `weight`, `mass`, `wt`                                                                                      |
| Weight Unit      | `weight unit`, `mass unit`, `wt unit`, `unit of weight`, `uom weight`                                       |
| Cost             | `cost`, `price`, `unit cost`, `unit price`, `amount`                                                        |
| Currency         | `currency`, `cost currency`, `curr`, `money unit`                                                           |
| Lead Time (Days) | `lead time`, `leadtime`, `lead time days`, `lt`, `lead days`, `procurement time`, `delivery time`           |

### Document Field Aliases

| Target Field    | Recognized Headers                                                                    |
| --------------- | ------------------------------------------------------------------------------------- |
| Document Number | `document number`, `doc number`, `doc#`, `item number`, `number`, `id`, `document id` |
| Name            | `name`, `title`, `document name`, `doc name`, `document title`, `subject`             |
| Description     | `description`, `desc`, `details`, `notes`, `comments`, `summary`, `abstract`          |
| Document Type   | `doc type`, `document type`, `type`, `category`                                       |
| File Name       | `file name`, `filename`, `file`, `attachment`                                         |
| MIME Type       | `mime type`, `file type`, `content type`, `media type`                                |
| Revision        | `revision`, `rev`, `version`, `ver`, `release`                                        |

### Issue Field Aliases

| Target Field  | Recognized Headers                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------ |
| Issue Number  | `issue number`, `issue#`, `ticket`, `ticket number`, `item number`, `defect id`, `defect number` |
| Title         | `title`, `name`, `summary`, `subject`, `issue title`, `problem`, `headline`                      |
| Description   | `description`, `desc`, `details`, `notes`, `comments`, `body`, `content`                         |
| Severity      | `severity`, `sev`, `impact`, `severity level`                                                    |
| Priority      | `priority`, `pri`, `urgency`, `importance`                                                       |
| Category      | `category`, `type`, `issue type`, `classification`, `area`                                       |
| Reported Date | `reported date`, `date reported`, `opened`, `open date`, `created date`, `submitted date`        |
| Resolution    | `resolution`, `fix`, `solution`, `action taken`                                                  |
| Root Cause    | `root cause`, `cause`, `reason`, `rca`, `why`                                                    |

### Manual Override

Users can manually adjust any auto-detected mapping in the Column Mapping step of the wizard. When a target field is reassigned, the previously mapped column is automatically cleared to prevent duplicates. Unmapped columns can be set to "Skip this column" to exclude them, or left unmapped to be collected as custom attributes.

### Custom Attributes from Unmapped Columns

Columns that are not mapped to any standard field are automatically collected into an `attributes` object on each created item. The column name is sanitized to create the attribute key:

- Whitespace replaced with underscores
- Non-alphanumeric characters (except `_` and `-`) removed
- Converted to lowercase

For example, a column named `Supplier Code` becomes the attribute key `supplier_code`.

---

## Validation Preview

Before any data is written to the database, every row is validated and presented in a review step. The validation pipeline:

1. **Type coercion**: Values are converted to expected types (strings trimmed, numbers parsed, enum values matched case-insensitively).
2. **Schema validation**: Each row is validated against the Zod schema for the item type (`importPartRowSchema`, `importDocumentRowSchema`, or `importIssueRowSchema`).
3. **Duplicate detection**: Item numbers are checked for uniqueness within the file. Duplicates are flagged as errors referencing the first occurrence.
4. **Warnings**: Non-blocking issues like missing descriptions or special characters in item numbers.
5. **Default values**: Revision defaults to `"-"` for Parts and Documents if not provided.

### Validation Summary

The review step displays:

- **Total rows**, **valid rows**, and **invalid rows** counts
- **Error breakdown by field**: Shows which fields have the most errors
- **Row-level detail table**: Each row shows its status (Valid/Error), mapped field values, and specific error/warning messages
- **Filter controls**: Toggle between All, Valid, and Invalid rows

### What Gets Imported

Only valid rows are imported. Invalid rows are skipped. The "Import N Parts" button shows the exact count of items that will be created.

---

## Bulk Part Creation

The import system creates items one at a time in a loop, which allows individual row failures to be tracked without aborting the entire batch.

**Limits:**

- Minimum: 1 row
- Maximum: 500 rows per import
- Maximum file size: 10 MB

**Response status codes:**

| Status | Meaning                                            |
| ------ | -------------------------------------------------- |
| 201    | All rows imported successfully                     |
| 207    | Partial success (some rows succeeded, some failed) |
| 400    | All rows failed                                    |

Each created item is returned with its `rowNumber`, `itemId`, and `itemNumber`. Failed rows include error messages.

### Pre-Release vs Post-Release

The import behavior depends on the design's lifecycle phase:

- **Pre-release design**: Items are created directly on the main branch. The `bypassBranchProtection` flag is set automatically.
- **Post-release design**: Items must be created on an ECO or workspace branch. The user selects the target branch in the context step. Items are created via `ItemService.createOnBranch()`.

---

## BOM Import Formats

The import system supports three BOM (Bill of Materials) formats, plus automatic format detection. BOM import is only available for Part imports.

### Level-Based (Indented) BOM

The most common format exported from PDM systems. Each row has a `Level` column indicating its depth in the assembly tree. Level 0 is the top-level assembly.

```csv
Level,Part Number,Name,Type,Qty
0,ASM-001,Motor Assembly,Manufacture,1
1,PN-001,Housing,Manufacture,1
1,PN-002,Motor,Purchase,1
2,PN-003,Rotor,Manufacture,1
2,PN-004,Stator,Manufacture,1
1,PN-005,Cover Plate,Manufacture,2
```

**Algorithm:** A stack tracks the current parent at each level. For each row, the stack is popped until the top item's level is less than the current row's level. The top of the stack becomes the parent.

This produces the relationships:

- ASM-001 -> PN-001 (qty 1)
- ASM-001 -> PN-002 (qty 1)
- PN-002 -> PN-003 (qty 1)
- PN-002 -> PN-004 (qty 1)
- ASM-001 -> PN-005 (qty 2)

### Parent-Child BOM

Each row explicitly names its parent via a `Parent` column. This format is common in ERP exports.

```csv
Part Number,Name,Parent,Qty,Find #
ASM-001,Motor Assembly,,1,
PN-001,Housing,ASM-001,1,1
PN-002,Motor,ASM-001,1,2
PN-003,Rotor,PN-002,1,1
PN-004,Stator,PN-002,1,2
PN-005,Cover Plate,ASM-001,2,3
```

Rows without a parent value are treated as top-level items (no parent relationship created). If a parent item number is not found in the file, it is looked up in existing items within the design.

### Flat Parts List

A simple list of parts with no hierarchy information. No BOM relationships are created. Parts are imported as standalone items.

```csv
Part Number,Name,Type,Material,Cost
PN-001,Housing,Manufacture,Aluminum 6061-T6,125.00
PN-002,Motor,Purchase,,350.00
PN-003,Rotor,Manufacture,Steel 4140,45.00
```

### Auto-Detect BOM Format

The system automatically detects the BOM format based on which columns are mapped:

| Mapped Columns                      | Detected Format         | Confidence |
| ----------------------------------- | ----------------------- | ---------- |
| `level` only                        | Level-based             | 0.85       |
| `level` + `quantity`                | Level-based             | 0.95       |
| `parentItemNumber` only             | Parent-child            | 0.85       |
| `parentItemNumber` + `quantity`     | Parent-child            | 0.95       |
| Both `level` and `parentItemNumber` | Level-based (preferred) | 0.70       |
| Neither                             | Flat                    | 1.00       |

The detected format and relationship count are displayed in the validation preview step.

---

## BOM Import Fields

In addition to standard part fields, BOM imports support these relationship fields:

| Field                | Type   | Description                        | Aliases                                                                       |
| -------------------- | ------ | ---------------------------------- | ----------------------------------------------------------------------------- |
| BOM Level            | number | Hierarchy depth (0 = top)          | `level`, `bom level`, `indent`, `lvl`, `hierarchy`                            |
| Parent Item Number   | string | Parent assembly's item number      | `parent`, `parent item number`, `parent part number`, `parent pn`, `assembly` |
| Quantity             | number | Quantity per assembly (default: 1) | `qty`, `quantity`, `qty per`, `qty/assy`, `count`                             |
| Find Number          | number | Position identifier on drawings    | `find #`, `find number`, `find no`, `item no`, `seq`, `sequence`              |
| Reference Designator | string | Component reference (e.g., R1, R2) | `ref des`, `reference designator`, `designator`                               |

### External Parent Support

When a parent item number referenced in the file does not exist among the rows being imported, the system looks it up in existing items within the target design. If found, the relationship is created between the existing parent and the newly imported child. If not found, the relationship creation fails with an error indicating "Parent item not found."

---

## BOM Validation

Before import, BOM relationships are validated for structural integrity:

### Cycle Detection

A depth-first search (DFS) traversal checks for circular references in the parent-child graph. If a cycle is detected (e.g., A -> B -> C -> A), it is reported as an error listing the involved item numbers.

### Self-Reference Detection

Items that reference themselves as their own parent are flagged as errors.

### Duplicate Checking

Within the file, item numbers are checked for uniqueness. Duplicate item numbers in different rows are flagged as validation errors.

### External Parent Warnings

Parents that are not in the import file are reported as warnings (not errors). The system will attempt to look them up in the existing design data during import.

---

## Import API

All import endpoints require authentication. Request bodies are validated with Zod schemas.

### POST /api/import/parts

Creates parts in bulk, optionally with BOM relationships.

**Request body:**

```json
{
  "designId": "uuid",
  "branchId": "uuid (optional, required for post-release)",
  "bypassBranchProtection": false,
  "rows": [
    {
      "name": "Aluminum Housing",
      "itemNumber": "PN-001",
      "revision": "-",
      "description": "Main housing for motor assembly",
      "partType": "Manufacture",
      "material": "Aluminum 6061-T6",
      "weight": "2.5",
      "weightUnit": "kg",
      "cost": "125.00",
      "costCurrency": "USD",
      "leadTimeDays": 14,
      "attributes": {
        "supplier_code": "SUP-042",
        "color": "silver"
      }
    }
  ],
  "bomRelationships": [
    {
      "parentItemNumber": "ASM-001",
      "childItemNumber": "PN-001",
      "quantity": 1,
      "findNumber": 1,
      "referenceDesignator": "H1"
    }
  ]
}
```

**Part row fields:**

| Field          | Type              | Required | Notes                                            |
| -------------- | ----------------- | -------- | ------------------------------------------------ |
| `name`         | string (1-500)    | Yes      |                                                  |
| `itemNumber`   | string (max 100)  | No       | Auto-generated if omitted                        |
| `revision`     | string (1-10)     | No       | Defaults to `"-"`                                |
| `description`  | string (max 5000) | No       |                                                  |
| `partType`     | enum              | No       | `Manufacture`, `Purchase`, `Software`, `Phantom` |
| `material`     | string (max 100)  | No       |                                                  |
| `weight`       | string            | No       |                                                  |
| `weightUnit`   | string (max 10)   | No       |                                                  |
| `cost`         | string            | No       |                                                  |
| `costCurrency` | string (3 chars)  | No       | ISO 4217 code                                    |
| `leadTimeDays` | integer (min 0)   | No       |                                                  |
| `attributes`   | object            | No       | String key-value pairs                           |

**BOM relationship fields:**

| Field                 | Type           | Required | Notes                        |
| --------------------- | -------------- | -------- | ---------------------------- |
| `parentItemNumber`    | string         | Yes      | Must exist in file or design |
| `childItemNumber`     | string         | Yes      | Must exist in file or design |
| `quantity`            | number (min 0) | No       | Defaults to 1                |
| `findNumber`          | integer        | No       |                              |
| `referenceDesignator` | string         | No       |                              |

**Response (201/207/400):**

```json
{
  "data": {
    "result": {
      "totalRows": 3,
      "successCount": 3,
      "errorCount": 0,
      "createdItems": [
        { "rowNumber": 2, "itemId": "uuid", "itemNumber": "PN-001" }
      ],
      "failedRows": [],
      "relationshipsCreated": 2,
      "relationshipsFailed": 0,
      "failedRelationships": []
    }
  }
}
```

### POST /api/import/documents

Creates documents in bulk. Same structure as parts import but without BOM support.

**Request body:**

```json
{
  "designId": "uuid",
  "branchId": "uuid (optional)",
  "bypassBranchProtection": false,
  "rows": [
    {
      "name": "Assembly Instructions",
      "itemNumber": "DOC-001",
      "description": "Step-by-step assembly instructions",
      "docType": "Procedure",
      "fileName": "assembly-instructions.pdf",
      "mimeType": "application/pdf",
      "revision": "-"
    }
  ]
}
```

**Document row fields:**

| Field         | Type              | Required | Notes                                                                |
| ------------- | ----------------- | -------- | -------------------------------------------------------------------- |
| `name`        | string (1-500)    | Yes      |                                                                      |
| `itemNumber`  | string (max 100)  | No       | Auto-generated if omitted                                            |
| `revision`    | string (1-10)     | No       | Defaults to `"-"`                                                    |
| `description` | string (max 5000) | No       |                                                                      |
| `docType`     | enum              | No       | `Specification`, `Drawing`, `Procedure`, `Manual`, `Report`, `Other` |
| `fileName`    | string (max 500)  | No       | Reference only; does not upload the file                             |
| `mimeType`    | string (max 100)  | No       |                                                                      |
| `attributes`  | object            | No       | String key-value pairs                                               |

This endpoint requires design access (`requireDesignAccess`) and branch access (`requireBranchAccess`) if a branch is specified. Bypassing branch protection requires the Administrator role.

### POST /api/import/issues

Creates issues in bulk. Issues use a free lifecycle and do not require a design or branch context.

**Request body:**

```json
{
  "programId": "uuid (optional)",
  "rows": [
    {
      "name": "Widget fails under load",
      "description": "The widget component fails when stress tested at 150% capacity",
      "severity": "High",
      "priority": "High",
      "category": "Quality",
      "reportedDate": "2024-01-15",
      "resolution": "Reinforced mounting brackets",
      "rootCause": "Insufficient material thickness"
    }
  ]
}
```

**Issue row fields:**

| Field          | Type               | Required | Notes                                                               |
| -------------- | ------------------ | -------- | ------------------------------------------------------------------- |
| `name`         | string (1-500)     | Yes      |                                                                     |
| `itemNumber`   | string (max 100)   | No       | Auto-generated if omitted                                           |
| `description`  | string (max 10000) | No       |                                                                     |
| `severity`     | enum               | No       | `Critical`, `High`, `Medium`, `Low`                                 |
| `priority`     | enum               | No       | `Critical`, `High`, `Medium`, `Low`                                 |
| `category`     | enum               | No       | `Design`, `Manufacturing`, `Quality`, `Customer`, `Safety`, `Other` |
| `reportedDate` | string             | No       | ISO date format (e.g., `2024-01-15`)                                |
| `resolution`   | string (max 10000) | No       |                                                                     |
| `rootCause`    | string (max 10000) | No       |                                                                     |
| `attributes`   | object             | No       | String key-value pairs                                              |

Issues are always created with state `Open` and revision `"-"`. They bypass branch protection automatically.

### Template Download Endpoints

CSV templates with headers and example rows can be downloaded:

| Endpoint                              | File                            |
| ------------------------------------- | ------------------------------- |
| `GET /api/import/templates/parts`     | `parts-import-template.csv`     |
| `GET /api/import/templates/documents` | `documents-import-template.csv` |
| `GET /api/import/templates/issues`    | `issues-import-template.csv`    |

Templates include all field labels as headers and one example row.

---

## BOM Export

Cascadia also supports exporting BOM structures and affected item lists to CSV via client-side functions in `src/components/bom/exportBomTree.ts`.

### BOM Tree Export

Exports a hierarchical BOM tree to a flat CSV with level indicators:

| Column        | Description                        |
| ------------- | ---------------------------------- |
| Level         | Hierarchy depth (0 = top)          |
| Item Number   | Part number                        |
| Name          | Part name                          |
| Revision      | Current revision letter            |
| State         | Lifecycle state                    |
| Type          | Item type                          |
| Quantity      | Quantity per parent                |
| Find Number   | Drawing position reference         |
| Design        | Design code                        |
| External      | "Yes" if from another design       |
| In ECO        | (optional) "Yes" if part of an ECO |
| Change Action | (optional) The ECO change action   |

### Affected Items Export

Exports the flat list of items affected by an ECO, with current and target revision/state columns.

---

## Import Wizard UI

The import wizard (`ImportDialog` component) guides users through a five-step process:

1. **Select Design** (or Select Program for Issues) -- Choose the target program, design, and branch.
2. **Upload File** -- Drag-and-drop or browse for .xlsx/.csv files. Shows a preview of the first 3 rows.
3. **Map Columns** -- Review auto-detected mappings. Manually adjust via dropdowns. See which columns will become custom attributes.
4. **Review** -- Validation summary with error/warning counts, row-level detail table, BOM structure detection info, and filter controls.
5. **Import** -- Progress indicator during creation. Final summary of successes and failures.

The wizard is embedded in an `ImportButton` component that can be placed on any page and pre-populated with program, design, and branch context.

### Usage

```tsx
import { ImportButton } from '@/components/import'

// Import parts into a specific design
<ImportButton
  itemType="Part"
  designId="some-design-id"
  programId="some-program-id"
  onImportComplete={() => refetchParts()}
/>

// Import issues (no design context needed)
<ImportButton
  itemType="Issue"
  onImportComplete={() => refetchIssues()}
/>
```

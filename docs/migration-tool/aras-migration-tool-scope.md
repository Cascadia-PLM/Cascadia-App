# Aras Migration Tool - Scope Document

## Overview

This tool migrates Aras Innovator Level 1 customizations to Cascadia PLM. It extracts database-level configuration from Aras and generates both TypeScript code and runtime configuration for a greenfield Cascadia implementation.

**Scope**: Level 1 customizations only (ItemTypes, properties, forms, permissions, relationships, lifecycles)
**Out of Scope**: Level 2 (methods/events), Level 3 (codetree changes)

---

## Aras → Cascadia Concept Mapping

### 1. ItemType → ItemTypeConfig

| Aras Concept    | Storage in Aras            | Cascadia Equivalent               | Output Location                                 |
| --------------- | -------------------------- | --------------------------------- | ----------------------------------------------- |
| ItemType name   | `innovator.ItemType` table | `ItemTypeConfig.name`             | Code: `src/lib/items/types/{name}.ts`           |
| Label           | ItemType property          | `ItemTypeConfig.label`            | Runtime: `item_type_configs.config.label`       |
| Plural label    | ItemType property          | `ItemTypeConfig.pluralLabel`      | Runtime: `item_type_configs.config.pluralLabel` |
| Icon            | ItemType property          | `ItemTypeConfig.icon`             | Runtime: `item_type_configs.config.icon`        |
| Core properties | ItemType metadata          | TypeScript interface + Zod schema | Code: Interface & schema in type file           |
| Tab name        | ItemType `tab_name`        | Used in UI organization           | Runtime: `config.fieldMetadata`                 |

**Mapping Logic:**

- ItemType becomes both a TypeScript file and a runtime config entry
- Core properties (name, label, etc.) split between code and runtime
- TypeScript provides type safety, runtime config allows no-deploy changes

### 2. Properties → Schema Fields

| Aras Concept  | Storage in Aras            | Cascadia Equivalent               | Output Location                                     |
| ------------- | -------------------------- | --------------------------------- | --------------------------------------------------- |
| Property name | `innovator.Property` table | TypeScript interface field        | Code: Interface in type file                        |
| Data type     | Property `data_type`       | Zod validator type                | Code: Zod schema definition                         |
| Required      | Property `is_required`     | Zod `.min()` or not `.optional()` | Code: Schema constraint                             |
| Default value | Property `default_value`   | Zod `.default()`                  | Code: Schema default                                |
| Max length    | Property `stored_length`   | Zod `.max()`                      | Code: Schema constraint                             |
| Label         | Property `label`           | Form field label                  | Runtime: `config.fieldMetadata.{field}.label`       |
| Tooltip/help  | Property `help_text`       | Form field description            | Runtime: `config.fieldMetadata.{field}.description` |
| Hidden        | Property `is_hidden`       | Field visibility                  | Runtime: `config.fieldMetadata.{field}.hidden`      |
| Pattern/regex | Property `pattern`         | Zod `.regex()`                    | Code: Schema validation                             |

**Data Type Mapping:**

```typescript
// Aras → Zod type mapping
'string'      → z.string()
'text'        → z.string()  // with .max(5000) or similar
'integer'     → z.number().int()
'decimal'     → z.number()
'float'       → z.number()
'date'        → z.date()
'boolean'     → z.boolean()
'item'        → z.string().uuid()  // foreign key reference
'list'        → z.enum([...])      // if has value list
'sequence'    → z.string()         // auto-generated, similar to itemNumber
'federated'   → z.string()         // external reference
'color'       → z.string().regex(/^#[0-9A-F]{6}$/i)
'image'       → z.string()         // file reference
'md5'         → z.string().length(32)
```

**Field Location Decision:**

- Structural fields (ID, itemNumber, state) → Code (BaseItem interface)
- Business fields (description, cost, material) → Code (type-specific interface)
- Field metadata (labels, help text, visibility) → Runtime config

### 3. Forms → React Components

| Aras Concept      | Storage in Aras          | Cascadia Equivalent    | Output Location                            |
| ----------------- | ------------------------ | ---------------------- | ------------------------------------------ |
| Form definition   | `innovator.Form` table   | React Form component   | Code: `src/lib/items/forms/{Name}Form.tsx` |
| Field layout      | Form relationships       | TanStack Form fields   | Code: Component JSX                        |
| Field groups/tabs | Form metadata            | Fieldset/Card sections | Code: Component structure                  |
| Field order       | Form field `sort_order`  | JSX field ordering     | Code: Component field order                |
| Field visibility  | Form field `is_visible`  | Conditional rendering  | Runtime: `fieldMetadata.{field}.hidden`    |
| Read-only fields  | Form field `is_readonly` | `disabled` prop        | Runtime: `fieldMetadata.{field}.readonly`  |

**Form Generation Strategy:**

1. **Initial Generation**: Create basic form component with all fields
2. **Template-Based**: Use existing forms (PartForm, DocumentForm) as templates
3. **Field Metadata**: Store advanced layout in runtime config
4. **Manual Refinement**: Generated forms are starting point, developers refine

**Generated Form Structure:**

```tsx
// Auto-generated from Aras Form
export function {ItemType}Form({ item, onSubmit, onCancel }: ItemFormProps<{ItemType}>) {
  const form = useForm({
    defaultValues: item || defaultValues,
    validators: { onSubmit: zodValidator({itemType}Schema) }
  })

  return (
    <form>
      {/* Fields grouped by Aras tab_name */}
      <Card>
        <CardHeader>General</CardHeader>
        <CardContent>
          {/* Fields from Aras form layout */}
        </CardContent>
      </Card>
    </form>
  )
}
```

### 4. Permissions → RBAC Config

| Aras Concept         | Storage in Aras              | Cascadia Equivalent                     | Output Location                      |
| -------------------- | ---------------------------- | --------------------------------------- | ------------------------------------ |
| Identity permissions | `innovator.Permission` table | `permissions.create/read/update/delete` | Runtime: `config.permissions`        |
| Access rules         | Permission `related_id`      | Role name strings                       | Runtime: Permission arrays           |
| Can Add              | ItemType `can_add`           | `permissions.create`                    | Runtime: `config.permissions.create` |
| Permission by state  | Permission lifecycle filter  | Lifecycle transition guards             | Code: Lifecycle definition           |

**Permission Mapping:**

- Aras Identities (groups/roles) → Cascadia role names (strings)
- Per-ItemType CRUD permissions → `permissions.{action}` arrays
- State-based permissions → Encoded in lifecycle transitions

**Example Runtime Config:**

```json
{
  "permissions": {
    "create": ["Engineer", "Admin"],
    "read": ["*"],
    "update": ["Engineer", "Admin"],
    "delete": ["Admin"]
  }
}
```

### 5. Relationships → RelationshipConfig

| Aras Concept      | Storage in Aras                    | Cascadia Equivalent           | Output Location                       |
| ----------------- | ---------------------------------- | ----------------------------- | ------------------------------------- |
| RelationshipType  | `innovator.RelationshipType` table | `RelationshipConfig`          | Runtime: `config.relationships[]`     |
| Relationship name | RelationshipType `name`            | `relationship.type`           | Runtime: `relationship.type`          |
| Source ItemType   | RelationshipType `relationship_id` | Defined on source type config | Runtime: On source type's config      |
| Related ItemType  | RelationshipType `related_id`      | `relationship.targetTypes`    | Runtime: `relationship.targetTypes[]` |
| Label             | RelationshipType `label`           | `relationship.label`          | Runtime: `relationship.label`         |
| Cardinality       | RelationshipType metadata          | `relationship.allowMultiple`  | Runtime: `relationship.allowMultiple` |

**Relationship Structure in Cascadia:**

```typescript
// Example: Part BOM relationship
{
  type: 'BOM',
  label: 'Bill of Materials',
  targetTypes: ['Part'],
  allowMultiple: true
}
```

**Migration Strategy:**

- Extract all RelationshipTypes from Aras
- Map to source ItemType's `relationships` array
- Store in runtime config (allows business users to modify)

### 6. Lifecycles → Workflow Definitions

| Aras Concept     | Storage in Aras                  | Cascadia Equivalent                  | Output Location                        |
| ---------------- | -------------------------------- | ------------------------------------ | -------------------------------------- |
| Life Cycle Map   | `innovator.Life_Cycle_Map` table | Workflow Definition (lifecycle type) | Database: `workflow_definitions` table |
| State            | Life Cycle State                 | Workflow state                       | `workflow_definitions.states[]`        |
| State name       | State `name`                     | `state.name`                         | State config                           |
| State label      | State `label`                    | `state.name` (display)               | State config                           |
| State color      | State metadata (custom)          | `state.color`                        | State config                           |
| Transition       | Life Cycle Transition            | Workflow transition                  | `workflow_definitions.transitions[]`   |
| Transition label | Transition `name`                | `transition.name`                    | Transition config                      |
| Transition roles | Transition permissions           | `transition.roles`                   | Transition config                      |

**Lifecycle Migration:**

1. Extract Life Cycle Map from Aras
2. Convert to Cascadia `WorkflowDefinition` with `definitionType: 'lifecycle'`
3. Map states and transitions
4. Insert into `workflow_definitions` table
5. Link to ItemType via `lifecycleDefinitionId` in runtime config

**Example Lifecycle:**

```json
{
  "name": "Part Lifecycle",
  "definitionType": "lifecycle",
  "states": [
    { "id": "Draft", "name": "Draft", "color": "gray" },
    { "id": "InReview", "name": "In Review", "color": "blue" },
    { "id": "Released", "name": "Released", "color": "green" }
  ],
  "transitions": [
    {
      "from": "Draft",
      "to": "InReview",
      "name": "Submit for Review",
      "roles": ["Engineer"]
    }
  ]
}
```

### 7. Views → DataGrid Columns

| Aras Concept    | Storage in Aras        | Cascadia Equivalent            | Output Location         |
| --------------- | ---------------------- | ------------------------------ | ----------------------- |
| View definition | `innovator.View` table | Table component columns        | Code: `{Name}Table.tsx` |
| Column          | View item              | DataGrid column def            | Code: Column definition |
| Column label    | View item `label`      | `columnHelper.accessor` header | Code: Header config     |
| Column width    | View item `width`      | Column `size`                  | Code: Column config     |
| Sort order      | View `default_sort`    | Initial `sorting` state        | Code: Table state       |

**Table Generation:**

- Use DataGrid component (wraps TanStack Table)
- Generate column definitions from Aras View
- Default to showing key fields (itemNumber, name, state, revision)

---

## Migration Tool Architecture

### Input: Aras Export Package

The tool accepts an Aras export package (AML XML files) containing:

- ItemType definitions
- Property definitions
- RelationshipType definitions
- Form definitions
- Permission definitions
- Life Cycle Map definitions
- View definitions

**Expected Structure:**

```
aras-export/
├── ItemType/
│   ├── Part.xml
│   ├── Document.xml
│   └── CustomType.xml
├── Property/
│   ├── Part__description.xml
│   ├── Part__material.xml
│   └── ...
├── RelationshipType/
│   ├── Part_BOM.xml
│   └── ...
├── Form/
│   ├── Part_Form.xml
│   └── ...
├── Life_Cycle_Map/
│   ├── Part_Lifecycle.xml
│   └── ...
└── View/
    ├── Part_Grid.xml
    └── ...
```

### Processing Pipeline

```
┌─────────────────┐
│  Aras AML XML   │
│  Export Package │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  1. Parse AML   │  Extract ItemTypes, Properties, Forms, etc.
│     Parser      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  2. Analyze &   │  Build dependency graph, validate references
│     Validate    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  3. Map to      │  Apply Aras → Cascadia mapping rules
│     Cascadia    │
└────────┬────────┘
         │
         ├──────────────┬────────────────┬──────────────┐
         ▼              ▼                ▼              ▼
  ┌──────────┐   ┌──────────┐    ┌──────────┐   ┌──────────┐
  │   Code   │   │ Runtime  │    │ Database │   │ Migration│
  │Generator │   │  Config  │    │  Seeds   │   │  Report  │
  └──────────┘   └──────────┘    └──────────┘   └──────────┘
         │              │                │              │
         ▼              ▼                ▼              ▼
  TypeScript files  JSON configs   SQL inserts    Markdown doc
```

### Output Artifacts

#### 1. Code Generation (`src/lib/items/types/`)

- **ItemType TypeScript files**: Interface, Zod schema, constants
- **Form components**: React components using TanStack Form
- **Table components**: DataGrid-based list views
- **Detail components**: Read-only detail views
- **Registry registration**: Code to register new types

**Example Output:**

```
src/lib/items/types/
├── custom-part.ts          # Generated
├── custom-part-form.tsx    # Generated
├── custom-part-table.tsx   # Generated
└── custom-part-detail.tsx  # Generated
```

#### 2. Runtime Configuration (`migration-output/runtime-configs/`)

- **JSON files per ItemType**: Labels, permissions, relationships, field metadata
- **Import script**: SQL or TypeScript to load into `item_type_configs` table

**Example Output:**

```json
// CustomPart.runtime.json
{
  "itemType": "CustomPart",
  "label": "Custom Part",
  "pluralLabel": "Custom Parts",
  "icon": "Box",
  "permissions": {
    "create": ["Engineer", "Admin"],
    "read": ["*"],
    "update": ["Engineer", "Admin"],
    "delete": ["Admin"]
  },
  "relationships": [
    {
      "type": "BOM",
      "label": "Bill of Materials",
      "targetTypes": ["CustomPart"],
      "allowMultiple": true
    }
  ],
  "fieldMetadata": {
    "material": {
      "label": "Material Type",
      "description": "Primary material used in manufacturing",
      "tab": "Engineering"
    }
  }
}
```

#### 3. Database Migrations

- **Schema changes**: Drizzle migration for new type-specific tables
- **Lifecycle seeds**: SQL to insert lifecycle definitions
- **Runtime config seeds**: SQL to insert `item_type_configs` records

**Example Output:**

```sql
-- migration-output/schema/custom_parts.sql
CREATE TABLE custom_parts (
  id UUID PRIMARY KEY REFERENCES items(id),
  description TEXT,
  material VARCHAR(100),
  weight NUMERIC,
  ...
);
```

#### 4. Migration Report (`migration-output/report.md`)

- Summary of migrated ItemTypes
- List of unmapped Aras features (warnings)
- Manual steps required
- Validation checklist

### Tool Implementation Structure

```
src/migration/
├── cli.ts                    # CLI entry point
├── parser/
│   ├── aml-parser.ts         # Parse AML XML
│   ├── itemtype-parser.ts    # Extract ItemType data
│   ├── property-parser.ts    # Extract Property data
│   ├── form-parser.ts        # Extract Form data
│   ├── lifecycle-parser.ts   # Extract Life Cycle Map
│   └── types.ts              # Parsed data types
├── analyzer/
│   ├── dependency-analyzer.ts # Build dependency graph
│   ├── validator.ts           # Validate parsed data
│   └── conflict-detector.ts   # Check for naming conflicts
├── mapper/
│   ├── itemtype-mapper.ts     # ItemType → ItemTypeConfig
│   ├── property-mapper.ts     # Property → Schema
│   ├── permission-mapper.ts   # Permissions → RBAC
│   ├── lifecycle-mapper.ts    # Lifecycle → WorkflowDefinition
│   └── types.ts               # Mapped data types
├── generator/
│   ├── code-generator.ts      # Orchestrates code generation
│   ├── type-generator.ts      # Generate TypeScript types
│   ├── form-generator.ts      # Generate form components
│   ├── table-generator.ts     # Generate table components
│   ├── detail-generator.ts    # Generate detail components
│   ├── runtime-config-generator.ts # Generate JSON configs
│   ├── migration-generator.ts # Generate Drizzle migrations
│   └── templates/             # Code templates
│       ├── type.ts.hbs
│       ├── form.tsx.hbs
│       ├── table.tsx.hbs
│       └── detail.tsx.hbs
└── reporter/
    ├── migration-reporter.ts  # Generate report
    └── templates/
        └── report.md.hbs
```

---

## CLI Interface

```bash
# Basic usage
npm run migrate:aras -- --input ./aras-export --output ./migration-output

# With options
npm run migrate:aras -- \
  --input ./aras-export \
  --output ./migration-output \
  --itemtypes "Part,Document,CustomType" \  # Filter specific types
  --skip-forms \                             # Skip form generation
  --dry-run                                  # Preview without writing

# Validate only
npm run migrate:aras -- --input ./aras-export --validate-only

# Generate report only
npm run migrate:aras -- --input ./aras-export --report-only
```

**CLI Options:**

- `--input <path>`: Path to Aras export directory (required)
- `--output <path>`: Output directory (default: `./migration-output`)
- `--itemtypes <list>`: Comma-separated list of ItemTypes to migrate (default: all)
- `--skip-forms`: Skip form component generation
- `--skip-tables`: Skip table component generation
- `--skip-migrations`: Skip database migration generation
- `--dry-run`: Preview changes without writing files
- `--validate-only`: Validate input without generating output
- `--report-only`: Generate migration report only
- `--overwrite`: Overwrite existing files (default: error if exists)
- `--format`: Auto-format generated code with Prettier

---

## Migration Workflow

### Phase 1: Preparation

1. Export Aras customizations to AML package
2. Review export for completeness
3. Backup Aras database (if needed for reference)

### Phase 2: Analysis

1. Run validation: `npm run migrate:aras -- --input ./export --validate-only`
2. Review validation report
3. Resolve any errors in Aras export

### Phase 3: Generation

1. Run migration: `npm run migrate:aras -- --input ./export --output ./migration`
2. Review generated code
3. Review migration report for warnings

### Phase 4: Integration

1. Copy generated files to Cascadia project:
   - Types → `src/lib/items/types/`
   - Forms → `src/lib/items/forms/`
   - Tables → `src/lib/items/tables/`
2. Run database migrations: `npm run db:generate && npm run db:migrate`
3. Import runtime configs: `npm run migrate:import-configs`
4. Register new types in `src/lib/items/index.ts`

### Phase 5: Validation

1. Start dev server: `npm run dev`
2. Test ItemType CRUD operations
3. Verify forms render correctly
4. Test permissions
5. Test lifecycle transitions

### Phase 6: Refinement

1. Customize generated forms (layout, validation, UX)
2. Add business logic to services
3. Customize table columns and filters
4. Add relationships and workflows

---

## Known Limitations & Manual Steps

### Limitations (Out of Scope for Initial Version)

1. **Methods/Events (Level 2)**: Not migrated
   - Aras server-side methods → Manual TypeScript implementation
   - Event handlers (onBeforeAdd, etc.) → Manual service layer code

2. **Codetree Changes (Level 3)**: Not migrated
   - Custom UI modifications → Manual React component development

3. **Complex Validations**: Partially migrated
   - Simple validations (required, max length) → Zod schema
   - Complex business rules → Manual Zod refinements

4. **Polyitem/Polymorphism**: Not supported
   - Aras polyitem relationships → Manual design decision

5. **Federated ItemTypes**: Not supported
   - External system integrations → Manual API integration

6. **Workflow Variables**: Not migrated
   - Workflow context variables → Manual workflow service implementation

### Manual Steps After Migration

1. **Implement Business Logic**
   - Create service methods for complex operations
   - Add custom validation rules
   - Implement computed fields

2. **Refine Forms**
   - Adjust field layout and grouping
   - Add conditional field visibility
   - Implement cascading dropdowns
   - Add custom form validation messages

3. **Customize Tables**
   - Add custom column renderers
   - Implement advanced filters
   - Add bulk actions

4. **Implement Relationships**
   - Build relationship UI (BOM editor, etc.)
   - Add relationship validation
   - Implement relationship constraints

5. **Configure Workflows**
   - Add workflow transition logic (approval routing, etc.)
   - Implement workflow actions
   - Add workflow notifications

6. **Set Up Permissions**
   - Review and refine generated RBAC rules
   - Add state-based permissions via lifecycle
   - Implement field-level security (if needed)

---

## Success Criteria

A migration is successful when:

1. **All Level 1 customizations are captured**:
   - ✅ All custom ItemTypes created
   - ✅ All properties migrated with correct types
   - ✅ All relationships defined
   - ✅ All lifecycles configured
   - ✅ Basic permissions set

2. **Generated code compiles**:
   - ✅ TypeScript compilation succeeds
   - ✅ No Zod schema errors
   - ✅ Forms render without errors

3. **Database migrations apply**:
   - ✅ Schema migrations run successfully
   - ✅ Runtime configs load into database

4. **Basic CRUD operations work**:
   - ✅ Can create items of each migrated type
   - ✅ Can read/update items
   - ✅ Can delete items (with proper permissions)
   - ✅ Lifecycle transitions work

5. **Migration report provides clear guidance**:
   - ✅ Summary of what was migrated
   - ✅ List of manual steps required
   - ✅ Warnings for unsupported features

---

## Future Enhancements (Post-Initial Scope)

### Phase 2: Method Migration (Level 2)

- Parse Aras server-side methods (JavaScript/C#)
- Generate TypeScript service method stubs
- Convert simple methods automatically (e.g., field calculations)
- Provide migration guide for complex methods

### Phase 3: Advanced Features

- Workflow variable migration
- Form event handler migration (onChange, etc.)
- Custom action migration
- Report definition migration (convert to queries)

### Phase 4: Data Migration

- Migrate actual item data from Aras to Cascadia
- Preserve revision history
- Migrate file vault contents
- Migrate user accounts and permissions

### Phase 5: Incremental Migration

- Support side-by-side Aras/Cascadia operation
- Sync changes between systems during transition
- Gradual cutover by ItemType or department

---

## Appendix: Example Migration

### Input: Aras Part ItemType

```xml
<!-- Simplified AML export -->
<Item type="ItemType" id="4F1AC04A2B484F3ABA4E20DB63808A88">
  <name>Part</name>
  <label>Part</label>
  <class_structure>
    <Item type="Property">
      <name>description</name>
      <data_type>text</data_type>
      <label>Description</label>
      <is_required>0</is_required>
    </Item>
    <Item type="Property">
      <name>material</name>
      <data_type>string</data_type>
      <label>Material</label>
      <stored_length>100</stored_length>
    </Item>
  </class_structure>
  <Relationships>
    <Item type="RelationshipType">
      <name>Part BOM</name>
      <relationship_id type="ItemType">4F1AC04A2B484F3ABA4E20DB63808A88</relationship_id>
      <related_id type="ItemType">4F1AC04A2B484F3ABA4E20DB63808A88</related_id>
    </Item>
  </Relationships>
</Item>
```

### Output: Cascadia Part Type

**`src/lib/items/types/part.ts`:**

```typescript
import { z } from 'zod'
import { baseItemSchema } from './base'

export interface Part extends BaseItem {
  itemType: 'Part'
  description?: string
  material?: string
}

export const partSchema = baseItemSchema.extend({
  itemType: z.literal('Part'),
  description: z.string().max(5000).optional(),
  material: z.string().max(100).optional(),
})

export type PartInput = z.infer<typeof partSchema>
```

**`migration-output/runtime-configs/Part.json`:**

```json
{
  "itemType": "Part",
  "label": "Part",
  "pluralLabel": "Parts",
  "icon": "Box",
  "permissions": {
    "create": ["Engineer"],
    "read": ["*"],
    "update": ["Engineer"],
    "delete": ["Admin"]
  },
  "relationships": [
    {
      "type": "BOM",
      "label": "Part BOM",
      "targetTypes": ["Part"],
      "allowMultiple": true
    }
  ],
  "fieldMetadata": {
    "description": {
      "label": "Description",
      "tab": "General"
    },
    "material": {
      "label": "Material",
      "tab": "General"
    }
  }
}
```

---

## Summary

This migration tool provides a **structured, automated pathway** from Aras Innovator to Cascadia PLM for Level 1 customizations. It:

1. **Parses** Aras AML exports
2. **Maps** Aras concepts to Cascadia equivalents
3. **Generates** TypeScript code, React components, and database migrations
4. **Produces** runtime configuration for business rules
5. **Reports** on migration status and required manual steps

The tool creates a **greenfield Cascadia implementation** that preserves Aras business logic while embracing Cascadia's code-first, type-safe architecture. Generated code serves as a **foundation for refinement**, not a final product, empowering developers to enhance and customize as needed.

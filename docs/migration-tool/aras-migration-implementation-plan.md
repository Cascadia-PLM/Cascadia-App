# Aras Migration Tool - Implementation Plan

## Overview

This document outlines the step-by-step implementation plan for building the Aras migration tool. It includes task breakdown, development phases, and technical specifications.

---

## Development Phases

### Phase 1: Foundation (Week 1)

**Goal**: Set up project structure and core parsing infrastructure

#### Tasks:

1. **Project Setup**
   - [ ] Create `src/migration/` directory structure
   - [ ] Install dependencies (`xml2js`, `handlebars`, `commander`)
   - [ ] Set up TypeScript configuration for migration tool
   - [ ] Create CLI entry point

2. **AML Parser Implementation**
   - [ ] Implement XML to JSON parser for AML files
   - [ ] Create type definitions for parsed AML structures
   - [ ] Write unit tests for parser
   - [ ] Add validation for AML schema compliance

3. **ItemType Parser**
   - [ ] Extract ItemType metadata (name, label, icon)
   - [ ] Parse ItemType class_structure (properties)
   - [ ] Extract relationships
   - [ ] Write unit tests with sample AML

4. **Property Parser**
   - [ ] Parse property definitions
   - [ ] Map Aras data types to internal representation
   - [ ] Extract constraints (required, length, pattern)
   - [ ] Handle property metadata (label, help text)

**Deliverables:**

- Working AML parser
- Parsed data structures for ItemTypes and Properties
- Unit test coverage >80%

---

### Phase 2: Mapping & Validation (Week 2)

**Goal**: Implement mapping logic from Aras to Cascadia structures

#### Tasks:

1. **ItemType Mapper**
   - [ ] Map ItemType to ItemTypeConfig structure
   - [ ] Split fields between code and runtime config
   - [ ] Handle naming conflicts (kebab-case conversion)
   - [ ] Generate unique identifiers

2. **Property Mapper**
   - [ ] Map Aras data types to Zod schemas
   - [ ] Map constraints to Zod validators
   - [ ] Generate TypeScript interface fields
   - [ ] Handle field metadata for runtime config

3. **Permission Mapper**
   - [ ] Extract Aras Permission records
   - [ ] Map to RBAC permission structure
   - [ ] Handle Can Add permissions
   - [ ] Map Identities to role names

4. **Lifecycle Mapper**
   - [ ] Parse Life Cycle Map definitions
   - [ ] Map to WorkflowDefinition structure
   - [ ] Extract states and transitions
   - [ ] Handle transition permissions

5. **Dependency Analyzer**
   - [ ] Build dependency graph of ItemTypes
   - [ ] Detect circular dependencies
   - [ ] Validate relationship references
   - [ ] Check lifecycle references

6. **Validator**
   - [ ] Validate parsed data completeness
   - [ ] Check for required fields
   - [ ] Validate data type mappings
   - [ ] Generate validation report

**Deliverables:**

- Complete mapping from Aras structures to Cascadia structures
- Dependency analysis and validation
- Error reporting for invalid configurations

---

### Phase 3: Code Generation (Week 3)

**Goal**: Generate TypeScript code and React components

#### Tasks:

1. **Template Setup**
   - [ ] Create Handlebars templates for all generators
   - [ ] Define template helper functions
   - [ ] Test templates with sample data

2. **Type Generator**
   - [ ] Generate TypeScript interface
   - [ ] Generate Zod schema
   - [ ] Add imports and exports
   - [ ] Format output with Prettier

3. **Form Generator**
   - [ ] Generate TanStack Form component
   - [ ] Map Aras Form layout to JSX
   - [ ] Group fields by tab/section
   - [ ] Add validation integration

4. **Table Generator**
   - [ ] Generate DataGrid component
   - [ ] Map Aras View to column definitions
   - [ ] Add default sorting and filtering
   - [ ] Include row actions (edit, delete)

5. **Detail Generator**
   - [ ] Generate detail view component
   - [ ] Layout fields in read-only cards
   - [ ] Add relationship displays
   - [ ] Include action buttons

6. **Registry Registration**
   - [ ] Generate ItemTypeRegistry.register() calls
   - [ ] Create index file for exports
   - [ ] Handle component imports

**Deliverables:**

- Code generation for all component types
- Handlebars templates for each generator
- Generated code that compiles without errors

---

### Phase 4: Runtime Config & Migrations (Week 4)

**Goal**: Generate runtime configurations and database migrations

#### Tasks:

1. **Runtime Config Generator**
   - [ ] Generate JSON config files
   - [ ] Include labels, permissions, relationships
   - [ ] Add field metadata
   - [ ] Validate JSON structure

2. **Migration Generator**
   - [ ] Generate Drizzle schema for new tables
   - [ ] Create migration SQL files
   - [ ] Add indexes and constraints
   - [ ] Generate seed data for lifecycles

3. **Config Import Script**
   - [ ] Write script to load JSON into database
   - [ ] Insert into `item_type_configs` table
   - [ ] Insert into `workflow_definitions` table
   - [ ] Handle conflicts and updates

4. **File Writer**
   - [ ] Write generated files to disk
   - [ ] Create directory structure
   - [ ] Handle file naming conflicts
   - [ ] Add .gitkeep files for empty directories

**Deliverables:**

- Runtime configuration JSON files
- Database migration scripts
- Import scripts for seeding configurations

---

### Phase 5: Reporting & CLI (Week 5)

**Goal**: Build CLI interface and migration reporting

#### Tasks:

1. **Migration Reporter**
   - [ ] Generate summary of migrated ItemTypes
   - [ ] List warnings for unmapped features
   - [ ] Create manual steps checklist
   - [ ] Format as Markdown

2. **CLI Implementation**
   - [ ] Implement command parsing with Commander
   - [ ] Add options (input, output, filters)
   - [ ] Implement dry-run mode
   - [ ] Add progress indicators

3. **Error Handling**
   - [ ] Catch and format errors
   - [ ] Provide actionable error messages
   - [ ] Log warnings vs errors
   - [ ] Exit with appropriate codes

4. **Documentation**
   - [ ] Write CLI usage guide
   - [ ] Create migration workflow documentation
   - [ ] Add troubleshooting guide
   - [ ] Write examples

**Deliverables:**

- Complete CLI tool
- Migration report generator
- User documentation

---

### Phase 6: Testing & Refinement (Week 6)

**Goal**: Test with real Aras exports and refine

#### Tasks:

1. **Integration Testing**
   - [ ] Test with sample Aras export
   - [ ] Validate generated code compiles
   - [ ] Test runtime configs load correctly
   - [ ] Verify migrations apply successfully

2. **End-to-End Testing**
   - [ ] Run full migration pipeline
   - [ ] Import into Cascadia instance
   - [ ] Test CRUD operations on migrated types
   - [ ] Verify lifecycle transitions work

3. **Refinement**
   - [ ] Fix bugs found in testing
   - [ ] Improve error messages
   - [ ] Optimize performance
   - [ ] Polish generated code formatting

4. **Documentation**
   - [ ] Update scope document with findings
   - [ ] Document limitations and workarounds
   - [ ] Create example migrations
   - [ ] Write best practices guide

**Deliverables:**

- Tested and validated migration tool
- Complete documentation
- Example migrations

---

## File Structure

```
src/migration/
├── cli.ts                           # CLI entry point
├── index.ts                         # Main orchestrator
├── types.ts                         # Shared types
├── config.ts                        # Configuration defaults
│
├── parser/                          # AML parsing
│   ├── index.ts
│   ├── aml-parser.ts                # Core XML → JSON parser
│   ├── itemtype-parser.ts           # ItemType extraction
│   ├── property-parser.ts           # Property extraction
│   ├── relationship-parser.ts       # RelationshipType extraction
│   ├── form-parser.ts               # Form extraction
│   ├── lifecycle-parser.ts          # Life Cycle Map extraction
│   ├── permission-parser.ts         # Permission extraction
│   ├── view-parser.ts               # View extraction
│   └── types.ts                     # Parsed data types
│
├── analyzer/                        # Analysis & validation
│   ├── index.ts
│   ├── dependency-analyzer.ts       # Build dependency graph
│   ├── validator.ts                 # Validate parsed data
│   ├── conflict-detector.ts         # Detect naming conflicts
│   └── types.ts                     # Analysis result types
│
├── mapper/                          # Aras → Cascadia mapping
│   ├── index.ts
│   ├── itemtype-mapper.ts           # ItemType → ItemTypeConfig
│   ├── property-mapper.ts           # Property → Schema + Interface
│   ├── permission-mapper.ts         # Permission → RBAC
│   ├── relationship-mapper.ts       # RelationshipType → RelationshipConfig
│   ├── lifecycle-mapper.ts          # Life Cycle Map → WorkflowDefinition
│   ├── form-mapper.ts               # Form → Component layout
│   ├── view-mapper.ts               # View → Table columns
│   ├── data-type-mapper.ts          # Aras types → Zod types
│   └── types.ts                     # Mapped data types
│
├── generator/                       # Code generation
│   ├── index.ts
│   ├── code-generator.ts            # Main code generator orchestrator
│   ├── type-generator.ts            # Generate TypeScript types
│   ├── form-generator.ts            # Generate form components
│   ├── table-generator.ts           # Generate table components
│   ├── detail-generator.ts          # Generate detail components
│   ├── registry-generator.ts        # Generate registry code
│   ├── runtime-config-generator.ts  # Generate JSON configs
│   ├── migration-generator.ts       # Generate DB migrations
│   ├── utils/
│   │   ├── formatting.ts            # Code formatting utilities
│   │   ├── naming.ts                # Naming conventions
│   │   └── imports.ts               # Import statement generation
│   └── templates/                   # Handlebars templates
│       ├── type.ts.hbs              # TypeScript interface + schema
│       ├── form.tsx.hbs             # Form component
│       ├── table.tsx.hbs            # Table component
│       ├── detail.tsx.hbs           # Detail component
│       ├── registry.ts.hbs          # Registry registration
│       ├── migration.sql.hbs        # DB migration
│       └── helpers.ts               # Template helpers
│
├── writer/                          # File I/O
│   ├── index.ts
│   ├── file-writer.ts               # Write files to disk
│   ├── directory-manager.ts         # Create directory structure
│   └── types.ts
│
├── reporter/                        # Reporting
│   ├── index.ts
│   ├── migration-reporter.ts        # Generate migration report
│   ├── summary-reporter.ts          # Generate summary stats
│   └── templates/
│       └── report.md.hbs            # Report template
│
└── __tests__/                       # Tests
    ├── fixtures/                    # Sample AML files
    │   ├── Part.xml
    │   ├── Document.xml
    │   └── CustomType.xml
    ├── parser/
    │   ├── aml-parser.test.ts
    │   ├── itemtype-parser.test.ts
    │   └── property-parser.test.ts
    ├── mapper/
    │   ├── itemtype-mapper.test.ts
    │   └── property-mapper.test.ts
    ├── generator/
    │   ├── type-generator.test.ts
    │   └── form-generator.test.ts
    └── integration/
        └── full-migration.test.ts
```

---

## Dependencies

```json
{
  "dependencies": {
    "commander": "^12.0.0", // CLI framework
    "xml2js": "^0.6.2", // XML parsing
    "handlebars": "^4.7.8", // Template engine
    "chalk": "^5.3.0", // Terminal colors
    "ora": "^8.0.1", // Spinners
    "zod": "^4.0.0" // Already in project
  },
  "devDependencies": {
    "@types/xml2js": "^0.4.14",
    "@types/node": "^20.11.0"
  }
}
```

---

## CLI Specification

### Command Structure

```bash
npm run migrate:aras -- [options]
```

### Options

| Option               | Alias | Type    | Description                          | Default              |
| -------------------- | ----- | ------- | ------------------------------------ | -------------------- |
| `--input <path>`     | `-i`  | string  | Path to Aras export directory        | Required             |
| `--output <path>`    | `-o`  | string  | Output directory                     | `./migration-output` |
| `--itemtypes <list>` | `-t`  | string  | Comma-separated ItemTypes to migrate | All                  |
| `--skip-forms`       |       | boolean | Skip form component generation       | false                |
| `--skip-tables`      |       | boolean | Skip table component generation      | false                |
| `--skip-migrations`  |       | boolean | Skip DB migration generation         | false                |
| `--dry-run`          | `-d`  | boolean | Preview without writing files        | false                |
| `--validate-only`    | `-v`  | boolean | Validate input only                  | false                |
| `--report-only`      | `-r`  | boolean | Generate report only                 | false                |
| `--overwrite`        |       | boolean | Overwrite existing files             | false                |
| `--format`           |       | boolean | Format code with Prettier            | true                 |
| `--verbose`          |       | boolean | Verbose logging                      | false                |
| `--help`             | `-h`  |         | Show help                            |                      |
| `--version`          |       |         | Show version                         |                      |

### Exit Codes

| Code | Meaning          |
| ---- | ---------------- |
| 0    | Success          |
| 1    | Validation error |
| 2    | File I/O error   |
| 3    | Parse error      |
| 4    | Generation error |

---

## Data Type Mapping Table

Complete mapping from Aras data types to Cascadia Zod schemas:

| Aras Type     | Zod Schema                            | Notes                                    |
| ------------- | ------------------------------------- | ---------------------------------------- |
| `string`      | `z.string()`                          | Add `.max()` from `stored_length`        |
| `text`        | `z.string().max(5000)`                | Large text field                         |
| `integer`     | `z.number().int()`                    | Integer numbers                          |
| `decimal`     | `z.number()`                          | Decimal numbers                          |
| `float`       | `z.number()`                          | Floating point                           |
| `date`        | `z.date()`                            | Date/time                                |
| `boolean`     | `z.boolean()`                         | True/false                               |
| `item`        | `z.string().uuid()`                   | Foreign key reference                    |
| `list`        | `z.enum([...])`                       | Extract values from List                 |
| `sequence`    | `z.string()`                          | Auto-generated, similar to itemNumber    |
| `federated`   | `z.string()`                          | External reference (not fully supported) |
| `color`       | `z.string().regex(/^#[0-9A-F]{6}$/i)` | Hex color                                |
| `image`       | `z.string()`                          | File reference                           |
| `md5`         | `z.string().length(32)`               | MD5 hash                                 |
| `mv_list`     | `z.array(z.string())`                 | Multi-value list                         |
| `filter_list` | `z.enum([...])`                       | Filtered list                            |

### Constraint Mapping

| Aras Constraint       | Zod Validator                        |
| --------------------- | ------------------------------------ |
| `is_required="1"`     | No `.optional()`                     |
| `is_required="0"`     | `.optional()`                        |
| `stored_length="100"` | `.max(100)`                          |
| `pattern="regex"`     | `.regex(new RegExp('regex'))`        |
| `prec="2"`            | Custom refinement for precision      |
| `data_source` (List)  | `.enum([...])` with values from List |

---

## Generated Code Examples

### TypeScript Type File

**Input**: Aras Part ItemType with properties: `description`, `material`, `weight`

**Output**: `src/lib/items/types/part.ts`

```typescript
import { z } from 'zod'
import { baseItemSchema, commonStates } from './base'
import type { BaseItem } from './base'

// Part-specific interface
export interface Part extends BaseItem {
  itemType: 'Part'
  designId: string
  description?: string
  material?: string
  weight?: number
}

// Part validation schema
export const partSchema = baseItemSchema.extend({
  itemType: z.literal('Part'),
  designId: z.string().uuid({ message: 'Design is required' }),
  description: z.string().max(5000).optional(),
  material: z.string().max(100).optional(),
  weight: z.number().optional(),
})

// Part-specific states (using common states)
export const partStates = commonStates

// Part relationships
export const partRelationships = [
  {
    type: 'BOM',
    label: 'Bill of Materials',
    targetTypes: ['Part'],
    allowMultiple: true,
  },
]

// Export type for use in other modules
export type PartInput = z.infer<typeof partSchema>
```

### Form Component

**Output**: `src/lib/items/forms/PartForm.tsx`

```tsx
import { useForm, useStore } from '@tanstack/react-form'
import { zodValidator } from '@/lib/form-validation'
import { partSchema, type Part, type PartInput } from '../types/part'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Card, CardContent, CardHeader } from '@/components/ui/Card'
import type { ItemFormProps } from '../types/base'

export function PartForm({ item, onSubmit, onCancel }: ItemFormProps<Part>) {
  const form = useForm({
    defaultValues:
      item ||
      ({
        itemNumber: '',
        revision: 'A',
        itemType: 'Part',
        description: '',
        material: '',
        weight: undefined,
      } as PartInput),
    validators: {
      onSubmit: zodValidator(partSchema),
    },
    onSubmit: async ({ value }) => {
      await onSubmit(value)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <Card>
        <CardHeader>General Information</CardHeader>
        <CardContent>
          <form.Field name="itemNumber">
            {(field) => (
              <Input
                label="Item Number"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                error={field.state.meta.errors?.[0] as string | undefined}
                required
              />
            )}
          </form.Field>

          <form.Field name="revision">
            {(field) => (
              <Input
                label="Revision"
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                error={field.state.meta.errors?.[0] as string | undefined}
                required
              />
            )}
          </form.Field>

          <form.Field name="description">
            {(field) => (
              <Textarea
                label="Description"
                value={field.state.value || ''}
                onChange={(e) => field.handleChange(e.target.value)}
                error={field.state.meta.errors?.[0] as string | undefined}
              />
            )}
          </form.Field>

          <form.Field name="material">
            {(field) => (
              <Input
                label="Material"
                value={field.state.value || ''}
                onChange={(e) => field.handleChange(e.target.value)}
                error={field.state.meta.errors?.[0] as string | undefined}
              />
            )}
          </form.Field>

          <form.Field name="weight">
            {(field) => (
              <Input
                type="number"
                label="Weight (kg)"
                value={field.state.value?.toString() || ''}
                onChange={(e) => field.handleChange(parseFloat(e.target.value))}
                error={field.state.meta.errors?.[0] as string | undefined}
              />
            )}
          </form.Field>
        </CardContent>
      </Card>

      <div className="flex gap-2 mt-4">
        <Button type="submit">Save</Button>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}
```

### Runtime Config JSON

**Output**: `migration-output/runtime-configs/Part.json`

```json
{
  "itemType": "Part",
  "label": "Part",
  "pluralLabel": "Parts",
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
      "targetTypes": ["Part"],
      "allowMultiple": true
    },
    {
      "type": "Document",
      "label": "Documents",
      "targetTypes": ["Document"],
      "allowMultiple": true
    }
  ],
  "fieldMetadata": {
    "description": {
      "label": "Description",
      "description": "Detailed description of the part",
      "tab": "General",
      "order": 1
    },
    "material": {
      "label": "Material",
      "description": "Primary material used in manufacturing",
      "tab": "General",
      "order": 2
    },
    "weight": {
      "label": "Weight",
      "description": "Part weight in kilograms",
      "tab": "General",
      "order": 3
    }
  }
}
```

### Database Migration

**Output**: `migration-output/migrations/0001_add_parts_table.sql`

```sql
-- Migration: Add parts table
-- Generated by Aras migration tool

CREATE TABLE IF NOT EXISTS parts (
  id UUID PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  description TEXT,
  material VARCHAR(100),
  weight NUMERIC,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_parts_material ON parts(material);

COMMENT ON TABLE parts IS 'Part-specific data extending base items table';
COMMENT ON COLUMN parts.description IS 'Detailed description of the part';
COMMENT ON COLUMN parts.material IS 'Primary material used in manufacturing';
COMMENT ON COLUMN parts.weight IS 'Part weight in kilograms';
```

---

## Testing Strategy

### Unit Tests

Test each module in isolation:

```typescript
// Example: property-mapper.test.ts
describe('PropertyMapper', () => {
  it('should map string property to Zod string schema', () => {
    const arasProperty = {
      name: 'description',
      data_type: 'string',
      stored_length: 500,
      is_required: false,
    }

    const result = PropertyMapper.mapProperty(arasProperty)

    expect(result.zodType).toBe('z.string().max(500).optional()')
    expect(result.tsType).toBe('string')
    expect(result.optional).toBe(true)
  })

  it('should map integer property with required constraint', () => {
    const arasProperty = {
      name: 'quantity',
      data_type: 'integer',
      is_required: true,
    }

    const result = PropertyMapper.mapProperty(arasProperty)

    expect(result.zodType).toBe('z.number().int()')
    expect(result.tsType).toBe('number')
    expect(result.optional).toBe(false)
  })
})
```

### Integration Tests

Test full pipeline with sample data:

```typescript
// Example: full-migration.test.ts
describe('Full Migration', () => {
  it('should migrate sample Part ItemType end-to-end', async () => {
    const inputPath = './fixtures/sample-export'
    const outputPath = './test-output'

    const migrator = new ArasMigrator({
      input: inputPath,
      output: outputPath,
    })

    const result = await migrator.migrate()

    expect(result.success).toBe(true)
    expect(result.itemTypesMigrated).toContain('Part')

    // Verify generated files exist
    expect(fs.existsSync(`${outputPath}/types/part.ts`)).toBe(true)
    expect(fs.existsSync(`${outputPath}/forms/PartForm.tsx`)).toBe(true)
    expect(fs.existsSync(`${outputPath}/runtime-configs/Part.json`)).toBe(true)

    // Verify generated code compiles
    const typeFile = fs.readFileSync(`${outputPath}/types/part.ts`, 'utf-8')
    expect(typeFile).toContain('export interface Part')
    expect(typeFile).toContain('export const partSchema')
  })
})
```

### E2E Tests

Test generated code in actual Cascadia instance:

1. Run migration on test Aras export
2. Copy generated files to Cascadia project
3. Run database migrations
4. Import runtime configs
5. Start dev server
6. Test CRUD operations via API
7. Verify UI renders correctly

---

## Performance Considerations

### Optimization Strategies

1. **Parallel Processing**: Parse multiple AML files concurrently
2. **Caching**: Cache parsed data structures to avoid re-parsing
3. **Streaming**: Stream large AML files instead of loading into memory
4. **Incremental Updates**: Support updating existing migrations

### Performance Targets

- Parse 100 ItemTypes in <10 seconds
- Generate code for 100 ItemTypes in <30 seconds
- Total migration time <1 minute for typical Aras instance

---

## Next Steps

1. **Review this plan** with stakeholders
2. **Set up development environment** and dependencies
3. **Start Phase 1**: Build foundation and parsers
4. **Iterate weekly** with demos and feedback
5. **Test with real Aras exports** as early as possible

---

## Success Metrics

- ✅ 100% of Level 1 customizations parsed successfully
- ✅ Generated TypeScript code compiles without errors
- ✅ Generated forms render in Cascadia UI
- ✅ Database migrations apply successfully
- ✅ Runtime configs load into database
- ✅ Migration report provides clear guidance
- ✅ Tool completes migration in <5 minutes for 50 ItemTypes
- ✅ Generated code passes ESLint and type checking
- ✅ Developer can customize generated code without breaking

---

## Risk Mitigation

| Risk                                  | Impact | Likelihood | Mitigation                                                       |
| ------------------------------------- | ------ | ---------- | ---------------------------------------------------------------- |
| Aras AML schema variations            | High   | Medium     | Extensive testing with real exports; schema versioning           |
| Complex property types                | Medium | High       | Comprehensive data type mapping table; manual override option    |
| Performance issues with large exports | Medium | Low        | Parallel processing; streaming parser                            |
| Generated code quality issues         | High   | Medium     | Use templates from existing codebase; manual refinement expected |
| Incomplete Aras exports               | High   | Medium     | Validation step; clear error messages; require complete exports  |

---

## Appendix: Template Samples

### type.ts.hbs

```handlebars
import { z } from 'zod'
import { baseItemSchema, commonStates } from './base'
import type { BaseItem } from './base'

// {{pascalCase name}}-specific interface
export interface {{pascalCase name}} extends BaseItem {
  itemType: '{{pascalCase name}}'
  {{#each properties}}
  {{camelCase name}}{{#if optional}}?{{/if}}: {{tsType}}
  {{/each}}
}

// {{pascalCase name}} validation schema
export const {{camelCase name}}Schema = baseItemSchema.extend({
  itemType: z.literal('{{pascalCase name}}'),
  {{#each properties}}
  {{camelCase name}}: {{zodSchema}},
  {{/each}}
})

// {{pascalCase name}}-specific states
export const {{camelCase name}}States = commonStates

// {{pascalCase name}} relationships
export const {{camelCase name}}Relationships = [
  {{#each relationships}}
  {
    type: '{{type}}',
    label: '{{label}}',
    targetTypes: [{{#each targetTypes}}'{{this}}'{{#unless @last}}, {{/unless}}{{/each}}],
    allowMultiple: {{allowMultiple}},
  },
  {{/each}}
]

// Export type for use in other modules
export type {{pascalCase name}}Input = z.infer<typeof {{camelCase name}}Schema>
```

---

This implementation plan provides a complete roadmap for building the Aras migration tool. Each phase builds on the previous, with clear deliverables and success criteria.

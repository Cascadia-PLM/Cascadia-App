# Aras Migration Tool - Quick Reference

> **TL;DR**: This tool extracts Level 1 customizations from Aras Innovator (ItemTypes, properties, forms, permissions, lifecycles) and generates TypeScript code + runtime config for Cascadia PLM.

---

## What Gets Migrated

| ✅ Migrated (Level 1)           | ❌ Not Migrated (Level 2-3)        |
| ------------------------------- | ---------------------------------- |
| ItemTypes                       | Server-side methods                |
| Properties (fields)             | Event handlers (onBeforeAdd, etc.) |
| Forms (UI layout)               | Custom JavaScript/C# code          |
| Permissions (RBAC)              | Codetree modifications             |
| Relationships                   | Workflow variables                 |
| Lifecycles (states/transitions) | Complex business logic             |
| Views (table columns)           | Custom UI components               |

---

## Quick Start

### 1. Export from Aras

```bash
# In Aras Innovator:
# 1. Navigate to Administration → Packages
# 2. Create new package with all custom ItemTypes
# 3. Export to ./aras-export/
```

### 2. Run Migration

```bash
# Install dependencies (first time only)
npm install

# Run migration
npm run migrate:aras -- --input ./aras-export --output ./migration-output

# Or with filtering
npm run migrate:aras -- -i ./aras-export -o ./output --itemtypes "Part,Document"
```

### 3. Review Output

```bash
# Check migration report
cat ./migration-output/report.md

# Review generated code
ls ./migration-output/types/
ls ./migration-output/forms/
ls ./migration-output/runtime-configs/
```

### 4. Integrate into Cascadia

```bash
# Copy generated files
cp -r ./migration-output/types/* ./src/lib/items/types/
cp -r ./migration-output/forms/* ./src/lib/items/forms/

# Run database migrations
npm run db:generate
npm run db:migrate

# Import runtime configs
npm run migrate:import-configs

# Start dev server
npm run dev
```

---

## CLI Options

```bash
npm run migrate:aras -- [options]

Required:
  -i, --input <path>         Path to Aras export directory

Optional:
  -o, --output <path>        Output directory (default: ./migration-output)
  -t, --itemtypes <list>     Filter ItemTypes (e.g., "Part,Document")
  --skip-forms               Skip form generation
  --skip-tables              Skip table generation
  --skip-migrations          Skip DB migrations
  -d, --dry-run              Preview without writing
  -v, --validate-only        Just validate, don't generate
  -r, --report-only          Generate report only
  --overwrite                Overwrite existing files
  --verbose                  Verbose logging
```

---

## Output Structure

```
migration-output/
├── report.md                      # Migration summary + manual steps
├── types/                         # TypeScript interfaces + Zod schemas
│   ├── custom-part.ts
│   └── custom-document.ts
├── forms/                         # React form components
│   ├── CustomPartForm.tsx
│   └── CustomDocumentForm.tsx
├── tables/                        # DataGrid table components
│   ├── CustomPartTable.tsx
│   └── CustomDocumentTable.tsx
├── runtime-configs/               # JSON configuration files
│   ├── CustomPart.json
│   └── CustomDocument.json
├── migrations/                    # Database migrations
│   ├── 0001_add_custom_parts.sql
│   └── 0002_add_lifecycles.sql
└── scripts/
    └── import-configs.ts          # Script to load configs into DB
```

---

## Mapping Cheat Sheet

### ItemTypes

```
Aras ItemType → Cascadia ItemTypeConfig
├── Code:    src/lib/items/types/{name}.ts (interface + schema)
└── Runtime: item_type_configs table (labels, permissions, relationships)
```

### Properties (Fields)

```
Aras Property → TypeScript field + Zod validator

Data Types:
  string   → z.string().max(N)
  text     → z.string().max(5000)
  integer  → z.number().int()
  decimal  → z.number()
  date     → z.date()
  boolean  → z.boolean()
  item     → z.string().uuid()      // Foreign key
  list     → z.enum([...])          // Value list
```

### Forms

```
Aras Form → React component (TanStack Form)
├── Fields organized by tabs (from Aras)
├── Validation via Zod schema
└── Metadata in runtime config (labels, help text)
```

### Permissions

```
Aras Permission → RBAC arrays
├── Can Add → permissions.create: ["Engineer", "Admin"]
├── Access  → permissions.read: ["*"]
└── Update  → permissions.update: ["Engineer"]
```

### Lifecycles

```
Aras Life Cycle Map → WorkflowDefinition
├── Stored in: workflow_definitions table
├── States & transitions preserved
└── Linked via: lifecycleDefinitionId in runtime config
```

---

## Common Issues & Solutions

### Issue: "Cannot parse AML file"

**Solution**: Ensure AML export is complete. Use Aras Package Export, not Nash Export.

### Issue: "Property type X not supported"

**Solution**: Check data type mapping table in scope doc. May require manual refinement.

### Issue: "Generated code doesn't compile"

**Solution**: Run `npm run format` and fix any TypeScript errors. Check import paths.

### Issue: "Runtime config not loading"

**Solution**: Verify `npm run migrate:import-configs` completed. Check DB connection.

### Issue: "Form fields in wrong order"

**Solution**: Customize generated form component. Form order comes from Aras `sort_order`.

---

## Manual Refinement Guide

After migration, you'll typically need to:

### 1. Customize Forms

```tsx
// Generated form is a starting point
// Enhance with:
- Conditional field visibility
- Cascading dropdowns
- Custom validation messages
- Better layout/grouping
```

### 2. Add Business Logic

```typescript
// In service classes (e.g., PartService)
- Computed fields
- Complex validations
- Workflow actions
- Integration points
```

### 3. Refine Tables

```tsx
// Customize DataGrid columns
- Custom cell renderers
- Filters and sorting
- Bulk actions
- Row expansion
```

### 4. Implement Relationships

```typescript
// Build relationship UI
- BOM editor
- Document attachments
- Relationship validation
```

### 5. Configure Workflows

```typescript
// Add workflow logic
- Approval routing
- Notifications
- State transition guards
```

---

## Validation Checklist

After migration, verify:

- [ ] All ItemTypes created in `src/lib/items/types/`
- [ ] Generated TypeScript compiles (`npm run build`)
- [ ] Forms render without errors
- [ ] Database migrations applied (`npm run db:migrate`)
- [ ] Runtime configs loaded (check `item_type_configs` table)
- [ ] Can create items via UI
- [ ] Can update items via UI
- [ ] Can delete items (with correct permissions)
- [ ] Lifecycles transitions work
- [ ] Permissions enforced correctly

---

## Architecture Decisions

### Why Two-Tier Config?

**Code** (TypeScript):

- Type safety (compile-time errors)
- Version controlled
- Requires deployment to change
- Schema, components, structure

**Runtime** (Database):

- No-deploy changes
- Business user configurable
- Instant updates
- Labels, permissions, relationships

### Why Not Migrate Methods?

Level 2 (methods) requires:

- Code analysis and transformation
- JavaScript/C# → TypeScript conversion
- Complex business logic understanding

This is best done manually with developer expertise.

### Why Generate Components?

Generated forms/tables are **starting points**, not final products:

- Saves boilerplate (~200 lines per ItemType)
- Enforces consistent patterns
- Developers customize as needed
- Faster than writing from scratch

---

## Example: Before & After

### Aras ItemType (Before)

```xml
<Item type="ItemType">
  <name>Fastener</name>
  <label>Fastener</label>
  <class_structure>
    <Item type="Property">
      <name>thread_size</name>
      <data_type>string</data_type>
      <label>Thread Size</label>
    </Item>
  </class_structure>
</Item>
```

### Cascadia Code (After)

```typescript
// src/lib/items/types/fastener.ts
export interface Fastener extends BaseItem {
  itemType: 'Fastener'
  threadSize?: string
}

export const fastenerSchema = baseItemSchema.extend({
  itemType: z.literal('Fastener'),
  threadSize: z.string().max(50).optional(),
})
```

### Runtime Config (After)

```json
{
  "itemType": "Fastener",
  "label": "Fastener",
  "pluralLabel": "Fasteners",
  "permissions": {
    "create": ["Engineer"],
    "read": ["*"],
    "update": ["Engineer"],
    "delete": ["Admin"]
  }
}
```

---

## Performance Tips

- **Large exports**: Use `--itemtypes` to filter
- **Parallel processing**: Tool automatically uses multiple cores
- **Dry run first**: Use `--dry-run` to preview
- **Incremental migration**: Migrate ItemTypes in batches

---

## Getting Help

1. **Read the migration report**: `migration-output/report.md`
2. **Check scope doc**: `docs/aras-migration-tool-scope.md`
3. **Review implementation plan**: `docs/aras-migration-implementation-plan.md`
4. **Open an issue**: Include migration report + error logs

---

## Next Steps After Migration

1. **Test basic CRUD** for all migrated ItemTypes
2. **Customize forms** for better UX
3. **Add business logic** in service classes
4. **Implement relationships** (BOM, documents, etc.)
5. **Configure workflows** and approvals
6. **Set up permissions** per your organization
7. **Train users** on new Cascadia UI
8. **Migrate data** from Aras (separate process)

---

## Resources

- **Cascadia Docs**: `docs/`
- **Item Type Guide**: `docs/development/adding-item-types.md`
- **Service Patterns**: `docs/development/service-patterns.md`
- **Versioning**: `docs/development/versioning.md`
- **Workflows**: `docs/development/lifecycles-and-workflows.md`

---

**Questions?** Check `docs/aras-migration-tool-scope.md` for detailed mapping and architecture.

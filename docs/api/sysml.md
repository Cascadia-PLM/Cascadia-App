# SysML v2 API

Standards-based interoperability layer that exposes Cascadia PLM data using the OMG SysML v2 API JSON format. Cascadia designs map to SysML Projects, branches and commits carry over directly, and items are serialized as SysML Elements with proper metaclass typing.

## Overview

| Endpoint                                         | Method | Auth          | Description                       |
| ------------------------------------------------ | ------ | ------------- | --------------------------------- |
| `/api/sysml/projects`                            | GET    | Auth required | List designs as SysML projects    |
| `/api/sysml/projects/:id`                        | GET    | Auth required | Get a single project              |
| `/api/sysml/projects/:id/commits`                | GET    | Auth required | List commits for a project        |
| `/api/sysml/projects/:id/branches/:bid/elements` | POST   | Auth required | Create an element on a branch     |
| `/api/sysml/projects/:id/commits/:cid/elements`  | GET    | Auth required | Get elements at a specific commit |

## Concept mapping

### Cascadia to SysML

| Cascadia Concept   | SysML v2 Concept                     |
| ------------------ | ------------------------------------ |
| Design             | Project                              |
| Branch             | Branch                               |
| Commit             | Commit                               |
| Part               | PartDefinition                       |
| Document           | ItemDefinition (aliased as Artifact) |
| Requirement        | RequirementDefinition                |
| Task               | ActionDefinition                     |
| ChangeOrder        | Package                              |
| BOM relationship   | PartUsage (composite)                |
| Document reference | Dependency                           |
| Item version       | DataVersion                          |

### SysML Element types

The serializer maps between Cascadia item types and SysML 2.0 metaclasses in both directions.

**Definition types** (templates/classes):

| SysML Type              | Cascadia Type  |
| ----------------------- | -------------- |
| `PartDefinition`        | Part           |
| `ItemDefinition`        | Part           |
| `RequirementDefinition` | Requirement    |
| `ActionDefinition`      | Task           |
| `ConstraintDefinition`  | Requirement    |
| `InterfaceDefinition`   | Part           |
| `PortDefinition`        | Part           |
| `AttributeDefinition`   | _(no mapping)_ |

**Usage types** (instances/occurrences):

| SysML Type         | Cascadia Type  |
| ------------------ | -------------- |
| `PartUsage`        | Part           |
| `ItemUsage`        | Part           |
| `RequirementUsage` | Requirement    |
| `ActionUsage`      | Task           |
| `ConstraintUsage`  | Requirement    |
| `InterfaceUsage`   | Part           |
| `PortUsage`        | Part           |
| `AttributeUsage`   | _(no mapping)_ |

**Namespace types** (no direct Cascadia equivalent):

`Package`, `Namespace`, `LibraryPackage`

### Relationship types

The SysML module defines both standard SysML relationships and Cascadia-specific PLM relationships:

**Standard SysML relationships:**

- `Specialization` -- Inheritance (target is general type of source)
- `FeatureTyping` -- Usage typed by definition
- `Subsetting`, `Redefinition` -- Feature refinement
- `Satisfy`, `Verify`, `Derive`, `Refine`, `Trace` -- Requirement relationships
- `Allocate` -- Element allocation

**PLM-specific relationships (Cascadia extensions):**

- `BOM` -- Bill of Materials (assembly contains component)
- `DocumentReference` -- Item references document
- `AffectedItem` -- Change order affects item
- `DerivedFrom` -- Item derived from another

---

## GET /api/sysml/projects

List all designs accessible to the authenticated user, serialized as SysML Projects.

### Query Parameters

| Parameter               | Type    | Default | Description              |
| ----------------------- | ------- | ------- | ------------------------ |
| `limit` or `pageSize`   | integer | 100     | Maximum results per page |
| `offset` or `pageStart` | integer | 0       | Offset for pagination    |

Both SysML-standard (`pageSize`/`pageStart`) and conventional (`limit`/`offset`) parameter names are accepted.

### Response

```json
{
  "@type": "ProjectCollection",
  "data": [
    {
      "@id": "d0e1f2a3-...",
      "@type": "Project",
      "name": "Widget Assembly Prototype",
      "description": "Electric utility widget design",
      "created": "2025-01-15T10:30:00.000Z",
      "defaultBranch": {
        "@id": "b1c2d3e4-...",
        "name": "main"
      }
    }
  ],
  "pageSize": 100,
  "pageStart": 0,
  "totalResults": 3
}
```

> **Note:** This endpoint returns a raw SysML-formatted envelope (`@type`, `pageSize`, `pageStart`, `totalResults`) rather than the standard Cascadia `{ data: ... }` wrapper.

---

## GET /api/sysml/projects/:id

Get a single design as a SysML Project.

### Path Parameters

| Parameter | Type | Description |
| --------- | ---- | ----------- |
| `id`      | UUID | Design ID   |

### Response

```json
{
  "data": {
    "@id": "d0e1f2a3-...",
    "@type": "Project",
    "name": "Widget Assembly Prototype",
    "description": "Electric utility widget design",
    "created": "2025-01-15T10:30:00.000Z",
    "defaultBranch": {
      "@id": "b1c2d3e4-...",
      "name": "main"
    }
  }
}
```

### Errors

| Status | Condition                       |
| ------ | ------------------------------- |
| 404    | Design not found                |
| 403    | User lacks access to the design |

---

## GET /api/sysml/projects/:id/commits

List commits for a project, optionally filtered by branch.

### Path Parameters

| Parameter | Type | Description         |
| --------- | ---- | ------------------- |
| `id`      | UUID | Design (project) ID |

### Query Parameters

| Parameter   | Type    | Default            | Description                         |
| ----------- | ------- | ------------------ | ----------------------------------- |
| `branchId`  | UUID    | _(default branch)_ | Filter commits to a specific branch |
| `pageSize`  | integer | 100                | Maximum results per page            |
| `pageStart` | integer | 0                  | Offset for pagination               |

### Response

```json
{
  "@type": "CommitCollection",
  "data": [
    {
      "@id": "c1d2e3f4-...",
      "@type": "Commit",
      "created": "2025-01-20T14:00:00.000Z",
      "owningProject": { "@id": "d0e1f2a3-..." },
      "previousCommit": { "@id": "a0b1c2d3-..." },
      "change": [
        { "@id": "item-uuid-1", "@type": "DataVersion" },
        { "@id": "item-uuid-2", "@type": "DataVersion" }
      ]
    }
  ],
  "pageSize": 100,
  "pageStart": 0,
  "totalResults": 12
}
```

Each commit includes a `change` array listing item versions that were modified in that commit, typed as `DataVersion`.

---

## GET /api/sysml/projects/:id/commits/:cid/elements

Get all elements (items) at a specific commit, serialized as SysML Elements with their relationships.

### Path Parameters

| Parameter | Type | Description         |
| --------- | ---- | ------------------- |
| `id`      | UUID | Design (project) ID |
| `cid`     | UUID | Commit ID           |

### Query Parameters

| Parameter   | Type    | Default | Description              |
| ----------- | ------- | ------- | ------------------------ |
| `pageSize`  | integer | 100     | Maximum results per page |
| `pageStart` | integer | 0       | Offset for pagination    |

### Response

```json
{
  "@type": "ElementCollection",
  "data": [
    {
      "@id": "item-uuid-1",
      "@type": "PartDefinition",
      "name": "Aluminum Housing",
      "declaredName": "P-1001",
      "qualifiedName": "PC-PROTO::P-1001",
      "ownedElement": [],
      "ownedRelationship": [
        {
          "@id": "rel-uuid-1",
          "@type": "BOM",
          "source": [{ "@id": "item-uuid-1" }],
          "target": [{ "@id": "item-uuid-2" }],
          "isComposite": true,
          "multiplicity": { "lower": 2, "upper": 2 }
        }
      ]
    }
  ],
  "pageSize": 100,
  "pageStart": 0,
  "totalResults": 25
}
```

### Element serialization details

Each Cascadia item is converted using `SysMLSerializer.itemToElement()`:

- `@id` -- The item's UUID
- `@type` -- SysML metaclass from `CASCADIA_TO_SYSML_MAP` (or the item's explicit `sysmlType` if set)
- `name` -- Item name
- `declaredName` -- Item number (e.g., `P-1001`)
- `qualifiedName` -- `{designCode}::{itemNumber}` (e.g., `PC-PROTO::P-1001`)
- `ownedRelationship` -- Array of serialized relationships for this item
- Custom JSONB attributes are spread into the element as additional properties

### Relationship serialization

Each relationship is converted using `SysMLSerializer.relationshipToSysML()`:

- `@id` -- Relationship UUID
- `@type` -- Relationship type string (e.g., `BOM`, `Satisfy`, `DocumentReference`)
- `source` -- Array of `{ @id }` references to source items
- `target` -- Array of `{ @id }` references to target items
- `isComposite` -- Whether this is a composition relationship (included when set)
- `multiplicity` -- `{ lower, upper }` bounds (upper can be `"*"` for unbounded)

---

## POST /api/sysml/projects/:id/branches/:bid/elements

Create a new element on a branch by posting a SysML Element JSON object. The element is converted to a Cascadia item and created on the specified branch.

### Path Parameters

| Parameter | Type | Description         |
| --------- | ---- | ------------------- |
| `id`      | UUID | Design (project) ID |
| `bid`     | UUID | Branch ID           |

### Request Body

A SysML Element JSON object:

```json
{
  "@type": "PartDefinition",
  "name": "Motor Mount Bracket",
  "declaredName": "BRK-001"
}
```

### Element to item conversion

The serializer maps the incoming element as follows:

| SysML Field                   | Cascadia Field                                         |
| ----------------------------- | ------------------------------------------------------ |
| `@type`                       | `sysmlType` + `itemType` (via `SYSML_TO_CASCADIA_MAP`) |
| `name`                        | `name`                                                 |
| `declaredName` or `name`      | `itemNumber` (fallback: `SYSML-{timestamp}`)           |
| All other non-standard fields | Stored in `attributes` JSONB column                    |

The created item gets:

- `state`: `Draft`
- `revision`: `-`
- `metamodel`: `sysml2`

### Response

**201 Created**

```json
{
  "data": {
    "@id": "new-item-uuid",
    "@type": "PartDefinition",
    "name": "Motor Mount Bracket",
    "declaredName": "BRK-001",
    "qualifiedName": "PC-PROTO::BRK-001",
    "ownedElement": [],
    "ownedRelationship": []
  }
}
```

### Errors

| Status | Condition                                                       |
| ------ | --------------------------------------------------------------- |
| 404    | Design or branch not found, or branch does not belong to design |
| 403    | Branch is locked, or user lacks design access                   |

---

## Qualified names

SysML qualified names follow the pattern `{designCode}::{itemNumber}`, with optional parent paths for hierarchical elements:

```
PC-PROTO::P-1001                    -- Top-level item
PC-PROTO::ASM-001::P-1001           -- Nested under parent
```

The `SysMLSerializer.buildQualifiedName()` and `parseQualifiedName()` utilities handle construction and parsing.

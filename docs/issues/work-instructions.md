# Issues: Work Instructions Module

## No List Endpoint for Work Instructions

- **Severity**: minor
- **Area**: API
- **Description**: There is no `GET /api/work-instructions` (index/list) endpoint. Work instructions can only be listed through the generic ItemService search or by fetching individually by ID. Other item types typically have a dedicated list route. This may be intentional if listing is handled through the generic items search, but it is inconsistent with the pattern of having dedicated sub-resource routes for everything else in the module.
- **Location**: `src/routes/api/work-instructions/` (missing `index.ts`)
- **Suggestion**: Either add a list endpoint or document that listing uses the generic `/api/v1/items?itemType=WorkInstruction` route.

## `any` Type in Step Update Handler

- **Severity**: minor
- **Area**: code
- **Description**: The PUT handler for `steps/$stepId.ts` uses `const updateData: any = { ... }` which circumvents TypeScript strict mode. This is the only explicit `any` in the work instructions API routes.
- **Location**: `src/routes/api/work-instructions/$id/steps/$stepId.ts`, line 71
- **Suggestion**: Type `updateData` as `Partial<typeof workInstructionSteps.$inferInsert>` or a dedicated update interface.

## Operations Bulk Reorder Uses Sequential Updates

- **Severity**: cosmetic
- **Area**: code
- **Description**: The PUT handler for bulk reorder of operations (and steps) iterates and executes individual UPDATE statements within a transaction. For large work instructions this is fine, but a single `VALUES`-based CTE update would be more efficient.
- **Location**: `src/routes/api/work-instructions/$id/operations.ts`, lines 134-149
- **Suggestion**: Low priority -- current approach is correct and unlikely to cause performance issues given typical operation counts.

# Issues: Work Instructions Module

## No List Endpoint for Work Instructions

- **Severity**: minor
- **Area**: API
- **Description**: There is no `GET /api/v1/work-instructions` (index/list) endpoint. Work instructions can only be listed through the generic ItemService search or by fetching individually by ID. Other item types typically have a dedicated list route. This may be intentional if listing is handled through the generic items search, but it is inconsistent with the pattern of having dedicated sub-resource routes for everything else in the module.
- **Location**: `packages/core/src/server/routes/work-instructions.ts`
- **Suggestion**: Either add a list endpoint or document that listing uses the generic `/api/v1/items?itemType=WorkInstruction` route.

## Operations Bulk Reorder Uses Sequential Updates

- **Severity**: cosmetic
- **Area**: code
- **Description**: The PUT handler for bulk reorder of operations (and steps) iterates and executes individual UPDATE statements within a transaction. For large work instructions this is fine, but a single `VALUES`-based CTE update would be more efficient.
- **Location**: `packages/core/src/server/routes/work-instructions.ts`
- **Suggestion**: Low priority -- current approach is correct and unlikely to cause performance issues given typical operation counts.

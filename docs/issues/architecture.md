# Issues: Architecture

Issues discovered during architecture documentation research.

---

## Excessive Dynamic Imports in ChangeOrderService

- **Severity**: minor
- **Area**: code
- **Description**: `ChangeOrderService` uses `await import('../../workflows/WorkflowService')` in at least 7 separate methods. Each call pays the module resolution cost at runtime, and the pattern is repeated rather than cached at the module level.
- **Location**: `src/lib/items/services/ChangeOrderService.ts` (lines 75, 955, 971, 984, 1007, 1143, 1453)
- **Suggestion**: The dynamic import is needed to avoid a circular dependency, which is the correct approach. However, the import could be cached at the class level (similar to the pattern used in `ItemTypeRegistry.registry.ts` with `WorkflowServiceCache`) instead of re-importing in every method. A single lazy-init pattern would be cleaner:
  ```typescript
  let _WorkflowService:
    | typeof import('../../workflows/WorkflowService').WorkflowService
    | null = null
  async function getWorkflowService() {
    if (!_WorkflowService) {
      const mod = await import('../../workflows/WorkflowService')
      _WorkflowService = mod.WorkflowService
    }
    return _WorkflowService
  }
  ```

# Visualization Issues

Tracked issues and technical debt related to visualization components.

## Dual React Flow Versions — RESOLVED

The project used to ship `reactflow` v11.11.4 alongside `@xyflow/react` v12. Every graph component is now on `@xyflow/react` v12 and `reactflow` is no longer a dependency.

## History Graph Layout Duplication

**Severity:** Low (code duplication)
**Files:**

- `packages/core/src/components/versioning/CommitGraphView.tsx`
- `packages/core/src/components/change-orders/EcoHistoryGraphView.tsx`
- `packages/core/src/components/programs/ProgramHistoryGraphView.tsx`

The `layoutCommitGraph` function and `styleEdges` function are duplicated across all three history graph components with minor variations. Each implements the same Dagre-based branch-column algorithm independently.

**Recommendation:** Extract the shared layout and edge styling logic into a utility module (e.g., `packages/core/src/components/versioning/graph-layout.ts`). Each graph view can then call the shared function with its specific parameters (e.g., program-level graph passes design grouping info).

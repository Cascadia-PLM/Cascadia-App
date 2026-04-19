# Visualization Issues

Tracked issues and technical debt related to visualization components.

## Dual React Flow Versions

**Severity:** Low (technical debt)
**Affected files:** See below

The project ships two versions of React Flow simultaneously:

- `reactflow` v11.11.4 (legacy API)
- `@xyflow/react` v12.9.3 (current API)

This increases bundle size and requires developers to know which import to use for each component.

**Components using `reactflow` v11 (legacy):**

- `src/components/items/GraphNavigator.tsx`
- `src/components/items/GraphItemNode.tsx`
- `src/components/items/PartRelationshipsPanel.tsx`
- `src/components/items/RelationshipEdge.tsx`
- `src/components/change-orders/EcoAffectedItemsPanel.tsx`
- `src/components/change-orders/EcoGraphItemNode.tsx`
- `src/components/thread/DigitalThreadNavigator.tsx`
- `src/components/thread/ThreadNode.tsx`
- `src/components/thread/ThreadNodeDiff.tsx`
- `src/components/thread/ThreadComparisonDialog.tsx`
- `src/components/thread/swimLaneLayout.ts`

**Components using `@xyflow/react` v12 (current):**

- `src/components/versioning/CommitGraphView.tsx`
- `src/components/versioning/CommitNode.tsx`
- `src/components/versioning/SharedForkEdge.tsx`
- `src/components/versioning/MainHeadNode.tsx`
- `src/components/programs/ProgramHistoryGraphView.tsx`
- `src/components/programs/DesignHeaderNode.tsx`
- `src/components/programs/EcoConnectorEdge.tsx`
- `src/components/change-orders/EcoHistoryGraphView.tsx`
- `src/components/workflows/WorkflowBuilder.tsx`
- `src/components/workflows/StateNode.tsx`
- `src/components/workflows/TransitionEdge.tsx`
- `src/components/workflows/PhaseGroupNode.tsx`
- `src/components/wiring/WiringDiagram.tsx`
- `src/components/wiring/ComponentNode.tsx`

**Recommendation:** Migrate all v11 components to `@xyflow/react` v12, then remove the `reactflow` dependency. The v12 API is largely compatible; the main changes are named imports (`ReactFlow` instead of default export) and updated type generics for custom node data.

## Deprecated CADViewerControls

**Severity:** Low (dead code)
**File:** `src/components/parts/CADViewerControls.tsx`

The `CADViewerControls` component is marked `@deprecated` with a comment to use `CADViewerToolbar` instead. The deprecated component renders controls in a horizontal bar above the viewer, while the replacement `CADViewerToolbar` floats inside the viewer container.

The `CADModelStats` export from the same file is still in use for compact stats display in file lists.

**Recommendation:** Remove the deprecated `CADViewerControls` function. Verify no remaining imports reference it before removal. Keep `CADModelStats` (extract to its own file or leave in place).

## Wiring Diagram Not Integrated

**Severity:** Low (incomplete feature)
**Directory:** `src/components/wiring/`

The wiring diagram editor exists as a complete component with types, custom nodes, and example data, but is not accessible from the application navigation. There are no routes or pages that render the `WiringDiagram` component.

**Recommendation:** Either integrate the wiring diagram into the design workspace (e.g., as a tab on Part detail pages for electronic assemblies) or document it as an experimental/upcoming feature and exclude it from production builds.

## History Graph Layout Duplication

**Severity:** Low (code duplication)
**Files:**

- `src/components/versioning/CommitGraphView.tsx`
- `src/components/change-orders/EcoHistoryGraphView.tsx`
- `src/components/programs/ProgramHistoryGraphView.tsx`

The `layoutCommitGraph` function and `styleEdges` function are duplicated across all three history graph components with minor variations. Each implements the same Dagre-based branch-column algorithm independently.

**Recommendation:** Extract the shared layout and edge styling logic into a utility module (e.g., `src/components/versioning/graph-layout.ts`). Each graph view can then call the shared function with its specific parameters (e.g., program-level graph passes design grouping info).

# Visualization Features

Cascadia PLM provides several graphical interfaces for exploring complex engineering data that would be difficult to understand in tabular form alone. These visualizations cover BOM hierarchies, item relationships, version history, ECO impact analysis, and 3D CAD models.

## BOM Tree View

**Component:** `packages/core/src/components/bom/BomTreeView.tsx`

The BOM Tree View renders a hierarchical Bill of Materials as an interactive tree-table. It is the primary way users explore parent-child part structures.

### Layout Modes

The component supports two layout modes:

- **Grid layout** -- A columnar tree-table with a header row, resizable columns, column-level filtering, and optional row checkboxes. This is used in the ECO Affected Items panel and design structure views where users need to see multiple data fields per row.
- **Flow layout** -- A simpler tree list showing item number, name, revision, state badge, and quantity. Used in read-only contexts where a compact view is sufficient.

### Key Capabilities

- **Expandable rows:** Click the chevron to expand/collapse child nodes. Depth is tracked via an `expandedNodes` Set passed from the parent.
- **Indentation:** Child rows are indented by a configurable `indentPx` (default 16px per level), creating a clear visual hierarchy.
- **Cross-design badges:** Items from external designs display an amber badge with the source design code.
- **Quantity display:** When a child appears more than once (quantity > 1), a "xN" indicator is shown.
- **Column resizing:** In grid mode, columns can be resized by dragging the handle on the right edge of each header cell. The component measures initial widths from the DOM and switches to pixel-based sizing on first resize.
- **Column filtering:** Grid columns support text search and multi-select filters (e.g., filter by state or ECO action).
- **Row selection:** Optional checkboxes with select-all, shift-click range selection, and ctrl-click toggle. Used for batch operations like "Add Selected to ECO."
- **Context menus:** Right-click a row to access actions like "View," "Add to ECO," or "Add Child."
- **CSV export:** `exportBomTree.ts` flattens the tree and exports it as a CSV file with level indicators, supporting both basic BOM and ECO-annotated exports.

### Data Shape

Each node implements the `BOMTreeNode` interface defined in `packages/core/src/components/bom/types.ts`:

```typescript
interface BOMTreeNode {
  itemId: string
  masterId?: string
  itemNumber: string
  name: string
  revision: string
  state: string
  itemType: string
  designId: string | null
  quantity?: number
  findNumber?: number
  children?: Array<BOMTreeNode>
  // Cross-design fields
  designCode?: string
  isExternal?: boolean
  // ECO-specific fields
  isInEco?: boolean
  changeAction?: string | null
}
```

### Where It Appears

- **Part detail pages** -- Structure tab shows the part's BOM hierarchy.
- **ECO Affected Items** -- `EcoTreeTable` wraps `BomTreeView` with ECO-specific columns (state, change action) and context menu actions.
- **ECO Design Structure** -- `EcoDesignStructureTree` shows the full design BOM with ECO annotations, expand/collapse-all buttons, and a "Show Affected" button that expands only the paths to affected items.

## Relationship Graph

**Component:** `packages/core/src/components/items/GraphNavigator.tsx`

The Relationship Graph renders a directed graph of all relationships connected to a given item. It uses React Flow (`@xyflow/react`) for the canvas and Dagre for automatic top-to-bottom layout.

### Features

- **Multi-directional traversal:** Users choose between three modes:
  - "All relationships" -- shows everything
  - "Uses (outgoing)" -- items this item depends on
  - "Where-used (incoming)" -- items that depend on this item
- **Configurable depth:** Depth selector (1-5 levels) controls how far the graph extends from the focal item.
- **Relationship type filtering:** Available relationship types are loaded from the API. Users can toggle individual types on/off with pill-shaped filter buttons.
- **Directed edges:** Every edge carries an arrowhead at its target end and an arrow inside its label chip -- see [Edge Direction](#edge-direction).
- **Usage relationships:** Definition/Usage pattern is visualized with dashed purple edges and animated flow. Usage items get a purple border; cross-design items get an amber ring highlight.
- **Interactive navigation:** Clicking an item number in the graph navigates to that item's detail page.
- **Fullscreen mode:** The `FullscreenGraphWrapper` component provides an expand button that opens the graph in a near-full-viewport dialog.
- **Color-coded nodes:** Nodes are colored by depth level (cyan for the focal item, slate for direct relations, lighter for second-level).

### Custom Nodes

Each node (`GraphItemNode`) displays:

- Item number (clickable link)
- Revision badge
- Item name (truncated)
- Item type badge (Part = blue, Document = purple, ChangeOrder = orange)
- State badge (Draft, Released, etc.)
- Cross-design indicator with design codes
- Expand/collapse buttons for on-demand upstream/downstream exploration

### Where It Appears

- **Part detail pages** -- Collapsible "Relationship Graph" card.
- **Document detail pages** -- Same component, showing document relationships.

## Scope Graph (Program / Design Drill-Down)

**Components:** `packages/core/src/components/graph/ScopeGraphView.tsx`, `packages/core/src/components/graph/GraphScopeNode.tsx`

The Scope Graph extends the relationship graph upward into the organizational hierarchy, mixing three node kinds in one canvas: **Programs** (indigo), **Designs** (violet), and **Items** (rendered with the same `GraphItemNode` as the relationship graph). It supports step-by-step drill-down from a program all the way to physical traceability:

```
Program → Designs → Items (Parts, Requirements, Documents, …)
        → related items (Work Instructions, Work Orders, Physical Parts, …)
```

### Behavior

- **Per-node expand/collapse:** Every node carries +/− buttons above and below (the same interaction as the Part relationship graph). Programs expand down to their designs; designs expand up to their program and down to their items; items expand through the existing item graph endpoint (with `includeFiles=true`), so BOMs, usage links, derived physical edges (`BUILDS`, `INSTANCE_OF`, `Consumes`/`Produces`/`Evidences`), and attached vault files all appear exactly as they do on a part's Relationships tab.
- **Directed edges:** Item relationships drawn inside a design read the same way they do on the item's own graph -- a Part that `Satisfies` a Requirement points at the Requirement. See [Edge Direction](#edge-direction).
- **Top-level items only:** Expanding a design shows only its top-level items — an item is hidden while another shown candidate points at it (e.g. a part that sits in an assembly's BOM, or a document referenced by a part). Hidden items surface when their parent is expanded, keeping large designs readable.
- **Item type filter:** Pill buttons list every item type present in the scope with counts (aggregated across designs on the program view). Any combination can be selected; the filter shapes what design expansions return, and narrowing it re-roots the hierarchy (a document nested only under a filtered-out part becomes top-level when viewing documents alone). Changing the filter reloads the graph.
- **Navigation & fullscreen:** Program/design codes and item numbers link to their pages; the graph sits in the shared `FullscreenGraphWrapper`.

### Endpoints

- `GET /api/v1/programs/:id/graph` -- program node + design nodes + aggregated per-type item counts. Requires program membership (or global `programs read` permission).
- `GET /api/v1/designs/:id/graph?direction=all|up|down&itemTypes=A,B` -- design node, parent program (up), top-level items (down). Requires design access.
- Item nodes expand via the existing `GET /api/v1/items/:id/graph`.

Program and design nodes use prefixed IDs (`program:<uuid>`, `design:<uuid>`); item nodes keep raw item IDs so responses from the scope endpoints and the item graph endpoint merge into one client-side cache. Shared node/edge builders live in `packages/core/src/lib/api/scope-graph.ts`.

### Where It Appears

- **Program detail pages** -- "Program Graph" card.
- **Design detail pages** -- "Graph" tab (regular and library designs).

## Design History Graph

**Components:**

- `packages/core/src/components/versioning/CommitGraphView.tsx` (design-level)
- `packages/core/src/components/programs/ProgramHistoryGraphView.tsx` (program-level)

The Design History Graph visualizes the commit history of a design as a Git-style branch/merge timeline. It uses React Flow v12 (`@xyflow/react`) with Dagre layout in bottom-to-top (BT) orientation -- oldest commits at the bottom, newest at the top.

### Design-Level Graph

Shows commits for a single design with branch-aware horizontal positioning:

- **Main branch** is always at column 0 (leftmost).
- **ECO branches** are assigned columns based on their sibling rank at each fork point. Merged branches are sorted by merge order (earlier merge = lower column). Open (unmerged) branches are pushed to the rightmost columns.
- A **"main" HEAD node** sits at the top of the main column, connected to the latest main commit by a straight edge.
- **Parent edges** use step-style routing (right angles) in solid slate gray.
- **Merge edges** use smooth-step routing with dashed orange lines and a reversed animation class.
- **Shared fork edges** use a custom `SharedForkEdge` component for fork points where multiple branches diverge.

### Program-Level Graph

Shows commits across all designs in a program, laid out side-by-side:

- Each design occupies its own horizontal band with a **design header node** at the top.
- Within each band, the same branch-column logic applies.
- Column widths are calculated per-design based on actual branch count, preventing wasted horizontal space.
- Cross-design ECOs are noted in the subtitle.

### Commit Node

Each commit node (`CommitNode`) shows:

- Commit type icon (regular commit, merge, consolidated)
- Tag indicators for tagged commits
- Change stats badge (+added, ~modified, -deleted)
- Commit message (truncated to 40 characters)
- Author name and relative timestamp
- ECO number badge for ECO-related commits
- Color scheme by branch type: green (main), orange (ECO), blue (workspace), purple (release)

### Interactive Features

- Click a commit to view the design's historical state at that point.
- Zoom and pan with mouse controls.
- MiniMap with color-coded nodes for orientation in large graphs.
- Fullscreen mode via `FullscreenGraphWrapper`.
- Legend showing branch types and edge styles.

### Where It Appears

- **Design detail pages** -- "History" tab.
- **Program detail pages** -- "History" tab shows the unified graph across all designs.

## ECO History Graph

**Component:** `packages/core/src/components/change-orders/EcoHistoryGraphView.tsx`

The ECO History Graph is a specialized variant of the Design History Graph, scoped to a single Engineering Change Order. It shows the commit history of the ECO's branch alongside the main branch it forked from.

### Features

- **Multi-design support:** If an ECO affects multiple designs, a design selector lets users switch between them. Each design's graph is fetched independently.
- Uses the same commit node component and edge styling as the Design History Graph.
- Branch-aware layout with main at column 0 and ECO branches to the right.

### Where It Appears

- **Change Order detail pages** -- "Branch History" tab.

## Affected Items Graph

**Component:** `packages/core/src/components/change-orders/EcoAffectedItemsPanel.tsx`

The ECO Affected Items panel provides two complementary views of items included in an Engineering Change Order:

### Graph View (Impact Graph)

Uses React Flow with Dagre layout to visualize affected items as a directed graph showing their relationships:

- **Nodes** display item number, revision, name, state, and change action badges.
- **Edges** show BOM parent-child and other relationships between affected items, with an arrowhead pointing parent → child.
- Items are color-coded by their ECO change action (release = green, revise = blue, obsolete = red).
- Fullscreen mode available.

### Table View

A DataGrid showing all affected items in a flat table with columns for item number, name, type, design, change action, current/target revision, and current/target state.

### Tree View (Design Structure)

Uses `EcoDesignStructureTree` (which wraps `BomTreeView`) to show the full BOM structure of each affected design, with ECO items highlighted. Features include:

- Expand All / Collapse All
- "Show Affected" to auto-expand only paths containing ECO items
- Batch selection and add-to-ECO
- Per-column filtering

### Where It Appears

- **Change Order detail pages** -- "Affected Items" tab, with Graph/Table/Tree sub-tabs.

## 3D CAD Viewer

**Components:**

- `packages/core/src/components/parts/CADViewer.tsx` -- Main viewer (React Three Fiber canvas)
- `packages/core/src/components/parts/CADViewerToolbar.tsx` -- Floating toolbar
- `packages/core/src/components/parts/CADViewerTypes.ts` -- Type definitions and presets
- `packages/core/src/components/parts/useCADViewerKeyboard.ts` -- Keyboard shortcut hook

The 3D CAD Viewer renders CAD models directly in the browser using WebGL. It is built on React Three Fiber and Three.js.

### Supported Formats

| Format   | Loader       | Color Support                                    |
| -------- | ------------ | ------------------------------------------------ |
| STL      | `STLLoader`  | No (uses material preset)                        |
| OBJ      | `OBJLoader`  | No (uses material preset)                        |
| GLB/glTF | `GLTFLoader` | Yes (per-face/solid colors from STEP conversion) |

STEP and IGES files are not rendered directly. They are converted server-side by the Python CAD converter microservice (`workers/cad-converter/`) into GLB format with per-face color preservation. The viewer then loads the GLB file.

### Viewer Features

- **Trackball controls:** Rotate, pan, and zoom with mouse. Rotation is fully unconstrained (no polar-angle limit), so models can be tumbled freely in any direction for interrogation. Damping is enabled for smooth motion.
- **Auto-fit camera:** On model load, the camera automatically positions itself to frame the entire model with comfortable padding.
- **Native part coordinates:** Geometry is never recentered — a part authored away from its origin renders away from the world origin, so two versions of the same part can be overlaid and compared without a registration step. Framing is therefore always expressed relative to the model's bounding-box _center_: the camera position, the controls target, the grid, and the contact shadows all derive from it, never from the world origin. (Wrapping the model in drei's `<Center>` looks like the alternative, but its layout effect does not depend on children, so it measures an empty box before the async load finishes and silently does nothing.)
- **Dynamic zoom limits:** Min and max zoom distances are calculated from the model's bounding box, preventing both clipping into the model and zooming too far away.
- **Wireframe mode:** Toggle wireframe rendering. In wireframe mode, the model renders as blue lines.
- **Grid overlay:** Toggle an infinite grid positioned below the model. Grid cell size scales based on model dimensions.
- **Orientation gizmo:** A 3D view cube in the top-right corner shows the current camera orientation.
- **Contact shadows:** In "Studio" background mode, soft contact shadows appear beneath the model.
- **Model statistics:** The toolbar displays the triangle count.

### Background Presets

| Preset  | Description                                            |
| ------- | ------------------------------------------------------ |
| Light   | Light gradient with city environment                   |
| Dark    | Dark gradient with night environment (default)         |
| Neutral | Gray gradient with warehouse environment               |
| Studio  | Light gray with studio environment and contact shadows |

### Material Presets

| Preset        | Description                   |
| ------------- | ----------------------------- |
| Gray Metal    | Default metallic gray         |
| Blue Metal    | Blue with high metalness      |
| White Plastic | White matte                   |
| Dark Metal    | Dark with high metalness      |
| Gold          | Gold with very high metalness |

For GLB files with embedded colors (from STEP conversion), the "default" preset shows the original per-face colors. Switching to any other preset overrides all materials.

### Standard Camera Views

Seven preset camera views are available via keyboard shortcuts or toolbar:

| Key | View      |
| --- | --------- |
| `1` | Front     |
| `2` | Back      |
| `3` | Left      |
| `4` | Right     |
| `5` | Top       |
| `6` | Bottom    |
| `0` | Isometric |

### Keyboard Shortcuts

| Key          | Action                       |
| ------------ | ---------------------------- |
| `R`          | Reset view (auto-fit camera) |
| `W`          | Toggle wireframe             |
| `F`          | Toggle fullscreen            |
| `G`          | Toggle grid                  |
| `1`-`6`, `0` | Standard views (see above)   |

Keyboard shortcuts only fire when the pointer is over or focus is within the viewer container. They are ignored when typing in form elements.

### Toolbar

The `CADViewerToolbar` floats in the top-left corner of the viewer and provides:

- Reset View button
- Wireframe toggle
- Grid toggle
- Background preset dropdown
- Material preset dropdown (shows "Original Colors" for GLB files with embedded colors)
- Download button (if available)
- Fullscreen toggle
- Triangle count display

### Technical Architecture

The viewer is built on:

- **React Three Fiber** (`@react-three/fiber` v9) -- React renderer for Three.js
- **React Three Drei** (`@react-three/drei` v10) -- Helper components (TrackballControls, Environment, GizmoHelper, Grid, etc.)
- **Three.js** (v0.182) -- Core 3D rendering library

The `CADViewer` component uses `forwardRef` to expose a `CADViewerHandle` with `resetView()` and `setView()` methods. The internal `Model` component handles loading via Three.js loaders, computing normals and bounding boxes, and applying material presets.

### Where It Appears

- **Part detail pages** -- Files tab shows the 3D viewer for CAD files.
- **Design engine** -- CAD Review panel shows generated models.

## Digital Thread Navigator

**Component:** `packages/core/src/components/thread/DigitalThreadNavigator.tsx`

The Digital Thread Navigator visualizes the full traceability chain of an item across engineering and manufacturing domains using a swim-lane layout.

### Features

- **Domain-based swim lanes:** Nodes are organized into engineering and manufacturing domains, laid out using a custom `swimLaneLayout` function.
- **Directed edges:** Lanes stack in flow order, but relationships that run against it (`INSTANCE_OF`, `VERIFIED_BY`) travel back up the canvas -- so the arrowhead, not the node's position, is what says which item the relationship is stated on.
- **Configurable traversal depth:** Separate depth controls for upstream (3 levels default), downstream (3 levels), and BOM depth (2 levels).
- **Layout direction:** Toggle between top-to-bottom (TB) and left-to-right (LR) orientation.
- **Thread comparison:** Compare the digital thread across different revisions or branches via a comparison dialog.
- **Custom thread nodes** (`ThreadNode`) with domain-specific styling.
- Fullscreen mode via `FullscreenGraphWrapper`.

### Where It Appears

- **Part detail pages** -- Collapsible "Digital Thread" card.

## Workflow Builder

**Component:** `packages/core/src/components/workflows/WorkflowBuilder.tsx`

While primarily a configuration tool rather than a data visualization, the Workflow Builder uses React Flow v12 with Dagre layout to render lifecycle state machines as interactive graphs.

### Features

- **State nodes** with configurable properties (name, type, actions, permissions).
- **Transition edges** showing allowed state changes with labels.
- **Phase group nodes** that visually group states into lifecycle phases.
- **Drag-and-drop editing** for repositioning states.
- **Add state/transition** directly on the canvas.
- **Auto-layout** via Dagre.
- **Properties panels** for editing selected states, transitions, and phases.

### Where It Appears

- **Admin pages** -- Workflow definition editor.

## Shared Infrastructure

### Edge Direction

**Module:** `packages/core/src/components/graph/edgeStyles.ts`
**Edge component:** `packages/core/src/components/graph/RelationshipEdge.tsx`
**Legend:** `packages/core/src/components/graph/EdgeDirectionLegend.tsx`

Relationships are directed and asymmetric: a Part that `Satisfies` a Requirement is stored as `source: part`, `target: requirement`, and the graph must read that way -- "the Part satisfies the Requirement", never the reverse. Three cues carry that direction, and every relationship graph uses all three:

1. **Arrowhead at the target end.** `directionalMarker(color)` builds a 22px `ArrowClosed` marker in the edge's own colour. Colours are never left to React Flow, whose `defaultMarkerColor` is a fixed `#b1b1b7` that tracks neither the stroke nor the light/dark colour mode -- an arrowhead left to the default is a different colour from its own line.
2. **Arrow inside the label chip.** `RelationshipEdge` rotates an arrow glyph by `atan2(targetY - sourceY, targetX - sourceX)`, so the relationship name and the direction it points are read in one glance rather than by tracing the line to its end.
3. **Plain-language tooltip.** `withEdgeDirectionLabels()` walks the laid-out graph and writes `data.directionSentence` -- "PRT-001 Satisfies REQ-002" -- which the chip exposes as its `title` and `aria-label`. It runs over the visible node set rather than a single API response, so edges spanning two separately-fetched expansions are still named.

Supporting pieces in the same module:

| Export                   | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `GRAPH_EDGE_COLORS`      | Per-kind colours, legible on both the light and dark canvas                 |
| `graphEdgeKind(data)`    | Classifies an edge from the `is*Relationship` flags the graph endpoints set |
| `graphEdgeVisuals(kind)` | Stroke, dash pattern, arrowhead and label colour for one kind               |
| `parallelEdgeOffsets()`  | Sideways spread for edges sharing a node pair, so their labels do not stack |
| `USAGE_EDGE_LABEL`       | `'used by'` -- see below                                                    |

**Flipped `UsageOf` edges.** The API returns usage relationships as usage → definition. Every graph view flips them so a definition sits above its usages, which means the wording has to flip too: the server's `"usage of"` would read backwards against the arrow, so the client relabels to `"used by"` and the edge reads "definition used by usage".

Edge kinds and their colours:

| Kind           | Colour              | Drawn as   | Used for                                         |
| -------------- | ------------------- | ---------- | ------------------------------------------------ |
| `relationship` | slate-500 `#64748b` | solid      | Item relationships (BOM, Satisfies, …)           |
| `usage`        | purple-500          | dashed 5,5 | Definition/Usage links                           |
| `physical`     | emerald-500         | dashed 5,5 | Derived physical links (`BUILDS`, `INSTANCE_OF`) |
| `file`         | sky-500             | dashed 3,3 | Attached vault files                             |
| `scope`        | slate-400 `#94a3b8` | solid      | Program → Design → Item containment              |

Containment sits one step lighter than relationships so the organizational scaffolding recedes behind the engineering data drawn over it.

### FullscreenGraphWrapper

**Component:** `packages/core/src/components/ui/FullscreenGraphWrapper.tsx`

A reusable wrapper that adds fullscreen/focus mode to any graph view. It renders the graph inline at a configurable height (default 600px) with an expand button, and opens a near-full-viewport Radix Dialog when toggled. The dialog includes a title bar, optional header controls, and footer area (typically used for legends).

Used by: CommitGraphView, ProgramHistoryGraphView, EcoHistoryGraphView, GraphNavigator, DigitalThreadNavigator, EcoAffectedItemsPanel.

### Dagre Layout

All graph visualizations use the `dagre` library (v0.8.5) for automatic node positioning. Common layout patterns:

- **Top-to-bottom (TB):** Used by GraphNavigator and WorkflowBuilder.
- **Bottom-to-top (BT):** Used by all history graph views (commits flow upward from old to new).
- **Swim lanes:** Used by DigitalThreadNavigator with custom layout logic.

### React Flow Version

Every graph view uses **`@xyflow/react` v12**. The legacy `reactflow` v11 package is no longer a dependency.

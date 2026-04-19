# Visualization Features

Cascadia PLM provides several graphical interfaces for exploring complex engineering data that would be difficult to understand in tabular form alone. These visualizations cover BOM hierarchies, item relationships, version history, ECO impact analysis, 3D CAD models, and wiring diagrams.

## BOM Tree View

**Component:** `src/components/bom/BomTreeView.tsx`

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

Each node implements the `BOMTreeNode` interface defined in `src/components/bom/types.ts`:

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

**Component:** `src/components/items/GraphNavigator.tsx`

The Relationship Graph renders a directed graph of all relationships connected to a given item. It uses React Flow (v11, `reactflow` package) for the canvas and Dagre for automatic top-to-bottom layout.

### Features

- **Multi-directional traversal:** Users choose between three modes:
  - "All relationships" -- shows everything
  - "Uses (outgoing)" -- items this item depends on
  - "Where-used (incoming)" -- items that depend on this item
- **Configurable depth:** Depth selector (1-5 levels) controls how far the graph extends from the focal item.
- **Relationship type filtering:** Available relationship types are loaded from the API. Users can toggle individual types on/off with pill-shaped filter buttons.
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

## Design History Graph

**Components:**

- `src/components/versioning/CommitGraphView.tsx` (design-level)
- `src/components/programs/ProgramHistoryGraphView.tsx` (program-level)

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

**Component:** `src/components/change-orders/EcoHistoryGraphView.tsx`

The ECO History Graph is a specialized variant of the Design History Graph, scoped to a single Engineering Change Order. It shows the commit history of the ECO's branch alongside the main branch it forked from.

### Features

- **Multi-design support:** If an ECO affects multiple designs, a design selector lets users switch between them. Each design's graph is fetched independently.
- Uses the same commit node component and edge styling as the Design History Graph.
- Branch-aware layout with main at column 0 and ECO branches to the right.

### Where It Appears

- **Change Order detail pages** -- "Branch History" tab.

## Affected Items Graph

**Component:** `src/components/change-orders/EcoAffectedItemsPanel.tsx`

The ECO Affected Items panel provides two complementary views of items included in an Engineering Change Order:

### Graph View (Impact Graph)

Uses React Flow (v11) with Dagre layout to visualize affected items as a directed graph showing their relationships:

- **Nodes** display item number, revision, name, state, and change action badges.
- **Edges** show BOM parent-child and other relationships between affected items.
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

- `src/components/parts/CADViewer.tsx` -- Main viewer (React Three Fiber canvas)
- `src/components/parts/CADViewerToolbar.tsx` -- Floating toolbar
- `src/components/parts/CADViewerTypes.ts` -- Type definitions and presets
- `src/components/parts/useCADViewerKeyboard.ts` -- Keyboard shortcut hook

The 3D CAD Viewer renders CAD models directly in the browser using WebGL. It is built on React Three Fiber and Three.js.

### Supported Formats

| Format   | Loader       | Color Support                                    |
| -------- | ------------ | ------------------------------------------------ |
| STL      | `STLLoader`  | No (uses material preset)                        |
| OBJ      | `OBJLoader`  | No (uses material preset)                        |
| GLB/glTF | `GLTFLoader` | Yes (per-face/solid colors from STEP conversion) |

STEP and IGES files are not rendered directly. They are converted server-side by the Python CAD converter microservice (`workers/cad-converter/`) into GLB format with per-face color preservation. The viewer then loads the GLB file.

### Viewer Features

- **Orbit controls:** Rotate, pan, and zoom with mouse. Damping is enabled for smooth motion.
- **Auto-fit camera:** On model load, the camera automatically positions itself to frame the entire model with comfortable padding.
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
- **React Three Drei** (`@react-three/drei` v10) -- Helper components (OrbitControls, Environment, GizmoHelper, Grid, etc.)
- **Three.js** (v0.182) -- Core 3D rendering library

The `CADViewer` component uses `forwardRef` to expose a `CADViewerHandle` with `resetView()` and `setView()` methods. The internal `Model` component handles loading via Three.js loaders, computing normals and bounding boxes, and applying material presets.

### Where It Appears

- **Part detail pages** -- Files tab shows the 3D viewer for CAD files.
- **Design engine** -- CAD Review panel shows generated models.

## Digital Thread Navigator

**Component:** `src/components/thread/DigitalThreadNavigator.tsx`

The Digital Thread Navigator visualizes the full traceability chain of an item across engineering and manufacturing domains using a swim-lane layout.

### Features

- **Domain-based swim lanes:** Nodes are organized into engineering and manufacturing domains, laid out using a custom `swimLaneLayout` function.
- **Configurable traversal depth:** Separate depth controls for upstream (3 levels default), downstream (3 levels), and BOM depth (2 levels).
- **Layout direction:** Toggle between top-to-bottom (TB) and left-to-right (LR) orientation.
- **Thread comparison:** Compare the digital thread across different revisions or branches via a comparison dialog.
- **Custom thread nodes** (`ThreadNode`) with domain-specific styling.
- Fullscreen mode via `FullscreenGraphWrapper`.

### Where It Appears

- **Part detail pages** -- Collapsible "Digital Thread" card.

## Wiring Diagram Editor

**Components:**

- `src/components/wiring/WiringDiagram.tsx` -- Main diagram component
- `src/components/wiring/ComponentNode.tsx` -- Custom component node
- `src/components/wiring/types.ts` -- Type definitions
- `src/components/wiring/exampleDiagrams.ts` -- Demo data

> **Status: Experimental.** The wiring diagram editor is a proof-of-concept for IoT device wiring visualization. It includes demo data but is not yet integrated into the main PLM workflow.

The Wiring Diagram Editor renders electronic component wiring diagrams using React Flow v12 (`@xyflow/react`).

### Features

- **Component nodes** with typed pins (input, output, power, ground, bidirectional) rendered as colored handles.
- **Wire connections** with configurable colors, labels, signal types, and gauge information.
- **Component types:** microcontroller, sensor, actuator, power, display, communication, passive, connector.
- **View/edit modes:** In view mode, nodes are fixed and non-connectable. In edit mode, nodes are draggable and connectable.
- **MiniMap** with color-coded nodes by component type.
- **Info panel** showing diagram name, description, component/connection counts, and electrical metadata (voltage, power).
- **Dark mode support** via `colorMode` prop.

### Component Node Data

Each component node carries:

- Label and component type
- Part number (linkable to BOM items)
- Pin definitions with position, type, and electrical specifications
- Optional description, datasheet URL, and image
- Additional specifications dictionary

### Where It Appears

- Currently only available as a standalone component with example diagrams. Not yet surfaced in the main application navigation.

## Workflow Builder

**Component:** `src/components/workflows/WorkflowBuilder.tsx`

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

### FullscreenGraphWrapper

**Component:** `src/components/ui/FullscreenGraphWrapper.tsx`

A reusable wrapper that adds fullscreen/focus mode to any graph view. It renders the graph inline at a configurable height (default 600px) with an expand button, and opens a near-full-viewport Radix Dialog when toggled. The dialog includes a title bar, optional header controls, and footer area (typically used for legends).

Used by: CommitGraphView, ProgramHistoryGraphView, EcoHistoryGraphView, GraphNavigator, DigitalThreadNavigator, EcoAffectedItemsPanel.

### Dagre Layout

All graph visualizations use the `dagre` library (v0.8.5) for automatic node positioning. Common layout patterns:

- **Top-to-bottom (TB):** Used by GraphNavigator and WorkflowBuilder.
- **Bottom-to-top (BT):** Used by all history graph views (commits flow upward from old to new).
- **Swim lanes:** Used by DigitalThreadNavigator with custom layout logic.

### React Flow Versions

The project currently uses two versions of React Flow:

- **`reactflow` v11.11.4** -- Used by GraphNavigator, DigitalThreadNavigator, and EcoAffectedItemsPanel.
- **`@xyflow/react` v12.9.3** -- Used by CommitGraphView, ProgramHistoryGraphView, EcoHistoryGraphView, WiringDiagram, and WorkflowBuilder.

See `docs/issues/visualization.md` for migration notes.

# Cascadia PLM Feature List

> **Last Updated:** April 2026
> **Version:** 0.1.0 (Initial Open-Source Release)

This document tracks all implemented features in Cascadia PLM, organized by category. Use ✅ for complete, 🟡 for partial/in-progress, and ⬜ for planned.

---

## Core Item Types

Eight core PLM item types are implemented with full CRUD operations.

| Item Type            | Status | Description                                                                                                        |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| **Part**             | ✅     | Parts with materials, partType (Manufacture/Purchase/Phantom/Software), cost, lead times                           |
| **Document**         | ✅     | Version-controlled files with check-in/check-out                                                                   |
| **Change Order**     | ✅     | ECO/ECN/MCO/Deviation workflows for change management                                                              |
| **Project**          | ✅     | Programs and designs for organizational hierarchy                                                                  |
| **Requirement**      | ✅     | Requirements tracking with acceptance criteria, priority, source                                                   |
| **Task**             | ✅     | Work items with assignees, due dates, estimated/actual hours                                                       |
| **Work Instruction** | ✅     | Rich step-by-step manufacturing instructions with parametric data                                                  |
| **Issue**            | 🟡     | Defect/quality tracking with severity, category, root cause (initial — unified CRUD, import; dedicated UI planned) |

### Two-Table Pattern

Every item type follows the unified architecture:

- **Base `items` table**: Common fields (itemNumber, revision, state, masterId, etc.)
- **Type-specific table**: Domain fields (parts.material, documents.fileType, etc.)

This enables unified queries across all items while maintaining type-specific data integrity.

---

## Change Management (ECO-as-Branch)

The signature differentiator: Git-style branching for engineering changes.

### Core Workflow ✅

| Feature                          | Status | Notes                                                                |
| -------------------------------- | ------ | -------------------------------------------------------------------- |
| Create ECO with branch isolation | ✅     | Each ECO gets its own working branch                                 |
| Add affected items to ECO        | ✅     | Items checked out to ECO branch                                      |
| Parallel ECOs on same items      | ✅     | Multiple ECOs can modify the same part independently                 |
| ECO approval workflow            | ✅     | Configurable state machine (Draft → In Review → Approved → Released) |
| ECO release with merge           | ✅     | Branch merged to main, revision letters assigned                     |
| Conflict detection               | ✅     | Identifies when multiple ECOs modify same items                      |
| ECO cancellation                 | ✅     | Clean branch deletion, no residual state                             |

### Change Actions ✅

| Action       | Description                                  |
| ------------ | -------------------------------------------- |
| **Release**  | First release of new item (Draft → Released) |
| **Revise**   | Create new revision of released item         |
| **Obsolete** | Mark item as obsolete                        |
| **Add**      | Add existing item to assembly BOM            |
| **Remove**   | Remove item from assembly BOM                |
| **Promote**  | Transition across lifecycle phase boundaries |

### Impact Analysis ✅

| Feature                | Status | Notes                                            |
| ---------------------- | ------ | ------------------------------------------------ |
| Where-used impact tree | ✅     | Recursive BOM traversal up to configurable depth |
| Cross-design impact    | ✅     | Detects items referenced from other designs      |
| Definition-usage chain | ✅     | Follows reusable part definition/instance links  |
| Deduplication          | ✅     | Affected item list without duplicates            |
| Impact assessment API  | ✅     | `POST /api/change-orders/:id/impact-assessment`  |

### Branch Operations ✅

| Operation            | Status | Notes                              |
| -------------------- | ------ | ---------------------------------- |
| Create branch        | ✅     | ECO branches created automatically |
| List branches        | ✅     | View all branches per design       |
| Branch status        | ✅     | Ahead/behind commit counts         |
| View branch items    | ✅     | Items modified on branch           |
| Merge to main        | ✅     | On ECO release                     |
| Branch history/graph | ✅     | Visual commit history              |

---

## BOM Management

Bill of Materials with hierarchical relationships, where-used tracking, and cross-design references.

| Feature                    | Status | Notes                                                                                |
| -------------------------- | ------ | ------------------------------------------------------------------------------------ |
| Parent/child relationships | ✅     | Parts can contain other parts                                                        |
| Quantity tracking          | ✅     | Per-relationship quantity                                                            |
| Find numbers               | ✅     | Position identifiers in assembly                                                     |
| Reference designators      | ✅     | For electrical components                                                            |
| BOM tree visualization     | ✅     | Expandable grid tree-table view                                                      |
| Where-used queries         | ✅     | "What assemblies use this part?"                                                     |
| Multi-level BOM expansion  | ✅     | Full indented BOM                                                                    |
| BOM changes tracked by ECO | ✅     | Add/remove tracked in change orders                                                  |
| Cross-design references    | ✅     | Read-only links to items in other designs                                            |
| MBOM (Manufacturing BOM)   | 🟡     | Initial — EBOM-to-MBOM creation, upstream change tracking; full UI/workflows planned |

---

## File Vault & Document Control

Enterprise-grade file management with PDM-style check-in/check-out.

| Feature                   | Status | Notes                             |
| ------------------------- | ------ | --------------------------------- |
| File upload/download      | ✅     | Attach files to any item          |
| Check-out for edit        | ✅     | Lock file for exclusive editing   |
| Check-in with versioning  | ✅     | Create new file version           |
| Discard checkout          | ✅     | Unlock without saving             |
| Lock status indicators    | ✅     | Show who has file locked          |
| Primary file designation  | ✅     | Main file per item                |
| Multiple files per item   | ✅     | Supporting documents              |
| File metadata             | ✅     | Size, type, dates                 |
| Branch-aware file storage | ✅     | Files isolated per ECO branch     |
| File promotion on merge   | ✅     | ECO files visible after release   |
| Storage abstraction       | ✅     | Local filesystem or S3-compatible |

---

## Workflow Engine

Configurable state machines for lifecycle and approval workflows.

### Lifecycle Management ✅

| Feature                  | Status | Notes                                                                   |
| ------------------------ | ------ | ----------------------------------------------------------------------- |
| State definitions        | ✅     | Custom states per item type                                             |
| State transitions        | ✅     | Allowed moves between states                                            |
| Initial/final states     | ✅     | Entry and terminal states                                               |
| State colors             | ✅     | Visual indicators                                                       |
| Per-item-type lifecycles | ✅     | Different lifecycles for parts vs documents                             |
| Lifecycle phases         | ✅     | Named phases (e.g., Prototype, Production) with per-phase configuration |
| Revision schemes         | ✅     | Alpha (A,B,C), numeric (1,2,3), prefixed-numeric (X1,X2), or none       |
| Per-phase revision reset | ✅     | Optionally reset revision numbering on phase entry                      |

### Workflow Features ✅

| Feature                 | Status | Notes                                   |
| ----------------------- | ------ | --------------------------------------- |
| Workflow definitions    | ✅     | JSON-based workflow configuration       |
| Workflow instances      | ✅     | Track workflow state per item           |
| Transition history      | ✅     | Full audit trail                        |
| Approval voting         | ✅     | Multi-approver support                  |
| Comments on transitions | ✅     | Notes when changing state               |
| Auto-start workflows    | ✅     | Workflow starts on ECO creation by type |

### Default Workflows Included ✅

- **Part Lifecycle**: Draft → In Review → Released → Superseded/Obsolete
- **Document Lifecycle**: Draft → In Review → Released → Superseded/Obsolete
- **ECO Workflow**: Draft → Submitted → In Review → Approved → Released | Rejected | Cancelled

---

## Versioning System (Git-Style)

Beyond traditional PLM revision tracking.

| Feature                      | Status | Notes                                        |
| ---------------------------- | ------ | -------------------------------------------- |
| Revision letters             | ✅     | A, B, C... assigned on release               |
| Master/instance pattern      | ✅     | masterId links revisions of same item        |
| Commit tracking              | ✅     | Every change creates a commit                |
| Commit messages              | ✅     | Describe what changed                        |
| Commit history               | ✅     | Full timeline per design                     |
| Design history graph         | ✅     | Visual branch/merge diagram                  |
| Branch isolation             | ✅     | Changes invisible until merged               |
| Merge commits                | ✅     | Record ECO releases                          |
| Baseline tags                | ✅     | Named snapshots of design state              |
| Change history tracking      | ✅     | Per-item edit history with field-level diffs |
| Relationship change tracking | ✅     | BOM add/remove/modify tracked in history     |

---

## User Management & Authentication

Enterprise authentication with flexible identity options.

### Authentication ✅

| Feature              | Status | Notes                                      |
| -------------------- | ------ | ------------------------------------------ |
| Email/password login | ✅     | Oslo.js crypto for password hashing        |
| Session management   | ✅     | Secure session tokens, SameSite=Strict     |
| Session expiration   | ✅     | Configurable timeouts                      |
| OAuth support        | ✅     | Arctic library integration                 |
| Account lockout      | ✅     | Brute-force protection after failed logins |

### Security Hardening ✅

| Feature                   | Status | Notes                                                                        |
| ------------------------- | ------ | ---------------------------------------------------------------------------- |
| CSRF protection           | ✅     | Origin/Referer validation on state-changing requests                         |
| CORS configuration        | ✅     | Dynamic per-request, env-configurable origins                                |
| Security response headers | ✅     | X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy |
| Input validation          | ✅     | Zod schemas on all API inputs                                                |
| File upload hardening     | ✅     | MIME type validation, size limits                                            |

### User Administration ✅

| Feature                      | Status | Notes                          |
| ---------------------------- | ------ | ------------------------------ |
| User CRUD                    | ✅     | Create, edit, deactivate users |
| Role assignment              | ✅     | Users can have multiple roles  |
| Password reset               | ✅     | Admin-initiated                |
| Last login tracking          | ✅     | Audit trail                    |
| User activation/deactivation | ✅     | Soft delete                    |

---

## Access Control (RBAC)

Program-based permissions for enterprise data isolation.

| Feature                    | Status | Notes                                   |
| -------------------------- | ------ | --------------------------------------- |
| Role definitions           | ✅     | Administrator, Engineer, Viewer, etc.   |
| Permission arrays          | ✅     | create/read/update/delete per item type |
| Program membership         | ✅     | Users assigned to programs              |
| Program-level isolation    | ✅     | Users only see their programs           |
| Design-level access        | ✅     | Permissions cascade from programs       |
| Runtime config permissions | ✅     | Configurable without code changes       |

### Default Roles ✅

| Role          | Description                        |
| ------------- | ---------------------------------- |
| Administrator | Full system access                 |
| Engineer      | Create/edit parts, documents, ECOs |
| Viewer        | Read-only access                   |

---

## Program & Design Hierarchy

Organizational structure for multi-product companies.

### Programs ✅

| Feature           | Status | Notes                         |
| ----------------- | ------ | ----------------------------- |
| Program CRUD      | ✅     | Create/edit programs          |
| Program status    | ✅     | Active, On Hold, Completed    |
| Customer tracking | ✅     | External customer reference   |
| Contract numbers  | ✅     | External contract reference   |
| Member management | ✅     | Add/remove users from program |
| Program dashboard | ✅     | Statistics and overview       |

### Designs ✅

| Feature                 | Status | Notes                                                               |
| ----------------------- | ------ | ------------------------------------------------------------------- |
| Design CRUD             | ✅     | Create/edit designs                                                 |
| Design families         | ✅     | Group related designs                                               |
| Default branch          | ✅     | Main branch per design                                              |
| Design statistics       | ✅     | Item counts, change activity                                        |
| Design status           | ✅     | Branch ahead/behind indicators                                      |
| Clone design            | ✅     | Copy design structure as a cloned "usage" reference of the original |
| Cross-design references | ✅     | Read-only links to items in other designs, branch-tracked           |
| Design structure API    | ✅     | Hierarchical design structure endpoint                              |

---

## Search & Navigation

Finding items across the system.

| Feature                    | Status | Notes                        |
| -------------------------- | ------ | ---------------------------- |
| Enterprise search          | ✅     | Search across all item types |
| Type-specific search       | ✅     | Filter by item type          |
| Item number search         | ✅     | Exact match lookup           |
| Full-text search           | ✅     | PostgreSQL text search       |
| Search by filename         | ✅     | Find items by attached file  |
| State filtering            | ✅     | Filter by lifecycle state    |
| Item lists with pagination | ✅     | Performant large result sets |
| Sortable columns           | ✅     | Click to sort                |

---

## Visualization

Graphical interfaces for complex data.

| Feature              | Status | Notes                            |
| -------------------- | ------ | -------------------------------- |
| BOM tree view        | ✅     | Hierarchical grid tree-table     |
| Relationship graph   | ✅     | React Flow visualization         |
| Design history graph | ✅     | Branch/commit timeline           |
| Affected items tree  | ✅     | ECO impact visualization         |
| 3D CAD viewer        | ✅     | STL/OBJ/GLB rendering in browser |

### 3D Viewer Features ✅

| Feature                   | Status |
| ------------------------- | ------ |
| STL file support          | ✅     |
| OBJ file support          | ✅     |
| GLB (binary glTF) support | ✅     |
| Per-face/solid colors     | ✅     |
| Orbit controls            | ✅     |
| Auto-fit camera           | ✅     |
| Wireframe mode            | ✅     |
| Model statistics          | ✅     |
| Reset view                | ✅     |

---

## Reporting Engine

Configurable reports with export capabilities.

| Feature            | Status | Notes                           |
| ------------------ | ------ | ------------------------------- |
| Report definitions | ✅     | JSON-based report configuration |
| Report execution   | ✅     | Run report with parameters      |
| Report preview     | ✅     | View results before export      |
| CSV export         | ✅     | Download as spreadsheet         |
| Saved reports      | ✅     | Persist report configurations   |

---

## Import/Export

Bulk data import from spreadsheets with intelligent BOM parsing.

### File Import ✅

| Feature                    | Status | Notes                                        |
| -------------------------- | ------ | -------------------------------------------- |
| Excel import (.xlsx, .xls) | ✅     | ExcelJS-based parsing                        |
| CSV import                 | ✅     | RFC 4180 compliant with quoted field support |
| Column auto-mapping        | ✅     | Intelligent field matching by header names   |
| Validation preview         | ✅     | Review errors/warnings before import         |
| Bulk part creation         | ✅     | Up to 500 rows per import                    |
| Rich text handling         | ✅     | Extracts text from Excel rich text cells     |
| Formula result extraction  | ✅     | Uses calculated values, not formulas         |

### BOM Import ✅

| Feature                    | Status | Notes                                       |
| -------------------------- | ------ | ------------------------------------------- |
| Level-based BOM (indented) | ✅     | Level column defines hierarchy depth        |
| Parent-child BOM           | ✅     | Explicit parent item number column          |
| Flat parts list            | ✅     | No hierarchy, parts only                    |
| Auto-detect BOM format     | ✅     | Determines format from mapped columns       |
| Quantity tracking          | ✅     | Per-relationship quantity from import       |
| Find numbers               | ✅     | Position identifiers from import            |
| Reference designators      | ✅     | Electrical component references from import |
| External parent support    | ✅     | Link to existing items not in import file   |
| BOM validation             | ✅     | Cycle detection, duplicate checking         |

### Import API ✅

| Endpoint                 | Status | Notes                                  |
| ------------------------ | ------ | -------------------------------------- |
| `POST /api/import/parts` | ✅     | Bulk part creation + BOM relationships |
| Branch-aware import      | ✅     | Import to ECO branch or main           |

---

## SysML v2 API

Standards-based interoperability layer.

| Feature                                          | Status | Notes                          |
| ------------------------------------------------ | ------ | ------------------------------ |
| `/api/sysml/projects`                            | ✅     | List designs as SysML projects |
| `/api/sysml/projects/:id`                        | ✅     | Get single project             |
| `/api/sysml/projects/:id/commits`                | ✅     | Commit history                 |
| `/api/sysml/projects/:id/branches/:bid/elements` | ✅     | Elements on branch             |
| `/api/sysml/projects/:id/commits/:cid/elements`  | ✅     | Elements at commit             |
| SysML element serialization                      | ✅     | Convert items to SysML format  |
| SysML relationship mapping                       | ✅     | BOM, Satisfy, Verify, etc.     |

### SysML Relationship Types ✅

Cascadia items map to SysML v2 concepts:

- Parts → PartDefinition / PartUsage
- Documents → Artifact
- Requirements → RequirementDefinition / RequirementUsage
- BOM → PartUsage (composite)
- References → Dependency (non-composite)

---

## API & Integration

RESTful API for external system integration.

### REST API ✅

| Endpoint Category      | Status | Notes                                  |
| ---------------------- | ------ | -------------------------------------- |
| Items CRUD             | ✅     | All item types                         |
| Relationships          | ✅     | Create, update, delete                 |
| Files                  | ✅     | Upload, download, check-in/out         |
| Workflows              | ✅     | Transitions, history                   |
| Change Orders          | ✅     | Full ECO lifecycle + impact assessment |
| Users & Roles          | ✅     | Administration                         |
| Reports                | ✅     | Execute and export                     |
| Search                 | ✅     | Enterprise search                      |
| Work Instructions      | ✅     | CRUD, executions, change alerts        |
| Design Engine Sessions | ✅     | Create, stream, update, complete       |
| AI Chat                | ✅     | Conversations with tool use            |

### Batch Operations ✅

| Operation                 | Status | Notes                         |
| ------------------------- | ------ | ----------------------------- |
| Batch item create         | ✅     | Create multiple items         |
| Batch relationship create | ✅     | Create multiple relationships |

### CAD Integration

| Integration          | Status | Notes                                                                           |
| -------------------- | ------ | ------------------------------------------------------------------------------- |
| SolidWorks connector | 🟡     | Development started                                                             |
| Solid Edge connector | 🟡     | Nearing phase 1 complete (Part/BOM push, no file transfer or PDM functionality) |

---

## Background Jobs System

Enterprise-scale async processing.

### Infrastructure ✅

| Component             | Status | Notes                             |
| --------------------- | ------ | --------------------------------- |
| RabbitMQ integration  | ✅     | Message broker for job queue      |
| Job worker process    | ✅     | Separate worker container         |
| Job type registry     | ✅     | Extensible handler registration   |
| Job priority levels   | ✅     | High/medium/low priority          |
| Job timeout handling  | ✅     | Configurable timeouts             |
| Graceful shutdown     | ✅     | Drain jobs before stop            |
| Job progress tracking | ✅     | Percent complete, status messages |
| Job logging           | ✅     | Debug/info/warn/error levels      |
| Job retry logic       | ✅     | Configurable retry attempts       |
| Dead letter queue     | ✅     | Failed jobs captured              |
| Job cancellation      | ✅     | Cancel running jobs               |

### Job Types ✅

| Job Type              | Status | Notes                                                          |
| --------------------- | ------ | -------------------------------------------------------------- |
| CAD file conversion   | ✅     | STEP/IGES → STL/GLB via Python worker                          |
| Design clone/copy     | ✅     | Batch operation                                                |
| Work instruction jobs | ✅     | Change alert processing                                        |
| Notification jobs     | 🟡     | Infrastructure set up, need to complete service implementation |
| Import/export         | 🟡     | Bulk data operations                                           |

### Admin UI ✅

| Feature         | Status | Notes                       |
| --------------- | ------ | --------------------------- |
| Job list view   | ✅     | All jobs with status        |
| Job detail view | ✅     | Progress, logs, metadata    |
| Job cancel      | ✅     | Cancel pending/running jobs |
| Job retry       | ✅     | Retry failed jobs           |

---

## Testing Infrastructure

Quality assurance framework.

| Component               | Status | Notes                                   |
| ----------------------- | ------ | --------------------------------------- |
| Vitest setup            | ✅     | Fast unit test runner                   |
| Playwright setup        | ✅     | E2E browser testing                     |
| Test database helper    | ✅     | Isolated test transactions              |
| Test data builder       | ✅     | Fluent fixture creation                 |
| Test coverage reporting | ✅     | Vitest + Playwright coverage            |
| CI/CD integration       | ✅     | GitHub Actions workflows for unit & E2E |
| Page object model       | ✅     | Playwright POM pattern                  |

---

## Deployment & Operations

Production-ready infrastructure.

### Docker Support ✅

| Component               | Status | Notes                       |
| ----------------------- | ------ | --------------------------- |
| Multi-stage Dockerfile  | ✅     | Optimized production builds |
| Docker Compose (dev)    | ✅     | Local development setup     |
| Docker Compose (prod)   | ✅     | Production deployment       |
| PostgreSQL container    | ✅     | Database service            |
| RabbitMQ container      | ✅     | Message broker service      |
| Jobs worker container   | ✅     | Background processing       |
| CAD converter container | ✅     | Python pythonocc worker     |

### Deployment Topologies ✅

| Topology             | Status | Notes                     |
| -------------------- | ------ | ------------------------- |
| Single server        | ✅     | All-in-one deployment     |
| Distributed services | ✅     | Separate app, jobs, vault |
| Kubernetes           | 🟡     | Helm charts planned       |

### Configuration ✅

| Feature                 | Status | Notes                    |
| ----------------------- | ------ | ------------------------ |
| Environment variables   | ✅     | All config via env       |
| .env file support       | ✅     | Local development        |
| Health check endpoint   | ✅     | `/api/health`            |
| Secrets management docs | ✅     | Kubernetes secrets, etc. |

---

## Admin Features

System administration capabilities.

| Feature                 | Status | Notes                           |
| ----------------------- | ------ | ------------------------------- |
| User management         | ✅     | Create, edit, deactivate        |
| Role management         | ✅     | Define and assign roles         |
| Item type configuration | ✅     | Runtime field metadata          |
| Lifecycle configuration | ✅     | Define states and transitions   |
| Workflow configuration  | ✅     | Create workflow definitions     |
| Jobs dashboard          | ✅     | Monitor background jobs         |
| AI settings             | ✅     | Configure provider, model, keys |
| Vault configuration     | ✅     | View effective storage config   |
| System settings         | 🟡     | Basic settings storage          |

---

## AI Assistant

LLM-powered chatbot for navigating and querying PLM data.

### AI Chatbot ✅

| Feature             | Status | Notes                                           |
| ------------------- | ------ | ----------------------------------------------- |
| Chat panel UI       | ✅     | Slide-out panel with markdown rendering         |
| Session persistence | ✅     | Conversations saved to database                 |
| Read-only PLM tools | ✅     | Search parts, get item details, navigate system |
| Write tools         | ✅     | Create/update items with permission enforcement |
| Confirmation flow   | ✅     | User confirms write actions before execution    |
| Anthropic adapter   | ✅     | Claude integration via TanStack AI              |
| OpenAI adapter      | ✅     | GPT integration via TanStack AI                 |
| Admin settings      | ✅     | Configure AI provider and model                 |

---

## Collaborative Design Engine

AI-assisted product design workflow that generates requirements, BOMs, CAD, and assemblies from a natural language description.

### Design Stages ✅

| Stage                 | Status | Notes                                                              |
| --------------------- | ------ | ------------------------------------------------------------------ |
| Requirements drafting | ✅     | LLM analyzes description, proposes structured requirements         |
| Requirements review   | ✅     | User edits/approves proposed requirements                          |
| BOM drafting          | ✅     | LLM decomposes into hierarchical BOM, searches for reuse           |
| BOM review            | ✅     | User validates BOM structure and requirement coverage              |
| Materialization       | ✅     | Creates actual items, relationships, and ECO in PLM                |
| CAD generation        | 🟡     | Generates STEP files via Zoo Text-to-CAD API for Manufacture parts |
| CAD review            | 🟡     | 3D viewer for reviewing generated models                           |
| Assembly composition  | 🟡     | Bottom-up assembly via KCL code generation                         |
| Assembly review       | 🟡     | Final assembly validation                                          |

### BOM Drafting Tools ✅

| Tool                              | Notes                                         |
| --------------------------------- | --------------------------------------------- |
| `search_parts`                    | Search PLM for existing parts to reuse        |
| `get_existing_bom`                | Analyze BOM structure of existing assemblies  |
| `get_item_details`                | Fetch full item details                       |
| `propose_new_part`                | Propose new part with partType classification |
| `add_existing_to_bom`             | Add existing item to BOM at specified parent  |
| `set_bom_parent`                  | Reparent a BOM node                           |
| `link_requirement_to_part`        | Map requirements to parts                     |
| `set_part_interfaces`             | Define mechanical interfaces for assembly     |
| `set_assembly_interface_mappings` | Define how children connect in assemblies     |
| `ask_clarification`               | Request user input when ambiguous             |

### Infrastructure ✅

| Feature                 | Status | Notes                                                      |
| ----------------------- | ------ | ---------------------------------------------------------- |
| Session persistence     | ✅     | `design_sessions` table with JSONB artifacts               |
| SSE streaming           | ✅     | Real-time stage updates via server-sent events             |
| Activity feed           | ✅     | Live log of engine actions                                 |
| Requirements coverage   | ✅     | Matrix showing requirement-to-part mapping                 |
| Materialization preview | ✅     | Shows what will be created before committing               |
| Interface definitions   | ✅     | Mechanical interfaces (mounting holes, mating faces, etc.) |

---

## CAD Conversion Service

Python microservice for converting CAD files between formats.

| Feature                    | Status | Notes                                        |
| -------------------------- | ------ | -------------------------------------------- |
| STEP file reading          | ✅     | Via pythonocc-core                           |
| IGES file reading          | ✅     | Via pythonocc-core                           |
| STL output                 | ✅     | Binary and ASCII variants                    |
| GLB output                 | ✅     | Binary glTF with per-face color preservation |
| Color extraction from STEP | ✅     | XDE metadata via XCAFDoc_ColorTool           |
| RabbitMQ integration       | ✅     | Processes conversion jobs from queue         |
| Docker deployment          | ✅     | Conda-packed miniforge3 image                |

---

## Work Instructions

Rich step-by-step manufacturing instructions linked to parts and work orders.

### Authoring ✅

| Feature               | Status | Notes                                          |
| --------------------- | ------ | ---------------------------------------------- |
| Operations management | ✅     | Ordered operations within instructions         |
| Rich step content     | ✅     | Text, image, parametric, and data field blocks |
| Image blocks          | ✅     | Reference vault files for visual instructions  |
| Parametric blocks     | ✅     | Link to part attributes with fallback values   |
| Data field capture    | ✅     | Text, numeric, checkbox, pass/fail fields      |

### PLM Integration ✅

| Feature              | Status | Notes                                             |
| -------------------- | ------ | ------------------------------------------------- |
| Part attachments     | ✅     | Link work instructions to specific parts          |
| MBOM inheritance     | ✅     | Inherit instructions to child BOM items           |
| Change alerts        | ✅     | Notify when attached parts are modified/obsoleted |
| Alert acknowledgment | ✅     | Track pending, acknowledged, dismissed alerts     |

### Execution Tracking ✅

| Feature             | Status | Notes                                       |
| ------------------- | ------ | ------------------------------------------- |
| Execution recording | ✅     | Track executor, duration, current step      |
| Step data capture   | ✅     | Values and timestamps per step              |
| Work order linking  | ✅     | Associate executions with work orders       |
| Sign-off workflows  | ✅     | Pending Approval → Approved/Rejected states |

---

## UI/UX

Modern, responsive interface.

### Technology ✅

| Component  | Technology             |
| ---------- | ---------------------- |
| Framework  | TanStack Start (React) |
| Styling    | Tailwind CSS 4         |
| Components | Radix UI primitives    |
| Icons      | Lucide React           |
| Forms      | TanStack Form          |
| Tables     | TanStack Table         |
| Routing    | TanStack Router        |

### Features ✅

| Feature               | Status | Notes                              |
| --------------------- | ------ | ---------------------------------- |
| Responsive design     | ✅     | Desktop-first, mobile-friendly     |
| Dark mode             | 🟡     | Tailwind support, not fully styled |
| Accessible components | ✅     | Radix primitives                   |
| Form validation       | ✅     | Zod schemas                        |
| Loading states        | ✅     | Skeleton loaders                   |
| Error handling        | ✅     | Toast notifications                |
| Breadcrumb navigation | ✅     | Context-aware                      |
| Resizable sidebar     | ✅     | Drag to resize, collapsible        |
| AI chat panel         | ✅     | Slide-out assistant panel          |

---

## Documentation

User and developer documentation.

| Doc Type                | Status | Notes                          |
| ----------------------- | ------ | ------------------------------ |
| Architecture overview   | ✅     | System mental model            |
| Service patterns        | ✅     | Code organization              |
| Database patterns       | ✅     | Schema design                  |
| Git-style versioning    | ✅     | ECO-as-branch explained        |
| Adding item types       | ✅     | Extension guide                |
| User guides             | ✅     | Programs, designs, ECOs        |
| API reference           | ✅     | Per-domain docs in `docs/api/` |
| Deployment guides       | ✅     | Docker, Kubernetes             |
| Configuration reference | ✅     | Environment variables          |

---

## Planned Features (Not Yet Implemented)

### Near-Term

| Feature                     | Priority | Notes                                                     |
| --------------------------- | -------- | --------------------------------------------------------- |
| Flexible workflows          | High     | Ad-hoc workflow routing                                   |
| Issue tracking dedicated UI | High     | Unified CRUD exists; needs dedicated forms and list views |
| Increase test coverage      | Medium   | Target 70%+ line coverage                                 |
| Solid Edge connector        | Medium   | Easy early CAD target                                     |

### Medium-Term

| Feature                      | Priority | Notes                                   |
| ---------------------------- | -------- | --------------------------------------- |
| Full MBOM management         | Medium   | Complete manufacturing BOM UI/workflows |
| Digital Thread visualization | Medium   | Full traceability view                  |
| RAG implementation           | Medium   | Semantic search with pgvector           |
| STEP file viewing in browser | Medium   | Server-side conversion already exists   |

### Long-Term

| Feature                  | Priority | Notes                     |
| ------------------------ | -------- | ------------------------- |
| ERP integration webhooks | Low      | Event-driven sync         |
| Mobile app               | Low      | iOS/Android               |
| ITAR compliance tools    | Low      | Defense customer features |
| Azure AD SSO             | Low      | Enterprise identity       |
| Google OAuth             | Low      | Consumer identity         |

---

## Technical Stack Summary

| Layer                | Technology                                       |
| -------------------- | ------------------------------------------------ |
| **Frontend**         | TanStack Start (React), Tailwind CSS 4, Radix UI |
| **Backend**          | TypeScript, Node.js, Hono                        |
| **Database**         | PostgreSQL 18+, Drizzle ORM                      |
| **Auth**             | Oslo.js, Arctic (OAuth)                          |
| **Validation**       | Zod                                              |
| **AI Integration**   | TanStack AI with Anthropic and OpenAI adapters   |
| **CAD Conversion**   | Python, pythonocc-core (STEP/IGES → STL/GLB)     |
| **CAD Generation**   | Zoo Text-to-CAD API, KCL for assemblies          |
| **Testing**          | Vitest, Playwright                               |
| **Message Queue**    | RabbitMQ                                         |
| **File Storage**     | Local filesystem / S3-compatible                 |
| **Containerization** | Docker, Docker Compose                           |
| **CI/CD**            | GitHub Actions                                   |

---

_This document should be updated as features are added or modified._

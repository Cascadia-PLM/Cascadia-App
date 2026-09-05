# Cascadia PLM Feature List

> **Last Updated:** August 2026
> **Version:** 0.5.0 (Open-Source Edition)

This document tracks all implemented features in Cascadia PLM, organized by category. Use ✅ for complete, 🟡 for partial/in-progress, and ⬜ for planned.

---

## Core Item Types

Thirteen core PLM item types are implemented with full CRUD operations, registered
through `ItemTypeRegistry`. (Programs and designs are the organizational hierarchy
_above_ items, not item types — see [Program & Design Hierarchy](#program--design-hierarchy).)

| Item Type            | Status | Description                                                                                                                                                                |
| -------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Part**             | ✅     | Parts with materials, partType (Manufacture/Purchase/Phantom/Software), cost, lead times                                                                                   |
| **Document**         | ✅     | Version-controlled files with check-in/check-out                                                                                                                           |
| **Change Order**     | ✅     | ECO/ECN/MCO/Deviation workflows for change management                                                                                                                      |
| **Requirement**      | ✅     | Requirements tracking with acceptance criteria, priority, source. Coverage counts links: "verified" means a VERIFIED_BY edge to a test case exists, not that a test passed |
| **Task**             | ✅     | Work items with assignees, due dates, estimated/actual hours                                                                                                               |
| **Test Plan**        | ✅     | Verification planning: scope, environment, entry/exit criteria, grouped test cases                                                                                         |
| **Test Case**        | ✅     | Executable verification with recorded execution history (NotRun/Passed/Failed/Blocked)                                                                                     |
| **Work Instruction** | ✅     | Rich step-by-step manufacturing instructions with parametric data                                                                                                          |
| **Issue**            | ✅     | Defect/quality tracking with severity, category, root cause; dedicated list/detail UI and spreadsheet import                                                               |
| **Tool**             | ✅     | Manufacturing/quality/utility equipment as non-versioned records (the Tool pattern)                                                                                        |
| **Software**         | ✅     | Firmware/software configuration items with a content-addressed source store — see [Software Management](#software-management)                                              |
| **Work Order**       | ✅     | Manufacturing execution: traveler, material consumption, qualification — see [Physical Traceability](#physical-traceability)                                               |
| **Physical Part**    | ✅     | Serialized units and identified lots of a Part — see [Physical Traceability](#physical-traceability)                                                                       |

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
| Conflict review                  | ✅     | Warning-level conflicts can be acknowledged as reviewed, with audit  |
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

| Feature                | Status | Notes                                              |
| ---------------------- | ------ | -------------------------------------------------- |
| Where-used impact tree | ✅     | Recursive BOM traversal up to configurable depth   |
| Cross-design impact    | ✅     | Detects items referenced from other designs        |
| Definition-usage chain | ✅     | Follows reusable part definition/instance links    |
| Deduplication          | ✅     | Affected item list without duplicates              |
| Impact assessment API  | ✅     | `POST /api/v1/change-orders/:id/impact-assessment` |

### Branch Operations ✅

| Operation            | Status | Notes                              |
| -------------------- | ------ | ---------------------------------- |
| Create branch        | ✅     | ECO branches created automatically |
| List branches        | ✅     | View all branches per design       |
| Branch status        | ✅     | Ahead/behind commit counts         |
| View branch items    | ✅     | Items modified on branch           |
| Merge to main        | ✅     | On ECO release                     |
| Branch history/graph | ✅     | Visual commit history              |

### Workspaces ✅

Personal sandbox branches for exploratory work that has not yet earned an ECO.

| Feature              | Status | Notes                                                        |
| -------------------- | ------ | ------------------------------------------------------------ |
| Create workspace     | ✅     | Per-user branch on any design the user can access            |
| Workspace item edits | ✅     | Same checkout/edit flow as an ECO branch, isolated from main |
| Convert to ECO       | ✅     | Promote the workspace into a new change order                |
| Merge into ECO       | ✅     | Fold workspace changes into an existing change order         |
| Workspace UI         | ✅     | Context banner, items panel, create/convert/merge dialogs    |

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
| GitHub OAuth login   | ✅     | Arctic; only implemented provider          |
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

| Feature              | Status | Notes                                                            |
| -------------------- | ------ | ---------------------------------------------------------------- |
| BOM tree view        | ✅     | Hierarchical grid tree-table                                     |
| Relationship graph   | ✅     | React Flow visualization                                         |
| Design history graph | ✅     | Branch/commit timeline                                           |
| Affected items tree  | ✅     | ECO impact visualization                                         |
| Digital thread view  | ✅     | Swim-lane navigator across five domains, with cross-context diff |
| 3D CAD viewer        | ✅     | STL/OBJ/GLB rendering on part, design and program pages          |

### 3D Viewer Features ✅

| Feature                           | Status |
| --------------------------------- | ------ |
| STL file support                  | ✅     |
| OBJ file support                  | ✅     |
| GLB (binary glTF) support         | ✅     |
| Per-face/solid colors             | ✅     |
| Orbit controls                    | ✅     |
| Auto-fit camera                   | ✅     |
| Wireframe mode                    | ✅     |
| Model statistics                  | ✅     |
| Reset view                        | ✅     |
| Part, design and program surfaces | ✅     |

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

| Endpoint                    | Status | Notes                                  |
| --------------------------- | ------ | -------------------------------------- |
| `POST /api/v1/import/parts` | ✅     | Bulk part creation + BOM relationships |
| Branch-aware import         | ✅     | Import to ECO branch or main           |

---

## SysML v2 API

Standards-based interoperability layer.

| Feature                                             | Status | Notes                          |
| --------------------------------------------------- | ------ | ------------------------------ |
| `/api/v1/sysml/projects`                            | ✅     | List designs as SysML projects |
| `/api/v1/sysml/projects/:id`                        | ✅     | Get single project             |
| `/api/v1/sysml/projects/:id/commits`                | ✅     | Commit history                 |
| `/api/v1/sysml/projects/:id/branches/:bid/elements` | ✅     | Elements on branch             |
| `/api/v1/sysml/projects/:id/commits/:cid/elements`  | ✅     | Elements at commit             |
| SysML element serialization                         | ✅     | Convert items to SysML format  |
| SysML relationship mapping                          | ✅     | BOM, Satisfy, Verify, etc.     |

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

| Endpoint Category  | Status | Notes                                           |
| ------------------ | ------ | ----------------------------------------------- |
| Items CRUD         | ✅     | All item types                                  |
| Relationships      | ✅     | Create, update, delete                          |
| Files              | ✅     | Upload, download, check-in/out                  |
| Workflows          | ✅     | Transitions, history                            |
| Change Orders      | ✅     | Full ECO lifecycle + impact assessment          |
| Users & Roles      | ✅     | Administration                                  |
| Reports            | ✅     | Execute and export                              |
| Search             | ✅     | Enterprise search                               |
| Work Instructions  | ✅     | Template CRUD, usage, change alerts             |
| Requirements & V&V | ✅     | Derive, satisfy, verify, coverage, gap analysis |
| Test Plans & Cases | ✅     | Plan membership, execution recording            |
| Digital Thread     | ✅     | Thread graph, cross-context comparison          |
| Workspaces         | ✅     | CRUD, convert-to-ECO, merge-to-ECO              |
| Physical Parts     | ✅     | Register, genealogy, recall, as-built           |
| Work Orders        | ✅     | Traveler, materials, qualification              |
| Software           | ✅     | Source tree, diff, draft commit                 |
| MBOM               | ✅     | EBOM-to-MBOM creation and tracking              |
| Manufacturer Parts | ✅     | AML bound to the part master                    |
| Dashboard          | ✅     | Cross-program stats and charts                  |
| AI Chat            | ✅     | Conversations with tool use                     |

### Batch Operations ✅

| Operation                 | Status | Notes                         |
| ------------------------- | ------ | ----------------------------- |
| Batch item create         | ✅     | Create multiple items         |
| Batch relationship create | ✅     | Create multiple relationships |

### CAD Integration

Native CAD connectors are planned commercial-edition features (see
[LICENSING.md](./LICENSING.md)). No connector code lives in this repository —
CAD files reach Cascadia through the file vault today.

| Integration          | Status | Notes                                                                              |
| -------------------- | ------ | ---------------------------------------------------------------------------------- |
| Solid Edge connector | ⬜     | Planned, commercial edition. Phase 1 scope: Part/BOM push, no file transfer or PDM |
| SolidWorks connector | ⬜     | Planned, commercial edition                                                        |

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

| Component               | Status | Notes                                                                      |
| ----------------------- | ------ | -------------------------------------------------------------------------- |
| Vitest setup            | ✅     | Fast unit test runner                                                      |
| Playwright setup        | ✅     | E2E browser testing                                                        |
| Test database helper    | ✅     | Isolated test transactions                                                 |
| Test data builder       | ✅     | Fluent fixture creation                                                    |
| Test coverage reporting | ✅     | Coverage is reported (`npm run test:coverage`); no thresholds are enforced |
| CI/CD integration       | ✅     | GitHub Actions workflows for unit & E2E                                    |
| Page object model       | ✅     | Playwright POM pattern                                                     |

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
| Health check endpoint   | ✅     | `/api/v1/health`         |
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

| Feature             | Status | Notes                                                                                                                      |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------- |
| Chat panel UI       | ✅     | Slide-out panel with markdown rendering                                                                                    |
| Session persistence | ✅     | Conversations saved to database                                                                                            |
| Read-only PLM tools | ✅     | Search parts, get item details, navigate system                                                                            |
| Write tools         | ✅     | Create/update items with permission enforcement                                                                            |
| Confirmation flow   | ✅     | User confirms write actions before execution                                                                               |
| Anthropic adapter   | ✅     | Claude integration via TanStack AI                                                                                         |
| OpenAI adapter      | ✅     | GPT integration via TanStack AI                                                                                            |
| Admin settings      | ✅     | Configure AI provider and model                                                                                            |
| Auto-fill new items | ✅     | Drop or paste a link, photo, nameplate or spec sheet on a new Part or Tool; fills fields, attributes and tool capabilities |

### MCP Servers ✅

| Feature                     | Status | Notes                                                                                        |
| --------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| PLM server (`cascadia-plm`) | ✅     | Chatbot tool registry over Streamable HTTP at `/api/mcp`                                     |
| API-key auth + scoping      | ✅     | Bearer `csc_` keys; key scope intersects role permissions                                    |
| Dev server (`cascadia-dev`) | ✅     | Stdio server for self-hosters: status, docs, db push/seed/reset                              |
| Shared tool registry        | ✅     | One tool stack for the in-app chatbot and MCP (`packages/core/src/lib/ai/tools/registry.ts`) |
| API key management UI       | ✅     | Self-service (profile) and admin issuance: scope editor, activity log, policy                |

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

## Physical Traceability

Identity and genealogy for real material — which unit was built from which lot,
and what evidence says it met its requirements. Deliberately stops short of
quantity and value: no inventory balances, no costing.

### Physical Parts ✅

| Feature              | Status | Notes                                                                         |
| -------------------- | ------ | ----------------------------------------------------------------------------- |
| PhysicalPart item    | ✅     | A physical instance of a Part: a serialized **unit** or an identified **lot** |
| Non-versioned        | ✅     | Tool pattern — instances are records of reality, not revisions                |
| Dual identity        | ✅     | `PP-000001` as a stable handle; serial or lot number as the display identity  |
| Registration         | ✅     | `POST /api/v1/physical-parts/register`                                        |
| Part `trackingMode`  | ✅     | `none`, `lot`, or `serial` — the policy deciding whether instances exist      |
| Document attachments | ✅     | Material certs, test reports, CoCs held in the vault against the instance     |

### Genealogy ✅

| Feature               | Status | Notes                                                                |
| --------------------- | ------ | -------------------------------------------------------------------- |
| Consumption edges     | ✅     | `Consumes` relationships, quantity pinned to the consumed revision   |
| Production edges      | ✅     | `Produces` relationships from work order to built instance           |
| Derived, never stored | ✅     | Walked on demand, so it cannot drift from the records it summarizes  |
| Forward traversal     | ✅     | `GET /api/v1/physical-parts/:id/genealogy`                           |
| Reverse traversal     | ✅     | `GET /api/v1/physical-parts/recall` — what shipped with this lot?    |
| As-built comparison   | ✅     | `GET /api/v1/physical-parts/:id/as-built-comparison` against the BOM |

### Work Orders & Qualification ✅

| Feature                   | Status | Notes                                                                      |
| ------------------------- | ------ | -------------------------------------------------------------------------- |
| Work Order item type      | ✅     | Holds vault attachments and participates in `item_relationships`           |
| Evidence edges            | ✅     | `Evidences` relationships tie a document to a requirement for an instance  |
| Qualification rollup      | ✅     | `GET /api/v1/work-orders/:id/qualification` — were these requirements met? |
| Uncertified-material gaps | ✅     | Consumed instances carrying neither evidence nor documents are listed      |

### Approved Manufacturer List ✅

| Feature                  | Status | Notes                                                        |
| ------------------------ | ------ | ------------------------------------------------------------ |
| Manufacturer parts       | ✅     | `manufacturer_parts` with manufacturer name and part number  |
| Bound to the part master | ✅     | Survives revisions — the AML is not re-approved per revision |

---

## Software Management

Firmware and software configuration items versioned alongside the hardware they
ship with, ECO-controlled like any other engineering item.

### Software Items ✅

| Feature            | Status | Notes                                                                 |
| ------------------ | ------ | --------------------------------------------------------------------- |
| Software item type | ✅     | `softwareType`: firmware, application, library, configuration, fpga   |
| Target & toolchain | ✅     | Target hardware and build toolchain recorded on the item              |
| Part lifecycle     | ✅     | Shares the Part lifecycle, so it is ECO-controlled and gets revisions |
| Build artifacts    | ✅     | Compiled output attached in the vault                                 |

### Source Store ✅

| Feature                     | Status | Notes                                                          |
| --------------------------- | ------ | -------------------------------------------------------------- |
| Content-addressed blobs     | ✅     | `software_blobs` keyed by content hash, shared across versions |
| Immutable manifests         | ✅     | `software_manifests` — a manifest is never edited in place     |
| Manifest pointer on version | ✅     | Branch isolation and time travel work with no special cases    |
| Source browsing             | ✅     | `GET /api/v1/software/:id/tree` and `/:id/file`                |
| Blob retrieval              | ✅     | `GET /api/v1/software/:id/blob/:hash`                          |
| Version history             | ✅     | `GET /api/v1/software/:id/versions`                            |
| Diff between versions       | ✅     | `GET /api/v1/software/:id/diff`                                |

### Checkout-Gated Editing ✅

| Feature                     | Status | Notes                                                               |
| --------------------------- | ------ | ------------------------------------------------------------------- |
| Draft manifest              | ✅     | Edits accumulate in `draftManifestId`, invisible to other branches  |
| Explicit commit             | ✅     | `POST /api/v1/software/:id/commit` promotes the draft               |
| Discard draft               | ✅     | `POST /api/v1/software/:id/draft/discard`                           |
| Per-file field history      | ✅     | Commit records `source`-category field changes per file             |
| Drafts never propagate      | ✅     | Not copied to new versions; never appear in field history           |
| Per-file conflict detection | ✅     | Conflicts sharpen from "the manifest changed" to the diverged files |

---

## Requirements & Verification

Requirements engineering and V&V backbone: requirement hierarchies, satisfaction
and verification links as first-class relationships, test execution records, and
design-level rollups. Links are structural — see the coverage caveat on the
Requirement item type.

### Requirement Relationships ✅

| Feature              | Status | Notes                                                                  |
| -------------------- | ------ | ---------------------------------------------------------------------- |
| Derived requirements | ✅     | `DERIVES_FROM` child→parent hierarchy, `POST /requirements/:id/derive` |
| Satisfaction links   | ✅     | `SATISFIES` edges from parts/documents to requirements                 |
| Allocation links     | ✅     | `ALLOCATED_TO` edges from requirements to parts                        |
| Verification links   | ✅     | `VERIFIED_BY` edges from test cases to requirements                    |
| Validation links     | ✅     | `VALIDATES` edges from test cases to parts                             |
| Satisfied-by lookup  | ✅     | `GET /items/:id/satisfied-requirements` — reverse view from an item    |

### Test Management ✅

| Feature             | Status | Notes                                                              |
| ------------------- | ------ | ------------------------------------------------------------------ |
| Test plans          | ✅     | Scope, environment, entry/exit criteria; group test cases          |
| Test case execution | ✅     | `POST /test-cases/:id/execute` records executor, status, timestamp |
| Execution history   | ✅     | Full run history per test case; latest status shown on the item    |
| Execution statuses  | ✅     | NotRun / Passed / Failed / Blocked                                 |

### Design-Level Rollups ✅

| Feature               | Status | Notes                                                                                                                                                                                           |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requirements coverage | ✅     | `GET /designs/:id/requirements-coverage` — link-based matrix                                                                                                                                    |
| Test coverage         | ✅     | `GET /designs/:id/test-coverage`                                                                                                                                                                |
| Verification gaps     | ✅     | `GET /designs/:id/verification-gaps`                                                                                                                                                            |
| Gap analysis          | ✅     | Seven gap types (unallocated/unsatisfied/unverified requirements, untested parts, unmapped EBOM, orphan MBOM, missing documentation) with severity, per-domain counts, and a completeness score |
| Gap analysis UI       | ✅     | Summary cards, filterable results table, analysis dialog                                                                                                                                        |

---

## Digital Thread

Cross-domain traceability graph connecting an item to everything it touches,
walked on demand from real relationships — never stored as a parallel structure.

| Feature             | Status | Notes                                                                                                                   |
| ------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| Thread graph API    | ✅     | `GET /thread/:itemId` — the full graph for an item                                                                      |
| Five domains        | ✅     | Requirements, engineering, manufacturing, validation, physical                                                          |
| Synthetic edges     | ✅     | `INSTANCE_OF` (physical part → part lineage) and `BUILDS` (work order → version) derived from columns, not stored edges |
| Swim-lane navigator | ✅     | Interactive thread view, one lane per domain                                                                            |
| Thread comparison   | ✅     | `POST /thread/:itemId/compare` — diff the thread at two version contexts (branch/commit/tag) with field-level diffs     |
| Comparison targets  | ✅     | Valid contexts enumerated per item                                                                                      |
| Thread cache        | ✅     | Server-side cache with admin warm/clear/stats/cleanup endpoints                                                         |

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

### Traveler & Execution Tracking ✅

| Feature              | Status | Notes                                                          |
| -------------------- | ------ | -------------------------------------------------------------- |
| Traveler (instances) | ✅     | Work orders instantiate templates as frozen snapshots          |
| Populate from BOM    | ✅     | Auto-build traveler from part attachments, deepest-first       |
| Execution recording  | ✅     | Runs per traveler line: executor, duration, unit label         |
| Step data capture    | ✅     | Values and timestamps per snapshot block                       |
| Required-run counts  | ✅     | Per-batch or per-unit lines; derived line status               |
| Completion gate      | ✅     | Orders complete only when lines are done or skipped (audited)  |
| Sign-off workflows   | ✅     | Pending Approval → Approved/Rejected states, executor resubmit |

---

## UI/UX

Modern, responsive interface.

### Technology ✅

| Component  | Technology                         |
| ---------- | ---------------------------------- |
| Framework  | Vite SPA + TanStack Router (React) |
| Styling    | Tailwind CSS 4                     |
| Components | Radix UI primitives                |
| Icons      | Lucide React                       |
| Forms      | TanStack Form                      |
| Tables     | TanStack Table                     |
| Routing    | TanStack Router                    |

### Features ✅

| Feature               | Status | Notes                                                       |
| --------------------- | ------ | ----------------------------------------------------------- |
| Responsive design     | ✅     | Desktop-first, mobile-friendly                              |
| Dark mode             | 🟡     | Tailwind support, not fully styled                          |
| Accessible components | ✅     | Radix primitives                                            |
| Form validation       | ✅     | Zod schemas                                                 |
| Loading states        | ✅     | Skeleton loaders                                            |
| Error handling        | ✅     | Toast notifications                                         |
| Breadcrumb navigation | ✅     | Context-aware                                               |
| Resizable sidebar     | ✅     | Drag to resize, collapsible                                 |
| AI chat panel         | ✅     | Slide-out assistant panel                                   |
| Home dashboard        | ✅     | Cross-program stats and activity charts on the landing page |
| Guided tour           | ✅     | In-app product tour                                         |

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

| Feature              | Priority | Notes                                     |
| -------------------- | -------- | ----------------------------------------- |
| Flexible workflows   | High     | Ad-hoc workflow routing                   |
| Solid Edge connector | Medium   | Easy early CAD target; commercial edition |
| SolidWorks connector | Medium   | Follows Solid Edge; commercial edition    |

### Medium-Term

| Feature                      | Priority | Notes                                   |
| ---------------------------- | -------- | --------------------------------------- |
| Full MBOM management         | Medium   | Complete manufacturing BOM UI/workflows |
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

| Layer                | Technology                                                   |
| -------------------- | ------------------------------------------------------------ |
| **Frontend**         | Vite SPA + TanStack Router (React), Tailwind CSS 4, Radix UI |
| **Backend**          | TypeScript, Node.js, Hono                                    |
| **Database**         | PostgreSQL 18+, Drizzle ORM                                  |
| **Auth**             | Oslo.js, Arctic (OAuth)                                      |
| **Validation**       | Zod                                                          |
| **AI Integration**   | TanStack AI with Anthropic and OpenAI adapters               |
| **CAD Conversion**   | Python, pythonocc-core (STEP/IGES → STL/GLB)                 |
| **Testing**          | Vitest, Playwright                                           |
| **Message Queue**    | RabbitMQ                                                     |
| **File Storage**     | Local filesystem / S3-compatible                             |
| **Containerization** | Docker, Docker Compose                                       |
| **CI/CD**            | GitHub Actions                                               |

---

_This document should be updated as features are added or modified._

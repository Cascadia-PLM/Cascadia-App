# System Architecture Overview

This document describes the high-level architecture of Cascadia PLM, the design principles that guide it, and how the codebase is organized.

---

## High-Level System Diagram

```
                         ┌──────────────────────────────────┐
                         │           Web Browser             │
                         │  Vite SPA (React + TanStack       │
                         │  Router/Query/Form)                │
                         └──────────────┬───────────────────┘
                                        │ HTTPS
                         ┌──────────────▼───────────────────┐
                         │       Hono API Server             │
                         │  (Node.js, TypeScript)             │
                         │                                   │
                         │  ┌─────────┐   ┌──────────────┐  │
                         │  │ Static  │   │  API Routes   │  │
                         │  │ Assets  │   │ /api/**       │  │
                         │  └─────────┘   └──────┬───────┘  │
                         │                       │          │
                         │        ┌──────────────▼───────┐  │
                         │        │    Service Layer      │  │
                         │        │ ItemService, Branch,  │  │
                         │        │ Checkout, Commit, etc │  │
                         │        └──────────┬───────────┘  │
                         │                   │              │
                         │        ┌──────────▼───────────┐  │
                         │        │   Drizzle ORM        │  │
                         │        └──────────┬───────────┘  │
                         └───────────────────┼──────────────┘
                                             │
                    ┌────────────────────────┼──────────────────────┐
                    │                        │                      │
         ┌──────────▼──────────┐  ┌──────────▼──────────┐  ┌───────▼───────┐
         │   PostgreSQL 18+    │  │   File Vault         │  │   RabbitMQ    │
         │                     │  │   (Local FS / S3)    │  │               │
         │ Items, Designs,     │  │   CAD files, PDFs,   │  │  Job queues   │
         │ Branches, Commits,  │  │   thumbnails         │  │               │
         │ Users, Workflows    │  │                      │  │               │
         └─────────────────────┘  └──────────────────────┘  └───────┬───────┘
                                                                    │
                                                       ┌────────────▼────────────┐
                                                       │   Background Workers    │
                                                       │                         │
                                                       │  ┌──────────────────┐   │
                                                       │  │ Jobs Worker (TS) │   │
                                                       │  └──────────────────┘   │
                                                       │  ┌──────────────────┐   │
                                                       │  │ CAD Converter    │   │
                                                       │  │ (Python/OCC)    │   │
                                                       │  └──────────────────┘   │
                                                       └─────────────────────────┘
```

---

## Technology Stack

| Layer              | Technology                               | Purpose                                                            |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------ |
| **Framework**      | Hono + Vite SPA (TanStack Router)        | Hono API server + Vite SPA with TanStack Router and TanStack Query |
| **UI**             | React 19, Tailwind CSS 4, Radix UI       | Component-based UI with accessible primitives                      |
| **Forms**          | TanStack Form + Zod v4                   | Type-safe form handling with schema validation                     |
| **Tables**         | TanStack Table                           | Sortable, filterable data grids                                    |
| **Database**       | PostgreSQL 18+                           | Enterprise-grade relational storage                                |
| **ORM**            | Drizzle ORM                              | Type-safe SQL queries with schema-driven migrations                |
| **Auth**           | @oslojs/crypto, @oslojs/encoding, Arctic | Session tokens (SHA-256 hashed), Argon2id passwords, OAuth         |
| **Graph Viz**      | React Flow (@xyflow/react) + Dagre       | BOM and workflow graph visualization                               |
| **AI**             | TanStack AI + Anthropic/OpenAI adapters  | AI chatbot and collaborative design engine                         |
| **3D Viewer**      | React Three Fiber + Three.js             | In-browser CAD model viewing (STL, OBJ, GLB)                       |
| **CAD Conversion** | Python + pythonocc-core                  | STEP/IGES to STL/GLB conversion with color preservation            |
| **Message Queue**  | RabbitMQ (amqplib)                       | Async job processing for CAD conversion, notifications             |
| **Logging**        | Pino + pino-pretty                       | Structured JSON logging                                            |
| **Testing**        | Vitest + Playwright                      | Unit/integration tests and E2E browser tests                       |

---

## Code-First Philosophy

Traditional PLM systems (Aras Innovator, Windchill, Teamcenter) rely on UI-based configuration: administrators click through wizards to define item types, workflows, and permissions. This approach creates several problems:

1. **No version control** -- configuration changes are not tracked in Git
2. **No code review** -- workflow changes bypass pull requests
3. **Fragile customization** -- UI-configured logic is hard to test or refactor
4. **Vendor lock-in** -- configuration formats are proprietary

Cascadia takes the opposite approach:

- **Item types are TypeScript interfaces** registered via `ItemTypeRegistry`. Adding a field means adding a Drizzle column and a Zod property.
- **Workflows are code-defined state machines** stored in `workflow_definitions` with transitions validated by `WorkflowService`.
- **Permissions are declared in code** (`ROLE_DEFINITIONS` in `src/lib/auth/permissions.ts`) and enforced via `apiHandler()`.
- **All customization lives in the Git repository**, reviewed through PRs, tested with Vitest/Playwright.

A two-tier configuration pattern allows runtime overrides from the database (labels, icons, lifecycle assignment) while keeping schemas, validation, and components strictly in code. See [two-table-pattern.md](./two-table-pattern.md) for details.

---

## Key Architectural Decisions

### 1. ECO-as-Branch

The signature feature. Engineering Change Orders get isolated database branches (modeled after Git), so parallel teams can work without stepping on each other. Changes are invisible until the ECO is approved and merged. See [eco-as-branch.md](./eco-as-branch.md).

### 2. Two-Table Pattern for Items

Every item (Part, Document, ChangeOrder, Requirement, etc.) has a row in the shared `items` table for common fields, plus a row in a type-specific table (`parts`, `documents`, etc.) for specialized fields. This gives unified querying across all types while preserving type-specific constraints. See [two-table-pattern.md](./two-table-pattern.md).

### 3. Immutable Version History

Each edit creates a new `items` row with a new `id` but the same `masterId`. The previous version is never mutated. Combined with `commits` and `itemVersions` tables, this gives full audit history with field-level change tracking.

### 4. Service Layer with Strict Layering

Three layers -- Orchestrators, Domain Logic, Utilities -- with a strict downward-only dependency rule. No circular imports. See [service-layer.md](./service-layer.md).

### 5. apiHandler() for All Routes

Every API route is wrapped in `apiHandler()` which provides authentication, permission checks, CSRF validation, CORS headers, security headers, error handling, and response serialization in one place. Routes just throw errors; the handler catches them.

### 6. Organizational Hierarchy

```
Organization
  └── Program (permission boundary)
        └── Design (version container)
              ├── main branch
              ├── eco/ECO-001 branch
              └── Items (Parts, Documents, Requirements, ...)
```

Programs are the permission boundary. Users are program members. Designs belong to programs. Global libraries (no program) are accessible to all authenticated users.

---

## Project Structure

### `src/components/`

React UI components, organized by domain.

```
components/
├── ui/                  # Base primitives: Button, Card, DataGrid, Dialog, Badge, etc.
│                        # Uses Radix UI + Tailwind. Import via @/components/ui/
├── ai/                  # AI chatbot panel and message rendering
├── design-engine/       # Collaborative design workspace (stages, artifacts, BOM tools)
├── work-instructions/   # Work instruction authoring and execution
├── designs/             # Design management (AddPartToDesignDialog, DesignBranchSelector)
├── versioning/          # Version comparison, commit history, diff views
└── forms/               # Item-type-specific form components (PartForm, DocumentForm, etc.)
```

### `src/lib/`

All business logic, organized by concern.

```
lib/
├── api/                 # apiHandler(), parseQuery(), response builders
├── auth/                # AuthService, SessionManager, PermissionService, AccessControlService
├── db/                  # Drizzle schema definitions, database connection, filters
│   └── schema/          # Table definitions: items.ts, versioning.ts, designs.ts, users.ts
├── items/               # Item type system
│   ├── registry.ts      # ItemTypeRegistry (central type registration)
│   ├── types/           # Zod schemas + TypeScript interfaces per item type
│   ├── services/        # ItemService, ChangeOrderService, ItemSearchService
│   └── numbering/       # Auto-numbering (P-001, ECO-001, etc.)
├── services/            # Core domain services
│   ├── BranchService.ts
│   ├── CommitService.ts
│   ├── CheckoutService.ts
│   ├── VersionResolver.ts
│   ├── ChangeOrderMergeService.ts
│   ├── ConflictDetectionService.ts
│   ├── DesignService.ts
│   ├── LifecycleService.ts
│   └── ...
├── workflows/           # Workflow engine (state machines, transitions)
├── vault/               # File storage (local FS or S3, upload/download/versioning)
├── jobs/                # Background job system (RabbitMQ producer/consumer)
├── errors/              # Typed error hierarchy (AppError, NotFoundError, ValidationError, ...)
├── ai/                  # AI chatbot tools, adapters, session service
├── design-engine/       # Collaborative design engine (stages, tools, materialization)
├── cad-generation/      # CAD generation pipeline (Zoo API, KCL)
└── sysml/               # SysML v2 serialization
```

### `src/server/`

Hono API server. Route modules live in `src/server/routes/` (one file per domain), mounted in `src/server/index.ts`.

```
server/
├── index.ts             # App creation, route mounting
├── adapter.ts           # adapt() bridge from Hono Context to apiHandler()
├── dev.ts               # Development server entry point
├── prod.ts              # Production server entry point
└── routes/
    ├── auth.ts          # Login, logout, session, OAuth callbacks
    ├── parts.ts         # Part CRUD
    ├── documents.ts     # Document CRUD
    ├── change-orders.ts # ECO operations + workflow transitions
    ├── designs.ts       # Design management + item operations
    ├── branches.ts      # Branch operations
    └── ...
```

### `src/routes/`

TanStack Router file-based routes for the Vite SPA frontend.

```
routes/
├── parts/               # UI routes for parts (list, detail)
├── designs/             # UI routes for designs (collaborative workspace)
├── admin/               # Admin UI (users, roles, system settings)
└── ...
```

### `workers/`

External worker processes that run in separate containers.

```
workers/
├── node/                # Node.js job worker Dockerfile
├── cad-converter/       # Python worker using pythonocc-core
│   └── src/             # STEP/IGES -> STL/GLB conversion with color preservation
└── cad-generator/       # Python worker: Parametric CAD (CadQuery)
```

### `scripts/`

Database seeding, deployment, and utility scripts.

```
scripts/
├── seed-minimal.ts          # Admin user, roles, standard library, lifecycles
├── seed-catalog.ts          # Generic component catalog (fasteners, raw stock)
├── truncate-all.ts          # Database reset
└── deploy/                  # Cloud deployment helpers
```

---

## Request Lifecycle

A typical API request flows through these stages:

```
Browser Request
    │
    ▼
Hono Router (route module matching)
    │
    ▼
apiHandler() wrapper
    ├── CORS preflight handling (OPTIONS)
    ├── CSRF validation (Origin/Referer check)
    ├── Authentication (session cookie → SessionManager.validateSession)
    ├── Permission check (PermissionService.canUser)
    │
    ▼
Route Handler Function
    ├── Parse/validate input (Zod schemas)
    ├── Call service layer
    ├── Return object → auto-wrapped as { data: ... }
    │   OR
    ├── Return Response → passed through (streaming, custom status)
    │   OR
    └── Throw error → caught by handleApiError()
                        ├── AppError → typed JSON error response
                        ├── ZodError → validation error response
                        ├── PostgreSQL error → mapped to AppError
                        └── Unknown → 500 Internal Server Error
    │
    ▼
Security Headers Applied (X-Content-Type-Options, X-Frame-Options, etc.)
    │
    ▼
Response to Browser
```

---

## Related Documentation

- [Two-Table Pattern](./two-table-pattern.md) -- item type architecture
- [ECO-as-Branch](./eco-as-branch.md) -- change management model
- [Service Layer](./service-layer.md) -- service patterns and dependencies
- [Security](./security.md) -- authentication, authorization, and hardening

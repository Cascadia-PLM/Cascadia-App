# Cascadia PLM System

> A code-first Product Lifecycle Management (PLM) system built with Hono + Vite SPA

Cascadia is a modern PLM system designed to replace traditional low-code PLM platforms like Aras Innovator. It prioritizes developer experience, type safety, and customization through code rather than UI-based configuration.

**Signature Feature**: ECO-as-Branch - Each Engineering Change Order gets its own isolated branch for parallel development, with Git-style versioning for all engineering data.

## Features

### Core Capabilities

- **Parts Management** - Manage parts with revisions, materials, costs, and lead times
- **Document Management** - Version-controlled documents with file vault storage
- **Change Management** - ECO/ECN workflows with branch-based isolation
- **Requirements Management** - Track and trace requirements across designs
- **BOM Management** - Multi-level bill of materials with where-used queries
- **Workflow Engine** - Configurable approval workflows with lifecycle states
- **Enterprise Search** - Full-text search across all item types
- **3D CAD Viewer** - STL/OBJ rendering in browser with orbit controls
- **Reporting Engine** - Configurable reports with CSV export

### Technical Highlights

- **Code-First Configuration** - All customization in TypeScript, version controlled
- **Git-Style Versioning** - Branches, commits, and tags for engineering data
- **ECO-as-Branch** - Change orders create isolated branches, merged on release
- **Type-Safe** - Full TypeScript throughout the stack with Zod validation
- **Enterprise-Ready** - PostgreSQL, ACID compliance, audit trails
- **Background Jobs** - RabbitMQ-powered async processing
- **Modern Auth** - Session-based with OAuth support (Azure AD, Google, GitHub)
- **SysML v2 Compatible** - Native support for SysML 2.0 with API endpoints
- **Flexible Storage** - Local filesystem or S3-compatible object storage
- **Batch Operations** - Bulk create items and relationships via API

## Technology Stack

- **Backend**: [Hono](https://hono.dev/) - Lightweight TypeScript API server
- **Frontend**: [Vite](https://vite.dev/) SPA + [TanStack Router](https://tanstack.com/router) + [TanStack Query](https://tanstack.com/query)
- **Database**: PostgreSQL 18+ with [Drizzle ORM](https://orm.drizzle.team)
- **UI**: Tailwind CSS 4 + [Radix UI](https://www.radix-ui.com/)
- **Auth**: Oslo.js crypto + [Arctic](https://arcticjs.dev/) for OAuth
- **Validation**: [TanStack Form](https://tanstack.com/form) + [Zod](https://zod.dev/)
- **Graph Visualization**: [React Flow](https://reactflow.dev/) + Dagre for BOM and commit graphs
- **3D Viewer**: Three.js for STL/OBJ CAD file preview
- **Message Queue**: RabbitMQ for background jobs
- **Testing**: Vitest + Playwright
- **Containerization**: Docker, Docker Compose

## Try the Demo

The fastest way to see Cascadia is the bundled demo stack — Postgres, RabbitMQ, the app (with embedded vault), the CAD converter, and the jobs worker, pre-seeded with a real engineering dataset (TDJ-25 6-DOF robot arm: ~88 parts, 101 BOM relationships, 79 colored GLBs + STEPs). No clone required:

```bash
curl -O https://raw.githubusercontent.com/Cascadia-PLM/Cascadia-App/main/docker-compose.demo.yml
docker compose -f docker-compose.demo.yml up -d
```

First run pulls ~1.2 GB of pre-built images from GitHub Container Registry (2-5 min on a typical connection) and seeds the database. When `docker compose -f docker-compose.demo.yml logs app` shows the server is listening, open <http://localhost:3000> and log in with `admin@cascadia.local` / `Cascadia`. Navigate to **Programs → ROBOT-ARM → TDJ-25** to explore the BOM tree, click any part with CAD to see the 3D viewer, and check the ECO **Initial Release - TDJ-25 Robot Arm** to see the signature ECO-as-Branch workflow in its released state.

Reset to a clean slate at any time:

```bash
docker compose -f docker-compose.demo.yml down -v
```

The demo's volumes are namespaced (`cascadia_demo_*`) and won't touch any local dev data.

Working from a clone instead? Use [`docker-compose.demo-with-build.yml`](./docker-compose.demo-with-build.yml) to build images from your working tree.

## Quick Start

### Prerequisites

- Node.js 20+
- PostgreSQL 18+
- npm or pnpm
- Docker (optional, for RabbitMQ)

### Installation

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your database credentials

# Set up database
npm run db:generate
npm run db:push
npm run db:seed

# Start development server
npm run dev
```

Visit `http://localhost:3000` to see the application. The minimal seed creates a bootstrap admin account (`admin@cascadia.local` / `Cascadia`) for local development only — **change this password immediately in any shared or production deployment**.

For detailed setup instructions, see [SETUP.md](./SETUP.md).

## Project Structure

```
src/
├── components/       # React components (forms, tables, dialogs)
├── lib/
│   ├── auth/         # Authentication & authorization services
│   ├── db/           # Drizzle schema & database utilities
│   ├── items/        # Item services (Parts, Documents, etc.)
│   ├── services/     # Core services (Branch, Checkout, Commit, etc.)
│   ├── workflows/    # Workflow engine
│   ├── jobs/         # Background job handlers
│   ├── api/          # API utilities
│   ├── vault/        # File storage system
│   └── sysml/        # SysML v2 serialization
├── routes/           # TanStack Router routes & API endpoints
└── __tests__/        # Test utilities and fixtures
tests/
├── e2e/              # Playwright E2E tests
│   ├── pages/        # Page object models
│   └── fixtures/     # Test fixtures
docs/                 # Architecture & feature documentation
scripts/              # Database seeding, deployment scripts
```

## Core Concepts

### ECO-as-Branch Workflow

1. **Create ECO** - Creates a branch from main
2. **Checkout Items** - Items are copied to the ECO branch
3. **Make Changes** - Edits are isolated to the branch
4. **Approve & Release** - Merge to main, assign revision letters (A, B, C...)

**Change Actions**: Release (new item), Revise (new revision), Obsolete, Add to BOM, Remove from BOM

### Organizational Hierarchy

- **Organization** - Top-level entity
- **Program** - Permission boundary, users are members of programs
- **Design** - Version container with branches and commits
- **Items** - Parts, Documents, Requirements, etc.

### Item Types

All item types extend `BaseItem` and register via `ItemTypeRegistry`:

- **Part** - Physical components with materials, costs, lead times
- **Document** - Version-controlled files
- **ChangeOrder** - ECOs that coordinate changes across items
- **Requirement** - Traceable requirements
- **Task** - Work items for workflows

### Admin Capabilities

- User and role management with RBAC
- Lifecycle and workflow configuration
- Background jobs dashboard with monitoring
- Health check endpoint (`/api/v1/health`)

### Service Layer

Business logic is centralized in services:

```typescript
// Create a new part
const part = await ItemService.create(
  'Part',
  {
    itemNumber: 'P-1001',
    name: 'Widget Assembly',
    partType: 'Manufacture',
  },
  userId,
)

// Checkout to an ECO branch
await CheckoutService.checkout(part.id, ecoId, userId)

// Get item at a specific version context
const versionedPart = await VersionResolver.getItemAtContext(part.masterId, {
  branchId,
  commitId,
})
```

## Development

### Available Scripts

```bash
# Development
npm run dev           # Start dev server on port 3000
npm run build         # Build for production
npm run serve         # Preview production build

# Database
npm run db:generate   # Generate migrations from schema changes
npm run db:migrate    # Run pending migrations
npm run db:push       # Push schema directly to database (dev only)
npm run db:studio     # Open Drizzle Studio GUI
npm run db:seed       # Minimal seed (admin, roles, program)
npm run db:reset:seed # Truncate all tables + reseed

# Testing
npm run test          # Run Vitest tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage
npm run test:e2e      # Run Playwright E2E tests
npm run test:e2e:ui   # Run E2E tests with UI

# Background Jobs (requires Docker)
docker compose up -d rabbitmq
docker compose --profile dev up jobs-worker-dev -d

# Code Quality
npm run lint          # ESLint
npm run format        # Prettier
npm run check         # Format + lint fix
```

### Adding a New Item Type

1. Define the type and Zod schema in `src/lib/items/types/`
2. Add database columns in `src/lib/db/schema/items.ts`
3. Create form, table, and detail components
4. Register the type in `ItemTypeRegistry`
5. Run `npm run db:generate` and `npm run db:push`

## Deployment

Cascadia supports flexible deployment options:

| Deployment     | Best For                    | Documentation                                    |
| -------------- | --------------------------- | ------------------------------------------------ |
| Single Server  | Development, small teams    | `docs/orchestration/deployments/single-server/`  |
| Distributed    | HA, 50+ users               | `docs/orchestration/deployments/distributed/`    |
| Cloud Database | Managed DB (RDS, Cloud SQL) | `docs/orchestration/deployments/cloud-database/` |
| Kubernetes     | Enterprise, auto-scaling    | `docs/orchestration/deployments/kubernetes/`     |

### Docker Compose

```bash
# Start all services
docker compose up -d

# Start with background job worker
docker compose --profile dev up -d
```

## Environment Variables

Required in `.env`:

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia
NODE_ENV=development
```

Optional:

```
FILE_STORAGE_PATH=/path/to/vault  # Default: ./vault-storage
RABBITMQ_URL=amqp://localhost     # For background jobs
SESSION_SECRET=your-secret-key    # Session encryption
```

## Architecture Decisions

### Why Code-First?

- All configuration is version controlled
- Full TypeScript type safety
- IDE support for development
- No complex UI builders to maintain

### Why ECO-as-Branch?

- Parallel change development without conflicts
- Clear audit trail of what changed and when
- Revision letters assigned only on release
- Git-like workflow familiar to developers

### Why Hono + Vite SPA?

- Lightweight, fast API server with standard Web API types
- Unified auth supporting session cookies and API keys
- Clean separation of API server and SPA frontend
- File-based routing via TanStack Router

### Why PostgreSQL?

- Enterprise standard with ACID compliance
- Excellent JSON support for flexible data
- Powerful full-text search capabilities
- Materialized views for complex queries

## Testing

Cascadia has comprehensive test coverage:

- Unit tests for all services (Vitest)
- Component tests with React Testing Library
- API route integration tests
- E2E browser tests (Playwright) with page object model
- CI via GitHub Actions

```bash
npm run test          # Run all unit/integration tests
npm run test:e2e      # Run Playwright E2E tests
npm run test:coverage # Generate coverage report
```

## CAD Integration

Cascadia stores and serves CAD files (STEP, IGES, SolidWorks, and more) through its file vault, with server-side conversion to STL/GLB for in-browser 3D preview. Native CAD connectors (Solid Edge, SolidWorks) that push parts and BOMs directly from CAD are on the roadmap but not yet implemented.

## Documentation

- [Setup Guide](./SETUP.md) - Detailed installation and configuration
- [Feature List](./cascadia-feature-list.md) - Comprehensive feature documentation
- [CLAUDE.md](./CLAUDE.md) - Development guide for AI assistants

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines. Security issues should be reported per [SECURITY.md](./SECURITY.md).

## License

Cascadia is licensed under the [GNU Affero General Public License v3.0 or later](./LICENSE). The AGPL's network-use clause means that if you run a modified version of Cascadia as a service, you must make the source available to users of that service.

## Support

For usage questions, see the documentation in [`docs/`](./docs/). For bugs and feature requests, open a GitHub issue.

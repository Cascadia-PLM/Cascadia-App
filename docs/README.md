# Cascadia PLM Documentation

> **Code-first Product Lifecycle Management built with Hono + Vite SPA**

This documentation covers the Cascadia PLM application architecture, features, API reference, deployment, and development guides.

---

## Getting Started

| Document                                            | Description                                                |
| --------------------------------------------------- | ---------------------------------------------------------- |
| [Installation](./getting-started/installation.md)   | Local development setup (Node.js, PostgreSQL, environment) |
| [Configuration](./getting-started/configuration.md) | Environment variables, runtime config, provider setup      |
| [Quick Start](./getting-started/quick-start.md)     | First run, seed data, create your first items and ECO      |

## Architecture

| Document                                                 | Description                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| [Overview](./architecture/overview.md)                   | System architecture, tech stack, design philosophy                 |
| [Two-Table Pattern](./architecture/two-table-pattern.md) | Item type architecture (base + type-specific tables)               |
| [ECO-as-Branch](./architecture/eco-as-branch.md)         | The signature Git-style branching model for engineering changes    |
| [Service Layer](./architecture/service-layer.md)         | Three-layer service architecture, dependency graph, error handling |
| [Security](./architecture/security.md)                   | Authentication, CSRF, CORS, RBAC, input validation                 |

## Features

| Document                                                                       | Description                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Item Types](./features/item-types.md)                                         | All 13 item types: Part, Document, Change Order, Requirement, Task, Work Instruction, Issue, Test Plan, Test Case, Software, Tool, Physical Part, Work Order |
| [Change Management](./features/change-management.md)                           | ECO workflow, change actions, impact analysis, conflict detection                                                                                            |
| [BOM Management](./features/bom-management.md)                                 | Bill of Materials hierarchies, where-used, cross-design references                                                                                           |
| [File Vault](./features/file-vault.md)                                         | Document control, check-in/out, vault storage, lock hierarchy                                                                                                |
| [Workflow Engine](./features/workflow-engine.md)                               | Lifecycle management, workflow definitions, approval voting                                                                                                  |
| [Versioning](./features/versioning.md)                                         | Git-style versioning, branches, commits, tags, revision schemes                                                                                              |
| [Programs & Designs](./features/programs-and-designs.md)                       | Organizational hierarchy, program membership, design cloning                                                                                                 |
| [Search](./features/search.md)                                                 | Enterprise search, type-specific search, filtering                                                                                                           |
| [Reporting](./features/reporting.md)                                           | Report engine, CSV export, saved configurations                                                                                                              |
| [Visualization](./features/visualization.md)                                   | BOM trees, relationship graphs, 3D CAD viewer, history graphs                                                                                                |
| [Import/Export](./features/import-export.md)                                   | Excel/CSV import, BOM import, column auto-mapping                                                                                                            |
| [Work Instructions](./features/work-instructions.md)                           | Manufacturing instructions, execution tracking, PLM integration                                                                                              |
| [Work Order Traveler](./features/work-order-traveler.md)                       | Traveler lines, frozen content snapshots, execution runs and sign-offs                                                                                       |
| [Physical Parts & Traceability](./features/physical-parts-and-traceability.md) | Serialized units and lots, work-order genealogy, the AML, qualification rollup                                                                               |
| [Software Management](./features/software-management.md)                       | Software items, content-addressed source store, in-app editing, per-file diffs                                                                               |
| [AI Assistant](./features/ai-assistant.md)                                     | LLM chatbot with PLM tools, multi-provider support                                                                                                           |
| [MCP Servers](./features/mcp.md)                                               | Model Context Protocol servers: PLM tools for external agents, dev/admin tools for self-hosters                                                              |
| [Design Engine](./features/design-engine.md)                                   | AI-assisted collaborative design: requirements, BOM, CAD, assembly                                                                                           |
| [CAD Services](./features/cad-services.md)                                     | CAD conversion (STEP/IGES to STL/GLB) and generation (Zoo API, KCL)                                                                                          |

## Optional Packages

Separately-licensed functionality, enabled per instance via `CASCADIA_PACKAGES`.

| Document                                               | Description                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [Advanced Auditing](./features/advanced-auditing.md)   | CAC/PIV digital signatures on workflow approvals, hash-chained audit trail               |
| [Odoo ERP Integration](./features/odoo-integration.md) | Pushes released parts and BOMs into an Odoo 19+ ERP on release, plus manual/dry-run sync |

## Administration

| Document                                      | Description                                                    |
| --------------------------------------------- | -------------------------------------------------------------- |
| [User Management](./admin/user-management.md) | Users, roles, authentication, sessions, account lockout        |
| [Access Control](./admin/access-control.md)   | RBAC, program isolation, permission model                      |
| [System Settings](./admin/system-settings.md) | Runtime configuration, lifecycle, workflow, AI, vault settings |
| [Background Jobs](./admin/background-jobs.md) | RabbitMQ job system, job types, monitoring, troubleshooting    |

## API Reference

All routes are mounted under `/api/v1/`.

| Document                                 | Description                                                      |
| ---------------------------------------- | ---------------------------------------------------------------- |
| [Contract & Versioning](./api/README.md) | Where the OpenAPI spec lives, the v1 freeze, the CI gate         |
| [Overview](./api/overview.md)            | API conventions, authentication, error handling, response format |
| [Items](./api/items.md)                  | Items CRUD, batch operations, version-context retrieval          |
| [Relationships](./api/relationships.md)  | BOM/relationship CRUD, batch create, where-used                  |
| [Files](./api/files.md)                  | File upload/download, check-in/out, lock hierarchy               |
| [Change Orders](./api/change-orders.md)  | ECO lifecycle, workflow transitions, impact assessment           |
| [Workflows](./api/workflows.md)          | Workflow definitions, transitions, approval voting               |
| [Search](./api/search.md)                | Enterprise search and type-specific search endpoints             |
| [Import](./api/import.md)                | Bulk import API (parts, documents, issues, BOM)                  |
| [SysML v2](./api/sysml.md)               | Standards-based SysML v2 interoperability API                    |
| [Design Engine](./api/design-engine.md)  | Design engine session management and SSE streaming               |
| [AI Chat](./api/ai-chat.md)              | AI assistant chat sessions and tool execution                    |

## Deployment

Prose guides for each topology. The matching **runnable** configs (compose files,
Kubernetes manifests) live under [Orchestration](#orchestration) below.

| Document                                                       | Description                                           |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| [Docker](./deployment/docker.md)                               | Docker images, multi-stage builds, Compose files      |
| [Single Server](./deployment/single-server.md)                 | All-in-one deployment for development and small teams |
| [Distributed](./deployment/distributed.md)                     | Multi-server deployment for HA and 50+ users          |
| [Kubernetes](./deployment/kubernetes.md)                       | K8s manifests, HPA, ingress, secrets                  |
| [Cloud Database](./deployment/cloud-database.md)               | Managed database (RDS, Cloud SQL, Azure)              |
| [CAD Converter](./deployment/cad-converter.md)                 | Python microservice deployment                        |
| [Quickstart Smoke Test](./deployment/quickstart-smoke-test.md) | Manual checklist for validating the demo stack        |

## Orchestration

Service topology and the ready-to-run deployment configurations.

| Document                                             | Description                                            |
| ---------------------------------------------------- | ------------------------------------------------------ |
| [Orchestration Guide](./orchestration/README.md)     | Index and core principles of the modular architecture  |
| [Deployment Installer](./orchestration/installer.md) | Interactive CLI that generates deployment configs      |
| [Architecture](./orchestration/architecture.md)      | System design, service boundaries, deployment patterns |
| [Services](./orchestration/services.md)              | Individual service descriptions and responsibilities   |
| [Database](./orchestration/database.md)              | Database configuration for different hosting scenarios |
| [Communication](./orchestration/communication.md)    | How services communicate and discover each other       |
| [Configuration](./orchestration/configuration.md)    | Every environment variable, by service                 |

Ready-to-use configurations, each with the compose file or manifests alongside its README:

| Configuration                                                          | Ships                  |
| ---------------------------------------------------------------------- | ---------------------- |
| [Single Server](./orchestration/deployments/single-server/README.md)   | `docker-compose.yml`   |
| [Distributed](./orchestration/deployments/distributed/README.md)       | Per-tier compose files |
| [Cloud Database](./orchestration/deployments/cloud-database/README.md) | `docker-compose.yml`   |
| [Kubernetes](./orchestration/deployments/kubernetes/README.md)         | Kustomize manifests    |

## Development Guides

| Document                                                          | Description                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| [Service Patterns](./development/service-patterns.md)             | Service layer conventions, error handling, transactions  |
| [Database Patterns](./development/database-patterns.md)           | Drizzle ORM patterns, schema conventions, migrations     |
| [Adding Item Types](./development/adding-item-types.md)           | Step-by-step guide to extending the type system          |
| [Adding API Routes](./development/adding-api-routes.md)           | Hono route conventions, apiHandler usage                 |
| [Adding Background Jobs](./development/adding-background-jobs.md) | Job type registration, handler patterns, submission      |
| [Adding Packages](./development/adding-packages.md)               | Optional package framework: catalog, entitlement, gating |
| [Testing](./development/testing.md)                               | Test strategy, utilities, CI/CD integration              |
| [UI Components](./development/ui-components.md)                   | Component library, forms, DataGrid, common pitfalls      |

## Design Proposals

Work that is proposed but not finished. **A proposal leaves this section when it
ships** — implemented designs move to Architecture or Features above, where
someone looking for how the system works will actually find them. What remains
here is genuinely open.

Each doc's own header carries the authoritative status; the summary below is a pointer.

| Document | Status |
| -------- | ------ |

## Other Resources

| Document                    | Description                                     |
| --------------------------- | ----------------------------------------------- |
| [Issues Tracker](./issues/) | Issues discovered during documentation research |

---

_See [cascadia-feature-list.md](../cascadia-feature-list.md) for the complete feature inventory._

# Changelog

All notable changes to Cascadia PLM will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-04-13

Initial open-source release under AGPL v3.

### Added

#### Core PLM

- **10 Item Types** — Part, Document, ChangeOrder, Requirement, Task, WorkInstruction, Issue, TestPlan, TestCase, Tool with unified two-table architecture and full CRUD via ItemService
- **BOM Management** — Hierarchical bill of materials with quantities, find numbers, reference designators, where-used queries, multi-level expansion, and cross-design references
- **File Vault** — Enterprise document control with check-in/check-out, versioning, branch-aware storage, and pluggable backends (local filesystem or S3-compatible)
- **Work Instructions** — Rich step-by-step manufacturing instructions with operations, parametric blocks, image blocks, data field capture, part attachments, change alerts, and execution tracking with sign-off
- **Import/Export** — Excel (.xlsx/.xls) and CSV import with column auto-mapping, BOM hierarchy parsing, validation preview, and bulk creation
- **Enterprise Search** — Full-text search across all item types with type-specific filtering, state filtering, and pagination
- **Reporting Engine** — JSON-based report definitions with execution, preview, and CSV export

#### Change Management

- **ECO-as-Branch** — Git-style branching for engineering changes: create ECO, checkout items to isolated branch, make changes, approve and merge to main with automatic revision letter assignment
- **Change Actions** — Release, Revise, Obsolete, Add to BOM, Remove from BOM, Promote
- **Conflict Detection** — Identifies when multiple ECOs modify the same items
- **Impact Assessment** — Recursive where-used traversal, cross-design impact, definition-usage chains

#### Versioning

- **Git-Style** — Branches, commits, tags, merge commits, master/instance pattern, and design history graphs
- **Branch Isolation** — Checkout/checkin workflow with changes invisible until merged
- **Revision Letters** — A, B, C... assigned only on ECO release, not during work
- **Change History** — Per-item edit history with field-level diffs and relationship change tracking

#### Workflow Engine

- **Lifecycle Management** — Configurable states, transitions, phases, revision schemes, and per-phase revision reset
- **Approval Workflows** — Multi-approver voting, comments on transitions, auto-start on ECO creation
- **Default Workflows** — Part lifecycle, Document lifecycle, ECO workflow included

#### Organization

- **Program & Design Hierarchy** — Organizations, programs (permission boundaries), designs (version containers), design families, clone support
- **Cross-Design References** — Read-only links to items in other designs with branch tracking

#### Security & Auth

- **Authentication** — Email/password with session management, account lockout, GitHub OAuth
- **RBAC** — Role-based access control with program-level isolation (Administrator, Engineer, Viewer)
- **Security Hardening** — CSRF protection, CORS configuration, security headers, input validation, file upload hardening
- **Encryption** — Optional encryption at rest for sensitive data (API keys)

#### Collaborative Design Engine

- **Multi-Stage Workflow** — Requirements drafting, requirements review, BOM drafting, BOM review, materialization, CAD generation, CAD review, assembly composition, assembly review
- **AI-Assisted BOM Drafting** — LLM tool-calling with part search, reuse detection, requirement mapping
- **Materialization** — Creates actual PLM items, relationships, and ECO from draft artifacts
- **SSE Streaming** — Real-time stage updates via server-sent events

#### CAD Integration

- **3D Viewer** — In-browser STL/OBJ/GLB rendering with orbit controls, wireframe mode, material presets, and standard views
- **CAD Conversion** — Python microservice (pythonocc-core) for STEP/IGES to STL/GLB with per-face color preservation
- **CAD Generation** — Text-to-CAD via Zoo API with KCL-based assembly composition (optional, requires API key)

#### AI Assistant (Optional)

- **Chat Panel** — LLM-powered chatbot with read/write PLM tools, confirmation flows, session persistence
- **Provider Support** — Anthropic (Claude) and OpenAI (GPT) via TanStack AI adapters
- **Admin Settings** — Configure provider, model, and API keys through the UI

#### API & Integration

- **REST API** — Comprehensive endpoints for all item types, relationships, files, workflows, search, reports, batch operations, and administration
- **OpenAPI Specification** — Full API documentation
- **SysML v2 API** — Standards-based interoperability with projects, branches, commits, and elements endpoints
- **Batch Operations** — Bulk create/update/delete items and relationships with per-item error handling

#### Background Jobs

- **RabbitMQ Integration** — Job type registry, priority levels, retry logic with exponential backoff, dead letter queue, progress tracking, cancellation
- **Job Types** — CAD file conversion, design clone, work instruction change alerts
- **Admin Dashboard** — Job list, detail view, cancel, retry

#### Deployment

- **Docker Support** — Multi-stage Dockerfiles for app, vault, jobs worker, CAD converter, and CAD generator
- **Docker Compose** — Development and production configurations
- **Deployment Guides** — Single-server, distributed, cloud database, and Kubernetes documentation
- **Health Check** — `/api/v1/health` endpoint for load balancer integration

#### Testing

- **Unit/Integration Tests** — Vitest with test database helper and test data builder
- **E2E Tests** — Playwright with page object model pattern
- **CI/CD** — GitHub Actions workflows for lint, unit tests, E2E tests, and builds

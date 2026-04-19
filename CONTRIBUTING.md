# Contributing to Cascadia PLM

Thank you for your interest in contributing to Cascadia! This guide will help you get started.

## Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to security@cascadiaplm.com.

## How to Contribute

### Reporting Bugs

1. **Search existing issues** first to avoid duplicates.
2. Open a new issue using the **Bug Report** template.
3. Include:
   - Steps to reproduce
   - Expected vs. actual behavior
   - Environment details (OS, Node.js version, PostgreSQL version, browser)
   - Relevant logs or screenshots

### Suggesting Features

1. Open a new issue using the **Feature Request** template.
2. Describe the problem you're trying to solve, not just the solution.
3. Consider how the feature fits into Cascadia's code-first philosophy.

### Submitting Code

1. **Fork the repository** and create a branch from `main`.
2. **Name your branch** descriptively: `fix/eco-merge-conflict`, `feat/solidworks-bom-sync`, etc.
3. **Write your code** following the conventions below.
4. **Add tests** if your change touches critical paths (data integrity, security, complex algorithms).
5. **Run the checks** before submitting:
   ```bash
   npm run check       # Format + lint
   npm run test        # Unit/integration tests
   npm run build       # Verify production build
   ```
6. **Open a pull request** against `main` with a clear description of what and why.

## Development Setup

### Prerequisites

- Node.js 20+
- PostgreSQL 18+
- Docker (for RabbitMQ and optional workers)

### Getting Started

```bash
# Clone your fork
git clone https://github.com/<your-username>/cascadia.git
cd cascadia

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your local database credentials

# Initialize database
npm run db:push
npm run db:seed

# Start dev server
npm run dev
```

### Running Tests

```bash
npm run test                            # Full unit/integration suite (Vitest)
npx vitest run src/path/to/file.test.ts # Scoped: one test file (fast iteration)
npm run test:e2e                        # E2E tests (Playwright, requires running server)
npm run test:coverage                   # Coverage report
```

Run `npm run check` before pushing — it applies Prettier and `eslint --fix` across the repo. CI runs `npm run lint` on every PR and will fail on lint errors.

### Background Workers (optional)

```bash
npm run workers:dev   # Start RabbitMQ + all workers via Docker
```

## Coding Conventions

### General

- **TypeScript** throughout — strict mode, no `any` types.
- **Zod** for runtime validation and type inference.
- **Path alias**: `@/*` maps to `src/*`.

### File Naming

- `kebab-case.ts` for modules: `item-service.ts`
- `PascalCase.tsx` for React components: `PartForm.tsx`
- Routes follow TanStack conventions: `parts/$id.tsx`

### Code Style

- Run `npm run check` before committing — this runs Prettier and ESLint.
- Use `cn()` from `@/lib/utils` for Tailwind class merging.
- Prefer Drizzle ORM for all database queries — never raw SQL.
- Throw typed errors (`NotFoundError`, `ValidationError`, etc.) from `@/lib/errors/`.

### API Routes

- Wrap handlers with `apiHandler()` from `@/lib/api/handler`.
- Return plain objects — they auto-wrap as `{ data: { ... } }`.
- Use `parseQuery(request, zodSchema)` for validated query params.

### Testing

Cascadia follows a **three-gate rule**: write a test only when a change touches one of these:

1. **Data integrity** — mutates multi-entity state (branching, versioning, ECO release, conflict detection, checkout)
2. **Security** — gates access or verifies identity (auth, permissions, access-control boundaries)
3. **Complex algorithm** — non-obvious logic (merge, workflow state machines, graph traversal)

If your change doesn't pass any gate — UI tweaks, CRUD wrappers, API routes that just delegate, utilities, schemas, styling — you do not need to add tests. Most PRs won't.

When you do write tests:

- Co-locate unit tests next to source: `MyService.test.ts` alongside `MyService.ts`.
- Use `TestDatabase` and fixtures from `src/__tests__/` for service tests — integration style, real DB, no mocks.
- Prefer **invariants** over call-shape assertions: test _what must always be true_ ("after ECO release, every affected item has a new revision letter"), not _what the code happens to do internally_.
- Match error **class** (`NotFoundError`, `ValidationError`) or `error.code` — not error message strings, which are refactor-brittle.
- E2E tests use the page object model in `tests/e2e/pages/`.
- Golden examples to pattern-match: `BranchService.test.ts`, `ChangeOrderMergeService.test.ts`, `VersionResolver.test.ts`.

## Pull Request Guidelines

- **Keep PRs focused.** One logical change per PR. Refactoring and features should be separate.
- **Write a clear description.** Explain what changed and why — not just what files you touched.
- **Link related issues** using `Fixes #123` or `Relates to #456`.
- **All CI checks must pass** before merge (lint, tests, build).
- **Expect review feedback.** We review for correctness, security, and alignment with Cascadia's architecture.

## Architecture Quick Reference

Before making changes to core areas, familiarize yourself with:

- **Service layer** — Business logic lives in `src/lib/services/` and `src/lib/items/services/`.
- **Two-table pattern** — Items have a shared `items` table and type-specific tables (`parts`, `documents`, etc.).
- **ECO-as-Branch** — All changes flow through Engineering Change Orders. Cannot modify `main` directly.
- **Branch protection** — Revision letters are assigned only on merge to main, never during work.

See [CLAUDE.md](./CLAUDE.md) for the full architecture reference.

## License

By contributing to Cascadia, you agree that your contributions will be licensed under the [GNU Affero General Public License v3.0](./LICENSE).

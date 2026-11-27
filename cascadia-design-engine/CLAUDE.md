# CLAUDE.md — @cascadia/design-engine

The collaborative design engine — the multi-stage AI workflow that takes a
design brief to requirements, a BOM, materialized PLM items, CAD and an
assembly — and the generative CAD it drives, under `src/cad-generation/`:
AI-written FreeCAD scripts executed by the headless FreeCAD worker, CadQuery
templates and mechanisms, assembly composition. AGPL-3.0-or-later like the rest
of the repository.

**Read first:** the root `CLAUDE.md`, whose _Collaborative Design Engine_
section lists the stages and key concepts. The documentation is
`docs/features/design-engine.md`, `docs/features/cad-services.md` and the API
page `docs/api/design-engine.md`.

**Why a module and not part of core.** It is a consumer of core: it
materializes into items, change orders and the vault through the same services
any other client uses, and core never needs to know it exists. Keeping it a
separate package keeps that true by construction — `npm run boundary:check`
fails if any core file imports it — and keeps core buildable and testable
without it.

**How it attaches to core.** Nothing in core imports this package. It registers
from two entry points, called by the app's composition roots
(`cascadia-app/src/modules.{server,client}.ts`):

- `src/register.server.ts` — `registerDesignEngine()` registers the
  `initiate_collaborative_design` AI tool and the `/api/v1/design-engine`
  routes; `registerCadGeneration()` the CAD settings and parts-CAD routes and
  the generation job definitions; `registerCadGenerationWorker()` the job
  handler for the jobs worker.
- `src/register.client.ts` — `registerDesignEngineClient()` and
  `registerCadGenerationClient()` register the sidebar entry, the UI slots on
  parts and the admin CAD-generation section; the `/designs/collaborative`
  routes under `src/routes/` are composed by `cascadia-app/vite.config.ts`.
- `src/db/schema/design-engine.ts` — its two tables, re-exported from
  `cascadia-app/src/modules.schema.ts` so drizzle-kit sees them. A schema
  change here commits its migration under `cascadia-app/drizzle/` like any
  other.

**Layout** mirrors the application's: `src/design-engine/` (the engine,
`stages/`, `tools/`, `prompts/`, `validation/`, materialization,
`session-service`), `src/cad-generation/` (the FreeCAD agent and its execute
step, the assembly planner and renderer, DFM rules), `src/db/schema/`,
`jobs/`, `server/routes/`, `components/`, `hooks/`, `query/`, `ai/tools/`. The
canonical stage enum is `DesignSessionStage` in `src/design-engine/types.ts`.
Inside this package `@/` resolves across the application packages first, then
this package — so a file here must never share a relative path with a core
file (`boundary:check` refuses the collision, because one would silently
shadow the other).

**Workers.** The CadQuery generator (`cascadia-workers-cad-generator/`) and the
FreeCAD runner (`cascadia-workers-freecad-runner/`) exist to serve this
package. They are services in the root `docker-compose.yml` (profiles `dev`
and `cad`), started by `npm run workers:dev` or individually with
`npm run cadgen:worker:dev` / `npm run freecad:worker:dev`. Their suites run
locally only — see `docs/development/python-worker-tests.md`.

**Tests** run with the shared suite against the test database:
`npx vitest run cascadia-design-engine`.

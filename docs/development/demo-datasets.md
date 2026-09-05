# Demo Datasets

Two seedable demo datasets ship with Cascadia. Both are static bundles fetched
from [`Cascadia-PLM/Demo-Data`](https://github.com/Cascadia-PLM/Demo-Data) and
replayed straight into the database — no CAD toolchain, no workers, no network.

One command seeds both:

| Dataset          | `--only` key | What you get                                                                                              |
| ---------------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| TDJ-25 robot arm | `robot-arm`  | `ROBOT-ARM` program, `TDJ-25` design, ~88 parts, ~101 BOM edges, ~79 GLB + thumbnail pairs, a release ECO |
| FreeCAD / KiCad  | `freecad`    | `PUC` and `USV` programs — the whole engineering record, see below                                        |

```bash
npm run db:seed && npm run demo:fetch && npm run seed:demo
```

`db:seed` first: both datasets assume the admin user, the roles and the shipped
lifecycles already exist, and neither creates them.

Each dataset is independently idempotent — it checks for its own programs and
does nothing if they are there — so re-running is safe, as is running when only
one of the two was seeded before. A dataset that is missing from disk is
reported and skipped rather than fatal, so one absent bundle does not cost you
the one you have; the exit code is still non-zero, so CI notices.

`npm run seed:demo -- --only robot-arm` (or `freecad`) seeds just one.

## The FreeCAD / KiCad datasets

Two products, deliberately taken through different flows so the dataset
exercises both:

| Program | Design         | Product                                                                   |
| ------- | -------------- | ------------------------------------------------------------------------- |
| `PUC`   | `PUC-CART-24V` | 4WD skid-steer powered utility cart, 62+ items — post-release ECO flow    |
| `USV`   | `USV-CAT-3M`   | 3 m semi-autonomous survey catamaran, 45+ items — pre-release review flow |

Each carries the full engineering record, not just geometry: parts and
assemblies with BOM and AML, requirements and V&V with coverage gaps left in on
purpose, ECO history, KiCad boards with Software items and firmware, MES
travelers with work orders and serialized units with genealogy,
Cables-workbench harnesses, and TechDraw drawings.

## Where the FreeCAD bundle comes from

It is **baked**, not written. The dataset is authored by a separate ~10k-line
Python pipeline (the FreeCADDemo repository) that drives FreeCAD 1.1, KiCad 10
and the CAD-converter workers, pushing everything through Cascadia's HTTP API
over one to two hours. That is a good authoring pipeline and a hopeless seed: it
needs two CAD toolchains, Docker workers, a live server and an API key, and it
mints different UUIDs on every run.

So the pipeline runs once, a bake freezes the answer, and what ships is the
frozen result.

```
Python pipeline  ──►  a seeded database  ──►  bake  ──►  bundle  ──►  seed  ──►  any database
   (1-2 hours,                                                        (seconds,
    full toolchain)                                                    no toolchain)
```

### Seeding

The FreeCAD dataset's seeder walks the order it was given, so it needs no
schema knowledge of its own. Rows go in through
`json_populate_recordset(null::<table>, $1::json)`, which hands Postgres the
JSON and lets it parse each value into the column's own type — that is what
keeps timestamps, JSONB, arrays and enums working without the script carrying a
type table. Then it patches the deferred columns, advances the number sequences
so the next part a user creates does not collide with a baked item number, and
copies the blobs into the vault at storage paths regenerated from the new ids.

Idempotent: it skips entirely if a baked program already exists.

| Env               | Effect                                                |
| ----------------- | ----------------------------------------------------- |
| `DEMO_DATA_DIR`   | where the bundle lives (default `./demo-data`)        |
| `VAULT_ROOT`      | where blobs are copied (default `./vault`)            |
| `DEMO_SKIP_FILES` | `true` seeds rows only — no vault blobs, no 3D models |

## Ids are derived, not natural

A baked id is `sha256(namespace + source id)`, shaped as a v4 UUID. This needs
no per-table knowledge of what makes a row unique, and keeps every relationship
consistent for free, because one source id maps to one result wherever it
appears — including inside JSONB payloads and in text like a
`Part:design:<uuid>` sequence scope key, which no foreign key would have
declared.

The consequence worth knowing: re-baking a **fresh** pipeline run yields
different ids, because the source ids are themselves fresh. That is fine. The
guarantee that matters is that one bundle seeds to the same ids on every machine
and every run, and bundles are pinned by tag in `scripts/fetch-demo-data.ts`.

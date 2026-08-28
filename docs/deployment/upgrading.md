# Upgrading Cascadia

How to move a running instance between released versions. This page exists
as of v0.5.0 — the first release that ships migration files.

## The two schema paths

| Path           | Command              | For                                                                 |
| -------------- | -------------------- | ------------------------------------------------------------------- |
| **Migrations** | `npm run db:migrate` | Released installs, from v0.5.0 on. The upgrade path.                |
| **Push**       | `npm run db:push`    | Development, CI, and the throwaway demo stack. Not an upgrade path. |

`db:push` diffs the live database against the code and applies the
difference directly — fine for ephemeral databases, but it writes no
history and cannot be reviewed. Released versions ship migration files
under `apps/<edition>/drizzle/`, and `db:migrate` applies exactly the
committed, reviewed SQL in order, recording each file in the journal
(`drizzle.__drizzle_migrations`).

CI enforces that the schema and the committed migrations never drift: a
schema change that would let `drizzle-kit generate` mint a new file fails
the build until the migration is committed alongside it.

## Fresh installs (v0.5.0 or later)

Nothing special: run `npm run db:migrate` against an empty database. It
applies the baseline and every later migration, journal included. Then seed
(`npm run db:seed`).

## Upgrading an install created before v0.5.0

Pre-0.5 databases were created by `db:push`, which writes no migration
journal. Running `db:migrate` against one would replay the baseline from
the top and fail on the first `CREATE TABLE`. **A one-time stamp bridges
this:**

```bash
# 1. Update the code to v0.5.0. Back up the database.
# 2. Optionally verify the baseline without writing anything:
npm run db:baseline -- --check
# 3. Stamp the baseline as already applied (verifies the schema again):
npm run db:baseline          # community edition: CASCADIA_APP=cascadia npm run db:baseline
# 4. From now on, every upgrade is:
npm run db:migrate
```

`db:baseline` refuses to stamp when the live schema is missing tables the
baseline creates — that means the database was not kept current with
`db:push` before the upgrade. Bring it to the 0.5.0 schema first (check out
v0.5.0 and run `npm run db:push` once), then stamp. The command records only
the `0000` baseline; every `0001` and later migration remains pending and is
executed by the following `npm run db:migrate`.

### In Docker

The published image carries `tsx` and `drizzle-kit` as admin tools:

```bash
docker exec cascadia-app npx tsx scripts/db-baseline.ts   # once
docker exec cascadia-app node scripts/drizzle.mjs migrate # every upgrade
```

> **Compose note:** `docker-compose.yml` currently runs
> `drizzle.mjs push --force` on app start — the pre-0.5 behavior, kept for
> one release so existing stacks upgrade without coordination. It is
> harmless on a stamped database (push sees no diff), and a future release
> will switch the boot command to `migrate`. Stamp your database anyway:
> the journal is what makes every later upgrade reviewable.

## Version identification

`GET /api/v1/health` reports the running version, the admin page shows it,
and images carry `org.opencontainers.image.version`. Check it before and
after an upgrade.

## Rules for maintainers

- Every schema change ships with migrations for **both editions** — run
  `npm run db:generate` and `CASCADIA_APP=cascadia npm run db:generate`,
  commit what appears under `apps/*/drizzle/`. CI fails otherwise.
- Never edit a committed migration file: the journal stores its hash, and
  an edited file breaks verification on every database that already applied
  it. Fix forward with a new migration.
- The enterprise migrations are proprietary (they name module tables) and
  never publish; the community migrations under `apps/cascadia/drizzle/`
  ship to the public repo. `npm run publish:verify` checks both directions.

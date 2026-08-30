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

CI enforces that the schema and the committed migrations never drift, in
both directions. A schema change that would let `drizzle-kit generate` mint
a new file fails the build until the migration is committed alongside it —
and `npm run db:check-migrations` applies the committed migrations to one
database, pushes the declared schema to another, and fails if the two differ.
Applying without throwing is not the same as arriving at the right schema: a
migration that dropped a statement, or that predates a rename the schema
already has, produces a database that is fine in dev (pushed) and wrong on a
real install (migrated).

Both of those run against empty databases, which is the one place a
data-dependent migration cannot be judged: a backfill `UPDATE` matches
nothing, a dedup `DELETE` removes nothing, and a guard written to abort on
corrupt history has nothing to abort on. `npm run db:check-backfills`
covers that case. For each migration that touches rows it stages the
journal to the tag before it, seeds the shape of data that tag's SQL exists
to handle, applies just that one file, and asserts what it did — including
the migrations that are supposed to fail, which must abort with the
documented SQLSTATE and leave the database exactly where it was. It runs in
the Migrations Apply job against its own scratch database.

**A new migration that touches rows has to ship a scenario.** The check
scans every journal entry for a row-touching statement and fails when one
has none registered, so add the seed-and-assert block to
`scripts/check-migration-backfills.mjs` in the same commit as the
migration. Locally: `createdb -U postgres cascadia_migrate_backfills`, then
`BACKFILL_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia_migrate_backfills npm run db:check-backfills`.

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
# 2. Stamp the baseline as already applied (verifies the schema first):
npm run db:baseline          # community edition: CASCADIA_APP=cascadia npm run db:baseline
# 3. From now on, every upgrade is:
npm run db:migrate
```

`db:baseline` refuses to stamp when the live schema is missing tables the
baseline creates — that means the database was not kept current with
`db:push` before the upgrade. Bring it to the 0.5.0 schema first (check out
v0.5.0 and run `npm run db:push` once), then stamp.

### In Docker

The published image carries `tsx` and `drizzle-kit` as admin tools:

```bash
docker exec cascadia-app npx tsx scripts/db-baseline.ts   # once
docker exec cascadia-app node scripts/drizzle.mjs migrate # every upgrade
```

> **Compose note:** `docker-compose.yml` boots through
> `scripts/boot-migrate.ts`, which applies committed migrations and then
> starts the server. This is the release the previous note promised; the
> boot command is no longer `push --force`.
>
> **A stack that never ran the stamp above will not start.** Its database
> has tables and no journal, which is indistinguishable from a database
> whose migrations were lost — so boot refuses rather than replaying the
> baseline over live data. It changes nothing and prints the one command
> that fixes it:
>
> ```bash
> docker exec cascadia-app npx tsx scripts/db-baseline.ts
> ```
>
> Restart after stamping. Every boot from then on applies whatever is new
> and does nothing when there is nothing new, so restarts stay free.
>
> The demo stacks (`docker-compose.demo*.yml`) still use `push`
> deliberately — they are throwaway.

### Rolling back

Migrations are forward-only. There is no `down` step and no
`drizzle-kit rollback`: rolling back means stopping the stack, restoring
the backup step 1 of the stamp procedure tells you to take, and starting
the previous image tag.

That is the whole reason for the backup, and the reason an applied
migration is never edited. Note the mechanism, because it is not the one
people assume: the journal stores each file's hash but **nothing ever
compares it**. Drizzle decides what to apply from the timestamp alone
(`created_at < folderMillis`), and neither `boot-migrate` nor `db:baseline`
looks at hashes either. So editing an applied migration does not fail
loudly — it does nothing at all on databases that already ran it, and those
databases silently diverge from ones that run the edited file later. That is
worse than an error, and it is why the rule is absolute. Fix forward with a
new migration.

## Version identification

`GET /api/v1/health` reports the running version, the admin page shows it,
and images carry `org.opencontainers.image.version`. Check it before and
after an upgrade.

## Consolidating unreleased migrations

A migration that has never been in a release has never reached an install
that upgrades. Before its first release, a run of them may be folded into a
single file — which is what happened before v0.5.1, to the twenty-five
(nineteen in the community edition) that the two remediation programs
produced after `v0.5.0`. It happened in two passes: the first program's were
folded while the second was still running, and the result was folded again
with the second's into the same `0001_remediation`. Folding a file that is
itself a fold is fine; what matters is that nothing in it was ever released.

This is allowed because it is not an edit in the sense above: no database
that ran those files ends up disagreeing with one that runs the consolidated
one. Three things make that true, and all three have to hold:

1. **Every folded migration is post-release.** Check the tag: `git ls-tree -r
--name-only v0.5.0 -- apps/*/drizzle/` shows what shipped. Anything at or
   before the last release stays where it is, forever.
2. **The consolidated file keeps the `when` of the _last_ migration it
   folds.** Drizzle applies on `created_at < folderMillis`, so the timestamp
   chosen decides exactly which databases skip the file, and only one choice
   draws that line in the right place. A fresh timestamp makes _every_
   database re-run statements it already has, and `ADD CONSTRAINT` fails for
   anyone tracking `main`. The **first** folded `when` skips for every
   database at or past the first folded file — which includes the ones that
   stopped in the middle and are missing the rest, so they skip silently and
   stay short of the schema. The **last** folded `when` skips only for a
   database whose high-water mark reached the final folded file, and reaching
   it means every earlier one was applied too: precisely the set that already
   contains the whole file. Everything else re-runs the file, which either
   succeeds (a released install, a fresh one) or fails loudly (a half-migrated
   one) — never silently.
3. **It is a concatenation, never a regeneration.** `db:generate` emits the
   schema delta; it does not know about the hand-written pre-cleanup blocks
   that null dangling pointers before validation, or the guards that abort on
   history corruption on purpose. Regenerating drops all of them, which is
   invisible on an empty database and destroys a populated upgrade.

Rule 2's first-versus-last distinction is not hypothetical; the rule reads
the way it does because of this. The v0.5.1 fold first shipped carrying the
**first** folded `when`, and a dev database that had tracked `main` as far as the original
`0001_remediation` compared against a timestamp _equal_ to the consolidated
file's — not less than it — so `db:migrate` skipped the file, printed
`migrations applied successfully!`, and exited 0 against a database it had not
touched. Replaying that stop point leaves the schema short of columns
(`change_orders.description`, `jobs.retry_delays`), constraints, indexes, and
one predicate that had since narrowed a unique index — so every query that
selects change-order columns fails with Postgres `42703`, which is what a login
turns into: the dashboard's `/stats` tile 500s while the page still renders,
because each widget catches its own failure.

A half-migrated database still cannot be _upgraded_ by a fold — the file
replays statements it already ran and `ADD CONSTRAINT` fails. The point of the
last-folded `when` is that it fails rather than lies; recover such a database
with `db:push` (dev) or by restoring the backup and migrating forward from the
last release (an install). Note that `db:baseline` is not the recovery: it
stamps only a database whose journal is empty, and no-ops on one that is
already stamped.

The snapshot chain needs the same care: keep the **last** folded
`NNNN_snapshot.json` as the survivor, re-pointed at the baseline's `id`.
Keeping the baseline's own would make the next `db:generate` re-emit
everything the consolidated file already contains.

Verify it five ways before committing — statement-for-statement equality
against the files being replaced, schema equality between the old and new
sequences on empty databases, a no-op run against a database that already
applied the sequence, a run against a database stopped **partway** through it,
and a real upgrade of a _seeded_ database at the last released version.
`npm run db:check-backfills` is the last of those for every statement that
touches rows, and it runs in CI; the rest are still manual.

The partway run is the one that was missing when v0.5.1 was folded, and it is
the only one that distinguishes a right timestamp from a wrong one — every
other check passes either way, because they all start from a database that is
at the baseline or at the end. Build it by applying the pre-fold files up to
some middle tag, stamping `drizzle.__drizzle_migrations` with that tag's
`when`, and running `db:migrate`. It must not report success without applying
the file: exit 0 with an unchanged journal is the failure this is looking
for.

## Rules for maintainers

- Every schema change ships with migrations for **both editions** — run
  `npm run db:generate` and `CASCADIA_APP=cascadia npm run db:generate`,
  commit what appears under `apps/*/drizzle/`. CI fails otherwise.
- Never edit a committed migration file. Nothing verifies the stored hash,
  so an edit does not fail — it silently divides your installs into those
  that ran the old statements and those that ran the new. Fix forward with a
  new migration.
- **Consolidating unreleased migrations is the one exception**, and it is a
  deliberate operation rather than an edit. See below.
- The enterprise migrations are proprietary (they name module tables) and
  never publish; the community migrations under `apps/cascadia/drizzle/`
  ship to the public repo. `npm run publish:verify` checks both directions.

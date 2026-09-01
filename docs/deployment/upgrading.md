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
covers that case. For each migration whose outcome depends on rows it
stages the journal to the tag before it, seeds the shape of data that tag's
SQL exists to handle, applies just that one file, and asserts what it did —
including the migrations that are supposed to fail, which must abort with
the documented SQLSTATE and leave the database exactly where it was. It
runs in the Migrations Apply job against its own scratch database.

"Depends on rows" is two families. The writes — `UPDATE`, `DELETE`,
`INSERT` — are the obvious one. The other is DDL Postgres validates against
every existing row before it will commit: `ADD CONSTRAINT`, `SET NOT NULL`,
a `NOT NULL` column added with no default, a column whose type changes, and
`CREATE UNIQUE INDEX`. Those are the statements that abort an upgrade
rather than silently doing nothing, and an empty database judges them no
better than it judges a backfill. Validating DDL against a table the same
migration just created does not count — there, "the rows already present"
is the empty set by construction, which is what keeps the baselines out.

**A new migration in either family has to ship a scenario.** The check
scans every journal entry and fails when one has none registered, so add
the seed-and-assert block to `scripts/check-migration-backfills.mjs` in the
same commit as the migration. Locally:
`createdb -U postgres cascadia_migrate_backfills`, then
`BACKFILL_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cascadia_migrate_backfills npm run db:check-backfills`.

Empty databases hide one more thing: they are the one state in which
`db:baseline` never runs, so nothing judged the upgrade path for the pre-0.5
installs it exists to rescue. `npm run db:check-baseline` covers that. For
every prefix of the journal it builds a database at exactly that migration,
baselines it, migrates it, and requires the result to equal what
`db:migrate` builds from empty — plus the refusals, so a check that only
proved the happy path cannot let this regress into stamping whatever it was
handed. It runs in the Migrations Apply job against its own scratch
database. Running it for every prefix is also what keeps the placement
honest as migrations accumulate: a new migration `db:baseline` could not
tell apart from the one before it would stamp one row short and fail here.

If a statement genuinely cannot behave differently against rows — a
constraint the database already enforced under another name, say — record
the argument in that script's `CANNOT_ABORT` list rather than narrowing its
classifier. Narrowing it is how the writes-only version of this check came
to wave a constraint-validating migration through with no scenario at all;
an entry naming a statement that no longer qualifies fails the run, so the
list cannot silently outlive what it was arguing about.

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
# 1. Back up the database.
# 2. See where db:baseline thinks the database sits. Writes nothing:
npm run db:baseline -- --check   # community edition: prefix CASCADIA_APP=cascadia
# 3. Record the migrations it already satisfies:
npm run db:baseline
# 4. Apply the ones it does not, and every upgrade after this:
npm run db:migrate
```

`db:baseline` does not take your word for where the database is. It compares
the live schema against the snapshot committed beside each migration and
records **only the migrations that schema actually satisfies** — the rest stay
pending, and step 4 applies them for real. A database pushed at v0.5.0 gets
one migration recorded; one kept current with `db:push` against a later
release gets all of them. Either is fine, and neither needs an old checkout.

That precision is not decoration. Drizzle's migrator resumes from the newest
row in the journal rather than checking each migration off, so a migration
recorded without having run is not retried later — `db:migrate` reports
success, applies nothing, and the columns and constraints it skipped surface
much later as errors nobody connects back to the upgrade.

`db:baseline` refuses, rather than guessing, when the live schema matches no
committed migration exactly. That means the database is between releases:
bring it to a released schema (check out that release, run `npm run db:push`
once) and run it again. `--check` reports the same verdict and exits non-zero
on refusal, so it can gate an upgrade script before anything is written.

#### If a previous stamp recorded too much

Before this behaviour existed, `db:baseline` recorded the _whole_ journal
whatever the database contained. On a v0.5.0 checkout that was the same thing
— there was only the baseline to record — but run from a later checkout it
marked every migration as applied, and `db:migrate` has been doing nothing
ever since.

`db:baseline` now detects this instead of blessing it: it names the migrations
recorded without having run and prints the `DELETE` that trims the journal
back to what the schema really satisfies. Back up first, run it, then
`npm run db:migrate` applies the rest properly. Running `db:baseline --check`
on any database stamped by an older build is the quickest way to find out
whether this happened to you.

### Preflight the data-dependent migrations

The migrations applied after the stamp validate against data the pre-0.5
schema allowed, and two of them refuse rather than repair: the items
identity unique — which `NULLS NOT DISTINCT` makes bite for the design-less
item types the old constraint never checked — and the versioning-graph
foreign keys. Both have a report-only preflight. Run them first, so a
collision arrives as a list of rows rather than as an aborted upgrade
window:

```bash
npm run db:check-duplicates   # names the colliding design-less identities
npm run db:check-orphans      # dangling versioning pointers, counted per edge
```

Each exits non-zero when it finds anything, so either can gate an upgrade
script. `db:check-orphans` also labels every edge with what the migration
will do about it: the inert classes (stale provenance pointers, tracking
rows left behind on archived branches) are cleaned by the file itself,
while a dangling `commits.parent_id` / `commits.branch_id` or a
`branches.head_commit_id` / `base_commit_id` aborts it on purpose — that is
history corruption, and a human decides. Read the `branch_items` edges the
same way: the cleanup covers archived branches only, so a dangler on a live
branch aborts too.

An abort is not a half-upgrade. `ADD CONSTRAINT` validates inside the
migration's transaction, so a refusal rolls that file back and leaves the
database exactly where it started; resolve the rows the report names and
run `db:migrate` again. Neither check is pre-0.5-specific — any install
that has not yet applied the post-v0.5.0 migrations can run them — but
pre-0.5 databases are where the offending rows accumulated.

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

## Consolidating unpublished migrations

A migration that has never been published has never reached a database
other than a development one upstream. Before it is first published, a run
of them may be folded into a single file — which is what happened to the
twenty-five (nineteen in the community edition) that the two remediation
programs produced after `v0.5.0`. It happened in two passes: the first
program's were folded while the second was still running, and the result was
folded again with the second's into the same `0001_remediation`. Folding a
file that is itself a fold is fine; what matters is that nothing in it was
ever published.

This is the standing practice, not an occasional cleanup: each wave of
development arrives in this repository as **one** new migration per edition,
folded from however many the work minted upstream. Development iterates
freely there; what publishes is the consolidated result.

This is allowed because it is not an edit in the sense above: no database
that ran those files ends up disagreeing with one that runs the consolidated
one. Three things make that true, and all three have to hold:

1. **Every folded migration is unpublished.** A release tag is not the line —
   publication is. A production database can only be tracking what this
   repository's `main` has carried, tagged or not, so check what `main`
   already holds under `apps/*/drizzle/`: anything there stays where it is,
   forever. (This is stricter than the release check the first fold used —
   `git ls-tree -r --name-only v0.5.0 -- apps/*/drizzle/` — which is only
   equivalent while nothing has been published since the tag.)
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
- **Consolidating unpublished migrations is the one exception**, and it is a
  deliberate operation rather than an edit — see "Consolidating unpublished
  migrations" above. It happens once per wave, right before the publish that
  ships it, so each publish carries at most one new migration per edition.
- The enterprise migrations are proprietary (they name module tables) and
  never publish; the community migrations under `apps/cascadia/drizzle/`
  ship to the public repo. `npm run publish:verify` checks both directions.

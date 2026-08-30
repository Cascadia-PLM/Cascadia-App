-- Consolidated: everything the two remediation programs changed in the
-- database between v0.5.0 and v0.5.1, in one file.
--
-- v0.5.0 shipped with 0000 alone, so none of the folded migrations was ever
-- in a release and none can be sitting applied in an install that upgrades.
-- This file supersedes the earlier `0001_remediation` (itself a fold of the
-- first program's eleven) together with the eight that followed it.
--
-- Statement order is preserved exactly, including the pre-cleanup blocks that
-- null dangling pointers before ADD CONSTRAINT and the guards that abort on
-- history corruption on purpose. This is a concatenation, not a regenerated
-- diff: `db:generate` emits the schema delta and would silently drop every
-- one of those.
--
-- The journal keeps the first folded entry's `when`, so a database that
-- already applied the whole sequence (anyone tracking main) skips this file,
-- while a v0.5.0 install and a fresh one both apply it. A database that
-- applied only PART of the sequence would skip it too and be left short —
-- see docs/deployment/upgrading.md.

-- Consolidated from 11 migrations (0001_messy_meltdown … 0011_ambiguous_boomerang),
-- none of which was ever in a release: v0.5.0 shipped with 0000 alone.
--
-- Statement order is preserved exactly, including the pre-cleanup blocks
-- that null dangling pointers before ADD CONSTRAINT and the guards that
-- deliberately abort on history corruption. This is a concatenation, not a
-- regenerated diff: `db:generate` emits the schema delta and would silently
-- drop every one of those.
--
-- The journal keeps the first folded entry's `when`, so a database that
-- already applied the sequence (anyone tracking main) skips this file,
-- while a v0.5.0 install and a fresh one both apply it.

-- Resolve duplicates before the unique index can reject them.
--
-- Votes are append-only (decision D7 on workflow_approval_votes): a vote that
-- existed has to stay visible as superseded, never deleted. So where a
-- (instance, state, user) group has more than one live vote — which only the
-- pre-index TOCTOU race could produce — keep the newest and supersede the
-- rest, tie-broken on id so the choice is deterministic.
--
-- The supersede timestamp is now(), not the winning vote's voted_at: an
-- auditor reading these rows sees them superseded at upgrade time, which is
-- when the decision was actually made.
--
-- The CHECK below can fail on data instead of adding cleanly, if any row holds
-- a vote value outside ('approved','rejected'). Nothing writes one — the
-- service takes a typed union — and there is no correct automatic answer for
-- what such a row meant, so it aborts the migration rather than guessing.
-- Migrations apply in a transaction, so a failure here leaves nothing behind.
UPDATE "workflow_approval_votes" AS v
SET "superseded_at" = now()
WHERE v."superseded_at" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "workflow_approval_votes" AS newer
    WHERE newer."workflow_instance_id" = v."workflow_instance_id"
      AND newer."state_id" = v."state_id"
      AND newer."user_id" = v."user_id"
      AND newer."superseded_at" IS NULL
      AND (newer."voted_at", newer."id") > (v."voted_at", v."id")
  );--> statement-breakpoint
CREATE UNIQUE INDEX "uq_wf_votes_active" ON "workflow_approval_votes" USING btree ("workflow_instance_id","state_id","user_id") WHERE "workflow_approval_votes"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_wf_votes_instance_state" ON "workflow_approval_votes" USING btree ("workflow_instance_id","state_id");--> statement-breakpoint
ALTER TABLE "workflow_approval_votes" ADD CONSTRAINT "ck_wf_votes_value" CHECK ("workflow_approval_votes"."vote" IN ('approved', 'rejected'));--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT "items_item_number_revision_design_id_item_type_unique";--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_item_number_revision_design_id_item_type_unique" UNIQUE NULLS NOT DISTINCT("item_number","revision","design_id","item_type");--> statement-breakpoint
-- Access-control data with no key: the same (user, role) pair could land
-- twice, so dedup the twins (keeping one arbitrary survivor per pair —
-- the rows are identical) before the primary key makes them impossible.
DELETE FROM "user_roles" a USING "user_roles" b
  WHERE a.ctid < b.ctid AND a.user_id = b.user_id AND a.role_id = b.role_id;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id");--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD COLUMN "program_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_logs_program_id_timestamp_idx" ON "ai_usage_logs" USING btree ("program_id","timestamp");--> statement-breakpoint
ALTER TABLE "change_order_designs" ADD CONSTRAINT "ck_cod_merge_status" CHECK (merge_status IN ('pending', 'merged', 'conflict', 'skipped'));--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "ck_items_revision_working_marker" CHECK (revision NOT LIKE '-%' OR revision = '-' OR revision ~ '^-[0-9a-f]{8}$');--> statement-breakpoint
-- Pre-cleanup: NULL any graph pointer whose target row no longer exists, so
-- ADD CONSTRAINT validates cleanly on historical databases that accumulated
-- dangling pointers while these columns were bare uuids.
UPDATE "designs" SET "parent_design_id" = NULL WHERE "parent_design_id" IS NOT NULL AND "parent_design_id" NOT IN (SELECT "id" FROM "designs");--> statement-breakpoint
UPDATE "designs" SET "clone_source_design_id" = NULL WHERE "clone_source_design_id" IS NOT NULL AND "clone_source_design_id" NOT IN (SELECT "id" FROM "designs");--> statement-breakpoint
UPDATE "designs" SET "source_design_id" = NULL WHERE "source_design_id" IS NOT NULL AND "source_design_id" NOT IN (SELECT "id" FROM "designs");--> statement-breakpoint
UPDATE "designs" SET "source_tag_id" = NULL WHERE "source_tag_id" IS NOT NULL AND "source_tag_id" NOT IN (SELECT "id" FROM "tags");--> statement-breakpoint
UPDATE "designs" SET "source_commit_id" = NULL WHERE "source_commit_id" IS NOT NULL AND "source_commit_id" NOT IN (SELECT "id" FROM "commits");--> statement-breakpoint
UPDATE "designs" SET "default_branch_id" = NULL WHERE "default_branch_id" IS NOT NULL AND "default_branch_id" NOT IN (SELECT "id" FROM "branches");--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_parent_design_id_designs_id_fk" FOREIGN KEY ("parent_design_id") REFERENCES "public"."designs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_clone_source_design_id_designs_id_fk" FOREIGN KEY ("clone_source_design_id") REFERENCES "public"."designs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_source_design_id_designs_id_fk" FOREIGN KEY ("source_design_id") REFERENCES "public"."designs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_source_tag_id_tags_id_fk" FOREIGN KEY ("source_tag_id") REFERENCES "public"."tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_source_commit_id_commits_id_fk" FOREIGN KEY ("source_commit_id") REFERENCES "public"."commits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_default_branch_id_branches_id_fk" FOREIGN KEY ("default_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Pre-cleanup, conservative by design. Inert orphan classes are resolved so
-- ADD CONSTRAINT validates; anything smelling of history corruption is NOT
-- touched — a dangling commits.parent_id/branch_id or branches.head/base
-- commit pointer aborts this transaction on validation, on purpose. Run
-- `npm run db:check-orphans` first for the per-edge report.
--
-- Tracking rows on ARCHIVED branches pointing at deleted items: the residue
-- deleteWorkspaceBranch used to create (it deleted the items and archived
-- the branch, leaving the rows). Active-branch danglers are NOT cleaned —
-- those abort and need a human.
DELETE FROM "branch_items" bi USING "branches" b
  WHERE bi."branch_id" = b."id" AND b."is_archived" = true
    AND bi."current_item_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "items" i WHERE i."id" = bi."current_item_id");--> statement-breakpoint
UPDATE "branch_items" SET "base_item_id" = NULL
  WHERE "base_item_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "items" i WHERE i."id" = "branch_items"."base_item_id");--> statement-breakpoint
UPDATE "branches" SET "change_order_item_id" = NULL
  WHERE "change_order_item_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "items" i WHERE i."id" = "branches"."change_order_item_id");--> statement-breakpoint
UPDATE "branches" SET "source_tag_id" = NULL
  WHERE "source_tag_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "tags" t WHERE t."id" = "branches"."source_tag_id");--> statement-breakpoint
DELETE FROM "item_versions"
  WHERE NOT EXISTS (SELECT 1 FROM "items" i WHERE i."id" = "item_versions"."item_id");--> statement-breakpoint
UPDATE "item_versions" SET "previous_item_id" = NULL
  WHERE "previous_item_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "items" i WHERE i."id" = "item_versions"."previous_item_id");--> statement-breakpoint
DELETE FROM "conflict_reviews"
  WHERE NOT EXISTS (SELECT 1 FROM "items" i WHERE i."id" = "conflict_reviews"."change_order_id");--> statement-breakpoint
UPDATE "conflict_reviews" SET "their_eco_id" = NULL
  WHERE "their_eco_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "items" i WHERE i."id" = "conflict_reviews"."their_eco_id");--> statement-breakpoint
ALTER TABLE "branch_items" ADD CONSTRAINT "branch_items_current_item_id_items_id_fk" FOREIGN KEY ("current_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_items" ADD CONSTRAINT "branch_items_base_item_id_items_id_fk" FOREIGN KEY ("base_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_head_commit_id_commits_id_fk" FOREIGN KEY ("head_commit_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_base_commit_id_commits_id_fk" FOREIGN KEY ("base_commit_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_change_order_item_id_items_id_fk" FOREIGN KEY ("change_order_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_source_tag_id_tags_id_fk" FOREIGN KEY ("source_tag_id") REFERENCES "public"."tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_parent_id_commits_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_merge_parent_id_commits_id_fk" FOREIGN KEY ("merge_parent_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_reviews" ADD CONSTRAINT "conflict_reviews_change_order_id_items_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_reviews" ADD CONSTRAINT "conflict_reviews_their_eco_id_items_id_fk" FOREIGN KEY ("their_eco_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_previous_item_id_items_id_fk" FOREIGN KEY ("previous_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_branch_items_current_item" ON "branch_items" USING btree ("current_item_id");--> statement-breakpoint
CREATE INDEX "idx_branch_items_base_item" ON "branch_items" USING btree ("base_item_id");--> statement-breakpoint
CREATE INDEX "idx_commit_merge_parent" ON "commits" USING btree ("merge_parent_id");--> statement-breakpoint
CREATE INDEX "idx_conflict_reviews_their_eco" ON "conflict_reviews" USING btree ("their_eco_id");--> statement-breakpoint
CREATE INDEX "idx_item_versions_previous_item" ON "item_versions" USING btree ("previous_item_id");--> statement-breakpoint
ALTER TABLE "parts" DROP COLUMN "quantity_on_hand";--> statement-breakpoint
ALTER TABLE "parts" DROP COLUMN "reorder_point";--> statement-breakpoint
ALTER TABLE "parts" DROP COLUMN "location";--> statement-breakpoint
ALTER TABLE "parts" DROP COLUMN "last_inventory_check";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
CREATE TABLE "ai_write_confirmations" (
	"token_hash" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"tool_name" varchar(100) NOT NULL,
	"params_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_write_confirmations" ADD CONSTRAINT "ai_write_confirmations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_write_confirmations_expires_at_idx" ON "ai_write_confirmations" USING btree ("expires_at");--> statement-breakpoint
DROP INDEX "idx_branch_type";--> statement-breakpoint
DROP INDEX "idx_current";--> statement-breakpoint
DROP INDEX "idx_vault_files_latest";--> statement-breakpoint
DROP INDEX "idx_vault_files_primary";--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "file_size" SET DATA TYPE bigint;--> statement-breakpoint
CREATE INDEX "idx_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_vault_files_latest" ON "vault_files" USING btree ("item_id") WHERE "vault_files"."is_latest_version";--> statement-breakpoint
CREATE INDEX "idx_vault_files_primary" ON "vault_files" USING btree ("item_id") WHERE "vault_files"."is_primary_model";
--> statement-breakpoint
-- Pre-cleanup for uq_instr_exec_open_run.
--
-- The index says one open run per (line, technician, unit label). If any such
-- group already holds more than one 'In Progress' row — which only the
-- pre-index TOCTOU race in InstructionExecutionService.start could produce —
-- keep the newest and abandon the rest, tie-broken on id so the choice is
-- deterministic. Executions are audit records and are never deleted.
--
-- 'Incomplete' is the existing abandon semantic (see abandon() in that
-- service) and is not one of the statuses the countable tally counts, so a
-- duplicate stops inflating the work order's completion gate without
-- disappearing from the run history. completed_at is stamped now(), not the
-- winner's: an auditor reading these rows sees them abandoned at upgrade
-- time, which is when the decision was actually made. The change is visible
-- in run history by design.
--
-- The CHECK below can fail on data instead of adding cleanly, if any row holds
-- a status outside the six legal literals. Nothing writes one — the service
-- takes a typed union — and there is no correct automatic answer for what such
-- a row meant, so it aborts the migration rather than guessing. Migrations
-- apply in a transaction, so a failure here leaves nothing behind.
UPDATE "instruction_executions" AS e
SET "status" = 'Incomplete',
    "completed_at" = now()
WHERE e."status" = 'In Progress'
  AND EXISTS (
    SELECT 1
    FROM "instruction_executions" AS newer
    WHERE newer."work_order_instruction_id" = e."work_order_instruction_id"
      AND newer."executed_by" = e."executed_by"
      AND COALESCE(newer."unit_label", '') = COALESCE(e."unit_label", '')
      AND newer."status" = 'In Progress'
      AND (newer."started_at", newer."id") > (e."started_at", e."id")
  );--> statement-breakpoint
CREATE UNIQUE INDEX "uq_instr_exec_open_run" ON "instruction_executions" USING btree ("work_order_instruction_id","executed_by",COALESCE("unit_label", '')) WHERE "instruction_executions"."status" = 'In Progress';--> statement-breakpoint
ALTER TABLE "instruction_executions" ADD CONSTRAINT "ck_instr_exec_status" CHECK ("instruction_executions"."status" IN ('In Progress', 'Complete', 'Incomplete', 'Pending Approval', 'Approved', 'Rejected'));
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "retry_delays" jsonb;
--> statement-breakpoint
-- Backfill the program a work order belongs to, wherever it can be derived.
--
-- #306 changed what `work_orders.program_id IS NULL` means: it no longer
-- admits every caller who can read work orders, it admits cross-program
-- authority (`programs:manage`) alone. That is the fail-closed reading, but it
-- applies retroactively — `WorkOrderForm` never had a program field and
-- `create` passed the caller's value straight through, so every work order
-- made through the UI before that change carries NULL and would disappear for
-- everyone without `programs:manage` on upgrade.
--
-- A work order names the part it builds, that part is an item that sits in a
-- design, and a design names a program. Where that chain resolves, the answer
-- is not a guess: `work_orders.part_id` and `items.design_id` are both
-- single-valued foreign keys onto primary keys, so at most one program is
-- reachable from any one row. This is the same derivation `create` now does
-- for new rows (`WorkOrderService.deriveProgramId`), applied once to the rows
-- that predate it.
--
-- Deliberately narrow, in three ways:
--
--   * `wo."program_id" IS NULL` — an existing value is never overwritten. An
--     administrator who already repaired a row keeps their answer, and
--     re-running this statement is a no-op.
--   * INNER JOIN — a work order with no part, or a part sitting in no design,
--     derives nothing and is left alone. `items.design_id` is nullable by
--     design (Tasks and Issues do not require one).
--   * `d."program_id" IS NOT NULL` — a Standard Library or unassigned design
--     legitimately has no program, so there is nothing to copy.
--
-- Every row this does not fill stays NULL, and therefore stays reachable by
-- `programs:manage` alone. That is exactly the outcome #306 shipped, narrowed
-- to the rows for which no non-arbitrary answer exists, which is what makes
-- this safe to run unattended: it never invents a program boundary, it only
-- restores one the row's own part already implied.
--
-- Reversible: the sole effect is NULL -> the program that row's part already
-- pointed at. Setting the column back to NULL restores the prior state
-- exactly. No row is deleted, and no other column is written.
UPDATE "work_orders" AS wo
SET "program_id" = d."program_id"
FROM "items" AS p
  JOIN "designs" AS d ON d."id" = p."design_id"
WHERE wo."part_id" = p."id"
  AND wo."program_id" IS NULL
  AND d."program_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "change_orders" ADD COLUMN "description" text;
--> statement-breakpoint
-- Backfill the program an issue belongs to, wherever it can be derived.
--
-- The program gate for issues changes what `issues.program_id IS NULL` means:
-- it stops admitting every caller who can read issues and starts admitting
-- cross-program authority (`programs:manage`) alone. That is the fail-closed
-- reading, but it applies retroactively — `IssueDetail` has never had a
-- program field, and `create` passed the caller's value straight through — so
-- every issue raised through the UI before that change carries NULL and would
-- disappear for everyone without `programs:manage` on upgrade.
--
-- This statement ships one release AHEAD of that gate, deliberately. On its
-- own it is unobservable: it fills NULLs while the access predicate still
-- ignores the column, so nothing a user can see changes. The point is that an
-- install upgrading through this release has the rescue already applied by the
-- time the gate arrives, instead of spending an upgrade window with rows dark.
-- The work-order sequence left that window open; this one does not.
--
-- An issue names the designs it concerns, and a design names a program. That
-- link is many-to-many rather than a single-valued foreign key, so unlike the
-- work-order chain it can resolve to more than one answer — hence the third
-- narrowing below. Where it resolves to exactly one, the answer is not a
-- guess: the reporter picked those designs by hand from a list already scoped
-- to the programs they can reach.
--
-- Deliberately narrow, in three ways:
--
--   * `s."program_id" IS NULL` — an existing value is never overwritten. An
--     administrator who already repaired a row keeps their answer, and
--     re-running this statement is a no-op.
--   * `d."program_id" IS NOT NULL` — a Standard Library or unassigned design
--     legitimately has no program, so there is nothing to copy. An issue whose
--     only links are to such designs derives nothing and is left alone, as is
--     one with no `issue_designs` row at all.
--   * `count(DISTINCT d."program_id") = 1` — an issue whose designs span two
--     programs has no single correct answer, and inventing one would draw a
--     boundary the reporter never drew. It stays NULL.
--
-- Of those three, the middle one is belt-and-braces rather than load-bearing:
-- `count(DISTINCT …)` does not count NULLs, so a library-only issue would fail
-- the HAVING anyway and a library link alongside a real one would already be
-- ignored. It is kept because it says the intent outright, and because without
-- it the value picked out below would depend on where Postgres sorts NULLs in
-- a DISTINCT aggregate — a detail no one should have to know to read this.
--
-- `issue_affected_items` is deliberately NOT joined. The schema and the create
-- handler both write it, but no screen populates it — the issue form seeds an
-- empty list and renders no picker — so it would add a longer join for
-- approximately no rows.
--
-- Every row this does not fill stays NULL, and therefore stays reachable by
-- `programs:manage` alone. That is exactly the outcome the gate ships, narrowed
-- to the rows for which no non-arbitrary answer exists, which is what makes
-- this safe to run unattended: it never invents a program boundary, it only
-- restores one the issue's own designs already implied.
--
-- Expect low coverage in practice, and that is fine: the design picker is
-- labelled optional and nothing in the app pre-fills it, so a minority of rows
-- carry a link at all. The rows it does not reach are the ones an administrator
-- has to name a program for by hand, which is why the gate must not ship
-- without a way to write the column.
--
-- Reversible: the sole effect is NULL -> the program that row's designs already
-- pointed at. Setting the column back to NULL restores the prior state
-- exactly. No row is deleted, and no other column is written.
UPDATE "issues" AS s
SET "program_id" = derived."program_id"
FROM (
  SELECT ln."issue_item_id" AS "issue_item_id",
         -- Exactly one distinct value survives the HAVING, so the array this
         -- indexes into is a singleton by construction.
         (array_agg(DISTINCT d."program_id"))[1] AS "program_id"
  FROM "issue_designs" AS ln
    JOIN "designs" AS d ON d."id" = ln."design_id"
  WHERE d."program_id" IS NOT NULL
  GROUP BY ln."issue_item_id"
  HAVING count(DISTINCT d."program_id") = 1
) AS derived
WHERE s."item_id" = derived."issue_item_id"
  AND s."program_id" IS NULL;
--> statement-breakpoint
-- Resolve duplicates before the unique index can reject them.
--
-- Three writers recorded an item on a change order by reading "not present"
-- and then inserting — `addAffectedItem`, `registerBranchChange` and
-- `checkoutItemToEco` — so two requests interleaving between those two
-- statements both wrote, and the merge went on to process both rows in
-- unspecified table order. Any database that ran those paths concurrently can
-- be carrying such a pair.
--
-- The keep-rule is a total order, so every database resolves a group the same
-- way and the survivor never depends on the planner:
--   1. the row that carries a working copy. The revision edits an engineer
--      has already made hang off `working_copy_id`, and deleting that row
--      strands them somewhere the release will not look. At most one row per
--      group can have one: only the revise path creates them, and that is the
--      path that refuses a duplicate outright rather than skipping it.
--   2. then the oldest `created_at` — the row the reviewers saw first.
--   3. then the lowest `id`, so an exact timestamp tie is still decided.
--
-- (`working_copy_id IS NULL` sorts false before true, which is what makes the
-- row holding a working copy win the first key.)
DELETE FROM "change_order_affected_items" AS d
WHERE d."affected_item_master_id" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "change_order_affected_items" AS keep
    WHERE keep."change_order_id" = d."change_order_id"
      AND keep."affected_item_master_id" = d."affected_item_master_id"
      AND (keep."working_copy_id" IS NULL, keep."created_at", keep."id")
        < (d."working_copy_id" IS NULL, d."created_at", d."id")
  );--> statement-breakpoint
CREATE UNIQUE INDEX "uq_coai_change_order_master" ON "change_order_affected_items" USING btree ("change_order_id","affected_item_master_id") WHERE "change_order_affected_items"."affected_item_master_id" IS NOT NULL;
--> statement-breakpoint
-- Null the stale ECO pointers before the constraint can reject them.
--
-- `commits.change_order_item_id` is the one edge of the versioning graph the
-- DBI-6 foreign-key pass skipped, so it has been a bare uuid for the whole
-- life of the schema while `branches.change_order_item_id` — written from the
-- same ECO id, on the same flows — has been FK-backed since 0001_remediation.
-- A database that hard-deleted an ECO item before that release therefore had
-- its branch pointer nulled by 0001's own pre-cleanup and its commit pointer
-- left dangling: the same residue class, one table later.
--
-- Nulling is the right disposition, and it is exactly what the constraint
-- itself will do from here on. A release commit is history and must outlive
-- the ECO that produced it, so deleting the row is wrong — it would unzip the
-- chain of commits hanging off it — and aborting is wrong too, because no
-- reader depends on the pointer: CommitGraphService, EcoBranchHistoryService
-- and ModelVersionService already render a commit whose pointer is null,
-- simply without an ECO number beside it.
UPDATE "commits" SET "change_order_item_id" = NULL
  WHERE "change_order_item_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "items" i WHERE i."id" = "commits"."change_order_item_id");--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_change_order_item_id_items_id_fk" FOREIGN KEY ("change_order_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_commit_eco" ON "commits" USING btree ("change_order_item_id");
--> statement-breakpoint
-- Collapse duplicate approvers before the unique constraints can reject them.
--
-- Neither approver table has carried a key since it was created, and
-- `addStateApprover` reached one of them the pre-remediation way: SELECT for an
-- existing row, then INSERT. Two requests interleaving between those two
-- statements both wrote, so any database where two administrators configured
-- the same state at once can be carrying such a pair — and nothing on the
-- instance-level table stopped a repeated pair inside one request's array
-- either.
--
-- Gating already behaves as if a pair were one row:
-- `WorkflowApprovalService.mergeApproverLists` keys on (type, id) and ORs the
-- `is_required` flags before anything counts a quorum. The twins are visible
-- instead in the approver list an administrator reads, and in
-- `removeStateApprover`, which deletes by id — so removing an approver left
-- them still approving.
--
-- That merge is also what fixes the keep-rule: the survivor has to be the row
-- gating was already using, or resolving a duplicate would quietly change who
-- must approve. So the keep-rule is a total order, and every database resolves
-- a group the same way rather than however the planner happened to read it:
--   1. the required row, because that is what the OR above produced.
--   2. then the oldest `created_at` — the row the configurer added first.
--   3. then the lowest `id`, so an exact timestamp tie is still decided.
--
-- (`NOT is_required` sorts false before true, which is what makes the required
-- row win the first key.)
DELETE FROM "workflow_instance_approvers" AS d
WHERE EXISTS (
    SELECT 1
    FROM "workflow_instance_approvers" AS keep
    WHERE keep."workflow_instance_id" = d."workflow_instance_id"
      AND keep."state_id" = d."state_id"
      AND keep."approver_type" = d."approver_type"
      AND keep."approver_id" = d."approver_id"
      AND (NOT keep."is_required", keep."created_at", keep."id")
        < (NOT d."is_required", d."created_at", d."id")
  );--> statement-breakpoint
ALTER TABLE "workflow_instance_approvers" ADD CONSTRAINT "uq_wf_instance_approvers" UNIQUE("workflow_instance_id","state_id","approver_type","approver_id");--> statement-breakpoint
DELETE FROM "workflow_state_approvers" AS d
WHERE EXISTS (
    SELECT 1
    FROM "workflow_state_approvers" AS keep
    WHERE keep."workflow_definition_id" = d."workflow_definition_id"
      AND keep."state_id" = d."state_id"
      AND keep."approver_type" = d."approver_type"
      AND keep."approver_id" = d."approver_id"
      AND (NOT keep."is_required", keep."created_at", keep."id")
        < (NOT d."is_required", d."created_at", d."id")
  );--> statement-breakpoint
ALTER TABLE "workflow_state_approvers" ADD CONSTRAINT "uq_wf_state_approvers" UNIQUE("workflow_definition_id","state_id","approver_type","approver_id");

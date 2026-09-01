-- Consolidated: the schema changes of the post-review hardening wave, in
-- one file — the real constraints behind the vault-thumbnail and API-key
-- lookups (with the pre-cleanup that repairs existing rows first), the
-- foreign-key renames that fit Postgres's 63-byte identifier limit, and the
-- conflict-review uniqueness drop that makes acknowledgements append-only.
--
-- None of the folded migrations was ever published, so none can be sitting
-- applied in an install that upgrades. Statement order is preserved exactly;
-- this is a concatenation, not a regenerated diff. The journal entry keeps
-- the LAST folded migration's timestamp, which is what draws the skip line
-- correctly — see docs/deployment/upgrading.md, "Consolidating unpublished
-- migrations", for why the first one would not.
-- Pre-cleanup: NULL any thumbnail pointer whose target row no longer exists,
-- so ADD CONSTRAINT validates on databases that accumulated dangling pointers
-- while thumbnail_file_id was a bare uuid. The residue is reachable rather
-- than theoretical: permanentlyDeleteFile removes the row outright, and the
-- schema comment claiming this FK was "added via raw SQL migration" was never
-- true of any migration in either edition.
UPDATE "vault_files" SET "thumbnail_file_id" = NULL WHERE "thumbnail_file_id" IS NOT NULL AND "thumbnail_file_id" NOT IN (SELECT "id" FROM "vault_files");--> statement-breakpoint
-- Pre-cleanup: "at most one thumbnail per item" was a comment the database did
-- nothing about, and setItemThumbnail cleared the old flag and set the new one
-- as two separate statements — so an item can already carry more than one
-- flagged file. Keep the newest by (uploaded_at, id), which is the one a person
-- most recently designated and the outcome the racing writers were reaching
-- for, and clear the rest. The item's thumbnail does not change unless it was
-- already ambiguous.
UPDATE "vault_files" SET "is_item_thumbnail" = false
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           row_number() OVER (
             PARTITION BY "item_id"
             ORDER BY "uploaded_at" DESC, "id" DESC
           ) AS "rn"
      FROM "vault_files"
     WHERE "is_item_thumbnail"
  ) ranked
  WHERE ranked."rn" > 1
);--> statement-breakpoint
DROP INDEX "idx_vault_files_item_thumbnail";--> statement-breakpoint
ALTER TABLE "vault_files" ADD CONSTRAINT "vault_files_thumbnail_file_id_vault_files_id_fk" FOREIGN KEY ("thumbnail_file_id") REFERENCES "public"."vault_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_vault_files_item_thumbnail" ON "vault_files" USING btree ("item_id") WHERE "vault_files"."is_item_thumbnail";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_api_keys_key_hash" ON "api_keys" USING btree ("key_hash");
--> statement-breakpoint
-- Seventeen foreign keys carried the implicit name drizzle derives, which
-- for these ran 68-82 bytes. Postgres truncates every identifier at 63, so
-- what the migrations asked for and what the database actually holds have
-- never been the same string: each ADD CONSTRAINT emitted a 42622 NOTICE and
-- stored the 63-byte prefix. Nothing referenced the names, so nothing broke
-- — but the schema described constraints no database had, and two names
-- differing only past byte 63 would have collided outright.
--
-- These are RENAMEs rather than the DROP + ADD pairs drizzle-kit generates.
-- A rename rewrites one catalog row; a re-ADD would re-validate every row of
-- these tables under an ACCESS EXCLUSIVE lock — on both sides of each key —
-- for a change that alters the meaning of no constraint.
--
-- Each RENAME names the *long* form of the old constraint. That is
-- deliberate and works on every install: Postgres truncates identifiers in
-- SQL text exactly as it did when the constraint was created, so the long
-- name resolves to the same 63-byte prefix everywhere — on a database
-- baselined from the 0000 migration, on one created by an early db:push, and
-- on a fresh database that replays 0000 immediately before this file. It
-- costs one more 42622 NOTICE per statement, once, and reads as the name the
-- earlier migrations wrote.
ALTER TABLE "change_order_affected_items" RENAME CONSTRAINT "change_order_affected_items_change_order_id_change_orders_item_id_fk" TO "fk_coai_change_order";--> statement-breakpoint
ALTER TABLE "change_order_impact_reports" RENAME CONSTRAINT "change_order_impact_reports_change_order_id_change_orders_item_id_fk" TO "fk_co_impact_report_change_order";--> statement-breakpoint
ALTER TABLE "change_order_impacted_items" RENAME CONSTRAINT "change_order_impacted_items_change_order_id_change_orders_item_id_fk" TO "fk_co_impacted_change_order";--> statement-breakpoint
ALTER TABLE "work_instruction_change_alerts" RENAME CONSTRAINT "work_instruction_change_alerts_work_instruction_id_work_instructions_item_id_fk" TO "fk_wi_alert_wi";--> statement-breakpoint
ALTER TABLE "work_instruction_operations" RENAME CONSTRAINT "work_instruction_operations_work_instruction_id_work_instructions_item_id_fk" TO "fk_wi_operation_wi";--> statement-breakpoint
ALTER TABLE "work_instruction_part_attachments" RENAME CONSTRAINT "work_instruction_part_attachments_work_instruction_id_work_instructions_item_id_fk" TO "fk_wi_part_attach_wi";--> statement-breakpoint
ALTER TABLE "work_instruction_steps" RENAME CONSTRAINT "work_instruction_steps_work_instruction_id_work_instructions_item_id_fk" TO "fk_wi_step_wi";--> statement-breakpoint
ALTER TABLE "work_instruction_steps" RENAME CONSTRAINT "work_instruction_steps_operation_id_work_instruction_operations_id_fk" TO "fk_wi_step_operation";--> statement-breakpoint
ALTER TABLE "instruction_executions" RENAME CONSTRAINT "instruction_executions_work_order_instruction_id_work_order_instructions_id_fk" TO "fk_instr_exec_line";--> statement-breakpoint
ALTER TABLE "work_order_instructions" RENAME CONSTRAINT "work_order_instructions_work_instruction_id_work_instructions_item_id_fk" TO "fk_wo_instruction_template";--> statement-breakpoint
ALTER TABLE "workflow_approval_votes" RENAME CONSTRAINT "workflow_approval_votes_workflow_instance_id_workflow_instances_id_fk" TO "fk_wf_votes_instance";--> statement-breakpoint
ALTER TABLE "workflow_instance_approvers" RENAME CONSTRAINT "workflow_instance_approvers_workflow_instance_id_workflow_instances_id_fk" TO "fk_wf_instance_approvers_instance";--> statement-breakpoint
ALTER TABLE "workflow_instances" RENAME CONSTRAINT "workflow_instances_workflow_definition_id_workflow_definitions_id_fk" TO "fk_wf_instances_definition";--> statement-breakpoint
ALTER TABLE "workflow_state_approvers" RENAME CONSTRAINT "workflow_state_approvers_workflow_definition_id_workflow_definitions_id_fk" TO "fk_wf_state_approvers_definition";--> statement-breakpoint
ALTER TABLE "part_manufacturer_parts" RENAME CONSTRAINT "part_manufacturer_parts_manufacturer_part_id_manufacturer_parts_id_fk" TO "fk_part_mfr_parts_mfr_part";--> statement-breakpoint
ALTER TABLE "component_catalog_entries" RENAME CONSTRAINT "component_catalog_entries_category_id_component_catalog_categories_id_fk" TO "fk_catalog_entry_category";--> statement-breakpoint
ALTER TABLE "component_catalog_media" RENAME CONSTRAINT "component_catalog_media_component_id_component_catalog_entries_id_fk" TO "fk_catalog_media_component";
--> statement-breakpoint
ALTER TABLE "conflict_reviews" DROP CONSTRAINT "conflict_reviews_unique";

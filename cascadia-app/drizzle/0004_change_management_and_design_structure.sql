-- Consolidated: this wave's two unpublished migrations in one file — the
-- change-management remediation (itself a fold of four) and the
-- design-structure designation. The public repository carries 0000-0003 and
-- nothing after them, so neither of the folded files can be sitting applied
-- in an install that upgrades; that is the condition that makes this a fold
-- rather than an edit.
--
-- Statement order is preserved exactly; this is a concatenation, not a
-- regenerated diff. The journal entry keeps the LAST folded migration's
-- timestamp, which is what draws the skip line correctly — see
-- docs/deployment/upgrading.md, "Consolidating unpublished migrations", for
-- why the first one would not.
--
-- The notes below were each written when their own file was all there was,
-- and the first of them describes a fold of its own. Read them section by
-- section. Both halves leave a mark in the schema — lifecycle_type is
-- tightened in the first, items.in_design_structure in the second — so this
-- is not a data-only migration, and db:baseline places a database at it
-- rather than stopping before it. That is why every row statement here is
-- still guarded: a database carrying their effect but not the schema mark
-- re-runs them, so each one has to do nothing the second time.
-- Consolidated: the row changes of the change-management remediation, in one
-- file — the change-order vocabulary rename (the two shipped definitions and
-- the program-settings key), the item-type config key workflowsByChangeType
-- becoming lifecyclesByChangeType, the lifecycle_type column becoming the one
-- source of truth, and the workflows permission resource becoming lifecycles
-- in role maps and API-key scopes.
--
-- None of the folded migrations was ever published, so none can be sitting
-- applied in an install that upgrades. Statement order is preserved exactly;
-- this is a concatenation, not a regenerated diff. The journal entry keeps
-- the LAST folded migration's timestamp, which is what draws the skip line
-- correctly — see docs/deployment/upgrading.md, "Consolidating unpublished
-- migrations", for why the first one would not.
--
-- Three of the four folded files changed rows and nothing else, and the notes
-- below still say so, section by section — each was written when its own file
-- was all there was. Read them that way. Taken as a whole this file also
-- carries the lifecycle_type DROP DEFAULT and SET NOT NULL, so it does leave a
-- mark in the schema, and db:baseline places a database at it rather than
-- stopping before it. What the fold does not change is why every row statement
-- is guarded: a database carrying their effect but not the schema mark still
-- re-runs them, so each one has to do nothing the second time.
-- The rows the ECO -> change-order rename touches (remediation plan, CM-20
-- and CM-21). Nothing here changes the schema, so `db:baseline` cannot see
-- whether it has run and leaves it for `db:migrate` — every statement is
-- therefore guarded to do nothing the second time.
--
-- One name for each shipped Driving definition (Decision 7). The strict
-- definition was "ECO - Default Workflow" though it serves ECO, ECN, MCO and
-- Deviation alike; the flexible one was "Dynamic Change Order" in the seed and
-- "XCO - Flexible Change Order" in the form that offers it. Renamed by their
-- fixed ids, and only while they still carry the shipped name: a definition
-- an administrator renamed keeps that name. Names are display-only; nothing
-- resolves a definition by name.
UPDATE "workflow_definitions" SET "name" = 'Change Order - Standard' WHERE "id" = '00000000-0000-4000-8000-000000000102' AND "name" = 'ECO - Default Workflow';--> statement-breakpoint
UPDATE "workflow_definitions" SET "name" = 'XCO - Flexible Change Order' WHERE "id" = '00000000-0000-4000-8000-000000000103' AND "name" = 'Dynamic Change Order';--> statement-breakpoint
-- The program-settings key `ecoNumberFormat` becomes `changeOrderNumberFormat`.
-- Stored in the `settings` JSONB, not in the v1 snapshot, read by nothing yet
-- — moved rather than duplicated, for the rows that carry it.
UPDATE "programs" SET "settings" = ("settings" - 'ecoNumberFormat') || jsonb_build_object('changeOrderNumberFormat', "settings"->'ecoNumberFormat') WHERE "settings" ? 'ecoNumberFormat';
--> statement-breakpoint
-- The item-type config key `workflowsByChangeType` becomes
-- `lifecyclesByChangeType` (remediation plan CM-25). It lives in the `config`
-- JSONB of `item_type_configs` and is not in the v1 snapshot. Nothing here
-- changes the schema, so `db:baseline` cannot see whether it has run and
-- leaves it for `db:migrate` — both statements are guarded to do nothing the
-- second time.
--
-- A row carrying only the old key has it moved; a row carrying both (written
-- by a build that already knew the new key) keeps the new one and loses the
-- old; a row carrying neither is untouched.
UPDATE "item_type_configs" SET "config" = ("config" - 'workflowsByChangeType') || jsonb_build_object('lifecyclesByChangeType', "config"->'workflowsByChangeType') WHERE "config" ? 'workflowsByChangeType' AND NOT ("config" ? 'lifecyclesByChangeType');--> statement-breakpoint
UPDATE "item_type_configs" SET "config" = "config" - 'workflowsByChangeType' WHERE "config" ? 'workflowsByChangeType';
--> statement-breakpoint
-- One source of truth for a definition's lifecycle type (remediation plan
-- CM-26). Since the unified model shipped, the kind was written to the
-- `lifecycle_type` column and to the `definition` JSONB, and read JSONB-first
-- because the column's ADD-COLUMN default stamped legacy rows 'Free'. The
-- column becomes the truth: backfilled the way the code resolved it — the
-- JSONB's own `lifecycleType`, else the legacy `definitionType` ('lifecycle'
-- was Driven, 'workflow' was Driving), else the column, else Free — then
-- made NOT NULL with no default, then the two JSONB keys are dropped. Each
-- statement does nothing the second time.
UPDATE "workflow_definitions" SET "lifecycle_type" = CASE
  WHEN "definition"->>'lifecycleType' IN ('Free', 'Driven', 'Driving') THEN ("definition"->>'lifecycleType')::"lifecycle_type"
  WHEN "definition"->>'definitionType' = 'lifecycle' THEN 'Driven'::"lifecycle_type"
  WHEN "definition"->>'definitionType' = 'workflow' THEN 'Driving'::"lifecycle_type"
  WHEN "definition" ? 'lifecycleType' OR "definition" ? 'definitionType' THEN 'Free'::"lifecycle_type"
  ELSE COALESCE("lifecycle_type", 'Free'::"lifecycle_type")
END WHERE "definition" ? 'lifecycleType' OR "definition" ? 'definitionType' OR "lifecycle_type" IS NULL;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ALTER COLUMN "lifecycle_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ALTER COLUMN "lifecycle_type" SET NOT NULL;--> statement-breakpoint
UPDATE "workflow_definitions" SET "definition" = "definition" - 'lifecycleType' - 'definitionType' WHERE "definition" ? 'lifecycleType' OR "definition" ? 'definitionType';
--> statement-breakpoint
-- The permission resource `workflows` becomes `lifecycles` (remediation plan
-- CM-27, Decision 4): the roles API enumerates no resource names, so the
-- rename need not wait for v2. Role rows and API-key scopes both store
-- `{ resource: [actions] }`. The key moves on rows that carry it; a row
-- carrying both keeps the new one and loses the old. Nothing here changes
-- the schema, so `db:baseline` leaves it for `db:migrate` — every statement
-- is guarded to do nothing the second time.
UPDATE "roles" SET "permissions" = ("permissions" - 'workflows') || jsonb_build_object('lifecycles', "permissions"->'workflows') WHERE "permissions" ? 'workflows' AND NOT ("permissions" ? 'lifecycles');--> statement-breakpoint
UPDATE "roles" SET "permissions" = "permissions" - 'workflows' WHERE "permissions" ? 'workflows';--> statement-breakpoint
UPDATE "api_keys" SET "permissions" = ("permissions" - 'workflows') || jsonb_build_object('lifecycles', "permissions"->'workflows') WHERE "permissions" ? 'workflows' AND NOT ("permissions" ? 'lifecycles');--> statement-breakpoint
UPDATE "api_keys" SET "permissions" = "permissions" - 'workflows' WHERE "permissions" ? 'workflows';
--> statement-breakpoint
-- A part is a top-level part of its design's structure only because something
-- designated it — creation in the design, a usage copy's root, "Add to
-- Structure" — and nesting it under a parent in its own design withdraws
-- that. Until now every part was born a top-level part (default true) and
-- stayed one for as long as nothing pointed at it, so a child whose BOM line
-- was removed surfaced as a root nobody chose.
--
-- The backfill applies the new rule to the rows that exist: a Part that a BOM
-- line in its own design nests loses the designation. A line counts when its
-- source row is one a structure view resolves to — a current row carrying a
-- real revision (main's view), or a working copy on the same branch as the
-- part's own working copy (that branch's view). A line owned only by a
-- superseded revision is history and nests nothing; a line owned only by a
-- branch's working copy and pointing at a main row is that branch's business
-- until it releases, when the merge clears the row. The same rule, as one
-- statement, lives in packages/core/src/lib/items/design-structure-designation.ts,
-- which the demo seeds run over the rows they insert — keep the two in step.
--
-- Both UPDATEs write only rows still designated and the two ALTERs are
-- idempotent, so the file does nothing the second time.
UPDATE "items" SET "in_design_structure" = false WHERE "in_design_structure" IS NULL;--> statement-breakpoint
UPDATE "items" AS t SET "in_design_structure" = false
WHERE t."item_type" = 'Part'
  AND t."in_design_structure" = true
  AND EXISTS (
    SELECT 1
    FROM "item_relationships" r
    JOIN "items" s ON s."id" = r."source_id"
    JOIN "items" tv ON tv."id" = r."target_id"
    WHERE r."relationship_type" = 'BOM'
      AND tv."master_id" = t."master_id"
      AND s."design_id" = t."design_id"
      AND (s."is_deleted" = false OR s."is_deleted" IS NULL)
      AND (
        (s."is_current" = true
          AND s."revision" NOT LIKE '-%'
          AND s."revision" <> 'DRAFT'
          AND s."revision" <> '')
        OR EXISTS (
          SELECT 1
          FROM "branch_items" bs
          JOIN "branch_items" bt ON bt."branch_id" = bs."branch_id"
          WHERE bs."current_item_id" = s."id"
            AND bt."current_item_id" = t."id"
            AND bs."change_type" IS NOT NULL
            AND bt."change_type" IS NOT NULL
        )
      )
  );--> statement-breakpoint
ALTER TABLE "items" ALTER COLUMN "in_design_structure" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "items" ALTER COLUMN "in_design_structure" SET NOT NULL;

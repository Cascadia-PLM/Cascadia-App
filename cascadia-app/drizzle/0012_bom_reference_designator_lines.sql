DROP INDEX "item_relationships_fixed_edge_unique";--> statement-breakpoint
DROP INDEX "item_relationships_fixed_make_edge_unique";--> statement-breakpoint
DROP INDEX "item_relationships_option_edge_unique";--> statement-breakpoint
DROP INDEX "item_relationships_option_make_edge_unique";--> statement-breakpoint
-- Reference designators become part of a BOM line's identity, compared as
-- stored, so store them the way the app now writes them: trimmed, a blank as
-- null. Cannot collide: every row was already unique without the column.
UPDATE "item_relationships" SET "reference_designator" = NULLIF(btrim("reference_designator", E' \t\r\n'), '') WHERE "reference_designator" IS DISTINCT FROM NULLIF(btrim("reference_designator", E' \t\r\n'), '');--> statement-breakpoint
CREATE UNIQUE INDEX "item_relationships_edge_unique" ON "item_relationships" USING btree ("source_id","target_id","relationship_type",COALESCE("option", '{}'::jsonb),COALESCE("target_make_code", ''),(CASE WHEN "relationship_type" = 'BOM' THEN COALESCE("reference_designator", '') ELSE '' END));
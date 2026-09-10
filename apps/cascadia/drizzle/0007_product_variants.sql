ALTER TABLE "item_relationships" DROP CONSTRAINT "item_relationships_source_id_target_id_relationship_type_unique";--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN "configuration" jsonb;--> statement-breakpoint
ALTER TABLE "item_relationships" ADD COLUMN "option" jsonb;--> statement-breakpoint
ALTER TABLE "item_relationships" ADD COLUMN "target_make_code" varchar(50);--> statement-breakpoint
ALTER TABLE "parts" ADD COLUMN "option_model" jsonb;--> statement-breakpoint
ALTER TABLE "parts" ADD COLUMN "makes" jsonb;--> statement-breakpoint
ALTER TABLE "parts" ADD COLUMN "product_family_code" varchar(100);--> statement-breakpoint
ALTER TABLE "parts" ADD COLUMN "variant_code" varchar(50);--> statement-breakpoint
CREATE UNIQUE INDEX "item_relationships_fixed_edge_unique" ON "item_relationships" USING btree ("source_id","target_id","relationship_type") WHERE "item_relationships"."option" IS NULL AND "item_relationships"."target_make_code" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "item_relationships_fixed_make_edge_unique" ON "item_relationships" USING btree ("source_id","target_id","relationship_type","target_make_code") WHERE "item_relationships"."option" IS NULL AND "item_relationships"."target_make_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "item_relationships_option_edge_unique" ON "item_relationships" USING btree ("source_id","target_id","relationship_type","option") WHERE "item_relationships"."option" IS NOT NULL AND "item_relationships"."target_make_code" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "item_relationships_option_make_edge_unique" ON "item_relationships" USING btree ("source_id","target_id","relationship_type","option","target_make_code") WHERE "item_relationships"."option" IS NOT NULL AND "item_relationships"."target_make_code" IS NOT NULL;
CREATE TABLE "issue_affected_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_item_id" uuid NOT NULL,
	"affected_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_issue_affected_item" UNIQUE("issue_item_id","affected_item_id")
);
--> statement-breakpoint
CREATE TABLE "issue_designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_item_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_issue_design" UNIQUE("issue_item_id","design_id")
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"tool_type" varchar(50),
	"tool_subtype" varchar(50),
	"manufacturer" varchar(200),
	"model" varchar(200),
	"capabilities" jsonb,
	"tool_status" varchar(20) DEFAULT 'available',
	"location" varchar(500),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "design_session_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"stage" varchar(50) NOT NULL,
	"seq" integer NOT NULL,
	"artifacts" jsonb NOT NULL,
	"llm_history_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "component_catalog_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_catalog_categories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "component_catalog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid NOT NULL,
	"entry_type" text DEFAULT 'component' NOT NULL,
	"dimensions" jsonb,
	"mounting_features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"electrical" jsonb,
	"specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stock_sizes" jsonb,
	"suppliers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"design_notes" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"verified" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "component_catalog_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"component_id" uuid NOT NULL,
	"type" text NOT NULL,
	"file_id" uuid NOT NULL,
	"label" text,
	"sort_order" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"key_hash" varchar(255) NOT NULL,
	"key_prefix" varchar(12) NOT NULL,
	"permissions" jsonb,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "idx_issue_design_ids";--> statement-breakpoint
ALTER TABLE "designs" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "issue_affected_items" ADD CONSTRAINT "issue_affected_items_issue_item_id_issues_item_id_fk" FOREIGN KEY ("issue_item_id") REFERENCES "public"."issues"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_affected_items" ADD CONSTRAINT "issue_affected_items_affected_item_id_items_id_fk" FOREIGN KEY ("affected_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_designs" ADD CONSTRAINT "issue_designs_issue_item_id_issues_item_id_fk" FOREIGN KEY ("issue_item_id") REFERENCES "public"."issues"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_designs" ADD CONSTRAINT "issue_designs_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_session_snapshots" ADD CONSTRAINT "design_session_snapshots_session_id_design_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."design_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_catalog_entries" ADD CONSTRAINT "component_catalog_entries_category_id_component_catalog_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."component_catalog_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "component_catalog_media" ADD CONSTRAINT "component_catalog_media_component_id_component_catalog_entries_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."component_catalog_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_issue_affected_items_issue" ON "issue_affected_items" USING btree ("issue_item_id");--> statement-breakpoint
CREATE INDEX "idx_issue_affected_items_item" ON "issue_affected_items" USING btree ("affected_item_id");--> statement-breakpoint
CREATE INDEX "idx_issue_designs_issue" ON "issue_designs" USING btree ("issue_item_id");--> statement-breakpoint
CREATE INDEX "idx_issue_designs_design" ON "issue_designs" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "design_session_snapshots_session_id_idx" ON "design_session_snapshots" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "design_session_snapshots_session_stage_idx" ON "design_session_snapshots" USING btree ("session_id","stage");--> statement-breakpoint
CREATE INDEX "idx_catalog_categories_parent" ON "component_catalog_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_catalog_categories_slug" ON "component_catalog_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_catalog_fts" ON "component_catalog_entries" USING gin (to_tsvector('simple',
        coalesce("name", '') || ' ' ||
        coalesce("description", '') || ' ' ||
        coalesce("design_notes", '')));--> statement-breakpoint
CREATE INDEX "idx_catalog_tags" ON "component_catalog_entries" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "idx_catalog_category" ON "component_catalog_entries" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_catalog_entry_type" ON "component_catalog_entries" USING btree ("entry_type");--> statement-breakpoint
CREATE INDEX "idx_catalog_media_component" ON "component_catalog_media" USING btree ("component_id");--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "affected_item_ids";--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "design_ids";
CREATE TABLE "architecture_layouts" (
	"design_id" uuid PRIMARY KEY NOT NULL,
	"positions" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "interfaces" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"interface_kind" varchar(20),
	"description" text
);
--> statement-breakpoint
ALTER TABLE "system_elements" ADD COLUMN "ports" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "architecture_layouts" ADD CONSTRAINT "architecture_layouts_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "architecture_layouts" ADD CONSTRAINT "architecture_layouts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interfaces" ADD CONSTRAINT "interfaces_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_interfaces_kind" ON "interfaces" USING btree ("interface_kind");--> statement-breakpoint
-- Interfaces: what joins system elements, as an item type of its own.
--
-- The `interfaces` table above is the Interface item type's own row, one per
-- item version like every type-specific table; what an interface joins is
-- its CONNECTS edges in item_relationships and needs no columns here.
--
-- The default Interface lifecycle — the System Element definition scoped to
-- the type, with the seed's layout — and its item-type link land below.
-- Upgrades never re-seed, so a migration is where an existing database gets
-- them; both statements are guarded, so a fresh install the seed already
-- wrote re-runs them to no effect. The link records who wrote it, so it is
-- written only where the seed's system user exists; without it the registry
-- falls back to the definition id the code carries for the type.
--
-- No role is touched: an interface is held against `system_elements`, the
-- resource the roles already carry.
INSERT INTO "workflow_definitions" ("id", "name", "version", "workflow_type", "definition", "is_active", "lifecycle_type", "drivers")
VALUES ('00000000-0000-4000-8000-000000000116', 'Interface - Default Lifecycle', 1, 'strict', $json${"states":[{"id":"Draft","name":"Draft","description":"Item is being created or edited","color":"gray","isInitial":true,"isFinal":false,"position":{"x":170,"y":20}},{"id":"Released","name":"Released","description":"Item is released for use","color":"green","isInitial":false,"isFinal":false,"position":{"x":170,"y":220}},{"id":"Superseded","name":"Superseded","description":"Replaced by a newer revision","color":"slate","isInitial":false,"isFinal":true,"position":{"x":20,"y":420}},{"id":"Obsolete","name":"Obsolete","description":"Item is no longer used","color":"red","isInitial":false,"isFinal":true,"position":{"x":320,"y":420}}],"transitions":[],"changeActionMappings":{"release":{"fromState":"Draft","toState":"Released","assignsRevision":true},"revise":{"fromState":"Released","newVersionState":"Released","oldVersionState":"Superseded","assignsRevision":true},"obsolete":{"fromState":"Released","toState":"Obsolete","assignsRevision":false}},"lifecycleType":"Driven","description":"Interface lifecycle. Release, revision and obsolescence go through ECOs, as for System Elements.","applicableItemTypes":["Interface"]}$json$::jsonb, true, 'Driven', '[]'::jsonb)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "item_type_configs" ("item_type", "config", "modified_by")
SELECT 'Interface', '{"lifecycleDefinitionId":"00000000-0000-4000-8000-000000000116"}'::jsonb, u."id"
FROM "users" u WHERE u."id" = '00000000-0000-4000-8000-000000000000'
ON CONFLICT ("item_type") DO NOTHING;

CREATE TABLE "software" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"description" text,
	"software_type" varchar(30),
	"source_mode" varchar(20) DEFAULT 'internal' NOT NULL,
	"version" varchar(50),
	"target_hardware" varchar(200),
	"toolchain" varchar(200),
	"manifest_id" uuid,
	"build_artifact_file_id" uuid
);
--> statement-breakpoint
CREATE TABLE "software_blobs" (
	"hash" varchar(64) PRIMARY KEY NOT NULL,
	"content" text,
	"vault_file_id" uuid,
	"size" integer NOT NULL,
	"is_binary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "software_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entries" jsonb NOT NULL,
	"file_count" integer NOT NULL,
	"total_size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "software" ADD CONSTRAINT "software_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software" ADD CONSTRAINT "software_manifest_id_software_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."software_manifests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "software_manifests" ADD CONSTRAINT "software_manifests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_software_manifest" ON "software" USING btree ("manifest_id");
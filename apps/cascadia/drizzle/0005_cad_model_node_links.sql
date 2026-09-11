CREATE TABLE "cad_model_node_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assembly_master_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"part_master_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cad_model_node_links" ADD CONSTRAINT "cad_model_node_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cad_model_node_links_node" ON "cad_model_node_links" USING btree ("assembly_master_id","node_key");--> statement-breakpoint
CREATE INDEX "idx_cad_model_node_links_part" ON "cad_model_node_links" USING btree ("part_master_id");
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
CREATE TABLE "design_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ai_chat_session_id" uuid,
	"program_id" uuid NOT NULL,
	"design_id" uuid,
	"title" varchar(255),
	"stage" varchar(50) DEFAULT 'idle' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"description" text,
	"artifacts" jsonb,
	"llm_history" jsonb,
	"pending_guidance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_stream_id" uuid,
	"stream_claimed_at" timestamp with time zone,
	"materialization_journal" jsonb,
	"artifacts_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"materialized_design_id" uuid,
	"error_message" text,
	"forked_from_session_id" uuid
);
--> statement-breakpoint
ALTER TABLE "design_session_snapshots" ADD CONSTRAINT "design_session_snapshots_session_id_design_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."design_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_ai_chat_session_id_ai_chat_sessions_id_fk" FOREIGN KEY ("ai_chat_session_id") REFERENCES "public"."ai_chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_materialized_design_id_designs_id_fk" FOREIGN KEY ("materialized_design_id") REFERENCES "public"."designs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_forked_from_session_id_design_sessions_id_fk" FOREIGN KEY ("forked_from_session_id") REFERENCES "public"."design_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_session_snapshots_session_id_idx" ON "design_session_snapshots" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "design_session_snapshots_session_stage_idx" ON "design_session_snapshots" USING btree ("session_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_design_snapshots_session_seq" ON "design_session_snapshots" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "design_sessions_user_id_idx" ON "design_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "design_sessions_program_id_idx" ON "design_sessions" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "design_sessions_status_idx" ON "design_sessions" USING btree ("status");
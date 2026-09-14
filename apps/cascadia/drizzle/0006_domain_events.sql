CREATE SEQUENCE "public"."domain_events_sequence" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint,
	"type" varchar(100) NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"subject_type" varchar(50),
	"subject_id" uuid,
	"subject_master_id" uuid,
	"program_id" uuid,
	"design_id" uuid,
	"branch_id" uuid,
	"payload" jsonb NOT NULL,
	"correlation_id" uuid,
	"causation_id" uuid,
	CONSTRAINT "domain_events_seq_unique" UNIQUE("seq")
);
--> statement-breakpoint
CREATE TABLE "event_consumers" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"last_error_seq" bigint,
	"next_attempt_at" timestamp with time zone,
	"parked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_domain_events_type_seq" ON "domain_events" USING btree ("type","seq");--> statement-breakpoint
CREATE INDEX "idx_domain_events_subject_master" ON "domain_events" USING btree ("subject_master_id");--> statement-breakpoint
CREATE INDEX "idx_domain_events_design" ON "domain_events" USING btree ("design_id");
--> statement-breakpoint
-- Commit-order sequencing for domain_events.seq. Mirrors
-- packages/core/src/lib/events/sequencing.ts, which every emitting process
-- also runs at boot (drizzle-kit cannot express triggers, so push-provisioned
-- databases get it from there). Both are idempotent.
CREATE OR REPLACE FUNCTION domain_events_assign_seq() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1163284052);
  UPDATE domain_events
     SET seq = nextval('domain_events_sequence')
   WHERE id = NEW.id AND seq IS NULL;
  RETURN NULL;
END
$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'domain_events_assign_seq'
       AND tgrelid = 'domain_events'::regclass
  ) THEN
    CREATE CONSTRAINT TRIGGER domain_events_assign_seq
      AFTER INSERT ON domain_events
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION domain_events_assign_seq();
  END IF;
END
$$;
--> statement-breakpoint
-- Folded in by stage 3 (retention's give-up horizon). This migration is
-- the wave's single new one per edition, so later stages append here
-- rather than minting their own — see the consolidation rule.
ALTER TABLE "event_consumers" ADD COLUMN "abandoned_at" timestamp with time zone;--> statement-breakpoint
-- Folded in by stage 7a (webhook subscriptions and the delivery log). This
-- migration is the wave's single new one per edition, so later stages append
-- here rather than minting their own -- see the consolidation rule.
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_seq" bigint NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"body" text NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"response_status" integer,
	"response_snippet" text,
	"error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_subscription_event_unique" UNIQUE("subscription_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"target_url" text NOT NULL,
	"event_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"program_id" uuid,
	"encrypted_secret" text,
	"secret_prefix" varchar(12),
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"delivery_lease_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_from_seq" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_pending" ON "webhook_deliveries" USING btree ("subscription_id","status","event_seq");--> statement-breakpoint
CREATE INDEX "idx_webhook_subscriptions_live" ON "webhook_subscriptions" USING btree ("deleted_at","enabled");--> statement-breakpoint
-- Folded in by the job dedupe-key fix. This wave's single migration per edition
-- is 0006, and the wave is unpublished, so it appends here rather than minting
-- an 0007. Additive: a nullable column and a PARTIAL unique index over the keys
-- live or finished work holds, so existing rows -- all of which have no key --
-- neither pay for the index nor collide with each other, and a failed or
-- cancelled job releases its key for the same work to be submitted again.
ALTER TABLE "jobs" ADD COLUMN "dedupe_key" varchar(200);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_jobs_dedupe_key" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."dedupe_key" IS NOT NULL AND "jobs"."status" NOT IN ('failed', 'cancelled');--> statement-breakpoint
-- Folded in by the webhook retention and delivery-log fixes. Three indexes on
-- webhook_deliveries: the delivery log's pages, one subscription's rows by seq,
-- which the pending index cannot serve with status between its columns; and
-- retention's two scans, settled rows and pending rows by age. Additive.
CREATE INDEX "idx_webhook_deliveries_log" ON "webhook_deliveries" USING btree ("subscription_id","event_seq","id");--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_settled_updated" ON "webhook_deliveries" USING btree ("updated_at") WHERE "webhook_deliveries"."status" <> 'pending';--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_pending_created" ON "webhook_deliveries" USING btree ("created_at") WHERE "webhook_deliveries"."status" = 'pending';

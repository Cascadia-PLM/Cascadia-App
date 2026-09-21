ALTER TABLE "software" ADD COLUMN "external_repository_url" text;--> statement-breakpoint
ALTER TABLE "software" ADD COLUMN "external_ref" varchar(300);--> statement-breakpoint
ALTER TABLE "software" ADD COLUMN "external_commit_sha" varchar(64);

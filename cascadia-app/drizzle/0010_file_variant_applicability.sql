ALTER TABLE "vault_files" ADD COLUMN "applicability" jsonb;--> statement-breakpoint
CREATE INDEX "idx_vault_files_applicability" ON "vault_files" USING gin ("applicability");
ALTER TABLE "companies" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "deleted_by_type" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "deleted_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "deleted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "deleted_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "deleted_by_type" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "deleted_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "deleted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "deleted_by_run_id" uuid;--> statement-breakpoint
CREATE INDEX "companies_deleted_at_idx" ON "companies" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "issues_deleted_at_idx" ON "issues" USING btree ("deleted_at");

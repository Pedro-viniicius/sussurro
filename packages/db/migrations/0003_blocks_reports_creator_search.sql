CREATE TYPE "public"."report_reason" AS ENUM('spam', 'harassment', 'hate', 'violence', 'sexual', 'self_harm', 'impersonation', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_target_type" AS ENUM('post', 'comment', 'account');--> statement-breakpoint
CREATE TABLE "blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_pkey" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "blocks_not_self_chk" CHECK (blocker_id <> blocked_id)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"target_type" "report_target_type" NOT NULL,
	"target_user_id" uuid NOT NULL,
	"post_id" uuid,
	"comment_id" uuid,
	"reason" "report_reason" NOT NULL,
	"details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_target_chk" CHECK ((target_type = 'post' and comment_id is null)
        or (target_type = 'comment' and post_id is null)
        or (target_type = 'account' and post_id is null and comment_id is null)),
	CONSTRAINT "reports_not_self_chk" CHECK (reporter_id <> target_user_id),
	CONSTRAINT "reports_details_chk" CHECK (details is null or char_length(details) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_blocked_idx" ON "blocks" USING btree ("blocked_id","blocker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_post_key" ON "reports" USING btree ("reporter_id","post_id") WHERE target_type = 'post';--> statement-breakpoint
CREATE UNIQUE INDEX "reports_comment_key" ON "reports" USING btree ("reporter_id","comment_id") WHERE target_type = 'comment';--> statement-breakpoint
CREATE UNIQUE INDEX "reports_account_key" ON "reports" USING btree ("reporter_id","target_user_id") WHERE target_type = 'account';--> statement-breakpoint
CREATE INDEX "reports_created_idx" ON "reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "reports_target_user_idx" ON "reports" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "reports_post_idx" ON "reports" USING btree ("post_id") WHERE post_id is not null;--> statement-breakpoint
CREATE INDEX "reports_comment_idx" ON "reports" USING btree ("comment_id") WHERE comment_id is not null;--> statement-breakpoint
CREATE INDEX "users_creator_handle_prefix_idx" ON "users" USING btree ((handle collate "C")) WHERE account_type = 'creator' and deleted_at is null;
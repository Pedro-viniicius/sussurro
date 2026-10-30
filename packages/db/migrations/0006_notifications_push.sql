CREATE TYPE "public"."notification_type" AS ENUM('post_liked', 'post_commented', 'comment_replied', 'new_followers', 'connection_created');--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"recipient_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"actor_id" uuid,
	"post_id" uuid,
	"comment_id" uuid,
	"count" integer DEFAULT 1 NOT NULL,
	"bucket_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notifications_new_followers_anonymous_chk" CHECK (type <> 'new_followers' or (actor_id is null and post_id is null and comment_id is null and payload = '{}'::jsonb)),
	CONSTRAINT "notifications_actor_chk" CHECK (type = 'new_followers' or actor_id is not null),
	CONSTRAINT "notifications_not_self_chk" CHECK (actor_id is null or actor_id <> recipient_id),
	CONSTRAINT "notifications_post_chk" CHECK ((type in ('post_liked', 'post_commented', 'comment_replied')) = (post_id is not null)),
	CONSTRAINT "notifications_comment_chk" CHECK ((type in ('post_commented', 'comment_replied')) = (comment_id is not null)),
	CONSTRAINT "notifications_bucket_chk" CHECK ((type = 'new_followers') = (bucket_key is not null)),
	CONSTRAINT "notifications_bucket_format_chk" CHECK (bucket_key is null or bucket_key ~ '^nf:[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "notifications_count_chk" CHECK (count >= 1 and (type = 'new_followers' or count = 1))
);
--> statement-breakpoint
CREATE TABLE "push_tickets" (
	"ticket_id" text PRIMARY KEY NOT NULL,
	"push_token_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"expo_token" text NOT NULL,
	"platform" text NOT NULL,
	"refresh_family_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "push_tokens_expo_token_key" UNIQUE("expo_token"),
	CONSTRAINT "push_tokens_platform_chk" CHECK (platform in ('ios', 'android')),
	CONSTRAINT "push_tokens_format_chk" CHECK (char_length(expo_token) <= 255 and expo_token ~ '^Expo(nent)?PushToken\[[^][:space:]]+\]$')
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tickets" ADD CONSTRAINT "push_tickets_push_token_id_push_tokens_id_fk" FOREIGN KEY ("push_token_id") REFERENCES "public"."push_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_recipient_updated_idx" ON "notifications" USING btree ("recipient_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("recipient_id") WHERE read_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_bucket_key" ON "notifications" USING btree ("recipient_id","bucket_key") WHERE bucket_key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_like_key" ON "notifications" USING btree ("recipient_id","actor_id","post_id") WHERE type = 'post_liked';--> statement-breakpoint
CREATE INDEX "notifications_actor_idx" ON "notifications" USING btree ("actor_id") WHERE actor_id is not null;--> statement-breakpoint
CREATE INDEX "notifications_post_idx" ON "notifications" USING btree ("post_id") WHERE post_id is not null;--> statement-breakpoint
CREATE INDEX "notifications_comment_idx" ON "notifications" USING btree ("comment_id") WHERE comment_id is not null;--> statement-breakpoint
CREATE INDEX "notifications_updated_idx" ON "notifications" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "push_tickets_created_idx" ON "push_tickets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "push_tickets_token_idx" ON "push_tickets" USING btree ("push_token_id");--> statement-breakpoint
CREATE INDEX "push_tokens_user_idx" ON "push_tokens" USING btree ("user_id","last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "push_tokens_family_idx" ON "push_tokens" USING btree ("refresh_family_id");
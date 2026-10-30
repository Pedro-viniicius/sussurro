CREATE TYPE "public"."connection_method" AS ENUM('ble', 'qr');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('pending_upload', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('draft', 'processing', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."post_type" AS ENUM('photo', 'text', 'reel');--> statement-breakpoint
CREATE TABLE "connections" (
	"user_a_id" uuid NOT NULL,
	"user_a_type" "account_type" DEFAULT 'personal' NOT NULL,
	"user_b_id" uuid NOT NULL,
	"user_b_type" "account_type" DEFAULT 'personal' NOT NULL,
	"method" "connection_method" NOT NULL,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_pkey" PRIMARY KEY("user_a_id","user_b_id"),
	CONSTRAINT "connections_ordered_pair_chk" CHECK (user_a_id < user_b_id),
	CONSTRAINT "connections_user_a_personal_chk" CHECK (user_a_type = 'personal'),
	CONSTRAINT "connections_user_b_personal_chk" CHECK (user_b_type = 'personal')
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" uuid NOT NULL,
	"follower_type" "account_type" DEFAULT 'personal' NOT NULL,
	"creator_id" uuid NOT NULL,
	"creator_type" "account_type" DEFAULT 'creator' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_pkey" PRIMARY KEY("follower_id","creator_id"),
	CONSTRAINT "follows_follower_personal_chk" CHECK (follower_type = 'personal'),
	CONSTRAINT "follows_creator_creator_chk" CHECK (creator_type = 'creator')
);
--> statement-breakpoint
CREATE TABLE "avatar_uploads" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"incoming_key" text NOT NULL,
	"storage_key" text,
	"status" "media_status" DEFAULT 'pending_upload' NOT NULL,
	"error" text,
	"requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "avatar_uploads_size_chk" CHECK (size_bytes > 0)
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"post_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"parent_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "comments_body_length_chk" CHECK (char_length(body) between 1 and 500),
	CONSTRAINT "comments_not_self_parent_chk" CHECK (parent_id is null or parent_id <> id)
);
--> statement-breakpoint
CREATE TABLE "likes" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "likes_pkey" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "post_media" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"post_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"kind" "media_kind" NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"incoming_key" text NOT NULL,
	"storage_key" text,
	"thumb_key" text,
	"width" integer,
	"height" integer,
	"duration_s" numeric(6, 2),
	"status" "media_status" DEFAULT 'pending_upload' NOT NULL,
	"processor_job_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_media_post_position_key" UNIQUE("post_id","position"),
	CONSTRAINT "post_media_position_chk" CHECK (position between 0 and 3),
	CONSTRAINT "post_media_video_position_chk" CHECK (kind <> 'video' or position = 0),
	CONSTRAINT "post_media_size_chk" CHECK (size_bytes > 0)
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"author_id" uuid NOT NULL,
	"type" "post_type" NOT NULL,
	"caption" text,
	"text" text,
	"status" "post_status" NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "posts_text_type_chk" CHECK ((type = 'text') = (text is not null)),
	CONSTRAINT "posts_text_length_chk" CHECK (text is null or char_length(text) between 1 and 280),
	CONSTRAINT "posts_caption_chk" CHECK (caption is null or (type <> 'text' and char_length(caption) <= 2200)),
	CONSTRAINT "posts_text_published_chk" CHECK (type <> 'text' or status = 'published'),
	CONSTRAINT "posts_published_at_chk" CHECK ((status = 'published') = (published_at is not null)),
	CONSTRAINT "posts_published_at_ms_chk" CHECK (published_at is null or published_at = date_trunc('milliseconds', published_at)),
	CONSTRAINT "posts_like_count_chk" CHECK (like_count >= 0),
	CONSTRAINT "posts_comment_count_chk" CHECK (comment_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_a_fk" FOREIGN KEY ("user_a_id","user_a_type") REFERENCES "public"."users"("id","account_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_user_b_fk" FOREIGN KEY ("user_b_id","user_b_type") REFERENCES "public"."users"("id","account_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_fk" FOREIGN KEY ("follower_id","follower_type") REFERENCES "public"."users"("id","account_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_creator_fk" FOREIGN KEY ("creator_id","creator_type") REFERENCES "public"."users"("id","account_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "avatar_uploads" ADD CONSTRAINT "avatar_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_user_b_idx" ON "connections" USING btree ("user_b_id","user_a_id");--> statement-breakpoint
CREATE INDEX "follows_creator_idx" ON "follows" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "avatar_uploads_user_idx" ON "avatar_uploads" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "avatar_uploads_created_idx" ON "avatar_uploads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "comments_post_idx" ON "comments" USING btree ("post_id","created_at","id");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id","created_at") WHERE parent_id is not null;--> statement-breakpoint
CREATE INDEX "comments_author_idx" ON "comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "likes_user_idx" ON "likes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "post_media_processing_idx" ON "post_media" USING btree ("updated_at") WHERE status = 'processing';--> statement-breakpoint
CREATE INDEX "posts_author_type_pub_idx" ON "posts" USING btree ("author_id","type","published_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE status = 'published' and deleted_at is null;--> statement-breakpoint
CREATE INDEX "posts_author_created_idx" ON "posts" USING btree ("author_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_pending_idx" ON "posts" USING btree ("status","created_at") WHERE status in ('draft', 'processing');--> statement-breakpoint
CREATE INDEX "posts_deleted_idx" ON "posts" USING btree ("deleted_at") WHERE deleted_at is not null;
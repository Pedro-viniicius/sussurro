ALTER TABLE "post_media" ADD COLUMN "poster_incoming_key" text;--> statement-breakpoint
ALTER TABLE "post_media" ADD COLUMN "poster_mime" text;--> statement-breakpoint
ALTER TABLE "post_media" ADD COLUMN "poster_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_video_duration_chk" CHECK (kind <> 'video' or (duration_s is not null and duration_s > 0));--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_poster_chk" CHECK ((poster_incoming_key is null) = (poster_mime is null) and (poster_incoming_key is null) = (poster_size_bytes is null));--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_poster_video_chk" CHECK (kind = 'video' or poster_incoming_key is null);--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_poster_size_chk" CHECK (poster_size_bytes is null or poster_size_bytes > 0);
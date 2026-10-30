CREATE TYPE "public"."request_status" AS ENUM('pending', 'accepted', 'declined', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "connection_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"from_id" uuid NOT NULL,
	"from_type" "account_type" DEFAULT 'personal' NOT NULL,
	"to_id" uuid NOT NULL,
	"to_type" "account_type" DEFAULT 'personal' NOT NULL,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"method" "connection_method" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "connection_requests_not_self_chk" CHECK (from_id <> to_id),
	CONSTRAINT "connection_requests_from_personal_chk" CHECK (from_type = 'personal'),
	CONSTRAINT "connection_requests_to_personal_chk" CHECK (to_type = 'personal'),
	CONSTRAINT "connection_requests_expiry_chk" CHECK (expires_at > created_at),
	CONSTRAINT "connection_requests_responded_chk" CHECK ((status = 'pending') = (responded_at is null))
);
--> statement-breakpoint
ALTER TABLE "connection_requests" ADD CONSTRAINT "connection_requests_from_fk" FOREIGN KEY ("from_id","from_type") REFERENCES "public"."users"("id","account_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_requests" ADD CONSTRAINT "connection_requests_to_fk" FOREIGN KEY ("to_id","to_type") REFERENCES "public"."users"("id","account_type") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connection_requests_pending_pair_key" ON "connection_requests" USING btree (least(from_id, to_id),greatest(from_id, to_id)) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "connection_requests_to_idx" ON "connection_requests" USING btree ("to_id","status","created_at");--> statement-breakpoint
CREATE INDEX "connection_requests_from_idx" ON "connection_requests" USING btree ("from_id","to_id");--> statement-breakpoint
CREATE INDEX "connection_requests_created_idx" ON "connection_requests" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_request_fk" FOREIGN KEY ("request_id") REFERENCES "public"."connection_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_request_idx" ON "connections" USING btree ("request_id") WHERE request_id is not null;
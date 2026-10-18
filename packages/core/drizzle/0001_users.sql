CREATE TABLE "users" (
	"email" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('admin', 'operator', 'viewer'))
);

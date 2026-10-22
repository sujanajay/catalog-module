CREATE TABLE "catalog_cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"batch_id" uuid NOT NULL,
	"brand_slug" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"product_id" uuid,
	"source_image_id" uuid,
	"output_id" uuid,
	"channel" text,
	"stage" text NOT NULL,
	"kind" text NOT NULL,
	"engine" text NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"usd" numeric(12, 8) DEFAULT 0 NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"chunk_id" uuid,
	"attempt" integer,
	CONSTRAINT "catalog_cost_events_channel_check" CHECK ("catalog_cost_events"."channel" IN ('noon', 'namshi', 'trendyol', 'styli', 'centrepoint', 'sixthstreet', 'vogacloset', 'amazon', 'shein')),
	CONSTRAINT "catalog_cost_events_stage_check" CHECK ("catalog_cost_events"."stage" IN ('matte', 'render', 'upscale', 'qa', 'classify', 'publish', 'finalize')),
	CONSTRAINT "catalog_cost_events_kind_check" CHECK ("catalog_cost_events"."kind" IN ('llm_call', 'matte_call', 'render', 'upscale_call', 'compute')),
	CONSTRAINT "catalog_cost_events_outcome_check" CHECK ("catalog_cost_events"."outcome" IN ('ok', 'failed', 'rate_limited', 'cap', 'fallback'))
);
--> statement-breakpoint
ALTER TABLE "catalog_cost_events" ADD CONSTRAINT "catalog_cost_events_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_cost_events_batch_id_idx" ON "catalog_cost_events" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "catalog_cost_events_brand_slug_at_idx" ON "catalog_cost_events" USING btree ("brand_slug","at");--> statement-breakpoint
CREATE INDEX "catalog_cost_events_output_id_idx" ON "catalog_cost_events" USING btree ("output_id");--> statement-breakpoint
CREATE INDEX "catalog_cost_events_at_idx" ON "catalog_cost_events" USING btree ("at");
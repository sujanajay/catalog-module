CREATE TABLE "brand_master" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"line" text NOT NULL,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_master_slug_unique" UNIQUE("slug"),
	CONSTRAINT "brand_master_line_check" CHECK ("brand_master"."line" IN ('softline', 'hardline')),
	CONSTRAINT "brand_master_source_check" CHECK ("brand_master"."source" IN ('warehouse', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "catalog_batch_products" (
	"batch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"link_status" text DEFAULT 'ok' NOT NULL,
	"change" text NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	CONSTRAINT "catalog_batch_products_batch_id_product_id_pk" PRIMARY KEY("batch_id","product_id"),
	CONSTRAINT "catalog_batch_products_link_status_check" CHECK ("catalog_batch_products"."link_status" IN ('ok', 'missing_images', 'not_in_sheet')),
	CONSTRAINT "catalog_batch_products_change_check" CHECK ("catalog_batch_products"."change" IN ('new', 'updated', 'unchanged', 'shots_removed', 'reordered', 'pending_attention', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "catalog_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_slug" text NOT NULL,
	"brand_name" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"product_type" text DEFAULT 'auto' NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{"identifierMode":"filename","precedence":"uploads_then_links","sheetColumns":null}'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{"products":0,"sources":0,"outputs":0,"verified":0,"needsAttention":0,"attentionProducts":0,"failed":0,"skipped":0,"unchanged":0,"skuResolved":0,"missingImages":0,"notInSheet":0,"unsupportedFiles":0,"duplicateFiles":0,"collected":0,"collectTotal":null,"previewReady":false,"latestExport":0,"failReason":null,"finalizePending":false,"policyFallback":false,"newProducts":0,"existingProducts":0,"shotsToRemove":0,"recheckOk":null,"recheckTotal":null}'::jsonb NOT NULL,
	"cost" jsonb DEFAULT '{"computeVcpuSeconds":0,"mattingMs":0,"renderMs":0,"computeUsd":0,"qaUsd":0,"qaCalls":0,"identifiers":0,"usdPerIdentifier":null,"inrPerIdentifier":null}'::jsonb NOT NULL,
	"report_uri" text,
	"sheet_xlsx_uri" text,
	"sheet_csv_uri" text,
	"error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_batches_status_check" CHECK ("catalog_batches"."status" IN ('draft', 'ingesting', 'matting', 'rendering', 'qa', 'publishing', 'done', 'failed')),
	CONSTRAINT "catalog_batches_product_type_check" CHECK ("catalog_batches"."product_type" IN ('auto', 'footwear', 'apparel_model', 'apparel_flat', 'bag_accessory', 'other'))
);
--> statement-breakpoint
CREATE TABLE "catalog_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"stage" text NOT NULL,
	"product_ids" jsonb NOT NULL,
	"source_image_ids" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"task_name" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_chunks_stage_check" CHECK ("catalog_chunks"."stage" IN ('matte', 'render', 'qa')),
	CONSTRAINT "catalog_chunks_status_check" CHECK ("catalog_chunks"."status" IN ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "catalog_eval_judgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"output_id" uuid NOT NULL,
	"judge_model" text NOT NULL,
	"scores" jsonb NOT NULL,
	"verdict" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_eval_judgements_verdict_check" CHECK ("catalog_eval_judgements"."verdict" IN ('pass', 'flag'))
);
--> statement-breakpoint
CREATE TABLE "catalog_eval_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"output_id" uuid NOT NULL,
	"source_image_id" uuid NOT NULL,
	"set_name" text NOT NULL,
	"identifier" text NOT NULL,
	"channel" text NOT NULL,
	"labeler" text NOT NULL,
	"label" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"judge_verdict" text,
	"judge_scores" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_eval_labels_channel_check" CHECK ("catalog_eval_labels"."channel" IN ('noon', 'namshi', 'trendyol', 'styli', 'centrepoint', 'sixthstreet', 'vogacloset', 'amazon', 'shein')),
	CONSTRAINT "catalog_eval_labels_label_check" CHECK ("catalog_eval_labels"."label" IN ('pass', 'flag'))
);
--> statement-breakpoint
CREATE TABLE "catalog_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"source_image_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"n" integer NOT NULL,
	"canvas_w" integer NOT NULL,
	"canvas_h" integer NOT NULL,
	"scale" numeric NOT NULL,
	"placed_x" integer NOT NULL,
	"placed_y" integer NOT NULL,
	"bytes" integer,
	"quality" integer,
	"render_key" text NOT NULL,
	"staging_uri" text,
	"object_path" text NOT NULL,
	"public_url" text NOT NULL,
	"generation" bigint,
	"crc32c" text,
	"is_live" boolean DEFAULT false NOT NULL,
	"compliance" jsonb,
	"qa_scores" jsonb,
	"qa_model" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text,
	"decision" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by" text,
	"superseded_at" timestamp with time zone,
	"superseded_by_output_id" uuid,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_outputs_channel_check" CHECK ("catalog_outputs"."channel" IN ('noon', 'namshi', 'trendyol', 'styli', 'centrepoint', 'sixthstreet', 'vogacloset', 'amazon', 'shein')),
	CONSTRAINT "catalog_outputs_status_check" CHECK ("catalog_outputs"."status" IN ('pending', 'staged', 'verified', 'needs_attention', 'failed', 'skipped')),
	CONSTRAINT "catalog_outputs_decision_check" CHECK ("catalog_outputs"."decision" IN ('use_as_is', 'remove', 'replaced'))
);
--> statement-breakpoint
CREATE TABLE "catalog_product_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_slug" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"alias_key" text NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_aliases_kind_check" CHECK ("catalog_product_aliases"."kind" IN ('identifier', 'opptra_sku', 'option_id', 'channel_id', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "catalog_product_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_id" uuid,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_product_events_kind_check" CHECK ("catalog_product_events"."kind" IN ('created', 'overwritten', 'shots_removed', 'channel_added', 'unchanged', 'reordered', 'sku_ids_added', 'alias_added', 'removed_photo', 'replacement_uploaded', 'restored', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "catalog_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_slug" text NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"product_key" text NOT NULL,
	"path_key" text NOT NULL,
	"identifier" text NOT NULL,
	"option_id_style_color" text,
	"opptra_sku_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sku_method" text,
	"product_type" text,
	"lock_batch_id" uuid,
	"last_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_source_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"sha256" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"superseded_at" timestamp with time zone,
	"replaces_id" uuid,
	"original_name" text NOT NULL,
	"upload_id" uuid,
	"raw_uri" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"bytes" bigint,
	"matte_uri" text,
	"matte_model" text,
	"matte_ms" integer,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_source_images_status_check" CHECK ("catalog_source_images"."status" IN ('pending', 'prepared', 'matted', 'failed', 'unsupported'))
);
--> statement-breakpoint
CREATE TABLE "catalog_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"relative_path" text,
	"gcs_uri" text,
	"source_url" text,
	"size_bytes" bigint,
	"mime" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"detected" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_uploads_kind_check" CHECK ("catalog_uploads"."kind" IN ('zip', 'image', 'sheet', 'product_list', 'google_sheet', 'drive_folder', 'url_list')),
	CONSTRAINT "catalog_uploads_status_check" CHECK ("catalog_uploads"."status" IN ('pending', 'uploaded', 'collected', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "model_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_slug" text NOT NULL,
	"category" text NOT NULL,
	"matte_model" text NOT NULL,
	"qa_model" text NOT NULL,
	"threshold" integer NOT NULL,
	"floor" integer NOT NULL,
	"qa_mode" text DEFAULT 'per_source' NOT NULL,
	"qa_sample_rate" numeric DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"matte_target" text,
	"matte_model_second" text,
	"shadow_mode" text,
	"qa_model_second" text,
	"eval_batch_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gates" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_policy_category_check" CHECK ("model_policy"."category" IN ('auto', 'footwear', 'apparel_model', 'apparel_flat', 'bag_accessory', 'other', '*')),
	CONSTRAINT "model_policy_qa_mode_check" CHECK ("model_policy"."qa_mode" IN ('per_source', 'per_output')),
	CONSTRAINT "model_policy_source_check" CHECK ("model_policy"."source" IN ('bakeoff', 'default', 'pending', 'manual')),
	CONSTRAINT "model_policy_matte_target_check" CHECK ("model_policy"."matte_target" IN ('cpu', 'gpu')),
	CONSTRAINT "model_policy_shadow_mode_check" CHECK ("model_policy"."shadow_mode" IN ('preserve_only', 'preserve_else_synthesise'))
);
--> statement-breakpoint
CREATE TABLE "sku_map" (
	"opptra_sku" text PRIMARY KEY NOT NULL,
	"brand" text NOT NULL,
	"brand_slug" text NOT NULL,
	"line" text NOT NULL,
	"option_key" text NOT NULL,
	"option_id_style_color" text,
	"ean" text,
	"color" text,
	"size" text,
	"channel_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"image_url" text,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone,
	CONSTRAINT "sku_map_line_check" CHECK ("sku_map"."line" IN ('softline', 'hardline')),
	CONSTRAINT "sku_map_source_check" CHECK ("sku_map"."source" IN ('warehouse', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "spend_days" (
	"day" date NOT NULL,
	"brand_slug" text NOT NULL,
	"engine" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "spend_days_day_brand_slug_engine_batch_id_pk" PRIMARY KEY("day","brand_slug","engine","batch_id"),
	CONSTRAINT "spend_days_engine_check" CHECK ("spend_days"."engine" IN ('catalog_qa', 'catalog_compute'))
);
--> statement-breakpoint
ALTER TABLE "catalog_batch_products" ADD CONSTRAINT "catalog_batch_products_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_batch_products" ADD CONSTRAINT "catalog_batch_products_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_chunks" ADD CONSTRAINT "catalog_chunks_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_eval_judgements" ADD CONSTRAINT "catalog_eval_judgements_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_eval_judgements" ADD CONSTRAINT "catalog_eval_judgements_output_id_catalog_outputs_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."catalog_outputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_eval_labels" ADD CONSTRAINT "catalog_eval_labels_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_eval_labels" ADD CONSTRAINT "catalog_eval_labels_output_id_catalog_outputs_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."catalog_outputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_eval_labels" ADD CONSTRAINT "catalog_eval_labels_source_image_id_catalog_source_images_id_fk" FOREIGN KEY ("source_image_id") REFERENCES "public"."catalog_source_images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_outputs" ADD CONSTRAINT "catalog_outputs_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_outputs" ADD CONSTRAINT "catalog_outputs_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_outputs" ADD CONSTRAINT "catalog_outputs_source_image_id_catalog_source_images_id_fk" FOREIGN KEY ("source_image_id") REFERENCES "public"."catalog_source_images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_outputs" ADD CONSTRAINT "catalog_outputs_superseded_by_output_id_catalog_outputs_id_fk" FOREIGN KEY ("superseded_by_output_id") REFERENCES "public"."catalog_outputs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_product_aliases" ADD CONSTRAINT "catalog_product_aliases_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_product_events" ADD CONSTRAINT "catalog_product_events_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_product_events" ADD CONSTRAINT "catalog_product_events_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_lock_batch_id_catalog_batches_id_fk" FOREIGN KEY ("lock_batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_last_batch_id_catalog_batches_id_fk" FOREIGN KEY ("last_batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_images" ADD CONSTRAINT "catalog_source_images_product_id_catalog_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."catalog_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_images" ADD CONSTRAINT "catalog_source_images_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_images" ADD CONSTRAINT "catalog_source_images_replaces_id_catalog_source_images_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."catalog_source_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_images" ADD CONSTRAINT "catalog_source_images_upload_id_catalog_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."catalog_uploads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_uploads" ADD CONSTRAINT "catalog_uploads_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_days" ADD CONSTRAINT "spend_days_batch_id_catalog_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."catalog_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_batch_products_product_id_idx" ON "catalog_batch_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "catalog_batches_brand_slug_idx" ON "catalog_batches" USING btree ("brand_slug");--> statement-breakpoint
CREATE INDEX "catalog_chunks_batch_id_idx" ON "catalog_chunks" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "catalog_eval_judgements_batch_id_idx" ON "catalog_eval_judgements" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_eval_judgements_output_model_uq" ON "catalog_eval_judgements" USING btree ("output_id","judge_model");--> statement-breakpoint
CREATE INDEX "catalog_eval_labels_batch_id_idx" ON "catalog_eval_labels" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "catalog_outputs_batch_id_idx" ON "catalog_outputs" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "catalog_outputs_product_id_idx" ON "catalog_outputs" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_outputs_live_uq" ON "catalog_outputs" USING btree ("product_id","channel","n") WHERE "catalog_outputs"."is_live";--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_product_aliases_brand_test_key_uq" ON "catalog_product_aliases" USING btree ("brand_slug","is_test","alias_key");--> statement-breakpoint
CREATE INDEX "catalog_product_aliases_product_id_idx" ON "catalog_product_aliases" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "catalog_product_events_product_id_idx" ON "catalog_product_events" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_products_brand_test_key_uq" ON "catalog_products" USING btree ("brand_slug","is_test","product_key");--> statement-breakpoint
CREATE INDEX "catalog_products_lock_batch_id_idx" ON "catalog_products" USING btree ("lock_batch_id");--> statement-breakpoint
CREATE INDEX "catalog_source_images_product_id_idx" ON "catalog_source_images" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_images_product_n_sha_batch_uq" ON "catalog_source_images" USING btree ("product_id","n","sha256","batch_id");--> statement-breakpoint
CREATE INDEX "catalog_uploads_batch_id_idx" ON "catalog_uploads" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_policy_brand_category_uq" ON "model_policy" USING btree ("brand_slug","category");--> statement-breakpoint
CREATE INDEX "sku_map_brand_slug_idx" ON "sku_map" USING btree ("brand_slug");--> statement-breakpoint
CREATE INDEX "sku_map_option_key_idx" ON "sku_map" USING btree ("option_key");--> statement-breakpoint
CREATE INDEX "sku_map_ean_idx" ON "sku_map" USING btree ("ean");--> statement-breakpoint
CREATE INDEX "spend_days_batch_id_idx" ON "spend_days" USING btree ("batch_id");
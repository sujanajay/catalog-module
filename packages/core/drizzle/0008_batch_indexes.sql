-- Large batches (2026-11-01): every step that reads a batch's photos filters catalog_source_images by batch_id, and
-- the same-photo lookups of the overwrite preview filter it by sha256; neither had an index, so each read scanned
-- every photo of every batch. The sweep and the enlargement lane read catalog_chunks by status (and task_name) across
-- batches. Additive; IF NOT EXISTS keeps a re-run harmless, and the short lock timeout keeps the migrate job
-- re-runnable (CREATE INDEX holds writes on the table for the seconds it takes).
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_chunks_status_task_name_idx" ON "catalog_chunks" USING btree ("status","task_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_source_images_batch_id_idx" ON "catalog_source_images" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_source_images_sha256_idx" ON "catalog_source_images" USING btree ("sha256");

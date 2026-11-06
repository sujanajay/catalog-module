-- R1 exit findings 3 and 4 (2026-11-06): catalog_traffic_shifts, one row each time traffic moved to a revision of one of
-- the six catalog services, written by the deploy gate through the catalog-traffic-shift job. deploy_overlap and the
-- daily cost check read it. Additive: a new table. Every statement can run again harmlessly.
-- The rows below are the shifts of 2026-11-05 14:29Z to 2026-11-06 05:48Z from Cloud Audit Logs (ReplaceService with the
-- revision at 100%), so the daily cost check of 2026-11-07 can tell the forced deploys' candidates from the revisions
-- that served batch 84a5a30a. No batch outcome is changed. Later shifts are written by the deploys themselves.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_traffic_shifts" (
	"service" text NOT NULL,
	"revision" text NOT NULL,
	"shifted_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_traffic_shifts_revision_shifted_at_pk" PRIMARY KEY("revision","shifted_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_traffic_shifts_shifted_at_idx" ON "catalog_traffic_shifts" USING btree ("shifted_at");--> statement-breakpoint
INSERT INTO "catalog_traffic_shifts" ("service", "revision", "shifted_at") VALUES
	('catalog-matting', 'catalog-matting-00081-dew', '2026-11-05T14:29:57Z'),
	('catalog-upscale', 'catalog-upscale-00044-bip', '2026-11-05T14:30:14Z'),
	('catalog-upscale-gpu', 'catalog-upscale-gpu-00024-teq', '2026-11-05T14:30:31Z'),
	('catalog-matting-gpu', 'catalog-matting-gpu-00074-duz', '2026-11-05T14:30:54Z'),
	('catalog-web', 'catalog-web-00065-diw', '2026-11-05T14:31:49Z'),
	('catalog-worker', 'catalog-worker-00074-sas', '2026-11-05T14:48:20Z'),
	('catalog-web', 'catalog-web-00070-rux', '2026-11-05T20:33:14Z'),
	('catalog-worker', 'catalog-worker-00080-qaz', '2026-11-06T03:47:18Z'),
	('catalog-matting', 'catalog-matting-00085-naz', '2026-11-06T05:30:58Z'),
	('catalog-upscale', 'catalog-upscale-00048-ruj', '2026-11-06T05:31:13Z'),
	('catalog-upscale-gpu', 'catalog-upscale-gpu-00028-vot', '2026-11-06T05:31:28Z'),
	('catalog-matting-gpu', 'catalog-matting-gpu-00078-qut', '2026-11-06T05:31:43Z'),
	('catalog-web', 'catalog-web-00073-fih', '2026-11-06T05:32:25Z'),
	('catalog-worker', 'catalog-worker-00083-xof', '2026-11-06T05:47:55Z')
ON CONFLICT DO NOTHING;

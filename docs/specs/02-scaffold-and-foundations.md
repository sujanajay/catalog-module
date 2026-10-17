# 02 Scaffold and foundations

Execute with `docs/specs/00-execution-protocol.md`. Source of truth: `docs/SPEC.md`. Visual contract:
`01-ui-prototype.md` is not needed here; no visual work ships in this spec.

Branch `feat/catalog-02-scaffold-and-foundations`. This spec deploys the worker, the migrate job and
the infrastructure. Nothing an operator can see changes; the web app is scaffolded but shows only a
placeholder page until 03 adds sign-in.

## Goal

Create the fresh repository and everything later specs build on: the pnpm monorepo scaffold, the
files lifted from the old `image-links-agent` repo, the channel data, naming and path rules, the
links sheet writers, shared CSV and safe-URL helpers, storage helpers for the public and private
buckets (including the staging-then-swap copy and the scoped delete), the full database schema and
its first migration, a generic Cloud Tasks enqueue, the worker route table with the two routes this
spec owns (`sync-master`, `sweep`), the brand master and SKU map sync from the warehouse, the SKU
resolution chain, the product identity helpers (find or create, aliases, locks, events), and the
bootstrap and deploy scripts for the `catalog-*` GCP resources.

Plain-language notes on words used below:
- "Scaffold" means the empty but working repo: folders, configs, build and test commands.
- "Lift" means copying a file from the old repo and changing it to fit this one. Nothing is imported
  from the old repo as a package.
- "Migration" is a SQL file that creates or changes database tables, applied in order.
- "Product" is one brand plus one style+colour identifier (defined in detail under "Product identity
  helpers"). "Output" is one finished image for one channel and one shot.

Rule for the whole module: no language model takes part in grouping, counting, column detection, SKU
resolution or link construction. Those are deterministic code with unit tests. Models are used only
for the QA judge and the product-type classifier (07).

## Scope and non-scope

In scope: the repo scaffold; the lift list; libraries in `packages/core`; schema and migration
`0000_init.sql`; the worker server with `/healthz`, `/tasks/catalog/sync-master` and
`/tasks/catalog/sweep`; `infra/bootstrap.sh` and `infra/deploy.sh`; the `test:real` harness; CI.

Out of scope: Google sign-in and roles (03, which also adds the `users` table in its own migration
`0001_users.sql`); ingestion adapters (04); matting service and rendering (05); wizard, batch pages,
publish and finalize (06); QA judge, attention tab and SKU mapping sheet (07); bake-off (08); load
test and hand-over (09). The esbuild entries other than `index` and `migrate` are added by the spec
that owns each one.

## Part 1: Scaffold

### Repo layout

```
catalog-module/
  apps/
    web/                     Next.js 15 App Router, React 19 (@catalog/web)
      app/                   page.tsx placeholder "Catalog images" (03 replaces it), layout.tsx
      lib/                   errors.ts (lifted), db.ts (getDb re-export)
      components/            ui.tsx, AutoRefresh.tsx (lifted primitives)
      Dockerfile
      next.config.ts         output: "standalone", outputFileTracingRoot = repo root
      package.json, tsconfig.json
    worker/                  Node 20 HTTP server bundled with esbuild (@catalog/worker)
      src/                   index.ts, server.ts, auth.ts, runtime.ts, migrate.ts, catalog/sync-master.ts, catalog/sweep.ts
      build.mjs, Dockerfile, package.json, tsconfig.json
  packages/
    core/                    shared library (@catalog/core)
      src/                   storage.ts, tasks.ts, spend.ts, csv.ts, safe-url.ts
      src/db/                client.ts, migrate.ts, testing.ts, schema.ts
      src/llm/               openrouter.ts, llm.ts, types.ts, util.ts
      src/catalog/           types.ts, channels.ts, naming.ts, sheet.ts, sku-mapping.ts, master-sync.ts, brands.ts, products.ts
      drizzle/               0000_init.sql, meta/
      drizzle.config.ts, package.json, tsconfig.json
  services/
    matting/                 README.md only in this spec ("Python matting service; built by 05")
  infra/
    bootstrap.sh, deploy.sh, lifecycle-public.json, lifecycle-assets.json, cors.json
  docs/
    SPEC.md, specs/, plans/, solutions/, handover/, prototype/
  .github/workflows/ci.yml
  package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig.base.json, eslint.config.mjs,
  vitest.config.ts, vitest.real.config.ts, cloudbuild.yaml, .gitignore, README.md
```

### Root files

- `package.json`: name `catalog-module`, `private: true`, `packageManager: pnpm@9`, `engines.node >=20`.
  Scripts: `lint` (`eslint .`), `typecheck` (`pnpm -r --if-present typecheck`), `test` (`vitest run`),
  `test:real` (`vitest run --config vitest.real.config.ts`), `build` (`pnpm -r --if-present build`),
  `catalog:smoke`, `catalog:eval`, `catalog:load`, `catalog:recheck` (each runs
  `node apps/worker/dist/<entry>.js`; the entries themselves arrive with 06 to 09, so until then the
  script exits with "not built yet"). Dev dependencies: `typescript` 5.x, `eslint`, `@eslint/js`,
  `typescript-eslint`, `vitest`, `@types/node`.
- `pnpm-workspace.yaml`: `packages: ["apps/*", "packages/*"]`.
- `tsconfig.base.json`: lifted as is (ES2022, ESNext, Bundler resolution, `strict`,
  `noUncheckedIndexedAccess`, `noEmit`).
- `eslint.config.mjs`: lifted as is; ignores `**/dist/**`, `**/.next/**`, `**/drizzle/**`,
  `services/**` (Python), `.claude/**`.
- `vitest.config.ts`: include `{apps,packages}/*/src/**/*.test.ts` and `{apps,packages}/*/test/**/*.test.ts`;
  exclude `**/*.real.test.ts`, `**/*.human.spec.ts`, `node_modules`.
- `vitest.real.config.ts`: include only `**/*.real.test.ts`. Every real test starts with
  `if (process.env.REAL_DATA !== "1") return test.skip(...)` so `pnpm test:real` without the flag
  passes with everything skipped.
- `.gitignore`: already exists in the fresh repo; add `.playwright/`, `dist/`, `.next/`,
  `smoke-output/`, `.env*` (keep `!.env.example`).
- `.github/workflows/ci.yml`: on `pull_request` and `push` to `main`; Node 20, `pnpm/action-setup`,
  `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`.
- `README.md`: one screen: what the module does, the GCP assumption (project `image-links-agent`,
  region `asia-south1`), how to run tests, link to `docs/SPEC.md`.

### Package manifests

Versions are "latest stable at build time, pinned in the lockfile"; builders confirm each library's
current major with Context7 before writing code against it.

- `packages/core/package.json` (`@catalog/core`, `type: module`, `exports: { "./*": "./src/*.ts" }`,
  scripts `typecheck`, `db:generate` = `drizzle-kit generate`). Dependencies: `drizzle-orm`, `pg`,
  `@google-cloud/storage`, `@google-cloud/tasks`, `@google-cloud/bigquery`, `sharp`, `exceljs`,
  `unzipper`, `googleapis`, `file-type`, `zod`. Dev: `drizzle-kit`, `@electric-sql/pglite`, `@types/pg`.
- `apps/worker/package.json` (`@catalog/worker`): `@catalog/core` (`workspace:*`), `google-auth-library`,
  `pg`, `@google-cloud/storage`, `@google-cloud/tasks`, `@google-cloud/bigquery`, `sharp`. Dev:
  `esbuild`, `drizzle-orm` (types). Scripts `build` (`node build.mjs`), `start`, `typecheck`.
- `apps/web/package.json` (`@catalog/web`): `next` 15, `react` 19, `react-dom` 19,
  `google-auth-library` (IAP JWT verification, used from 03), `@catalog/core`, `pg`, `@google-cloud/storage`,
  `@google-cloud/tasks`, `zod`. Dev: `@types/react`, `@types/react-dom`, `@types/node`.
  Scripts `dev`, `build`, `start`, `typecheck`.

### Dockerfiles and Cloud Build

- `apps/worker/Dockerfile`: lifted; two stages on `node:20-slim`; `corepack prepare pnpm@9`;
  `pnpm install --frozen-lockfile --filter "@catalog/worker..."`, `pnpm --filter @catalog/worker build`,
  `pnpm --filter @catalog/worker deploy --prod /out`; runtime copies `/out/node_modules` and `/out/dist`;
  `CMD ["node", "dist/index.js"]`. `sharp` is in the externals list so its native binary is installed
  in the image, not bundled.
- `apps/web/Dockerfile`: lifted; the `deps` stage copies the three package manifests and the lockfile
  and runs `pnpm install --frozen-lockfile`; `build` runs `pnpm --filter @catalog/web build`; runtime
  copies `.next/standalone`, `.next/static` and `public`; `CMD ["node", "apps/web/server.js"]`.
- `services/matting/Dockerfile`: added by 05.
- `cloudbuild.yaml`: lifted; steps `worker` and `web` build `${_AR}/worker:${_TAG}` and
  `${_AR}/web:${_TAG}` in parallel (`waitFor: ["-"]`); 05 adds the `matting` step and image so the
  file ends with three images. `machineType: E2_HIGHCPU_8`, `timeout: 1800s`.
- `apps/worker/build.mjs`: lifted; `entryPoints` are `index` and `migrate` in this spec (later
  specs add `catalog-local`, `catalog-smoke`, `catalog-eval`, `catalog-load`, `catalog-recheck`,
  `catalog-qa-check`); `platform: node`, `target: node20`, `format: esm`; externals
  `@google-cloud/*`, `google-auth-library`, `pg`, `pg-native`, `sharp`; the `createRequire` banner is
  kept; copies `packages/core/drizzle` to `dist/drizzle`.

### Lift list

Rule: copy and adapt, never add `image-links-agent` as a dependency. Every file below is copied from
`C:\Users\Sujan AH\Desktop\image-links-agent`, its imports changed from `@ila/*` to `@catalog/*`, and
then edited as the third column says. Tests that come with a lifted file are lifted and adapted too.

| Old path | New path | What to change |
|---|---|---|
| `packages/core/src/storage.ts` | `packages/core/src/storage.ts` | Keep `StorageLike`, `setStorageClient`, `getBucketName`, `parseGsUri`, `toGsUri`, `uploadBuffer`, `downloadBuffer`, `signedUrl`, `MAX_SIGNED_URL_TTL_SEC`, `extFromMime`, `mimeFromPath`. Delete `referenceObjectPath`, `outputObjectPath`, `toDataUrl`, `bufferToDataUrl` (shoot-era paths). Add the functions in "Storage" below. |
| `packages/core/src/tasks.ts` | `packages/core/src/tasks.ts` | Replace `enqueueGeneration`, `generationTaskBody`, `buildGenerationTaskRequest` with the generic `enqueueTask(route, body, opts)` and `buildTaskRequest`; queue default changes from `generation` to `catalog`; keep `TasksClientLike`, `setTasksClient`, `tasksConfigFromEnv`, `queuePath`, `DISPATCH_DEADLINE_SEC = 900`, the `TASKS_INLINE=1` fire-and-forget POST. |
| `packages/core/src/engines/openrouter.ts` | `packages/core/src/llm/openrouter.ts` | Keep `chatCompletion`, `OpenRouterError`, the key redaction, the one retry on 429/5xx with `retry-after`, `DEFAULT_BASE_URL`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_RETRY_DELAY_MS`, `ChatCompletionResponse`. Delete `imagesGenerate`, `getJson`, `ImagesResponse`. `DEFAULT_APP_NAME = "catalog-module"`. |
| `packages/core/src/engines/types.ts` | `packages/core/src/llm/types.ts` | Keep only `OpenRouterDeps`. Delete `EngineId`, `ShotType`, `SHOT_TYPES`, `GenerateInput`, `GeneratedImage`, `GenerateResult`, `EngineAdapter`. |
| `packages/core/src/engines/util.ts` | `packages/core/src/llm/util.ts` | Keep `toDataUrl(ref)`, `refsToImageParts`, `parseDataUrl`, `readCost`, `sumUsage`, `stripBase64`. Delete `fetchImage`, `costOrEstimate` (imports `ENGINES`), `validateInput`. |
| `packages/core/src/prompts/llm.ts` | `packages/core/src/llm/llm.ts` | Keep `callLlm`, `callLlmJson`, `parseJsonLoose`, `LlmResponseError`, `LlmJsonError`, `imageParts`, `textPart`, `LLM_MAX_TOKENS`, `JSON_NUDGE`, `combine`, `addCosts` and the message types. Delete `orchestratorModel` and `DEFAULT_ORCHESTRATOR_MODEL`; `LlmCallOptions.model` becomes required and `callLlm` throws when it is missing (the model is always chosen by `model_policy`, never by env). Error text says "LLM" not "Orchestrator LLM". |
| `packages/core/src/spend.ts` | `packages/core/src/spend.ts` | Re-key from `brandId`/`shootId` to `brandSlug`/`batchId`; drop the `shoots` import and the per-shoot cap; the per-batch cap reads `catalog_batches.options.qaCapUsd` (07 sets it). Keep `dailyCapFromEnv`, `DEFAULT_DAILY_SPEND_CAP_USD = 10`, `CapCheck`. Inline the small `recordSpend`/`sumSpendForDay`/`utcDay` queries from the old `db/queries.ts` (that file is not lifted). |
| `packages/core/src/db/client.ts` | same | Unchanged pattern (`Db`, `getDb`, `closeDb`, `poolConfigFromEnv`); pool `max` reads `DB_POOL_MAX` (default 5 locally; deploy sets 2 for the worker and 3 for the web). |
| `packages/core/src/db/migrate.ts` | same | Unchanged (`resolveMigrationsFolder`, `runMigrations`). |
| `packages/core/src/db/testing.ts` | same | Unchanged (`createDbFromPglite`, `createTestDb`). |
| `apps/worker/src/auth.ts` | same | Unchanged: OIDC check for Cloud Tasks and Cloud Scheduler calls (audience `WORKER_URL`, caller `WORKER_SA_EMAIL`, `SKIP_OIDC=1` for local dev). |
| `apps/worker/src/server.ts` | same | Becomes a route table (see "Worker server"); the `/tasks/generate` branch and the `generationId` uuid check go. Keep `readBody` with its 64 KB cap, `send`, `retryCountHeader`, `createServer`. |
| `apps/worker/src/index.ts` | same | Wire `routes` for the two routes of this spec; delete the engines, prompts and `enqueueGeneration` imports and the `checkEngineAvailability` call; log line "catalog-worker listening". |
| `apps/worker/src/runtime.ts` | same | Unchanged (`defaultMigrationsDir`). |
| `apps/worker/src/migrate.ts` | same | Keep the migrate-then-exit shape; delete the demo brand and prompt template seeds. 03 adds the `SEED_ADMIN_EMAIL` seed here. |
| `apps/worker/build.mjs`, `apps/worker/Dockerfile`, `apps/web/Dockerfile`, `cloudbuild.yaml` | same | Package names and images as described above. |
| `infra/bootstrap.sh`, `infra/deploy.sh` | same | Keep the patterns `set -euo pipefail`, `export CLOUDSDK_CORE_PROJECT`, `gcv()` CR strip, `retry`, `ensure_sa`, `project_binding`, `sa_binding`, `auth_flag`, `SKIP_BUILD=1`, image tag = git short SHA; replace every resource with the `catalog-*` set in "Infra" below; shared resources are checked, never created. |
| Root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`, `.gitignore` | same | Names and scripts as in "Root files". |
| `apps/web/lib/errors.ts` | same | Unchanged (`HttpError`, `notFound`, `badRequest`, `errorResponse`, `handle`, `readJson`); 03 adds `ForbiddenError`. |
| `apps/web/components/ui.tsx`, `AutoRefresh.tsx` | same | Keep `Badge`, `usd`, `when`, `AutoRefresh`; delete `Score` (QA scores of the shoot app). |
| `docs/solutions/deploy-cloud-run.md`, `docs/solutions/infra-bootstrap.md` | `docs/solutions/` | Copied as reference learnings (Cloud Run IAM at project level, Windows path notes); names inside updated to `catalog-*`. |

Not lifted as is: `apps/web/lib/user.ts` (it trusts the plain IAP header
`x-goog-authenticated-user-email`; 03 rewrites it to verify the signed IAP JWT and to look up the
role); everything about shoots, templates, gallery, prompts, image engines, the old `brands` table
and its `db/seed.ts`.

## Part 2: Foundations

### Types and enums (`packages/core/src/catalog/types.ts`)

```ts
export const CHANNEL_IDS = ["noon","namshi","trendyol","styli","centrepoint","sixthstreet","vogacloset","amazon","shein"] as const;
export const BATCH_STATUSES = ["draft","ingesting","matting","rendering","qa","publishing","done","failed"] as const;
export const UPLOAD_KINDS = ["zip","image","sheet","product_list","google_sheet","drive_folder","url_list"] as const;
export const OUTPUT_STATUSES = ["pending","staged","verified","needs_attention","failed","skipped"] as const;
export const LINK_STATUSES = ["ok","missing_images","not_in_sheet"] as const;
export const SHEET_STATUSES = ["ok","needs_attention","missing_images","not_in_sheet"] as const;
export const CHANGE_KINDS = ["new","updated","unchanged","shots_removed","reordered","pending_attention","failed"] as const;
export const PRODUCT_TYPES = ["auto","footwear","apparel_model","apparel_flat","bag_accessory","other"] as const;
export const IDENTIFIER_MODES = ["filename","folder","sheet_column"] as const;
export const PRECEDENCES = ["uploads_then_links","links_only","uploads_only"] as const;
export const OUTPUT_FLAGS = [
  "low_resolution","no_shadow_source","passthrough","alpha_source","unsupported","small_source",
  "fallback_matte","duplicate_shot","numbering_gap","failed_compliance",
  "complete_product","different_product","halo","leftover_background","text_or_watermark","collage",
  "orientation","placement",
  "qa_unavailable","qa_cap","qa_sampled_out","type_unknown",
  "shadow_synthesised","transparent","upscaled",
] as const;
export const DECISIONS = ["use_as_is","remove","replaced"] as const;
export const QA_MODES = ["per_source","per_output"] as const;
export const POLICY_SOURCES = ["bakeoff","default","pending","manual"] as const;
export const EVAL_LABELS = ["pass","flag"] as const;
export const ALIAS_KINDS = ["identifier","opptra_sku","option_id","channel_id","manual"] as const;
export const EVENT_KINDS = ["created","overwritten","shots_removed","channel_added","unchanged","reordered",
  "sku_ids_added","alias_added","removed_photo","replacement_uploaded","restored","removed"] as const;
export const ROLES = ["admin","operator","viewer"] as const;

export interface ResolvedPolicy {
  matteModel: string; qaModel: string; threshold: number; floor: number; qaMode: QaMode; qaSampleRate: number; source: PolicySource;
  matteTarget?: "cpu" | "gpu";             // camelCase twin of model_policy.matte_target; absent = cpu (05 picks the service by model id)
  matteModelSecond?: string;               // model_policy.matte_model_second: used when the first is not listed by any matting service
  shadowMode?: "preserve_only" | "preserve_else_synthesise";   // model_policy.shadow_mode (05 shadow rule); absent = preserve_only
  qaModelSecond?: string;                  // model_policy.qa_model_second: used when the first returns qa_unavailable twice in a batch
}
export interface BatchOptions {
  identifierMode: IdentifierMode;          // step 2; default "filename"
  precedence: Precedence;                  // step 2; default "uploads_then_links"; only meaningful when both kinds exist
  sheetColumns: { identifier: number; images: number[] } | null;   // step 2; null when no sheet
  policy?: ResolvedPolicy;                 // set at start (07); absent on draft
  qaCapUsd?: number | null;                // per-batch QA cap (07)
  evalSet?: string | null;                 // eval batches (08)
}
```

Each array has a matching type alias (`ChannelId`, `BatchStatus`, `UploadKind`, `OutputStatus`,
`LinkStatus`, `SheetStatus`, `ChangeKind`, `ProductType`, `IdentifierMode`, `Precedence`,
`OutputFlag`, `Decision`, `QaMode`, `PolicySource`, `EvalLabel`, `AliasKind`, `EventKind`, `Role`)
written as `(typeof X)[number]`. Also in this file:

```ts
export interface BatchCounts {
  products: number; sources: number; outputs: number; verified: number; needsAttention: number;
  attentionProducts: number; failed: number; skipped: number; unchanged: number; skuResolved: number;
  missingImages: number; notInSheet: number; unsupportedFiles: number; duplicateFiles: number;
  collected: number; collectTotal: number | null; previewReady: boolean; latestExport: number;
  failReason: string | null; finalizePending: boolean; policyFallback: boolean;
  newProducts: number; existingProducts: number; shotsToRemove: number;
  recheckOk: number | null; recheckTotal: number | null;   // independent re-check written by finalize (06)
}
export interface BatchCost {
  computeVcpuSeconds: number; mattingMs: number; renderMs: number; computeUsd: number;
  qaUsd: number; qaCalls: number; identifiers: number;
  usdPerIdentifier: number | null; inrPerIdentifier: number | null;
}
export function flagReason(flag: OutputFlag, ctx?: Record<string, string | number>): string;
```

`flagReason` returns the operator sentence for a flag. This spec ships the sentences for the render
and compliance flags (`low_resolution` to `failed_compliance`); 07 adds the QA sentences. The
`fallback_matte` sentence is: "Background was removed with the simple method because the cut-out
service was unavailable. Check the edges." The three render flags added from the model review:
`shadow_synthesised` is information only and has no sentence; `transparent` (attention): "This
product looks transparent or glass; the cut-out may need a look." with the action "Compare the two
images. 'Use as is' keeps it."; `upscaled` (attention; experiment only, 08): "This image was enlarged
by an experimental step." with the action "Check logos, text and fabric texture against the
original." Every sentence states what happened and what to do; no model names, no technical ids.

There is no `separator` and no `skipLowResolution` option. Shot numbers are parsed from `_<n>`,
`-<n>` and `_0<n>` at once, and the Styli low-resolution skip is the constant
`STYLI_SKIP_LOW_RESOLUTION` below.

### Channel table (`packages/core/src/catalog/channels.ts`)

This table is the sheet, encoded exactly:

| id | min canvas | target canvas | margins | anchor | background | dpi | sheet text and notes |
|---|---|---|---|---|---|---|---|
| noon | 660x900 | 1080x1480 | top 10%, bottom 10%, side 5% (horizontal shots) | centre | `#E0E0E0` | 72 | "660x900 (min) -> 1080x1480+, >=72 PPI, <=2 MB, 0.73 (3:4)" |
| namshi | 660x900 | 1080x1480 | top 10%, bottom 10% | centre | `#E0E0E0` | 72 | "= Noon rules" |
| trendyol | 600x800 | 1200x1800 | none in sheet | centre | `#E0E0E0` | 96 | "600x800 @72 (min) -> 1200x1800 @96, <=2 MB, 3:4, HTTPS, no spaces"; accepted files are 1200x1800 |
| styli | 2342x3123 | 2342x3123 | guides top 450, bottom 450, left 150, right 150 px | bottom-centre | `#E0E0E0` | 300 | sheet "1200x1600 -> 2000x2667"; email canvas applies to every Styli image [U] |
| centrepoint | 3000x3000 | 3000x3000 | none in sheet | centre | `#E0E0E0` | 300 | "3000x3000, >=300 PPI, 1:1" |
| sixthstreet | 1200x1600 | 2000x2667 | none in sheet | centre | `#E0E0E0` | 300 | "1200x1600 -> 2000x2667, 3:4" |
| vogacloset | 1200x1600 | 2000x2667 | none in sheet | centre | `#E0E0E0` | 300 | same as 6thStreet |
| amazon | 1000x1000 | 2000x2000 | none in sheet | centre | img 1 `#FFFFFF`, rest `#E0E0E0` | 300 | "1000x1000 -> 2000x2000, 3:4 portrait, first image pure white" |
| shein | 1000x1000 | 2000x2000 | none in sheet | centre | img 1 `#FFFFFF`, rest `#E0E0E0` | 300 | "exactly Amazon" |

"None in sheet" = margin 0: the product is fitted to the full canvas on its limiting dimension and
centred. Noon's "(horizontal shots)": the 5% side margin is the minimum when the product is wider
than tall. Common: JPEG 4:4:4, sRGB with ICC, quality 90 stepping down to 70 until <= 2,000,000
bytes, EXIF applied then stripped, JFIF density set. Adaptive canvas: the largest size between min and
target that keeps upscaling <= 1.5x; below that, the min canvas with a `low_resolution` flag; Styli
(fixed canvas) flags, and `STYLI_SKIP_LOW_RESOLUTION` (always true; it is no longer a batch option)
excludes such images from the sheet with a note.

```ts
export interface Size { w: number; h: number }
export interface Margins {
  top: number; bottom: number; left: number; right: number;
  unit: "fraction" | "px";
  /** Noon: side margins apply only when the product bbox is wider than tall. */
  sidesOnlyWhenWide?: boolean;
}
export interface ChannelSpec {
  id: ChannelId;
  label: string;                       // "Noon", "Namshi", "Trendyol", "Styli", "Centrepoint", "6thStreet", "VogaCloset", "Amazon", "Shein"
  group: "P1" | "P2";                  // P1: namshi, noon, trendyol, amazon; P2: styli, sixthstreet, centrepoint, vogacloset, shein (information only)
  minCanvas: Size;
  targetCanvas: Size;
  margins: Margins;                    // zeros with unit "fraction" when the sheet is silent
  anchor: "centre" | "bottom-centre";
  background: string;                  // "#E0E0E0"
  firstImageBackground?: string;       // "#FFFFFF" for amazon and shein
  dpi: number;
  fixedCanvas: boolean;                // true where min equals target (styli, centrepoint)
  uniformScaleDefault: boolean;        // true for styli
  sheetText: string;                   // the quoted text column above
  notes?: string;
}
export const CHANNELS: Record<ChannelId, ChannelSpec>;
export const CHANNEL_ORDER: ChannelId[];            // the row order above
export function channel(id: ChannelId): ChannelSpec;
export function backgroundFor(id: ChannelId, shotNumber: number): string;   // firstImageBackground when shotNumber === 1
export const JPEG_QUALITY_START = 90, JPEG_QUALITY_MIN = 70, JPEG_QUALITY_STEP = 5;   // STEP is a builder constant
export const MAX_OUTPUT_BYTES = 2_000_000;
export const MAX_UPSCALE = 1.5;
export const DETAIL_SHOT_BBOX_FRACTION = 0.85;
export const MIN_SOURCE_LONG_SIDE_PX = 500;
export const STYLI_MIN_SOURCE_HEIGHT_PX = 1482;      // ceil((3123 - 450 - 450) / 1.5); feeds the wizard warning only
export const STYLI_SKIP_LOW_RESOLUTION = true;       // agreement with Styli; always applied
export const CHANNEL_RULES_VERSION = "1";            // bumped on any rule change; part of render_key (06)
```

Margins encoding: noon `{top:0.10,bottom:0.10,left:0.05,right:0.05,unit:"fraction",sidesOnlyWhenWide:true}`;
namshi `{top:0.10,bottom:0.10,left:0,right:0,unit:"fraction"}`; styli
`{top:450,bottom:450,left:150,right:150,unit:"px"}`; all others zeros. Nothing is pre-ticked and no
channel defaults are stored anywhere; the groups only order the cards in the wizard.

### Naming and paths (`packages/core/src/catalog/naming.ts`)

```ts
parseShotName(fileName): { identifier; n: number | null; suffix: "" | "_rect" | "_square"; stem }
sanitizeSegment(s)            // spaces -> "_"; keep letters, digits, "-", "_", "."; case kept
brandSlug(name)               // lowercase, sanitised
normalizeKey(s)               // uppercase; spaces, "_" and "-" removed  -> product_key and alias keys
rootPrefix(isTest)            // "catalog" | "catalog-test"
batchPrefix(brandSlug, batchId, isTest)     // <root>/<brand>/<batchId>          (private bucket)
productPrefix(brandSlug, pathKey, isTest)   // <root>/<brand>/<pathKey>/         (public bucket)
shotStem(pathKey, n)                        // <pathKey>_<n>                      (no version argument)
uploadPath(prefix, uploadId, fileName)      // <prefix>/uploads/<uploadId>/<sanitised>
rawPath(prefix, pathKey, n, ext)            // <prefix>/raw/<pathKey>/<pathKey>_<n>.<ext>
derivedPath(prefix, pathKey, n, kind)       // <prefix>/derived/<pathKey>/<pathKey>_<n>.<kind>.png
stagingPath(prefix, pathKey, channel, n)    // <prefix>/staging/<pathKey>/<channel>/<pathKey>_<n>.jpg
exportPath(prefix, name)                    // <prefix>/exports/<name>  (links-v<k>.xlsx|csv, report-v<k>.json)
brandExportPath(brandSlug, name, isTest)    // <root>/<brand>/exports/links-<yyyymmdd-hhmmss>.xlsx|csv
publicObjectPath(brandSlug, pathKey, channel, n, isTest)  // <root>/<brand>/<pathKey>/<channel>/<pathKey>_<n>.jpg
publicUrl(bucket, objectPath)               // https://storage.googleapis.com/<bucket>/<path>, segments URI-encoded, no spaces
assertWithinProduct(objectPath, productPrefix)   // throws unless objectPath starts with productPrefix and productPrefix starts with "catalog/" or "catalog-test/"
TEST_PREFIX = "catalog-test/"; assertTestPrefix(objectPath)
```

`parseShotName` rule: the shot number is the number after the last `_` or `-` in the stem; `_0n` is
allowed (`ABC123_01` is shot 1); a trailing `_rect` or `_square` before the number or at the end is
returned in `suffix`; `n` is null when the stem ends in letters. A shot number has at most three
digits. A trailing `_<number>` or `-<number>` with four or more digits is part of the identifier:
`ONLY-SHOES_Autumnwinter_5079628_15380145.jpg` is shot 1 of identifier
`ONLY-SHOES_Autumnwinter_5079628_15380145`, and `IMG_2041.heic` is identifier `IMG_2041`, shot 1.
A product whose single file carries no shot number gets `n = 1`. There is no version argument
anywhere in this module, no `_v<k>` suffix, no batch id and no SKU id in any public path.

Output extension: every public object path and every link in a sheet ends in lowercase `.jpg` (the
channel sheets say JPEG/JPG). `publicObjectPath` is the only function that builds a public path, and
a unit test asserts the suffix; the re-check (09) asserts it too.

Numbering rule (this is the one place it is decided; 04 and 06 restate it): shot `n` is the position
of the file in the product's upload, counted 1..k in the order of the numbers in the file names
(`_1`, `_2`, `_4` become positions 1, 2, 3). Object paths and the sheet use positions, so there is
never a blank cell for a gap; when the file-name numbers had gaps the product gets flag
`numbering_gap` and the sheet row's `notes` says "Shot numbers <list> are missing in the upload;
images shifted left in this row." The original file name is kept in
`catalog_source_images.original_name`. The order files arrived in, and their order in a zip or
folder listing, never affects shot order.

Path examples (brand `uspa`, identifier `ABC123`, batch `b1`):
- raw: `catalog/uspa/b1/raw/ABC123/ABC123_2.jpg` (private bucket)
- staging: `catalog/uspa/b1/staging/ABC123/noon/ABC123_2.jpg` (private bucket)
- public: `catalog/uspa/ABC123/noon/ABC123_2.jpg`, link
  `https://storage.googleapis.com/image-links-agent-public/catalog/uspa/ABC123/noon/ABC123_2.jpg`
- test batches use `catalog-test/` in both buckets.

`path_key` is fixed when the product row is created and never changes, even if a later upload spells
the identifier differently; `identifier` (verbatim, latest seen) is what the sheet shows.

### Links sheet (`packages/core/src/catalog/sheet.ts`)

```ts
export interface SheetRow {
  brand: string; identifier: string; optionIdStyleColor: string; opptraSkuIds: string[];
  links: Partial<Record<ChannelId, (string | null)[]>>;  // index = shot order - 1; null = removed or missing
  status: SheetStatus;            // from SHEET_STATUSES
  notes: string;
  change: ChangeKind;             // from CHANGE_KINDS
  changedAt: Date | null;
}
export interface SheetSpec { channels: ChannelId[]; rows: SheetRow[] }   // channels in the order ticked
export function sheetColumns(spec: SheetSpec): { fixed: string[]; perChannel: Record<ChannelId, number>; tail: string[] };
export async function writeLinksXlsx(spec: SheetSpec): Promise<Buffer>;
export function writeLinksCsv(spec: SheetSpec): string;
export async function fillProductListWorkbook(original: Buffer, spec: SheetSpec, matchColumn: number): Promise<Buffer>;
export async function compareXlsxCsv(xlsx: Buffer, csv: string): Promise<{ equal: boolean; differences: string[] }>;
```

Columns: `brand`, `identifier`, `option_id_style_color`, `opptra_sku_ids` (`;`-joined), then per
channel a merged header with the channel label over `Image 1..N` (N = the most shots that channel has
across the rows), then `status`, `notes`, `change`, `changed_at`. The CSV uses the flat header
`<Channel> Image n` for every image column and the same four tail columns.

Writer rules:
- `brand`, `identifier`, `option_id_style_color` and `opptra_sku_ids` are written as string values
  with `numFmt = "@"`, so a numeric identifier such as `8905701361431` displays in full.
- Both header rows are bold; the sheet is frozen below the header
  (`worksheet.views = [{ state: "frozen", ySplit: 2 }]`); each column width is the longest value in
  it, capped at 60 characters, with link columns at least 40.
- Rows are in natural sort order of `identifier` (one brand per batch). The same input always yields
  the same row order.
- Rows for `missing_images` products carry no links and the status word; `not_in_sheet` rows carry
  their links and the status word.
- `fillProductListWorkbook` (used by finalize in 06 when a product list workbook was uploaded) loads
  the operator's original workbook, keeps every sheet, column and value, appends `link_status` and
  per selected channel `<Channel> Image 1..N` on the right, repeats a colourway's links on each of
  its per-size rows, appends one row per `not_in_sheet` product at the bottom with its identifier in
  `matchColumn` (as text, `numFmt "@"`), its links and `link_status`, and returns the new buffer. The
  original upload is never modified.
- `compareXlsxCsv` flattens the xlsx with the reader and compares it to the CSV cell by cell; used by
  finalize (06) and the re-check (09).

ExcelJS calls confirmed in current docs (builders re-confirm with Context7 before coding):
`worksheet.mergeCells(r1, c1, r2, c2)` for each channel header, `cell.value = { text, hyperlink, tooltip }`
for clickable links, `await workbook.xlsx.writeBuffer()` for the Buffer, and for reading (04)
`await workbook.xlsx.load(buffer)` with `worksheet.eachRow((row, rowNumber) => ...)`.

### CSV (`packages/core/src/csv.ts`) and safe URL (`packages/core/src/safe-url.ts`)

Both are new files in this repo (nothing is moved from the old web app).

```ts
// csv.ts
export function csvField(v: unknown): string;          // quotes when needed, doubles inner quotes
export function csvLine(fields: unknown[]): string;
export function buildCsv(header: string[], rows: unknown[][]): string;   // CRLF line ends, UTF-8 BOM
export function parseCsv(text: string): string[][];    // RFC 4180: quoted fields, doubled quotes, CR LF and LF, BOM stripped

// safe-url.ts
export class UnsafeUrlError extends Error {}
export function assertSafeUrl(raw: string): URL;       // https only; host must not resolve to a private, loopback, link-local or metadata IP
export interface SafeFetchOptions { fetch?: typeof fetch; maxBytes?: number /* default 40 * 1024 * 1024 */; timeoutMs?: number; maxRedirects?: number /* default 5 */ }
export async function safeFetch(url: string, opts?: SafeFetchOptions): Promise<{ buf: Buffer; mime: string; finalUrl: string; status: number }>;
```

`safeFetch` follows redirects manually (`redirect: "manual"`), re-validates every hop with
`assertSafeUrl`, streams the body and stops with a plain error once `maxBytes` (40 MB) is exceeded.
Any https host with a public IP is allowed; Supabase and Azure blob hosts need no special case.
("SSRF" is the attack where a server is tricked into fetching an internal address; these two checks
prevent it.)

### Storage (`packages/core/src/storage.ts`)

The lifted base (`StorageLike`, `setStorageClient`, `getBucketName`, `parseGsUri`, `toGsUri`,
`uploadBuffer`, `downloadBuffer`, `signedUrl`, `MAX_SIGNED_URL_TTL_SEC`) is unchanged. Add:

```ts
getPublicBucketName(env)                      // PUBLIC_BUCKET, default "image-links-agent-public"
signedPutUrl(objectPath, contentType, ttlSec = 900)   // file.getSignedUrl({ version: "v4", action: "write", contentType, expires })
headObject(gsUri) -> { exists, size, contentType, generation, crc32c }   // file.exists(), file.getMetadata()
readRange(gsUri, start, endInclusive); createRangeStream(gsUri, start, endInclusive)   // file.download({start,end}) / createReadStream, inclusive end
listObjects(gsPrefixUri) -> string[]
stageCopyToPublic(stagingGsUri, objectPath, { ifGenerationMatch }) -> { generation: string; crc32c: string }
   // file.copy(publicBucket.file(objectPath), { preconditionOpts: { ifGenerationMatch }, contentType: "image/jpeg", cacheControl: PUBLIC_CACHE_CONTROL })
   // returns [copiedFile] whose metadata.generation is the new live generation; ifGenerationMatch 0 = must not exist yet
deletePublicObject(objectPath, productPrefix, { ifGenerationMatch })   // assertWithinProduct first; file.delete({ ifGenerationMatch })
setCustomTime(gsUri, when: Date)              // file.setMetadata({ customTime: when.toISOString() }) on superseded raw
deleteTestObjects(gsPrefixUri) -> number      // assertTestPrefix; the only bulk delete in the codebase
PUBLIC_CACHE_CONTROL = "public, max-age=300"
```

GCS client calls confirmed in current docs (builders re-confirm with Context7 before coding):
`file.getSignedUrl({ version: "v4", action: "write", contentType, expires })`; `file.download({ start, end })`
and `file.createReadStream({ start, end })` with an inclusive `end`; `file.getMetadata()` gives
`size`, `contentType`, `generation`, `crc32c`; `file.copy(destinationFile, { preconditionOpts:
{ ifGenerationMatch }, contentType, cacheControl })` resolves `[copiedFile, apiResponse]` and
`copiedFile.metadata.generation` is the new generation; `ifGenerationMatch: 0` means the object must
not exist; `file.delete({ ifGenerationMatch })`; `file.setMetadata({ customTime: isoString })`;
`bucket.setMetadata({ versioning: { enabled: true } })`; `bucket.setCorsConfiguration([...])`.

Rules:
- `stageCopyToPublic` and `deletePublicObject` are the only two functions that write to the public
  bucket, and both run only in the worker (the web service account has read-only access there).
- `deletePublicObject` calls `assertWithinProduct(objectPath, productPrefix)` before touching the
  client, so a wrong prefix fails in code before it can fail in IAM.
- A precondition mismatch (GCS HTTP 412) is surfaced as `GenerationMismatchError` with the sentence
  "Changed by another run. Start the batch again for this product." so 06 can mark the output failed.
- Every storage write, copy, delete and verify GET retries on 429, 5xx and network errors up to 3
  times with exponential backoff (1 s, 2 s, 4 s; builder constants `STORAGE_RETRIES`,
  `STORAGE_RETRY_BASE_MS`) inside the delivery before the output is marked `failed`. A precondition
  failure (412) is never retried. An output whose public object already verifies is never re-written.
- Signing on Cloud Run uses the IAM `signBlob` path; `catalog-web@` has
  `roles/iam.serviceAccountTokenCreator` on itself for that (bootstrap).
- Unit tests assert the exact precondition values with a fake client (see test plan).

### Tasks (`packages/core/src/tasks.ts`)

```ts
export type TaskRoute =
  | "/tasks/catalog/sync-master" | "/tasks/catalog/sweep" | "/tasks/catalog/ingest"
  | "/tasks/catalog/chunk" | "/tasks/catalog/publish" | "/tasks/catalog/finalize";
export interface EnqueueTaskOptions { delaySec?: number; taskId?: string; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; client?: TasksClientLike }
export async function enqueueTask(route: TaskRoute, body: Record<string, unknown>, opts?: EnqueueTaskOptions): Promise<string>;
export function buildTaskRequest(route: TaskRoute, body: Record<string, unknown>, cfg: TasksConfig, opts?: EnqueueTaskOptions, now?: number): { parent: string; task: unknown };
```

The queue comes from `TASKS_QUEUE` (default `catalog`). When `taskId` is given it becomes the Cloud
Tasks task name (`<queuePath>/tasks/<taskId>`, characters limited to letters, digits, `-` and `_`),
so a re-enqueue of the same chunk or publish is deduplicated by the queue. `TASKS_INLINE=1` keeps the
local behaviour: POST the body straight to `${WORKER_URL}${route}`, fire-and-forget. The
`dispatchDeadline` stays 900 seconds to match the worker's Cloud Run timeout.

### LLM client (`packages/core/src/llm/`)

Lifted as in the lift list. Contracts in brief:
- `chatCompletion(body, deps?)` posts to OpenRouter `/chat/completions`, redacts the key from every
  error, retries once on 429 or 5xx honouring `retry-after`, throws `OpenRouterError { status, bodySnippet, path }`.
- `callLlm(messages, { model, temperature?, maxTokens? }, deps?)` returns `{ text, usage, costUsd, model }`;
  `callLlmJson(messages, validate, opts, deps?)` parses with `parseJsonLoose`, retries once with
  `JSON_NUDGE`, returns `{ value, text, usage, costUsd, calls }`.
- The model is always passed explicitly; there is no default model and no model env var in this
  package. 07 reads the model from `model_policy`.
- No live call runs in any test of this spec; `deps.fetch` is a fake.

### Spend (`packages/core/src/spend.ts`)

```ts
export const DEFAULT_DAILY_SPEND_CAP_USD = 10;
export const SPEND_ENGINES = ["catalog_qa", "catalog_compute"] as const;
export type CapCheck = { ok: true } | { ok: false; reason: string };
export function dailyCapFromEnv(env = process.env): number;      // DAILY_SPEND_CAP_USD, default 10
export async function recordCost(db: Db, input: { brandSlug: string; batchId: string; engine: SpendEngine; costUsd: number; calls?: number; day?: Date }): Promise<void>;
export async function checkCaps(db: Db, input: { brandSlug: string; batchId: string; env?: NodeJS.ProcessEnv; now?: Date }): Promise<CapCheck>;
```

`recordCost` upserts into `spend_days` (adds `cost_usd` and `calls`). `checkCaps` refuses when the
UTC day's total across all brands has reached the daily cap, or when the batch's
`options.qaCapUsd` is set and the batch's `catalog_qa` total has reached it. Reasons are sentences
with an action ("Daily spend cap reached: $9.80 of $10.00 used this UTC day. Raise DAILY_SPEND_CAP_USD
or wait for the cap to reset at midnight UTC."). 07 is the first caller.

### Database (`packages/core/src/db/schema.ts`, migration `drizzle/0000_init.sql`)

All tables: uuid primary key `defaultRandom()` unless stated, `created_at` default now, snake_case
columns, text columns checked against the arrays in `catalog/types.ts` through Drizzle `text(...,
{ enum })`. `money` = `numeric(12,6)`. `users` is NOT in this migration: 03 adds it in its own
`0001_users.sql`. No other spec ships a migration.

```
brand_master          id, name text, slug text unique, line text enum softline|hardline, source text enum warehouse|manual,
                      synced_at timestamptz null, created_at
sku_map               opptra_sku text pk, brand text, brand_slug text (idx), line text, option_key text (idx), option_id_style_color text,
                      ean text (idx), color text, size text, channel_ids jsonb (keys namshi_ae, namshi_sa, child_zsku, noon_ae, noon_sa,
                      trendyol, centerpoint_ae_ksa, sixth_street_ae, sixth_street_sa, styli_ae_ksa, styli_sku, amazon, voga_closet, shein,
                      amazon_uae_ksa_asin), image_url text, source text enum warehouse|manual, synced_at timestamptz
model_policy          id, brand_slug text ("*" any), category text (ProductType or "*"), matte_model text, qa_model text, threshold int, floor int,
                      qa_mode enum QA_MODES default per_source, qa_sample_rate numeric default 1, source enum POLICY_SOURCES,
                      matte_target text enum cpu|gpu null (written by 08's bake-off; null = cpu),
                      matte_model_second text null, shadow_mode text enum preserve_only|preserve_else_synthesise null, qa_model_second text null
                      (the per-product-type defaults 07 writes and 08 overwrites),
                      eval_batch_ids jsonb string[] default [], gates jsonb null, created_at, updated_at; unique (brand_slug, category)
catalog_batches       id, brand_slug text (idx), brand_name text, name text, status enum BATCH_STATUSES default draft, is_test bool default false,
                      product_type enum PRODUCT_TYPES default auto, channels jsonb ChannelId[], options jsonb BatchOptions, counts jsonb BatchCounts,
                      cost jsonb BatchCost, report_uri text null, sheet_xlsx_uri text null, sheet_csv_uri text null, error text null,
                      created_by text, created_at, started_at null, finished_at null, updated_at
catalog_uploads       id, batch_id fk cascade (idx), kind enum UPLOAD_KINDS, name text, relative_path text null, gcs_uri text null, source_url text null,
                      size_bytes bigint null, mime text null, status enum pending|uploaded|collected|failed default pending, detected jsonb null,
                      error text null, created_at
catalog_products      id, brand_slug text, is_test bool, product_key text, path_key text, identifier text, option_id_style_color text null,
                      opptra_sku_ids jsonb string[] default [], sku_method text null, product_type text null, lock_batch_id fk catalog_batches null,
                      last_batch_id fk catalog_batches null, created_at, updated_at; unique (brand_slug, is_test, product_key)
catalog_batch_products batch_id fk cascade, product_id fk cascade, link_status enum LINK_STATUSES default ok, change enum CHANGE_KINDS,
                      flags jsonb OutputFlag[] default [], notes text default ""; pk (batch_id, product_id)
catalog_product_aliases id, brand_slug text, is_test bool, alias_key text, product_id fk cascade, kind enum ALIAS_KINDS, created_at;
                      unique (brand_slug, is_test, alias_key)
catalog_product_events id, product_id fk cascade (idx), batch_id fk null, kind enum EVENT_KINDS, actor text, details jsonb, at timestamptz default now
catalog_source_images id, product_id fk cascade (idx), batch_id fk (brought by), n int, sha256 text, is_current bool default false, superseded_at null,
                      replaces_id fk catalog_source_images null, original_name text, upload_id fk null, raw_uri text, mime text, width int null,
                      height int null, bytes bigint null, matte_uri text null, matte_model text null, matte_ms int null, flags jsonb default [],
                      status enum pending|prepared|matted|failed|unsupported default pending, error text null, created_at;
                      unique (product_id, n, sha256, batch_id)
catalog_outputs       id, batch_id fk (idx), product_id fk (idx), source_image_id fk, channel enum CHANNEL_IDS, n int,
                      canvas_w int, canvas_h int, scale numeric, placed_x int, placed_y int, bytes int null, quality int null, render_key text,
                      staging_uri text null, object_path text, public_url text, generation bigint null, crc32c text null, is_live bool default false,
                      compliance jsonb null, qa_scores jsonb null, qa_model text null, status enum OUTPUT_STATUSES default pending,
                      flags jsonb default [], reason text null, decision enum DECISIONS null, decided_by text null, decided_at null,
                      published_at null, published_by text null, superseded_at null, superseded_by_output_id fk null, attempt int default 1,
                      error text null, created_at, updated_at; partial unique (product_id, channel, n) where is_live
catalog_chunks        id, batch_id fk cascade (idx), index int, stage enum matte|render|qa, product_ids jsonb string[], source_image_ids jsonb null,
                      status enum queued|running|done|failed default queued, attempt int default 1, task_name text null, started_at null,
                      finished_at null, error text null, created_at
catalog_eval_labels   id, batch_id fk cascade (idx), output_id fk cascade, source_image_id fk, set_name text, identifier text, channel enum CHANNEL_IDS,
                      labeler text, label enum EVAL_LABELS, reasons jsonb string[], note text null, judge_verdict text null, judge_scores jsonb null, created_at
catalog_eval_judgements id, batch_id fk cascade (idx), output_id fk cascade, judge_model text, scores jsonb, verdict enum EVAL_LABELS, reasons jsonb string[],
                      cost_usd money, ms int, created_at; unique (output_id, judge_model)
spend_days            day date, brand_slug text, engine text (catalog_qa | catalog_compute), batch_id fk catalog_batches, cost_usd money default 0,
                      calls int default 0; pk (day, brand_slug, engine, batch_id)
```

Notes:
- `catalog_products` is brand-scoped and lives across batches. `lock_batch_id` is the product lock
  (one unfinished batch at a time); `last_batch_id` is the batch that last published it.
- `catalog_source_images.batch_id` means "brought by this batch"; `is_current` marks the one version
  per (product, n) that the next batch starts from. A new version is inserted as not current at
  ingest (04) and becomes current only when its product goes live in the publish step (06), which
  also sets `superseded_at` on the old version and `customTime` on its raw object; an abandoned draft
  therefore changes nothing; `replaces_id` links a replacement to the source it
  replaced (07).
- `catalog_outputs`: exactly one live row per (product, channel, n), enforced by the partial unique
  index; superseded rows keep their `generation` for the audit trail.
- `spend_days.batch_id` is part of the primary key, so Postgres requires it to be non-null; every
  catalog cost is incurred inside a batch, so `recordCost` always receives a `batchId`.
- Model ids live only in `model_policy`, `catalog_batches.options.policy`,
  `catalog_source_images.matte_model`, `catalog_outputs.qa_model`, `catalog_eval_judgements.judge_model`
  and logs; nothing that reaches an operator.

Migration: `pnpm --filter @catalog/core db:generate` writes `packages/core/drizzle/0000_init.sql` and
`meta/`; `createTestDb()` applies it in tests; the `catalog-migrate` Cloud Run job applies it on deploy.

### Worker server (`apps/worker/src/server.ts`)

```ts
export interface HandleOptions { retryCount?: number }                 // from x-cloudtasks-taskretrycount
export interface HandleResult { httpStatus: number; outcome: string }   // 200 done, 503 retry, 500 unexpected
export interface ServerDeps {
  auth: AuthConfig;
  version: string;                                                      // K_REVISION or "dev"
  routes: Partial<Record<TaskRoute, (body: Record<string, unknown>, opts: HandleOptions) => Promise<HandleResult>>>;
}
```

`handleRequest`: `GET /healthz` returns `{ ok: true, version, routes: Object.keys(deps.routes) }`
without auth; every other path must be a `POST` (405 otherwise), must pass `authorize()` from the
lifted `auth.ts` (401 or 403), must be in `routes` (404 otherwise) and must carry a JSON object body
(400 otherwise). The handler's `HandleResult` is sent as `{ outcome }` with its status. Unexpected
throws are logged as structured JSON (`severity: "ERROR"`) and answered 500. This worker `/healthz`
contract does not change later; the matting services' own `/healthz` (05) is a different endpoint
that lists `models: [{ id, inputSize, target: "cpu" | "gpu" }]` and `default`.

Handlers in this spec (`apps/worker/src/catalog/`):
- `sync-master.ts`: `handleSyncMaster(deps, body)` runs `syncMaster` and returns
  `{ httpStatus: 200, outcome: "synced:<brands>/<skus>" }`; a BigQuery error returns 503 so Cloud
  Scheduler retries.
- `sweep.ts`: `handleSweep(deps, body)` finds batches whose status is `ingesting`, `matting`,
  `rendering`, `qa` or `publishing` and whose most recent progress (the newest of `started_at`,
  `finished_at` across their chunks and the batch's own `updated_at`) is older than `SWEEP_STALE_MS`
  (2 hours, from the plan). Each such batch is set to `failed` with `error` = "No progress for 2
  hours. Start the batch again.", its product locks are released (`releaseLocks`), and one structured
  log event (`severity: "WARNING"`, batch id, released product count) is written. Returns
  `{ httpStatus: 200, outcome: "swept:<n>" }`. Idempotent: a second run finds nothing.

### Brand master and SKU map sync (`packages/core/src/catalog/master-sync.ts`)

```ts
export interface BigQueryLike { query(options: { query: string; location?: string; params?: Record<string, unknown> }): Promise<[Record<string, unknown>[], unknown]> }
export interface SyncResult { brands: number; skus: number; warnings: string[] }
export async function syncMaster(db: Db, bq: BigQueryLike, env = process.env): Promise<SyncResult>;
export const MASTER_SL_SQL: string;
export const MASTER_HL_SQL: string;
```

BigQuery client call confirmed in current docs (builders re-confirm with Context7):
`new BigQuery({ projectId })`, then `const [rows] = await bigquery.query({ query, location, params })`.
Project `BQ_PROJECT` (default `opptra-datawarehouse`), `BQ_LOCATION` (default `asia-south1`).

Queries (read-only, column names as the warehouse has them; the builder confirms the exact list with
`SELECT column_name FROM raw_gcc_dimensions.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '...'`
first and records it in the test fixture):
- Softline: `SELECT product_code, option_id_style_color, ean, color, size, fact_gcc.alias_gcc_brand(brand) AS brand,
  fact_gcc.family_of_gcc_brand(brand) AS line, image_url, namshi_ae, namshi_sa, child_zsku, noon_ae, noon_sa, trendyol,
  centerpoint_ae_ksa, 6th_street_ae, 6th_street_sa, styli_ae_ksa, styli_sku, amazon, voga_closet, shein FROM raw_gcc_dimensions.master_sl`.
- Hardline: `SELECT sku, ean, fact_gcc.alias_gcc_brand(brand) AS brand, fact_gcc.family_of_gcc_brand(brand) AS line,
  amazon_uae_ksa_asin, <noon, trendyol, styli id columns> FROM raw_gcc_dimensions.sku_master_sheet_hl`.

Upsert rules: `sku_map` keyed by `opptra_sku` (`product_code` for softline, `sku` for hardline);
`option_key = normalizeKey(option_id_style_color)` for softline and `normalizeKey(sku)` with the
trailing size segment removed for hardline; `brand_master` rows with `source = warehouse` upserted by
`slug = brandSlug(brand)`, `line` from `family_of_gcc_brand`; a manual brand whose slug now exists in
the warehouse is switched to `source = warehouse` and keeps its id; a `sku_map` row with
`source = manual` (07 mapping sheet) is overwritten when the warehouse later carries the same
`opptra_sku`. Brands and SKU rows are never deleted by the sync. `synced_at` is set on every touched row.

### Brands (`packages/core/src/catalog/brands.ts`)

```ts
export interface BrandOption { slug: string; name: string; line: "softline" | "hardline"; source: "warehouse" | "manual" }
export async function listBrandOptions(db: Db): Promise<BrandOption[]>;   // grouped by line (softline first), sorted by name
export async function addManualBrand(db: Db, input: { name: string; line: "softline" | "hardline"; createdBy: string }): Promise<BrandOption>; // idempotent on slug
```

There is no add-brand form. The wizard's brand list (06) comes from `listBrandOptions`, and its help
text says "Brand not in the list? Email sujan@opptra.com." A brand missing from the warehouse (for
example Anta or BHPC before their masters exist) is added by the admin through one of two paths, both
noted in `docs/solutions/manual-brand.md` by the builder:
- SQL in Cloud SQL Studio against database `catalog`:
  `INSERT INTO brand_master (name, slug, line, source) VALUES ('Anta', 'anta', 'softline', 'manual') ON CONFLICT (slug) DO NOTHING;`
- or `addManualBrand` called from a small one-file script run with the migrate job's connection.
The nightly sync reconciles the row by slug when the warehouse catches up.

### SKU resolution (`packages/core/src/catalog/sku-mapping.ts`)

```ts
export type SkuMethod = "option_key" | "ean" | "channel_id" | "product_code" | "manual" | "unresolved";
export interface ResolveInput { brandSlug: string; identifier: string; ean?: string | null; channelIds?: string[]; manual?: Map<string, string[]> }
export interface ResolveResult { optionIdStyleColor: string | null; opptraSkuIds: string[]; method: SkuMethod }
export async function resolveSkus(db: Db, input: ResolveInput): Promise<ResolveResult>;
export function parseManualMapping(rows: string[][]): Map<string, string[]>;   // columns identifier, opptra_sku_id; several rows per identifier allowed
```

Order, stopping at the first hit, all on `normalizeKey` values and restricted to the batch's brand
slug: `option_key` -> `ean` -> channel id (any of `styli_sku`, `styli_ae_ksa`, `child_zsku`, `noon_ae`,
`noon_sa`, `amazon`, `amazon_uae_ksa_asin`) -> `product_code` with the trailing size segment removed
-> manual map -> `unresolved`. A hit returns every per-size `opptra_sku` for that option, sorted.
Unresolved is a normal state, not a warning: SKU ids are optional and may arrive later.

### Product identity helpers (`packages/core/src/catalog/products.ts`)

A product is one brand plus one style+colour identifier. `product_key = normalizeKey(identifier)`
decides whether an upload is a known product (`ABC-123`, `abc_123` and `ABC123` are the same);
`path_key = sanitizeSegment(identifier)` as first seen is the path segment for life. Opptra SKU ids
are attributes, never part of the key or any path.

```ts
export async function findOrCreateProduct(db: Db, input: { brandSlug: string; isTest: boolean; identifier: string; skus: ResolveResult | null; productType?: ProductType; actor: string }): Promise<{ product: CatalogProduct; isNew: boolean }>;
export async function addAlias(db: Db, input: { productId: string; aliasKey: string; kind: AliasKind; actor: string; batchId?: string | null }): Promise<void>;
export type LockResult = { ok: true } | { ok: false; busy: { productId: string; identifier: string; batchId: string; batchName: string }[] };
export async function lockProducts(db: Db, batchId: string, productIds: string[]): Promise<LockResult>;
export async function releaseLocks(db: Db, batchId: string): Promise<number>;
export async function recordEvent(db: Db, input: { productId: string; batchId?: string | null; kind: EventKind; actor: string; details?: Record<string, unknown> }): Promise<void>;
```

- `findOrCreateProduct`: (1) `normalizeKey(identifier)` found in `catalog_product_aliases` for the
  brand and `is_test` -> existing product; (2) `skus.optionIdStyleColor` normalised found in aliases
  -> existing product; (3) otherwise insert the product with `product_key`, `path_key`, `identifier`,
  the resolved ids, its own key as the first alias (`kind: identifier`), a `created` event, and
  `isNew: true`. In every case the resolved `option_id` and each `opptra_sku` become aliases if not
  yet present, and a changed `opptra_sku_ids` list writes a `sku_ids_added` event. Insert races are
  resolved by the unique index: on conflict, re-read and return `isNew: false`.
- `addAlias`: inserts the alias and a `alias_added` event; a key already pointing at another product
  fails with "This name already belongs to <identifier>."
- `lockProducts`: one transaction, `UPDATE catalog_products SET lock_batch_id = $batch WHERE id IN (...)
  AND (lock_batch_id IS NULL OR lock_batch_id = $batch)`; if the row count is short the transaction
  rolls back and the result lists the busy products with the batch that holds them, so 06 can show
  "ABC123 and 4 others are still being processed in batch <name>. Wait for it to finish or remove
  them from this upload."
- `releaseLocks`: `UPDATE ... SET lock_batch_id = NULL WHERE lock_batch_id = $batch`; returns the count.
- `recordEvent`: `actor` is the signed-in email or `system` (sync, sweep).

### Env vars added by this spec

| Name | Default | Used by |
|---|---|---|
| `GCP_PROJECT` | `image-links-agent` | web, worker |
| `REGION` | `asia-south1` | web, worker |
| `BUCKET` | `image-links-agent-assets` | web, worker |
| `PUBLIC_BUCKET` | `image-links-agent-public` | web, worker |
| `DB_HOST`, `DB_NAME=catalog`, `DB_USER=catalog_app`, `DB_PASSWORD` (secret `catalog-db-password`) | | web, worker |
| `DB_POOL_MAX` | `2` (worker), `3` (web) | web, worker |
| `TASKS_QUEUE` | `catalog` | web, worker |
| `WORKER_URL`, `WORKER_SA_EMAIL` | | web, worker |
| `SHARE_SA_EMAIL` | `catalog-web@image-links-agent.iam.gserviceaccount.com` | web |
| `BQ_PROJECT` | `opptra-datawarehouse` | worker |
| `BQ_LOCATION` | `asia-south1` | worker |
| `MATTING_URL` | none (defined in 05; the worker refuses to matte without it) | worker |
| `MATTING_GPU_URL` | none, optional (defined in 05; when unset every model runs on the CPU service) | worker |
| `TASKS_INLINE`, `SKIP_OIDC`, `REAL_DATA` | dev and test only | |

### Infra: `infra/bootstrap.sh` (check-then-create, re-runnable, no deletes, nothing secret printed)

Shared resources that already exist and are only checked (the script stops with a clear message if
one is missing): VPC `ila-vpc`, subnet `ila-subnet`, Cloud SQL instance `ila-pg`, Artifact Registry
repo `apps`, private bucket `gs://image-links-agent-assets`, secret `openrouter-api-key`. The old
`ila-web` and `ila-worker` services are left as they are.

1. APIs: ensure `run`, `cloudtasks`, `sqladmin`, `secretmanager`, `artifactregistry`, `cloudbuild`,
   `storage`, `iam`, `iamcredentials`, `logging`, `cloudresourcemanager`, plus
   `sheets.googleapis.com`, `drive.googleapis.com`, `bigquery.googleapis.com`,
   `cloudscheduler.googleapis.com`.
2. Database: `gcloud sql databases create catalog --instance=ila-pg` if missing; user `catalog_app`
   with a password generated in memory (`openssl rand -base64 24`), stored as secret
   `catalog-db-password` (`--data-file=-`) and passed to `sql users create`; never echoed, logged or
   written to disk. If the user exists but the secret does not, stop with an error rather than reset.
3. IAP (sign-in for `catalog-web`, 03): enable `iap.googleapis.com` and
   `cloudresourcemanager.googleapis.com` (step 1 list); `gcloud beta services identity create
   --service=iap.googleapis.com` (idempotent); `project_binding` of
   `serviceAccount:service-<project-number>@gcp-sa-iap.iam.gserviceaccount.com` to `roles/run.invoker`
   (already present from the earlier app, so SKIP). No OAuth client, brand or auth secret is created;
   IAP uses the Google-managed client. The `domain:opptra.com` access grant needs the service to
   exist and lives in `deploy.sh` (03).
4. Public bucket `gs://image-links-agent-public`: create with `--location=asia-south1
   --uniform-bucket-level-access` (no public access prevention); `add-iam-policy-binding
   --member=allUsers --role=roles/storage.objectViewer`; `gcloud storage buckets update --versioning`;
   `--lifecycle-file=infra/lifecycle-public.json`. If an org policy blocks `allUsers`, print the policy
   name and exit 2.
5. Assets bucket: `--lifecycle-file=infra/lifecycle-assets.json`; `--cors-file=infra/cors.json`
   (origin `*` until the first deploy, then the web URL; methods `PUT, GET, HEAD`; response headers
   `Content-Type, Content-Length`; max age 3600).
6. Queue `catalog`: `gcloud tasks queues create catalog --location=asia-south1
   --max-concurrent-dispatches=20 --max-attempts=5 --min-backoff=10s`.
7. Service accounts: `ensure_sa catalog-web`, `ensure_sa catalog-worker`, `ensure_sa catalog-matting`.
8. IAM (project level where resource level is denied; note the fallback in `docs/solutions/`):
   - `catalog-worker@`: `roles/storage.objectUser` on the public bucket (overwrite and scoped delete
     need `storage.objects.delete`); if the role is not available in the org, fall back to
     `roles/storage.objectAdmin` on that bucket only and print a WARN line.
   - `catalog-web@`: `roles/storage.objectViewer` on the public bucket (it never writes there) and
     `roles/storage.objectAdmin` on the assets bucket (signed PUTs, exports).
   - `catalog-worker@`: `roles/storage.objectAdmin` on the assets bucket.
   - Both: `roles/cloudsql.client`, `roles/secretmanager.secretAccessor`, `roles/cloudtasks.enqueuer`.
   - `catalog-worker@`: `roles/run.invoker` (project level) for matting and scheduler calls.
   - `catalog-web@`: `roles/iam.serviceAccountTokenCreator` on itself (signed URLs);
     `catalog-web@` and `catalog-worker@`: `roles/iam.serviceAccountUser` on `catalog-worker@`.
   - `catalog-matting@`: no bucket or database rights (it receives bytes and returns bytes).
   - Cloud Build default SA: `roles/cloudbuild.builds.builder`, `roles/artifactregistry.writer`,
     `roles/logging.logWriter`.
9. BigQuery cross-project IAM for `catalog-worker@`: `roles/bigquery.dataViewer` on datasets
   `raw_gcc_dimensions`, `dimensions`, `fact_gcc` of `opptra-datawarehouse` and
   `roles/bigquery.jobUser` on that project. If the operator lacks rights there, print the exact
   commands and continue (exit 2 at the end).
10. Cloud Scheduler: `WORKER_URL=https://catalog-worker-<project-number>.asia-south1.run.app`.
    `catalog-sync-master` with `--schedule="$SYNC_MASTER_CRON"` (nightly; the exact cron is a builder
    constant at the top of the script) and `catalog-sweep` with `--schedule="$SWEEP_CRON"` (every 30
    minutes; builder constant). Both: `--uri=${WORKER_URL}/tasks/catalog/<route> --http-method=POST
    --message-body='{}' --headers=Content-Type=application/json
    --oidc-service-account-email=catalog-worker@... --oidc-token-audience=${WORKER_URL}
    --attempt-deadline=600s`. Flags confirmed with Context7 before use. The lifted `authorize()`
    accepts these calls because the token email is the worker SA and the audience is `WORKER_URL`.
11. Second run prints only SKIP lines and exits 0.

Lifecycle files:
- `infra/lifecycle-public.json`: delete when `isLive: false` and `daysSinceNoncurrentTime: 30`;
  delete when `numNewerVersions: 4` (keeps at most three older versions per path).
- `infra/lifecycle-assets.json`: delete `matchesPrefix` `catalog/`, `catalog-test/` with
  `matchesSuffix`-free name patterns for `/uploads/` and `/derived/` at `age: 180`; `/raw/` at
  `daysSinceCustomTime: 180` (current raw has no `customTime` and is never removed); `/staging/` at
  `age: 30`; `exports/` has no rule. Builders confirm the condition names with Context7 and keep the
  file as data, not generated.

### Infra: `infra/deploy.sh`

`TAG=$(git rev-parse --short HEAD)`, `AR=asia-south1-docker.pkg.dev/image-links-agent/apps`;
`SKIP_BUILD=1` reuses the images for the current commit. `WORKER_URL` and `WEB_URL` are the
deterministic `https://catalog-<svc>-<project-number>.asia-south1.run.app` forms.

1. Smoke gate (from 06 on): `pnpm catalog:smoke` runs before the build when the entry exists; any
   `failed_compliance` stops the deploy.
2. Build: `gcloud builds submit --config cloudbuild.yaml --substitutions=_AR=...,_TAG=...` (two images
   here, three from 05).
3. `ENV_VARS` as in the env table (`DB_HOST` from `gcloud sql instances describe ila-pg`); secrets
   `DB_PASSWORD=catalog-db-password:latest` for all; the web adds `IAP_AUDIENCE` and
   `ALLOWED_HOSTED_DOMAIN` in 03 (no auth secrets); the worker adds `OPENROUTER_API_KEY` in 07. `--network=ila-vpc --subnet=ila-subnet --vpc-egress=private-ranges-only`.
4. `catalog-migrate` job: `gcloud run jobs deploy catalog-migrate --image=$AR/worker:$TAG --command=node
   --args=dist/migrate.js --service-account=catalog-worker@... --max-retries=0 --task-timeout=600`,
   then `jobs execute --wait`.
5. `catalog-worker`: private (`auth_flag` pattern: `--no-allow-unauthenticated` on first create,
   `--invoker-iam-check` afterwards), `--cpu=2 --memory=2Gi --concurrency=2 --min-instances=0
   --max-instances=10 --timeout=900`, `DB_POOL_MAX=2`.
6. `catalog-web`: private like the worker (`auth_flag` pattern) and `--iap` from 03 on (in this spec
   the placeholder page is deployed private without `--iap`, reachable only through an identity
   token; 03 adds `--iap`, `IAP_AUDIENCE` and the `domain:opptra.com` grant); `--cpu=1 --memory=1Gi
   --min-instances=0 --max-instances=3 --timeout=300`, `DB_POOL_MAX=3`. Never
   `--allow-unauthenticated`.
7. `catalog-matting` (CPU, asia-south1) and `catalog-matting-gpu` (L4, asia-southeast1): from 05
   (CPU `--cpu=4 --memory=16Gi --concurrency=1 --min-instances=0 --max-instances=20 --timeout=300`;
   GPU `--cpu=4 --memory=16Gi --gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy --concurrency=1
   --min-instances=0 --max-instances=3`; both private; 05 owns the exact flags).
8. Print `web:`, `worker:` and (from 05) `matting:` and `matting-gpu:` URLs.

## Workstreams

- A `scaffold-and-core-data` (worktree `catalog-module-wt/02-scaffold-and-core-data`): repo scaffold,
  root files, manifests, CI, Dockerfiles, `cloudbuild.yaml`, `build.mjs`, the lifted `llm/`,
  `db/{client,migrate,testing}.ts`, `errors.ts`, `ui.tsx`, `AutoRefresh.tsx`; then `catalog/types.ts`,
  `channels.ts`, `naming.ts`, `sheet.ts`, `csv.ts`, `safe-url.ts`. Depends on nothing; the others
  branch from its first commit (the scaffold) so `pnpm install` works everywhere.
- B `storage-tasks-infra` (worktree `.../02-storage-tasks-infra`): `storage.ts`, `tasks.ts`,
  worker `server.ts`, `auth.ts`, `index.ts`, `runtime.ts`, `migrate.ts`, `catalog/sweep.ts` skeleton,
  `bootstrap.sh`, `deploy.sh`, the three JSON files. Imports `naming.ts` from A for
  `assertWithinProduct` (a stub with the same signature until merge).
- C `schema-master-products` (worktree `.../02-schema-master-products`): `schema.ts`, `0000_init.sql`,
  `spend.ts`, `master-sync.ts`, `brands.ts`, `sku-mapping.ts`, `products.ts`, `catalog/sync-master.ts`,
  the real-data test. Starts from A's `types.ts` arrays (a stub with the same arrays until merge).
- Integration: merge A, B, C on the feature branch; wire `index.ts` routes; run
  `pnpm lint && pnpm typecheck && pnpm test`, then tier 3, then bootstrap twice.

## Test plan

Tier 1 (unit, vitest, fakes only):
- `channels.ts`: every id present; a test re-declares the table and compares every field;
  `backgroundFor("amazon", 1) === "#FFFFFF"`, `backgroundFor("amazon", 2) === "#E0E0E0"`;
  `STYLI_SKIP_LOW_RESOLUTION === true`; `CHANNEL_RULES_VERSION` is a non-empty string.
- `naming.ts`: `ABC123_1.jpg`, `ABC123-2.JPG`, `ABC123_03.png`, `ABC 123_1.jpg`, `7055653305_1.jpg`,
  `ABC123_rect_1.jpg`, `ABC123_1_square.jpg`; three-digit cap: `ABC123_100.jpg` is n 100,
  `IMG_2041.heic` is identifier `IMG_2041` with n null (the caller assigns 1 for a single file), and
  `ONLY-SHOES_Autumnwinter_5079628_15380145.jpg` is identifier
  `ONLY-SHOES_Autumnwinter_5079628_15380145` with n null; `ABC123.jpg` gives n null;
  `ABC123_2_v3.jpg` gives identifier `ABC123_2`, n 3 (no version rule exists); `shotStem` has two
  arguments and no `_v` ever appears in any path from this module; `publicObjectPath` ends in
  lowercase `.jpg` for every channel and input case and contains no batch id; position renumbering:
  files numbered `_1`, `_2`, `_4` become positions 1, 2, 3 with `numbering_gap` and the notes
  sentence naming shot 3; `productPrefix` ends with `/`; `publicUrl` has no spaces
  and round-trips through `new URL()`; `assertWithinProduct` throws for another product's prefix
  (`catalog/uspa/ABC124/...` against `catalog/uspa/ABC123/`), for a non-catalog prefix
  (`eval/uspa/ABC123/`) and for a prefix-looking string without the trailing slash
  (`catalog/uspa/ABC12`); `assertTestPrefix` throws outside `catalog-test/`.
- `sheet.ts`: two channels with 3 and 2 shots; merged ranges; hyperlinks; `change` and `changed_at`
  tail columns; CSV flat header `Noon Image 1`; a row with `null` cells leaves blanks; a 13-digit
  identifier is written and read back as the same string (`numFmt "@"`); both header rows bold and
  `views[0].ySplit === 2`; column widths within the caps; rows come out in natural sort order
  regardless of input order; a `missing_images` row has no links and a `not_in_sheet` row keeps
  them; `fillProductListWorkbook` keeps every original cell, appends the columns, repeats links on
  per-size rows and appends the `not_in_sheet` row; `compareXlsxCsv(writeLinksXlsx(s), writeLinksCsv(s))`
  is equal and a changed cell is reported.
- `csv.ts`: quotes, CRLF, BOM; `parseCsv(buildCsv(...))` round-trips.
- `safe-url.ts`: `safeFetch` follows 2 redirects, rejects a redirect to a private IP, stops at `maxBytes`.
- `storage.ts` with a fake client: `signedPutUrl` passes `{ version: "v4", action: "write", contentType }`;
  `readRange` passes inclusive `end`; `stageCopyToPublic` passes `preconditionOpts.ifGenerationMatch`
  exactly as given (0 and a real generation), `contentType: "image/jpeg"` and
  `cacheControl: "public, max-age=300"`, and returns the copied file's generation and crc32c;
  `deletePublicObject` passes `ifGenerationMatch` and refuses an out-of-prefix path before calling the
  client; `deleteTestObjects` throws for a prefix outside `catalog-test/`; `setCustomTime` passes an
  ISO string.
- `tasks.ts`: `buildTaskRequest` for each of the six routes; `taskId` becomes `task.name` under the
  queue path; `TASKS_INLINE=1` posts to `${WORKER_URL}${route}`.
- `llm/`: `chatCompletion` redacts the key in errors and retries once on 429; `callLlm` throws when
  no model is given; `parseJsonLoose` cases lifted.
- `spend.ts`: `dailyCapFromEnv` defaults and invalid values; `checkCaps` reasons.
- `server.ts`: `/healthz` lists routes; 405, 401/403, 404, 400 paths; dispatch to the right handler;
  `retryCount` passed through.
- `sku-mapping.ts`: each method hits in order on a PGlite-seeded `sku_map`; several sizes sorted;
  `unresolved` when nothing matches; manual map wins only after the others miss.
- `products.ts`: `lockProducts` contention: lock three products for batch 1, then try four for batch
  2 including one of them -> `ok: false` with the busy row naming batch 1 and no row changed
  (transaction rolled back); `releaseLocks` returns 3.

Tier 2 (PGlite integration):
- `0000_init.sql` applies on a fresh PGlite; every table and index above exists; the partial unique
  index on `catalog_outputs (product_id, channel, n) where is_live` allows two non-live rows and
  rejects a second live row; `catalog_product_aliases` rejects a duplicate `(brand_slug, is_test,
  alias_key)`; `catalog_products` rejects a duplicate `(brand_slug, is_test, product_key)`; an
  invalid enum value fails; no `users` table exists yet.
- `findOrCreateProduct`: the same identifier spelled `ABC-123` then `abc_123` returns the same product
  with `isNew: false` and `path_key` unchanged; an identifier matching a resolved `option_id` alias
  lands on the existing product; new SKU ids write `sku_ids_added`.
- `syncMaster` with a fake `BigQueryLike` returning 5 softline and 3 hardline rows: upserts; a second
  run changes nothing but `synced_at`; a manual brand is reconciled to `warehouse`; no row deleted.
- `handleSweep` on a PGlite batch with old chunk timestamps: status `failed`, locks released, the
  error sentence set; a fresh batch untouched.

Tier 3 (real data, `REAL_DATA=1 pnpm test:real`, `packages/core/src/catalog/master-sync.real.test.ts`):
- Runs `syncMaster` against the real BigQuery project with Application Default Credentials into a
  PGlite database (no Cloud SQL needed). Asserts: softline brands include USPA, French Connection,
  Campus, Penti, Nautica, Vero Moda, Keds, Cardio Bunny, Puma and hardline brands include Bergner,
  Carote, Nutricook, NutriBullet, GTPlayer, Tower, Dowinx, Qubo, Nuwey; `sku_map` has at least
  16,612 + 335 rows; `resolveSkus` for the first USPA `option_id_style_color` of the sync result
  returns more than one per-size SKU with method `option_key`.
- Writes nothing to GCS. If the ADC account lacks BigQuery access, the test fails with the exact IAM
  commands from bootstrap in its message.

Infra check: `bash infra/bootstrap.sh` once, then a second time with every line SKIP and exit 0; both
outputs pasted in the PR. Tier 4 and 5 do not apply yet (nothing an operator can use).

## Done criteria

- The repo at `C:\Users\Sujan AH\Desktop\catalog-module` has the layout above; `pnpm install
  --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` is green locally and in CI.
- Every contract above exists with the exact names and signatures; no file imports anything from
  `image-links-agent`; no `_v<k>`, batch id or SKU id appears in any public path helper.
- `0000_init.sql` generated and applied by `createTestDb()`; the partial unique index and the alias
  unique index exist.
- `REAL_DATA=1 pnpm test:real` passes the master-sync real test on the integrator's machine.
- `bootstrap.sh` created the database and user, enabled the IAP API, ensured the IAP service agent
  and its `roles/run.invoker` binding (SKIP expected), the public bucket with `allUsers` read, versioning and
  lifecycle, the assets lifecycle and CORS, the queue, the three service accounts, the IAM bindings
  (or printed the exact commands), and the two scheduler jobs; a second run is all SKIP.
- `deploy.sh` built the two images, ran `catalog-migrate`, deployed `catalog-worker` (private) and
  `catalog-web` (private, placeholder page); `GET ${WORKER_URL}/healthz` through an identity
  token returns `{ ok, version, routes: ["/tasks/catalog/sync-master", "/tasks/catalog/sweep"] }`;
  one manual `gcloud scheduler jobs run catalog-sync-master` followed by `SELECT count(*) FROM sku_map`
  shows rows.
- `docs/solutions/` has the two lifted learnings plus `manual-brand.md`.

## Merge, deploy, report

Follow `00-execution-protocol.md`. One PR from `feat/catalog-02-scaffold-and-foundations` with the
test output, the two bootstrap runs and the `/healthz` response. Deploy with `infra/deploy.sh`. The
report lists what shipped, the test evidence, anything excluded and why, and confirms that 03 needs
no manual step from the human (IAP uses the Google-managed OAuth client). It ends with "Ready for the
next spec: 03 Auth and roles".

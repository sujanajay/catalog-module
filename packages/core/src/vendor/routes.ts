/**
 * M7-F2 vendor interface: the capabilities every module calls through, the states a route can be in, and the seed
 * route table (M7-F2-R2). Route ids and model ids are internal: they reach logs and stored judgements, never
 * operator text (M7-F2-R6).
 */
export const CAPABILITIES = ["vision.read", "judge.render", "image.matte", "image.upscale", "ocr.read", "people.detect"] as const;
export type Capability = typeof CAPABILITIES[number];
/** Candidate states from M7 3.2. Only `serving` routes are called; the harness (M7-F6) moves the others. */
export const ROUTE_STATES = ["registered", "benchmarked", "shadow", "canary", "serving", "retired", "off"] as const;
export type RouteState = typeof ROUTE_STATES[number];
/** How a route is reached: OpenRouter (M7-S2), our own matting and upscale services and the overflow vendor (M3-S5). */
export const ROUTE_ADAPTERS = ["openrouter", "matting-gpu", "matting-cpu", "upscale-gpu", "upscale-cpu", "photoroom"] as const;
export type RouteAdapter = typeof ROUTE_ADAPTERS[number];
/**
 * M3-F2-R3: the bought overflow adapters. A route on one of them is called only within its `dailyCapUsd` (no cap: never
 * called), and its ledger rows carry the adapter as their engine, so the cost meter shows the overflow line.
 */
export const OVERFLOW_ADAPTERS: readonly RouteAdapter[] = ["photoroom"];
export const isOverflowAdapter = (adapter: string): boolean => (OVERFLOW_ADAPTERS as readonly string[]).includes(adapter);
/**
 * Capabilities that send brand photos: a route without a written no-training position cannot be switched to
 * `serving` for them (M7-F2-R7).
 */
export const BRAND_PHOTO_CAPABILITIES: readonly Capability[] = ["vision.read", "judge.render", "image.matte", "image.upscale", "ocr.read", "people.detect"];

/** One row of the route table (M7 3.3 `Route`). */
export interface RouteDef {
  /** Stable id: `<capability>:<adapter>:<model>`. */
  id: string;
  capability: Capability;
  /** Call order, 1 first. Route 1 is what the kill switch turns off. */
  rank: number;
  adapter: RouteAdapter;
  model: string;
  paramsVersion: string;
  /** List price per call in USD, for the harness and the bake-off; the ledger records the billed cost. */
  priceUsd: number | null;
  /** Requests per minute the route is allowed, when the vendor sets one. */
  rateLimitPerMin: number | null;
  region: string | null;
  licence: string | null;
  /** The written no-training position (document and date), or null when none is on file. */
  noTrainingTerms: string | null;
  state: RouteState;
  /**
   * M3-F2-R3: the most an overflow route may spend in one UTC day, in USD (ledger rows of its engine and kind). Null on
   * an overflow route means it is never called; own routes have none.
   */
  dailyCapUsd: number | null;
}

/**
 * The seeded no-training position of a route nobody has decided on yet (M7-F2-R7). A route whose position is missing
 * or still this value is never called for a capability that sends brand photos, and the database refuses it as
 * `serving` (CHECK `vendor_routes_serving_needs_terms_check`). Recording the owner's decision is a data change:
 * `setRoute(db, id, {noTrainingTerms, state: "serving", changedBy, reason})`.
 */
export const NO_TRAINING_PENDING = "pending: owner decision";
/** True when a written no-training position is on file (not missing, blank or pending). */
export const hasNoTrainingPosition = (terms: string | null | undefined): boolean => !!terms?.trim() && !terms.trim().toLowerCase().startsWith("pending");
/** M7-F2-R7: a route may be called only when it is `serving` and, for a brand-photo capability, has a position on file. */
export const routeCallable = (route: Pick<RouteDef, "capability" | "state" | "noTrainingTerms">): boolean =>
  route.state === "serving" && (!BRAND_PHOTO_CAPABILITIES.includes(route.capability) || hasNoTrainingPosition(route.noTrainingTerms));

/**
 * The owner's written no-training position for the OpenRouter routes (M7-F2-R7), recorded by Sujan on 2026-11-03:
 * OpenRouter's provider data policy covers it (it does not route to providers that train on or log prompts unless
 * the account opts in). A future route without a decision is seeded with NO_TRAINING_PENDING instead.
 */
export const OPENROUTER_NO_TRAINING_POSITION = "OpenRouter provider data policy (https://openrouter.ai/docs/guides/privacy/data-collection); owner decision 2026-11-03";

export const routeId = (capability: Capability, adapter: RouteAdapter, model: string) => `${capability}:${adapter}:${model}`;

/**
 * M1 D43: models measured to pass what a judge must catch, so they can never judge again, whatever a route row, a policy
 * row, a pinned batch or an environment setting says: google/gemini-2.5-flash-lite caught 0 of 14 known defects. The
 * classifier is not a judge and keeps using it.
 */
export const RETIRED_JUDGE_MODELS: readonly string[] = ["google/gemini-2.5-flash-lite"];
export const isRetiredJudge = (capability: Capability, model: string): boolean => capability === "judge.render" && RETIRED_JUDGE_MODELS.includes(model);

/**
 * The seed chains for the capabilities this slice folds in (M7-F2-R2): the judge (`judge.render`, M1 D43: only models
 * that pass the judge exam, evals/judge-exam.ts) and the product classifier, which is the first reading of a photo
 * (`vision.read`). The prices are per check, measured. The matting and upscale chains are added by M3-S5 with their adapters.
 */
const OPENROUTER_ROUTES: readonly {capability: Capability; rank: number; model: string; priceUsd: number}[] = [
  {capability: "judge.render", rank: 1, model: "anthropic/claude-haiku-5.5", priceUsd: 0.00074},
  {capability: "judge.render", rank: 2, model: "google/gemini-3.8-flash", priceUsd: 0.00556},
  {capability: "vision.read", rank: 1, model: "google/gemini-2.5-flash-lite", priceUsd: 0.0004},
  {capability: "vision.read", rank: 2, model: "anthropic/claude-haiku-5.5", priceUsd: 0.0004},
  {capability: "vision.read", rank: 3, model: "qwen/qwen3-vl-30b-a3b-instruct", priceUsd: 0.0004},
];
const OPENROUTER_SEED_ROUTES: readonly RouteDef[] = OPENROUTER_ROUTES.map(({capability, rank, model, priceUsd}) => ({
  id: routeId(capability, "openrouter", model), capability, rank, adapter: "openrouter" as const, model, paramsVersion: "1",
  priceUsd, rateLimitPerMin: null, region: "openrouter", licence: "OpenRouter terms of service",
  noTrainingTerms: OPENROUTER_NO_TRAINING_POSITION, state: "serving" as const, dailyCapUsd: null,
}));

/**
 * The no-training position of our own matting and upscale services (M7-F2-R7): the photo goes to a Cloud Run service in
 * our own project and to no third party, so nothing can train on it (M3 Integration decision D9).
 */
export const OWN_SERVICE_NO_TRAINING_POSITION = "Own service in project image-links-agent: no third party receives the photo (M3 decision D9)";
/**
 * The cut-out models the matting services serve, with their recorded licences (M3-F2-R6). Kept in step with
 * catalog/matte.ts DEPLOYED_MATTE_MODELS by a test. The order is the rank among the GPU routes: model 1 first.
 */
export const MATTE_ROUTE_MODELS = [
  {model: "birefnet-general", licence: "MIT"},
  {model: "birefnet-general-lite", licence: "MIT"},
  {model: "birefnet-hrsod", licence: "MIT"},
  {model: "bria-rmbg", licence: "CC BY-NC 4.0 (internal tool only, spec 08; replaced before outside-brand self-serve, M12)"},
] as const;
/** The overflow vendor's cut-out and enlargement routes (M3-F2 4.2.8), seeded off with no position and no cap. */
export const PHOTOROOM_MATTE_MODEL = "segment-v1";
export const PHOTOROOM_UPSCALE_MODEL = "edit-v2-upscale-ai.fast";
/**
 * M3-S5 seed chains (M7-F2-R2 table, M3-F2-R3 and decision D8):
 * - `image.matte`: every served model on the GPU services (ranks 1 to 4), then the overflow vendor (rank 10, `off`, no
 *   no-training position, no cap: the adapter ships switched off), then every model on the CPU cut-out service (ranks 11
 *   to 14, today's fallback). With overflow off a GPU outage behaves as before (the CPU service, same model); with
 *   overflow on, the vendor answers before the slow CPU service.
 * - `image.upscale`: the GPU upscaler's x2 and x4 models, the CPU upscaler (`off`: an admin switch only, it costs 2.6x the
 *   GPU) and the vendor (`off`). The spec 18 enlargement lifecycle does not read these rows yet (decision D10).
 * Switching the vendor on is data: `setRoute(db, id, {noTrainingTerms, state: "serving", dailyCapUsd, ...})`.
 */
const own = {paramsVersion: "1", rateLimitPerMin: null, region: "asia-south1", noTrainingTerms: OWN_SERVICE_NO_TRAINING_POSITION, dailyCapUsd: null} as const;
const vendor = {paramsVersion: "1", rateLimitPerMin: null, region: "photoroom", licence: "Photoroom API terms of service", noTrainingTerms: NO_TRAINING_PENDING, state: "off" as const, dailyCapUsd: null} as const;
export const IMAGE_SEED_ROUTES: readonly RouteDef[] = [
  ...MATTE_ROUTE_MODELS.map(({model, licence}, i): RouteDef => ({...own, id: routeId("image.matte", "matting-gpu", model), capability: "image.matte", rank: 1 + i, adapter: "matting-gpu", model, priceUsd: 0.0018, licence, state: "serving"})),
  {...vendor, id: routeId("image.matte", "photoroom", PHOTOROOM_MATTE_MODEL), capability: "image.matte", rank: 10, adapter: "photoroom", model: PHOTOROOM_MATTE_MODEL, priceUsd: 0.02},
  ...MATTE_ROUTE_MODELS.map(({model, licence}, i): RouteDef => ({...own, id: routeId("image.matte", "matting-cpu", model), capability: "image.matte", rank: 11 + i, adapter: "matting-cpu", model, priceUsd: null, licence, state: "serving"})),
  {...own, id: routeId("image.upscale", "upscale-gpu", "swinir-x2"), capability: "image.upscale", rank: 1, adapter: "upscale-gpu", model: "swinir-x2", priceUsd: 0.0039, licence: "Apache-2.0", state: "serving"},
  {...own, id: routeId("image.upscale", "upscale-gpu", "swinir-x4"), capability: "image.upscale", rank: 2, adapter: "upscale-gpu", model: "swinir-x4", priceUsd: 0.0039, licence: "Apache-2.0", state: "serving"},
  {...own, id: routeId("image.upscale", "upscale-cpu", "swinir-x2"), capability: "image.upscale", rank: 3, adapter: "upscale-cpu", model: "swinir-x2", priceUsd: 0.010, licence: "Apache-2.0", state: "off"},
  {...vendor, id: routeId("image.upscale", "photoroom", PHOTOROOM_UPSCALE_MODEL), capability: "image.upscale", rank: 10, adapter: "photoroom", model: PHOTOROOM_UPSCALE_MODEL, priceUsd: 0.05},
];
export const SEED_ROUTES: readonly RouteDef[] = [...OPENROUTER_SEED_ROUTES, ...IMAGE_SEED_ROUTES];

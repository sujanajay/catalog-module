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
/** How a route is reached. M3-S5 adds the matting and upscale adapters; this slice ships the OpenRouter one. */
export const ROUTE_ADAPTERS = ["openrouter", "matting-gpu", "matting-cpu", "upscale-gpu", "upscale-cpu", "photoroom"] as const;
export type RouteAdapter = typeof ROUTE_ADAPTERS[number];
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
 * The seed chains for the capabilities this slice folds in (M7-F2-R2): the judge (`judge.render`) and the product
 * classifier, which is the first reading of a photo (`vision.read`). Route 1 and 2 are the policy's first and second
 * judge today; the fallback is the third provider already measured in the eval suite (docs/SPEC.md, the six of
 * `CATALOG_QA_CANDIDATES`, about USD 0.0004 per check). M7-S3's scoring runner may reorder them (open question
 * 4.2.10-1). The matting and upscale chains are added by M3-S5 with their adapters.
 */
const OPENROUTER_MODELS = [
  {rank: 1, model: "google/gemini-2.5-flash-lite"},
  {rank: 2, model: "anthropic/claude-haiku-5.5"},
  {rank: 3, model: "qwen/qwen3-vl-30b-a3b-instruct"},
] as const;
export const SEED_ROUTES: readonly RouteDef[] = (["judge.render", "vision.read"] as const).flatMap(capability => OPENROUTER_MODELS.map(({rank, model}) => ({
  id: routeId(capability, "openrouter", model), capability, rank, adapter: "openrouter" as const, model, paramsVersion: "1",
  priceUsd: 0.0004, rateLimitPerMin: null, region: "openrouter", licence: "OpenRouter terms of service",
  noTrainingTerms: OPENROUTER_NO_TRAINING_POSITION, state: "serving" as const,
})));

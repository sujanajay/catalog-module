// Shared enums, option shapes and operator sentences for the catalog module (spec 02, "Types and enums").
// The arrays are the single source for the database text enums (schema.ts) and for every type below.

export const CHANNEL_IDS = ["noon","namshi","trendyol","styli","centrepoint","sixthstreet","vogacloset","amazon","shein"] as const;
export const BATCH_STATUSES = ["draft","ingesting","matting","rendering","qa","publishing","done","failed","cancelled"] as const;
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
  "shadow_synthesised","transparent","upscaled","cut_in_source","auto_dropped",
  "product_removed","chart_image","matte_passthrough",
] as const;
export const DECISIONS = ["use_as_is","remove","replaced"] as const;
export const QA_MODES = ["per_source","per_output"] as const;
export const POLICY_SOURCES = ["bakeoff","default","pending","manual"] as const;
export const EVAL_LABELS = ["pass","flag"] as const;
export const ALIAS_KINDS = ["identifier","opptra_sku","option_id","channel_id","manual"] as const;
export const EVENT_KINDS = ["created","overwritten","shots_removed","channel_added","unchanged","reordered",
  "sku_ids_added","alias_added","removed_photo","replacement_uploaded","restored","removed"] as const;
export const ROLES = ["admin","operator","viewer"] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export type UploadKind = (typeof UPLOAD_KINDS)[number];
/** Inputs added through the paste box (pasted image links and Google links); every other kind is a file. */
export const PASTE_INPUT_KINDS: readonly UploadKind[] = ["url_list", "google_sheet", "drive_folder"];
export type OutputStatus = (typeof OUTPUT_STATUSES)[number];
export type LinkStatus = (typeof LINK_STATUSES)[number];
export type SheetStatus = (typeof SHEET_STATUSES)[number];
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export type ProductType = (typeof PRODUCT_TYPES)[number];
export type IdentifierMode = (typeof IDENTIFIER_MODES)[number];
export type Precedence = (typeof PRECEDENCES)[number];
export type OutputFlag = (typeof OUTPUT_FLAGS)[number];
/** Spec 11: the sheet note and reason of the `upscaled` information flag (the colour was enlarged by the GPU upscaler). Model-free. */
export const UPSCALED_SENTENCE = "Enlarged with a quality pass to meet this marketplace's size.";
export type Decision = (typeof DECISIONS)[number];
export type QaMode = (typeof QA_MODES)[number];
export type PolicySource = (typeof POLICY_SOURCES)[number];
export type EvalLabel = (typeof EVAL_LABELS)[number];
export type AliasKind = (typeof ALIAS_KINDS)[number];
export type EventKind = (typeof EVENT_KINDS)[number];
export type Role = (typeof ROLES)[number];

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
  cleanedUp?: boolean;                     // test batch cleaned up while its spend still counts today; hidden from the list
}

export interface BatchCounts {
  products: number; sources: number; outputs: number; verified: number; needsAttention: number;
  attentionProducts: number; failed: number; skipped: number; unchanged: number; skuResolved: number;
  missingImages: number; notInSheet: number; unsupportedFiles: number; duplicateFiles: number;
  collected: number; collectTotal: number | null; previewReady: boolean; latestExport: number;
  failReason: string | null; finalizePending: boolean; policyFallback: boolean;
  newProducts: number; existingProducts: number; shotsToRemove: number;
  recheckOk: number | null; recheckTotal: number | null;   // independent re-check written by finalize (06): this batch's delivered links
  /**
   * Links that could not be downloaded (spec 14b F5 part 1); `unsupportedFiles` counts files only.
   * Optional and not in EMPTY_BATCH_COUNTS (the column's DDL default, which would need a migration):
   * a batch not yet collected, or written before release B, reads it as 0.
   */
  linkFailures?: number;
  /** Links of this batch held for a decision (held products); not delivered, so outside both Details counts. */
  heldLinks?: number;
  /** Earlier batches' live links the sheet keeps for held products, re-checked separately. */
  recheckCarriedOk?: number | null; recheckCarriedTotal?: number | null;
  // Intake progress (spec 14c F6). Optional and not in EMPTY_BATCH_COUNTS (a new default would need a
  // migration): a row written before release C reads phase and placingClaim as null, placed as 0.
  /** What intake is doing now; the worker writes it with every counts update and clears `rate` when it changes. */
  phase?: IntakePhase | null;
  /** Photos placed so far (placing writes it after each chunk, or once at the end). */
  placed?: number;
  /** Photos to place, set when placing is claimed. */
  placeTotal?: number | null;
  /** The last RATE_SAMPLES progress samples, all of the current phase (`done` is `placed` while placing). */
  rate?: RateSample[];
  /** The placing lease: the batch stays `ingesting` while a delivery holds it. */
  placingClaim?: PlacingClaim | null;
}
/** Intake phases (spec 14c F6). The first five are collecting, `placing` follows, the last two end intake. */
export const INTAKE_PHASES = ["uploading", "downloading", "reading", "unpacking", "checking", "placing", "ready", "needs_input"] as const;
export type IntakePhase = (typeof INTAKE_PHASES)[number];
/** One progress sample: ISO time, the phase it was taken in, and the phase's done count then. */
export interface RateSample { at: string; phase: IntakePhase; done: number }
/** A placing lease: `token` names the claiming delivery (run and upload id), `until` is an ISO expiry. */
export interface PlacingClaim { token: string; until: string }
export interface BatchCost {
  computeVcpuSeconds: number; mattingMs: number; renderMs: number; computeUsd: number;
  qaUsd: number; qaCalls: number; identifiers: number;
  /** Token totals of the quality check and classifier calls, from OpenRouter's `usage` (07 4.5). */
  qaPromptTokens?: number; qaCompletionTokens?: number;
  usdPerIdentifier: number | null; inrPerIdentifier: number | null;
}

type Ctx = Record<string, string | number>;

function has(ctx: Ctx | undefined, ...keys: string[]): boolean {
  return !!ctx && keys.every((k) => ctx[k] !== undefined && ctx[k] !== "");
}

/** Marketplace label from ctx, or a neutral fallback. */
function channelName(ctx: Ctx | undefined, fallback: string): string {
  return has(ctx, "channel") ? String(ctx?.channel) : fallback;
}

/**
 * Operator sentences for the render and compliance flags (spec 02). Each says what happened and
 * what to do; no model names or technical ids. 07 replaces the QA sentences with its reasons table.
 */
const REASONS: Partial<Record<OutputFlag, (ctx?: Ctx) => string>> = {
  low_resolution: (ctx) =>
    (has(ctx, "w", "h", "deliverW", "deliverH")
      ? `The original is ${ctx?.w} x ${ctx?.h}. ${channelName(ctx, "This marketplace")} images are delivered at ${ctx?.deliverW} x ${ctx?.deliverH}, so this one was enlarged and may look soft.`
      : has(ctx, "w", "h", "min")
      ? `The original is ${ctx?.w} x ${ctx?.h}. ${channelName(ctx, "This marketplace")} wants at least ${ctx?.min} px, so this one may look soft.`
      : `The original photo is smaller than ${channelName(ctx, "this marketplace")} wants, so this one may look soft.`) +
    " It will upload, but ask the brand for a larger photo if you can.",
  no_shadow_source: () =>
    "The original photo has no shadow that could be kept, so the product sits on the plain background without one. Nothing to do; replace the photo if you want a shadow.",
  passthrough: () =>
    "The original already met this marketplace's rules, so it was only saved again in the right format. Nothing to do.",
  alpha_source: () =>
    "The original has a transparent background, so it was used as the cut-out directly. Nothing to do.",
  unsupported: (ctx) =>
    has(ctx, "name", "format")
      ? `${ctx?.name} is a ${ctx?.format} file. Save it as JPEG or PNG and add it again.`
      : `${has(ctx, "name") ? ctx?.name : "This file"} could not be read as a photo. Save it as JPEG or PNG and add it again.`,
  small_source: (ctx) =>
    (has(ctx, "w", "h")
      ? `The original is only ${ctx?.w} x ${ctx?.h}, under 500 px on its long side.`
      : "The original is under 500 px on its long side.") +
    " It is too small to look good anywhere. Remove it or replace it with a larger photo.",
  fallback_matte: () =>
    "Background was removed with the simple method because the cut-out service was unavailable. Check the edges.",
  duplicate_shot: (ctx) =>
    `Two files in the upload have the same identifier and shot number${has(ctx, "n") ? ` (${ctx?.n})` : ""}, so this product was not processed. Remove or rename one of them and add the product again.`,
  numbering_gap: (ctx) =>
    has(ctx, "list")
      ? `Shot numbers ${ctx?.list} are missing in the upload; images shifted left in this row.`
      : "Some shot numbers are missing in the upload; images shifted left in this row.",
  failed_compliance: (ctx) =>
    `The image we made did not meet ${channelName(ctx, "the marketplace")}'s rules${has(ctx, "failures") ? `: ${ctx?.failures}` : ""}. Remove it or replace it, and the technical team will look at the report.`,
  shadow_synthesised: () => "",
  cut_in_source: () =>
    "The original photo is already cut at the frame edge, so that edge sits flush with the edge of the image. Nothing to do; ask the brand for an uncut photo if you want one.",
  transparent: () =>
    "This product looks transparent or glass; the cut-out may need a look. Compare the two images. 'Use as is' keeps it.",
  matte_passthrough: () =>
    "This photo is a close-up that fills the frame, so the whole photo was kept as it is instead of being cut out. Nothing to do.",
  chart_image: () =>
    "This photo is a size chart or a text-only image, so it was left out of the marketplace images. Nothing to do.",
  auto_dropped: () =>
    "This photo was left out automatically: it could not be made cleanly and this product has enough other good photos. Nothing to do.",
  upscaled: () => `${UPSCALED_SENTENCE} Nothing to do.`,
};

/** Used for flags whose sentences arrive with 07 (QA). */
const GENERIC_REASON = "This image needs a look. Compare the two images; 'Use as is' keeps it.";

/**
 * The operator sentence for a flag. `ctx` fills details when known: `w`, `h`, `min`, `channel`
 * (marketplace label), `failures`, `name`, `format`, `n`, `list`. `shadow_synthesised` is
 * information only and returns "".
 */
export function flagReason(flag: OutputFlag, ctx?: Record<string, string | number>): string {
  const reason = REASONS[flag];
  return reason ? reason(ctx) : GENERIC_REASON;
}

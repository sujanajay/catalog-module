// Shared enums, option shapes and operator sentences for the catalog module (spec 02, "Types and enums").
// The arrays are the single source for the database text enums (schema.ts) and for every type below.

import type { StoredRoot } from "./ingest/roots";

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
  "product_removed","chart_image","matte_passthrough","enlargement_failed",
  // M1-F3 (M1-S3): delivered now by an auto-decide rule with the best image we have; may be improved later at the same URL.
  "provisional",
  // M1 D30 (M1-S6): a follow-up photo that was not added (another batch's live photo has its place, or over the channel limit).
  "not_added",
] as const;
/** Why the QA triage would hold an output for a person (qa/triage.ts `HoldCause`). */
export const HOLD_CAUSES = ["wrong_item","collage","unusable","corrupt","unchecked","photo_one","every_photo","not_publishable","code_fault","not_enlarged","visible_defect"] as const;
/**
 * M1-F3-R1: what an auto-decide rule does with an output the triage would hold. `deliver`: the staged image is
 * published now, flagged `provisional` (only when it exists and passes the channel's hard rules; otherwise the slot is
 * dropped). `drop`: the photo gets no link on that channel and the rest of the set is delivered. `hold` (owner, 2026-11-06,
 * M1 D39): the rare last resort. The photo gets no link and waits for a person, while the rest of the set is delivered and
 * the batch finishes; nothing else waits for it.
 */
export const AUTO_DECIDE_ACTIONS = ["deliver","drop","hold"] as const;
/** `catalog_auto_decide_rules.channel`: one channel, or `*` for every channel. */
export const AUTO_DECIDE_CHANNELS = ["*",...CHANNEL_IDS] as const;
/**
 * M1-S4 `catalog_improvements.end_reason`: why a photo stopped being a candidate without being improved. `superseded`: a
 * later batch published the product, so this batch no longer owns its links. `not_passed`: the upscaler enlarged the
 * photo but the new render did not pass, so the delivered provisional slot was put back and another try cannot help.
 */
export const IMPROVEMENT_END_REASONS = ["superseded","not_passed"] as const;
export type ImprovementEndReason = (typeof IMPROVEMENT_END_REASONS)[number];
export const DECISIONS = ["use_as_is","remove","replaced"] as const;
export const QA_MODES = ["per_source","per_output"] as const;
export const POLICY_SOURCES = ["bakeoff","default","pending","manual"] as const;
export const EVAL_LABELS = ["pass","flag"] as const;
export const ALIAS_KINDS = ["identifier","opptra_sku","option_id","channel_id","manual"] as const;
export const EVENT_KINDS = ["created","overwritten","shots_removed","channel_added","unchanged","reordered",
  "sku_ids_added","alias_added","removed_photo","replacement_uploaded","restored","removed",
  // Spec 18 enlargement lifecycle (migration 0006): an operator "Try again" on a failed enlargement, and an operator
  // "Use as is" that accepted plain (not enlarged) outputs after the warning.
  "enlargement_retried","plain_accepted","photo_recut"] as const;
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
export type HoldCause = (typeof HOLD_CAUSES)[number];
export type AutoDecideAction = (typeof AUTO_DECIDE_ACTIONS)[number];
export type AutoDecideChannel = (typeof AUTO_DECIDE_CHANNELS)[number];
/** Spec 11: the sheet note and reason of the `upscaled` information flag (the colour was enlarged by the GPU upscaler). Model-free. */
export const UPSCALED_SENTENCE = "Enlarged with a quality pass to meet this marketplace's size.";
/**
 * Spec 18 section 5: the sentence of `enlargement_failed`, a photo that needed the upscaler to reach a channel's size
 * and could not get it (the enlargement task failed, or its stored image is missing). The output is held with this
 * reason; a plain resize never stands in. Model-free.
 */
export const ENLARGEMENT_FAILED_WHY = "This photo could not be enlarged to this marketplace's size.";
export const ENLARGEMENT_FAILED_WHAT = "Try again, use it as it is after the warning, replace the photo, or ask the brand for a larger one.";
/** M1-F3: the sheet note of a `provisional` output (delivered now by an auto-decide rule). Model-free. */
export const PROVISIONAL_SENTENCE = "Delivered now with the best image we have; it may be improved later at the same link. Nothing to do.";
export const ENLARGEMENT_FAILED_SENTENCE = `${ENLARGEMENT_FAILED_WHY} ${ENLARGEMENT_FAILED_WHAT}`;
/** What to do when "Try again" cannot run (a size refusal, or a batch that has stopped): the card offers no Try again. */
export const ENLARGEMENT_FAILED_WHAT_NO_RETRY = "Use it as it is after the warning, replace the photo, or ask the brand for a different one.";
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
  /**
   * M1-F1-R2: the grouping mode is detected for each input root (folder, zip, sheet, paste) and
   * `identifierMode` is not used for grouping. Set on batches the wizard creates; absent (false) on
   * older batches and whenever step 2's "Change" forces one mode for the whole batch.
   */
  perRoot?: boolean;
  policy?: ResolvedPolicy;                 // set at start (07); absent on draft
  qaCapUsd?: number | null;                // per-batch QA cap (07)
  evalSet?: string | null;                 // eval batches (08)
  cleanedUp?: boolean;                     // test batch cleaned up while its spend still counts today; hidden from the list
  /** Set when the sweep cancelled an untouched draft (spec 14d F12): when, and after how many days. */
  expired?: { at: string; days: number } | null;
  /**
   * Spec 18 3.3.6: written at Start when the upscaler is on (UPSCALE_MODEL set, not `off`): every photo this batch
   * enlarges beyond UPSCALE_MIN_SCALE goes through the upscaler or is held (invariant enlarged_without_upscaler).
   * Absent on batches from before spec 18 and when the upscaler is off. The model id is engineering only. Spec 18
   * quality: `minScale` is the batch's threshold (absent on older batches: 1.5) and `x4Model` the model above 2.0x.
   * Spec 18 GPU upscaler (2026-10-30): `target` "gpu" when Start ran with UPSCALE_TARGET=gpu, so every enlargement of
   * the batch is made on catalog-upscale-gpu; absent, the worker's UPSCALE_URL service as before. One batch never
   * mixes CPU and GPU images.
   */
  enlargement?: { model: string; x4Model?: string; minScale?: number; target?: "gpu" } | null;
  /**
   * M1-F2-R6 (M1-S2): the batch starts by itself after the countdown once collection and grouping end. Set by the
   * one-page New batch; absent (false) for API and load-driver batches unless asked (R9). "Wait" sets it false.
   */
  autoStart?: boolean;
  /**
   * M1 D30 (M1-S6): a follow-up batch ("Add more photos") only adds photos. Its shots of a product that already has
   * photos are numbered after that product's highest shot, and its publish never replaces, removes or retires a live
   * photo; a photo over its channel's image limit (ingest/append.ts) is skipped with a note. Absent on other batches.
   */
  append?: boolean;
  /**
   * M1-F2-R7: two identifiers that are one product, from different uploads: only the newest upload's photos are used
   * and the other spelling is left out. Absent means on; false (the operator's "Use only the newest photo of each
   * product" unticked) leaves both out, as before M1-S2. Spellings from one upload have no newest and are both left out.
   */
  newestSameProduct?: boolean;
  /**
   * M1-F3 (M1-S3): written at Start. The auto-decide rules (`catalog_auto_decide_rules`) as they were when the batch
   * started, so a rule changed mid-batch does not affect it. Present means the batch auto-decides: no output waits for
   * a person and no product becomes `pending_attention`. Absent on batches started before M1-S3 (they keep the holds).
   */
  autoDecide?: { rules: { id: string; cause: HoldCause; channel: AutoDecideChannel; action: AutoDecideAction }[] } | null;
}

export interface BatchCounts {
  /**
   * M1-F1-R2: the input roots of a per-root batch and the mode each was grouped by, written with the
   * grouping. Optional and not in EMPTY_BATCH_COUNTS (a new default would need a migration).
   */
  roots?: StoredRoot[];
  products: number; sources: number; outputs: number; verified: number; needsAttention: number;
  attentionProducts: number; failed: number; skipped: number; unchanged: number; skuResolved: number;
  missingImages: number; notInSheet: number; unsupportedFiles: number; duplicateFiles: number;
  /**
   * Products grouping left out whole (leftOutProducts): no link is made for them, the digest and the batch page say so,
   * and the batch's outcome is not a success. Optional and not in EMPTY_BATCH_COUNTS (a new default would need a migration).
   */
  productsLeftOut?: number;
  /** Files, rows and links outside those products that gave no photo (written at finalize): not counted once by product. */
  filesLeftOut?: number;
  /** Whole inputs that were not read (a failed upload, a product list that could not be used), written at finalize. */
  uploadsNotRead?: number;
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
  /** M1-F3: delivered links of this batch an auto-decide rule chose (flagged `provisional`); written by the report. */
  provisional?: number;
  /** Earlier batches' live links the sheet keeps for held products, re-checked separately. */
  recheckCarriedOk?: number | null; recheckCarriedTotal?: number | null;
  /**
   * Spec 15 E7, written by every chunk delivery (refreshBatchProgress). Optional for the same reason as
   * `linkFailures`: a batch from before release E reads `prepared` as unknown and the others as absent.
   * `prepared`: photos of the batch that are cut out, failed, or left out as a size chart.
   * `progressAt`: the last time a photo finished in any stage (ISO time).
   * `processingRate`: the last 5 samples of the images made, appended when the count changed.
   */
  prepared?: number;
  progressAt?: string | null;
  processingRate?: { at: string; made: number }[];
  /**
   * When refreshBatchProgress last counted a large batch (ISO time): such a batch is counted at most every
   * PROGRESS_REFRESH_INTERVAL_MS, and exactly by finalize. Bookkeeping only; finalize leaves it out of the done counts.
   */
  progressRefreshedAt?: string;
  // Intake progress (spec 14c F6). Optional and not in EMPTY_BATCH_COUNTS (a new default would need a
  // migration): a row written before release C reads phase and placingClaim as null, placed as 0.
  /** What intake is doing now; the worker writes it with every counts update and clears `rate` when it changes. */
  phase?: IntakePhase | null;
  /** Photos placed so far (written at most every 10 s while placing, and with the closing write). */
  placed?: number;
  /** Photos to place, set when placing is claimed. */
  placeTotal?: number | null;
  /** Products found or created so far while grouping (written about every 10 s and at each hand-on). */
  grouped?: number;
  /** Products to find or create, set when grouping has matched them. */
  groupTotal?: number | null;
  /** The last RATE_SAMPLES progress samples, all of the current phase (`done` is `placed` while placing). */
  rate?: RateSample[];
  /** The placing lease: the batch stays `ingesting` while a delivery holds it. */
  placingClaim?: PlacingClaim | null;
  /**
   * Why a batch reopened with Fix and continue could not start (spec 14c F8): the reopen keeps the old
   * `failReason` here, step 1 shows it above the inputs, and the next hand-off to collecting clears it.
   */
  fixReason?: string | null;
  /** M1-F2-R6: when the armed countdown ends and the batch starts (ISO time); null or absent when none runs. */
  autoStartAt?: string | null;
  /**
   * The run id of the newest collection hand-off (ingestBatch). An ingest task of an earlier run that runs out of
   * attempts does not fail the batch (failStoppedIngest). Optional (no migration): absent, any run counts.
   */
  ingestRun?: string | null;
  /**
   * M1-S6 (M1-F5-R1, R4): how many times the sweep moved this batch on by itself: `sweepHandOffs` hand-offs of a draft
   * whose tab closed before collecting, `sweepRearms` countdowns armed again after their task was lost, and
   * `ingestResends` re-sends of an intake that gave up. Each is capped, so a draft that keeps failing waits for a
   * person and is listed on the Ops page. Optional (no migration).
   */
  sweepHandOffs?: number;
  sweepRearms?: number;
  ingestResends?: number;
  /**
   * M1 D24 (review P1-1): a new id written by every input change while the batch is collecting. The batch-wide step
   * records the value it grouped with in `groupedChange` at its claim; when they differ at its closing write it does
   * not close but groups again. Optional (no migration).
   */
  inputsChangedAt?: string | null;
  groupedChange?: string | null;
  /** M1 review P2-4: the auto-start task ended this countdown on purpose (a refusal that is not busy); the sweep does not arm it again. */
  autoStartEnded?: boolean | null;
  /**
   * Spec 17 G4: real errors each chunk's current task (stage, step) threw, keyed by chunk id and counted by the
   * worker. The chunk fails at CHUNK_MAX_ERRORS; a new step starts again at 1. Optional (no migration).
   */
  chunkErrors?: Record<string, { stage: string; step: number; errors: number }>;
  /**
   * Spec 18 3.3.6, kept by refreshBatchProgress: photos of the batch that need a stored enlargement, those that have
   * it, and those whose enlargement failed for good. Optional (no migration): absent reads as no enlargement.
   */
  enlargeTotal?: number;
  enlargeDone?: number;
  enlargeFailed?: number;
}
/** Intake phases (spec 14c F6). The first five are collecting, `grouping` (products found or created) and `placing` follow, the last two end intake. */
export const INTAKE_PHASES = ["uploading", "downloading", "reading", "unpacking", "checking", "grouping", "placing", "ready", "needs_input"] as const;
export type IntakePhase = (typeof INTAKE_PHASES)[number];
/** One progress sample: ISO time, the phase it was taken in, and the phase's done count then. */
export interface RateSample { at: string; phase: IntakePhase; done: number }
/**
 * A placing lease: `token` names the claiming delivery (run and upload id), `until` is an ISO expiry,
 * `attempt` the run of the step working under it (null once that run stopped on an error), `next`
 * (spec 14d F7 part 2) the first photo of the chunk placing handed on to its continuation (absent while
 * grouping or the first chunk runs), `group` the first product of the grouping chunk handed on (absent while the
 * grouping delivery itself runs).
 */
export interface PlacingClaim { token: string; until: string; attempt?: string | null; next?: number; group?: number }
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
  not_added: () =>
    "This photo from Add more photos was not added, so the photos already live stay as they are. The technical team will look at it.",
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
  enlargement_failed: () => ENLARGEMENT_FAILED_SENTENCE,
  provisional: () => PROVISIONAL_SENTENCE,
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

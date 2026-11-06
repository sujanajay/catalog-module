// M1-F3-R1, M1 D40: which photo takes image 1's place when image 1 is held for a person. Pure; the worker renders and writes
// (apps/worker/src/catalog/auto-resolve.ts promoteOverHeldPhoto).
import type { catalogOutputs, catalogSourceImages } from "../db/schema";
import type { AutoAction, RenderVariant } from "./auto-resolve";
import type { RenderOutput } from "./render";
import { problemFlags } from "./qa/triage";
import type { ChannelId } from "./types";

type Output = typeof catalogOutputs.$inferSelect;
type Source = typeof catalogSourceImages.$inferSelect;

/** The judge's views that show the product as a shopper expects a first image to (M1-F3-R1 "front or packshot"). */
export const IMAGE_ONE_VIEWS: ReadonlySet<string> = new Set(["front", "on-model", "flat"]);

export interface PromotionInput {
  channels: readonly ChannelId[];
  sources: readonly Source[];
  outputs: readonly Output[];
  /** Live slots of the product, from any batch, with the photo at each: a slot already published keeps its photo, so the listing's order stays. */
  live: readonly { channel: ChannelId; n: number; sha256?: string | null }[];
  held: (o: Output) => boolean;
}
const score = (o: Output) => Number((o.qaScores as { overall?: unknown } | null)?.overall ?? 0);
/** The judge's view of the photo: read once per photo, so it is on any of the judgements (qa-stage.ts). */
const viewOf = (o: Output) => ((o.qaScores as { judgements?: { view?: unknown }[] } | null)?.judgements ?? []).map(j => j.view).find(v => typeof v === "string") ?? null;

/**
 * The held image 1 and the photo to promote, or null. Image 1 must be held on every channel it has, and the candidate must
 * have passed on exactly those channels, in a view fit for image 1; the best of its weakest scores wins, then the lowest
 * number. Null also when either number is live with another photo on one of those channels, because the marketplace already
 * has that order. A slot already showing the photo that would land there is no obstacle: that is a re-send of a product promoted
 * before (ingest numbers the file's photos again), and promoting again keeps the delivered order, so image 1 and image 2 never show one photo.
 */
export function pickPromotion(input: PromotionInput): { from: Source; to: Source } | null {
  const replaced = new Set(input.sources.flatMap(s => s.replacesId ? [s.replacesId] : []));
  const photos = input.sources.filter(s => !replaced.has(s.id) && !s.flags.includes("chart_image")).sort((a, b) => a.n - b.n);
  const from = photos[0];
  if (!from) return null;
  const rows = (s: Source) => input.outputs.filter(o => o.sourceImageId === s.id && input.channels.includes(o.channel) && o.status !== "skipped");
  const held = rows(from);
  if (!held.length || !held.every(input.held)) return null;
  const channels = held.map(o => o.channel).sort().join();
  const passed = (o: Output) => o.status === "staged" && o.decision === null && !!o.stagingUri && !o.flags.includes("provisional") && !problemFlags(o.flags).length && o.qaScores !== null && IMAGE_ONE_VIEWS.has(String(viewOf(o)));
  const candidates = photos.slice(1).flatMap(s => {
    const mine = rows(s);
    return mine.length && mine.every(passed) && mine.map(o => o.channel).sort().join() === channels ? [{ s, weakest: Math.min(...mine.map(score)) }] : [];
  }).sort((a, b) => b.weakest - a.weakest || a.s.n - b.s.n);
  const to = candidates[0]?.s;
  if (!to) return null;
  const taken = (n: number, photo: Source) => input.live.some(l => l.n === n && l.sha256 !== photo.sha256 && held.some(o => o.channel === l.channel));
  return taken(from.n, to) || taken(to.n, from) ? null : { from, to };
}

/** The columns of one output after it changed its number. Its status, flags, reason and judgement stay. */
export function catalogSlotPatch(o: Output, r: RenderOutput, at: { n: number; objectPath: string; publicUrl: string; key: string; stagingUri: string; crc32c: string | null; variant: RenderVariant; action: AutoAction }): Partial<Output> {
  const before = (o.compliance ?? {}) as Record<string, unknown>;
  const actions = Array.isArray(before.auto_actions) ? before.auto_actions as AutoAction[] : [];
  return {
    n: at.n, objectPath: at.objectPath, publicUrl: at.publicUrl, renderKey: at.key, stagingUri: at.stagingUri, crc32c: at.crc32c,
    canvasW: r.plan.w, canvasH: r.plan.h, scale: r.plan.scale, placedX: r.plan.placedX, placedY: r.plan.placedY, bytes: r.bytes, quality: r.quality,
    compliance: { ...r.compliance, variant: at.variant, ...(before.auto_decide ? { auto_decide: before.auto_decide } : {}), auto_actions: [...actions, at.action] } as unknown as Output["compliance"],
  };
}

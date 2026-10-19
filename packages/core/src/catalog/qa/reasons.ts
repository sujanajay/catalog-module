import { flagReason, type OutputFlag } from "../types";
export interface ReasonContext { n?: number; k?: number; channel?: string; w?: number; h?: number; min?: number; failures?: string; error?: string }
export interface FlagDetails { why: string; whatToDo: string }
export function flagDetails(flag: OutputFlag | "failed", ctx: ReasonContext = {}): FlagDetails {
  const n = ctx.n ?? "N", k = ctx.k ?? "the selected", channel = ctx.channel ?? "This marketplace";
  const pairs: Partial<Record<OutputFlag | "failed", [string,string]>> = {
    complete_product:["Part of the product or model looks cut at the frame edge in the original photo.",`We never crop, so the made image shows the same thing. "Use as is" keeps it; "Replace photo ${n}" swaps the photo for all ${k} marketplaces.`],
    different_product:["This photo does not match photo 1 of the same identifier.","If the file was named wrongly, remove it; the rest of the product is unaffected."],
    halo:["The edge of the product looks rough or shows a halo, often white on white.",'Compare the two images. The product itself is never redrawn; only the background changes. "Use as is" keeps it.'],
    leftover_background:["Some of the original background is still visible around the product.",`Compare the two images. "Use as is" keeps it; "Replace photo ${n}" swaps the photo.`],
    text_or_watermark:["The photo carries text, a watermark or a logo overlay. Marketplaces reject these.","Remove it, or replace it with a clean photo."],
    collage:["This image combines several photos in one. Marketplaces reject these.","Remove it, or replace it with the single photos."],
    orientation:["The product looks rotated or upside down.","If the original is like this, replace it with a corrected photo."],
    placement:[`On ${ctx.channel ?? "Styli"} the product does not sit at the bottom centre inside the guides like the other angles.`,`Check the other angles of this product. This affects ${ctx.channel ?? "Styli"} only; "Remove this photo" removes it for ${ctx.channel ?? "Styli"}, "Replace photo ${n}" swaps the photo.`],
    low_resolution:[ctx.w !== undefined && ctx.h !== undefined ? `The original is ${ctx.w} x ${ctx.h}. ${channel} wants at least ${ctx.min ?? "the required"} px, so this one may look soft.` : `The original photo is smaller than ${channel} wants, so this one may look soft.`,"It will upload, but ask the brand for a larger photo if you can. The other marketplaces are fine with it."],
    small_source:[ctx.w !== undefined && ctx.h !== undefined ? `The original is only ${ctx.w} x ${ctx.h}, under 500 px on its long side.` : "The original is under 500 px on its long side.","It is too small to look good anywhere. Remove it or replace it with a larger photo."],
    failed:[ctx.error ?? "The file is corrupt and could not be decoded.","Nothing was made for any marketplace from this photo. Remove it or replace it."],
    failed_compliance:[`The image we made did not meet ${channel}'s rules${ctx.failures ? `: ${ctx.failures}` : ""}.`,"This should not happen. Remove it or replace it, and the technical team will look at the report."],
    fallback_matte:["The background was removed with the simple method because the cut-out service was unavailable.",'Check the edges. "Use as is" keeps it.'],
    transparent:["This product looks transparent or glass; the cut-out may need a look.",'Compare the two images. "Use as is" keeps it.'],
    upscaled:["This image was enlarged by an experimental step.","Check logos, text and fabric texture against the original."],
    qa_unavailable:["The quality check could not read this image.",'Please look at it yourself. "Use as is" keeps it.'],
    qa_cap:["Quality check paused: the spending limit was reached.","Look at this image yourself, or raise the limit and start a new batch."],
    type_unknown:["We could not tell what kind of product this is, so the general treatment was used.","If the images look wrong, start a new batch with the product type chosen by hand."],
    no_shadow_source:["The original photo has no shadow that could be kept, so the product sits on the plain background without one.","Nothing to do; replace the photo if you want a shadow."],
    shadow_synthesised:["A shadow was added because the original photo had no shadow that could be kept.","Nothing to do."],
    cut_in_source:["The original photo is already cut at the frame edge, so that edge sits flush with the edge of the image.","Nothing to do; ask the brand for an uncut photo if you want one."],
    passthrough:["The original already met this marketplace's rules, so it was only saved again in the right format.","Nothing to do."],
    alpha_source:["The original has a transparent background, so it was used as the cut-out directly.","Nothing to do."],
    qa_sampled_out:["This image was not selected for the quality-check sample.","Nothing to do."],
  };
  const pair = pairs[flag];
  if (pair) return {why:pair[0],whatToDo:pair[1]};
  return {why:flagReason(flag as OutputFlag),whatToDo:"Check the original photo and replace it if needed."};
}
export function shortClause(flag: OutputFlag | "failed", ctx: ReasonContext = {}): string {
  const clauses: Partial<Record<OutputFlag | "failed",string>> = {complete_product:"looks cut at the frame edge",different_product:"looks like a different product from the others",failed:"could not be read",low_resolution:`is too small for ${ctx.channel ?? "this marketplace"}`,small_source:"is too small",text_or_watermark:"carries text or a watermark",collage:"combines several photos",halo:"has a rough edge",leftover_background:"still shows some background",orientation:"looks rotated",placement:`sits differently from the other angles on ${ctx.channel ?? "Styli"}`,fallback_matte:"was cut out with the simple method",transparent:"looks transparent or glass",qa_unavailable:"could not be checked",qa_cap:"was not checked because the spending limit was reached",failed_compliance:`did not meet ${ctx.channel ?? "this marketplace"}'s rules`};
  return clauses[flag] ?? "needs a look";
}
export interface ProblemPhoto { n: number; flag?: OutputFlag | "failed"; flags?: OutputFlag[]; reason?: string | null; channel?: string }
export function problemLine(photos: readonly ProblemPhoto[]): string {
  return photos.map((photo,index) => {
    const prefix = `${index === 0 ? "Photo" : "photo"} ${photo.n}`;
    const reason = photo.reason?.trim().replace(/[.!?]+$/, "");
    return reason ? `${prefix}: ${reason[0]!.toLowerCase()}${reason.slice(1)}` : `${prefix} ${shortClause(photo.flag ?? photo.flags?.[0] ?? "failed",photo)}`;
  }).join("; ") + (photos.length ? "." : "");
}

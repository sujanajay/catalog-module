// Cut-in-source handling (spec 10 section 6): a photo whose product reaches the frame edge (a model
// cut at the knees) must come out flush with the canvas on that side where the channel has no
// margin, end exactly on the guide where it has one, carry no floating line or shadow under the cut,
// and be flagged for information, never held for a person.
import { delta, dropSpecks, SPECK_PX } from "./image";
import { EXTENT_DELTA } from "./geometry";
import type { OutputContext } from "./context";
import { judge, notRun, type CheckResult, type CheckSubject } from "./types";

/** Information flag names accepted for a cut source. The render fix must set one of these; the first is the preferred name. */
export const CUT_SOURCE_FLAGS: readonly string[] = ["cut_source", "source_cut", "cut_at_edge"];
export const FLUSH_TOLERANCE_PX = 1;

const E = "cut_edge" as const;

export function checkCutEdge(ctx: OutputContext): CheckResult[] {
  const { subject: s, canvas, background, safeBox, product } = ctx;
  const who: CheckSubject = { identifier: s.identifier, n: s.n, channel: s.channel };
  if (!ctx.cutSides.length) return [notRun("cut_edge.flush", E, who, "The product does not touch the source frame.")];
  const out: CheckResult[] = [];
  // Measured extent of the product on the canvas: clearly foreground pixels where the product should be (a line drawn elsewhere never extends it).
  let x0 = canvas.w, y0 = canvas.h, x1 = -1, y1 = -1;
  for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) if (product[y * canvas.w + x] && delta(canvas.rgb, y * canvas.w + x, background) > EXTENT_DELTA) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 < 0) return [notRun("cut_edge.flush", E, who, "No product pixels on the canvas.")];
  const limit = { top: safeBox.y, bottom: safeBox.y + safeBox.h - 1, left: safeBox.x, right: safeBox.x + safeBox.w - 1 };
  const measured = { top: y0, bottom: y1, left: x0, right: x1 };
  for (const side of ctx.cutSides) {
    const gap = Math.abs(measured[side] - limit[side]);
    const edge = { top: 0, bottom: canvas.h - 1, left: 0, right: canvas.w - 1 }[side];
    const zeroMargin = limit[side] === edge;
    out.push(judge(gap <= FLUSH_TOLERANCE_PX, `cut_edge.flush_${side}`, E, who, gap, FLUSH_TOLERANCE_PX, "px", zeroMargin ? `The product is cut at the source ${side}; on the canvas it ends ${gap} px from the ${side} edge (must be flush).` : `The product is cut at the source ${side}; on the canvas it ends ${gap} px from the ${side} guide (must sit on it).`));
    // No floating line or shadow: the strip just beyond the cut side must be pure background.
    let worst = 0;
    const strip = 12, mask = new Uint8Array(canvas.w * canvas.h);
    const mark = (x: number, y: number) => { const d = delta(canvas.rgb, y * canvas.w + x, background); if (d > 12) { mask[y * canvas.w + x] = 1; if (d > worst) worst = d; } };
    if (side === "bottom" || side === "top") {
      const from = side === "bottom" ? y1 + 1 : Math.max(0, y0 - strip), to = side === "bottom" ? Math.min(canvas.h, y1 + 1 + strip) : y0;
      for (let y = from; y < to; y++) for (let x = Math.max(0, x0); x <= Math.min(canvas.w - 1, x1); x++) mark(x, y);
    } else {
      const from = side === "right" ? x1 + 1 : Math.max(0, x0 - strip), to = side === "right" ? Math.min(canvas.w, x1 + 1 + strip) : x0;
      for (let y = Math.max(0, y0); y <= Math.min(canvas.h - 1, y1); y++) for (let x = from; x < to; x++) mark(x, y);
    }
    let bad = 0;
    for (const v of dropSpecks(mask, canvas.w, canvas.h, SPECK_PX)) bad += v;
    // Inside the silhouette, the last rows (or columns) before the cut must still be product: a gap there is a floating line.
    let gapPixels = 0, maskPixels = 0;
    const inStrip = (x: number, y: number) => side === "bottom" ? y > y1 - strip : side === "top" ? y < y0 + strip : side === "right" ? x > x1 - strip : x < x0 + strip;
    for (let y = Math.max(0, y0); y <= Math.min(canvas.h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(canvas.w - 1, x1); x++) { const i = y * canvas.w + x; if (!product[i] || !inStrip(x, y)) continue; maskPixels++; if (delta(canvas.rgb, i, background) <= 8) gapPixels++; }
    const gapShare = maskPixels ? gapPixels / maskPixels : 0;
    out.push(judge(bad === 0 && gapShare <= 0.01, `cut_edge.no_line_${side}`, E, who, bad || Math.round(gapShare * 1e4) / 1e4, 0, bad ? "pixels beyond the edge" : "gap share inside the silhouette", bad ? `${bad} pixels beyond the cut ${side} edge are not background (worst delta ${worst}): a floating line or shadow.` : gapShare > 0.01 ? `${(gapShare * 100).toFixed(1)}% of the silhouette's last ${strip} rows before the cut ${side} are background: a gap or a floating line.` : `Nothing is drawn beyond the cut ${side} edge and the silhouette runs to it.`));
  }
  const flagged = s.flags.some(f => CUT_SOURCE_FLAGS.includes(f));
  out.push(judge(flagged, "cut_edge.flagged", E, who, s.flags.join(",") || "none", CUT_SOURCE_FLAGS[0]!, "flag", flagged ? "The cut source carries its information flag." : `The cut source carries no information flag (expected one of ${CUT_SOURCE_FLAGS.join(", ")}).`));
  const held = s.status === "needs_attention" || s.status === "failed";
  out.push(judge(!held, "cut_edge.not_held", E, who, s.status, "staged or verified", "status", held ? "A cut source was held for a person; it must pass with an information flag." : "The cut source was not held."));
  return out;
}

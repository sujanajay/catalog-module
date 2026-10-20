// Cut-in-source handling (spec 10 section 6): a photo whose product reaches the frame edge (a model
// cut at the knees) must come out flush with the canvas on that side where the channel has no
// margin, end exactly on the guide where it has one, carry no floating line or shadow under the cut,
// and be flagged for information, never held for a person.
import { delta, dropSpecks, SPECK_PX } from "./image";
import { SOURCE_MATCH_DELTA, sourceDelta, visibleProduct } from "./geometry";
import { overflowPx, type OutputContext } from "./context";
import { judge, notRun, pass, type CheckResult, type CheckSubject } from "./types";

/** The information flag the render sets on a cut source (spec 05, `cut_in_source`). */
export const CUT_SOURCE_FLAGS: readonly string[] = ["cut_in_source"];
export const FLUSH_TOLERANCE_PX = 1;
/**
 * The most of the product box a render may trim off an axis so the other axis fills the canvas (spec 05
 * CUT_FILL_MAX_TRIM, stated here as the suite's own bound): a third, the widest canvas mismatch in the channel
 * table (a square photo on the 2:3 Trendyol canvas).
 */
export const MAX_TRIM_SHARE = 1 / 3;
/** Slack on MAX_TRIM_SHARE (spec 05 CUT_FILL_TRIM_SLACK): a square full-bleed box is a pixel or two off square after the matte's soft edge. */
export const TRIM_SLACK = 0.01;

const E = "cut_edge" as const;

export function checkCutEdge(ctx: OutputContext): CheckResult[] {
  const { subject: s, canvas, background, safeBox, half } = ctx;
  const who: CheckSubject = { identifier: s.identifier, n: s.n, channel: s.channel };
  const out: CheckResult[] = [];
  // Trim: from the recorded scale alone, how much of the product the placement leaves no room for on each axis. Spec 05
  // allows that only on an axis with a cut side, only so that the other axis (cut on both ends) fills the canvas, and
  // never beyond a third of the product box; an uncut outline is never trimmed. A fitted product is trimmed on neither axis.
  const { sourceBox: box, cut, safeBox: safe } = ctx, scale = s.placement.scale;
  const axes = [
    { name: "width", trimmed: overflowPx(box.w, scale, safe.w), length: box.w, cutSide: cut.left || cut.right, otherFilled: cut.top && cut.bottom && Math.round(box.h * scale) >= safe.h - FLUSH_TOLERANCE_PX, sides: "left or right" },
    { name: "height", trimmed: overflowPx(box.h, scale, safe.h), length: box.h, cutSide: cut.top || cut.bottom, otherFilled: cut.left && cut.right && Math.round(box.w * scale) >= safe.w - FLUSH_TOLERANCE_PX, sides: "top or bottom" },
  ];
  const trimmed = axes.filter(a => a.trimmed > 0);
  if (trimmed.length) {
    const problems = trimmed.flatMap(a => {
      const share = a.trimmed / a.length;
      return [
        !a.cutSide && `${a.trimmed} px of the ${a.name} are trimmed although the photo is not cut at the ${a.sides}`,
        a.cutSide && !a.otherFilled && `${a.trimmed} px of the ${a.name} are trimmed without the other axis being cut on both ends and filling the canvas`,
        share > MAX_TRIM_SHARE + TRIM_SLACK + 1 / a.length && `${(share * 100).toFixed(1)}% of the ${a.name} is trimmed (at most a third)`,
      ].filter((p): p is string => typeof p === "string");
    });
    const worst = Math.max(...trimmed.map(a => a.trimmed / a.length));
    out.push(judge(!problems.length, "cut_edge.trim", E, who, Math.round(worst * 1e4) / 1e4, Math.round(MAX_TRIM_SHARE * 1e4) / 1e4, "share of the product box", problems.length ? `${problems.join("; ")}.` : `The placement trims ${trimmed.map(a => `${a.trimmed} px of the ${a.name} (${(100 * a.trimmed / a.length).toFixed(1)}%)`).join(" and ")} off cut sides so the other axis fills the canvas.`));
  } else out.push(pass("cut_edge.trim", E, who, 0, Math.round(MAX_TRIM_SHARE * 1e4) / 1e4, "share of the product box", "The placement leaves room for the whole product; nothing is trimmed."));
  if (!ctx.cutSides.length) return [notRun("cut_edge.flush", E, who, "The product does not touch the source frame."), ...out];
  // Measured extent of the product on the canvas: the product pixels visibly where the plan put them (visibleProduct: inside
  // the half-coverage mask and matching the source there, so a white hem on a white canvas still counts, or clearly not
  // background next to the mask). A line drawn elsewhere never extends it.
  const visible = visibleProduct(ctx);
  let x0 = canvas.w, y0 = canvas.h, x1 = -1, y1 = -1;
  for (let y = 0; y < canvas.h; y++) for (let x = 0; x < canvas.w; x++) if (visible[y * canvas.w + x] && half[y * canvas.w + x]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 < 0) return [notRun("cut_edge.flush", E, who, "No product pixels on the canvas.")];
  const limit = { top: safeBox.y, bottom: safeBox.y + safeBox.h - 1, left: safeBox.x, right: safeBox.x + safeBox.w - 1 };
  const measured = { top: y0, bottom: y1, left: x0, right: x1 };
  for (const side of ctx.cutSides) {
    const gap = Math.abs(measured[side] - limit[side]);
    const edge = { top: 0, bottom: canvas.h - 1, left: 0, right: canvas.w - 1 }[side];
    const flush = limit[side] === edge;
    out.push(judge(gap <= FLUSH_TOLERANCE_PX && flush, `cut_edge.flush_${side}`, E, who, Math.abs(measured[side] - edge), FLUSH_TOLERANCE_PX, "px", `The product is cut at the source ${side}; on the canvas it ends ${Math.abs(measured[side] - edge)} px from the ${side} edge (must be flush, with no margin on that side).`));
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
    // Inside the silhouette, the last rows (or columns) before the cut must still be product: a gap there is a floating
    // line. A gap pixel shows canvas background where the source has something else; a white shoe or the photo's own
    // white corner matches the source and is not a gap.
    let gapPixels = 0, maskPixels = 0;
    const inStrip = (x: number, y: number) => side === "bottom" ? y > y1 - strip : side === "top" ? y < y0 + strip : side === "right" ? x > x1 - strip : x < x0 + strip;
    for (let y = Math.max(0, y0); y <= Math.min(canvas.h - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(canvas.w - 1, x1); x++) { const i = y * canvas.w + x; if (!half[i] || !inStrip(x, y)) continue; maskPixels++; if (delta(canvas.rgb, i, background) <= 8 && sourceDelta(ctx, x, y) > SOURCE_MATCH_DELTA) gapPixels++; }
    const gapShare = maskPixels ? gapPixels / maskPixels : 0;
    out.push(judge(bad === 0 && gapShare <= 0.01, `cut_edge.no_line_${side}`, E, who, bad || Math.round(gapShare * 1e4) / 1e4, 0, bad ? "pixels beyond the edge" : "gap share inside the silhouette", bad ? `${bad} pixels beyond the cut ${side} edge are not background (worst delta ${worst}): a floating line or shadow.` : gapShare > 0.01 ? `${(gapShare * 100).toFixed(1)}% of the silhouette's last ${strip} rows before the cut ${side} are background: a gap or a floating line.` : `Nothing is drawn beyond the cut ${side} edge and the silhouette runs to it.`));
  }
  const flagged = s.flags.some(f => CUT_SOURCE_FLAGS.includes(f));
  out.push(judge(flagged, "cut_edge.flagged", E, who, s.flags.join(",") || "none", CUT_SOURCE_FLAGS[0]!, "flag", flagged ? "The cut source carries its information flag." : `The cut source carries no information flag (expected one of ${CUT_SOURCE_FLAGS.join(", ")}).`));
  const held = s.status === "needs_attention" || s.status === "failed";
  out.push(judge(!held, "cut_edge.not_held", E, who, s.status, "staged or verified", "status", held ? "A cut source was held for a person; it must pass with an information flag." : "The cut source was not held."));
  return out;
}

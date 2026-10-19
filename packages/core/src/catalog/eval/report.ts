// Bake-off report (spec 08 section 4.6): one HTML page of plain tables and its JSON twin. Written
// only under catalog-test/eval/<set>/reports/; model ids appear here and never on operator pages.
import type { ScopeResult } from "./policy-writer";
import { MATTE_CANDIDATES } from "./run";

/** Section 4.10 licence registry, a record only (winners are chosen on quality alone). */
export const LICENCES: Record<string, string> = {
  "birefnet-general": "MIT", "birefnet-general-lite": "MIT", "birefnet-hrsod": "MIT", "birefnet-hr": "MIT",
  "birefnet-hr-matting": "MIT", "birefnet-dynamic-matting": "MIT", "ben2-base": "MIT", "inspyrenet-base": "MIT",
  "bria-rmbg": "CC BY-NC 4.0 (gated on Hugging Face; rembg hosts the ONNX)", "rmbg-1.4": "non-commercial",
};
export const AGENCY_REFERENCE_INR = 60;
/** Brands from section 4.2 with no sample images in this build (reduced scope: only Anta and French Connection have real sets). */
export const WAITING_BRANDS = ["Campus", "ONLY", "Cardio Bunny", "Keds", "USPA", "Vero Moda", "Penti", "Nautica", "Puma", "Bergner", "Carote", "Nutricook", "NutriBullet", "GTPlayer", "Tower", "Dowinx", "Qubo", "Nuwey", "BHPC", "Samsco"];

export interface ReportInput {
  set: string; runId: string; batchIds: string[]; scopes: ScopeResult[];
  notRun: { model: string; reason: string }[];
  cost: { usd: number; products: number; inrPerUsd: number | null };
  policyRows: { brandSlug: string; category: string; outcome: string }[];
  commands: string[];
}
export function reportJson(input: ReportInput) {
  const usdPerStyle = input.cost.products ? input.cost.usd / input.cost.products : null;
  return {
    set: input.set, runId: input.runId, batchIds: input.batchIds,
    candidates: MATTE_CANDIDATES.map(c => ({ ...c, licence: LICENCES[c.id] ?? "unknown" })),
    scopes: input.scopes.map(s => ({ brand: s.brand, category: s.category, judges: s.judges, mattes: s.mattes, matteRanking: s.matteRanking, row: s.row, labelerDisagreements: s.disagreements })),
    notRun: input.notRun, experiments: "not run: the refinement experiments are deferred in this build",
    brandsWaitingForImages: WAITING_BRANDS,
    cost: { usd: input.cost.usd, products: input.cost.products, usdPerStyle, inrPerStyle: usdPerStyle !== null && input.cost.inrPerUsd ? usdPerStyle * input.cost.inrPerUsd : null, agencyReferenceInr: AGENCY_REFERENCE_INR },
    policyRows: input.policyRows, commands: input.commands,
  };
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (v: number | null | undefined) => v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`;
const num = (v: number | null | undefined, d = 0) => v === null || v === undefined ? "n/a" : v.toFixed(d);
const table = (head: string[], rows: unknown[][]) => `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

export function reportHtml(input: ReportInput): string {
  const data = reportJson(input);
  const parts: string[] = [`<h1>Bake-off ${esc(input.set)} ${esc(input.runId)}</h1>`, `<p>Batches: ${esc(input.batchIds.join(", "))}</p>`];
  parts.push("<h2>Candidates</h2>", table(["Model", "Tier", "Input size", "GPU only", "Licence"], data.candidates.map(c => [c.id, c.tier, c.inputSize, c.gpuOnly ? "yes" : "no", c.licence])));
  parts.push("<h2>Candidates not run</h2>", input.notRun.length ? table(["Model", "Reason"], input.notRun.map(n => [n.model, n.reason])) : "<p>None.</p>");
  for (const s of input.scopes) {
    parts.push(`<h2>${esc(s.brand)} / ${esc(s.category)}</h2>`);
    parts.push(table(["Judge", "Precision", "Recall", "n labelled", "n passed by judge", "n flagged by human", "Precision gate", "Recall gate", "Swept threshold", "USD per check", "ms per check"],
      s.judges.map(j => [j.judgeModel, pct(j.atDefault.precision), pct(j.atDefault.recall), j.atDefault.n_labelled, j.atDefault.n_passed_by_judge, j.atDefault.n_flagged_by_human, j.atDefault.precisionGate, j.atDefault.recallGate, j.sweptThreshold ?? "none", num(j.costPerCheck, 5), num(j.msPerCheck)])));
    parts.push(table(["Matte", "Target", "n", "n labelled", "Compliance", "Human edge flags", "Judge edge disagreements", "Mean edge", "Mean background", "ms per image (CPU)", "ms per image (L4)", "Plan hours", "Plan USD"],
      s.mattes.map(m => [m.matteModel, m.matteTarget, m.n, m.n_labelled, pct(m.complianceRate), pct(m.edgeFlagRate), m.edgeDisagreements, num(m.meanEdgeQuality, 1), num(m.meanBackgroundClean, 1), m.matteTarget === "cpu" ? num(m.msPerImage) : "", m.matteTarget === "gpu" ? num(m.msPerImage) : "", num(m.planHours, 1), num(m.planUsd, 2)])));
    parts.push(`<p>Matte ranking: ${esc(s.matteRanking.map(r => `${r.matteModel} (${r.matteTarget})`).join(" > ") || "no labels")}. Labeler disagreements: ${s.disagreements}.</p>`);
    if (s.row && !s.row.gates.met) parts.push(`<p>Gates not met for this pair: no judge reached precision 97% and recall 90% at any threshold with the labels available, so QA runs per output until the next re-evaluation.</p>`);
  }
  parts.push("<h2>Policy rows</h2>", input.policyRows.length ? table(["Brand", "Category", "Outcome"], input.policyRows.map(r => [r.brandSlug, r.category, r.outcome])) : "<p>Not written yet (run policy write).</p>");
  parts.push("<h2>Experiments</h2>", `<p>${esc(data.experiments)}</p>`);
  parts.push("<h2>Cost per style+colour</h2>", `<p>USD ${num(data.cost.usd, 4)} over ${data.cost.products} products: USD ${num(data.cost.usdPerStyle, 4)} per style${data.cost.inrPerStyle !== null ? `, INR ${num(data.cost.inrPerStyle, 2)} per style` : ""}, next to the agency reference INR ${AGENCY_REFERENCE_INR} per style+colour.</p>`);
  parts.push("<h2>Brands waiting for sample images</h2>", `<p>${esc(WAITING_BRANDS.join(", "))}</p>`);
  parts.push("<h2>Commands used</h2>", `<pre>${esc(input.commands.join("\n"))}</pre>`);
  return `<!doctype html><meta charset="utf-8"><title>Bake-off ${esc(input.set)}</title><style>body{font-family:sans-serif;margin:16px}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ccc;padding:4px 6px;font-size:13px}</style>${parts.join("\n")}`;
}

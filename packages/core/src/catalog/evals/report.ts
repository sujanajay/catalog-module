// Report of an output-quality eval run: a JSON twin of every check and an HTML contact sheet that
// shows every failing image with the number measured and the bar it missed. Written under
// catalog-test/evals/<run>/ by the job and locally; no model id is ever written here.
import sharp from "sharp";
import type { FlagRow } from "./attention";
import type { CheckGroup, CheckResult } from "./types";

export interface ReportThumb { identifier: string; n: number; channel: string; original: Buffer | null; output: Buffer | null; /** Object path of the retained full-size output (catalog-test/evals/<run>/evidence/...), when kept. */ evidence?: string | null }
export interface EvalReport {
  run: string; startedAt: string; finishedAt: string; mode: string;
  golden: { products: number; photos: number; brands: Record<string, number>; categories: Record<string, number>; tags: Record<string, number> };
  summary: { checks: number; passed: number; failed: number; notRun: number; /** Checks recorded as information (status `info`): measured, never failed. */ information: number; attentionProducts: number; attentionRate: number; expectedAttention: number; falseHoldRate: number | null; useAsIsRate: number | null; planted: { caught: number; total: number }; line: string; passedAll: boolean };
  byGroup: Record<CheckGroup, { checks: number; passed: number; failed: number; notRun: number }>;
  byCheck: Record<string, { checks: number; failed: number }>;
  failures: CheckResult[];
  notRun: CheckResult[];
  /** Checks with status `info` (an open owner decision measured on this run, section 15c). */
  information: CheckResult[];
  attention: { identifier: string; detail: string }[];
  /** One row per flag raised, held or not. `model` is engineering data for this JSON only. */
  flags: FlagRow[];
  batches: string[];
  results?: CheckResult[];
}

export function summaryLine(passed: number, checks: number, attentionProducts: number): string {
  return `Output-quality eval: ${passed} of ${checks} checks passed, ${attentionProducts} products need attention (target 0)`;
}

export interface ReportInput {
  run: string; startedAt: Date; finishedAt: Date; mode: string; golden: EvalReport["golden"]; results: CheckResult[];
  attention: { attentionProducts: number; attentionRate: number; expectedAttention: number; falseHoldRate: number | null; useAsIsRate: number | null; plantedCaught: number; plantedTotal: number };
  flags: FlagRow[]; batches: string[]; includeAll?: boolean;
}
export function buildReport(input: ReportInput): EvalReport {
  const groups: CheckGroup[] = ["completeness", "geometry", "shadow", "cutout", "cut_edge", "attention", "overwrite"];
  const byGroup = Object.fromEntries(groups.map(g => [g, { checks: 0, passed: 0, failed: 0, notRun: 0 }])) as EvalReport["byGroup"];
  const byCheck: EvalReport["byCheck"] = {};
  let passed = 0, failed = 0, notRun = 0, information = 0;
  for (const r of input.results) {
    const g = byGroup[r.group]; g.checks++;
    const c = byCheck[r.id] ??= { checks: 0, failed: 0 }; c.checks++;
    if (r.status === "not_run") { g.notRun++; notRun++; } else if (r.status === "info") { g.notRun++; information++; } else if (r.ok) { g.passed++; passed++; } else { g.failed++; failed++; c.failed++; }
  }
  const checks = passed + failed, a = input.attention;
  const failures = input.results.filter(r => r.status === "fail");
  return {
    run: input.run, startedAt: input.startedAt.toISOString(), finishedAt: input.finishedAt.toISOString(), mode: input.mode, golden: input.golden,
    summary: { checks, passed, failed, notRun, information, attentionProducts: a.attentionProducts, attentionRate: a.attentionRate, expectedAttention: a.expectedAttention, falseHoldRate: a.falseHoldRate, useAsIsRate: a.useAsIsRate, planted: { caught: a.plantedCaught, total: a.plantedTotal }, line: summaryLine(passed, checks, a.attentionProducts), passedAll: failed === 0 && a.attentionProducts === 0 },
    byGroup, byCheck, failures, notRun: input.results.filter(r => r.status === "not_run"), information: input.results.filter(r => r.status === "info"),
    attention: input.results.filter(r => r.id === "attention.not_held" && !r.ok).map(r => ({ identifier: r.subject.identifier, detail: r.detail })),
    flags: input.flags, batches: input.batches, ...(input.includeAll ? { results: input.results } : {}),
  };
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const MAX_THUMBS = 400;

async function thumb(bytes: Buffer | null): Promise<string> {
  if (!bytes) return "";
  try { return `<img width="240" src="data:image/jpeg;base64,${(await sharp(bytes).resize(240, 320, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()).toString("base64")}">`; }
  catch { return "<span>(no preview)</span>"; }
}

/** The contact sheet: one row per failing (identifier, image, channel) with every failed check and its numbers. */
export async function reportHtml(report: EvalReport, thumbs: ReportThumb[]): Promise<string> {
  const key = (r: CheckResult) => `${r.subject.identifier}|${r.subject.n ?? ""}|${r.subject.channel ?? ""}`;
  const grouped = new Map<string, CheckResult[]>();
  for (const f of report.failures) grouped.set(key(f), [...grouped.get(key(f)) ?? [], f]);
  const rows: string[] = [];
  let shown = 0;
  for (const [k, fails] of grouped) {
    const [identifier, n, ch] = k.split("|");
    const t = thumbs.find(x => x.identifier === identifier && String(x.n) === n && x.channel === ch);
    const pics = t && shown < MAX_THUMBS ? `${await thumb(t.original)} ${await thumb(t.output)}${t.evidence ? `<br><small>full size: <code>${esc(t.evidence)}</code></small>` : ""}` : "";
    if (pics) shown++;
    rows.push(`<tr><td><b>${esc(identifier)}</b>${n ? ` image ${esc(n)}` : ""}${ch ? ` for ${esc(ch)}` : ""}</td><td>${pics}</td><td><ul>${fails.map(f => `<li><code>${esc(f.id)}</code>: ${esc(f.detail)} <i>(measured ${esc(f.measured)}, bar ${esc(f.threshold)} ${esc(f.unit)})</i></li>`).join("")}</ul></td></tr>`);
  }
  const groupRows = Object.entries(report.byGroup).map(([g, v]) => `<tr><td>${esc(g)}</td><td>${v.checks}</td><td>${v.passed}</td><td>${v.failed}</td><td>${v.notRun}</td></tr>`).join("");
  const checkRows = Object.entries(report.byCheck).sort().map(([id, v]) => `<tr><td><code>${esc(id)}</code></td><td>${v.checks}</td><td>${v.failed}</td></tr>`).join("");
  return `<!doctype html><meta charset="utf-8"><title>Output-quality eval ${esc(report.run)}</title><style>body{font-family:sans-serif;margin:16px}table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ccc;padding:4px 6px;font-size:13px;vertical-align:top}img{margin:2px;border:1px solid #999}.ok{color:#1a7f37}.bad{color:#b31d28}</style>
<h1>Output-quality eval ${esc(report.run)}</h1>
<p class="${report.summary.passedAll ? "ok" : "bad"}"><b>${esc(report.summary.line)}</b></p>
<p>Mode: ${esc(report.mode)}. Golden set: ${report.golden.products} products, ${report.golden.photos} photos. Attention rate ${(report.summary.attentionRate * 100).toFixed(2)}% (target 0). False-hold rate ${report.summary.falseHoldRate === null ? "no holds" : `${(report.summary.falseHoldRate * 100).toFixed(1)}%`} (target 0). Planted wrong items caught: ${report.summary.planted.caught} of ${report.summary.planted.total}. Expected attention products: ${report.summary.expectedAttention}. Checks not run: ${report.summary.notRun}. Recorded as information: ${report.summary.information}.</p>
<h2>By group</h2><table><thead><tr><th>Group</th><th>Checks</th><th>Passed</th><th>Failed</th><th>Not run</th></tr></thead><tbody>${groupRows}</tbody></table>
<h2>By check</h2><table><thead><tr><th>Check</th><th>Runs</th><th>Failed</th></tr></thead><tbody>${checkRows}</tbody></table>
<h2>Products needing attention (${report.attention.length})</h2><ul>${report.attention.map(a => `<li><b>${esc(a.identifier)}</b>: ${esc(a.detail)}</li>`).join("") || "<li>none</li>"}</ul>
<h2>Failing images (${grouped.size})</h2><table><thead><tr><th>Image</th><th>Original and output</th><th>Failed checks</th></tr></thead><tbody>${rows.join("") || "<tr><td colspan=3>None.</td></tr>"}</tbody></table>
<h2>Flags raised (${report.flags.length})</h2><table><thead><tr><th>Product</th><th>Image</th><th>Channel</th><th>Flag</th><th>Dimension</th><th>Score</th><th>Bar</th><th>Evidence</th><th>Action</th><th>Final status</th><th>Human label</th></tr></thead><tbody>${report.flags.slice(0, 2000).map(f => `<tr><td>${esc(f.identifier)}</td><td>${f.n}</td><td>${esc(f.channel)}</td><td>${esc(f.flag)}</td><td>${esc(f.dimension ?? "")}</td><td>${f.score === null || Number.isNaN(f.score) ? "" : f.score}</td><td>${f.dimension ? f.threshold : ""}</td><td>${esc(f.evidence)}</td><td>${esc(f.action)}</td><td>${esc(f.finalStatus)}</td><td>${esc(f.humanLabel)}</td></tr>`).join("")}</tbody></table>
<h2>Information (${report.information.length})</h2><p>Measured and recorded, not failed: an open owner decision (section 15c).</p><ul>${report.information.slice(0, 200).map(r => `<li><code>${esc(r.id)}</code> ${esc(r.subject.identifier)}${r.subject.n ? ` image ${r.subject.n}` : ""}${r.subject.channel ? ` for ${esc(r.subject.channel)}` : ""}: ${esc(r.detail)} <i>(measured ${esc(r.measured)}, bar ${esc(r.threshold)} ${esc(r.unit)})</i></li>`).join("") || "<li>none</li>"}</ul>
<h2>Checks not run (${report.notRun.length})</h2><ul>${[...new Set(report.notRun.map(r => `${r.id}: ${r.detail}`))].slice(0, 50).map(esc).map(s => `<li>${s}</li>`).join("")}</ul>`;
}

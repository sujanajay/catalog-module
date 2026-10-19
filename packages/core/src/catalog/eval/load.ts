// Loads the rows score.ts works on for a set of eval batches (spec 08 section 4.5 inputs).
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogBatches, catalogEvalJudgements, catalogEvalLabels, catalogOutputs, catalogProducts, catalogSourceImages, modelPolicy } from "../../db/schema";
import type { EvalJudgementRow, EvalLabelRow, EvalOutputRow } from "./score";

export async function loadEvalRows(db: Db, batchIds: readonly string[]) {
  if (!batchIds.length) return { batches: [], outputs: [] as EvalOutputRow[], judgements: [] as EvalJudgementRow[], labels: [] as EvalLabelRow[] };
  const ids = [...batchIds];
  const batches = await db.select().from(catalogBatches).where(inArray(catalogBatches.id, ids));
  if (batches.length !== ids.length || batches.some(b => !b.isTest || !b.options.evalSet)) throw new Error("Every batch must be an eval test batch.");
  const rows = await db.select({ output: catalogOutputs, source: catalogSourceImages, product: catalogProducts })
    .from(catalogOutputs)
    .innerJoin(catalogSourceImages, eq(catalogSourceImages.id, catalogOutputs.sourceImageId))
    .innerJoin(catalogProducts, eq(catalogProducts.id, catalogOutputs.productId))
    .where(and(inArray(catalogOutputs.batchId, ids), sql`${catalogOutputs.status} <> 'skipped'`));
  const outputs: EvalOutputRow[] = rows.map(({ output, source, product }) => {
    const batch = batches.find(b => b.id === output.batchId)!;
    return {
      outputId: output.id, batchId: output.batchId, brand: batch.brandSlug, category: product.productType ?? "other",
      matteModel: source.matteModel ?? batch.options.policy?.matteModel ?? "unknown",
      matteTarget: batch.options.policy?.matteTarget ?? "cpu", matteMs: source.matteMs, complianceOk: output.compliance?.ok === true,
    };
  });
  const judgements = (await db.select().from(catalogEvalJudgements).where(inArray(catalogEvalJudgements.batchId, ids)))
    .map(j => ({ outputId: j.outputId, judgeModel: j.judgeModel, scores: j.scores, verdict: j.verdict, costUsd: Number(j.costUsd), ms: j.ms }));
  const labels = (await db.select().from(catalogEvalLabels).where(inArray(catalogEvalLabels.batchId, ids)))
    .map(l => ({ outputId: l.outputId, labeler: l.labeler, label: l.label, reasons: l.reasons, createdAt: l.createdAt }));
  return { batches, outputs, judgements, labels };
}

/**
 * `score --live` (section 4.7): per (brand, category) of every non-pending policy row, the outputs the
 * judge flagged in real batches since the row was written, and how many the operator kept with
 * "Use as is" (a false flag).
 */
export async function liveDrift(db: Db) {
  const policies = await db.select().from(modelPolicy);
  const out: { brand: string; category: string; since: Date; judged: number; judgeFlagged: number; falseFlags: number; falseFlagRate: number | null }[] = [];
  for (const p of policies) {
    if (p.source === "pending") continue;
    const rows = await db.select({ status: catalogOutputs.status, decision: catalogOutputs.decision, verdict: sql<string | null>`${catalogOutputs.qaScores}->>'verdict'` })
      .from(catalogOutputs)
      .innerJoin(catalogBatches, eq(catalogBatches.id, catalogOutputs.batchId))
      .innerJoin(catalogProducts, eq(catalogProducts.id, catalogOutputs.productId))
      .where(and(eq(catalogBatches.isTest, false), gte(catalogOutputs.createdAt, p.updatedAt), sql`${catalogOutputs.qaScores} IS NOT NULL`,
        p.brandSlug === "*" ? sql`true` : eq(catalogBatches.brandSlug, p.brandSlug),
        p.category === "*" ? sql`true` : eq(catalogProducts.productType, p.category)));
    const flagged = rows.filter(r => r.verdict === "flag");
    const falseFlags = flagged.filter(r => r.decision === "use_as_is").length;
    out.push({ brand: p.brandSlug, category: p.category, since: p.updatedAt, judged: rows.length, judgeFlagged: flagged.length, falseFlags, falseFlagRate: flagged.length ? falseFlags / flagged.length : null });
  }
  return out;
}

// Output-quality evals (spec 10): the shared result shape every checker returns. A check is a hard
// pass or fail with the number it measured and the bar it was measured against, so the report can
// show "what was measured and how" next to every failing image without re-running anything.
import type { ChannelId, OutputFlag, ProductType } from "../types";

export type CheckGroup = "completeness" | "geometry" | "shadow" | "cutout" | "cut_edge" | "attention" | "overwrite";

export interface CheckSubject {
  /** The golden identifier (without the run prefix). */
  identifier: string;
  n: number | null;
  channel: ChannelId | null;
}

export interface CheckResult {
  /** Stable check id, for example `geometry.edges` or `shadow.hard_edge`. */
  id: string;
  group: CheckGroup;
  subject: CheckSubject;
  ok: boolean;
  /** "not_run" when the check does not apply (its inputs were missing); counted separately, never as a pass. */
  status: "pass" | "fail" | "not_run";
  /** What was measured, in the unit named by `unit`. */
  measured: number | string | null;
  /** The bar, in the same unit. */
  threshold: number | string | null;
  unit: string;
  /** One plain sentence. */
  detail: string;
}

export interface Raster { w: number; h: number; rgb: Buffer }

/** The placement the pipeline recorded for an output (catalog_outputs columns). */
export interface OutputPlacement { w: number; h: number; scale: number; placedX: number; placedY: number }

export interface Expectation {
  /** The product is allowed (and required) to end in "needs attention". */
  attention: boolean;
  /** Flags the pipeline must raise on this source. */
  flags: OutputFlag[];
  /** Which component detects the expected flags: code (always asserted) or the judge (asserted only on a live run). */
  detector: "code" | "judge";
}

/** Everything the image checks need for one (source, channel) output. */
export interface OutputSubject {
  identifier: string;
  n: number;
  channel: ChannelId;
  productType: ProductType;
  /** The source after prepare(): sRGB, EXIF applied. */
  source: Raster;
  /** Median border colour of the source and whether the border is uniform (prepare's analysis). */
  sourceBackground: { uniform: boolean; color: [number, number, number] };
  /** The matte at source resolution, one byte per pixel. */
  alpha: Buffer;
  /** The encoded output exactly as staged (and copied to the public link). */
  jpeg: Buffer;
  placement: OutputPlacement;
  flags: OutputFlag[];
  status: string;
  expect: Expectation;
}

export const pass = (id: string, group: CheckGroup, subject: CheckSubject, measured: CheckResult["measured"], threshold: CheckResult["threshold"], unit: string, detail: string): CheckResult => ({ id, group, subject, ok: true, status: "pass", measured, threshold, unit, detail });
export const fail = (id: string, group: CheckGroup, subject: CheckSubject, measured: CheckResult["measured"], threshold: CheckResult["threshold"], unit: string, detail: string): CheckResult => ({ id, group, subject, ok: false, status: "fail", measured, threshold, unit, detail });
export const notRun = (id: string, group: CheckGroup, subject: CheckSubject, detail: string): CheckResult => ({ id, group, subject, ok: true, status: "not_run", measured: null, threshold: null, unit: "", detail });
/** Pass or fail in one call: `ok` decides, the numbers are recorded either way. */
export const judge = (ok: boolean, id: string, group: CheckGroup, subject: CheckSubject, measured: CheckResult["measured"], threshold: CheckResult["threshold"], unit: string, detail: string): CheckResult => (ok ? pass : fail)(id, group, subject, measured, threshold, unit, detail);

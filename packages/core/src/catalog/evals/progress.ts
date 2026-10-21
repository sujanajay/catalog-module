// Durable progress for the output-quality eval run (spec 10 section 13). The job processes one
// (brand, category) set at a time and, after each set, writes everything the final report needs
// from it under catalog-test/evals/<run>/sets/<set>.json. A later `run --resume <run>` loads those
// records, skips the sets that finished, re-runs the ones that failed and finishes the report from
// stored results, so a transient failure costs one set and not the whole run.
import { retryTransient, type RetryOptions } from "../../retry";
import type { AttentionOutputRow, AttentionProductRow, AttentionShotRow } from "./attention";
import type { MatteTrial } from "./matte-bakeoff";
import type { ReportThumb } from "./report";
import type { CheckResult } from "./types";

export const EVALS_PREFIX = "catalog-test/evals";
export const RUN_ID_PATTERN = /^evals-[A-Za-z0-9-]+$/;
export const SET_ID_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/** One (brand, category) set is named `<brand>.<category>`, for example `anta.footwear`. */
export const setId = (brand: string, category: string) => `${brand}.${category}`;
export const setsPrefix = (run: string) => `${EVALS_PREFIX}/${run}/sets/`;
export const setRecordPath = (run: string, set: string) => `${setsPrefix(run)}${set}.json`;

/**
 * Evidence retention: the job's cleanup deletes every output when a set ends, so the full-size output of every image
 * with a failing check is copied under the run before cleanup (at most EVIDENCE_CAP_PER_SET per set), and its path
 * goes on the record's thumb row. Everything stays under catalog-test/.
 */
export const EVIDENCE_CAP_PER_SET = 200;
export const evidencePrefix = (run: string, set: string) => `${EVALS_PREFIX}/${run}/evidence/${set}/`;
export const evidencePath = (run: string, set: string, identifier: string, channel: string, n: number) => `${evidencePrefix(run, set)}${identifier}__${channel}__${n}.jpg`;
/** A sample of an all-pass set: one output per photo (noon), kept under the same cap with the `sample` suffix (section 15e). */
export const samplePath = (run: string, set: string, identifier: string, channel: string, n: number) => `${evidencePrefix(run, set)}${identifier}__${channel}__${n}__sample.jpg`;
export const SAMPLE_CHANNEL = "noon";
/** Hands out at most `cap` evidence slots; `take` is synchronous so concurrent image checks never exceed the cap. */
export class EvidenceBudget {
  kept = 0;
  skipped = 0;
  constructor(readonly cap = EVIDENCE_CAP_PER_SET) {}
  take(): boolean { if (this.kept < this.cap) { this.kept++; return true; } this.skipped++; return false; }
}

export interface SetRecord {
  set: string; brand: string; category: string;
  status: "done" | "failed";
  /**
   * The failure, in one line, when status is "failed". The arrays below are then empty, except when
   * only the overwrite passes failed: the set keeps its first-pass checks and the overwrite checks
   * are recorded as failed with the error.
   */
  error: string | null;
  startedAt: string; finishedAt: string;
  photos: number; products: number;
  results: CheckResult[];
  thumbs: ReportThumb[];
  deterministicPass: string[];
  attentionRows: AttentionOutputRow[];
  attentionProducts: AttentionProductRow[];
  trials: MatteTrial[];
  /** The overwrite contract ran on this set (it runs on the first eligible set of the run only). */
  overwriteRan: boolean;
  batches: string[];
  /** Per-shot expectations of the manifest in the batch's own shot numbers (mapped by source sha256), for attention.expected_flags. */
  shotExpectations?: AttentionShotRow[];
  /** Byte-identical sources of the set, counted once in the bake-off (the kept `identifier_n` and the ones dropped for it). */
  duplicateSources?: { sha256: string; kept: string; dropped: string[] }[];
}

type StoredThumb = Omit<ReportThumb, "original" | "output"> & { original: string | null; output: string | null };

export function serializeSetRecord(record: SetRecord): string {
  const thumbs: StoredThumb[] = record.thumbs.map(t => ({ ...t, original: t.original?.toString("base64") ?? null, output: t.output?.toString("base64") ?? null }));
  return JSON.stringify({ ...record, thumbs });
}

export function parseSetRecord(text: string): SetRecord {
  const raw = JSON.parse(text) as Omit<SetRecord, "thumbs"> & { thumbs: StoredThumb[] };
  if (typeof raw.set !== "string" || (raw.status !== "done" && raw.status !== "failed") || !Array.isArray(raw.results)) throw new Error("Not an eval set record.");
  const thumbs: ReportThumb[] = (raw.thumbs ?? []).map(t => ({ ...t, original: t.original === null ? null : Buffer.from(t.original, "base64"), output: t.output === null ? null : Buffer.from(t.output, "base64") }));
  return { ...raw, thumbs };
}

/** Parses `--sets a.b,c.d`; every id must be one of `known`. */
export function parseSetsFlag(value: string, known: readonly string[]): string[] {
  const ids = value.split(",").map(v => v.trim()).filter(Boolean);
  if (!ids.length) throw new Error("--sets needs at least one set id, for example anta.footwear.");
  const unknown = ids.filter(id => !known.includes(id));
  if (unknown.length) throw new Error(`Unknown set${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Known sets: ${known.join(", ")}.`);
  return [...new Set(ids)];
}

/**
 * Which sets to process, in `all` order: a set with a stored "done" record is skipped, a stored
 * "failed" record is re-run, and `only` (from --sets) narrows the list.
 */
export function selectSets(all: readonly string[], stored: ReadonlyMap<string, SetRecord>, only?: readonly string[]): { run: string[]; skipped: string[] } {
  const wanted = only ? all.filter(id => only.includes(id)) : [...all];
  const skipped = wanted.filter(id => stored.get(id)?.status === "done");
  return { run: wanted.filter(id => !skipped.includes(id)), skipped };
}

/** The storage calls the eval path makes directly; the pipeline handlers keep their own client. */
export interface EvalStorage {
  downloadBuffer(gsUri: string): Promise<{ buf: Buffer; mime: string }>;
  uploadBuffer(path: string, buf: Buffer, mime: string): Promise<string>;
  headObject(gsUri: string): Promise<{ exists: boolean; size: number | null; contentType: string | null; generation: string | null; crc32c: string | null }>;
  listObjects(gsPrefixUri: string): Promise<string[]>;
}

/** Default: five attempts, 1 s, 2 s, 4 s, 8 s between them, on socket resets, timeouts, 429 and 5xx. */
export const EVAL_STORAGE_RETRY: RetryOptions = { tries: 5 };

/**
 * Every read and write of the eval path (golden sources, mattes, outputs, set records, the report)
 * is retried on transient network errors. Each call is idempotent (a whole-object read, an
 * overwrite of a path this run owns, a metadata read, a listing), so repeating it is safe.
 */
export function withEvalRetry(storage: EvalStorage, opts: RetryOptions = EVAL_STORAGE_RETRY): EvalStorage {
  return {
    downloadBuffer: uri => retryTransient(() => storage.downloadBuffer(uri), opts),
    uploadBuffer: (path, buf, mime) => retryTransient(() => storage.uploadBuffer(path, buf, mime), opts),
    headObject: uri => retryTransient(() => storage.headObject(uri), opts),
    listObjects: prefix => retryTransient(() => storage.listObjects(prefix), opts),
  };
}

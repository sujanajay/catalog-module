// The ingest working files (spec 04, "Ingest run"; see index.ts for the layout): the per-upload
// manifest and its JSON helpers. Kept apart from index.ts so step 2 (detect-step.ts) and the link
// failures (link-failures.ts) can read manifests without importing the runner.
import { getBucketName, toGsUri } from "../../storage";
import type { OutputFlag } from "../types";
import type { Detected, IngestDeps, SourceItem } from "./types";

/**
 * What reading one item gave: where its bytes are and what they are, or the reject sentence. A link
 * (spec 14d F5 part 2) also carries `attempts`, the fetches made for it across runs, and a failed link
 * `final`: false while a later run may fetch it again (a transient failure under LINK_MAX_ATTEMPTS),
 * true otherwise. Results written before release D have neither; they are kept as they are.
 */
export type ItemResult =
  | { ok: true; sha256: string; uri: string; mime: string; ext: string; width: number | null; height: number | null; size: number; flags: OutputFlag[]; attempts?: number }
  | { ok: false; reason: string; attempts?: number; final?: boolean };

/** Per upload: its items, the results so far, sheet warnings and the Detected for catalog_uploads. */
export interface UploadManifest {
  version: 1;
  items: SourceItem[];
  results: Record<string, ItemResult>;
  warnings: string[];
  productList: boolean;
  detected: Detected;
  /**
   * Fetches already made in earlier runs for links whose non-final failure this run dropped (spec 14d
   * F5 part 2), by item key, so the attempts add up across runs towards LINK_MAX_ATTEMPTS.
   */
  priorAttempts?: Record<string, number>;
}

/** Stable key of an item's bytes, so a re-collected item finds its earlier result. */
export function itemKey(item: SourceItem): string {
  const b = item.bytes;
  if (b.kind === "gcs") return `gcs:${b.gsUri}`;
  if (b.kind === "url") return `url:${b.url}`;
  return `zip:${b.zipGsUri}#${b.entryPath}`;
}

export const workPrefix = (prefix: string) => `${prefix}/derived/_ingest`;
export const manifestPath = (prefix: string, uploadId: string) => `${workPrefix(prefix)}/${uploadId}/manifest.json`;

export async function loadJson<T>(deps: Pick<IngestDeps, "storage">, objectPath: string): Promise<T | null> {
  const gsUri = toGsUri(getBucketName(), objectPath);
  const head = await deps.storage.headObject(gsUri);
  if (!head.exists) return null;
  return JSON.parse((await deps.storage.downloadBuffer(gsUri)).buf.toString("utf8")) as T;
}

export async function saveJson(deps: Pick<IngestDeps, "storage">, objectPath: string, value: unknown): Promise<void> {
  await deps.storage.uploadBuffer(objectPath, Buffer.from(JSON.stringify(value), "utf8"), "application/json");
}

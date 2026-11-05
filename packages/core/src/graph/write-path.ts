// M0-S3 write path (docs/program/requirements/M0-catalog-graph.md F2 and F3-R1, R2, R9): the pipeline's calls into the
// graph. Ingest records each accepted brand photo as an asset and a `brand` version (F2-R1); the render records each
// staged output as an asset (sha256 of the staged bytes, 64-bit difference hash) and a channel version whose parent is
// its photo's version (F2-R2, R3, R7); publish turns every changed slot into a `links_delivered` or `removed` event
// with a reason and a change type (F3-R1, R2, R9). Everything here is idempotent and joins the caller's transaction.
import sharp from "sharp";
import { CHANGE_TYPE, type ChangeTypeId } from "../learning/change-types";
import { catalogAssets, catalogContentVersions } from "../db/schema";
import type { ChannelId } from "../catalog/types";
import { recordAsset, recordVersion, sha256Hex, type GraphDb, type NewAsset } from "./index";
import type { ReasonKind, VersionSource } from "./types";

/** The module that records brand photos (M1 intake) and the one that records channel renders (M3 images). */
export const SOURCE_PHOTO_PRODUCER = "M1";
export const OUTPUT_PRODUCER = "M3";
/** created_by of the versions the pipeline writes. */
export const PIPELINE_ACTOR = "catalog-worker";

const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Perceptual hash (F2-R7)
// ---------------------------------------------------------------------------

/**
 * The 64-bit difference hash: the image as a 9x8 grey thumbnail; bit i (row-major, most significant first) is 1 when
 * pixel x of row y is brighter than pixel x + 1. A resized or re-compressed copy keeps (nearly) the same bits.
 */
export async function dhash64(bytes: Uint8Array): Promise<bigint> {
  const grey = await sharp(bytes).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) hash = (hash << 1n) | (grey[y * 9 + x]! > grey[y * 9 + x + 1]! ? 1n : 0n);
  }
  return hash;
}

/** Hamming distance of two 64-bit hashes (the F3 matcher compares it with the match distance setting). */
export function phashDistance(a: bigint, b: bigint): number {
  let v = BigInt.asUintN(64, a ^ b), d = 0;
  while (v) { d += Number(v & 1n); v >>= 1n; }
  return d;
}

/**
 * The asset row of image bytes, computed outside any transaction (hashing is CPU work). An image the decoder cannot
 * read keeps a null perceptual hash: the version is still recorded (its sha256 is exact), only live matching skips it.
 */
export async function imageAsset(bytes: Uint8Array, uri: string, mime: string): Promise<NewAsset> {
  const sha256 = sha256Hex(bytes);
  try {
    const [phash, meta] = await Promise.all([dhash64(bytes), sharp(bytes).metadata()]);
    return { sha256, uri, mime, bytes: bytes.length, phash, width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { sha256, uri, mime, bytes: bytes.length, phash: null };
  }
}

// ---------------------------------------------------------------------------
// Brand photos (F2-R1)
// ---------------------------------------------------------------------------

/** What the write path needs of a catalog_source_images row. */
export interface SourcePhoto {
  productId: string;
  batchId: string;
  n: number;
  sha256: string;
  rawUri: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
}

/** One brand photo version per product and content: re-sending a photo in a later batch reuses it (F2-R6). */
export const sourceProducerRef = (productId: string) => `product:${productId}`;

const sourceVersionRow = (p: SourcePhoto, optionId: string | null, isTest: boolean) => ({
  optionId, scope: "master" as const, component: "image" as const, role: "unknown" as const, position: p.n, source: "brand" as const,
  aiGenerated: false, producer: SOURCE_PHOTO_PRODUCER, producerRef: sourceProducerRef(p.productId), assetSha256: p.sha256,
  contentHash: p.sha256, hashKind: "sha256" as const, batchId: p.batchId, isTest, createdBy: PIPELINE_ACTOR,
});

/**
 * Ingest (F2-R1): every accepted photo as an asset (its existing sha256; no perceptual hash: the photo's bytes are not read
 * here, and live matching compares channel images with the output versions) and a `brand` version, scope master, position n, role unknown until M2 reads it. Bulk,
 * 500 rows a statement, idempotent. A row whose sha256 is not a sha256 (never written by ingest) is left out.
 * Returns the number of versions created.
 */
export async function recordSourcePhotoVersions(db: GraphDb, photos: readonly (SourcePhoto & { optionId: string | null; isTest: boolean })[]): Promise<number> {
  const valid = photos.filter((p) => SHA256_HEX.test(p.sha256));
  let created = 0;
  for (let i = 0; i < valid.length; i += 500) {
    const part = valid.slice(i, i + 500);
    await db
      .insert(catalogAssets)
      .values(part.map((p) => ({ sha256: p.sha256, uri: p.rawUri, mime: p.mime, width: p.width, height: p.height, bytes: p.bytes })))
      .onConflictDoNothing({ target: catalogAssets.sha256 });
    created += (
      await db
        .insert(catalogContentVersions)
        .values(part.map((p) => sourceVersionRow(p, p.optionId, p.isTest)))
        .onConflictDoNothing()
        .returning({ id: catalogContentVersions.id })
    ).length;
  }
  return created;
}

/**
 * The brand photo's version id, recording it when ingest did not (a photo the operator replaced, a batch collected
 * before M0-S3 shipped). Null for a row whose sha256 is not a sha256.
 */
export async function ensureSourceVersion(db: GraphDb, p: SourcePhoto, ctx: { optionId: string | null; isTest: boolean }): Promise<string | null> {
  if (!SHA256_HEX.test(p.sha256)) return null;
  await recordAsset(db, { sha256: p.sha256, uri: p.rawUri, mime: p.mime, width: p.width, height: p.height, bytes: p.bytes });
  return (await recordVersion(db, sourceVersionRow(p, ctx.optionId, ctx.isTest))).versionId;
}

// ---------------------------------------------------------------------------
// Channel renders (F2-R2, R3, R4)
// ---------------------------------------------------------------------------

/** F2-R2: `upscaled` when the upscaler made it, else `cleanup` (a cut-out render). Crops and generated images are M3-F1 and M3 mode A, recorded by their own producers. */
export function outputVersionSource(flags: readonly string[]): VersionSource {
  return flags.includes("upscaled") ? "upscaled" : "cleanup";
}

export interface OutputVersionInput {
  output: { id: string; channel: ChannelId; n: number; publicUrl: string; flags: readonly string[] };
  source: SourcePhoto;
  product: { optionId: string | null };
  batch: { id: string; isTest: boolean; settingsSnapshotId: string | null };
  /** imageAsset of the bytes written to staging (F2-R3: hashed where the bytes already are). */
  asset: NewAsset;
}

/**
 * Records a staged output: its asset and an immutable channel version (producer M3, producer_ref the output id) whose
 * parent is the brand photo's version. Run it in the transaction that writes the output's staging_uri and set the
 * returned id as content_version_id there (F2-R2). The same bytes for the same output return the same id (F2-R6).
 */
export async function recordOutputVersion(db: GraphDb, input: OutputVersionInput): Promise<string> {
  const { output, source, product, batch, asset } = input;
  await recordAsset(db, asset);
  const parent = await ensureSourceVersion(db, source, { optionId: product.optionId, isTest: batch.isTest });
  const versionSource = outputVersionSource(output.flags);
  const { versionId } = await recordVersion(db, {
    optionId: product.optionId, scope: output.channel, component: "image", role: "unknown", position: output.n,
    source: versionSource, aiGenerated: false, producer: OUTPUT_PRODUCER, producerRef: output.id, assetSha256: asset.sha256,
    parentVersionIds: parent ? [parent] : [], publicUrl: output.publicUrl, settingsSnapshotId: batch.settingsSnapshotId,
    batchId: batch.id, isTest: batch.isTest, createdBy: PIPELINE_ACTOR,
  });
  return versionId;
}

// ---------------------------------------------------------------------------
// Publish: reason and change type (F3-R9)
// ---------------------------------------------------------------------------

export interface PublishedSlot {
  /** catalog_content_versions.source of the version now behind the link. */
  versionSource: VersionSource;
  n: number;
  /** sha256 of the brand photo the slot's new image was made from. */
  sourceSha256: string;
  /** sha256 of the brand photo behind the image the slot held before; null for an empty slot. */
  previousSourceSha256: string | null;
  /** The new image's photo was live in another slot of this channel before (a re-ordered gallery). */
  movedFromOtherSlot: boolean;
  flags: readonly string[];
  decision: string | null;
}

/**
 * The M10 v0 change type of a delivered slot (decision table in the M0 doc, section 9): crops and generated images by
 * their version source; a photo moved from another slot is a re-order; a different photo in slot 1 replaces the main
 * image; an upscaled render is `img_upscaled`; any other render (the photo on the channel's background) is
 * `img_background_fixed`.
 */
export function publishChangeType(s: PublishedSlot): ChangeTypeId {
  if (s.versionSource === "crop") return CHANGE_TYPE.img_shotset_crops;
  if (s.versionSource === "generated") return CHANGE_TYPE.img_shotset_generated;
  if (s.movedFromOtherSlot && s.previousSourceSha256 !== s.sourceSha256) return CHANGE_TYPE.img_reordered;
  if (s.n === 1 && s.previousSourceSha256 !== null && s.previousSourceSha256 !== s.sourceSha256) return CHANGE_TYPE.img_main_replaced;
  if (s.versionSource === "upscaled") return CHANGE_TYPE.img_upscaled;
  return CHANGE_TYPE.img_background_fixed;
}

/** A removed slot changes the gallery without new content: v0 has no removal type, so it is a re-order (decision table). */
export const REMOVED_CHANGE_TYPE: ChangeTypeId = CHANGE_TYPE.img_reordered;

/**
 * Why a slot changed: an auto-decide rule's provisional pick (`auto_decide`), the operator's "Use as is" (`operator`),
 * the same photo made again under changed channel rules or pipeline (`rule`, with the channel's rules key version), else
 * new content from the brand (`new_content`).
 */
export function publishReason(s: PublishedSlot, rulesKeyVersion: string): { reasonKind: ReasonKind; reasonRef: string | null } {
  if (s.flags.includes("provisional")) return { reasonKind: "auto_decide", reasonRef: null };
  if (s.decision === "use_as_is") return { reasonKind: "operator", reasonRef: null };
  if (s.previousSourceSha256 !== null && s.previousSourceSha256 === s.sourceSha256) return { reasonKind: "rule", reasonRef: `channel-rules:${rulesKeyVersion}` };
  return { reasonKind: "new_content", reasonRef: null };
}

/** The change set of one product's publish in one batch: a stable uuid, so a retried publish names the same set. */
export function publishChangeSetId(batchId: string, productId: string): string {
  const h = sha256Hex(new TextEncoder().encode(`publish|${batchId}|${productId}`));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

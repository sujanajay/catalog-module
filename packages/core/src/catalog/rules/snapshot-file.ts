// M5-S3 (M5 3.3, M5-F4-R8): every published ruleset snapshot also lives once as JSON in private storage
// (`rules/snapshots/v<version>.json`), so a batch can still start on the rules when the snapshot table cannot be read.
// The file is written check-then-write (a snapshot never changes once published, so an existing file is never
// rewritten) by the first Start that pins its version; nothing here deletes a file.
import { getBucketName, toGsUri } from "../../storage";
import type * as storageModule from "../../storage";
import type { RulesetSnapshot } from "./types";

/**
 * The storage calls the snapshot file needs (the worker's and the web's storage module both fit). `getBucketName` is
 * the private bucket uploadBuffer writes to; absent, the BUCKET variable names it, as uploadBuffer itself reads it.
 */
export type SnapshotFileStorage = Pick<typeof storageModule, "uploadBuffer" | "downloadBuffer" | "headObject" | "listObjects"> & Partial<Pick<typeof storageModule, "getBucketName">>;
const bucketOf = (storage: SnapshotFileStorage, env: NodeJS.ProcessEnv) => (storage.getBucketName ? storage.getBucketName() : getBucketName(env));

export const SNAPSHOT_FILE_PREFIX = "rules/snapshots/";

/** The private-bucket object path of one published snapshot. */
export function snapshotFilePath(version: number): string {
  return `${SNAPSHOT_FILE_PREFIX}v${version}.json`;
}

/** The ruleset version a snapshot file path names, or null for any other object under the prefix. */
export function versionOfSnapshotFile(objectPath: string): number | null {
  const name = objectPath.slice(objectPath.lastIndexOf("/") + 1);
  const match = /^v([1-9]\d*)\.json$/.exec(name);
  return match ? Number(match[1]) : null;
}

/** Writes the snapshot file when it is not there yet. Returns true when this call wrote it. */
export async function ensureSnapshotFile(storage: SnapshotFileStorage, snapshot: RulesetSnapshot, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = snapshotFilePath(snapshot.version);
  if ((await storage.headObject(toGsUri(bucketOf(storage, env), path))).exists) return false;
  await storage.uploadBuffer(path, Buffer.from(JSON.stringify(snapshot)), "application/json");
  return true;
}

/** Reads one snapshot file; null when it does not exist. A file whose body is not that version's snapshot is an error. */
export async function readSnapshotFile(storage: SnapshotFileStorage, version: number, env: NodeJS.ProcessEnv = process.env): Promise<RulesetSnapshot | null> {
  const uri = toGsUri(bucketOf(storage, env), snapshotFilePath(version));
  if (!(await storage.headObject(uri)).exists) return null;
  const snapshot = JSON.parse((await storage.downloadBuffer(uri)).buf.toString("utf8")) as RulesetSnapshot;
  if (snapshot?.version !== version || !Array.isArray(snapshot.rules) || !Array.isArray(snapshot.channels)) throw new Error(`The rules snapshot file ${snapshotFilePath(version)} does not hold ruleset version ${version}.`);
  return snapshot;
}

/** The newest snapshot file in storage, or null when there is none. */
export async function latestSnapshotFile(storage: SnapshotFileStorage, env: NodeJS.ProcessEnv = process.env): Promise<RulesetSnapshot | null> {
  const listed = await storage.listObjects(toGsUri(bucketOf(storage, env), SNAPSHOT_FILE_PREFIX));
  const versions = listed.map((uri) => versionOfSnapshotFile(uri)).filter((v): v is number => v !== null).sort((a, b) => b - a);
  return versions.length ? readSnapshotFile(storage, versions[0]!, env) : null;
}

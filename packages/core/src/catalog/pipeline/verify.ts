import { isRetryableStorageError, STORAGE_RETRIES, STORAGE_RETRY_BASE_MS } from "../../storage";
export const VERIFY_RETRIES = 3;
export const STALE_GENERATION = "The public link returned a different generation.";
/** Public objects carry max-age=300 (SPEC: a re-upload shows within five minutes), plus a margin. */
export const PUBLIC_CACHE_WINDOW_MS = 310_000;
export type VerifyResult = { ok: true } | { ok: false; reason: string };
export interface VerifyOptions {
  size: number; generation: number | string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>;
  /**
   * Publication only: when the plain link keeps returning a cached older generation, read the copied
   * generation itself (`?generation=`, not in the cache) with the same checks. A just-overwritten link
   * the cache still holds serves the new bytes within the cache lifetime (SPEC: five minutes).
   */
  pinnedFallback?: boolean;
}
const sleepDefault = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** A public read, independent of the authenticated storage client. */
export async function verifyPublic(url: string, options: VerifyOptions): Promise<VerifyResult> {
  if (!new URL(url).pathname.endsWith(".jpg")) return { ok: false, reason: "The URL must end in .jpg." };
  const sleep = options.sleep ?? sleepDefault;
  let target = url;
  for (let stale = 0; ; stale++) {
    let response: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await (options.fetch ?? fetch)(target, { headers: { "Cache-Control": "no-cache" } });
        if (response.status === 429 || response.status >= 500) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        break;
      } catch (error) {
        if (attempt >= STORAGE_RETRIES || !(error instanceof TypeError || isRetryableStorageError(error))) return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        await sleep(STORAGE_RETRY_BASE_MS * 2 ** attempt);
      }
    }
    if (response.status !== 200) return { ok: false, reason: `HTTP ${response.status}` };
    if (response.headers.get("x-goog-generation") !== String(options.generation)) {
      await response.body?.cancel();
      if (target === url && stale < VERIFY_RETRIES) { await sleep(250 * 2 ** stale); continue; }
      if (options.pinnedFallback && target === url) { target = `${url}?generation=${encodeURIComponent(String(options.generation))}`; continue; }
      return { ok: false, reason: STALE_GENERATION };
    }
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "image/jpeg") return { ok: false, reason: "The public link is not image/jpeg." };
    if (response.headers.get("content-length") !== String(options.size)) return { ok: false, reason: "The public link has the wrong size." };
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length === options.size && bytes.subarray(0,3).equals(Buffer.from([255,216,255])) ? { ok: true } : { ok: false, reason: "The public link is not a complete JPEG." };
  }
}
/**
 * An independent reader of overwritten links: Google's cache may still serve the previous generation
 * of a plain public link for the cache lifetime, so a stale generation is polled until that window
 * ends. Every other failure returns at once.
 */
export async function verifyPublicSettled(url: string, options: VerifyOptions & { windowMs?: number; pollMs?: number; now?: () => number }): Promise<VerifyResult> {
  const now = options.now ?? Date.now, sleep = options.sleep ?? sleepDefault, deadline = now() + (options.windowMs ?? PUBLIC_CACHE_WINDOW_MS);
  for (;;) {
    const result = await verifyPublic(url, options);
    if (result.ok || result.reason !== STALE_GENERATION || now() >= deadline) return result;
    await sleep(options.pollMs ?? 10_000);
  }
}

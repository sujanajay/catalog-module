/**
 * The Photoroom overflow adapter (M3-F2-R3, M7-F2 table): background removal (`image.matte`, Remove Background API
 * `POST https://sdk.photoroom.com/v1/segment`, `channels=alpha`) and AI upscale (`image.upscale`, Image Editing API
 * `POST https://image-api.photoroom.com/v2/edit`, `upscale.mode=ai.fast`, a 4x enlargement). Shipped switched off: its
 * routes are seeded `off` with no no-training position and no daily cap, so no call is made until the owner records
 * both (no paid call without Sujan's yes, M3 4.2.10). Docs read through Context7 (2026-11-04).
 *
 * The key comes from the PHOTOROOM_API_KEY env mount (Secret Manager) and is never logged. The vendor name stays in the
 * route id, logs and the cost ledger's engine, never in operator text (M7-F2-R6).
 */
import sharp from "sharp";
import type { RouteAttempt, RouteFailure } from "../router";

export const PHOTOROOM_SEGMENT_URL = "https://sdk.photoroom.com/v1/segment";
export const PHOTOROOM_EDIT_URL = "https://image-api.photoroom.com/v2/edit";
/** The Remove Background API's input limit (Photoroom docs): 6,000 px on the widest side. */
export const PHOTOROOM_MAX_SIDE = 6000;
/** The AI upscale's fixed factor (`upscale.mode=ai.fast`: 4x). */
export const PHOTOROOM_UPSCALE_FACTOR = 4;
export const PHOTOROOM_TIMEOUT_MS = 120_000;

export interface PhotoroomDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}
/** One alpha mask at the size of the image that was sent (8-bit grey, row-major). */
export interface VendorMask { alpha: Buffer; width: number; height: number; ms: number }
/** One upscaled image (PNG bytes as the vendor answered, checked for size). */
export interface VendorUpscale { image: Buffer; width: number; height: number; ms: number }

/** A request with no answer: no key (no call), a refused connection (free) or a timeout (priced: it may be billed). */
const unanswered = <T>(failure: RouteFailure, priceUsd: number): RouteAttempt<T> =>
  ({value: null, failure, costUsd: failure.kind === "timeout" ? priceUsd : 0, calls: failure.kind === "no_key" ? 0 : 1});
/** The failure kind of an HTTP status: 402 is the account out of credit (not the next route's fault, but no answer). */
export function photoroomFailure(status: number): RouteFailure {
  const kind = status === 401 || status === 403 ? "auth" : status === 402 ? "payment_required" : status === 429 ? "rate_limit" : status >= 500 ? "server" : "http";
  return {kind, status};
}

async function post(url: string, form: FormData, deps: PhotoroomDeps): Promise<{response: Response; ms: number} | {failure: RouteFailure}> {
  const key = (deps.env ?? process.env).PHOTOROOM_API_KEY?.trim();
  if (!key) return {failure: {kind: "no_key", status: null}};
  const started = Date.now();
  try {
    const response = await (deps.fetch ?? fetch)(url, {method: "POST", headers: {"x-api-key": key}, body: form, signal: AbortSignal.timeout(deps.timeoutMs ?? PHOTOROOM_TIMEOUT_MS)});
    return {response, ms: Date.now() - started};
  } catch (error) {
    // The message may carry the request, so it is not kept. A timeout may have been billed (the vendor can finish the
    // image after we stop waiting), so it is priced; a refused connection never reached the vendor.
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {failure: {kind: timedOut ? "timeout" : "no_response", status: 0}};
  }
}

/**
 * Background removal of one image (`png`, lossless, at most PHOTOROOM_MAX_SIDE on its long side). The answer must be a
 * mask of exactly the sent size, else the route failed (`wrong_size`, M7-F2-R3). `costUsd` is the route's list price
 * for an answered call (Photoroom bills per successful image); a failed call is free.
 */
export async function photoroomMatte(png: Buffer, size: {width: number; height: number}, priceUsd: number, deps: PhotoroomDeps = {}): Promise<RouteAttempt<VendorMask>> {
  const form = new FormData();
  form.set("image_file", new Blob([new Uint8Array(png)], {type: "image/png"}), "source.png");
  form.set("channels", "alpha");
  form.set("format", "png");
  form.set("size", "full");
  const sent = await post(PHOTOROOM_SEGMENT_URL, form, deps);
  if ("failure" in sent) return unanswered(sent.failure, priceUsd);
  if (!sent.response.ok) return {value: null, failure: photoroomFailure(sent.response.status), costUsd: 0, calls: 1};
  const bytes = Buffer.from(await sent.response.arrayBuffer());
  if (!bytes.length) return {value: null, failure: {kind: "empty_reply", status: sent.response.status}, costUsd: 0, calls: 1};
  try {
    const {data, info} = await sharp(bytes).toColourspace("b-w").removeAlpha().raw().toBuffer({resolveWithObject: true});
    if (info.width !== size.width || info.height !== size.height) return {value: null, failure: {kind: "wrong_size", status: sent.response.status}, costUsd: priceUsd, calls: 1};
    return {value: {alpha: data, width: info.width, height: info.height, ms: sent.ms}, failure: null, costUsd: priceUsd, calls: 1};
  } catch {
    return {value: null, failure: {kind: "wrong_size", status: sent.response.status}, costUsd: priceUsd, calls: 1};
  }
}

/**
 * AI upscale of one image by PHOTOROOM_UPSCALE_FACTOR, then (for a 2x request) a Lanczos downscale to exactly 2x; the
 * output is never sharpened (M3-F2-R2). The vendor's answer must be the factor times the input within 2 px on each
 * side, else `wrong_size`.
 */
export async function photoroomUpscale(image: Buffer, factor: 2 | 4, priceUsd: number, deps: PhotoroomDeps = {}): Promise<RouteAttempt<VendorUpscale>> {
  const input = await sharp(image).metadata();
  if (!input.width || !input.height) return {value: null, failure: {kind: "http", status: null}, costUsd: 0, calls: 0};
  const form = new FormData();
  form.set("imageFile", new Blob([new Uint8Array(image)]), "source");
  form.set("referenceBox", "originalImage");
  form.set("removeBackground", "false");
  form.set("upscale.mode", "ai.fast");
  const sent = await post(PHOTOROOM_EDIT_URL, form, deps);
  if ("failure" in sent) return unanswered(sent.failure, priceUsd);
  if (!sent.response.ok) return {value: null, failure: photoroomFailure(sent.response.status), costUsd: 0, calls: 1};
  const bytes = Buffer.from(await sent.response.arrayBuffer());
  if (!bytes.length) return {value: null, failure: {kind: "empty_reply", status: sent.response.status}, costUsd: 0, calls: 1};
  const made = await sharp(bytes).metadata().catch(() => null);
  const want = {width: input.width * PHOTOROOM_UPSCALE_FACTOR, height: input.height * PHOTOROOM_UPSCALE_FACTOR};
  if (!made?.width || !made.height || Math.abs(made.width - want.width) > 2 || Math.abs(made.height - want.height) > 2) return {value: null, failure: {kind: "wrong_size", status: sent.response.status}, costUsd: priceUsd, calls: 1};
  const target = {width: input.width * factor, height: input.height * factor};
  const out = made.width === target.width && made.height === target.height ? bytes : await sharp(bytes).resize(target.width, target.height, {fit: "fill", kernel: "lanczos3"}).png().toBuffer();
  return {value: {image: out, ...target, ms: sent.ms}, failure: null, costUsd: priceUsd, calls: 1};
}

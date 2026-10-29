import sharp from "sharp";
import type { Size } from "./channels";
import type { Matte, Prepared } from "./render";
import { BG_TOLERANCE } from "./compliance";
import { gpuUrlsFromEnv, UPSCALE_RETRY_DELAY_MS, UPSCALE_TIMEOUT_MS } from "./upscale";
import { log } from "../log";
import { bearerFor, googleIdTokenFor, raceAbort, type IdTokenFor } from "../id-token";

export interface MattingService { baseUrl: string; target: "cpu" | "gpu" }
/**
 * Ids of the batch and product one call works for, sent as the `x-catalog-batch` and `x-catalog-product`
 * headers so the matting service's log lines carry them. Per call, because the worker shares one client.
 */
export interface MattingTrace { batchId?: string | undefined; productId?: string | undefined }
export const TRACE_HEADERS = { batchId: "x-catalog-batch", productId: "x-catalog-product" } as const;
export function setTraceHeaders(headers: Headers, trace: MattingTrace | undefined): void {
  if (trace?.batchId) headers.set(TRACE_HEADERS.batchId, trace.batchId);
  if (trace?.productId) headers.set(TRACE_HEADERS.productId, trace.productId);
}
export interface ModelInfo { id: string; inputSize: number | "native"; target: "cpu" | "gpu" }
/** One upscaler the GPU service lists in /health (`upscale.models`); `scale` is its fixed factor. */
export interface UpscaleModelInfo { id: string; available: boolean; scale: number }
/** The /health `upscale` section: absent on a service without /upscale (the CPU service). */
export interface UpscaleHealth { models: UpscaleModelInfo[]; default: string | null }
export interface MattingClientOptions {
  services: MattingService[]; fetch?: typeof fetch; idToken?: IdTokenFor;
  model?: string; timeoutMs?: number;
  /**
   * Spec 16 3.1.3: the base URL of the service that answers /upscale. Absent reads `UPSCALE_URL` from the
   * environment; unset or empty keeps the first GPU service (spec 11). Spec 18 H2: an URL that matches none of
   * `services` is the dedicated CPU upscale service catalog-upscale. This client never calls it (no /health, no
   * breaker): its upscaleTarget is "cpu" (the `+cpu` render keys) and upscale() refuses, because the enlarge stage
   * (enlarge.ts, spec 18 H3) serves it. infra/lib/shape.sh refuses UPSCALE_SERVICE=dedicated until H3 sets
   * ENLARGE_CLIENT_WIRED=1.
   */
  upscaleUrl?: string | null;
  /** Spec 16 3.1.5: cut-out calls in flight per GPU service from this process (default MATTE_INFLIGHT_PER_INSTANCE). */
  inflightPerService?: number;
  /** Waits between busy (429) answers; tests pass an instant one. */
  sleep?: (ms: number) => Promise<void>;
}
/**
 * The model ids the matting services serve: services/matting/app.py `INPUT_SIZES`, which is also
 * the `MATTE_MODELS` default (a test keeps the two in step). Built-in policies name only these.
 */
export const DEPLOYED_MATTE_MODELS: readonly string[] = ["birefnet-general", "birefnet-general-lite", "birefnet-hrsod", "bria-rmbg"];
export const BREAKER_FAILURES =Number(process.env.MATTING_BREAKER_FAILURES ?? 5);
export const BREAKER_COOLDOWN_MS = Number(process.env.MATTING_BREAKER_COOLDOWN_MS ?? 60_000);
// Allow measured 64-second CPU readiness plus startup headroom, below Cloud Run's 300 seconds.
export const MATTING_TIMEOUT_MS = Number(process.env.MATTING_TIMEOUT_MS ?? 180_000);
const positiveInt = (raw: string | undefined, fallback: number): number => { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : fallback; };
/**
 * Spec 16 3.1.5: cut-out calls one worker process keeps in flight per GPU service; extra calls wait in the client
 * instead of meeting Cloud Run's 429 when every GPU instance is busy.
 */
export const MATTE_INFLIGHT_PER_INSTANCE = positiveInt(process.env.MATTE_INFLIGHT_PER_INSTANCE, 4);
/** Busy (429) answers from the GPU services in a row for one photo before one breaker failure and the CPU service. */
export const MATTE_BUSY_TRIES = 3;
/** The wait after a busy answer: 1 to 3 s with jitter, so parallel callers do not retry in step. */
export const busyWaitMs = (random: number = Math.random()): number => 1000 + Math.round(random * 2000);
// Discovery is refreshed once a minute, independently for each service.
export const HEALTH_TTL_MS = 60_000;
export const FLOODFILL_TOLERANCE = 24;
// Border seeds use the tighter tolerance; propagation permits compression noise.
const SEED_TOLERANCE = BG_TOLERANCE;
type Breaker = { state: "closed" | "open" | "half-open"; failures: number; openedAt: number | null };
/** The failing call behind a breaker failure: its model (absent for /health) and HTTP status (null without one). */
interface FailureCause { model?: string; status: number | null }
/**
 * `modelFailures`: spec 17 3.3.5, failed cut-out calls in a row per model on this service, so a model that always
 * fails is seen while another model keeps the service's breaker closed. Counting only: the breaker decides.
 */
interface ServiceState extends MattingService { breaker: Breaker; modelFailures: Map<string, number>; models: ModelInfo[]; default: string; version: string | null; checkedAt: number; upscale: UpscaleHealth | null; inflight: number; waiters: (() => void)[] }
const failureStatus = (err: unknown): number | null => (err instanceof UnavailableError && err.status !== undefined ? err.status : null);
/** The `upscale` section of a /health body, or null when absent or malformed (a malformed section never fails matting). */
export function parseUpscaleHealth(value: unknown): UpscaleHealth | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { models?: unknown; default?: unknown };
  if (!Array.isArray(v.models)) return null;
  const valid = (m: unknown): m is UpscaleModelInfo => {
    const x = m as Partial<UpscaleModelInfo> | null;
    return !!x && typeof x === "object" && typeof x.id === "string" && !!x.id && typeof x.available === "boolean" && Number.isInteger(x.scale) && x.scale! > 1;
  };
  return { models: v.models.filter(valid).map(m => ({ id: m.id, available: m.available, scale: m.scale })), default: typeof v.default === "string" && v.default ? v.default : null };
}
function modelSendLongSide(inputSize: ModelInfo["inputSize"], source: Size): number {
  return inputSize === "native" ? Math.max(256, Math.min(2304, Math.round(Math.max(source.w, source.h) / 32) * 32)) : inputSize;
}
export interface MatteOptions { padFraction?: number }
class UnavailableError extends Error { constructor(message: string, readonly status?: number) { super(message); } }
/** The upscaler could not be used (not listed as available, breaker open, 503 twice, timeout, bad request); the render falls back to Lanczos. */
export class UpscaleUnavailableError extends Error {}
export interface UpscaleOptions { model: string; contentType: "image/png" | "image/jpeg"; timeoutMs?: number; retryDelayMs?: number; sleep?: (ms: number) => Promise<void> }
export class UnknownMatteModelError extends Error {}

export class MattingClient {
  private readonly states: ServiceState[];
  private readonly request: typeof fetch;
  private readonly token: IdTokenFor;
  /** The service /upscale goes to (spec 16 3.1.3); null without a GPU service and without a matching UPSCALE_URL. */
  private readonly upscaleState: ServiceState | null;
  /** Spec 18 H2: UPSCALE_URL names no matting service, so it is catalog-upscale, which only the enlarge stage calls. */
  private readonly dedicatedUpscale: boolean;
  private readonly inflightLimit: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Round-robin position over the GPU services. */
  private turn = 0;
  constructor(private readonly opts: MattingClientOptions) {
    if (opts.services.filter((s) => s.target === "cpu").length !== 1) throw new Error("MATTING_URL is required for background removal, and only one CPU matting service is supported.");
    const urls = opts.services.map((s) => normaliseUrl(s.baseUrl));
    if (new Set(urls).size !== urls.length) throw new Error("Each matting service URL may be listed once.");
    this.states = opts.services.map((s) => ({ ...s, baseUrl: normaliseUrl(s.baseUrl), breaker: { state: "closed", failures: 0, openedAt: null }, modelFailures: new Map(), models: [], default: "", version: null, checkedAt: -Infinity, upscale: null, inflight: 0, waiters: [] }));
    const upscaleUrl = normaliseUrl((opts.upscaleUrl === undefined ? process.env.UPSCALE_URL : opts.upscaleUrl) ?? "");
    const firstGpu = this.states.find((s) => s.target === "gpu") ?? null;
    const named = upscaleUrl ? this.states.find((s) => s.baseUrl === upscaleUrl) ?? null : null;
    // Spec 18 H2: an URL that is no matting service is the dedicated CPU upscale service (catalog-upscale). It joins
    // neither health() (which every matte() awaits, so a slow catalog-upscale would delay every cut-out) nor any
    // breaker; the enlarge stage calls it (enlarge.ts).
    this.dedicatedUpscale = Boolean(upscaleUrl && !named);
    this.upscaleState = named ?? (this.dedicatedUpscale ? null : firstGpu);
    this.inflightLimit = opts.inflightPerService ?? MATTE_INFLIGHT_PER_INSTANCE;
    this.sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.request = opts.fetch ?? fetch;
    this.token = opts.idToken ?? googleIdTokenFor();
  }
  /** Compatibility view is the required CPU breaker; use breakers for both targets. */
  get breaker(): Breaker { return this.states.find((s) => s.target === "cpu")!.breaker; }
  /**
   * Spec 11 assumption 9: the upscaler's own breaker. Upscale failures never touch the matting breakers; after
   * BREAKER_FAILURES consecutive failures the upscaler is skipped for BREAKER_COOLDOWN_MS, closed again by a success.
   */
  readonly upscaleBreaker: { failures: number; openedAt: number | null } = { failures: 0, openedAt: null };
  private upscaleAvailable(): boolean {
    const b = this.upscaleBreaker;
    if (b.openedAt !== null && Date.now() - b.openedAt >= BREAKER_COOLDOWN_MS) { b.openedAt = null; b.failures = BREAKER_FAILURES - 1; }
    return b.openedAt === null;
  }
  private upscaleFailure(): void {
    const b = this.upscaleBreaker;
    b.failures++;
    if (b.failures >= BREAKER_FAILURES) b.openedAt = Date.now();
  }
  /** The first service of each target; with several GPU services see `gpuBreakers`. */
  get breakers(): Partial<Record<"cpu" | "gpu", Breaker>> { return Object.fromEntries([...this.states].reverse().map((s) => [s.target, s.breaker])); }
  /** Every GPU service's breaker, in the configured order. */
  get gpuBreakers(): Breaker[] { return this.states.filter((s) => s.target === "gpu").map((s) => s.breaker); }
  /** Spec 17 3.3.5: failed cut-out calls in a row per (service, model), in the configured service order. */
  get modelFailures(): { service: "cpu" | "gpu"; model: string; failures: number }[] {
    return this.states.flatMap((s) => [...s.modelFailures].map(([model, failures]) => ({ service: s.target, model, failures })));
  }
  /** The service /upscale goes to: "cpu" when UPSCALE_URL names the CPU cut-out service or catalog-upscale, otherwise "gpu". */
  get upscaleTarget(): "cpu" | "gpu" { return this.dedicatedUpscale ? "cpu" : this.upscaleState?.target ?? "gpu"; }
  /** Waits for a free in-flight place on a GPU service (spec 16 3.1.5); the CPU service is not limited here. */
  private async acquire(s: ServiceState): Promise<() => void> {
    const limit = s.target === "gpu" ? this.inflightLimit : Infinity;
    while (s.inflight >= limit) await new Promise<void>((resolve) => s.waiters.push(resolve));
    s.inflight++;
    return () => { s.inflight--; s.waiters.shift()?.(); };
  }
  /** `cause`: the call that opened the breaker; its model and status join the line (spec 17 3.3.5). */
  private transition(s: ServiceState, state: Breaker["state"], cause?: FailureCause): void {
    if (s.breaker.state === state) return;
    s.breaker.state = state;
    // Process-wide (the worker shares one client), so the line names no batch.
    log(state === "open" ? "WARNING" : "INFO", "matting_breaker", { service: s.target, state, ...(cause && { model: cause.model, status: cause.status }) });
  }
  private available(s: ServiceState): boolean {
    if (s.breaker.state === "open" && Date.now() - s.breaker.openedAt! >= BREAKER_COOLDOWN_MS) this.transition(s, "half-open");
    return s.breaker.state !== "open";
  }
  private failure(s: ServiceState, err: unknown, model?: string): void {
    const cause: FailureCause = { model, status: failureStatus(err) };
    if (cause.model) {
      const failures = (s.modelFailures.get(cause.model) ?? 0) + 1;
      s.modelFailures.set(cause.model, failures);
      // Seen once per run of failures, also while other models keep the service's breaker closed.
      if (failures === BREAKER_FAILURES) log("WARNING", "matting_model_failing", { service: s.target, model: cause.model, status: cause.status, failures });
    }
    s.breaker.failures++;
    if (s.breaker.failures >= BREAKER_FAILURES || s.breaker.state === "half-open") {
      s.breaker.openedAt = Date.now(); this.transition(s, "open", cause);
    }
  }
  private async call(s: ServiceState, endpoint: string, init: RequestInit = {}, timeoutMs = this.opts.timeoutMs ?? MATTING_TIMEOUT_MS, trace?: MattingTrace): Promise<Response> {
    const signal = AbortSignal.timeout(timeoutMs);
    const headers = new Headers(init.headers);
    setTraceHeaders(headers, trace);
    const bearer = await raceAbort(bearerFor(s.baseUrl, this.token), signal);
    if (bearer) {
      signal.throwIfAborted();
      headers.set("Authorization", bearer);
    }
    const response = await this.request(`${s.baseUrl}${endpoint}`, { ...init, headers, signal });
    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) throw new UnavailableError(`Background removal service returned ${response.status}.`, response.status);
      throw new Error(`Background removal request rejected (${response.status}).`);
    }
    return response;
  }
  /** `upscale` is the GPU service's /health `upscale` section (null without a GPU service or without the section). */
  async health(): Promise<{ ok: boolean; models: ModelInfo[]; default: string; versions: Record<"cpu" | "gpu", string | null>; upscale?: UpscaleHealth | null }> {
    await Promise.all(this.states.map(async (s) => {
      if (Date.now() - s.checkedAt < HEALTH_TTL_MS || !this.available(s)) return;
      try {
        const h = await (await this.call(s, "/health")).json() as { ok: boolean; models: ModelInfo[]; default: string; version: string; upscale?: unknown };
        if (!h.ok || !Array.isArray(h.models) || h.models.some((m) => !m.id || m.target !== s.target || (m.inputSize !== "native" && (!Number.isInteger(m.inputSize) || m.inputSize <= 0)))) throw new Error("Invalid matting health response.");
        s.models = h.models; s.default = h.default; s.version = h.version; s.upscale = parseUpscaleHealth(h.upscale); s.checkedAt = Date.now();
      } catch (err) { this.failure(s, err); }
    }));
    // Several GPU services serve the same models; each model id is listed once.
    const models = this.states.flatMap((s) => s.models).filter((m, i, all) => all.findIndex((x) => x.id === m.id && x.target === m.target) === i);
    return { ok: this.states.some((s) => s.models.length > 0), models, default: this.states.find((s) => s.target === "cpu")!.default, versions: { cpu: this.states.find((s) => s.target === "cpu")?.version ?? null, gpu: this.states.find((s) => s.target === "gpu" && s.version)?.version ?? null }, upscale: this.upscaleState?.upscale ?? null };
  }
  /**
   * POST /upscale?model=<id>&scale=2 on the upscale service (spec 11; spec 16 3.1.3: the GPU service, or the CPU
   * cut-out service when UPSCALE_URL names it, which serves /upscale with UPSCALE_CPU=1): the body is the image
   * bytes, the answer a JPEG of exactly twice the size. Only a model that service's /health lists as available at
   * scale 2 is asked for. Same auth, base URL as matting: an open matting breaker of that service or an open upscale breaker skips the call, one retry follows a
   * 503 after `retryDelayMs`, and only a final failure of the service (not a rejected request, 400 or 413)
   * counts, once, towards the upscale breaker (never the matting one). Throws UpscaleUnavailableError; the render
   * then uses Lanczos.
   */
  async upscale(image: Buffer, opts: UpscaleOptions, trace?: MattingTrace): Promise<{ jpeg: Buffer; ms: number; model: string }> {
    if (this.dedicatedUpscale) throw new UpscaleUnavailableError("Enlargement on catalog-upscale is served by the enlarge stage, not the matting client.");
    const s = this.upscaleState;
    if (!s) throw new UpscaleUnavailableError("No matting service is configured for upscaling.");
    const h = await this.health();
    if (!h.upscale?.models.some((m) => m.id === opts.model && m.available && m.scale === 2)) throw new UpscaleUnavailableError(`The ${s.target.toUpperCase()} service does not list this upscaler as available.`);
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.available(s) || !this.upscaleAvailable()) throw new UpscaleUnavailableError(`The ${s.target.toUpperCase()} service is paused after repeated failures.`);
      const started = Date.now();
      try {
        const response = await this.call(s, `/upscale?model=${encodeURIComponent(opts.model)}&scale=2`, { method: "POST", body: new Uint8Array(image), headers: { "content-type": opts.contentType } }, opts.timeoutMs ?? UPSCALE_TIMEOUT_MS, trace);
        const jpeg = Buffer.from(await response.arrayBuffer());
        const ms = Number(response.headers.get("x-upscale-ms"));
        this.upscaleBreaker.failures = 0; this.upscaleBreaker.openedAt = null;
        return { jpeg, ms: Number.isFinite(ms) && ms > 0 ? ms : Date.now() - started, model: response.headers.get("x-upscale-model") ?? opts.model };
      } catch (err) {
        last = err;
        if (attempt === 0 && err instanceof UnavailableError && err.status === 503) { await sleep(opts.retryDelayMs ?? UPSCALE_RETRY_DELAY_MS); continue; }
        break;
      }
    }
    if (!(last instanceof Error && /request rejected/.test(last.message))) this.upscaleFailure();
    throw new UpscaleUnavailableError(`Upscale failed: ${last instanceof Error ? last.message : String(last)}`);
  }
  sendLongSide(model: string, source: Size): number {
    const info = [...this.states].sort((a, b) => Number(b.target === "gpu") - Number(a.target === "gpu")).flatMap((s) => s.models).find((m) => m.id === model);
    if (!info) throw new UnknownMatteModelError(`Unknown background removal model: ${model}.`);
    return modelSendLongSide(info.inputSize, source);
  }
  /**
   * `opts.padFraction` surrounds the photo with a white border of that share of its long side before
   * sending, and crops the mask back: a frame-filling close-up then looks like a framed object, so a
   * salient-object model keeps the whole surface instead of only the logo on it (the cut-out
   * integrity ladder in matte-guard.ts).
   */
  async matte(prepared: Prepared, model?: string, opts: MatteOptions = {}, trace?: MattingTrace): Promise<Matte> {
    const h = await this.health();
    const chosen = model ?? this.opts.model ?? h.default;
    if (!chosen) throw new UnavailableError("The CPU background removal service's default model is unavailable.");
    const candidates = this.states.filter((s) => s.models.some((m) => m.id === chosen)).sort((a, b) => Number(b.target === "gpu") - Number(a.target === "gpu"));
    if (!candidates.length) {
      if (!h.ok) throw new UnavailableError("Background removal services are unavailable.");
      throw new UnknownMatteModelError(`Unknown background removal model: ${chosen}.`);
    }
    // Spec 16 3.1.5: the GPU services in turn (round robin), each call within the in-flight limit. A busy answer
    // (429: every instance of that service is working) waits 1 to 3 s and tries the next GPU service; only
    // MATTE_BUSY_TRIES busy answers in a row count one breaker failure and hand the photo to the CPU service. Any
    // other failure counts at once and moves on, as before.
    const gpus = candidates.filter((s) => s.target === "gpu"), cpus = candidates.filter((s) => s.target === "cpu");
    const start = gpus.length ? this.turn++ % gpus.length : 0;
    const order = [...gpus.slice(start), ...gpus.slice(0, start)];
    const failed = new Set<ServiceState>();
    let busy = 0, next = 0;
    for (;;) {
      const live = order.filter((s) => !failed.has(s) && this.available(s));
      if (!live.length) break;
      const s = live[next++ % live.length]!;
      try { return await this.matteOn(s, prepared, chosen, opts, trace); }
      catch (err) {
        if (err instanceof Error && /request rejected/.test(err.message)) throw err;
        if (err instanceof UnavailableError && err.status === 429 && ++busy < MATTE_BUSY_TRIES) { await this.sleep(busyWaitMs()); continue; }
        this.failure(s, err, chosen); failed.add(s);
        if (busy >= MATTE_BUSY_TRIES) break;
      }
    }
    for (const s of cpus) {
      if (!this.available(s)) continue;
      try { return await this.matteOn(s, prepared, chosen, opts, trace); }
      catch (err) {
        if (err instanceof Error && /request rejected/.test(err.message)) throw err;
        this.failure(s, err, chosen);
      }
    }
    throw new UnavailableError("Background removal services are unavailable.");
  }
  /** One cut-out call on one service; throws on any failure (the caller counts it). */
  private async matteOn(s: ServiceState, prepared: Prepared, chosen: string, opts: MatteOptions, trace: MattingTrace | undefined): Promise<Matte> {
    const info = s.models.find((m) => m.id === chosen)!;
    const pad = Math.round(Math.max(prepared.width, prepared.height) * Math.max(0, opts.padFraction ?? 0));
    const framed = { w: prepared.width + 2 * pad, h: prepared.height + 2 * pad };
    const sentLongSide = modelSendLongSide(info.inputSize, framed);
    const raw = sharp(prepared.rgb, { raw: { width: prepared.width, height: prepared.height, channels: 3 } });
    const source = pad ? sharp(await raw.extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 255, g: 255, b: 255 } }).png().toBuffer()) : raw;
    const png = await source.resize(sentLongSide, sentLongSide, { fit: "inside", kernel: "lanczos3" }).png().toBuffer();
    const body = new FormData(); body.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "source.png");
    const release = await this.acquire(s);
    let response: Response, maskPng: Buffer;
    try {
      response = await this.call(s, `/matte?model=${encodeURIComponent(chosen)}`, { method: "POST", body }, undefined, trace);
      maskPng = Buffer.from(await response.arrayBuffer());
    } finally { release(); }
    const mask = await alphaFromPng(maskPng);
    const upscaled = sharp(mask.alpha, { raw: { width: mask.width, height: mask.height, channels: 1 } }).resize(framed.w, framed.h, { fit: "fill", kernel: "lanczos3" });
    const fitted = pad ? sharp(await upscaled.extract({ left: pad, top: pad, width: prepared.width, height: prepared.height }).toColourspace("b-w").raw().toBuffer(), { raw: { width: prepared.width, height: prepared.height, channels: 1 } }) : upscaled;
    const alpha = await fitted.blur(1).toColourspace("b-w").raw().toBuffer();
    s.breaker.failures = 0; s.breaker.openedAt = null; s.modelFailures.delete(chosen); this.transition(s, "closed");
    return { alpha, width: prepared.width, height: prepared.height, model: chosen, ms: Number(response.headers.get("x-ms") ?? 0), source: "model", target: s.target, sentLongSide };
  }  async convert(buf: Buffer, trace?: MattingTrace): Promise<Buffer> {
    const body = new FormData(); body.set("file", new Blob([new Uint8Array(buf)]), "source.heic");
    return Buffer.from(await (await this.call(this.states.find((s) => s.target === "cpu")!, "/convert", { method: "POST", body }, undefined, trace)).arrayBuffer());
  }
}

const normaliseUrl = (url: string): string => url.trim().replace(/\/+$/, "");

/**
 * The worker's client from its environment (spec 16 3.1.5): `MATTING_URL` (the CPU service, required; local default
 * http://localhost:8081), `MATTING_GPU_URLS` (comma list) or else the single `MATTING_GPU_URL`, `UPSCALE_URL` and
 * `MATTE_INFLIGHT_PER_INSTANCE`.
 */
export function mattingClientFromEnv(env: NodeJS.ProcessEnv = process.env, extra: Omit<MattingClientOptions, "services" | "upscaleUrl" | "inflightPerService"> = {}): MattingClient {
  const services: MattingService[] = [{ baseUrl: env.MATTING_URL?.trim() || "http://localhost:8081", target: "cpu" }, ...gpuUrlsFromEnv(env).map((baseUrl) => ({ baseUrl, target: "gpu" as const }))];
  return new MattingClient({ ...extra, services, upscaleUrl: env.UPSCALE_URL ?? null, inflightPerService: positiveInt(env.MATTE_INFLIGHT_PER_INSTANCE, 4) });
}

export async function alphaFromPng(png: Buffer): Promise<{ alpha: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).toColourspace("b-w").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { alpha: data, width: info.width, height: info.height };
}

export function floodFillMatte(p: Prepared): Matte {
  if (!p.background.uniform) throw new UnavailableError("Background removal was unavailable and this photo's background is not plain. Start the batch again later, or replace the photo.");
  const { width: w, height: h, rgb } = p;
  const alpha = Buffer.alloc(w * h, 255);
  const queue = new Int32Array(w * h); let head = 0, tail = 0;
  const near = (i: number, tolerance: number) => p.background.color.every((c, k) => Math.abs(rgb[i * 3 + k]! - c) <= tolerance);
  const add = (i: number, tolerance: number) => { if (alpha[i] && near(i, tolerance)) { alpha[i] = 0; queue[tail++] = i; } };
  for (let x = 0; x < w; x++) { add(x, SEED_TOLERANCE); add((h - 1) * w + x, SEED_TOLERANCE); }
  for (let y = 0; y < h; y++) { add(y * w, SEED_TOLERANCE); add(y * w + w - 1, SEED_TOLERANCE); }
  while (head < tail) {
    const i = queue[head++]!, x = i % w, y = Math.floor(i / w);
    if (x) add(i - 1, FLOODFILL_TOLERANCE); if (x + 1 < w) add(i + 1, FLOODFILL_TOLERANCE);
    if (y) add(i - w, FLOODFILL_TOLERANCE); if (y + 1 < h) add(i + w, FLOODFILL_TOLERANCE);
  }
  // Separable sigma-one Gaussian preserves the synchronous public contract.
  const weights = [0.004433, 0.054006, 0.242036, 0.39905, 0.242036, 0.054006, 0.004433];
  const temp = new Float32Array(w * h), blurred = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = -3; k <= 3; k++) temp[y * w + x]! += alpha[y * w + Math.max(0, Math.min(w - 1, x + k))]! * weights[k + 3]!;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let sum = 0; for (let k = -3; k <= 3; k++) sum += temp[Math.max(0, Math.min(h - 1, y + k)) * w + x]! * weights[k + 3]!; blurred[y * w + x] = Math.round(sum); }
  return { alpha: blurred, width: w, height: h, model: "floodfill", ms: 0, source: "floodfill", target: null, sentLongSide: null };
}

export async function matteFor(prepared: Prepared, client: MattingClient | null, model?: string, opts: MatteOptions = {}, trace?: MattingTrace): Promise<Matte> {
  if (prepared.alphaSource) return { alpha: prepared.alphaSource, width: prepared.width, height: prepared.height, model: "alpha_source", ms: 0, source: "alpha_source", target: null, sentLongSide: null };
  if (!client) return floodFillMatte(prepared);
  try { return await client.matte(prepared, model, opts, trace); } catch (err) { if (!(err instanceof UnavailableError)) throw err; return floodFillMatte(prepared); }
}

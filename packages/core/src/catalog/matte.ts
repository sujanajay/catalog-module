import sharp from "sharp";
import { GoogleAuth } from "google-auth-library";
import type { Size } from "./channels";
import type { Matte, Prepared } from "./render";
import { BG_TOLERANCE } from "./compliance";

export interface MattingService { baseUrl: string; target: "cpu" | "gpu" }
export interface ModelInfo { id: string; inputSize: number | "native"; target: "cpu" | "gpu" }
export interface MattingClientOptions {
  services: MattingService[]; fetch?: typeof fetch; idToken?: (audience: string) => Promise<string>;
  model?: string; timeoutMs?: number; batchId?: string;
}
export const BREAKER_FAILURES = Number(process.env.MATTING_BREAKER_FAILURES ?? 5);
export const BREAKER_COOLDOWN_MS = Number(process.env.MATTING_BREAKER_COOLDOWN_MS ?? 60_000);
export const MATTING_TIMEOUT_MS = Number(process.env.MATTING_TIMEOUT_MS ?? 60_000);
// Discovery is refreshed once a minute, independently for each service.
export const HEALTH_TTL_MS = 60_000;
export const FLOODFILL_TOLERANCE = 24;
// Border seeds use the tighter tolerance; propagation permits compression noise.
const SEED_TOLERANCE = BG_TOLERANCE;
type Breaker = { state: "closed" | "open" | "half-open"; failures: number; openedAt: number | null };
interface ServiceState extends MattingService { breaker: Breaker; models: ModelInfo[]; default: string; version: string | null; checkedAt: number }
class UnavailableError extends Error {}
export class UnknownMatteModelError extends Error {}

export class MattingClient {
  private readonly states: ServiceState[];
  private readonly request: typeof fetch;
  private readonly token: (audience: string) => Promise<string>;
  constructor(private readonly opts: MattingClientOptions) {
    if (!opts.services.some((s) => s.target === "cpu")) throw new Error("MATTING_URL is required for background removal.");
    if (new Set(opts.services.map((s) => s.target)).size !== opts.services.length) throw new Error("Only one matting service per target is supported.");
    this.states = opts.services.map((s) => ({ ...s, baseUrl: s.baseUrl.replace(/\/$/, ""), breaker: { state: "closed", failures: 0, openedAt: null }, models: [], default: "", version: null, checkedAt: -Infinity }));
    this.request = opts.fetch ?? fetch;
    const auth = new GoogleAuth();
    this.token = opts.idToken ?? (async (audience) => {
      const client = await auth.getIdTokenClient(audience);
      return client.idTokenProvider.fetchIdToken(audience);
    });
  }
  /** Compatibility view is the required CPU breaker; use breakers for both targets. */
  get breaker(): Breaker { return this.states.find((s) => s.target === "cpu")!.breaker; }
  get breakers(): Partial<Record<"cpu" | "gpu", Breaker>> { return Object.fromEntries(this.states.map((s) => [s.target, s.breaker])); }
  private transition(s: ServiceState, state: Breaker["state"]): void {
    if (s.breaker.state === state) return;
    s.breaker.state = state;
    console.info(JSON.stringify({ event: "matting_breaker", batchId: this.opts.batchId ?? "local", service: s.target, state }));
  }
  private available(s: ServiceState): boolean {
    if (s.breaker.state === "open" && Date.now() - s.breaker.openedAt! >= BREAKER_COOLDOWN_MS) this.transition(s, "half-open");
    return s.breaker.state !== "open";
  }
  private failure(s: ServiceState): void {
    s.breaker.failures++;
    if (s.breaker.failures >= BREAKER_FAILURES || s.breaker.state === "half-open") {
      s.breaker.openedAt = Date.now(); this.transition(s, "open");
    }
  }
  private async call(s: ServiceState, endpoint: string, init: RequestInit = {}): Promise<Response> {
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? MATTING_TIMEOUT_MS);
    const url = new URL(s.baseUrl);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const headers = new Headers(init.headers);
    if (!local) headers.set("Authorization", `Bearer ${await this.token(s.baseUrl)}`);
    const response = await this.request(`${s.baseUrl}${endpoint}`, { ...init, headers, signal });
    if (!response.ok) {
      if (response.status >= 500 || response.status === 429) throw new UnavailableError(`Background removal service returned ${response.status}.`);
      throw new Error(`Background removal request rejected (${response.status}).`);
    }
    return response;
  }
  async health(): Promise<{ ok: boolean; models: ModelInfo[]; default: string; versions: Record<"cpu" | "gpu", string | null> }> {
    await Promise.all(this.states.map(async (s) => {
      if (Date.now() - s.checkedAt < HEALTH_TTL_MS || !this.available(s)) return;
      try {
        const h = await (await this.call(s, "/health")).json() as { ok: boolean; models: ModelInfo[]; default: string; version: string };
        if (!h.ok || !Array.isArray(h.models) || h.models.some((m) => !m.id || m.target !== s.target || (m.inputSize !== "native" && (!Number.isInteger(m.inputSize) || m.inputSize <= 0)))) throw new Error("Invalid matting health response.");
        s.models = h.models; s.default = h.default; s.version = h.version; s.checkedAt = Date.now();
      } catch { this.failure(s); }
    }));
    return { ok: this.states.some((s) => s.models.length > 0), models: this.states.flatMap((s) => s.models), default: this.states.find((s) => s.target === "cpu")!.default, versions: { cpu: this.states.find((s) => s.target === "cpu")?.version ?? null, gpu: this.states.find((s) => s.target === "gpu")?.version ?? null } };
  }
  sendLongSide(model: string, source: Size): number {
    const info = [...this.states].sort((a, b) => Number(b.target === "gpu") - Number(a.target === "gpu")).flatMap((s) => s.models).find((m) => m.id === model);
    if (!info) throw new UnknownMatteModelError(`Unknown background removal model: ${model}.`);
    return info.inputSize === "native" ? Math.max(256, Math.min(2304, Math.round(Math.max(source.w, source.h) / 32) * 32)) : info.inputSize;
  }
  async matte(prepared: Prepared, model?: string): Promise<Matte> {
    const h = await this.health();
    const chosen = model ?? this.opts.model ?? h.default;
    if (!chosen) throw new UnavailableError("The CPU background removal service's default model is unavailable.");
    const candidates = this.states.filter((s) => s.models.some((m) => m.id === chosen)).sort((a, b) => Number(b.target === "gpu") - Number(a.target === "gpu"));
    if (!candidates.length) {
      if (!h.ok) throw new UnavailableError("Background removal services are unavailable.");
      throw new UnknownMatteModelError(`Unknown background removal model: ${chosen}.`);
    }
    for (const s of candidates) {
      if (!this.available(s)) continue;
      const info = s.models.find((m) => m.id === chosen)!;
      const sentLongSide = info.inputSize === "native" ? Math.max(256, Math.min(2304, Math.round(Math.max(prepared.width, prepared.height) / 32) * 32)) : info.inputSize;
      const png = await sharp(prepared.rgb, { raw: { width: prepared.width, height: prepared.height, channels: 3 } }).resize(sentLongSide, sentLongSide, { fit: "inside", kernel: "lanczos3" }).png().toBuffer();
      const body = new FormData(); body.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "source.png");
      try {
        const response = await this.call(s, `/matte?model=${encodeURIComponent(chosen)}`, { method: "POST", body });
        const mask = await alphaFromPng(Buffer.from(await response.arrayBuffer()));
        const alpha = await sharp(mask.alpha, { raw: { width: mask.width, height: mask.height, channels: 1 } }).resize(prepared.width, prepared.height, { fit: "fill", kernel: "lanczos3" }).blur(1).toColourspace("b-w").raw().toBuffer();
        s.breaker.failures = 0; s.breaker.openedAt = null; this.transition(s, "closed");
        return { alpha, width: prepared.width, height: prepared.height, model: chosen, ms: Number(response.headers.get("x-ms") ?? 0), source: "model", target: s.target, sentLongSide };
      } catch (err) {
        if (err instanceof Error && /request rejected/.test(err.message)) throw err;
        this.failure(s);
      }
    }
    throw new UnavailableError("Background removal services are unavailable.");
  }
  async convert(buf: Buffer): Promise<Buffer> {
    const body = new FormData(); body.set("file", new Blob([new Uint8Array(buf)]), "source.heic");
    return Buffer.from(await (await this.call(this.states.find((s) => s.target === "cpu")!, "/convert", { method: "POST", body })).arrayBuffer());
  }
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

export async function matteFor(prepared: Prepared, client: MattingClient | null, model?: string): Promise<Matte> {
  if (prepared.alphaSource) return { alpha: prepared.alphaSource, width: prepared.width, height: prepared.height, model: "alpha_source", ms: 0, source: "alpha_source", target: null, sentLongSide: null };
  if (!client) return floodFillMatte(prepared);
  try { return await client.matte(prepared, model); } catch (err) { if (!(err instanceof UnavailableError)) throw err; return floodFillMatte(prepared); }
}

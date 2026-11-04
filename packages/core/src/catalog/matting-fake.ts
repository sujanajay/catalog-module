// Test support (M3-S5): an in-memory fetch for the CPU and GPU matting services and the overflow vendor, so the routed
// cut-out runs through the real MattingClient and the real Photoroom adapter without a network call or a paid call.
import sharp from "sharp";
import { MattingClient } from "./matte";
import { PHOTOROOM_SEGMENT_URL } from "../vendor/adapters/photoroom";

export const FAKE_CPU_URL = "http://127.0.0.1:18081";
export const FAKE_GPU_URL = "http://127.0.0.1:18082";
export interface FakeMattingState {
  /** A stopped service refuses connections (health and cut-outs). */
  down: {cpu: boolean; gpu: boolean};
  /** A busy service answers 429 to every cut-out (all its instances working); its health still answers. */
  busy: {cpu: boolean; gpu: boolean};
  /** The client's waits between busy answers (ms each). */
  sleeps: number[];
  /** Models that answer 500 on a service that is up (a broken model, not a stopped service). */
  failing: {cpu: Set<string>; gpu: Set<string>};
  /** Every cut-out asked, in order: `<target>:<model>` or `vendor`. */
  calls: string[];
  /** The vendor's answer: a mask of the sent size, a status, a mask of the wrong size, or no answer in time. */
  vendor: "ok" | "wrong_size" | "timeout" | number;
  /** The x-api-key headers the vendor saw (to prove the key is sent and only there). */
  vendorKeys: string[];
}
const refused = () => Promise.reject(new TypeError("fetch failed: connect ECONNREFUSED"));
async function maskPng(width: number, height: number): Promise<Buffer> {
  return sharp({create: {width, height, channels: 3, background: "white"}}).greyscale().png().toBuffer();
}

/** The fake fetch and its state; `models` are served by both services. */
export function fakeMatting(models: readonly string[] = ["birefnet-general", "birefnet-general-lite"]) {
  const state: FakeMattingState = {down: {cpu: false, gpu: false}, busy: {cpu: false, gpu: false}, sleeps: [], failing: {cpu: new Set(), gpu: new Set()}, calls: [], vendor: "ok", vendorKeys: []};
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === PHOTOROOM_SEGMENT_URL) {
      state.calls.push("vendor");
      state.vendorKeys.push(new Headers(init?.headers).get("x-api-key") ?? "");
      if (typeof state.vendor === "number") return new Response("{}", {status: state.vendor});
      if (state.vendor === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      const file = (init?.body as FormData).get("image_file") as File;
      const meta = await sharp(Buffer.from(await file.arrayBuffer())).metadata();
      const extra = state.vendor === "wrong_size" ? 7 : 0;
      return new Response(new Uint8Array(await maskPng(meta.width! + extra, meta.height!)), {headers: {"content-type": "image/png"}});
    }
    const target = url.startsWith(FAKE_GPU_URL) ? "gpu" : url.startsWith(FAKE_CPU_URL) ? "cpu" : null;
    if (!target) throw new Error(`fakeMatting: unexpected URL ${url}`);
    if (state.down[target]) return refused();
    const path = new URL(url).pathname;
    if (path === "/health") return Response.json({ok: true, models: models.map(id => ({id, inputSize: 64, target})), default: models[0], version: target});
    if (path === "/matte") {
      const model = new URL(url).searchParams.get("model") ?? "";
      state.calls.push(`${target}:${model}`);
      if (state.busy[target]) return new Response(null, {status: 429});
      if (state.failing[target].has(model)) return new Response(null, {status: 500});
      return new Response(new Uint8Array(await maskPng(64, 64)), {headers: {"x-ms": "12"}});
    }
    return new Response(null, {status: 404});
  }) as typeof globalThis.fetch;
  const client = new MattingClient({services: [{baseUrl: FAKE_CPU_URL, target: "cpu"}, {baseUrl: FAKE_GPU_URL, target: "gpu"}], fetch, upscaleUrl: null, sleep: async (ms: number) => { state.sleeps.push(ms); }});
  return {state, fetch, client};
}

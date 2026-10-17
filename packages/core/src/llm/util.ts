// Small helpers shared by the LLM calls: image parts, data URLs, cost and usage arithmetic.

export interface ImageRef {
  mime: string;
  data: Buffer;
}

export function toDataUrl(ref: ImageRef): string {
  return `data:${ref.mime};base64,${ref.data.toString("base64")}`;
}

/** Images as OpenRouter image_url parts, order preserved. */
export function refsToImageParts(refs: ImageRef[]): { type: "image_url"; image_url: { url: string } }[] {
  return refs.map((r) => ({ type: "image_url" as const, image_url: { url: toDataUrl(r) } }));
}

export function parseDataUrl(url: string): ImageRef | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?),(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const isB64 = /;base64/i.test(m[2] ?? "");
  const payload = m[3] ?? "";
  const data = isB64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  return { data, mime };
}

/** usage.cost when it is a finite number, otherwise null. */
export function readCost(usage: unknown): number | null {
  const c = (usage as { cost?: unknown } | null | undefined)?.cost;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

/** Sum numeric fields (one level deep) across usage objects. */
export function sumUsage(list: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const u of list) {
    for (const [k, v] of Object.entries(u)) {
      if (typeof v === "number") out[k] = ((out[k] as number | undefined) ?? 0) + v;
      else if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

/**
 * Deep-copy `raw` replacing base64 payloads (data URLs, b64_json) with a short placeholder so the
 * raw response can be stored in jsonb or logs without megabytes of image data.
 */
export function stripBase64(raw: unknown): unknown {
  if (typeof raw === "string") {
    if (raw.startsWith("data:") && raw.includes(";base64,")) {
      const head = raw.slice(0, raw.indexOf(",") + 1);
      return `${head}<${raw.length - head.length} chars omitted>`;
    }
    return raw;
  }
  if (Array.isArray(raw)) return raw.map(stripBase64);
  if (raw && typeof raw === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      out[k] = k === "b64_json" && typeof v === "string" ? `<${v.length} chars omitted>` : stripBase64(v);
    }
    return out;
  }
  return raw;
}

// Fault proxy rules (spec 09 section 4.2): pure matching, so the proxy itself stays a thin
// forwarder. A rule matches on method and a path regex and fires on every call, every n-th call or
// a share of calls; its action is a status code, a delay, a truncated body or a held connection.
export interface FaultAction {
  /** Answer with this status instead of forwarding (for example 503). */
  status?: number;
  /** Wait this long before forwarding (or before answering with `status`). */
  delayMs?: number;
  /** Forward, then send only the first `truncateBytes` bytes of the body. */
  truncateBytes?: number;
  /** Never answer (the caller's timeout decides). */
  hang?: boolean;
}

export interface FaultRule {
  name: string;
  method?: string;
  /** Regular expression tested against the request path (with query). */
  path: string;
  /** Fire on every `every`-th matching call (1 = every call). Default 1. */
  every?: number;
  /** Fire on this share (0..1) of matching calls, decided by `random`. Ignored when `every` is set. */
  ratio?: number;
  /** Fire only on the first `limit` matching calls; afterwards the call is forwarded unchanged. */
  limit?: number;
  action: FaultAction;
}

export interface FaultRequest { method: string; path: string }

/** Matching state per rule: how many calls matched (counted before the decision). */
export type FaultCounters = Map<string, number>;

/**
 * The first rule that matches and fires for this request, or null to forward unchanged. Counters
 * are advanced for every matching rule in order until one fires.
 */
export function pickFault(rules: readonly FaultRule[], req: FaultRequest, counters: FaultCounters, random: () => number = Math.random): FaultRule | null {
  for (const rule of rules) {
    if (rule.method && rule.method.toUpperCase() !== req.method.toUpperCase()) continue;
    if (!new RegExp(rule.path).test(req.path)) continue;
    const seen = (counters.get(rule.name) ?? 0) + 1;
    counters.set(rule.name, seen);
    if (rule.limit !== undefined && seen > rule.limit) continue;
    const fires = rule.every !== undefined ? seen % Math.max(1, Math.floor(rule.every)) === 0 : rule.ratio !== undefined ? random() < rule.ratio : true;
    if (fires) return rule;
  }
  return null;
}

/** Proxy rules of the named scenarios from section 4.2 that a proxy alone can inject. */
export const FAULT_SCENARIOS: Record<string, FaultRule[]> = {
  matting_down: [{ name: "matte_503", method: "POST", path: "^/matte", action: { status: 503 } }],
  matting_slow: [{ name: "matte_slow", method: "POST", path: "^/matte", every: 3, action: { delayMs: 61_000 } }],
  matting_recovers: [{ name: "matte_503_then_ok", method: "POST", path: "^/matte", limit: 8, action: { status: 503 } }],
  matting_gpu_down: [{ name: "gpu_unreachable", path: ".*", action: { status: 503 } }],
  gcs_flaky: [{ name: "gcs_503", path: ".*", ratio: 0.1, action: { status: 503 } }],
  verify_mismatch: [{ name: "verify_truncate", method: "GET", path: "\\.jpg", limit: 1, action: { truncateBytes: 100 } }],
  lock_sweeper: [{ name: "matte_hang", method: "POST", path: "^/matte", action: { hang: true } }],
  openrouter_down: [{ name: "chat_500", method: "POST", path: "/chat/completions", action: { status: 500 } }],
  supabase_broken_link: [{ name: "link_404", method: "GET", path: ".*", limit: 1, action: { status: 404 } }],
};

/** Parse and check a rules list (from a JSON file or the proxy's control endpoint). */
export function parseFaultRules(value: unknown): FaultRule[] {
  if (!Array.isArray(value)) throw new Error("Fault rules must be a JSON array.");
  return value.map((raw, i) => {
    const r = raw as Partial<FaultRule>;
    if (!r || typeof r.path !== "string" || typeof r.action !== "object" || !r.action) throw new Error(`Fault rule ${i + 1} needs a path and an action.`);
    new RegExp(r.path);
    return { ...r, name: typeof r.name === "string" && r.name ? r.name : `rule_${i + 1}`, path: r.path, action: r.action } as FaultRule;
  });
}

// Fault proxy (spec 09 section 4.2; esbuild entry "fault-proxy"). A local HTTP proxy put in front
// of one upstream (the matting service, a GCS-compatible endpoint or the OpenRouter base URL) that
// injects failures by rule, so each guardrail can be switched on and off per scenario.
//
//   node apps/worker/dist/fault-proxy.js --target http://localhost:8081 [--port 8090]
//     [--scenario matting_down | --rules rules.json]
//
// Point the caller at the proxy (for example MATTING_URL=http://localhost:8090). Rules can be read
// and replaced while it runs: GET /__fault/rules, PUT /__fault/rules with a JSON array ([] turns
// every fault off). Every injected fault is logged as one JSON line naming the rule, never a body.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { FAULT_SCENARIOS, parseFaultRules, pickFault, type FaultCounters, type FaultRule } from "@catalog/core/catalog/load/fault-rules";

const CONTROL = "/__fault/rules";
// Hop-by-hop and length headers are recomputed by Node on each side of the proxy.
const DROP_REQUEST = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);
const DROP_RESPONSE = new Set(["connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive"]);

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

const log = (entry: Record<string, unknown>) => console.info(JSON.stringify({ at: new Date().toISOString(), ...entry }));

function startFaultProxy(target: string, port: number, initial: FaultRule[]): http.Server {
  let rules = initial;
  let counters: FaultCounters = new Map();
  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET", requestPath = req.url ?? "/";
    try {
      if (requestPath === CONTROL) {
        if (method === "PUT") { rules = parseFaultRules(JSON.parse((await readBody(req)).toString("utf8"))); counters = new Map(); log({ event: "rules_replaced", rules: rules.map(r => r.name) }); }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rules));
        return;
      }
      const reqHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") reqHeaders[k] = v;
      const rule = pickFault(rules, { method, path: requestPath, headers: reqHeaders }, counters);
      if (rule) log({ event: "fault", rule: rule.name, method, path: requestPath.split("?")[0], action: rule.action });
      if (rule?.action.hang) return;
      if (rule?.action.delayMs) await new Promise(resolve => setTimeout(resolve, rule.action.delayMs));
      if (rule?.action.status) { res.writeHead(rule.action.status, { "content-type": "text/plain" }).end(`fault-proxy: ${rule.name}`); return; }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !DROP_REQUEST.has(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const body = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await readBody(req));
      const upstream = await fetch(new URL(requestPath, target), { method, headers, body, redirect: "manual" });
      let bytes = Buffer.from(await upstream.arrayBuffer());
      if (rule?.action.truncateBytes !== undefined) bytes = bytes.subarray(0, rule.action.truncateBytes);
      const out: Record<string, string> = {};
      upstream.headers.forEach((v, k) => { if (!DROP_RESPONSE.has(k)) out[k] = v; });
      res.writeHead(upstream.status, { ...out, "content-length": String(bytes.length) }).end(bytes);
    } catch (error) {
      log({ event: "proxy_error", method, path: requestPath.split("?")[0], error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }).end("fault-proxy: upstream error");
    }
  });
  // A held connection (the lock_sweeper scenario) must not be closed by Node's own request timeout.
  server.requestTimeout = 0;
  server.listen(port, () => log({ event: "listening", port, target, rules: rules.map(r => r.name) }));
  return server;
}

async function main() {
  const { values } = parseArgs({ options: { target: { type: "string" }, port: { type: "string", default: "8090" }, scenario: { type: "string" }, rules: { type: "string" } } });
  if (!values.target) throw new Error("Usage: fault-proxy --target <url> [--port <n>] [--scenario <name> | --rules <rules.json>]");
  new URL(values.target);
  let rules: FaultRule[] = [];
  if (values.scenario) {
    const scenario = FAULT_SCENARIOS[values.scenario];
    if (!scenario) throw new Error(`Unknown scenario ${values.scenario}. Known: ${Object.keys(FAULT_SCENARIOS).join(", ")}.`);
    rules = scenario;
  } else if (values.rules) rules = parseFaultRules(JSON.parse(await readFile(values.rules, "utf8")));
  startFaultProxy(values.target, Number(values.port), rules);
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

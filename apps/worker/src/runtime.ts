import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LogFields, Severity } from "@catalog/core/log";

/**
 * In the esbuild bundle the migrations are copied next to the bundle (dist/drizzle). Point
 * MIGRATIONS_DIR there unless the operator set it explicitly.
 */
export function defaultMigrationsDir(env: NodeJS.ProcessEnv = process.env): void {
  if (env.MIGRATIONS_DIR) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "drizzle");
  if (existsSync(path.join(bundled, "meta", "_journal.json"))) env.MIGRATIONS_DIR = bundled;
}

/** Process warnings of one kind logged with their stack before only every WARNING_LOG_EVERY-th is. */
export const WARNING_LOG_FIRST = 5;
export const WARNING_LOG_EVERY = 1000;

/**
 * Spec 18 H4: every process warning (MaxListenersExceededWarning and the like) as one structured WARNING line
 * with the stack that raised it, so a flood names its emitter in Cloud Logging. Node's own stderr line stays.
 * The first WARNING_LOG_FIRST of each kind (name plus message) carry the stack, then one line per
 * WARNING_LOG_EVERY with the running count. Install once per process.
 */
export function installWarningLog(log: (severity: Severity, message: string, fields?: LogFields) => void, proc: Pick<NodeJS.Process, "on"> = process): (warning: Error) => void {
  const seen = new Map<string, number>();
  const onWarning = (warning: Error) => {
    const kind = `${warning.name}: ${warning.message}`, n = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, n);
    if (n > WARNING_LOG_FIRST && n % WARNING_LOG_EVERY !== 0) return;
    // MaxListenersExceededWarning carries the emitter, the event name and the listener count.
    const extra = warning as Error & { emitter?: object; type?: unknown; count?: unknown };
    log("WARNING", "process warning", {
      warning: warning.name, detail: warning.message, seen: n, stack: warning.stack ?? null,
      ...(extra.emitter ? { emitter: extra.emitter.constructor?.name ?? null } : {}),
      ...(extra.type !== undefined ? { event: String(extra.type) } : {}),
      ...(typeof extra.count === "number" ? { listeners: extra.count } : {}),
    });
  };
  proc.on("warning", onWarning);
  return onWarning;
}

// Structured logs (observability Part B): one JSON line per call on stdout/stderr, which Cloud Run
// turns into a LogEntry. Special keys (Cloud Logging "special fields in structured payloads"):
// `severity` becomes LogEntry.severity, `logging.googleapis.com/labels` becomes LogEntry.labels (string
// values), and every other key stays in jsonPayload (jsonPayload.message, jsonPayload.batchId, ...).
// An ERROR that carries an Error object also gets the Error Reporting fields (`@type`
// ReportedErrorEvent, `stack_trace`, `serviceContext`) so Error Reporting groups it.
// No third-party SDK: this is the whole logger.

export type Severity = "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL" | "ALERT" | "EMERGENCY";
export const SEVERITIES: readonly Severity[] = ["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"];
export const LABELS_KEY = "logging.googleapis.com/labels";
export const ERROR_EVENT_TYPE = "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";
/** The value of the `app` label on every line that carries a batch. */
export const LOG_APP_LABEL = "catalog";

/**
 * The usual fields (any other key is allowed): batchId, brandSlug, stage, chunkId, productId, sourceImageId,
 * outputId, channel, attempt, durationMs, outcome, error. `error` may be an Error object: it is written as its
 * message, and on ERROR and above its stack goes to `stack_trace`.
 */
export type LogFields = Record<string, unknown>;

const AT_LEAST_ERROR = new Set<Severity>(["ERROR", "CRITICAL", "ALERT", "EMERGENCY"]);

/** A known severity name (any case), or undefined. */
export function toSeverity(value: unknown): Severity | undefined {
  if (typeof value !== "string") return undefined;
  const upper = value.toUpperCase() as Severity;
  return SEVERITIES.includes(upper) ? upper : undefined;
}

/** The JSON object `log` prints (exported for tests). `severity` and `message` in `fields` are ignored. */
export function logEntry(severity: Severity, message: string, fields: LogFields | null | undefined = {}, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  // A null or undefined fields value never throws: the line is still written.
  const { severity: _severity, message: _message, ...rest } = fields ?? {};
  const entry: Record<string, unknown> = { severity, message, ...rest };
  const error = rest.error;
  if (error instanceof Error) {
    entry.error = error.message;
    if (AT_LEAST_ERROR.has(severity)) {
      entry["@type"] = ERROR_EVENT_TYPE;
      entry.stack_trace = error.stack ?? `${error.name}: ${error.message}`;
      entry.serviceContext = { service: env.K_SERVICE || env.CLOUD_RUN_JOB || LOG_APP_LABEL };
    }
  }
  const batchId = rest.batchId;
  if (batchId !== undefined && batchId !== null && batchId !== "") entry[LABELS_KEY] = { app: LOG_APP_LABEL, batchId: String(batchId) };
  return entry;
}

function serialize(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value instanceof Error ? value.message : value);
  } catch {
    // A circular field never loses the line: keep what the alerts match on.
    return JSON.stringify({ severity: entry.severity, message: entry.message, ...(entry[LABELS_KEY] ? { [LABELS_KEY]: entry[LABELS_KEY], batchId: (entry[LABELS_KEY] as { batchId: string }).batchId } : {}), logError: "Some log fields could not be written." });
  }
}

/** Prints one JSON line: ERROR and above on stderr (console.error), WARNING on console.warn, the rest on console.info. */
export function log(severity: Severity, message: string, fields: LogFields | null | undefined = {}): void {
  const line = serialize(logEntry(severity, message, fields));
  if (AT_LEAST_ERROR.has(severity)) console.error(line);
  else if (severity === "WARNING") console.warn(line);
  else console.info(line);
}

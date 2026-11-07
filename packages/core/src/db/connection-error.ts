/**
 * True when an error means the connection dropped or could not be made, not that the work itself was wrong. Such an
 * error says nothing about the photo being worked on, so it must never be recorded as a fault of that photo.
 *
 * The shapes are the ones pg 8 and pg-pool 3 produce (read from their source):
 * - plain errors with no code, known only by their message ("Connection terminated unexpectedly");
 * - Node socket errors with a string `code` (ECONNRESET), which an HTTP client's socket can raise too; those are not a
 *   fault of the photo either;
 * - the server's own errors, with a SQLSTATE `code` (class 08, or a server shutting down);
 * - drizzle wraps a failed query in an error of its own ("Failed query: ...") with the driver's error as `cause`, and
 *   Node reports a failed connect to several addresses as an AggregateError, so both are walked.
 */
const PG_MESSAGES = new Set([
  "Connection terminated",
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
  "timeout exceeded when trying to connect",
  "timeout expired",
  "Client has encountered a connection error and is not queryable",
  "Client was closed and is not queryable",
  "Cannot use a pool after calling end on the pool",
  "There was an error establishing an SSL connection",
]);
const SOCKET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENOTFOUND", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH"]);
/**
 * 57P01 admin_shutdown, 57P02 crash_shutdown, 57P03 cannot_connect_now, 57P05 idle_session_timeout, 53300
 * too_many_connections, 25P03 idle_in_transaction_session_timeout, 57014 query_canceled (the worker's pool sets a
 * statement_timeout, client.ts, so a database too busy to answer ends here). Class 08 is checked by its prefix.
 */
const SQLSTATES = new Set(["57P01", "57P02", "57P03", "57P05", "53300", "25P03", "57014"]);
const MAX_DEPTH = 5;

export function isConnectionError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > MAX_DEPTH) return false;
  const e = error as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === "string" && (SOCKET_CODES.has(e.code) || SQLSTATES.has(e.code) || /^08[0-9A-Z]{3}$/.test(e.code))) return true;
  if (typeof e.message === "string" && PG_MESSAGES.has(e.message)) return true;
  if (isConnectionError(e.cause, depth + 1)) return true;
  return Array.isArray(e.errors) && e.errors.some(inner => isConnectionError(inner, depth + 1));
}

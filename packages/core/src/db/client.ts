import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema";
import { log } from "../log";

export type Schema = typeof schema;

/**
 * Driver-agnostic Drizzle database handle. Both the production node-postgres client and the
 * PGlite client used in tests (`@catalog/core/db/testing`) satisfy this type.
 */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export const DEFAULT_DB_POOL_MAX = 5;

/**
 * Pool size from DB_POOL_MAX (default 5 locally). infra/deploy.sh sets it per consumer so the
 * catalog stays inside the shared instance's connection budget (./budget.ts).
 */
export function poolMaxFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DB_POOL_MAX);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DB_POOL_MAX;
}

/**
 * The worker's session timeouts (its server sets them with workerDbTimeoutDefaults): a statement that runs
 * longer than WORKER_STATEMENT_TIMEOUT_MS is cancelled by Postgres and its task fails and is retried, and a
 * session left idle inside a transaction for WORKER_IDLE_TX_TIMEOUT_MS is ended. So a runaway query cannot
 * keep the shared instance busy for hours after its request is gone. Both are far above the slowest
 * legitimate query and transaction of the worker (seconds).
 */
export const WORKER_STATEMENT_TIMEOUT_MS = 300_000;
export const WORKER_IDLE_TX_TIMEOUT_MS = 600_000;

/** Sets DB_STATEMENT_TIMEOUT_MS and DB_IDLE_TX_TIMEOUT_MS to the worker defaults where they are not set. Call before getDb. */
export function workerDbTimeoutDefaults(env: NodeJS.ProcessEnv = process.env): void {
  env.DB_STATEMENT_TIMEOUT_MS ??= String(WORKER_STATEMENT_TIMEOUT_MS);
  env.DB_IDLE_TX_TIMEOUT_MS ??= String(WORKER_IDLE_TX_TIMEOUT_MS);
}

/** statement_timeout and idle_in_transaction_session_timeout from DB_STATEMENT_TIMEOUT_MS and DB_IDLE_TX_TIMEOUT_MS (unset or 0: none). */
function sessionTimeouts(env: NodeJS.ProcessEnv): Pick<pg.PoolConfig, "statement_timeout" | "idle_in_transaction_session_timeout"> {
  const ms = (v: string | undefined) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const statement = ms(env.DB_STATEMENT_TIMEOUT_MS);
  const idleTx = ms(env.DB_IDLE_TX_TIMEOUT_MS);
  return { ...(statement ? { statement_timeout: statement } : {}), ...(idleTx ? { idle_in_transaction_session_timeout: idleTx } : {}) };
}

export function poolConfigFromEnv(env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  const max = poolMaxFromEnv(env);
  const timeouts = sessionTimeouts(env);
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, max, ...timeouts };
  const { DB_HOST, DB_NAME, DB_USER, DB_PASSWORD } = env;
  if (!DB_HOST || !DB_NAME || !DB_USER) {
    throw new Error("Database not configured: set DATABASE_URL or DB_HOST, DB_NAME, DB_USER, DB_PASSWORD");
  }
  return { host: DB_HOST, database: DB_NAME, user: DB_USER, password: DB_PASSWORD, port: 5432, max, ...timeouts };
}

/** Postgres SQLSTATE 53300 too_many_connections, also used for "remaining connection slots are reserved". */
export function isTooManyConnections(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === "53300") return true;
  return typeof e.message === "string" && /too many (clients|connections)|remaining connection slots are reserved/i.test(e.message);
}

export interface ConnectRetryOptions {
  /** Total tries including the first (default 5). */
  attempts?: number;
  /** First wait in ms, doubled each retry (default 200: 200, 400, 800, 1600; about 3 s in all). */
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, waitMs: number) => void;
}

/**
 * Runs connect() again with a short exponential backoff while Postgres answers "too many
 * connections", so a burst degrades into a slower request instead of a crashed page or task.
 * Bounded: after the last attempt the error is rethrown. Every other error is rethrown at once.
 */
export async function connectWithRetry<T>(connect: () => Promise<T>, opts: ConnectRetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseMs = opts.baseMs ?? 200;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect();
    } catch (err) {
      if (attempt >= attempts || !isTooManyConnections(err)) throw err;
      const waitMs = baseMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
      opts.onRetry?.(attempt, waitMs);
      await sleep(waitMs);
    }
  }
}

type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: unknown) => void) => void;

/** pg.Pool whose connect() (and so query(), which goes through connect()) retries "too many connections". */
export class RetryingPool extends pg.Pool {
  constructor(config?: pg.PoolConfig, private readonly retry: ConnectRetryOptions = {}) {
    super(config);
  }

  connect(): Promise<pg.PoolClient>;
  connect(callback: ConnectCallback): void;
  connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    const p = connectWithRetry(() => super.connect(), {
      onRetry: (attempt, waitMs) => log("WARNING", "db connect: too many connections, retrying", { attempt, waitMs: Math.round(waitMs) }),
      ...this.retry,
    });
    if (!callback) return p;
    p.then(client => callback(undefined, client, (release?: unknown) => client.release(release as Error | boolean | undefined)), (err: Error) => callback(err, undefined, () => {}));
  }
}

let pool: pg.Pool | undefined;
let db: Db | undefined;

/** Process-wide singleton (pg Pool + drizzle). */
export function getDb(): Db {
  if (!db) {
    pool = new RetryingPool(poolConfigFromEnv());
    db = drizzle(pool, { schema });
  }
  return db;
}

/** Close the singleton pool (graceful shutdown, one-shot scripts like the migrate job). */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = undefined;
  db = undefined;
  if (p) await p.end();
}

export { schema };

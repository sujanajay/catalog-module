import { CloudTasksClient } from "@google-cloud/tasks";
import { retryTransient, type RetryOptions } from "./retry";
import { log } from "./log";
import { cloudRunAudience } from "./cloud-run";

/**
 * Generic Cloud Tasks enqueue for the catalog worker.
 *
 * Production: creates an HTTP task on `projects/{GCP_PROJECT}/locations/{REGION}/queues/{TASKS_QUEUE}`
 * that POSTs the JSON body to `${WORKER_URL}${route}` with an OIDC token for WORKER_SA_EMAIL
 * (audience: the service URL of WORKER_URL, also for a tag URL; see cloudRunAudience). A `taskId`
 * becomes the task name, so a re-enqueue of the same chunk or publish is deduplicated by the queue.
 *
 * The client library marks CreateTask non-idempotent and so never retries it. A named task is
 * idempotent (a repeat answers ALREADY_EXISTS, which counts as success), so a named createTask is
 * retried here on transient failures (UNAVAILABLE, DEADLINE_EXCEEDED, connection resets, 429, 5xx):
 * 5 tries with 1, 2, 4 and 8 s waits. An unnamed task is tried once, so a retry never duplicates it.
 *
 * New-batch setup (the ingest route: reading uploads and grouping them, wizard step 2) goes to its
 * own queue when TASKS_INGEST_QUEUE is set, so it never waits behind a big batch's render, qa and
 * publish tasks on TASKS_QUEUE. Unset, every route uses TASKS_QUEUE (the old single-queue behaviour).
 * Both queues target the same worker URL with the same OIDC token.
 *
 * Spec 16: a bulk batch's chunk and publish tasks (`bulk: true`) go to TASKS_BULK_QUEUE when it is set, so an
 * operator's small batch keeps the slots of TASKS_QUEUE to itself. Unset, they stay on TASKS_QUEUE.
 *
 * Local dev (`TASKS_INLINE=1`): POSTs the same body straight to the worker, fire-and-forget,
 * so the caller (a web request) is not blocked on the task.
 */

export const TASK_ROUTES = [
  "/tasks/catalog/sync-master",
  "/tasks/catalog/sweep",
  "/tasks/catalog/ingest",
  "/tasks/catalog/ingest-more",
  "/tasks/catalog/chunk",
  "/tasks/catalog/publish",
  "/tasks/catalog/finalize",
] as const;

export type TaskRoute = (typeof TASK_ROUTES)[number];

/** Routes that run on the ingest queue (TASKS_INGEST_QUEUE) when it is configured. */
export const INGEST_TASK_ROUTES: readonly TaskRoute[] = ["/tasks/catalog/ingest", "/tasks/catalog/ingest-more"];

/** Routes that run on the bulk queue (TASKS_BULK_QUEUE) for a bulk batch, when it is configured (spec 16). */
export const BULK_TASK_ROUTES: readonly TaskRoute[] = ["/tasks/catalog/chunk", "/tasks/catalog/publish"];

/** Minimal surface of `CloudTasksClient` we use - lets tests pass a fake. */
export type TasksClientLike = Pick<CloudTasksClient, "createTask">;

let client: TasksClientLike | undefined;

export function setTasksClient(c: TasksClientLike | undefined): void {
  client = c;
}

function getTasksClient(): TasksClientLike {
  if (!client) client = new CloudTasksClient();
  return client;
}

export interface EnqueueTaskOptions {
  delaySec?: number;
  /** Cloud Tasks task id (letters, digits, "-", "_"; at most 500 characters) for deduplication. */
  taskId?: string;
  /** Spec 16: the task belongs to a bulk batch (the bulk queue when configured). */
  bulk?: boolean;
  /** Overrides for tests. */
  env?: NodeJS.ProcessEnv;
  retry?: RetryOptions;
  fetch?: typeof fetch;
  client?: TasksClientLike;
}

export interface TasksConfig {
  project: string;
  region: string;
  queue: string;
  workerUrl: string;
  serviceAccountEmail: string;
}

export const DEFAULT_GCP_PROJECT = "image-links-agent";
export const DEFAULT_REGION = "asia-south1";
export const DEFAULT_TASKS_QUEUE = "catalog";

/** Matches the worker's Cloud Run --timeout (900 s); the 10-minute default can cut off slow chunks. */
export const DISPATCH_DEADLINE_SEC = 900;

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,500}$/;

/**
 * Spec 15: the id of a chunk's one live task, `chunk-<chunkId>-<stage>-<step>`. Every chunk enqueue uses it
 * with the body `{chunkId, stage, step}`, and every re-dispatch raises the step, so a new task never meets
 * the queue's deduplication of an id that ran recently.
 */
export function chunkTaskId(chunkId: string, stage: string, step: number): string {
  return `chunk-${chunkId}-${stage}-${step}`;
}

/** gRPC code ALREADY_EXISTS: a task with this name exists or ran recently (deduplicated). */
const GRPC_ALREADY_EXISTS = 6;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} env var is not set`);
  return v;
}

export function tasksConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TasksConfig {
  return {
    project: env.GCP_PROJECT || DEFAULT_GCP_PROJECT,
    region: env.REGION || DEFAULT_REGION,
    queue: env.TASKS_QUEUE || DEFAULT_TASKS_QUEUE,
    workerUrl: required(env, "WORKER_URL").replace(/\/+$/, ""),
    serviceAccountEmail: required(env, "WORKER_SA_EMAIL"),
  };
}

/**
 * The queue a route's tasks go to: the ingest queue for ingest routes when set, the bulk queue for a bulk
 * batch's chunk and publish tasks when set, else TASKS_QUEUE.
 */
export function queueForRoute(route: TaskRoute, env: NodeJS.ProcessEnv = process.env, bulk = false): string {
  if (INGEST_TASK_ROUTES.includes(route) && env.TASKS_INGEST_QUEUE) return env.TASKS_INGEST_QUEUE;
  if (bulk && BULK_TASK_ROUTES.includes(route) && env.TASKS_BULK_QUEUE) return env.TASKS_BULK_QUEUE;
  return env.TASKS_QUEUE || DEFAULT_TASKS_QUEUE;
}

export function queuePath(cfg: Pick<TasksConfig, "project" | "region" | "queue">): string {
  return `projects/${cfg.project}/locations/${cfg.region}/queues/${cfg.queue}`;
}

function assertTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`Invalid task id "${taskId}": use letters, digits, "-" and "_" only (at most 500 characters)`);
  }
}

interface HttpTask {
  name?: string;
  httpRequest: {
    httpMethod: "POST";
    url: string;
    headers: Record<string, string>;
    body: string;
    oidcToken: { serviceAccountEmail: string; audience: string };
  };
  scheduleTime?: { seconds: number };
  dispatchDeadline: { seconds: number };
}

/** Build the createTask request (exported for tests). */
export function buildTaskRequest(
  route: TaskRoute,
  body: Record<string, unknown>,
  cfg: TasksConfig,
  opts: EnqueueTaskOptions = {},
  now: number = Date.now(),
): { parent: string; task: unknown } {
  const parent = queuePath(cfg);
  const task: HttpTask = {
    httpRequest: {
      httpMethod: "POST",
      url: `${cfg.workerUrl}${route}`,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify(body)).toString("base64"),
      oidcToken: { serviceAccountEmail: cfg.serviceAccountEmail, audience: cloudRunAudience(cfg.workerUrl) },
    },
    dispatchDeadline: { seconds: DISPATCH_DEADLINE_SEC },
  };
  if (opts.taskId !== undefined) {
    assertTaskId(opts.taskId);
    task.name = `${parent}/tasks/${opts.taskId}`;
  }
  if (opts.delaySec && opts.delaySec > 0) task.scheduleTime = { seconds: Math.floor(now / 1000) + Math.ceil(opts.delaySec) };
  return { parent, task };
}

/**
 * Enqueue a task for the worker. Returns the Cloud Tasks task name (also when the queue already
 * holds a task with the same `taskId`), or "inline" in TASKS_INLINE mode.
 */
export async function enqueueTask(route: TaskRoute, body: Record<string, unknown>, opts: EnqueueTaskOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;

  if (env.TASKS_INLINE === "1") {
    if (opts.taskId !== undefined) assertTaskId(opts.taskId);
    const url = `${required(env, "WORKER_URL").replace(/\/+$/, "")}${route}`;
    const doFetch = opts.fetch ?? fetch;
    const send = () =>
      doFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        .then((res) => {
          if (!res.ok) log("ERROR", `[tasks] inline POST ${url} -> ${res.status}`, { route, status: res.status });
        })
        .catch((err: unknown) => log("ERROR", `[tasks] inline POST ${url} failed`, { route, error: err instanceof Error ? err : String(err) }));
    if (opts.delaySec && opts.delaySec > 0) setTimeout(() => void send(), opts.delaySec * 1000);
    else void send();
    return "inline";
  }

  const cfg = { ...tasksConfigFromEnv(env), queue: queueForRoute(route, env, opts.bulk) };
  const request = buildTaskRequest(route, body, cfg, opts);
  const name = (request.task as HttpTask).name;
  const create = async () => {
    try {
      const [task] = await (opts.client ?? getTasksClient()).createTask(request as Parameters<TasksClientLike["createTask"]>[0]);
      return task.name ?? "";
    } catch (err) {
      // Also the answer to a retry whose earlier try reached the queue but lost its reply.
      if ((err as { code?: unknown } | null)?.code === GRPC_ALREADY_EXISTS && name) return name;
      throw err;
    }
  };
  return name ? retryTransient(create, opts.retry) : create();
}

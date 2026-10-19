import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  buildTaskRequest,
  DISPATCH_DEADLINE_SEC,
  enqueueTask,
  TASK_ROUTES,
  tasksConfigFromEnv,
  type TaskRoute,
  type TasksClientLike,
} from "./tasks";

const env = {
  GCP_PROJECT: "image-links-agent",
  REGION: "asia-south1",
  TASKS_QUEUE: "catalog",
  WORKER_URL: "https://catalog-worker-847405579637.asia-south1.run.app/",
  WORKER_SA_EMAIL: "catalog-worker@image-links-agent.iam.gserviceaccount.com",
};
const WORKER = "https://catalog-worker-847405579637.asia-south1.run.app";
const QUEUE = "projects/image-links-agent/locations/asia-south1/queues/catalog";

interface BuiltTask {
  name?: string;
  httpRequest: { httpMethod: string; url: string; headers: Record<string, string>; body: string; oidcToken: unknown };
  scheduleTime?: { seconds: number };
  dispatchDeadline: { seconds: number };
}

function fakeClient() {
  const createTask = vi.fn().mockResolvedValue([{ name: `${QUEUE}/tasks/123` }]);
  return { client: { createTask } as unknown as TasksClientLike, createTask };
}

afterEach(() => vi.useRealTimers());

describe("TaskRoute", () => {
  it("TASK_ROUTES lists exactly the six routes of the type", () => {
    expectTypeOf<(typeof TASK_ROUTES)[number]>().toEqualTypeOf<TaskRoute>();
    expect(TASK_ROUTES).toHaveLength(6);
  });
});

describe("tasksConfigFromEnv", () => {
  it("defaults project, region and queue", () => {
    const cfg = tasksConfigFromEnv({ WORKER_URL: "https://w/", WORKER_SA_EMAIL: "sa@x" });
    expect(cfg).toEqual({ project: "image-links-agent", region: "asia-south1", queue: "catalog", workerUrl: "https://w", serviceAccountEmail: "sa@x" });
  });

  it("throws when WORKER_URL or WORKER_SA_EMAIL is missing", () => {
    expect(() => tasksConfigFromEnv({ WORKER_SA_EMAIL: "sa@x" })).toThrow(/WORKER_URL/);
    expect(() => tasksConfigFromEnv({ WORKER_URL: "https://w" })).toThrow(/WORKER_SA_EMAIL/);
  });
});

describe("buildTaskRequest", () => {
  const cfg = tasksConfigFromEnv(env);

  it.each(TASK_ROUTES)("builds an OIDC HTTP task for %s", (route) => {
    const body = { batchId: "b1", n: 2 };
    const req = buildTaskRequest(route, body, cfg);
    const task = req.task as BuiltTask;
    expect(req.parent).toBe(QUEUE);
    expect(task.name).toBeUndefined();
    expect(task.scheduleTime).toBeUndefined();
    expect(task.httpRequest.httpMethod).toBe("POST");
    expect(task.httpRequest.url).toBe(`${WORKER}${route}`);
    expect(task.httpRequest.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(Buffer.from(task.httpRequest.body, "base64").toString())).toEqual(body);
    expect(task.httpRequest.oidcToken).toEqual({ serviceAccountEmail: env.WORKER_SA_EMAIL, audience: WORKER });
    expect(task.dispatchDeadline).toEqual({ seconds: DISPATCH_DEADLINE_SEC });
    expect(DISPATCH_DEADLINE_SEC).toBe(900);
  });

  it("taskId becomes task.name under the queue path", () => {
    const req = buildTaskRequest("/tasks/catalog/chunk", {}, cfg, { taskId: "chunk-b1_3-render" });
    expect((req.task as BuiltTask).name).toBe(`${QUEUE}/tasks/chunk-b1_3-render`);
  });

  it("rejects a taskId with characters Cloud Tasks does not allow", () => {
    expect(() => buildTaskRequest("/tasks/catalog/chunk", {}, cfg, { taskId: "chunk/1" })).toThrow(/Invalid task id/);
    expect(() => buildTaskRequest("/tasks/catalog/chunk", {}, cfg, { taskId: "" })).toThrow(/Invalid task id/);
    expect(() => buildTaskRequest("/tasks/catalog/chunk", {}, cfg, { taskId: "a".repeat(501) })).toThrow(/Invalid task id/);
  });

  it("sets scheduleTime when delaySec is given", () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const req = buildTaskRequest("/tasks/catalog/finalize", {}, cfg, { delaySec: 30 }, now);
    expect((req.task as BuiltTask).scheduleTime).toEqual({ seconds: now / 1000 + 30 });
  });
});

describe("enqueueTask", () => {
  it("creates the task and returns its name", async () => {
    const { client, createTask } = fakeClient();
    const name = await enqueueTask("/tasks/catalog/ingest", { batchId: "b1" }, { env, client });
    expect(name).toBe(`${QUEUE}/tasks/123`);
    expect(createTask).toHaveBeenCalledTimes(1);
    const req = createTask.mock.calls[0]![0] as { parent: string; task: BuiltTask };
    expect(req.parent).toBe(QUEUE);
    expect(req.task.httpRequest.url).toBe(`${WORKER}/tasks/catalog/ingest`);
  });

  it("treats ALREADY_EXISTS for a named task as deduplicated", async () => {
    const createTask = vi.fn().mockRejectedValue(Object.assign(new Error("6 ALREADY_EXISTS"), { code: 6 }));
    const client = { createTask } as unknown as TasksClientLike;
    expect(await enqueueTask("/tasks/catalog/publish", { batchId: "b1" }, { env, client, taskId: "publish-b1" })).toBe(
      `${QUEUE}/tasks/publish-b1`,
    );
  });

  it("retries a named task after a transient reset and returns its name", async () => {
    const sleep = vi.fn(async () => {});
    const createTask = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("14 UNAVAILABLE: read ECONNRESET"), { code: 14 }))
      .mockResolvedValueOnce([{ name: `${QUEUE}/tasks/ingest-u1-r1` }]);
    const client = { createTask } as unknown as TasksClientLike;
    expect(await enqueueTask("/tasks/catalog/ingest", { batchId: "b1", uploadId: "u1" }, { env, client, taskId: "ingest-u1-r1", retry: { sleep } })).toBe(`${QUEUE}/tasks/ingest-u1-r1`);
    expect(createTask).toHaveBeenCalledTimes(2);
    // Every try sends the same task name, so the queue keeps one task whatever the network did.
    expect(createTask.mock.calls.map(([req]) => (req as { task: BuiltTask }).task.name)).toEqual([`${QUEUE}/tasks/ingest-u1-r1`, `${QUEUE}/tasks/ingest-u1-r1`]);
  });

  it("counts ALREADY_EXISTS on a retry as success (the first try reached the queue but lost its reply)", async () => {
    const createTask = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("4 DEADLINE_EXCEEDED"), { code: 4 }))
      .mockRejectedValueOnce(Object.assign(new Error("6 ALREADY_EXISTS"), { code: 6 }));
    const client = { createTask } as unknown as TasksClientLike;
    expect(await enqueueTask("/tasks/catalog/ingest", {}, { env, client, taskId: "ingest-u1-r1", retry: { sleep: async () => {} } })).toBe(`${QUEUE}/tasks/ingest-u1-r1`);
    expect(createTask).toHaveBeenCalledTimes(2);
  });

  it("tries an unnamed task once, so a retry can never duplicate it", async () => {
    const createTask = vi.fn().mockRejectedValue(Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }));
    const client = { createTask } as unknown as TasksClientLike;
    await expect(enqueueTask("/tasks/catalog/finalize", {}, { env, client, retry: { sleep: async () => {} } })).rejects.toThrow(/UNAVAILABLE/);
    expect(createTask).toHaveBeenCalledTimes(1);
  });

  it("rethrows other createTask errors", async () => {
    const createTask = vi.fn().mockRejectedValue(Object.assign(new Error("7 PERMISSION_DENIED"), { code: 7 }));
    const client = { createTask } as unknown as TasksClientLike;
    await expect(enqueueTask("/tasks/catalog/publish", {}, { env, client, taskId: "publish-b1" })).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it("TASKS_INLINE=1 posts to ${WORKER_URL}${route} without Cloud Tasks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    const { client, createTask } = fakeClient();
    const r = await enqueueTask("/tasks/catalog/sweep", { a: 1 }, {
      env: { TASKS_INLINE: "1", WORKER_URL: "http://localhost:8081/" },
      client,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(r).toBe("inline");
    expect(createTask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8081/tasks/catalog/sweep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
  });

  it("TASKS_INLINE=1 with delaySec waits before posting", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    await enqueueTask("/tasks/catalog/chunk", {}, {
      env: { TASKS_INLINE: "1", WORKER_URL: "http://localhost:8081" },
      fetch: fetchMock as unknown as typeof fetch,
      delaySec: 5,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

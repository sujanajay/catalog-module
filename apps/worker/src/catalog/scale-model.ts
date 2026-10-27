// Spec 16 F4: a discrete-event model of the whole batch pipeline at the F2 shape, in simulated time, for the local
// scale test. It plays the pieces that set the speed: the two Cloud Tasks queues (FIFO, a slot count each), the
// per-batch window, chunk deliveries with E's 480 s budget and hand-off, photos at once inside a delivery on the
// worker's share of vCPU, the GPU cut-out service (instances x concurrency, one inference at a time under the lock,
// Cloud Run's 10 s pending window then 429, the client's wait-and-retry and the CPU fallback after the third busy
// answer), the CPU upscale service, the judge (long tail, 429 with back-off) and publish. It never touches a
// database or a network; scale.test.ts runs the real handlers for the duplicate-work and ownership checks.
import { bestMinutesRate, imagesPerMinuteBy5Min, stageTaskMs } from "@catalog/core/catalog/load/throughput";

export interface ModelShape {
  operatorSlots: number; bulkSlots: number;
  workerInstances: number; workerCpu: number; workerConcurrency: number;
  photoConcurrency: number; chunkPhotos: number; operatorWindow: number; bulkWindow: number; bulkBatchProducts: number;
  budgetMs: number; deadlineMs: number;
  gpu: { instances: number; concurrency: number; inferenceMs: number; lockGapMs: number; prePostMs: number; guardShare: number; coldStartMs: number; modelLoadMs: number; models: number; pendingMs: number; busyTries: number };
  cpuService: { instances: number; upscaleMs: number; cutoutMs: number };
  upscaleShare: number;
  judge: { callsPerPhoto: number; medianMs: number; sigma: number; rate429: number; backoffMs: number; retries: number };
  worker: { matteCpuMs: number; renderCpuMsPerImage: number; qaCpuMs: number; writeMs: number };
  publishMsPerProduct: number;
}

/** The F2 run shape of spec 16 section 8 with the plan's constants (section 1.2 of the plan). */
export const F2_SHAPE: ModelShape = {
  operatorSlots: 8, bulkSlots: 36, workerInstances: 24, workerCpu: 4, workerConcurrency: 2,
  photoConcurrency: 4, chunkPhotos: 10, operatorWindow: 8, bulkWindow: 30, bulkBatchProducts: 100,
  budgetMs: 480_000, deadlineMs: 900_000,
  gpu: { instances: 3, concurrency: 2, inferenceMs: 650, lockGapMs: 130, prePostMs: 300, guardShare: 0.15, coldStartMs: 120_000, modelLoadMs: 6_000, models: 3, pendingMs: 420_000, busyTries: 3 },
  cpuService: { instances: 16, upscaleMs: 7_000, cutoutMs: 12_000 },
  upscaleShare: 0.5,
  judge: { callsPerPhoto: 1.23, medianMs: 5_500, sigma: 0.45, rate429: 0.05, backoffMs: 4_000, retries: 3 },
  worker: { matteCpuMs: 3_000, renderCpuMsPerImage: 750, qaCpuMs: 300, writeMs: 40 },
  publishMsPerProduct: 5_000,
};

export interface ModelBatch { name: string; products: number; photosPerProduct: number; channels: number; startAtMs: number; bulk?: boolean }

export interface ModelReport {
  drainedAtMs: Record<string, number>;
  firstImageAtMs: Record<string, number>;
  /** When each batch's n-th chunk (0-based index) started its first delivery. */
  chunkStartedAtMs: Record<string, number[]>;
  photosMatted: Record<string, number>; mattedTwice: number;
  imagesPerMinuteBy5Min: number[]; bestThreeMinutesPhotosPerMinute: number;
  stageTaskMs: Record<string, { p50: number; p95: number; n: number }>;
  maxQueueDepth: Record<"operator" | "bulk", number>;
  maxActiveChunks: Record<string, number>;
  maxDeliveryMs: number; handOffs: number;
  gpu: { calls: number; busy429: number; cpuFallbacks: number; modelLoads: number };
  judge: { calls: number; rateLimited: number; failedAfterRetries: number };
  renderOverlapsMatteMs: Record<string, number>;
}

/** A seeded random source (mulberry32), so a run is repeatable. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Simulated time: `sleep` resolves in time order; `run` lets every promise chain settle between instants. */
class Clock {
  now = 0;
  private seq = 0;
  private heap: { at: number; seq: number; resolve: () => void }[] = [];
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.push({ at: this.now + Math.max(0, ms), seq: this.seq++, resolve }));
  }
  private push(e: { at: number; seq: number; resolve: () => void }) {
    const h = this.heap; h.push(e);
    for (let i = h.length - 1; i > 0;) { const p = (i - 1) >> 1; if (less(h[p]!, h[i]!)) break; [h[p], h[i]] = [h[i]!, h[p]!]; i = p; }
  }
  private pop() {
    const h = this.heap, top = h[0]!, last = h.pop()!;
    if (h.length) { h[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && less(h[l]!, h[m]!)) m = l; if (r < h.length && less(h[r]!, h[m]!)) m = r; if (m === i) break; [h[m], h[i]] = [h[i]!, h[m]!]; i = m; } }
    return top;
  }
  async run(): Promise<void> {
    await settle();
    while (this.heap.length) {
      const at = this.heap[0]!.at;
      this.now = at;
      while (this.heap.length && this.heap[0]!.at === at) this.pop().resolve();
      await settle();
    }
  }
}
const less = (a: { at: number; seq: number }, b: { at: number; seq: number }) => a.at < b.at || (a.at === b.at && a.seq < b.seq);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** FIFO places; `within` gives up after that much simulated time. */
class Places {
  private used = 0;
  private waiting: { grant: (ok: boolean) => void; done: boolean }[] = [];
  constructor(private readonly size: number, private readonly clock: Clock) {}
  async take(within = Infinity): Promise<boolean> {
    if (this.used < this.size && !this.waiting.length) { this.used += 1; return true; }
    return new Promise<boolean>((grant) => {
      const w = { grant, done: false };
      this.waiting.push(w);
      if (Number.isFinite(within)) void this.clock.sleep(within).then(() => { if (!w.done) { w.done = true; this.waiting.splice(this.waiting.indexOf(w), 1); grant(false); } });
    });
  }
  give(): void {
    const next = this.waiting.shift();
    if (next) { next.done = true; next.grant(true); } else this.used -= 1;
  }
}

interface Chunk { batch: BatchState; index: number; photos: { product: number; model: number }[]; stage: "matte" | "render" | "qa" | "done"; cursor: number; dispatched: boolean; startedAt?: number }
interface BatchState { spec: ModelBatch; bulk: boolean; chunks: Chunk[]; active: number; maxActive: number; publishLeft: number; firstImageAt?: number; drainedAt?: number; matteSpan: [number, number]; renderSpan: [number, number] }
interface Task { batch: BatchState; run: () => Promise<void> }

export async function simulate(shape: ModelShape, batches: readonly ModelBatch[], seed = 1): Promise<ModelReport> {
  const clock = new Clock(), rnd = random(seed);
  const queues = { operator: { slots: shape.operatorSlots, fifo: [] as Task[], running: 0, maxDepth: 0 }, bulk: { slots: shape.bulkSlots, fifo: [] as Task[], running: 0, maxDepth: 0 } };
  const gpuAdmit = new Places(shape.gpu.instances * shape.gpu.concurrency, clock);
  const gpuLocks = Array.from({ length: shape.gpu.instances }, () => new Places(1, clock));
  const gpuLoaded = Array.from({ length: shape.gpu.instances }, () => new Set<number>());
  let gpuNext = 0, gpuWarmAt: number | null = null;
  const cpuService = new Places(shape.cpuService.instances, clock);
  const durations: Record<string, number[]> = { matte: [], render: [], qa: [], publish: [] };
  const imagesAt: number[] = [];
  const report = { gpu: { calls: 0, busy429: 0, cpuFallbacks: 0, modelLoads: 0 }, judge: { calls: 0, rateLimited: 0, failedAfterRetries: 0 }, handOffs: 0, maxDeliveryMs: 0 };
  const matted = new Map<string, number>();
  const lognormal = (median: number, sigma: number) => { const u = Math.max(1e-9, rnd()), v = rnd(); return median * Math.exp(sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)); };

  const enqueue = (task: Task) => {
    const q = task.batch.bulk ? queues.bulk : queues.operator;
    q.fifo.push(task); q.maxDepth = Math.max(q.maxDepth, q.fifo.length);
    pump(q);
  };
  const pump = (q: typeof queues.operator) => {
    while (q.running < q.slots && q.fifo.length) {
      const task = q.fifo.shift()!; q.running += 1;
      void task.run().then(() => { q.running -= 1; pump(q); });
    }
  };
  const dispatchChunks = (b: BatchState) => {
    const window = b.bulk ? shape.bulkWindow : shape.operatorWindow;
    for (const c of b.chunks) {
      if (b.active >= window) break;
      if (c.dispatched) continue;
      c.dispatched = true; b.active += 1; b.maxActive = Math.max(b.maxActive, b.active);
      enqueue({ batch: b, run: () => deliver(c) });
    }
  };

  /** One GPU cut-out call, with Cloud Run's pending window, the client's busy rule and the CPU fallback. */
  async function cutOut(model: number): Promise<void> {
    if (gpuWarmAt === null) gpuWarmAt = clock.now + shape.gpu.coldStartMs;
    if (clock.now < gpuWarmAt) await clock.sleep(gpuWarmAt - clock.now);
    for (let busy = 0; busy < shape.gpu.busyTries; busy++) {
      report.gpu.calls += 1;
      if (await gpuAdmit.take(shape.gpu.pendingMs)) {
        const i = gpuNext++ % shape.gpu.instances;
        await clock.sleep(shape.gpu.prePostMs / 2);
        await gpuLocks[i]!.take();
        if (!gpuLoaded[i]!.has(model)) { gpuLoaded[i]!.add(model); report.gpu.modelLoads += 1; await clock.sleep(shape.gpu.modelLoadMs); }
        await clock.sleep(shape.gpu.inferenceMs + shape.gpu.lockGapMs);
        gpuLocks[i]!.give();
        await clock.sleep(shape.gpu.prePostMs / 2);
        gpuAdmit.give();
        return;
      }
      report.gpu.busy429 += 1;
      if (busy + 1 < shape.gpu.busyTries) await clock.sleep(1_000 + 2_000 * rnd());
    }
    report.gpu.cpuFallbacks += 1;
    await cpuService.take(); await clock.sleep(shape.cpuService.cutoutMs); cpuService.give();
  }

  async function judgeCall(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      report.judge.calls += 1;
      await clock.sleep(lognormal(shape.judge.medianMs, shape.judge.sigma));
      if (rnd() >= shape.judge.rate429) return;
      report.judge.rateLimited += 1;
      if (attempt >= shape.judge.retries) { report.judge.failedAfterRetries += 1; return; }
      await clock.sleep(shape.judge.backoffMs * (attempt + 1));
    }
  }

  async function photoWork(c: Chunk, at: number, cpu: Places, writes: Places): Promise<void> {
    const cpuFor = async (ms: number) => { await cpu.take(); await clock.sleep(ms); cpu.give(); };
    const write = async () => { await writes.take(); await clock.sleep(shape.worker.writeMs); writes.give(); };
    const p = c.photos[at]!, key = `${c.batch.spec.name}/${c.index}/${at}`;
    if (c.stage === "matte") {
      await cpuFor(shape.worker.matteCpuMs * 0.8);
      await cutOut(p.model);
      if (rnd() < shape.gpu.guardShare) await cutOut(p.model);
      await cpuFor(shape.worker.matteCpuMs * 0.2);
      await write(); await write();
      matted.set(key, (matted.get(key) ?? 0) + 1);
    } else if (c.stage === "render") {
      if (rnd() < shape.upscaleShare) { await cpuService.take(); await clock.sleep(shape.cpuService.upscaleMs); cpuService.give(); }
      for (let ch = 0; ch < c.batch.spec.channels; ch++) { await cpuFor(shape.worker.renderCpuMsPerImage); await write(); imagesAt.push(clock.now); }
      c.batch.firstImageAt ??= clock.now;
    } else {
      await cpuFor(shape.worker.qaCpuMs);
      const calls = Math.floor(shape.judge.callsPerPhoto) + (rnd() < shape.judge.callsPerPhoto % 1 ? 1 : 0);
      for (let i = 0; i < calls; i++) await judgeCall();
      await write();
    }
  }

  /** One chunk delivery: photos `photoConcurrency` at a time on this task's share of the instance's vCPU. */
  async function deliver(c: Chunk): Promise<void> {
    const started = clock.now, stage = c.stage as "matte" | "render" | "qa";
    c.startedAt ??= started;
    const span = stage === "matte" ? c.batch.matteSpan : stage === "render" ? c.batch.renderSpan : null;
    if (span) span[0] = Math.min(span[0], started);
    const cpu = new Places(Math.max(1, Math.round(shape.workerCpu / shape.workerConcurrency)), clock), writes = new Places(1, clock);
    let done = 0, outOfTime = false;
    const workers = Array.from({ length: shape.photoConcurrency }, async () => {
      while (c.cursor < c.photos.length && !outOfTime) {
        if (done > 0 && clock.now - started >= shape.budgetMs) { outOfTime = true; return; }
        const at = c.cursor++;
        await photoWork(c, at, cpu, writes);
        done += 1;
      }
    });
    await Promise.all(workers);
    const ms = clock.now - started;
    report.maxDeliveryMs = Math.max(report.maxDeliveryMs, ms);
    durations[stage]!.push(ms);
    if (span) span[1] = Math.max(span[1], clock.now);
    if (c.cursor < c.photos.length) { report.handOffs += 1; enqueue({ batch: c.batch, run: () => deliver(c) }); return; }
    c.cursor = 0;
    if (stage !== "qa") { c.stage = stage === "matte" ? "render" : "qa"; enqueue({ batch: c.batch, run: () => deliver(c) }); return; }
    c.stage = "done"; c.batch.active -= 1;
    for (let n = new Set(c.photos.map((p) => p.product)).size; n > 0; n--) enqueue({ batch: c.batch, run: () => publish(c.batch) });
    dispatchChunks(c.batch);
  }

  async function publish(b: BatchState): Promise<void> {
    const t0 = clock.now;
    await clock.sleep(shape.publishMsPerProduct);
    durations.publish!.push(clock.now - t0);
    b.publishLeft -= 1;
    if (b.publishLeft === 0) b.drainedAt = clock.now;
  }

  const states: BatchState[] = batches.map((spec) => {
    const bulk = spec.bulk ?? spec.products >= shape.bulkBatchProducts;
    const b: BatchState = { spec, bulk, chunks: [], active: 0, maxActive: 0, publishLeft: spec.products, matteSpan: [Infinity, 0], renderSpan: [Infinity, 0] };
    let photos: Chunk["photos"] = [];
    for (let product = 0; product < spec.products; product++) {
      // Whole products per chunk (planChunks): a product starts a new chunk when the next would pass chunkPhotos.
      if (photos.length && photos.length + spec.photosPerProduct > shape.chunkPhotos) { b.chunks.push({ batch: b, index: b.chunks.length, photos, stage: "matte", cursor: 0, dispatched: false }); photos = []; }
      const model = Math.floor(rnd() * shape.gpu.models);
      for (let n = 0; n < spec.photosPerProduct; n++) photos.push({ product, model });
    }
    if (photos.length) b.chunks.push({ batch: b, index: b.chunks.length, photos, stage: "matte", cursor: 0, dispatched: false });
    return b;
  });
  for (const b of states) void clock.sleep(b.spec.startAtMs).then(() => dispatchChunks(b));
  await clock.run();

  const by = <T>(f: (b: BatchState) => T) => Object.fromEntries(states.map((b) => [b.spec.name, f(b)]));
  const counts = [...matted.values()];
  return {
    drainedAtMs: by((b) => (b.drainedAt ?? NaN) - b.spec.startAtMs),
    firstImageAtMs: by((b) => (b.firstImageAt ?? NaN) - b.spec.startAtMs),
    chunkStartedAtMs: by((b) => b.chunks.map((c) => (c.startedAt ?? NaN) - b.spec.startAtMs)),
    photosMatted: by((b) => b.chunks.reduce((n, c) => n + c.photos.length, 0)),
    mattedTwice: counts.filter((n) => n > 1).length,
    imagesPerMinuteBy5Min: imagesPerMinuteBy5Min(imagesAt),
    bestThreeMinutesPhotosPerMinute: bestMinutesRate(imagesAt, 3) / Math.max(1, batches[0]?.channels ?? 1),
    stageTaskMs: stageTaskMs(durations),
    maxQueueDepth: { operator: queues.operator.maxDepth, bulk: queues.bulk.maxDepth },
    maxActiveChunks: by((b) => b.maxActive),
    maxDeliveryMs: report.maxDeliveryMs, handOffs: report.handOffs,
    gpu: report.gpu, judge: report.judge,
    renderOverlapsMatteMs: by((b) => Math.max(0, Math.min(b.matteSpan[1], b.renderSpan[1]) - Math.max(b.matteSpan[0], b.renderSpan[0]))),
  };
}

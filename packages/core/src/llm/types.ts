// Dependencies of the OpenRouter client. Tests inject `fetch` so no live call is ever made.
import type { RetryPolicy } from "./openrouter";

export interface OpenRouterDeps {
  /** Defaults to process.env.OPENROUTER_API_KEY (read at call time, mounted from Secret Manager). */
  apiKey?: string;
  /** Defaults to globalThis.fetch. Inject a mock in tests. */
  fetch?: typeof fetch;
  /** Defaults to https://openrouter.ai/api/v1 */
  baseUrl?: string;
  /** Sent as X-Title / HTTP-Referer. Defaults to "catalog-module". */
  appName?: string;
  /** Per-request timeout. Defaults to 600_000 ms. */
  timeoutMs?: number;
  /** Base backoff before the single retry on 429/5xx. Defaults to 2_000 ms. */
  retryDelayMs?: number;
  /** Back-off on 429/5xx beyond the single default retry (the QA judge sets one). */
  retry?: RetryPolicy;
}

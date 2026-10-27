// The intake browser harness's stand-in for `undici` in the app's server bundle (aliased by
// next.config.ts only under next dev with INTAKE_HARNESS=1). packages/core/src/safe-url.ts builds
// pinnedFetch from undici's Agent and fetch; here fetch is the harness's fake image host, which
// catalog-intake.server.ts installs on globalThis (same process). safeFetch's own checks still run.
const HOST = Symbol.for("catalog.intakeHarness.imageHost");

export class Agent {
  constructor(_options?: unknown) {}
}

export const fetch: typeof globalThis.fetch = (input, init) => {
  const host = (globalThis as { [HOST]?: typeof globalThis.fetch })[HOST];
  if (!host) return Promise.reject(new Error("harness: no fake image host installed"));
  return host(input, init);
};

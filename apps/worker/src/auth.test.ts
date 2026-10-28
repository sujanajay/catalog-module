import { describe, expect, it } from "vitest";
import { authConfigFromEnv, type IdTokenVerifier } from "./auth";

const verifier = {} as IdTokenVerifier;

describe("authConfigFromEnv", () => {
  it("expects the service URL as the audience, also when WORKER_URL is a tag URL", () => {
    expect(authConfigFromEnv(verifier, { WORKER_URL: "https://catalog-worker-847405579637.asia-south1.run.app/" }).audience).toBe("https://catalog-worker-847405579637.asia-south1.run.app");
    expect(authConfigFromEnv(verifier, { WORKER_URL: "https://candidate---catalog-worker-qtoctgoxqa-el.a.run.app" }).audience).toBe("https://catalog-worker-qtoctgoxqa-el.a.run.app");
  });
  it("leaves the audience unset without WORKER_URL", () => {
    expect(authConfigFromEnv(verifier, {}).audience).toBeUndefined();
    expect(authConfigFromEnv(verifier, { WORKER_URL: "" }).audience).toBeUndefined();
  });
});

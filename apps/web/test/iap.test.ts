import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../lib/errors";
import { IAP_KEYS_TTL_MS, resetIapKeysCache, verifyIapJwt } from "../lib/iap";
import { fakeDeps, makeKey, signJwt, TEST_AUDIENCE } from "./helpers/iap-jwt";

const key = makeKey("kid-1");

async function expect401(p: Promise<unknown>) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect(err).toMatchObject({ status: 401, message: "Sign in to continue." });
}

afterEach(() => resetIapKeysCache());

describe("verifyIapJwt", () => {
  it("accepts a token with the right aud, iss, exp, email and sub; lowercases the email", async () => {
    const { deps } = fakeDeps([key]);
    const token = signJwt(key, { email: "Someone@Opptra.com", sub: "accounts.google.com:42" });
    expect(await verifyIapJwt(token, TEST_AUDIENCE, deps)).toEqual({
      email: "someone@opptra.com",
      sub: "accounts.google.com:42",
    });
  });

  it("rejects a wrong audience (a token for another IAP resource)", async () => {
    const { deps } = fakeDeps([key]);
    const token = signJwt(key, { aud: "/projects/123456789/locations/asia-south1/services/ila-web" });
    await expect401(verifyIapJwt(token, TEST_AUDIENCE, deps));
  });

  it("rejects a wrong issuer", async () => {
    const { deps } = fakeDeps([key]);
    await expect401(verifyIapJwt(signJwt(key, { iss: "https://accounts.google.com" }), TEST_AUDIENCE, deps));
  });

  it("rejects an expired token", async () => {
    const { deps } = fakeDeps([key]);
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expect401(verifyIapJwt(signJwt(key, { iat: past - 600, exp: past }), TEST_AUDIENCE, deps));
  });

  it("rejects a tampered payload", async () => {
    const { deps } = fakeDeps([key]);
    const [h, , s] = signJwt(key).split(".");
    const forged = Buffer.from(
      JSON.stringify({
        aud: TEST_AUDIENCE,
        iss: "https://cloud.google.com/iap",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
        sub: "x",
        email: "boss@opptra.com",
      }),
    ).toString("base64url");
    await expect401(verifyIapJwt(`${h}.${forged}.${s}`, TEST_AUDIENCE, deps));
  });

  it("rejects a token signed by a key that is not Google's, under a known kid", async () => {
    const { deps } = fakeDeps([key]);
    const attacker = makeKey("kid-1");
    await expect401(verifyIapJwt(signJwt(attacker), TEST_AUDIENCE, deps));
  });

  it("rejects a token without email, and one without sub", async () => {
    const { deps } = fakeDeps([key]);
    await expect401(verifyIapJwt(signJwt(key, { email: undefined }), TEST_AUDIENCE, deps));
    await expect401(verifyIapJwt(signJwt(key, { email: "" }), TEST_AUDIENCE, deps));
    await expect401(verifyIapJwt(signJwt(key, { sub: undefined }), TEST_AUDIENCE, deps));
  });

  it("rejects garbage, an empty token and an empty audience", async () => {
    const { deps } = fakeDeps([key]);
    await expect401(verifyIapJwt("not-a-jwt", TEST_AUDIENCE, deps));
    await expect401(verifyIapJwt("", TEST_AUDIENCE, deps));
    await expect401(verifyIapJwt(signJwt(key), "", deps));
  });

  it("fetches the keys once for many verifications and again after the TTL", async () => {
    const { deps, clock } = fakeDeps([key]);
    for (let i = 0; i < 5; i++) await verifyIapJwt(signJwt(key), TEST_AUDIENCE, deps);
    expect(deps.calls).toBe(1);
    clock.t += IAP_KEYS_TTL_MS;
    await verifyIapJwt(signJwt(key), TEST_AUDIENCE, deps);
    expect(deps.calls).toBe(2);
  });

  it("refreshes once when an unknown kid appears, then accepts a rotated key", async () => {
    const { deps, clock } = fakeDeps([key]);
    await verifyIapJwt(signJwt(key), TEST_AUDIENCE, deps);
    expect(deps.calls).toBe(1);

    // Google rotates: the new key is published after our cache was filled.
    const rotated = makeKey("kid-2");
    deps.keys = [key, rotated];
    clock.t += 2 * 60 * 1000;
    expect(await verifyIapJwt(signJwt(rotated), TEST_AUDIENCE, deps)).toMatchObject({ email: "someone@opptra.com" });
    expect(deps.calls).toBe(2);
    await verifyIapJwt(signJwt(rotated), TEST_AUDIENCE, deps);
    expect(deps.calls).toBe(2);
  });

  it("rejects an unknown kid after one refresh, and does not refetch on every such token", async () => {
    const { deps, clock } = fakeDeps([key]);
    await verifyIapJwt(signJwt(key), TEST_AUDIENCE, deps);
    clock.t += 2 * 60 * 1000;
    const stranger = makeKey("kid-unknown");
    await expect401(verifyIapJwt(signJwt(stranger), TEST_AUDIENCE, deps));
    expect(deps.calls).toBe(2);
    for (let i = 0; i < 3; i++) await expect401(verifyIapJwt(signJwt(stranger), TEST_AUDIENCE, deps));
    expect(deps.calls).toBe(2);
  });

  it("does not cache a failed key fetch", async () => {
    const { deps } = fakeDeps([key]);
    let fail = true;
    const flaky = {
      async getKeys() {
        if (fail) throw new Error("network");
        return deps.getKeys();
      },
      now: deps.now,
    };
    await expect401(verifyIapJwt(signJwt(key), TEST_AUDIENCE, flaky));
    fail = false;
    expect(await verifyIapJwt(signJwt(key), TEST_AUDIENCE, flaky)).toMatchObject({ email: "someone@opptra.com" });
  });
});

// Test helper: a locally generated ES256 key pair and an IAP-shaped JWT signer. Nothing calls Google.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { IAP_ISSUER } from "../../lib/iap";

export const TEST_AUDIENCE = "/projects/123456789/locations/asia-south1/services/catalog-web";

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  /** PEM public key, the format getIapPublicKeys() returns (key id -> PEM). */
  publicPem: string;
}

export function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid, privateKey, publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** Signs an IAP-like JWT; `claims` override the defaults (right aud, iss, a 10 minute exp). */
export function signJwt(key: TestKey, claims: Record<string, unknown> = {}, kid = key.kid): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "ES256", typ: "JWT", kid });
  const payload = b64url({
    aud: TEST_AUDIENCE,
    iss: IAP_ISSUER,
    iat: now,
    exp: now + 600,
    sub: "accounts.google.com:1234567890",
    email: "someone@opptra.com",
    ...claims,
  });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363", // JOSE (r||s) form, as IAP sends it
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/** IapDeps whose getKeys returns the given keys and counts its calls; `clock.t` drives now(). */
export function fakeDeps(keys: TestKey[]) {
  const clock = { t: 1_000_000 };
  const deps = {
    calls: 0,
    keys,
    async getKeys() {
      deps.calls++;
      return Object.fromEntries(deps.keys.map((k) => [k.kid, k.publicPem]));
    },
    now: () => clock.t,
  };
  return { deps, clock };
}

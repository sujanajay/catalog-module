// Verifies the signed IAP header (spec 03, "The IAP identity in the app"). IAP adds a signed JWT to
// every request it forwards; its signature is checked against Google's published IAP public keys, so
// an identity cannot be forged even if a request reached the container without passing IAP. The
// plain x-goog-authenticated-user-email header is never trusted.
import { OAuth2Client } from "google-auth-library";
import { unauthorized } from "./errors";

export const IAP_JWT_HEADER = "x-goog-iap-jwt-assertion";
export const IAP_ISSUER = "https://cloud.google.com/iap";
/** Re-fetch the keys hourly, or sooner when a token names an unknown key id (see below). */
export const IAP_KEYS_TTL_MS = 60 * 60 * 1000;
/**
 * An unknown key id triggers at most one refresh per this interval, so a stream of tokens with made-up
 * key ids cannot turn every request into a fetch of Google's key set.
 */
const UNKNOWN_KID_REFRESH_MIN_MS = 60 * 1000;

export interface IapIdentity {
  email: string;
  sub: string;
}
export interface IapDeps {
  getKeys(): Promise<Record<string, string>>;
  now?(): number;
}

let client: OAuth2Client | undefined;
const oauthClient = () => (client ??= new OAuth2Client());

/** Production keys: IAP's public keys (key id -> PEM public key), fetched from Google. */
const defaultDeps: IapDeps = {
  async getKeys() {
    return (await oauthClient().getIapPublicKeys()).pubkeys;
  },
};

interface KeysEntry {
  keys: Promise<Record<string, string>>;
  fetchedAt: number;
}
// Cached per deps object: production shares one entry (defaultDeps); each test's deps gets its own.
let keysCache = new WeakMap<IapDeps, KeysEntry>();

/** Tests only: forget every cached key set. */
export function resetIapKeysCache(): void {
  keysCache = new WeakMap();
}

function fetchKeys(deps: IapDeps, now: number): Promise<Record<string, string>> {
  const keys = deps.getKeys();
  const entry: KeysEntry = { keys, fetchedAt: now };
  keysCache.set(deps, entry);
  // A failed fetch is not cached; the next verification tries again.
  keys.catch(() => {
    if (keysCache.get(deps) === entry) keysCache.delete(deps);
  });
  return keys;
}

async function keysFor(deps: IapDeps, kid: string, now: number): Promise<Record<string, string>> {
  const entry = keysCache.get(deps);
  if (!entry || now - entry.fetchedAt >= IAP_KEYS_TTL_MS) return fetchKeys(deps, now);
  const keys = await entry.keys;
  if (Object.hasOwn(keys, kid) || now - entry.fetchedAt < UNKNOWN_KID_REFRESH_MIN_MS) return keys;
  // Unknown key id on a set older than a minute: Google may have rotated its keys; refresh once.
  return fetchKeys(deps, now);
}

/** Reads the key id and algorithm from the token header without trusting anything else in it. */
function readHeader(token: string): { kid: string; alg: string } {
  const [encoded, ...rest] = token.split(".");
  if (!encoded || rest.length !== 2) throw new Error("not a JWT");
  const header: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!header || typeof header !== "object") throw new Error("bad JWT header");
  const { kid, alg } = header as { kid?: unknown; alg?: unknown };
  if (typeof kid !== "string" || !kid || typeof alg !== "string") throw new Error("bad JWT header");
  return { kid, alg };
}

/**
 * Verifies an IAP JWT for `audience` (the exact Cloud Run audience from IAP_AUDIENCE, so a token minted
 * for any other IAP resource is refused). The library checks the ES256 signature, exp, iss and aud;
 * this function then requires non-empty email and sub claims. Any failure throws
 * HttpError(401, "Sign in to continue.").
 */
export async function verifyIapJwt(token: string, audience: string, deps: IapDeps = defaultDeps): Promise<IapIdentity> {
  try {
    if (!token || !audience) throw new Error("missing token or audience");
    const { kid, alg } = readHeader(token);
    // IAP signs with ES256 only.
    if (alg !== "ES256") throw new Error(`unexpected alg ${alg}`);
    const now = deps.now?.() ?? Date.now();
    const keys = await keysFor(deps, kid, now);
    const ticket = await oauthClient().verifySignedJwtWithCertsAsync(token, keys, audience, [IAP_ISSUER]);
    const payload = ticket.getPayload();
    const email = payload?.email;
    const sub = payload?.sub;
    if (typeof email !== "string" || !email || typeof sub !== "string" || !sub) {
      throw new Error("token has no email or sub");
    }
    return { email: email.toLowerCase(), sub };
  } catch {
    throw unauthorized();
  }
}

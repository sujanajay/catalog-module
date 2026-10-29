import { GoogleAuth } from "google-auth-library";
import { cloudRunAudience } from "./cloud-run";

/** Mints a Google ID token for an audience (a Cloud Run service URL); tests pass a fake. */
export type IdTokenFor = (audience: string) => Promise<string>;

/**
 * The ID token minter the worker's service clients share: application default credentials (the metadata server on
 * Cloud Run), one GoogleAuth per minter so its token cache is reused across calls. Kept apart from cloud-run.ts so
 * that module stays free of google-auth-library for its other importers.
 */
export function googleIdTokenFor(): IdTokenFor {
  const auth = new GoogleAuth();
  return async (audience) => {
    const client = await auth.getIdTokenClient(audience);
    return client.idTokenProvider.fetchIdToken(audience);
  };
}

/** True for a local http URL, which takes no ID token (the matting service on localhost in development and tests). */
export function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** The Authorization header value for a call to `url` (its Cloud Run audience), or null for a local URL. */
export async function bearerFor(url: string, idToken: IdTokenFor): Promise<string | null> {
  if (isLocalUrl(url)) return null;
  return `Bearer ${await idToken(cloudRunAudience(url))}`;
}

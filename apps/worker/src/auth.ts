// OIDC check for Cloud Tasks deliveries and Cloud Scheduler calls: the bearer token must be a
// Google-signed ID token for the service URL of WORKER_URL, issued to WORKER_SA_EMAIL (verified email).
import type { OAuth2Client } from "google-auth-library";
import { cloudRunAudience } from "@catalog/core/cloud-run";

export type IdTokenVerifier = Pick<OAuth2Client, "verifyIdToken">;

export interface AuthConfig {
  verifier: IdTokenVerifier;
  /** Expected audience (the service URL of WORKER_URL). */
  audience?: string;
  /** Expected token email (WORKER_SA_EMAIL). */
  serviceAccountEmail?: string;
  /** SKIP_OIDC=1 - local dev only. */
  skip?: boolean;
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 403 | 500; message: string };

export function authConfigFromEnv(verifier: IdTokenVerifier, env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    verifier,
    audience: env.WORKER_URL ? cloudRunAudience(env.WORKER_URL.replace(/\/+$/, "")) : undefined,
    serviceAccountEmail: env.WORKER_SA_EMAIL || undefined,
    skip: env.SKIP_OIDC === "1",
  };
}

export async function authorize(authorization: string | undefined, cfg: AuthConfig): Promise<AuthResult> {
  if (cfg.skip) return { ok: true };
  if (!cfg.audience || !cfg.serviceAccountEmail) {
    return { ok: false, status: 500, message: "Worker auth not configured: set WORKER_URL and WORKER_SA_EMAIL" };
  }
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
  if (!m) return { ok: false, status: 401, message: "Missing bearer token" };
  let payload: { email?: string; email_verified?: boolean } | undefined;
  try {
    const ticket = await cfg.verifier.verifyIdToken({ idToken: m[1]!, audience: cfg.audience });
    payload = ticket.getPayload();
  } catch {
    return { ok: false, status: 401, message: "Invalid token" };
  }
  if (!payload || payload.email !== cfg.serviceAccountEmail || payload.email_verified !== true) {
    return { ok: false, status: 403, message: "Token not issued to the worker service account" };
  }
  return { ok: true };
}

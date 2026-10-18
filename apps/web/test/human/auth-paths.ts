// Where the tier 4 (human-like) tests keep the saved browser sign-in state. The folder is git-ignored
// and excluded from Cloud Build uploads (.gitignore and .gcloudignore both list ".playwright"): the
// files hold IAP's session cookie, so they never leave the tester's machine.
import path from "node:path";

/** apps/web/.playwright */
export const AUTH_DIR = path.resolve(__dirname, "../../.playwright");
/** The admin (or any signed-in) state: written by login.ts, read by every *.human.spec.ts. */
export const ADMIN_STATE = path.join(AUTH_DIR, "auth-state.json");
/** Optional second account that is a viewer: `login.ts viewer`. */
export const VIEWER_STATE = path.join(AUTH_DIR, "auth-state-viewer.json");

/** The deployed web URL, e.g. https://catalog-web-<project-number>.asia-south1.run.app */
export function webUrl(): string {
  const url = process.env.WEB_URL;
  if (!url) {
    throw new Error(
      "Set WEB_URL to the deployed web address first, for example " +
        "$env:WEB_URL = 'https://catalog-web-<project-number>.asia-south1.run.app' in PowerShell.",
    );
  }
  return url;
}

/**
 * The ID token audience for a call to `url`. Cloud Run checks the token's `aud` against the service URL, also when
 * the call goes to a traffic tag URL (https://<tag>---<service host>), so a run.app URL becomes its service origin:
 * the tag prefix, path, query and trailing slash are dropped. Any other URL (local, custom) is returned unchanged.
 * Same rule as services/matting/tests/cloudrun_check.py `audience_for`.
 */
export function cloudRunAudience(url: string): string {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return url; }
  if (!parsed.hostname.endsWith(".run.app")) return url;
  const host = parsed.host, tag = host.indexOf("---");
  return `${parsed.protocol}//${tag < 0 ? host : host.slice(tag + 3)}`;
}

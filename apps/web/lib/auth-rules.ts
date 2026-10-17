// The app's own guard on who it accepts (spec 03). IAP's Google-managed client and the
// domain:opptra.com grant already restrict sign-in to Opptra accounts; this check keeps a later
// change of the IAM grant from ever widening who the app accepts.

/**
 * True when `email` is an address of exactly `allowedDomain` (case does not matter): one "@", a
 * non-empty local part, no whitespace, and the part after "@" equal to the domain (so
 * "someone@opptra.com.evil.com" and "someone@evil-opptra.com" are refused).
 */
export function allowedEmail(email: string, allowedDomain: string): boolean {
  const e = email.toLowerCase();
  const domain = allowedDomain.toLowerCase();
  if (!domain || /\s/.test(e)) return false;
  const [local, ...rest] = e.split("@");
  if (rest.length !== 1 || !local) return false;
  return e.endsWith("@" + domain);
}

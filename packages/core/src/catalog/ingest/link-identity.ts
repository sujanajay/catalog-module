// What makes two links the same file without reading them. Kept apart so it stays one definition.

/** Parameters that only sign or date a link. Anything else in a query may name the file (`img?id=1`, Drive `uc?id=`). */
const ALWAYS_SIGNING = /^(x-amz-.+|x-goog-.+)$/i;
/** `token` signs a link only when the path already names a file (Supabase, Firebase); in `/download?token=AAA` it may be the file. */
const FILE_IN_PATH = /\.[a-z0-9]{1,5}$/i;
/** Short names that only sign a link when the signature itself is there: Azure's `sig`, and `Signature` on S3 and CloudFront. */
const SIGNED_WITH: readonly { mark: string; params: RegExp }[] = [
  { mark: "sig", params: /^(sig|se|sp|st|sv|sr|spr|skoid|sktid|skt|ske|sks|skv)$/i },
  { mark: "signature", params: /^(signature|expires|awsaccesskeyid|googleaccessid|policy|key-pair-id)$/i },
];

/**
 * A link without its signing parameters and fragment. Two links are the same file only when this is equal; every other
 * query parameter stays, so links that differ in it are different files until their bytes prove otherwise. Treating two
 * same files as different costs a counted row; the reverse loses a photo, so an unknown parameter always stays.
 */
export function linkIdentity(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const names = [...parsed.searchParams.keys()];
  const signing = SIGNED_WITH.filter((s) => names.some((n) => n.toLowerCase() === s.mark));
  const tokenSigns = FILE_IN_PATH.test(parsed.pathname);
  const kept = [...parsed.searchParams.entries()].filter(([n]) => !ALWAYS_SIGNING.test(n) && !(tokenSigns && n.toLowerCase() === "token") && !signing.some((s) => s.params.test(n)));
  parsed.search = new URLSearchParams(kept).toString();
  parsed.hash = "";
  return parsed.toString();
}

// Safe URL fetching (spec 02, "safe URL"). "SSRF" is the attack where a server is tricked into
// fetching an internal address; these checks prevent it:
// - assertSafeUrl: https only, no user:password, no internal host names, no private IP literals.
// - safeFetch: also resolves the host name and refuses private, loopback, link-local and metadata
//   addresses; follows redirects by hand, re-checking every hop; stops once maxBytes is exceeded.
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export interface SafeFetchOptions {
  fetch?: typeof fetch;
  /** Default 40 MB. */
  maxBytes?: number;
  /** Per hop. Default 60 s. */
  timeoutMs?: number;
  /** Default 5. */
  maxRedirects?: number;
  /** Resolves a host name to its addresses. Defaults to the system resolver; tests inject a fake. */
  lookup?: (hostname: string) => Promise<string[]>;
}

export const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;
export const DEFAULT_SAFE_FETCH_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_REDIRECTS = 5;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, includes the 169.254.169.254 metadata server
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form (::a.b.c.d)
  ["fc00::", 7], // unique local, includes the fd00:ec2::254 metadata address
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal"]);

/** IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) IPv6 address. */
function embeddedIpv4(ip: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(?:0+:)?(.+)$/i.exec(ip);
  if (!m) return null;
  const tail = m[1]!;
  if (isIP(tail) === 4) return tail;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for private, loopback, link-local, metadata and other non-public addresses. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return blocked.check(ip, "ipv4");
  if (kind === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4) return blocked.check(v4, "ipv4");
    return blocked.check(ip, "ipv6");
  }
  return true; // not an IP at all: refuse rather than guess
}

/** https only; the host must not be an internal name or a private, loopback, link-local or metadata IP. */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`Not a valid link: ${raw}`);
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError(`Only https links can be used: ${raw}`);
  if (url.username || url.password) throw new UnsafeUrlError(`Links with a user name or password cannot be used: ${url.host}`);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new UnsafeUrlError(`Links to internal addresses cannot be used: ${url.hostname}`);
  }
  if (isIP(host) && isPrivateIp(host)) {
    throw new UnsafeUrlError(`Links to internal addresses cannot be used: ${url.hostname}`);
  }
  return url;
}

async function systemLookup(hostname: string): Promise<string[]> {
  const res = await dnsLookup(hostname, { all: true, verbatim: true });
  return res.map((r) => r.address);
}

async function assertPublicHost(url: URL, lookup: (hostname: string) => Promise<string[]>): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return; // literal already checked by assertSafeUrl
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new UnsafeUrlError(`Could not find the server for ${url.hostname}.`);
  }
  if (!addresses.length || addresses.some(isPrivateIp)) {
    throw new UnsafeUrlError(`Links to internal addresses cannot be used: ${url.hostname}`);
  }
}

const isRedirect = (status: number) => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  const tooLarge = () => new Error(`The file at ${url} is larger than ${megabytes(maxBytes)}.`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * GET an https URL safely: every hop (the first URL and each redirect) passes assertSafeUrl and a
 * DNS check, redirects are followed by hand up to `maxRedirects`, and the body is streamed and
 * stopped once it exceeds `maxBytes`. A non-2xx final answer throws a plain error.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<{ buf: Buffer; mime: string; finalUrl: string; status: number }> {
  const f = opts.fetch ?? globalThis.fetch;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SAFE_FETCH_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const lookup = opts.lookup ?? systemLookup;

  let current = url;
  for (let hop = 0; ; hop++) {
    const target = assertSafeUrl(current);
    await assertPublicHost(target, lookup);
    let res: Response;
    try {
      res = await f(target.href, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(`Downloading ${target.href} took longer than ${Math.round(timeoutMs / 1000)} seconds.`, { cause: err });
      }
      throw new Error(`Could not download ${target.href}: ${(err as Error)?.message ?? String(err)}`, { cause: err });
    }

    if (isRedirect(res.status)) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`${target.href} redirected without saying where to.`);
      if (hop >= maxRedirects) throw new Error(`${url} redirected more than ${maxRedirects} times.`);
      current = new URL(location, target).href;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Could not download ${target.href}: the server answered ${res.status}.`);
    }
    const buf = await readCapped(res, maxBytes, target.href);
    const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() || "application/octet-stream";
    return { buf, mime, finalUrl: target.href, status: res.status };
  }
}

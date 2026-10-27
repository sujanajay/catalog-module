import dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeUrl, isPrivateIp, safeFetch, UnsafeUrlError } from "./safe-url";

const PUBLIC_IP = "34.120.10.10";
const DNS: Record<string, string[]> = {
  "a.example.com": [PUBLIC_IP],
  "b.example.com": [PUBLIC_IP],
  "c.example.com": [PUBLIC_IP],
  "evil.example.com": ["10.0.0.5"],
  "mixed.example.com": [PUBLIC_IP, "127.0.0.1"],
};
const lookup = async (host: string) => {
  const found = DNS[host];
  if (!found) throw new Error(`ENOTFOUND ${host}`);
  return found;
};

type Reply = { status: number; headers?: Record<string, string>; body?: Uint8Array<ArrayBuffer> | string };
function fakeFetch(routes: Record<string, Reply>) {
  const calls: { url: string; redirect: RequestRedirect | undefined }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, redirect: init?.redirect });
    const r = routes[url];
    if (!r) throw new Error(`fakeFetch: no route for ${url}`);
    return new Response(r.body ?? null, { status: r.status, headers: r.headers });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

describe("assertSafeUrl", () => {
  it("accepts public https links", () => {
    expect(assertSafeUrl("https://storage.googleapis.com/b/x.jpg").hostname).toBe("storage.googleapis.com");
    expect(assertSafeUrl(`https://${PUBLIC_IP}/x.jpg`).hostname).toBe(PUBLIC_IP);
  });

  it.each([
    "http://example.com/x.jpg",
    "ftp://example.com/x.jpg",
    "file:///etc/passwd",
    "not a url",
    "https://user:pw@example.com/x.jpg",
    "https://localhost/x",
    "https://foo.localhost/x",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://169.254.169.254/latest/meta-data",
    "https://127.0.0.1/x",
    "https://0x7f.0.0.1/x",
    "https://10.1.2.3/x",
    "https://172.20.0.1/x",
    "https://192.168.1.1/x",
    "https://[::1]/x",
    "https://[fe80::1]/x",
    "https://[fd00:ec2::254]/x",
    "https://[::ffff:127.0.0.1]/x",
  ])("refuses %s", (raw) => {
    expect(() => assertSafeUrl(raw)).toThrow(UnsafeUrlError);
  });

  it("classifies addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("2606:4700::1111")).toBe(false);
    expect(isPrivateIp("100.64.0.1")).toBe(true);
    expect(isPrivateIp("::ffff:a9fe:a9fe")).toBe(true);
    expect(isPrivateIp("64:ff9b::a00:1")).toBe(true);
    // 6to4, Teredo and local-use NAT64 forms of 169.254.169.254
    expect(isPrivateIp("2002:a9fe:a9fe::")).toBe(true);
    expect(isPrivateIp("2001:0:4136:e378:8000:63bf:5601:5601")).toBe(true);
    expect(isPrivateIp("64:ff9b:1::a9fe:a9fe")).toBe(true);
  });

  it("keeps the query string (which can carry an access token) out of error messages", () => {
    expect(() => assertSafeUrl("http://example.com/x.jpg?sig=SECRET")).toThrow(/Only https links can be used: http:\/\/example\.com\/x\.jpg$/);
  });
});

describe("safeFetch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("checks the address again at connect time (DNS rebinding)", async () => {
    // The pre-check sees a public address; the lookup made while connecting answers loopback.
    vi.spyOn(dns, "lookup").mockImplementation(((_host: string, opts: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
      if (opts?.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
      else cb(null, "127.0.0.1", 4);
    }) as unknown as typeof dns.lookup);
    await expect(safeFetch("https://rebind.example.com/x", { lookup: async () => [PUBLIC_IP] })).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it("names the link without its query string when the download fails", async () => {
    const f = fakeFetch({ "https://c.example.com/x.jpg?sig=SECRET": { status: 403 } });
    const err = await safeFetch("https://c.example.com/x.jpg?sig=SECRET", { fetch: f, lookup }).catch((e: Error) => e);
    expect(String(err)).toMatch(/c\.example\.com\/x\.jpg: the server answered 403/);
    expect(String(err)).not.toContain("SECRET");
  });

  it("follows two redirects, re-checking each hop, and returns the body", async () => {
    const f = fakeFetch({
      "https://a.example.com/start": { status: 302, headers: { location: "https://b.example.com/next" } },
      "https://b.example.com/next": { status: 301, headers: { location: "/final.jpg" } },
      "https://b.example.com/final.jpg": { status: 200, headers: { "content-type": "image/jpeg; charset=binary" }, body: "JPEGDATA" },
    });
    const r = await safeFetch("https://a.example.com/start", { fetch: f, lookup });
    expect(r.buf.toString()).toBe("JPEGDATA");
    expect(r.mime).toBe("image/jpeg");
    expect(r.finalUrl).toBe("https://b.example.com/final.jpg");
    expect(r.status).toBe(200);
    expect(f.calls).toHaveLength(3);
    expect(f.calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("rejects a redirect to a private IP without fetching it", async () => {
    const f = fakeFetch({
      "https://a.example.com/start": { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } },
    });
    await expect(safeFetch("https://a.example.com/start", { fetch: f, lookup })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(f.calls).toHaveLength(1);
  });

  it("rejects a redirect to a host name that resolves to a private address", async () => {
    const f = fakeFetch({
      "https://a.example.com/start": { status: 307, headers: { location: "https://evil.example.com/x" } },
    });
    await expect(safeFetch("https://a.example.com/start", { fetch: f, lookup })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(safeFetch("https://mixed.example.com/x", { fetch: f, lookup })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(f.calls).toHaveLength(1);
  });

  it("stops at maxBytes while streaming", async () => {
    const f = fakeFetch({ "https://a.example.com/big": { status: 200, body: new Uint8Array(2048) } });
    await expect(safeFetch("https://a.example.com/big", { fetch: f, lookup, maxBytes: 1000 })).rejects.toThrow(/larger than/);
    const ok = await safeFetch("https://a.example.com/big", { fetch: f, lookup, maxBytes: 4096 });
    expect(ok.buf.length).toBe(2048);
  });

  it("refuses an oversized declared content-length before reading", async () => {
    const f = fakeFetch({ "https://a.example.com/big": { status: 200, headers: { "content-length": "999999" }, body: "x" } });
    await expect(safeFetch("https://a.example.com/big", { fetch: f, lookup, maxBytes: 10 })).rejects.toThrow(/larger than/);
  });

  it("stops after maxRedirects", async () => {
    const f = fakeFetch({
      "https://a.example.com/1": { status: 302, headers: { location: "https://a.example.com/2" } },
      "https://a.example.com/2": { status: 302, headers: { location: "https://a.example.com/1" } },
    });
    await expect(safeFetch("https://a.example.com/1", { fetch: f, lookup, maxRedirects: 3 })).rejects.toThrow(/more than 3 times/);
    expect(f.calls).toHaveLength(4);
  });

  it("throws a plain error on a non-2xx answer", async () => {
    const f = fakeFetch({ "https://c.example.com/missing.jpg": { status: 404, body: "not found" } });
    await expect(safeFetch("https://c.example.com/missing.jpg", { fetch: f, lookup })).rejects.toThrow(/answered 404/);
  });
});

describe("safeFetch headers and truncateAt (spec 14b F2)", () => {
  /** Fake fetch that records the headers of every request and streams a large body in chunks. */
  function recording(routes: Record<string, Reply & { chunks?: number }>) {
    const calls: { url: string; headers: Record<string, string>; cancelled: boolean }[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const call = { url, headers: { ...(init?.headers as Record<string, string> | undefined) }, cancelled: false };
      calls.push(call);
      const r = routes[url];
      if (!r) throw new Error(`fakeFetch: no route for ${url}`);
      if (!r.chunks) return new Response(r.body ?? null, { status: r.status, headers: r.headers });
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ >= r.chunks!) return controller.close();
          controller.enqueue(new Uint8Array(700).fill(sent));
        },
        cancel() { call.cancelled = true; },
      });
      return new Response(body, { status: r.status, headers: r.headers });
    }) as typeof fetch;
    return Object.assign(fn, { calls });
  }

  it("truncateAt 1024 returns 1,024 bytes and status 404 without throwing, and cancels the rest", async () => {
    const f = recording({ "https://a.example.com/missing.jpg": { status: 404, headers: { "content-type": "text/html" }, chunks: 10 } });
    const r = await safeFetch("https://a.example.com/missing.jpg", { fetch: f, lookup, truncateAt: 1024 });
    expect(r.status).toBe(404);
    expect(r.buf.length).toBe(1024);
    expect(r.mime).toBe("text/html");
    expect(f.calls[0]!.cancelled).toBe(true);
  });

  it("truncateAt returns a short body whole", async () => {
    const f = recording({ "https://a.example.com/a.jpg": { status: 206, headers: { "content-type": "image/jpeg" }, body: "JPEG" } });
    const r = await safeFetch("https://a.example.com/a.jpg", { fetch: f, lookup, truncateAt: 1024 });
    expect([r.status, r.buf.toString(), r.mime]).toEqual([206, "JPEG", "image/jpeg"]);
  });

  it("sends the headers on every redirect hop", async () => {
    const f = recording({
      "https://a.example.com/start": { status: 302, headers: { location: "https://b.example.com/next" } },
      "https://b.example.com/next": { status: 301, headers: { location: "/final.jpg" } },
      "https://b.example.com/final.jpg": { status: 206, headers: { "content-type": "image/jpeg" }, body: "JPEG" },
    });
    await safeFetch("https://a.example.com/start", { fetch: f, lookup, headers: { Range: "bytes=0-1023" }, truncateAt: 1024 });
    expect(f.calls.map((c) => [c.url, c.headers.Range])).toEqual([
      ["https://a.example.com/start", "bytes=0-1023"],
      ["https://b.example.com/next", "bytes=0-1023"],
      ["https://b.example.com/final.jpg", "bytes=0-1023"],
    ]);
  });

  it("still throws for an unsafe link with truncateAt, and sends no headers without the option", async () => {
    const f = recording({ "https://a.example.com/start": { status: 302, headers: { location: "https://169.254.169.254/x" } }, "https://c.example.com/x.jpg": { status: 200, body: "x" } });
    await expect(safeFetch("https://a.example.com/start", { fetch: f, lookup, truncateAt: 1024 })).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(safeFetch("http://c.example.com/x.jpg", { fetch: f, lookup, truncateAt: 1024 })).rejects.toBeInstanceOf(UnsafeUrlError);
    await safeFetch("https://c.example.com/x.jpg", { fetch: f, lookup });
    expect(f.calls.at(-1)!.headers).toEqual({});
  });
});

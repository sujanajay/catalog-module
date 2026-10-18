import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRangeStream,
  deletePublicObject,
  deleteTestObjects,
  downloadBuffer,
  extFromMime,
  GenerationMismatchError,
  getPublicBucketName,
  headObject,
  listObjects,
  mimeFromPath,
  parseGsUri,
  PUBLIC_CACHE_CONTROL,
  readRange,
  setCustomTime,
  setStorageClient,
  setStorageSleep,
  signedPutUrl,
  signedUrl,
  stageCopyToPublic,
  STORAGE_RETRIES,
  toGsUri,
  uploadBuffer,
  type StorageLike,
} from "./storage";

const apiError = (code: number | string, message = "boom") => Object.assign(new Error(message), { code });

describe("path and uri helpers", () => {
  it("round-trips gs:// uris", () => {
    expect(toGsUri("bkt", "/a/b.png")).toBe("gs://bkt/a/b.png");
    expect(parseGsUri("gs://bkt/a/b/c.png")).toEqual({ bucket: "bkt", path: "a/b/c.png" });
    expect(() => parseGsUri("https://x/y")).toThrow();
    expect(() => parseGsUri("gs://bkt")).toThrow();
  });

  it("maps mime types and extensions", () => {
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("image/png; charset=binary")).toBe("png");
    expect(extFromMime("application/x-unknown")).toBe("bin");
    expect(mimeFromPath("a/b.JPEG")).toBe("image/jpeg");
    expect(mimeFromPath("a/b.webp")).toBe("image/webp");
    expect(mimeFromPath("a/b.xyz")).toBe("application/octet-stream");
  });

  it("public bucket name defaults to image-links-agent-public", () => {
    expect(getPublicBucketName({})).toBe("image-links-agent-public");
    expect(getPublicBucketName({ PUBLIC_BUCKET: "other" })).toBe("other");
  });
});

describe("GCS operations (fake client)", () => {
  const save = vi.fn();
  const download = vi.fn();
  const getMetadata = vi.fn();
  const getSignedUrl = vi.fn();
  const createReadStream = vi.fn();
  const copy = vi.fn();
  const del = vi.fn();
  const setMetadata = vi.fn();
  const getFiles = vi.fn();
  const sleep = vi.fn((_ms: number) => Promise.resolve());

  interface FakeFile {
    bucketName: string;
    name: string;
    save: typeof save;
    download: typeof download;
    getMetadata: typeof getMetadata;
    getSignedUrl: typeof getSignedUrl;
    createReadStream: typeof createReadStream;
    copy: typeof copy;
    delete: typeof del;
    setMetadata: typeof setMetadata;
  }
  const file = vi.fn(
    (bucketName: string, name: string): FakeFile => ({
      bucketName,
      name,
      save,
      download,
      getMetadata,
      getSignedUrl,
      createReadStream,
      copy,
      delete: del,
      setMetadata,
    }),
  );
  const bucket = vi.fn((name: string) => ({ file: (p: string) => file(name, p), getFiles }));

  beforeEach(() => {
    vi.clearAllMocks();
    save.mockResolvedValue(undefined);
    download.mockResolvedValue([Buffer.from("hello")]);
    getMetadata.mockResolvedValue([{ contentType: "image/png" }]);
    getSignedUrl.mockResolvedValue(["https://signed.example/x"]);
    del.mockResolvedValue([{}]);
    setMetadata.mockResolvedValue([{}]);
    getFiles.mockResolvedValue([[]]);
    vi.stubEnv("BUCKET", "image-links-agent-assets");
    vi.stubEnv("PUBLIC_BUCKET", "");
    setStorageClient({ bucket } as unknown as StorageLike);
    setStorageSleep(sleep);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setStorageClient(undefined);
    setStorageSleep(undefined);
  });

  it("uploadBuffer saves to BUCKET and returns gs:// uri", async () => {
    const uri = await uploadBuffer("catalog/uspa/b1/raw/A/A_1.jpg", Buffer.from("x"), "image/jpeg");
    expect(uri).toBe("gs://image-links-agent-assets/catalog/uspa/b1/raw/A/A_1.jpg");
    expect(bucket).toHaveBeenCalledWith("image-links-agent-assets");
    expect(save).toHaveBeenCalledWith(Buffer.from("x"), { contentType: "image/jpeg", resumable: false });
  });

  it("downloadBuffer reads bytes and content type", async () => {
    expect(await downloadBuffer("gs://other/a.png")).toEqual({ buf: Buffer.from("hello"), mime: "image/png" });
    expect(bucket).toHaveBeenCalledWith("other");
  });

  it("uploadBuffer saves optional staging cache metadata without changing legacy defaults", async () => {
    await uploadBuffer("catalog/uspa/b1/staging/A/noon/A_1.jpg", Buffer.from("x"), "image/jpeg", { cacheControl: PUBLIC_CACHE_CONTROL });
    expect(save).toHaveBeenCalledWith(Buffer.from("x"), { contentType: "image/jpeg", resumable: false, metadata: { cacheControl: PUBLIC_CACHE_CONTROL } });
  });

  it("signedUrl requests a v4 read url and clamps ttl to 7 days", async () => {
    const now = Date.now();
    expect(await signedUrl("gs://bkt/a.png", 30 * 86400)).toBe("https://signed.example/x");
    const opts = getSignedUrl.mock.calls[0]![0] as { version: string; action: string; expires: number };
    expect(opts.version).toBe("v4");
    expect(opts.action).toBe("read");
    expect(opts.expires - now).toBeLessThanOrEqual(7 * 86400 * 1000 + 1000);
    expect(opts.expires - now).toBeGreaterThan(7 * 86400 * 1000 - 5000);
  });

  it("signedPutUrl passes v4, write and the content type with a 900 s default ttl", async () => {
    const now = Date.now();
    expect(await signedPutUrl("catalog/uspa/b1/uploads/u1/a.zip", "application/zip")).toBe("https://signed.example/x");
    expect(file).toHaveBeenCalledWith("image-links-agent-assets", "catalog/uspa/b1/uploads/u1/a.zip");
    const opts = getSignedUrl.mock.calls[0]![0] as { version: string; action: string; contentType: string; expires: number };
    expect(opts).toMatchObject({ version: "v4", action: "write", contentType: "application/zip" });
    expect(opts.expires - now).toBeGreaterThan(900 * 1000 - 5000);
    expect(opts.expires - now).toBeLessThanOrEqual(900 * 1000 + 1000);
  });

  it("headObject returns size, type, generation and crc32c, or exists false on 404", async () => {
    getMetadata.mockResolvedValueOnce([{ size: "123", contentType: "image/jpeg", generation: "1700000000000001", crc32c: "abc==" }]);
    expect(await headObject("gs://b/p.jpg")).toEqual({
      exists: true,
      size: 123,
      contentType: "image/jpeg",
      generation: "1700000000000001",
      crc32c: "abc==",
    });
    getMetadata.mockRejectedValueOnce(apiError(404, "No such object"));
    expect(await headObject("gs://b/missing.jpg")).toEqual({ exists: false, size: null, contentType: null, generation: null, crc32c: null });
  });

  it("readRange and createRangeStream pass an inclusive end", async () => {
    await readRange("gs://b/big.zip", 10, 19);
    expect(download).toHaveBeenCalledWith({ start: 10, end: 19 });
    createReadStream.mockReturnValue("stream");
    expect(createRangeStream("gs://b/big.zip", 0, 0)).toBe("stream");
    expect(createReadStream).toHaveBeenCalledWith({ start: 0, end: 0 });
    await expect(readRange("gs://b/big.zip", 5, 4)).rejects.toThrow(/Invalid byte range/);
  });

  it("listObjects returns gs:// uris under the prefix", async () => {
    getFiles.mockResolvedValueOnce([[{ name: "catalog/uspa/b1/raw/A/A_1.jpg" }, { name: "catalog/uspa/b1/raw/A/A_2.jpg" }]]);
    expect(await listObjects("gs://assets/catalog/uspa/b1/raw/")).toEqual([
      "gs://assets/catalog/uspa/b1/raw/A/A_1.jpg",
      "gs://assets/catalog/uspa/b1/raw/A/A_2.jpg",
    ]);
    expect(getFiles).toHaveBeenCalledWith({ prefix: "catalog/uspa/b1/raw/", autoPaginate: true });
  });

  describe("stageCopyToPublic", () => {
    const staging = "gs://image-links-agent-assets/catalog/uspa/b1/staging/ABC123/noon/ABC123_2.jpg";
    const target = "catalog/uspa/ABC123/noon/ABC123_2.jpg";

    it.each([0, "1700000000000001"])("passes ifGenerationMatch %s exactly, jpeg type and cache header", async (gen) => {
      const copied = { metadata: {}, getMetadata: vi.fn() };
      copy.mockResolvedValueOnce([copied, { resource: { generation: "1700000000000999", crc32c: "crc==" } }]);
      const r = await stageCopyToPublic(staging, target, { ifGenerationMatch: gen });
      expect(r).toEqual({ generation: "1700000000000999", crc32c: "crc==" });
      expect(copy).toHaveBeenCalledTimes(1);
      const [dest, opts] = copy.mock.calls[0]!;
      expect(dest).toMatchObject({ bucketName: "image-links-agent-public", name: target });
      expect(opts).toEqual({
        preconditionOpts: { ifGenerationMatch: gen },
        contentType: "image/jpeg",
        cacheControl: "public, max-age=300",
      });
      expect(PUBLIC_CACHE_CONTROL).toBe("public, max-age=300");
      expect(file).toHaveBeenCalledWith("image-links-agent-assets", "catalog/uspa/b1/staging/ABC123/noon/ABC123_2.jpg");
    });

    it("falls back to the copied file's metadata", async () => {
      copy.mockResolvedValueOnce([{ metadata: { generation: 42, crc32c: "m==" } }, {}]);
      expect(await stageCopyToPublic(staging, target, { ifGenerationMatch: 0 })).toEqual({ generation: "42", crc32c: "m==" });
    });

    it("turns a 412 into GenerationMismatchError without retrying", async () => {
      copy.mockRejectedValueOnce(apiError(412, "conditionNotMet"));
      const err = await stageCopyToPublic(staging, target, { ifGenerationMatch: 0 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GenerationMismatchError);
      expect((err as Error).message).toBe("Changed by another run. Start the batch again for this product.");
      expect(copy).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("retries 503, 429 and network errors with 1 s, 2 s, 4 s backoff", async () => {
      copy
        .mockRejectedValueOnce(apiError(503))
        .mockRejectedValueOnce(apiError(429))
        .mockRejectedValueOnce(apiError("ECONNRESET"))
        .mockResolvedValueOnce([{ metadata: {} }, { resource: { generation: "7", crc32c: "c==" } }]);
      expect(await stageCopyToPublic(staging, target, { ifGenerationMatch: "6" })).toEqual({ generation: "7", crc32c: "c==" });
      expect(copy).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
    });

    it("gives up after STORAGE_RETRIES retries", async () => {
      copy.mockRejectedValue(apiError(500));
      await expect(stageCopyToPublic(staging, target, { ifGenerationMatch: 0 })).rejects.toThrow("boom");
      expect(copy).toHaveBeenCalledTimes(STORAGE_RETRIES + 1);
      copy.mockReset();
    });

    it("does not retry a 403", async () => {
      copy.mockRejectedValueOnce(apiError(403));
      await expect(stageCopyToPublic(staging, target, { ifGenerationMatch: 0 })).rejects.toThrow("boom");
      expect(copy).toHaveBeenCalledTimes(1);
    });

    it("refuses a target outside catalog/ and catalog-test/", async () => {
      await expect(stageCopyToPublic(staging, "eval/uspa/ABC123/noon/ABC123_2.jpg", { ifGenerationMatch: 0 })).rejects.toThrow(/Refusing/);
      await expect(stageCopyToPublic(staging, "catalog/uspa/../x.jpg", { ifGenerationMatch: 0 })).rejects.toThrow(/Refusing/);
      expect(copy).not.toHaveBeenCalled();
    });

    it("refuses a target that is not the staged image's own product path", async () => {
      for (const other of [
        "catalog/uspa/ABC124/noon/ABC124_2.jpg", // another product
        "catalog/uspa/ABC123/namshi/ABC123_2.jpg", // another channel
        "catalog/uspa/ABC123/noon/ABC123_3.jpg", // another shot
        "catalog-test/uspa/ABC123/noon/ABC123_2.jpg", // another root
        "catalog/uspa/exports/ABC123_2.jpg",
      ]) {
        await expect(stageCopyToPublic(staging, other, { ifGenerationMatch: 0 })).rejects.toThrow(/Refusing/);
      }
      // The source must be a staged image in the private bucket.
      for (const src of [
        "gs://image-links-agent-public/catalog/uspa/ABC123/noon/ABC123_2.jpg",
        "gs://image-links-agent-assets/catalog/uspa/b1/raw/ABC123/noon/ABC123_2.jpg",
        "gs://other-bucket/catalog/uspa/b1/staging/ABC123/noon/ABC123_2.jpg",
      ]) {
        await expect(stageCopyToPublic(src, target, { ifGenerationMatch: 0 })).rejects.toThrow(/Refusing/);
      }
      expect(copy).not.toHaveBeenCalled();
    });

    it("treats a 412 after a lost answer as success when the live object is this staged image", async () => {
      copy.mockRejectedValueOnce(apiError("ECONNRESET")).mockRejectedValueOnce(apiError(412, "conditionNotMet"));
      getMetadata
        .mockResolvedValueOnce([{ crc32c: "same==", size: "10" }])
        .mockResolvedValueOnce([{ crc32c: "same==", size: "10", generation: "99", timeCreated: new Date().toISOString() }]);
      expect(await stageCopyToPublic(staging, target, { ifGenerationMatch: 0 })).toEqual({ generation: "99", crc32c: "same==" });
    });

    it("keeps GenerationMismatchError when the live object holds other bytes", async () => {
      copy.mockRejectedValueOnce(apiError(412, "conditionNotMet"));
      getMetadata
        .mockResolvedValueOnce([{ crc32c: "mine==", size: "10" }])
        .mockResolvedValueOnce([{ crc32c: "theirs==", size: "10", generation: "99", timeCreated: new Date().toISOString() }]);
      await expect(stageCopyToPublic(staging, target, { ifGenerationMatch: 0 })).rejects.toBeInstanceOf(GenerationMismatchError);
    });
  });

  describe("deletePublicObject", () => {
    const prefix = "catalog/uspa/ABC123/";

    it("passes ifGenerationMatch on the public bucket", async () => {
      expect(await deletePublicObject("catalog/uspa/ABC123/noon/ABC123_3.jpg", prefix, { ifGenerationMatch: "55" })).toBe(true);
      expect(file).toHaveBeenCalledWith("image-links-agent-public", "catalog/uspa/ABC123/noon/ABC123_3.jpg");
      expect(del).toHaveBeenCalledWith({ ifGenerationMatch: "55" });
    });

    it("refuses an out-of-prefix path before calling the client", async () => {
      await expect(deletePublicObject("catalog/uspa/ABC124/noon/ABC124_1.jpg", prefix, { ifGenerationMatch: "1" })).rejects.toThrow(/Refusing/);
      await expect(deletePublicObject("eval/uspa/ABC123/noon/x.jpg", "eval/uspa/ABC123/", { ifGenerationMatch: "1" })).rejects.toThrow(/Refusing/);
      expect(bucket).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    });

    it("412 is GenerationMismatchError; 404 means already gone", async () => {
      del.mockRejectedValueOnce(apiError(412));
      await expect(deletePublicObject("catalog/uspa/ABC123/noon/ABC123_3.jpg", prefix, { ifGenerationMatch: "1" })).rejects.toBeInstanceOf(
        GenerationMismatchError,
      );
      del.mockRejectedValueOnce(apiError(404));
      expect(await deletePublicObject("catalog/uspa/ABC123/noon/ABC123_3.jpg", prefix, { ifGenerationMatch: "1" })).toBe(false);
    });
  });

  it("setCustomTime passes an ISO string", async () => {
    await setCustomTime("gs://image-links-agent-assets/catalog/uspa/b1/raw/A/A_1.jpg", new Date("2026-10-01T12:00:00Z"));
    expect(setMetadata).toHaveBeenCalledWith({ customTime: "2026-10-01T12:00:00.000Z" });
  });

  describe("deleteTestObjects", () => {
    it("throws for a prefix outside catalog-test/ before listing", async () => {
      await expect(deleteTestObjects("gs://image-links-agent-public/catalog/uspa/")).rejects.toThrow(/catalog-test/);
      await expect(deleteTestObjects("gs://image-links-agent-assets/catalog-test/../catalog/")).rejects.toThrow(/catalog-test/);
      expect(getFiles).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
    });

    it("deletes every object under the test prefix and counts them", async () => {
      getFiles.mockResolvedValueOnce([[{ name: "catalog-test/run1/a.jpg" }, { name: "catalog-test/run1/b.jpg" }, { name: "catalog-test/run1/c.jpg" }]]);
      del.mockResolvedValueOnce([{}]).mockRejectedValueOnce(apiError(404)).mockResolvedValueOnce([{}]);
      expect(await deleteTestObjects("gs://image-links-agent-public/catalog-test/run1/")).toBe(2);
      expect(getFiles).toHaveBeenCalledWith({ prefix: "catalog-test/run1/", autoPaginate: true });
      expect(del).toHaveBeenCalledTimes(3);
    });
  });
});

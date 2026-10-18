import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { checkImage, classifyImageReject, imageFlags, readHeifSize, type ImageInfo } from "./image-check";
import { heicFixture } from "../../../test-fixtures/catalog/ingest-a/builders";

const base = (w: number, h: number, channels: 3 | 4 = 3) =>
  sharp({ create: { width: w, height: h, channels, background: channels === 4 ? { r: 200, g: 10, b: 10, alpha: 0.5 } : "#808080" } });

/** A minimal BMP file header plus DIB header (no pixel data needed: BMP is refused at the sniff). */
function bmpFixture(): Buffer {
  const b = Buffer.alloc(54);
  b.write("BM", 0, "latin1");
  b.writeUInt32LE(54, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(10, 18);
  b.writeInt32LE(10, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  return b;
}

async function ok(buf: Buffer, name: string): Promise<ImageInfo> {
  const r = await checkImage(buf.subarray(0, 4100), buf, name);
  if (!r.ok) throw new Error(`expected ok, got ${r.message}`);
  return r;
}

describe("checkImage", () => {
  it("reads jpeg, png with alpha, webp, tiff and avif", async () => {
    const jpg = await ok(await base(800, 1200).jpeg().toBuffer(), "a.jpg");
    expect(jpg).toMatchObject({ mime: "image/jpeg", ext: "jpg", width: 800, height: 1200, hasAlpha: false, pages: 1, space: "srgb" });

    const png = await ok(await base(640, 480, 4).png().toBuffer(), "a.png");
    expect(png).toMatchObject({ mime: "image/png", ext: "png", width: 640, height: 480, hasAlpha: true });

    expect(await ok(await base(600, 600).webp().toBuffer(), "a.webp")).toMatchObject({ mime: "image/webp", ext: "webp", width: 600 });
    expect(await ok(await base(600, 500).tiff().toBuffer(), "a.tif")).toMatchObject({ mime: "image/tiff", ext: "tif", height: 500 });
    expect(await ok(await base(512, 512).avif().toBuffer(), "a.avif")).toMatchObject({ mime: "image/avif", ext: "avif", width: 512 });
  });

  it("reports the frame count of a 2-frame gif and the first frame's size", async () => {
    const w = 50, h = 40;
    const raw = Buffer.alloc(w * h * 2 * 4, 255);
    raw.fill(0, 0, w * h * 4); // frames must differ or the encoder merges them
    for (let i = 3; i < raw.length; i += 4) raw[i] = 255;
    const gif = await sharp(raw, { raw: { width: w, height: h * 2, channels: 4, pageHeight: h } }).gif({ delay: [100, 100] }).toBuffer();
    const info = await ok(gif, "anim.gif");
    expect(info).toMatchObject({ mime: "image/gif", width: 50, height: 40 });
    expect(info.pages).toBeGreaterThan(1);
  });

  it("accepts a HEIC file as a normal image with the dimensions from its container", async () => {
    const heic = heicFixture(4032, 3024);
    const info = await ok(heic, "IMG_2041.heic");
    expect(info).toMatchObject({ ok: true, mime: "image/heic", ext: "heic", width: 4032, height: 3024 });
    expect(readHeifSize(heic)).toEqual({ width: 4032, height: 3024 });
    // HEIF brand mif1 is also reported as image/heic.
    expect(await ok(heicFixture(100, 200, "mif1"), "x.heif")).toMatchObject({ mime: "image/heic", width: 100, height: 200 });
    // No ispe box: still accepted, dimensions left for 05 to fill.
    expect(await ok(heicFixture(0, 0), "y.heic")).toMatchObject({ ok: true, width: 0, height: 0 });
  });

  it("refuses a BMP with its sentence", async () => {
    const r = await checkImage(bmpFixture(), bmpFixture(), "scan.bmp");
    expect(r).toEqual({ ok: false, reason: "unsupported", message: "scan.bmp is a BMP file. Save it as JPEG or PNG and add it again." });
  });

  it("calls a truncated jpeg corrupt", async () => {
    const jpg = await base(600, 400).jpeg().toBuffer();
    const cut = jpg.subarray(0, Math.floor(jpg.length / 2));
    expect(await checkImage(cut.subarray(0, 4100), cut, "half.jpg")).toEqual({
      ok: false, reason: "corrupt", message: "half.jpg is corrupt (cannot be decoded).",
    });
  });

  it("calls a PDF, an empty file and random bytes not an image", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n", "latin1");
    expect(await checkImage(pdf, pdf, "lookbook.pdf")).toEqual({ ok: false, reason: "not_image", message: "lookbook.pdf is not an image." });
    expect(await checkImage(Buffer.alloc(0), Buffer.alloc(0), "empty.jpg")).toMatchObject({ ok: false, reason: "not_image" });
    expect(await checkImage(Buffer.from("hello world"), null, "notes.txt")).toMatchObject({ ok: false, reason: "not_image" });
  });

  it("flags a 400 px image small_source and a 500 px one not", async () => {
    expect(imageFlags(await ok(await base(400, 300).jpeg().toBuffer(), "small.jpg"))).toEqual(["small_source"]);
    expect(imageFlags(await ok(await base(500, 300).jpeg().toBuffer(), "edge.jpg"))).toEqual([]);
    expect(imageFlags(await ok(heicFixture(0, 0), "unknown.heic"))).toEqual([]);
  });

  it("classifies its own reject sentences and nothing else", () => {
    expect(classifyImageReject("scan.bmp is a BMP file. Save it as JPEG or PNG and add it again.")).toBe("unsupported");
    expect(classifyImageReject("half.jpg is corrupt (cannot be decoded).")).toBe("corrupt");
    expect(classifyImageReject("lookbook.pdf is not an image.")).toBe("not_image");
    expect(classifyImageReject("Two files claim shot 1 of ABC: a.jpg, b.jpg. Rename one and re-upload.")).toBeNull();
  });
});

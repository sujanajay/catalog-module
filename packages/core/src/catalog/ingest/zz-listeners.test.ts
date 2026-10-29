import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { buildZip } from "../../../test-fixtures/catalog/ingest-a/builders";
import { openZipReader } from "./zip";

it("probe", async () => {
  const warnings: Error[] = [];
  process.on("warning", w => warnings.push(w));
  const zip = buildZip(Array.from({ length: 400 }, (_, i) => ({ path: `a/P${i}_1.jpg`, data: Buffer.alloc(5000, i) })));
  const storage = {
    headObject: async () => ({ exists: true, size: zip.length, contentType: null, generation: "1", crc32c: null }),
    createRangeStream: (_u: string, s: number, e: number) => Readable.from([zip.subarray(s, e + 1)]),
  };
  const reader = await openZipReader(storage as never, "gs://b/catalog-test/x.zip");
  await Promise.all(Array.from({ length: 400 }, async (_, i) => { for await (const _c of reader.entryStream(`a/P${i}_1.jpg`)) { /* drain */ } }));
  await new Promise(r => setTimeout(r, 200));
  for (const w of warnings) console.log(w.name, w.message, w.stack);
  expect(warnings.length).toBe(0);
});

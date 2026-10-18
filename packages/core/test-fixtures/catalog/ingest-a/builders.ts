// Fixture builders for the ingestion tests (spec 04, workstream A). Everything is generated in the
// test, so no binary fixtures are checked in.
import { crc32, deflateRawSync } from "node:zlib";

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

const u32 = (...values: number[]) => {
  const b = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => b.writeUInt32BE(v, i * 4));
  return b;
};

/**
 * A minimal HEIF container: `ftyp` (major brand `heic` or `mif1`) and `meta/iprp/ipco` holding a
 * 160x120 thumbnail `ispe` and the image's own `ispe`. No coded image data: nothing decodes HEIC
 * at ingest. `width = 0` leaves the ispe boxes out.
 */
export function heicFixture(width: number, height: number, brand: "heic" | "mif1" = "heic"): Buffer {
  const ftyp = box("ftyp", Buffer.from(brand, "latin1"), u32(0), Buffer.from("mif1heic", "latin1"));
  const ispe = (w: number, h: number) => box("ispe", u32(0), u32(w, h));
  const hdlr = box("hdlr", u32(0, 0), Buffer.from("pict", "latin1"), u32(0, 0, 0), Buffer.from([0]));
  const props = width > 0 ? [ispe(160, 120), ispe(width, height)] : [box("colr", Buffer.from("nclx", "latin1"), Buffer.alloc(7))];
  const meta = box("meta", u32(0), hdlr, box("iprp", box("ipco", ...props)));
  return Buffer.concat([ftyp, meta, box("mdat", Buffer.alloc(16))]);
}

export interface ZipEntryInput {
  path: string;
  data?: Buffer;          // omitted for a directory entry (path ending in "/")
  compress?: boolean;     // deflate instead of store
}

/** A zip archive (no zip64, no data descriptors) built with node:zlib only. */
export function buildZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, "utf8");
    const raw = e.data ?? Buffer.alloc(0);
    const method = e.compress && raw.length ? 8 : 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

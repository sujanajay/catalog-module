import sharp, { type OverlayOptions } from "sharp";

export async function contactSheet(items: { label: string; jpeg: Buffer }[], columns: number): Promise<Buffer> {
  if (!Number.isInteger(columns) || columns < 1) throw new Error("Contact sheet columns must be a positive integer");
  const width = 260, height = 290, cols = Math.min(columns, Math.max(1, items.length));
  const overlays: OverlayOptions[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!, left = (i % cols) * width, top = Math.floor(i / cols) * height;
    const thumb = await sharp(item.jpeg).resize(240, 240, { fit: "inside", withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    overlays.push({ input: thumb.data, left: left + Math.round((width - thumb.info.width) / 2), top: top + Math.round((240 - thumb.info.height) / 2) });
    const escaped = item.label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const label = await sharp({ text: { text: escaped, font: "sans 12", width: 240, height: 40, align: "center", rgba: true } }).png().toBuffer();
    overlays.push({ input: label, left: left + 10, top: top + 245 });
  }
  return sharp({ create: { width: cols * width, height: Math.max(1, Math.ceil(items.length / cols)) * height, channels: 3, background: "#FFFFFF" } }).composite(overlays).jpeg({ quality: 85 }).toBuffer();
}

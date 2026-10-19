// The re-upload pass (spec 09 section 4.1): a sample of Run A's products comes back with one photo
// altered (one pixel row changed, so its sha256 differs) and one shot dropped.
import sharp from "sharp";
import type { LoadOption } from "./replicate";

/** Run A's full-scale sample; scaled with the number of options by `reuploadSampleSize`. */
export const FULL_REUPLOAD_SAMPLE = 300;

export function reuploadSampleSize(options: number): number {
  return Math.max(1, Math.round((options * FULL_REUPLOAD_SAMPLE) / 2700));
}

export interface ReuploadShot<T> { name: string; n: number; item: T; alter: boolean }
export interface ReuploadPlan<T> {
  options: { identifier: string; shots: ReuploadShot<T>[] }[];
  altered: { identifier: string; n: number }[];
  dropped: { identifier: string; n: number }[];
  untouched: { identifier: string; n: number }[];
}

/**
 * Picks `sample` options spread evenly over Run A's list. Per option: shot 1 is altered, the last
 * shot is dropped, the rest are sent unchanged (so they stay `unchanged`). Needs 3 or more shots.
 */
export function planReupload<T>(options: LoadOption<T>[], sample: number): ReuploadPlan<T> {
  const k = Math.min(Math.max(1, Math.floor(sample)), options.length);
  const plan: ReuploadPlan<T> = { options: [], altered: [], dropped: [], untouched: [] };
  for (let i = 0; i < k; i++) {
    const option = options[Math.floor((i * options.length) / k)]!;
    if (option.shots.length < 3) throw new Error(`${option.identifier} has fewer than 3 shots; the re-upload pass needs 3.`);
    const last = option.shots[option.shots.length - 1]!;
    const kept = option.shots.slice(0, -1).map((s, j) => ({ ...s, alter: j === 0 }));
    plan.options.push({ identifier: option.identifier, shots: kept });
    plan.altered.push({ identifier: option.identifier, n: kept[0]!.n });
    plan.dropped.push({ identifier: option.identifier, n: last.n });
    for (const s of kept.slice(1)) plan.untouched.push({ identifier: option.identifier, n: s.n });
  }
  return plan;
}

/** The same picture with its first pixel row inverted, re-encoded as JPEG (sha256 differs, size kept). */
export async function alterOnePixelRow(photo: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(photo).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < info.width * info.channels; i++) data[i] = 255 - data[i]!;
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).jpeg({ quality: 95 }).toBuffer();
}

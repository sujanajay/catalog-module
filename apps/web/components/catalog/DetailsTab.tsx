import { batchPrefix, productPrefix } from "@catalog/core/catalog/naming";
import { channel } from "@catalog/core/catalog/channels";
import { getPublicBucketName } from "@catalog/core/storage";
import type { BatchCounts, ChannelId } from "@catalog/core/catalog/types";
import NotRefreshedLine from "./NotRefreshedLine";
import { plural } from "../../lib/catalog/copy";

type DetailsProps = {
  id: string;
  brand: string;
  isTest: boolean;
  counts: BatchCounts;
  failures: { n: number; originalName: string; channel: ChannelId; reason: string | null; error: string | null }[];
  recheckFailures: { url: string; reason: string }[];
  notRefreshedChannels: { channel: ChannelId; lastBatchId: string; lastBatchName: string }[];
  hasReport: boolean;
};

export default function DetailsTab({ id, brand, isTest, counts, failures, recheckFailures, notRefreshedChannels, hasReport }: DetailsProps) {
  const held = counts.heldLinks ?? 0, carried = counts.recheckCarriedTotal ?? 0, carriedOk = counts.recheckCarriedOk ?? 0;
  return (
    <div className="card">
      <h2>For the technical team</h2>
      <p className="mono">
        batch {id} · raw files: gs://{process.env.BUCKET ?? "image-links-agent-assets"}/{batchPrefix(brand, id, isTest)}/raw/ · public links: https://storage.googleapis.com/{getPublicBucketName()}/{productPrefix(brand, "<pathKey>", isTest)}&lt;channel&gt;/ · {hasReport ? <a href={`/api/catalog/batches/${id}/export?format=report`}>report.json</a> : "report.json is not ready yet"}
      </p>
      {/* Both lines count this batch's delivered links; held and carried-over links are said apart (spec 06). */}
      <p>Links verified: {counts.verified} of {counts.outputs - counts.skipped - held}</p>
      <p>Independent re-check: {counts.recheckOk ?? 0} of {counts.recheckTotal ?? 0} OK</p>
      {held > 0 && <p>Not counted above: {held} {plural(held, "image", "images")} of the {plural(counts.attentionProducts, "product", "products")} that {plural(counts.attentionProducts, "needs", "need")} your attention, published once you decide.{carried > 0 ? ` Until then the sheet keeps ${carried} earlier ${plural(carried, "link", "links")} for ${plural(counts.attentionProducts, "it", "them")}; the re-check found ${carriedOk} of ${carried} OK.` : ""}</p>}
      {recheckFailures.length > 0 && (
        <ul>{recheckFailures.map(f => <li key={f.url}><a href={f.url}>{f.url}</a>: {f.reason}</li>)}</ul>
      )}
      <NotRefreshedLine items={notRefreshedChannels} />
      {failures.length > 0 && (
        <div role="alert">
          <p>{failures.length} {plural(failures.length, "image", "images")} could not be made.</p>
          {failures.map((f, i) => (
            <p key={i}>{f.originalName} for {channel(f.channel).label}: {(f.reason ?? f.error ?? "Could not be made").replace(/[.]+$/, "")}. Replace it from the Needs attention tab.</p>
          ))}
        </div>
      )}
    </div>
  );
}

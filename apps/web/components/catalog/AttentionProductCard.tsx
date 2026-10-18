import { channel } from "@catalog/core/catalog/channels";
import type { AttentionProduct } from "@/lib/catalog/products";
import { ActionOnly } from "@/components/ViewerPreview";

export default function AttentionProductCard({ item, canAct }: { item: AttentionProduct; canAct: boolean }) {
  return (
    <article className="pc">
      <header>
        <b className="mono">{item.identifier}</b>
        <span>{item.photos.length ? `${new Set(item.photos.map(p => p.n)).size} of ${item.totalShots} photos need a decision` : `${item.totalShots} source ${item.totalShots === 1 ? "photo" : "photos"} - processing needs attention`}</span>
      </header>
      <p className="prob">{item.problemLine}</p>
      {item.photos.map(p => (
        <div className="ir" key={p.outputId}>
          <figure>
            <img src={p.originalUrl} alt={`Photo ${p.n} original`} />
            <figcaption>Photo {p.n} of {item.totalShots}, original</figcaption>
          </figure>
          <figure>
            {p.outputUrl ? <img src={p.outputUrl} alt={`Photo ${p.n} made for ${channel(p.channel).label}`} /> : <div className="ph">Could not be made</div>}
            <figcaption>Photo {p.n} of {item.totalShots}, made for {channel(p.channel).label}</figcaption>
          </figure>
          <div className="why">
            <b>{p.why}</b>
            <p>{p.whatToDo}</p>
            {canAct && (
              <ActionOnly>
                <div className="acts">
                  {["Use as is", "Remove this photo", `Replace photo ${p.n}`].map((text, i) => (
                    <span key={text} title="Available after the quality-check update">
                      <button className={`btn sm ${i === 0 ? "ok" : "ghost"}`} disabled title="Available after the quality-check update">{text}</button>
                    </span>
                  ))}
                </div>
              </ActionOnly>
            )}
          </div>
        </div>
      ))}
    </article>
  );
}

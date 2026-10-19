import { inrAmount, RUPEES_NOT_CONFIGURED, usdAmount } from "@catalog/core/catalog/cost";

/** Only the figures of 07's costLine; no policy or model data reaches the page. */
export interface CostLineData { usdPerIdentifier: number | null; inrPerIdentifier: number | null; usd: number; inr: number | null }

const REFERENCE = "agency reference INR 60 per style";

/**
 * "INR <x> per style so far · INR <y> for this batch · agency reference INR 60 per style" (spec 07
 * 4.11, spec 01 batch page). INR has two decimals and USD four, so a sub-cent spend stays visible.
 */
export default function CostLine({ line }: { line: CostLineData }) {
  if (line.inrPerIdentifier !== null && line.inr !== null) {
    return <p className="cost-line"><strong className="cost-fig">INR {inrAmount(line.inrPerIdentifier)}</strong> per style so far · INR {inrAmount(line.inr)} for this batch · {REFERENCE}</p>;
  }
  if (line.usdPerIdentifier !== null) {
    return <p className="cost-line"><strong className="cost-fig">USD {usdAmount(line.usdPerIdentifier)}</strong> per style so far · USD {usdAmount(line.usd)} for this batch · {RUPEES_NOT_CONFIGURED} · {REFERENCE}</p>;
  }
  return <p className="cost-line">Cost per style is not available yet · {REFERENCE}</p>;
}

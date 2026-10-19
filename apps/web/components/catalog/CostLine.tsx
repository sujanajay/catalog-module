import { money } from "../../lib/catalog/copy";

/** Only the figures of 07's costLine; no policy or model data reaches the page. */
export interface CostLineData { usdPerIdentifier: number | null; inrPerIdentifier: number | null }

const REFERENCE = "agency reference INR 60 per style";

/** "INR <x> per style so far · agency reference INR 60 per style" (spec 07 4.11, spec 01 batch page). */
export default function CostLine({ line }: { line: CostLineData }) {
  if (line.inrPerIdentifier !== null) {
    return <p className="cost-line"><strong className="cost-fig">INR {money(line.inrPerIdentifier)}</strong> per style so far · {REFERENCE}</p>;
  }
  if (line.usdPerIdentifier !== null) {
    return <p className="cost-line"><strong className="cost-fig">USD {money(line.usdPerIdentifier)}</strong> per style so far (set INR_PER_USD to show rupees) · {REFERENCE}</p>;
  }
  return <p className="cost-line">Cost per style is not available yet · {REFERENCE}</p>;
}

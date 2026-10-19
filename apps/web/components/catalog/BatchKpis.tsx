import type { BatchCounts } from "@catalog/core/catalog/types";
import { plural } from "../../lib/catalog/copy";
export default function BatchKpis({counts:c}:{counts:BatchCounts}) {
  return <div className="kpis">{[[c.products,plural(c.products,"product","products")],[c.verified,plural(c.verified,"image made and verified","images made and verified")],[c.attentionProducts,plural(c.attentionProducts,"product needs attention","products need attention")],[c.failed,"could not be made"]].map(([value,label],i)=><div key={label} className={`kpi ${i===2 && c.attentionProducts ? "w" : ""}`}><b>{Number(value).toLocaleString("en")}</b><span>{label}</span></div>)}</div>;
}

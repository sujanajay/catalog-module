import type { BatchCounts } from "@catalog/core/catalog/types";
export default function BatchKpis({counts:c}:{counts:BatchCounts}) {
  return <div className="kpis">{[[c.products,"products"],[c.verified,"images made and verified"],[c.attentionProducts,"products need attention"],[c.failed,"could not be made"]].map(([value,label],i)=><div key={label} className={`kpi ${i===2 && c.attentionProducts ? "w" : ""}`}><b>{Number(value).toLocaleString("en")}</b><span>{label}</span></div>)}</div>;
}

// Small display primitives shared by the catalog pages.

export function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status.replace(/_/g, " ")}</span>;
}

export function usd(n: number | string | null | undefined, digits = 2): string {
  const v = Number(n ?? 0);
  return `$${v.toFixed(v !== 0 && Math.abs(v) < 0.1 ? Math.max(digits, 3) : digits)}`;
}

export function when(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().slice(0, 16).replace("T", " ") + "Z";
}

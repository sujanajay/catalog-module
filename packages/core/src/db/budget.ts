// Postgres connection budget for the shared Cloud SQL instance ila-pg (db-f1-micro).
// See docs/solutions/db-connection-budget.md for the incident that made this explicit.
//
// infra/deploy.sh passes the deployed shape to the worker and the jobs as DB_CONNECTION_BUDGET, for
// example "max=25;reserved=3;ila=4;worker=4x2;web=3x2;jobs=2x1" (instances x pool per consumer;
// semicolons because the value travels inside gcloud --set-env-vars), and
// refuses to deploy a shape that does not fit. The load driver re-checks it before it starts.

export interface ConnectionBudget {
  /** Postgres max_connections of the instance (db-f1-micro default: 25). */
  max: number;
  /** Slots only superusers or pg_use_reserved_connections roles may take (superuser_reserved_connections). */
  reserved: number;
  /** Connections assumed for the earlier ila-web and ila-worker apps on the same instance. */
  ila: number;
  worker: { instances: number; pool: number };
  web: { instances: number; pool: number };
  /** Cloud Run jobs that may run at the same time (load, recheck, QA check, migrate...). */
  jobs: { instances: number; pool: number };
}

export interface BudgetCheck {
  /** Slots an ordinary role can take: max - reserved. */
  available: number;
  /** What the catalog may use: available - ila. */
  catalogLimit: number;
  /** Worst case the catalog can open: every consumer at its maximum instances with a full pool. */
  catalogTotal: number;
  headroom: number;
  fits: boolean;
}

export function checkBudget(b: ConnectionBudget): BudgetCheck {
  const available = b.max - b.reserved;
  const catalogLimit = available - b.ila;
  const catalogTotal =
    b.worker.instances * b.worker.pool + b.web.instances * b.web.pool + b.jobs.instances * b.jobs.pool;
  return { available, catalogLimit, catalogTotal, headroom: catalogLimit - catalogTotal, fits: catalogTotal <= catalogLimit };
}

/** Parses "max=25;reserved=3;ila=4;worker=4x2;web=3x2;jobs=2x1" (commas also accepted). Throws on a missing or malformed field. */
export function parseBudget(text: string): ConnectionBudget {
  const fields = new Map<string, string>();
  for (const part of text.split(/[;,]/)) {
    const [k, v] = part.split("=").map(s => s.trim());
    if (k && v) fields.set(k, v);
  }
  const num = (k: string) => {
    const n = Number(fields.get(k));
    if (!Number.isInteger(n) || n < 0) throw new Error(`DB_CONNECTION_BUDGET: ${k} must be a whole number`);
    return n;
  };
  const pair = (k: string) => {
    const m = /^(\d+)x(\d+)$/.exec(fields.get(k) ?? "");
    if (!m) throw new Error(`DB_CONNECTION_BUDGET: ${k} must look like <instances>x<pool>`);
    return { instances: Number(m[1]), pool: Number(m[2]) };
  };
  return { max: num("max"), reserved: num("reserved"), ila: num("ila"), worker: pair("worker"), web: pair("web"), jobs: pair("jobs") };
}

export function formatBudget(b: ConnectionBudget, c: BudgetCheck = checkBudget(b)): string {
  return (
    `max_connections ${b.max} - reserved ${b.reserved} - ila ${b.ila} = ${c.catalogLimit} for the catalog; ` +
    `worker ${b.worker.instances}x${b.worker.pool} + web ${b.web.instances}x${b.web.pool} + jobs ${b.jobs.instances}x${b.jobs.pool} = ${c.catalogTotal}; ` +
    `headroom ${c.headroom}`
  );
}

// M6-F2-R1 (M6-S4): every migration is additive, so the live code and the new code both work on the migrated schema
// while a deploy shifts traffic (expand and contract). This check refuses a migration that drops, renames or retypes a
// column or table, adds NOT NULL without a default, or adds a CHECK or foreign key that existing rows may break,
// unless the file is marked `-- contract: <release>` (the contract step of an expand and contract change, written once
// the previous release no longer reads the object). Run by CI through packages/core/scripts/check-migrations.mjs.
// Node built-ins only and no extensionless imports, so plain `node` can load this file.

/** Migrations up to this number were applied before the rule existed; they are never checked again. */
export const MIGRATION_LINT_FROM = 9;

/** The marker that allows a contract step: `-- contract: R2` (the release that stops reading the object). */
export const CONTRACT_MARKER = /^\s*--\s*contract:\s*\S+/im;

export interface MigrationFinding {
  file: string;
  statement: string;
  rule: string;
}

const RULES: { rule: string; test: (s: string) => boolean }[] = [
  { rule: "drops a table", test: (s) => /\bDROP\s+TABLE\b/.test(s) },
  { rule: "drops a column", test: (s) => /\bDROP\s+COLUMN\b/.test(s) },
  { rule: "renames a table or column", test: (s) => /\bRENAME\b/.test(s) },
  { rule: "changes a column type", test: (s) => /\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+(SET\s+DATA\s+)?TYPE\b/.test(s) },
  { rule: "sets NOT NULL on an existing column", test: (s) => /\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+SET\s+NOT\s+NULL\b/.test(s) },
  {
    rule: "adds a NOT NULL column without a default",
    test: (s) => /\bADD\s+COLUMN\b/.test(s) && /\bNOT\s+NULL\b/.test(s) && !/\bDEFAULT\b/.test(s),
  },
  {
    rule: "adds a CHECK or foreign key that existing rows may break (add it NOT VALID)",
    test: (s) => /\bALTER\s+TABLE\b/.test(s) && /\bADD\s+CONSTRAINT\b/.test(s) && /\b(CHECK|FOREIGN\s+KEY)\b/.test(s) && !/\bNOT\s+VALID\b/.test(s),
  },
];

/** The statements of a migration file, without comments, upper-cased outside quoted names, whitespace collapsed. */
export function migrationStatements(sql: string): string[] {
  const noComments = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  return noComments
    .split(";")
    .map((s) => s.replace(/"[^"]*"/g, (q) => `\u0000${q}\u0000`))
    .map((s) => s.split("\u0000").map((part, i) => (i % 2 ? part : part.toUpperCase())).join(""))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The findings of one migration file; none when the file carries the contract marker. */
export function lintMigration(file: string, sql: string): MigrationFinding[] {
  if (CONTRACT_MARKER.test(sql)) return [];
  const findings: MigrationFinding[] = [];
  for (const statement of migrationStatements(sql)) {
    for (const { rule, test } of RULES) if (test(statement)) findings.push({ file, statement, rule });
  }
  return findings;
}

/** The number of a migration file name (`0010_x.sql` is 10), or null for any other file. */
export function migrationNumber(name: string): number | null {
  const match = /^(\d{4})_[\w-]+\.sql$/.exec(name);
  return match ? Number(match[1]) : null;
}

/** Findings over every migration numbered MIGRATION_LINT_FROM or later; `files` maps a file name to its SQL. */
export function lintMigrations(files: Record<string, string>, from = MIGRATION_LINT_FROM): MigrationFinding[] {
  return Object.keys(files)
    .filter((name) => (migrationNumber(name) ?? -1) >= from)
    .sort()
    .flatMap((name) => lintMigration(name, files[name]!));
}

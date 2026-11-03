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

/** `existingRows`: the rule is about rows already in the table, so it cannot fire on a table the same file creates. */
const RULES: { rule: string; test: (s: string) => boolean; existingRows?: true }[] = [
  { rule: "drops a table", test: (s) => /\bDROP\s+TABLE\b/.test(s) },
  { rule: "drops a column", test: (s) => /\bDROP\s+COLUMN\b/.test(s) },
  { rule: "renames a table or column", test: (s) => /\bRENAME\b/.test(s) },
  { rule: "changes a column type", test: (s) => /\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+(SET\s+DATA\s+)?TYPE\b/.test(s) },
  { rule: "sets NOT NULL on an existing column", test: (s) => /\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+SET\s+NOT\s+NULL\b/.test(s) },
  {
    rule: "adds a NOT NULL column without a default",
    // Per ADD COLUMN clause, so `ADD COLUMN a int NOT NULL, ADD COLUMN b int DEFAULT 0` is caught.
    test: (s) => s.split(/,\s*(?=ADD\s+COLUMN\b)/).some((c) => /\bADD\s+COLUMN\b/.test(c) && /\bNOT\s+NULL\b/.test(c) && !/\bDEFAULT\b/.test(c)),
  },
  { rule: "drops a column default (old code inserting without the column fails)", test: (s) => /\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+DROP\s+DEFAULT\b/.test(s) },
  { rule: "adds a unique index or constraint that existing rows may break", test: (s) => /\bCREATE\s+UNIQUE\s+INDEX\b/.test(s) || (/\bADD\s+CONSTRAINT\b/.test(s) && /\bUNIQUE\b/.test(s)), existingRows: true },
  { rule: "drops an index, type or view", test: (s) => /\bDROP\s+(INDEX|TYPE|VIEW|MATERIALIZED\s+VIEW)\b/.test(s) },
  { rule: "deletes rows", test: (s) => /^(TRUNCATE|DELETE\s+FROM)\b/.test(s) },
  {
    rule: "adds a CHECK or foreign key that existing rows may break (add it NOT VALID)",
    test: (s) => /\bALTER\s+TABLE\b/.test(s) && /\bADD\s+CONSTRAINT\b/.test(s) && /\b(CHECK|FOREIGN\s+KEY)\b/.test(s) && !/\bNOT\s+VALID\b/.test(s),
    existingRows: true,
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
  const statements = migrationStatements(sql);
  // A table this file creates has no rows yet, so a CHECK, foreign key or unique index on it cannot break any.
  const created = new Set(statements.flatMap((s) => tableName(/^CREATE TABLE (?:IF NOT EXISTS )?(\S+)/.exec(s)?.[1])));
  for (const statement of statements) {
    const target = tableName(/\bALTER TABLE (?:ONLY )?(?:IF EXISTS )?(\S+)/.exec(statement)?.[1] ?? /\bCREATE UNIQUE INDEX .*? ON (?:ONLY )?(\S+)/.exec(statement)?.[1]);
    for (const { rule, test, existingRows } of RULES) {
      if (existingRows && target.some((t) => created.has(t))) continue;
      if (test(statement)) findings.push({ file, statement, rule });
    }
  }
  return findings;
}

/** A table name as a statement writes it, without quotes or the `public.` schema; [] when there is none. */
function tableName(raw: string | undefined): string[] {
  if (!raw) return [];
  const name = raw.replace(/"/g, "").toLowerCase();
  return [name.startsWith("public.") ? name.slice("public.".length) : name];
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

export interface JournalEntry { idx: number; when: number; tag: string }

/**
 * Checks drizzle's meta/_journal.json. The pg migrator applies a migration only when its `when` is later than the
 * newest applied one, so an entry whose `when` sorts before an earlier entry's is skipped, with no error, on a database
 * that already has that earlier entry (a branch generated before another branch's migration merged). Entries must run
 * idx 0..n-1, `when` must strictly increase with idx, migration numbers must increase, and each entry needs its .sql
 * file (and each .sql file its entry) when `files` is given. Applies to every entry, also those before
 * MIGRATION_LINT_FROM.
 */
export function lintJournal(journal: { entries: JournalEntry[] }, files?: Record<string, string>): MigrationFinding[] {
  const findings: MigrationFinding[] = [];
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  entries.forEach((e, i) => {
    const file = `meta/_journal.json ${e.tag}`;
    const prev = entries[i - 1];
    if (e.idx !== i) findings.push({ file, statement: `idx ${e.idx}`, rule: `journal idx must run 0..n-1 (expected ${i})` });
    if (prev && !(e.when > prev.when)) {
      findings.push({ file, statement: `when ${e.when}`, rule: `journal "when" must be later than ${prev.tag} (${prev.when}), or drizzle skips this migration; regenerate it after the earlier one merged` });
    }
    const n = migrationNumber(`${e.tag}.sql`), p = prev ? migrationNumber(`${prev.tag}.sql`) : null;
    if (n === null) findings.push({ file, statement: e.tag, rule: "journal tag is not a migration file name" });
    else if (p !== null && n <= p) findings.push({ file, statement: e.tag, rule: `migration number must be above ${prev!.tag}` });
    if (files && !(`${e.tag}.sql` in files)) findings.push({ file, statement: e.tag, rule: "journal entry has no .sql file" });
  });
  if (files) {
    for (const name of Object.keys(files)) {
      if (migrationNumber(name) !== null && !entries.some((e) => `${e.tag}.sql` === name)) findings.push({ file: name, statement: name, rule: "migration file is not in meta/_journal.json, so it never runs" });
    }
  }
  return findings;
}

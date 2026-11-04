// M6-F2 acceptance test 4: CI rejects a test migration that drops a column without the contract marker. The rules run
// on statements (lintMigration) and through the CI command (scripts/check-migrations.mjs) on a folder of files.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintJournal, lintMigration, lintMigrations, migrationStatements, type JournalEntry } from "./migration-lint";
import { resolveMigrationsFolder } from "./migrate";

const rules = (sql: string) => lintMigration("0099_test.sql", sql).map((f) => f.rule);

describe("migration lint (M6-F2-R1)", () => {
  it("refuses drops, renames, type changes, NOT NULL without a default and CHECKs that existing rows may break", () => {
    expect(rules(`ALTER TABLE "catalog_outputs" DROP COLUMN "flags";`)).toEqual(["drops a column"]);
    expect(rules(`DROP TABLE "catalog_runs";`)).toEqual(["drops a table"]);
    expect(rules(`ALTER TABLE "a" RENAME COLUMN "b" TO "c";`)).toEqual(["renames a table or column"]);
    expect(rules(`ALTER TABLE "a" RENAME TO "b";`)).toEqual(["renames a table or column"]);
    expect(rules(`ALTER TABLE "a" ALTER COLUMN "b" SET DATA TYPE bigint;`)).toEqual(["changes a column type"]);
    expect(rules(`alter table a alter column b type text;`)).toEqual(["changes a column type"]);
    expect(rules(`ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;`)).toEqual(["sets NOT NULL on an existing column"]);
    expect(rules(`ALTER TABLE "a" ADD COLUMN "b" integer NOT NULL;`)).toEqual(["adds a NOT NULL column without a default"]);
    expect(rules(`ALTER TABLE "a" ADD CONSTRAINT "a_b_check" CHECK ("a"."b" IN ('x'));`)).toEqual(["adds a CHECK or foreign key that existing rows may break (add it NOT VALID)"]);
    expect(rules(`ALTER TABLE "a" ADD CONSTRAINT "a_b_fk" FOREIGN KEY ("b") REFERENCES "c"("id");`)).toHaveLength(1);
    // Review 2026-11-03: per clause, and the other ways to break the previous release's code.
    expect(rules(`ALTER TABLE "a" ADD COLUMN "b" integer NOT NULL, ADD COLUMN "c" integer DEFAULT 0;`)).toEqual(["adds a NOT NULL column without a default"]);
    expect(rules(`ALTER TABLE "a" ALTER COLUMN "b" DROP DEFAULT;`)).toEqual(["drops a column default (old code inserting without the column fails)"]);
    expect(rules(`CREATE UNIQUE INDEX "a_b" ON "a" ("b");`)).toEqual(["adds a unique index or constraint that existing rows may break"]);
    expect(rules(`ALTER TABLE "a" ADD CONSTRAINT "a_b_unique" UNIQUE("b");`)).toEqual(["adds a unique index or constraint that existing rows may break"]);
    expect(rules(`DROP INDEX IF EXISTS "a_b_idx";`)).toEqual(["drops an index, type or view"]);
    expect(rules(`DELETE FROM "a";`)).toEqual(["deletes rows"]);
    expect(rules(`TRUNCATE "a";`)).toEqual(["deletes rows"]);
  });

  it("allows additive changes: new tables, nullable or defaulted columns, dropped NOT NULL, NOT VALID checks, indexes", () => {
    expect(rules(`CREATE TABLE "x" ("id" uuid PRIMARY KEY NOT NULL, "n" integer NOT NULL);`)).toEqual([]);
    expect(rules(`ALTER TABLE "a" ADD COLUMN "b" text;`)).toEqual([]);
    expect(rules(`ALTER TABLE "a" ADD COLUMN IF NOT EXISTS "b" integer DEFAULT 0 NOT NULL;`)).toEqual([]);
    expect(rules(`ALTER TABLE "a" ALTER COLUMN "b" DROP NOT NULL;`)).toEqual([]);
    expect(rules(`ALTER TABLE "a" DROP CONSTRAINT IF EXISTS "a_b_check";--> statement-breakpoint\nALTER TABLE "a" ADD CONSTRAINT "a_b_check" CHECK ("a"."b" IN ('x', 'y')) NOT VALID;`)).toEqual([]);
    expect(rules(`CREATE INDEX IF NOT EXISTS "a_b_idx" ON "a" USING btree ("b");`)).toEqual([]);
    // A word inside a quoted name or a comment is not a statement.
    expect(rules(`-- we never DROP COLUMN here\nALTER TABLE "drop_column_log" ADD COLUMN "rename" text;`)).toEqual([]);
  });

  it("allows a foreign key, CHECK or unique index on a table the same file creates (it has no rows yet), never on an existing one", () => {
    const created = `CREATE TABLE IF NOT EXISTS "t" ("id" uuid PRIMARY KEY, "b" uuid, "k" text);--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 't_b_fk') THEN ALTER TABLE "t" ADD CONSTRAINT "t_b_fk" FOREIGN KEY ("b") REFERENCES "public"."a"("id"); END IF; END $$;--> statement-breakpoint
ALTER TABLE "public"."t" ADD CONSTRAINT "t_k_check" CHECK ("t"."k" <> '');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "t_k_uq" ON "t" USING btree ("k");`;
    expect(rules(created)).toEqual([]);
    // The same statements on a table the file does not create are still refused.
    expect(rules(created.replace(`CREATE TABLE IF NOT EXISTS "t"`, `CREATE TABLE IF NOT EXISTS "other"`))).toEqual([
      "adds a CHECK or foreign key that existing rows may break (add it NOT VALID)",
      "adds a CHECK or foreign key that existing rows may break (add it NOT VALID)",
      "adds a unique index or constraint that existing rows may break",
    ]);
  });

  it("lets a contract step through only with the marker", () => {
    const drop = `ALTER TABLE "catalog_outputs" DROP COLUMN "legacy";`;
    expect(rules(drop)).toHaveLength(1);
    expect(rules(`-- contract: R2\n${drop}`)).toEqual([]);
  });

  it("checks only migrations from 0009 on, and every one of them in the repo passes", () => {
    const old = { "0003_intake_states.sql": `ALTER TABLE "a" ADD CONSTRAINT "c" CHECK (true);`, "0010_x.sql": `ALTER TABLE "a" DROP COLUMN "b";` };
    expect(lintMigrations(old).map((f) => f.file)).toEqual(["0010_x.sql"]);
    const folder = resolveMigrationsFolder();
    const files = Object.fromEntries(readdirSync(folder).filter((n) => n.endsWith(".sql")).map((n) => [n, readFileSync(path.join(folder, n), "utf8")]));
    expect(lintMigrations(files)).toEqual([]);
    // drizzle's "--> statement-breakpoint" is a comment to the lint.
    expect(migrationStatements(`SET LOCAL lock_timeout = '10s';--> statement-breakpoint\nSELECT "Mixed"`)).toEqual(["SET LOCAL LOCK_TIMEOUT = '10S'", `SELECT "Mixed"`]);
  });

  it("the CI command fails on a test migration that drops a column without the marker, and passes the repo's folder", () => {
    const script = path.resolve(import.meta.dirname, "../../scripts/check-migrations.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "catalog-migration-lint-"));
    try {
      writeFileSync(path.join(dir, "0011_drop_flags.sql"), `ALTER TABLE "catalog_outputs" DROP COLUMN "flags";`);
      const failed = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("0011_drop_flags.sql: drops a column");
      writeFileSync(path.join(dir, "0011_drop_flags.sql"), `-- contract: R2\nALTER TABLE "catalog_outputs" DROP COLUMN "flags";`);
      expect(spawnSync(process.execPath, [script, dir], { encoding: "utf8" }).status).toBe(0);
      expect(spawnSync(process.execPath, [script], { encoding: "utf8" }).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a journal whose \"when\" does not increase with idx (drizzle would skip that migration silently)", () => {
    const entry = (idx: number, when: number, tag: string): JournalEntry => ({ idx, when, tag });
    expect(lintJournal({ entries: [entry(0, 1, "0000_a"), entry(1, 2, "0001_b")] })).toEqual([]);
    // A branch generated before another branch's 0009 merged: its later migration carries an earlier timestamp.
    const skipped = lintJournal({ entries: [entry(0, 1, "0000_a"), entry(1, 30, "0009_graph"), entry(2, 20, "0010_ledger")] });
    expect(skipped.map((f) => f.rule)).toEqual([expect.stringContaining('journal "when" must be later than 0009_graph')]);
    expect(lintJournal({ entries: [entry(0, 1, "0000_a"), entry(2, 2, "0001_b")] }).map((f) => f.rule)).toEqual(["journal idx must run 0..n-1 (expected 1)"]);
    expect(lintJournal({ entries: [entry(0, 1, "0001_a"), entry(1, 2, "0001_b")] }).map((f) => f.rule)).toEqual(["migration number must be above 0001_a"]);
    expect(lintJournal({ entries: [entry(0, 1, "0000_a")] }, { "0000_a.sql": "", "0001_b.sql": "" }).map((f) => f.rule)).toEqual(["migration file is not in meta/_journal.json, so it never runs"]);
  });

  it("the repo's journal is in run order, with M3-S5's 0016 after 0012", () => {
    const folder = resolveMigrationsFolder();
    const journal = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] };
    const files = Object.fromEntries(readdirSync(folder).filter((n) => n.endsWith(".sql")).map((n) => [n, ""]));
    expect(lintJournal(journal, files)).toEqual([]);
    expect(journal.entries.slice(-2).map((e) => e.tag)).toEqual(["0012_deploy_safe_cost_ledger", "0016_overflow_daily_cap"]);
  });

  it("the CI command fails on a journal out of run order", () => {
    const script = path.resolve(import.meta.dirname, "../../scripts/check-migrations.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "catalog-migration-journal-"));
    try {
      mkdirSync(path.join(dir, "meta"));
      writeFileSync(path.join(dir, "0009_graph.sql"), `CREATE TABLE "g" ("id" uuid);`);
      writeFileSync(path.join(dir, "0010_ledger.sql"), `ALTER TABLE "a" ADD COLUMN "b" text;`);
      writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ entries: [{ idx: 0, when: 30, tag: "0009_graph" }, { idx: 1, when: 20, tag: "0010_ledger" }] }));
      const failed = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('journal "when" must be later than 0009_graph');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

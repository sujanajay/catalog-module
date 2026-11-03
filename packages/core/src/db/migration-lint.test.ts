// M6-F2 acceptance test 4: CI rejects a test migration that drops a column without the contract marker. The rules run
// on statements (lintMigration) and through the CI command (scripts/check-migrations.mjs) on a folder of files.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lintMigration, lintMigrations, migrationStatements } from "./migration-lint";
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
});

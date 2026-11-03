// M6-F2-R1: fails (exit 1) when a migration in packages/core/drizzle (or the folder given as the first argument) is not
// additive and carries no `-- contract: <release>` marker. Run by CI: node packages/core/scripts/check-migrations.mjs
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import {lintMigrations} from '../src/db/migration-lint.ts';

const folder = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'drizzle'));
const files = Object.fromEntries(fs.readdirSync(folder).filter((name) => name.endsWith('.sql')).map((name) => [name, fs.readFileSync(path.join(folder, name), 'utf8')]));
const findings = lintMigrations(files);
for (const f of findings) console.error(`${f.file}: ${f.rule}: ${f.statement}`);
if (findings.length) {
  console.error(`${findings.length} migration statement(s) are not additive. A batch must survive the deploy: add first, remove a release later, and mark that file "-- contract: <release>".`);
  process.exit(1);
}
console.log(`migrations additive: ${Object.keys(files).length} file(s) checked`);

// Run with node infra/tests/sql-tier.test.mjs. Offline: a fake gcloud on PATH, no provider calls.
// Spec 16 3.2.5: infra/sql-tier.sh prints SKIP when ila-pg already has the tier, refuses a change without
// CONFIRM_RESTART=1, patches only the tier with it, and refuses an unknown tier name before calling gcloud.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import {spawnSync} from 'node:child_process';
import {gitBashPath} from '../../packages/core/src/git-bash.ts';

const root = path.resolve(import.meta.dirname, '../..');
const bash = process.env.CATALOG_BASH || gitBashPath();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-sql-tier-'));

// Fake gcloud: the tier lives in $dir/tier; every call is logged; describe prints it with CRLF, as on Windows.
fs.writeFileSync(path.join(dir, 'gcloud'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/log"
case "$*" in
  "sql instances describe ila-pg --format=value(settings.tier)") printf '%s\\r\\n' "$(cat "$FAKE_DIR/tier")" ;;
  "sql instances patch ila-pg --tier="*" --quiet") t="$5"; printf '%s' "\${t#--tier=}" > "$FAKE_DIR/tier" ;;
  *) echo "unexpected gcloud call: $*" >&2; exit 2 ;;
esac
`, {mode: 0o755});

function run(tier, env) {
  fs.writeFileSync(path.join(dir, 'tier'), tier);
  fs.rmSync(path.join(dir, 'log'), {force: true});
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['SQL_TIER', 'CONFIRM_RESTART'].includes(k)));
  const r = spawnSync(bash, ['-c', 'export FAKE_DIR="$(cygpath -u "$FAKE_WIN" 2>/dev/null || echo "$FAKE_WIN")"; export PATH="$FAKE_DIR:$PATH"; bash infra/sql-tier.sh'],
    {cwd: root, env: {...clean, ...env, FAKE_WIN: dir}, encoding: 'utf8'});
  const log = fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split(/\r?\n/) : [];
  return {...r, log, after: fs.readFileSync(path.join(dir, 'tier'), 'utf8')};
}

try {
  let r = run('db-custom-2-7680', {});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ila-pg tier: db-custom-2-7680 \(default max_connections 400\)/);
  assert.match(r.stdout, /sql tier: SKIP/);
  assert.deepEqual(r.log, ['sql instances describe ila-pg --format=value(settings.tier)']);
  console.log('PASS skip when it matches');

  r = run('db-f1-micro', {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /restarts it for a few minutes[\s\S]*CONFIRM_RESTART=1/);
  assert.equal(r.after, 'db-f1-micro');
  assert.ok(!r.log.some((l) => l.includes('patch')), 'no patch without the confirm flag');
  console.log('PASS refuses without CONFIRM_RESTART=1');

  r = run('db-f1-micro', {CONFIRM_RESTART: '1'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.after, 'db-custom-2-7680');
  assert.ok(r.log.includes('sql instances patch ila-pg --tier=db-custom-2-7680 --quiet'), r.log.join('\n'));
  assert.match(r.stdout, /PATCH db-f1-micro -> db-custom-2-7680/);
  console.log('PASS patches only the tier with the flag');

  r = run('db-custom-2-7680', {CONFIRM_RESTART: '1'});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SKIP/);
  console.log('PASS re-run prints SKIP');

  r = run('db-custom-2-7680', {CONFIRM_RESTART: '1', SQL_TIER: 'db-n1-standard-2; rm -rf /'});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SQL_TIER must be/);
  assert.deepEqual(r.log, []);
  console.log('PASS refuses an unknown tier before calling gcloud');
  console.log('5 offline sql-tier cases passed');
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}

// Run with node infra/tests/chunk-defaults.test.mjs. No GCP call: gcloud is a fake bash function.
// Spec 15 E6: deploy.sh defaults the chunk size to 10 and the window to 8, refuses a non-integer, and
// passes the optional time budget to the worker only when set. bootstrap.sh runs the sweep every
// 10 minutes and its scheduler step is check-then-update: SKIP when the schedule matches, UPDATE when
// it differs, CREATE when the job is missing, never a delete.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import {spawnSync} from 'node:child_process';
import {gitBashPath} from '../../packages/core/src/git-bash.ts';

const infra = path.resolve(import.meta.dirname, '..');
const bash = process.env.CATALOG_BASH || gitBashPath();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-chunk-defaults-'));
const lines = (file) => fs.readFileSync(path.join(infra, file), 'utf8').split(/\r?\n/);

function run(label, script, env = {}) {
  const log = path.join(dir, label + '.log');
  fs.writeFileSync(log, '');
  const r = spawnSync(bash, ['-c', script], {env: {...process.env, LOG: log, ...env}, encoding: 'utf8', timeout: 60000});
  if (r.error) throw r.error;
  return {status: r.status, stdout: r.stdout, stderr: r.stderr, calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)};
}

let cases = 0;
try {
  // 1. deploy.sh: the chunk settings block, from CHUNK_IMAGES= to the budget check.
  {
    const deploy = lines('deploy.sh');
    const start = deploy.findIndex((l) => l.startsWith('CHUNK_IMAGES='));
    const end = deploy.findIndex((l, i) => i > start && l.includes('CATALOG_CHUNK_TIME_BUDGET_MS must be'));
    assert.ok(start >= 0 && end > start, 'chunk settings block not found in deploy.sh');
    const block = deploy.slice(start, end + 1).join('\n');
    const script = `set -euo pipefail\n${block}\necho "images=$CHUNK_IMAGES window=$CHUNK_WINDOW budget=\${CHUNK_BUDGET:+,CATALOG_CHUNK_TIME_BUDGET_MS=$CHUNK_BUDGET}"`;
    const clean = {CATALOG_CHUNK_IMAGES: '', CATALOG_CHUNK_WINDOW: '', CATALOG_CHUNK_TIME_BUDGET_MS: ''};
    const defaults = run('deploy-defaults', script, clean);
    assert.equal(defaults.status, 0, defaults.stderr);
    assert.equal(defaults.stdout.trim(), 'images=10 window=8 budget=');
    const set = run('deploy-set', script, {...clean, CATALOG_CHUNK_IMAGES: '12', CATALOG_CHUNK_WINDOW: '4', CATALOG_CHUNK_TIME_BUDGET_MS: '60000'});
    assert.equal(set.stdout.trim(), 'images=12 window=4 budget=,CATALOG_CHUNK_TIME_BUDGET_MS=60000');
    for (const [name, value] of [['CATALOG_CHUNK_IMAGES', '2.5'], ['CATALOG_CHUNK_IMAGES', 'ten'], ['CATALOG_CHUNK_IMAGES', '0'], ['CATALOG_CHUNK_WINDOW', '-1'], ['CATALOG_CHUNK_TIME_BUDGET_MS', '60s']]) {
      const r = run('deploy-refuse', script, {...clean, [name]: value});
      assert.notEqual(r.status, 0, `${name}=${value} must be refused`);
      assert.match(r.stderr, new RegExp(`${name} must be a positive integer`));
    }
    // Both services get the window; only the worker gets the budget.
    const text = deploy.join('\n');
    assert.match(text, /^WORKER_ENV=".*CATALOG_CHUNK_WINDOW=\$CHUNK_WINDOW\$\{CHUNK_BUDGET:\+,CATALOG_CHUNK_TIME_BUDGET_MS=\$CHUNK_BUDGET\}"$/m);
    assert.match(text, /^WEB_ENV=".*CATALOG_CHUNK_IMAGES=\$CHUNK_IMAGES,CATALOG_CHUNK_WINDOW=\$CHUNK_WINDOW"$/m);
    console.log('PASS deploy chunk defaults');
    cases++;
  }

  // 2. bootstrap.sh: sweep every 10 minutes, scheduler step check-then-update.
  {
    const boot = lines('bootstrap.sh');
    assert.ok(boot.includes('SWEEP_CRON="*/10 * * * *"       # every 10 minutes (spec 15: lost chunk tasks come back within 30 min)'), 'sweep cron is every 10 minutes');
    const start = boot.findIndex((l) => l.startsWith('ensure_scheduler_job() {'));
    const end = boot.findIndex((l, i) => i > start && l === '}');
    assert.ok(start >= 0 && end > start, 'ensure_scheduler_job not found in bootstrap.sh');
    const fn = boot.slice(start, end + 1).join('\n');
    const fake = `gcloud() {
  printf '%s\\n' "$*" >> "$LOG"
  case "$1 $2 $3" in
    "scheduler jobs describe") [ -n "$CURRENT" ] || return 1; printf '%s\\r\\n' "$CURRENT" ;;
  esac
}`;
    const script = `set -euo pipefail
${fake}
skip() { printf 'SKIP %s\\n' "$*"; }; create() { printf 'CREATE %s\\n' "$*"; }; update() { printf 'UPDATE %s\\n' "$*"; }
PROJECT=image-links-agent REGION=asia-south1 SCHEDULER_TZ=Asia/Kolkata WORKER=w@x WORKER_URL=https://worker
${fn}
ensure_scheduler_job catalog-sweep /tasks/catalog/sweep "*/10 * * * *"`;
    const cases3 = [
      {label: 'sweep-matches', current: '*/10 * * * *', out: /^SKIP scheduler job catalog-sweep$/m, verb: null},
      {label: 'sweep-old-cron', current: '*/30 * * * *', out: /^UPDATE scheduler job catalog-sweep schedule \(\*\/30 \* \* \* \* -> \*\/10 \* \* \* \*\)$/m, verb: 'scheduler jobs update http catalog-sweep'},
      {label: 'sweep-missing', current: '', out: /^CREATE scheduler job catalog-sweep/m, verb: 'scheduler jobs create http catalog-sweep'},
    ];
    for (const c of cases3) {
      const r = run(c.label, script, {CURRENT: c.current});
      assert.equal(r.status, 0, c.label + '\n' + r.stderr);
      assert.match(r.stdout, c.out, c.label);
      const writes = r.calls.filter((a) => !a.startsWith('scheduler jobs describe'));
      assert.deepEqual(writes.map((a) => a.split(' --')[0]), c.verb ? [c.verb] : [], c.label);
      if (c.verb?.includes('update')) assert.match(writes[0], /--schedule=\*\/10 \* \* \* \* --time-zone=Asia\/Kolkata/);
      assert.ok(!r.calls.some((a) => /delete/.test(a)), c.label + ' deletes nothing');
    }
    console.log('PASS bootstrap sweep schedule');
    cases++;
  }
  console.log(`chunk-defaults: ${cases} cases passed`);
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}

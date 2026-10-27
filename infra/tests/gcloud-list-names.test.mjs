// Run with node infra/tests/gcloud-list-names.test.mjs. No provider calls.
// gcloud list prints short resource names on newer SDKs (589) and full projects/... names on older
// ones. The check-then-create in deploy.sh (tasks queues) and test-render-pool.sh (worker pool)
// must treat both forms, with or without CRLF, as "exists" and never call create for them.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-list-names-'));

// The queue block of deploy.sh, from ENSURE_QUEUES= to the end of its for loop.
const deploy = fs.readFileSync(path.join(infra, 'deploy.sh'), 'utf8').split(/\r?\n/);
const start = deploy.findIndex((l) => l.startsWith('ENSURE_QUEUES='));
const end = deploy.findIndex((l, i) => i > start && l === 'done');
assert.ok(start >= 0 && end > start, 'Queue block not found in deploy.sh');
const queueBlock = deploy.slice(start, end + 1).join('\n');

// Fake gcloud: logs each call, prints $LIST for list, fails list when LIST_FAIL=1.
const fake = `gcloud() {
  printf '%s\\n' "$*" >> "$LOG"
  case "$1 $2 $3" in
    *" list"*) [ "\${LIST_FAIL:-0}" = 1 ] && { echo 'PERMISSION_DENIED mocked' >&2; return 1; }; printf "$LIST" ;;
    "builds worker-pools describe") echo 'RUNNING,e2-standard-8,100,,PUBLIC_EGRESS,' ;;
  esac
}`;

function run(label, script, env) {
  const log = path.join(dir, label + '.log');
  fs.writeFileSync(log, '');
  const r = spawnSync(bash, ['-c', script], {env: {...process.env, LOG: log, ...env}, encoding: 'utf8', timeout: 60000});
  if (r.error) throw r.error;
  return {status: r.status, stderr: r.stderr, calls: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)};
}

const full = (q) => `projects/image-links-agent/locations/asia-south1/queues/${q}`;
const queueScript = `set -euo pipefail
${fake}
gcv() { gcloud "$@" | tr -d '\\r'; }
PROJECT=image-links-agent REGION=asia-south1 QUEUE=catalog INGEST_MAX_DISPATCHES=4 TASKS_MAX_DISPATCHES=8 BULK_MAX_DISPATCHES=0 BULK_QUEUE=catalog-bulk
${queueBlock}`;

const queueCases = [
  {label: 'queues-short-names', list: 'catalog\\ncatalog-ingest\\ngeneration\\n', creates: 0},
  {label: 'queues-full-names', list: `${full('catalog')}\\n${full('catalog-ingest')}\\n`, creates: 0},
  {label: 'queues-crlf', list: 'catalog\\r\\ncatalog-ingest\\r\\n', creates: 0},
  {label: 'queues-preview-short', list: 'catalog\\ncatalog-ingest\\n', preview: '1', creates: 0},
  {label: 'queues-ingest-missing', list: 'catalog\\ncatalog-ingest-old\\n', creates: 1},
  {label: 'queues-ingest-missing-full', list: `${full('catalog')}\\n`, creates: 1},
  {label: 'queues-list-fails', list: '', fail: '1', status: 1, creates: 0},
];
try {
  for (const c of queueCases) {
    const r = run(c.label, queueScript, {LIST: c.list, LIST_FAIL: c.fail || '0', CATALOG_PREVIEW: c.preview || '0'});
    assert.equal(r.status, c.status ?? 0, c.label + '\n' + r.stderr);
    const creates = r.calls.filter((a) => a.startsWith('tasks queues create'));
    assert.equal(creates.length, c.creates, c.label + ' create calls: ' + creates.join(' | '));
    if (c.creates) assert.match(creates[0], /^tasks queues create catalog-ingest /, c.label);
    if (!c.status) {
      const updates = r.calls.filter((a) => a.startsWith('tasks queues update'));
      assert.equal(updates.length + creates.length, c.preview ? 2 : 1, c.label + ' queue calls');
    }
    console.log('PASS ' + c.label);
  }

  const pool = 'catalog-test-render05';
  const poolCases = [
    {label: 'pool-short-name', list: `${pool}\\n`, creates: 0},
    {label: 'pool-full-name', list: `projects/image-links-agent/locations/us-central1/workerPools/${pool}\\r\\n`, creates: 0},
    {label: 'pool-missing', list: 'other-pool\\n', creates: 1},
    {label: 'pool-list-fails', list: '', fail: '1', status: 1, creates: 0},
  ];
  const poolScript = `${fake}\nexport -f gcloud\nbash "$TARGET"`;
  for (const c of poolCases) {
    const r = run(c.label, poolScript, {LIST: c.list, LIST_FAIL: c.fail || '0', TARGET: path.join(infra, 'test-render-pool.sh')});
    assert.equal(r.status, c.status ?? 0, c.label + '\n' + r.stderr);
    const creates = r.calls.filter((a) => a.startsWith('builds worker-pools create'));
    assert.equal(creates.length, c.creates, c.label + ' create calls');
    console.log('PASS ' + c.label);
  }
  console.log(queueCases.length + poolCases.length + ' offline list-name cases passed');
} finally {
  // Only remove the directory freshly created by this proof, never user data.
  fs.rmSync(dir, {recursive: true, force: true});
}

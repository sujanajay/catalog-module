// Run with node infra/tests/preview-gpu-url.test.mjs. No provider calls.
// A preview deploy (CATALOG_PREVIEW=1) reuses the GPU cut-out URL from the live catalog-worker.
// gcloud 589 rejects the filter() transform in --format=value, so deploy.sh reads the worker's
// --format=json instead. The URL is used when present, an absent URL does not abort, and a
// gcloud failure still stops the deploy.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-preview-gpu-url-'));

// The preview branch of the GPU step in deploy.sh, up to the line that adds the URL to WORKER_ENV.
const deploy = fs.readFileSync(path.join(infra, 'deploy.sh'), 'utf8').split(/\r?\n/);
const gpuStep = deploy.findIndex((l) => l === 'echo "==> matting GPU"');
const start = deploy.findIndex((l, i) => i > gpuStep && l === 'if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then');
const end = deploy.findIndex((l, i) => i > start && l.includes('WORKER_ENV+=",MATTING_GPU_URL=$MATTING_GPU_URL"'));
assert.ok(gpuStep >= 0 && start > gpuStep && end > start, 'Preview GPU block not found in deploy.sh');
const previewBlock = deploy.slice(start, end + 1).join('\n') + '\nfi';

// Fake gcloud: logs each call, prints $DESCRIBE_JSON (with CRLF, as on Windows), fails when DESCRIBE_FAIL=1.
const script = `set -euo pipefail
gcloud() {
  printf '%s\\n' "$*" >> "$LOG"
  [ "\${DESCRIBE_FAIL:-0}" = 1 ] && { echo 'PERMISSION_DENIED mocked' >&2; return 1; }
  printf '%s\\r\\n' "$DESCRIBE_JSON"
}
gcv() { gcloud "$@" | tr -d '\\r'; }
REGION=asia-south1 CATALOG_PREVIEW=1 WORKER_ENV="BUCKET=b"
MATTING_GPU_URL=""
${previewBlock}
echo "URL=[$MATTING_GPU_URL]"
echo "ENV=[$WORKER_ENV]"`;

const service = (env) => JSON.stringify({spec: {template: {spec: {containers: [{image: 'x', env}]}}}});
const gpu = 'https://catalog-matting-gpu-example-as.a.run.app';
const cases = [
  {
    label: 'url-present',
    json: service([
      {name: 'MATTING_URL', value: 'https://cpu.example'},
      {name: 'MATTING_GPU_URL', value: gpu},
      {name: 'DB_PASSWORD', valueFrom: {secretKeyRef: {name: 'db', key: 'latest'}}},
    ]),
    url: gpu,
    env: `BUCKET=b,MATTING_GPU_URL=${gpu}`,
  },
  {label: 'url-absent', json: service([{name: 'MATTING_URL', value: 'https://cpu.example'}]), url: '', env: 'BUCKET=b'},
  {label: 'no-env-list', json: service(undefined), url: '', env: 'BUCKET=b'},
  {label: 'describe-fails', json: '', fail: '1', status: 1},
];

try {
  for (const c of cases) {
    const log = path.join(dir, c.label + '.log');
    fs.writeFileSync(log, '');
    const r = spawnSync(bash, ['-c', script], {
      env: {...process.env, LOG: log, DESCRIBE_JSON: c.json, DESCRIBE_FAIL: c.fail || '0'},
      encoding: 'utf8',
      timeout: 60000,
    });
    if (r.error) throw r.error;
    assert.equal(r.status, c.status ?? 0, c.label + '\n' + r.stderr);
    const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(calls, ['run services describe catalog-worker --region=asia-south1 --format=json'], c.label);
    if (c.status) {
      assert.doesNotMatch(r.stdout, /URL=/, c.label + ' must stop before using the URL');
    } else {
      const out = r.stdout.replace(/\r/g, '');
      assert.match(out, new RegExp(`^URL=\\[${c.url.replace(/[.]/g, '\\.')}\\]$`, 'm'), c.label);
      assert.ok(out.includes(`ENV=[${c.env}]`), c.label + ' WORKER_ENV: ' + out);
    }
    console.log('PASS ' + c.label);
  }
  console.log(cases.length + ' offline preview GPU URL cases passed');
} finally {
  // Only remove the directory freshly created by this proof, never user data.
  fs.rmSync(dir, {recursive: true, force: true});
}

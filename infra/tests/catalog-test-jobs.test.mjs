// Run with node infra/tests/catalog-test-jobs.test.mjs. No provider calls: a fake gcloud and git on PATH.
// Spec 18 (plan 7.2, worker gate 7b): the smoke job gets the worker's UPSCALE_* env, so the smoke's enlargement case
// (apps/worker/src/catalog-smoke.ts enlargementCase) runs instead of reporting "The upscaler is off". 2026-10-30: the
// gated deploy of c7955bf skipped it because infra/catalog-test-jobs.sh copied only the DB, bucket and URL settings.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-jobs-'));
const posix = (p) => p.replaceAll('\\', '/');
fs.mkdirSync(path.join(dir, 'bin'));

const upscaleUrl = 'https://catalog-upscale-abc-el.a.run.app';
const base = [
  {name: 'GCP_PROJECT', value: 'image-links-agent'}, {name: 'REGION', value: 'asia-south1'},
  {name: 'BUCKET', value: 'image-links-agent-assets'}, {name: 'PUBLIC_BUCKET', value: 'public-bucket'},
  {name: 'DB_HOST', value: '10.0.0.3'}, {name: 'DB_NAME', value: 'catalog'}, {name: 'DB_USER', value: 'catalog'},
  {name: 'MATTING_URL', value: 'https://catalog-matting-abc-el.a.run.app'},
  {name: 'MATTING_GPU_URL', value: 'https://catalog-matting-gpu-abc-as.a.run.app'},
  {name: 'WORKER_URL', value: 'https://catalog-worker-abc-el.a.run.app'},
  {name: 'DB_PASSWORD', valueFrom: {secretKeyRef: {name: 'catalog-db-password', key: 'latest'}}},
  {name: 'TASKS_ENLARGE_QUEUE', value: 'catalog-enlarge'},
];
// What infra/deploy.sh gives the worker with UPSCALE_SERVICE=dedicated (values from infra/lib/shape.sh).
const upscale = [
  {name: 'UPSCALE_MIN_SCALE', value: '1'}, {name: 'UPSCALE_URL', value: upscaleUrl},
  {name: 'UPSCALE_TIMEOUT_S', value: '1740'}, {name: 'UPSCALE_COLD_START_S', value: '120'},
  {name: 'UPSCALE_MAX_PIXELS', value: '5400000'}, {name: 'UPSCALE_MAX_PIXELS_X4', value: '4900000'},
  {name: 'UPSCALE_MODEL', value: 'swinir-x2'}, {name: 'UPSCALE_MODEL_X4', value: 'swinir-x4'},
];
const writeWorker = (env) => fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({spec: {template: {spec: {containers: [{env}]}}}}));

// Fake gcloud: the worker description from the fixture, no existing jobs, and `jobs replace` keeps the job file.
fs.writeFileSync(path.join(dir, 'bin', 'gcloud'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/calls.log"
case "$*" in
  *"services describe catalog-worker "*) cat "$FAKE_DIR/worker.json" ;;
  *"jobs list"*) echo '[]' ;;
  *"jobs replace"*) cp "$4" "$FAKE_DIR/job-$(basename "$4")" ;;
esac
`, {mode: 0o755});
// Fake git: a clean tree at commit abc1234 (the script refuses a dirty tree).
fs.writeFileSync(path.join(dir, 'bin', 'git'), `#!/usr/bin/env bash
case "$*" in
  "rev-parse --short HEAD") echo abc1234 ;;
  "status --porcelain") ;;
  *) exit 1 ;;
esac
`, {mode: 0o755});

function run(jobs, extraEnv = {}) {
  for (const name of fs.readdirSync(dir)) if (name.startsWith('job-') || name === 'calls.log') fs.rmSync(path.join(dir, name));
  const r = spawnSync(bash, ['-c', 'export PATH="$(cygpath -u "$FAKE_DIR" 2>/dev/null || printf %s "$FAKE_DIR")/bin:$PATH"; bash infra/catalog-test-jobs.sh'],
    {cwd: root, env: {...process.env, FAKE_DIR: posix(dir), CATALOG_TEST_RUN: '0f1e2d3c-4b5a-4968-8776-655443322110', CATALOG_TEST_JOBS: jobs, MATTING_URL: '', ...extraEnv}, encoding: 'utf8'});
  const job = (kind) => {
    const file = path.join(dir, `job-${kind}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };
  return {status: r.status, stderr: r.stderr, stdout: r.stdout, job};
}
const envOf = (job) => Object.fromEntries(job.spec.template.spec.template.spec.containers[0].env.map((e) => [e.name, e.value ?? e.valueFrom]));

try {
  // 1. The smoke job carries every UPSCALE_* setting of the worker with the worker's values.
  writeWorker([...base, ...upscale]);
  let r = run('smoke real');
  assert.equal(r.status, 0, r.stderr);
  const smoke = envOf(r.job('smoke'));
  for (const {name, value} of upscale) assert.equal(smoke[name], value, `the smoke job lacks ${name}`);
  // The rest of the job is unchanged: the DB secret is a reference, the job pool is 1, the smoke's real data dir is set.
  assert.deepEqual(smoke.DB_PASSWORD, {secretKeyRef: {name: 'catalog-db-password', key: 'latest'}});
  assert.equal(smoke.DB_POOL_MAX, '1');
  assert.equal(smoke.REAL_DATA_DIR, '/tmp/catalog-data');
  // Only the smoke gets them: the real job keeps its own (upscaler-free) configuration, and nothing unrelated is copied.
  const real = envOf(r.job('real'));
  assert(!Object.keys(real).some((name) => name.startsWith('UPSCALE_')), 'the real job must not get the UPSCALE_* env');
  assert.equal(smoke.TASKS_ENLARGE_QUEUE, undefined);

  // 2. The gate passes the candidates' matting URLs; the UPSCALE_* env still comes from the worker (its candidate).
  r = run('smoke', {MATTING_URL: 'https://candidate---catalog-matting-abc-el.a.run.app', MATTING_GPU_URL: '', WORKER_URL: 'https://candidate---catalog-worker-abc-el.a.run.app'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(envOf(r.job('smoke')).UPSCALE_URL, upscaleUrl);
  assert.equal(envOf(r.job('smoke')).UPSCALE_MODEL_X4, 'swinir-x4');

  // 3. A worker with the upscaler on but no Cloud Run UPSCALE_URL is refused before any job changes.
  writeWorker([...base, ...upscale.filter((e) => e.name !== 'UPSCALE_URL')]);
  r = run('smoke');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /UPSCALE_MODEL but no Cloud Run UPSCALE_URL/);
  assert.equal(r.job('smoke'), null);

  // 4. A worker with the upscaler off gives a smoke job without UPSCALE_MODEL (the case then reports skipped).
  writeWorker(base);
  r = run('smoke');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(envOf(r.job('smoke')).UPSCALE_MODEL, undefined);

  // 5. A secret reference under an UPSCALE_ name is never copied.
  writeWorker([...base, ...upscale, {name: 'UPSCALE_TOKEN', valueFrom: {secretKeyRef: {name: 'x', key: 'latest'}}}]);
  r = run('smoke');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(envOf(r.job('smoke')).UPSCALE_TOKEN, undefined);
  console.log('catalog-test-jobs tests passed');
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}

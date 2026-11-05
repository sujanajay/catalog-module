// Run with node infra/tests/labels.test.mjs. Offline, no gcloud.
// M6-F1 (M6-S1): every Cloud Run service and job of the catalog carries app=catalog, component=<its name> and
// env=live|preview|test; deploy_service and every job script refuse a deploy without them.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import {spawnSync} from 'node:child_process';
import {gitBashPath} from '../../packages/core/src/git-bash.ts';

const root = path.resolve(import.meta.dirname, '../..');
const bash = process.env.CATALOG_BASH || gitBashPath();
const sh = (script, env = {}) => {
  const r = spawnSync(bash, ['-c', `set -euo pipefail\ncd "$ROOT"\nsource infra/lib/labels.sh\n${script}`], {env: {...process.env, ROOT: root, ...env}, encoding: 'utf8', timeout: 60000});
  if (r.error) throw r.error;
  return {status: r.status, out: r.stdout.replace(/\r/g, ''), err: r.stderr.replace(/\r/g, '')};
};
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('catalog_labels: live by default, preview on the preview stack, or the env given', () => {
  assert.equal(sh('catalog_labels catalog-worker').out, 'app=catalog,component=catalog-worker,env=live');
  assert.equal(sh('catalog_labels catalog-worker-preview', {CATALOG_PREVIEW: '1'}).out, 'app=catalog,component=catalog-worker-preview,env=preview');
  assert.equal(sh('catalog_labels catalog-test-smoke test').out, 'app=catalog,component=catalog-test-smoke,env=test');
});

test('catalog_labels_check: refuses a missing app, component or env (the old app=catalog,component=job too)', () => {
  assert.equal(sh('catalog_labels_check x "app=catalog,component=catalog-migrate,env=live"').status, 0);
  for (const bad of ['', 'app=catalog,component=job', 'component=catalog-worker,env=live', 'app=catalog,env=live', 'app=catalog,component=catalog-worker,env=prod']) {
    const r = sh(`catalog_labels_check thing "${bad}"`);
    assert.equal(r.status, 1, bad);
    assert.match(r.err, /refusing to deploy thing without the labels app=catalog, component=<name> and env=live\|preview\|test/);
  }
});

test('catalog_labels_in_args: reads --labels=v and --labels v', () => {
  assert.equal(sh('catalog_labels_in_args --region=r --labels=app=catalog,component=a,env=live --x').out, 'app=catalog,component=a,env=live');
  assert.equal(sh('catalog_labels_in_args --labels "app=catalog,component=b,env=test"').out, 'app=catalog,component=b,env=test');
  assert.equal(sh('catalog_labels_in_args --region=r').out, '');
});

test('deploy_service refuses a service whose deploy args carry no labels, before any gcloud call', () => {
  const r = spawnSync(bash, ['-c', `set -euo pipefail
cd "$ROOT"
gcloud() { echo "gcloud called: $*" >&2; return 1; }
source infra/lib/services.sh
source infra/lib/gate.sh
service_test_svc() { SVC_NAME=test-svc; SVC_REGION=asia-south1; SVC_DEPLOY=1; SVC_SHIFT=1; SVC_ARGS=(--image=x --region=asia-south1); }
deploy_service test-svc`], {env: {...process.env, ROOT: root}, encoding: 'utf8', timeout: 60000});
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing to deploy test-svc without the labels/);
  assert.doesNotMatch(r.stderr, /gcloud called/);
});

test('every service in the registry and every job script labels with its own name and an env', () => {
  const read = (f) => fs.readFileSync(path.join(root, 'infra', f), 'utf8');
  const services = read('lib/services.sh');
  for (const name of ['catalog-matting', 'catalog-upscale', 'catalog-upscale-gpu', 'catalog-matting-gpu']) assert.ok(services.includes(`--labels="$(catalog_labels ${name} live)"`), name);
  assert.ok(services.includes('--labels="$(catalog_labels "$WORKER_SERVICE")"') && services.includes('--labels="$(catalog_labels "$WEB_SERVICE")"'));
  const files = fs.readdirSync(path.join(root, 'infra')).filter((f) => f.endsWith('.sh')).concat(fs.readdirSync(path.join(root, 'infra/lib')).map((f) => `lib/${f}`));
  for (const f of files) {
    const text = read(f);
    assert.doesNotMatch(text, /component=job\b|component: ?'job'/, `${f} still labels a job component=job`);
    // Every job deploy names its labels from a checked variable.
    for (const m of text.matchAll(/gcloud run jobs deploy(?:[^\n]*\\\n)*[^\n]*/g)) {
      // A deploy from a flags file (check-matting.sh) carries its labels in the file, asserted below.
      if (!m[0].includes('--flags-file')) assert.match(m[0], /--labels="\$[A-Za-z_]+"/, `${f}: ${m[0].slice(0, 80)}`);
    }
  }
  for (const f of ['catalog-eval.sh', 'catalog-output-evals.sh', 'catalog-qa-check.sh', 'catalog-scale-jobs.sh', 'deploy.sh']) assert.match(read(f), /catalog_labels_check /, f);
  assert.match(read('catalog-test-jobs.sh'), /labels:\{app:'catalog',component:name,env:/);
  assert.match(read('check-matting.sh'), /'--labels': \{ app: 'catalog', component: process\.env\.PROBE_JOB, env: 'test' \}/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n${e.message}`); }
}
if (failed) process.exit(1);

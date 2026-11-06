// Run with node infra/tests/catalog-cost-reconcile.test.mjs. No provider calls: a fake gcloud on PATH.
// M6-S2: infra/catalog-cost-reconcile.sh is check-then-create. A first run grants catalog-worker@ the read-only
// Monitoring and Cloud Run viewer roles, creates the Cloud Run job (copied from the live catalog-worker, DB password as a
// secret reference only) and the 06:00 UTC schedule, then runs a 14-day backfill; a second run against that state
// changes nothing; a new worker image updates only the job; nothing is ever deleted; every call runs with
// CLOUDSDK_CORE_PROJECT=image-links-agent.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-cost-reconcile-'));
const posix = (p) => p.replaceAll('\\', '/');
fs.mkdirSync(path.join(dir, 'bin'));
fs.mkdirSync(path.join(dir, 'state'));
const WORKER = 'catalog-worker@image-links-agent.iam.gserviceaccount.com';
const IMAGE = 'asia-south1-docker.pkg.dev/image-links-agent/apps/worker:abc1234';
const URI = 'https://run.googleapis.com/v2/projects/image-links-agent/locations/asia-south1/jobs/catalog-cost-reconcile:run';
const ROLES = ['roles/monitoring.viewer', 'roles/run.viewer', 'roles/logging.viewer', 'roles/run.invoker'];

const workerEnv = [
  {name: 'GCP_PROJECT', value: 'image-links-agent'}, {name: 'REGION', value: 'asia-south1'},
  {name: 'DB_HOST', value: '10.0.0.3'}, {name: 'DB_NAME', value: 'catalog'}, {name: 'DB_USER', value: 'catalog'},
  {name: 'DB_PASSWORD', valueFrom: {secretKeyRef: {name: 'catalog-db-password', key: 'latest'}}},
  {name: 'OPENROUTER_API_KEY', valueFrom: {secretKeyRef: {name: 'openrouter-api-key', key: 'latest'}}},
  {name: 'DB_POOL_MAX', value: '8'},
];
const writeWorker = (image) => fs.writeFileSync(path.join(dir, 'state', 'worker.json'), JSON.stringify({spec: {template: {spec: {containers: [{image, env: workerEnv}]}}}}));

// Fake gcloud: log "<CLOUDSDK_CORE_PROJECT>|gcloud <args>", answer reads from $STATE, record writes.
fs.writeFileSync(path.join(dir, 'bin', 'gcloud'), `#!/usr/bin/env bash
printf '%s|gcloud %s\\n' "\${CLOUDSDK_CORE_PROJECT:-unset}" "$*" >> "$FAKE_DIR/calls.log"
S="$FAKE_DIR/state"
case "$*" in
  "run services describe catalog-worker "*) cat "$S/worker.json" ;;
  "run jobs list"*"--format=json"*) if [ -f "$S/job.json" ]; then printf '[%s]\\r\\n' "$(cat "$S/job.json")"; else echo '[]'; fi ;;
  "run jobs list"*) [ -f "$S/job.json" ] && printf 'catalog-cost-reconcile\\r\\n' || true ;;
  "run jobs replace "*) cp "$4" "$S/job.json" ;;
  "run jobs executions list"*) cat "$S/executions.txt" 2>/dev/null || true ;;
  "run jobs execute "*) [ "\${FAIL_EXECUTE:-0}" = 1 ] && exit 1; printf 'exec-1\\t1\\r\\n' > "$S/executions.txt" ;;
  "projects get-iam-policy"*) cat "$S/policy.csv" 2>/dev/null || true ;;
  "projects add-iam-policy-binding"*) ;;
  "scheduler jobs describe"*) [ -f "$S/schedule.txt" ] || { echo 'NOT_FOUND' >&2; exit 1; }; printf '%s\\r\\n' "$(cat "$S/schedule.txt")" ;;
  "scheduler jobs create"*|"scheduler jobs update"*) ;;
  *) echo "fake gcloud: unexpected $*" >&2; exit 9 ;;
esac
`, {mode: 0o755});

function run(args = [], env = {}) {
  fs.rmSync(path.join(dir, 'calls.log'), {force: true});
  const r = spawnSync(bash, ['-c', `export PATH="$(cygpath -u "$FAKE_DIR" 2>/dev/null || printf %s "$FAKE_DIR")/bin:$PATH"; bash infra/catalog-cost-reconcile.sh ${args.join(' ')}`],
    {cwd: root, env: {...process.env, FAKE_DIR: posix(dir), CLOUDSDK_CORE_PROJECT: 'someone-elses-project', ...env}, encoding: 'utf8'});
  const log = path.join(dir, 'calls.log');
  return {status: r.status, stdout: r.stdout, stderr: r.stderr, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []};
}
const lines = (r, tag) => r.stdout.split('\n').filter((l) => l.includes(`] ${tag} `));
const job = () => JSON.parse(fs.readFileSync(path.join(dir, 'state', 'job.json'), 'utf8'));

let cases = 0;
try {
  // 0. deploy.sh's "job" mode before the reconciliation was set up: nothing is created.
  writeWorker(IMAGE);
  let r = run(['job']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual([lines(r, 'CREATE'), lines(r, 'SKIP').length], [[], 1], r.stdout);
  assert.ok(!fs.existsSync(path.join(dir, 'state', 'job.json')), 'job mode created the job');
  console.log('PASS job mode leaves a job that was never set up alone');
  cases++;

  // 1. First run on an empty project: everything is created, then a 14-day backfill runs.
  r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const c of r.calls) assert.ok(c.startsWith('image-links-agent|'), 'project not pinned: ' + c);
  assert.ok(!r.calls.some((c) => / delete|remove-iam|\brm\b/.test(c)), 'a delete was called');
  for (const role of ROLES) {
    assert.ok(r.calls.some((c) => c.includes(`projects add-iam-policy-binding image-links-agent --member=serviceAccount:${WORKER} --role=${role}`)), role);
  }
  assert.ok(!r.calls.some((c) => /--role=roles\/(editor|owner|monitoring\.editor|run\.admin|run\.developer)/.test(c)), 'only read roles are granted');
  const j = job();
  assert.deepEqual(j.metadata, {name: 'catalog-cost-reconcile', labels: {app: 'catalog', component: 'catalog-cost-reconcile', env: 'live'}});
  const task = j.spec.template.spec.template.spec;
  assert.equal(task.serviceAccountName, WORKER);
  assert.equal(task.maxRetries, 2);
  const c = task.containers[0];
  assert.equal(c.image, IMAGE);
  assert.deepEqual([c.command, c.args], [['node'], ['dist/catalog-cost-reconcile.js']]);
  const env = Object.fromEntries(c.env.map((e) => [e.name, e.value ?? e.valueFrom]));
  assert.deepEqual(env.DB_PASSWORD, {secretKeyRef: {name: 'catalog-db-password', key: 'latest'}});
  assert.equal(env.DB_POOL_MAX, '1');
  assert.equal(env.OPENROUTER_API_KEY, undefined, 'the reconcile job never gets the OpenRouter key');
  assert.match(j.spec.template.metadata.annotations['run.googleapis.com/network-interfaces'], /ila-vpc/);
  const sched = r.calls.find((x) => x.includes('scheduler jobs create http catalog-cost-reconcile'));
  assert.ok(sched, 'schedule not created');
  for (const part of ['--schedule=0 6 * * *', '--time-zone=Etc/UTC', `--uri=${URI}`, '--http-method=POST', `--oauth-service-account-email=${WORKER}`]) assert.ok(sched.includes(part), 'schedule lacks ' + part);
  assert.ok(r.calls.some((x) => x.endsWith('gcloud run jobs execute catalog-cost-reconcile --region=asia-south1 --update-env-vars=COST_RECONCILE_DAYS=14 --wait')), 'first backfill not run');
  assert.equal(lines(r, 'CREATE').length, 7, r.stdout);
  console.log('PASS first run creates four read roles, job and schedule, then runs a 14-day backfill');
  cases++;

  // 2. Second run against that state: nothing created or updated.
  fs.writeFileSync(path.join(dir, 'state', 'policy.csv'), ROLES.map((role) => `${role},serviceAccount:${WORKER}\r\n`).join(''));
  fs.writeFileSync(path.join(dir, 'state', 'schedule.txt'), `0 6 * * *|Etc/UTC|${URI}|${WORKER}`);
  r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual([lines(r, 'CREATE'), lines(r, 'UPDATE')], [[], []], r.stdout);
  assert.equal(lines(r, 'SKIP').length, 6, r.stdout);
  assert.ok(!r.calls.some((x) => /jobs replace|jobs execute|add-iam-policy-binding|scheduler jobs (create|update)/.test(x)), 'a write on a re-run');
  console.log('PASS re-run is all SKIP');
  cases++;

  // 3. A deploy moved catalog-worker to a new image: "job" updates only the job.
  writeWorker(IMAGE.replace('abc1234', 'def5678'));
  r = run(['job']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(lines(r, 'UPDATE').length, 1, r.stdout);
  assert.equal(job().spec.template.spec.template.spec.containers[0].image, IMAGE.replace('abc1234', 'def5678'));
  assert.ok(!r.calls.some((x) => /scheduler|iam/.test(x)), 'job mode touched more than the job');
  console.log('PASS job mode follows the worker image');
  cases++;

  // 4. "run" takes the number of days, refuses a bad one before any call.
  r = run(['run', '7']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.calls.some((x) => x.endsWith('gcloud run jobs execute catalog-cost-reconcile --region=asia-south1 --update-env-vars=COST_RECONCILE_DAYS=7 --wait')), r.calls.join('\n'));
  r = run(['run', '43']);
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, []);
  console.log('PASS run takes 1 to 42 days');
  cases++;

  // 5. No successful execution yet: setup runs one; a failed first run stops setup; the opt-out only prints the step.
  fs.writeFileSync(path.join(dir, 'state', 'executions.txt'), 'exec-0\t0\r\n');
  r = run([], {FAIL_EXECUTE: '1'});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the first run of catalog-cost-reconcile failed; read its logs/);
  r = run([], {COST_RECONCILE_SKIP_FIRST_RUN: '1'});
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /NEXT STEP: no successful run of catalog-cost-reconcile yet/);
  assert.ok(!r.calls.some((x) => x.includes('jobs execute')), 'the opt-out executed the job');
  console.log('PASS first run: failure stops setup, opt-out prints the next step');
  cases++;
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}
console.log(`${cases} offline cost reconcile infra cases passed`);

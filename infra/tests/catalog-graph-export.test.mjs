// Run with node infra/tests/catalog-graph-export.test.mjs. No provider calls: fake gcloud and bq on PATH.
// M0-S4: infra/catalog-graph-export.sh is check-then-create. A first run creates the catalog_os dataset, the worker's
// grants, the Cloud Run job (copied from the live catalog-worker, DB password as a secret reference only) and the
// 02:30 UTC schedule; a second run against that state changes nothing; a new worker image updates only the job;
// nothing is ever deleted; every call runs with CLOUDSDK_CORE_PROJECT=image-links-agent.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-graph-export-'));
const posix = (p) => p.replaceAll('\\', '/');
fs.mkdirSync(path.join(dir, 'bin'));
fs.mkdirSync(path.join(dir, 'state'));
const WORKER = 'catalog-worker@image-links-agent.iam.gserviceaccount.com';
const IMAGE = 'asia-south1-docker.pkg.dev/image-links-agent/apps/worker:abc1234';
const URI = 'https://run.googleapis.com/v2/projects/image-links-agent/locations/asia-south1/jobs/catalog-graph-export:run';

const workerEnv = [
  {name: 'GCP_PROJECT', value: 'image-links-agent'}, {name: 'REGION', value: 'asia-south1'},
  {name: 'DB_HOST', value: '10.0.0.3'}, {name: 'DB_NAME', value: 'catalog'}, {name: 'DB_USER', value: 'catalog'},
  {name: 'DB_PASSWORD', valueFrom: {secretKeyRef: {name: 'catalog-db-password', key: 'latest'}}},
  {name: 'OPENROUTER_API_KEY', valueFrom: {secretKeyRef: {name: 'openrouter-api-key', key: 'latest'}}},
  {name: 'DB_POOL_MAX', value: '8'},
];
const writeWorker = (image) => fs.writeFileSync(path.join(dir, 'state', 'worker.json'), JSON.stringify({spec: {template: {spec: {containers: [{image, env: workerEnv}]}}}}));

// Fake gcloud and bq: log "<CLOUDSDK_CORE_PROJECT>|<tool> <args>", answer reads from $STATE, record writes.
fs.writeFileSync(path.join(dir, 'bin', 'gcloud'), `#!/usr/bin/env bash
printf '%s|gcloud %s\\n' "\${CLOUDSDK_CORE_PROJECT:-unset}" "$*" >> "$FAKE_DIR/calls.log"
S="$FAKE_DIR/state"
case "$*" in
  "run services describe catalog-worker "*) cat "$S/worker.json" ;;
  "run jobs list"*) if [ -f "$S/job.json" ]; then printf '[%s]\\r\\n' "$(cat "$S/job.json")"; else echo '[]'; fi ;;
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
fs.writeFileSync(path.join(dir, 'bin', 'bq'), `#!/usr/bin/env bash
printf '%s|bq %s\\n' "\${CLOUDSDK_CORE_PROJECT:-unset}" "$*" >> "$FAKE_DIR/calls.log"
S="$FAKE_DIR/state"
case "$*" in
  *" show --format=prettyjson image-links-agent:catalog_os") [ -f "$S/dataset.json" ] || exit 1; cat "$S/dataset.json" ;;
  *" mk --dataset "*) ;;
  "query "*) { cat; printf '\\n'; } >> "$FAKE_DIR/sql.log" ;;
  *) echo "fake bq: unexpected $*" >&2; exit 9 ;;
esac
`, {mode: 0o755});

function run(args = [], env = {}) {
  for (const f of ['calls.log', 'sql.log']) fs.rmSync(path.join(dir, f), {force: true});
  const r = spawnSync(bash, ['-c', `export PATH="$(cygpath -u "$FAKE_DIR" 2>/dev/null || printf %s "$FAKE_DIR")/bin:$PATH"; bash infra/catalog-graph-export.sh ${args.join(' ')}`],
    {cwd: root, env: {...process.env, FAKE_DIR: posix(dir), CLOUDSDK_CORE_PROJECT: 'someone-elses-project', ...env}, encoding: 'utf8'});
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');
  return {status: r.status, stdout: r.stdout, stderr: r.stderr, calls: read('calls.log').split('\n').filter(Boolean), sql: read('sql.log')};
}
const lines = (r, tag) => r.stdout.split('\n').filter((l) => l.includes(`] ${tag} `));
const job = () => JSON.parse(fs.readFileSync(path.join(dir, 'state', 'job.json'), 'utf8'));

let cases = 0;
try {
  // 0. deploy.sh's "job" mode before the export was set up: nothing is created.
  writeWorker(IMAGE);
  let r = run(['job']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual([lines(r, 'CREATE'), lines(r, 'SKIP').length], [[], 1], r.stdout);
  assert.ok(!fs.existsSync(path.join(dir, 'state', 'job.json')), 'job mode created the job');
  console.log('PASS job mode leaves a job that was never set up alone');
  cases++;

  // 1. First run on an empty project: everything is created.
  r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const c of r.calls) assert.ok(c.startsWith('image-links-agent|'), 'project not pinned: ' + c);
  assert.ok(!r.calls.some((c) => / delete|remove-iam|\brm\b/.test(c)), 'a delete was called');
  assert.ok(r.calls.some((c) => c.includes('bq --project_id=image-links-agent --location=asia-south1 mk --dataset') && c.endsWith('image-links-agent:catalog_os')), 'dataset not created');
  assert.ok(r.sql.includes(`GRANT \`roles/bigquery.dataEditor\` ON SCHEMA \`image-links-agent\`.catalog_os TO "serviceAccount:${WORKER}"`), 'worker grant: ' + r.sql);
  assert.ok(!r.sql.includes('dataViewer'), 'no data team grant without DATA_TEAM_MEMBER');
  for (const role of ['roles/bigquery.jobUser', 'roles/run.invoker']) {
    assert.ok(r.calls.some((c) => c.includes(`projects add-iam-policy-binding image-links-agent --member=serviceAccount:${WORKER} --role=${role}`)), role);
  }
  const j = job();
  assert.deepEqual(j.metadata, {name: 'catalog-graph-export', labels: {app: 'catalog', component: 'catalog-graph-export', env: 'live'}});
  const task = j.spec.template.spec.template.spec;
  assert.equal(task.serviceAccountName, WORKER);
  assert.equal(task.maxRetries, 2);
  const c = task.containers[0];
  assert.equal(c.image, IMAGE);
  assert.deepEqual([c.command, c.args], [['node'], ['dist/catalog-graph-export.js']]);
  const env = Object.fromEntries(c.env.map((e) => [e.name, e.value ?? e.valueFrom]));
  assert.deepEqual(env.DB_PASSWORD, {secretKeyRef: {name: 'catalog-db-password', key: 'latest'}});
  assert.equal(env.DB_POOL_MAX, '1');
  assert.equal(env.GRAPH_EXPORT_DATASET, 'catalog_os');
  assert.equal(env.OPENROUTER_API_KEY, undefined, 'the export job never gets the OpenRouter key');
  assert.match(j.spec.template.metadata.annotations['run.googleapis.com/network-interfaces'], /ila-vpc/);
  const sched = r.calls.find((x) => x.includes('scheduler jobs create http catalog-graph-export'));
  assert.ok(sched, 'schedule not created');
  for (const part of ['--schedule=30 2 * * *', '--time-zone=Etc/UTC', `--uri=${URI}`, '--http-method=POST', `--oauth-service-account-email=${WORKER}`]) assert.ok(sched.includes(part), 'schedule lacks ' + part);
  assert.ok(r.calls.some((x) => x.endsWith('gcloud run jobs execute catalog-graph-export --region=asia-south1 --wait')), 'first export not run');
  assert.equal(lines(r, 'CREATE').length, 7, r.stdout);
  console.log('PASS first run creates dataset, grant, two roles, job and schedule, then runs the first export');
  cases++;

  // 2. Second run against that state: nothing created or updated.
  fs.writeFileSync(path.join(dir, 'state', 'dataset.json'), JSON.stringify({location: 'asia-south1', access: [{role: 'WRITER', userByEmail: WORKER}]}));
  fs.writeFileSync(path.join(dir, 'state', 'policy.csv'), `roles/bigquery.jobUser,serviceAccount:${WORKER}\r\nroles/run.invoker,serviceAccount:${WORKER}\r\n`);
  fs.writeFileSync(path.join(dir, 'state', 'schedule.txt'), `30 2 * * *|Etc/UTC|${URI}|${WORKER}`);
  r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual([lines(r, 'CREATE'), lines(r, 'UPDATE')], [[], []], r.stdout);
  assert.equal(lines(r, 'SKIP').length, 7, r.stdout);
  assert.ok(!r.calls.some((x) => /jobs replace|jobs execute|add-iam-policy-binding|scheduler jobs (create|update)| mk /.test(x)), 'a write on a re-run');
  assert.equal(r.sql, '');
  console.log('PASS re-run is all SKIP');
  cases++;

  // 3. A deploy moved catalog-worker to a new image: "job" updates only the job.
  writeWorker(IMAGE.replace('abc1234', 'def5678'));
  r = run(['job']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(lines(r, 'UPDATE').length, 1, r.stdout);
  assert.equal(job().spec.template.spec.template.spec.containers[0].image, IMAGE.replace('abc1234', 'def5678'));
  assert.ok(!r.calls.some((x) => /scheduler|iam|bq /.test(x)), 'job mode touched more than the job');
  console.log('PASS job mode follows the worker image');
  cases++;

  // 4. The data team reader is granted only when named, and a malformed member is refused before any call.
  r = run([], {DATA_TEAM_MEMBER: 'group:data-team@opptra.com'});
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.sql.includes('GRANT `roles/bigquery.dataViewer` ON SCHEMA `image-links-agent`.catalog_os TO "group:data-team@opptra.com"'), r.sql);
  r = run([], {DATA_TEAM_MEMBER: 'data-team'});
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, []);
  console.log('PASS data team reader');
  cases++;

  // 4b. No successful execution yet: setup runs one; a failed first run stops setup; the opt-out only prints the step.
  fs.writeFileSync(path.join(dir, 'state', 'executions.txt'), 'exec-0\t0\r\n');
  r = run([], {FAIL_EXECUTE: '1'});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /the first run of catalog-graph-export failed; read its logs/);
  r = run([], {GRAPH_EXPORT_SKIP_FIRST_RUN: '1'});
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /NEXT STEP: no successful run of catalog-graph-export yet/);
  assert.ok(!r.calls.some((x) => x.includes('jobs execute')), 'the opt-out executed the job');
  console.log('PASS first run: failure stops setup, opt-out prints the next step');
  cases++;

  // 5. A dataset in another location stops the script before anything else.
  fs.writeFileSync(path.join(dir, 'state', 'dataset.json'), JSON.stringify({location: 'US', access: []}));
  r = run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /location 'US', expected asia-south1/);
  assert.ok(!r.calls.some((x) => /jobs replace|scheduler/.test(x)));
  console.log('PASS wrong dataset location refused');
  cases++;
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}
console.log(`${cases} offline graph export infra cases passed`);

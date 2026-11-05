// Run with node infra/tests/catalog-route-switch.test.mjs. No provider calls: a fake gcloud on PATH.
// R1 exit item 3: infra/catalog-route-switch.sh is check-then-create. Setup creates the Cloud Run job from the live
// catalog-worker (DB password as a secret reference only, no OpenRouter key, no retries, the built-in judge model);
// a second run changes nothing; "job" mode never creates it. set, show and drill pass their command per execution
// with who asked and refuse bad input before any execution. set and show wait for the execution's end state and print
// its log; a failed start, a start that names no execution and a failed execution all stop with an error. The drill
// returns after the start. Every call runs with CLOUDSDK_CORE_PROJECT=image-links-agent.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-route-switch-'));
const posix = (p) => p.replaceAll('\\', '/');
fs.mkdirSync(path.join(dir, 'bin'));
fs.mkdirSync(path.join(dir, 'state'));
const IMAGE = 'asia-south1-docker.pkg.dev/image-links-agent/apps/worker:abc1234';
const ROUTE = 'judge.render:openrouter:google/gemini-2.5-flash-lite';
const HAIKU = 'judge.render:openrouter:anthropic/claude-haiku-5.5';
const BATCH = '0b0e7c4e-1234-4abc-8def-0123456789ab';
const EXEC = 'catalog-route-switch-x7k2p';
const workerEnv = [
  {name: 'GCP_PROJECT', value: 'image-links-agent'}, {name: 'DB_HOST', value: '10.0.0.3'}, {name: 'DB_NAME', value: 'catalog'}, {name: 'DB_USER', value: 'catalog'},
  {name: 'DB_PASSWORD', valueFrom: {secretKeyRef: {name: 'catalog-db-password', key: 'latest'}}},
  {name: 'OPENROUTER_API_KEY', valueFrom: {secretKeyRef: {name: 'openrouter-api-key', key: 'latest'}}},
  {name: 'CATALOG_QA_DEFAULT_MODEL', value: 'google/gemini-2.5-flash-lite'},
  {name: 'DB_POOL_MAX', value: '8'},
];
const writeWorker = (image) => fs.writeFileSync(path.join(dir, 'state', 'worker.json'), JSON.stringify({spec: {template: {spec: {containers: [{image, env: workerEnv}]}}}}));

// Fake gcloud: log "<CLOUDSDK_CORE_PROJECT>|gcloud [arg] [arg]...", answer reads from $STATE. The execution's start and
// end are steered by EXEC_OUT (the printed name), EXEC_FAIL=1 (the start fails) and EXEC_END (succeeded or failed).
fs.writeFileSync(path.join(dir, 'bin', 'gcloud'), `#!/usr/bin/env bash
{ printf '%s|gcloud' "\${CLOUDSDK_CORE_PROJECT:-unset}"; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; } >> "$FAKE_DIR/calls.log"
S="$FAKE_DIR/state"
case "$*" in
  "run services describe catalog-worker "*) cat "$S/worker.json" ;;
  "run jobs list"*"--format=json"*) if [ -f "$S/job.json" ]; then printf '[%s]\\r\\n' "$(cat "$S/job.json")"; else echo '[]'; fi ;;
  "run jobs list"*) [ -f "$S/job.json" ] && printf 'catalog-route-switch\\r\\n' || true ;;
  "run jobs replace "*) cp "$4" "$S/job.json" ;;
  "run jobs execute "*) [ "\${EXEC_FAIL:-0}" = 1 ] && { echo 'ERROR: (gcloud.run.jobs.execute) PERMISSION_DENIED: run.jobs.runWithOverrides' >&2; exit 1; }
    printf '%s\\r\\n' "\${EXEC_OUT-${EXEC}}" ;;
  "run jobs executions describe "*)
    if [ "\${EXEC_END:-succeeded}" = succeeded ]; then printf '{"status":{"conditions":[{"type":"Completed","status":"True"}],"succeededCount":1}}\\r\\n'
    else printf '{"status":{"conditions":[{"type":"Completed","status":"False","message":"Task failed"}],"failedCount":1}}\\r\\n'; fi ;;
  "config get-value account"*) printf 'owner@opptra.com\\r\\n' ;;
  "logging read "*) printf 'Before:\\r\\n  judge.render rank 1 ${ROUTE}: serving\\r\\n' ;;
  *) echo "fake gcloud: unexpected $*" >&2; exit 9 ;;
esac
`, {mode: 0o755});

function run(args = [], env = {}) {
  fs.rmSync(path.join(dir, 'calls.log'), {force: true});
  const quoted = args.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ');
  const r = spawnSync(bash, ['-c', `export PATH="$(cygpath -u "$FAKE_DIR" 2>/dev/null || printf %s "$FAKE_DIR")/bin:$PATH"; bash infra/catalog-route-switch.sh ${quoted}`],
    {cwd: root, env: {...process.env, FAKE_DIR: posix(dir), CLOUDSDK_CORE_PROJECT: 'someone-elses-project', ROUTE_ACTOR: '', GCLOUD_POLL_S: '0', GCLOUD_RETRY_DELAY_S: '0', ...env}, encoding: 'utf8'});
  const log = fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8') : '';
  return {status: r.status, stdout: r.stdout, stderr: r.stderr, calls: log.split('\n').filter(Boolean)};
}
const lines = (r, tag) => r.stdout.split('\n').filter((l) => l.includes(`] ${tag} `));
const job = () => JSON.parse(fs.readFileSync(path.join(dir, 'state', 'job.json'), 'utf8'));
const executes = (r) => r.calls.filter((c) => c.includes('[run] [jobs] [execute]'));

let cases = 0;
try {
  writeWorker(IMAGE);
  // 0. deploy.sh's "job" mode before setup: nothing is created.
  let r = run(['job']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual([lines(r, 'CREATE'), lines(r, 'SKIP').length], [[], 1], r.stdout);
  assert.ok(!fs.existsSync(path.join(dir, 'state', 'job.json')));
  console.log('PASS job mode leaves a job that was never set up alone'); cases++;

  // 1. Commands before setup refuse without executing anything.
  r = run(['show']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not exist yet/);
  assert.equal(executes(r).length, 0);
  console.log('PASS commands refuse before the job exists'); cases++;

  // 2. Setup creates the job from the live worker: secret reference only, no OpenRouter key, no retries, labels.
  r = run([]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(lines(r, 'CREATE').length, 1, r.stdout);
  const created = job();
  const task = created.spec.template.spec.template.spec;
  const container = task.containers[0];
  assert.equal(container.image, IMAGE);
  assert.deepEqual([container.command, container.args], [['node'], ['dist/catalog-route-switch.js']]);
  assert.equal(task.maxRetries, 0);
  assert.ok(Number(task.timeoutSeconds) >= 360 * 60, 'the task timeout covers the longest drill');
  assert.deepEqual(created.metadata.labels, {app: 'catalog', component: 'catalog-route-switch', env: 'live'});
  assert.deepEqual(container.env.find((e) => e.name === 'DB_PASSWORD'), {name: 'DB_PASSWORD', valueFrom: {secretKeyRef: {name: 'catalog-db-password', key: 'latest'}}});
  assert.deepEqual(container.env.find((e) => e.name === 'CATALOG_QA_DEFAULT_MODEL'), {name: 'CATALOG_QA_DEFAULT_MODEL', value: 'google/gemini-2.5-flash-lite'});
  assert.ok(!container.env.some((e) => e.name === 'OPENROUTER_API_KEY'), 'the job never mounts the OpenRouter key');
  assert.ok(r.calls.every((c) => c.startsWith('image-links-agent|')), r.calls.join('\n'));
  console.log('PASS setup creates the job from the live worker, project pinned'); cases++;

  // 3. Re-run: SKIP, no replace, also when the API leaves out maxRetries 0. A new worker image: UPDATE.
  r = run([]);
  assert.deepEqual([lines(r, 'CREATE').length, lines(r, 'UPDATE').length, lines(r, 'SKIP').length], [0, 0, 1], r.stdout);
  const omitted = job(); delete omitted.spec.template.spec.template.spec.maxRetries;
  fs.writeFileSync(path.join(dir, 'state', 'job.json'), JSON.stringify(omitted));
  r = run(['job']);
  assert.equal(lines(r, 'SKIP').length, 1, r.stdout);
  assert.ok(!r.calls.some((c) => c.includes('[replace]')));
  writeWorker(IMAGE.replace('abc1234', 'def5678'));
  r = run(['job']);
  assert.equal(lines(r, 'UPDATE').length, 1, r.stdout);
  assert.match(job().spec.template.spec.template.spec.containers[0].image, /def5678$/);
  console.log('PASS re-run is a no-op (maxRetries 0 left out counts as same); a new worker image updates the job'); cases++;

  // 4. set: one execution with the command, route id, reason (commas kept) and gcloud account; waits for its end
  // state and prints its log (read by execution name).
  r = run(['set', ROUTE, 'off', 'vendor outage, see incident 12']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  let [call] = executes(r);
  assert.ok(call.includes(`[--update-env-vars=^~^ROUTE_COMMAND=set~ROUTE_ID=${ROUTE}~ROUTE_STATE=off~ROUTE_REASON=vendor outage, see incident 12~ROUTE_ACTOR=owner@opptra.com~ROUTE_FORCE=0]`), call);
  assert.ok(call.includes('[--async]') && call.includes('[--format=value(metadata.name)]'), call);
  assert.ok(r.calls.some((c) => c.includes(`[executions] [describe] [${EXEC}]`)), r.calls.join('\n'));
  assert.ok(r.calls.some((c) => c.includes('[logging] [read]') && c.includes(`labels."run.googleapis.com/execution_name"="${EXEC}"`)), r.calls.join('\n'));
  assert.match(r.stdout, /judge\.render rank 1 .*: serving/);
  assert.match(r.stdout, new RegExp(`execution ${EXEC} succeeded`));
  r = run(['set', ROUTE, 'off', 'last route', '--force']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(executes(r)[0].includes('~ROUTE_FORCE=1]'));
  console.log('PASS set passes the change with reason, who asked and --force, waits for the end state and prints the log'); cases++;

  // 5. Bad input is refused before any execution.
  for (const bad of [['set', ROUTE, 'retired', 'reason here'], ['set', 'not-a-route', 'off', 'reason here'], ['set', ROUTE, 'off', 'x'], ['set', ROUTE, 'off', 'bad & reason'],
    ['set', ROUTE, 'off', 'reason here', '--forced'], ['drill', 'judge.render', '0', 'reason here'], ['drill', 'judge.render', '361', 'reason here'], ['drill', 'judge.fake', '5', 'reason here'],
    ['drill', 'judge.render', '5', 'reason here', 'abc'], ['drill', 'judge.render', '5', 'reason here', '--route=vision.read:openrouter:a/b'], ['drill', 'judge.render', '5', 'reason here', BATCH, BATCH]]) {
    r = run(bad);
    assert.notEqual(r.status, 0, bad.join(' '));
    assert.equal(executes(r).length, 0, bad.join(' '));
  }
  console.log('PASS bad states, ids, flags, reasons, lengths, routes and batch ids are refused before executing'); cases++;

  // 6. A start that fails, one that names no execution, and an execution that fails all stop with an error.
  r = run(['set', ROUTE, 'off', 'reason here'], {EXEC_FAIL: '1'});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PERMISSION_DENIED/);
  assert.match(r.stderr, /could not start catalog-route-switch/);
  for (const out of ['', 'Execution started']) {
    r = run(['drill', 'judge.render', '30', 'reason here'], {EXEC_OUT: out});
    assert.notEqual(r.status, 0, `name '${out}'`);
    assert.match(r.stderr, /named no execution/);
    assert.doesNotMatch(r.stdout, /end it early/);
    assert.ok(!r.calls.some((c) => c.includes('[logging] [read]')), 'no log read without an execution name');
  }
  r = run(['set', ROUTE, 'off', 'reason here'], {EXEC_END: 'failed'});
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`execution ${EXEC}: failed: Task failed`));
  assert.match(r.stdout, /judge\.render rank 1/, 'the failed execution log is printed');
  console.log('PASS a failed start, a nameless start and a failed execution stop with an error'); cases++;

  // 7. drill: async start with capability, minutes, batch and a named route; ROUTE_ACTOR overrides the account.
  r = run(['drill', 'judge.render', '90', 'R1 exit item 3', BATCH, `--route=${HAIKU}`], {ROUTE_ACTOR: 'sujan@opptra.com'});
  assert.equal(r.status, 0, r.stderr + r.stdout);
  [call] = executes(r);
  assert.ok(call.includes(`[--update-env-vars=^~^ROUTE_COMMAND=drill~DRILL_CAPABILITY=judge.render~DRILL_MINUTES=90~DRILL_BATCH=${BATCH}~DRILL_ROUTE=${HAIKU}~ROUTE_REASON=R1 exit item 3~ROUTE_ACTOR=sujan@opptra.com]`), call);
  assert.ok(call.includes('[--async]'), call);
  assert.ok(!r.calls.some((c) => c.includes('[describe]')), 'the drill does not wait');
  assert.match(r.stdout, new RegExp(`executions cancel ${EXEC} `));
  assert.match(r.stdout, /comes back on its own at the expiry/);
  console.log('PASS drill starts asynchronously with its batch, route and actor'); cases++;

  // 8. show with a capability.
  r = run(['show', 'vision.read']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(executes(r)[0].includes('[--update-env-vars=^~^ROUTE_COMMAND=show~ROUTE_CAPABILITY=vision.read]'));
  console.log('PASS show'); cases++;
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}
console.log(`${cases} cases passed`);

// Run with node infra/tests/gcloud-retry.test.mjs. Offline: gcloud is a fake bash function, no GCP call.
// 2026-11-05 root-cause review item 2 (stops #11, #12, #15): a laptop network blip during a gcloud read or while a gate
// waits for a probe job must not fail the gate, and an unknown result must never pass it.
// The fake answers each kind of call from a comma list (the last item repeats):
//   READ_SEQ   for "run services describe" (and any other read):  ok | dns | reset | notfound | denied | reauth
//   EXEC_SEQ   for "run jobs execute":                            ok | dns | reset | denied
//   POLL_SEQ   for "run jobs executions describe":                running | succeeded | failed | partial | busy | dns | denied | garbage | nospace
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-gcloud-retry-'));

const fake = 'source infra/tests/gcloud-retry-fake.sh';

let n = 0;
function run(body, env = {}) {
  const state = path.join(dir, String(++n));
  fs.mkdirSync(state);
  const log = path.join(state, 'calls.log');
  fs.writeFileSync(log, '');
  const r = spawnSync(bash, ['-c', `set -euo pipefail\ncd "$ROOT"\nsource infra/lib/gcloud-retry.sh\n${fake}\n${body}`], {
    env: {...process.env, ROOT: root, LOG: log, STATE: state, GCLOUD_RETRY_DELAY_S: '0', GCLOUD_POLL_S: '0', GCLOUD_POLL_OUTAGE_S: '60', ...env},
    encoding: 'utf8', timeout: 120000,
  });
  if (r.error) throw r.error;
  const calls = fs.readFileSync(log, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
  return {status: r.status, out: r.stdout.replace(/\r/g, ''), err: r.stderr.replace(/\r/g, ''), calls};
}
const count = (calls, prefix) => calls.filter((c) => c.startsWith(prefix)).length;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('gcloud_retry: a DNS failure, then success, returns the output and logs the retry', () => {
  const r = run('gcloud_retry gcloud run services describe x --region=r --format=json', {READ_SEQ: 'dns,reset,ok'});
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.trim(), '{"status":{"url":"https://x.run.app"}}');
  assert.equal(r.calls.length, 3);
  assert.match(r.err, /WARN: run services describe x: .*NameResolutionError.* \(attempt 1 of 5\); trying again in 0 s/);
  assert.match(r.err, /\(attempt 2 of 5\)/);
});

test('gcloud_retry: a persistent network failure stops after GCLOUD_RETRY_ATTEMPTS with gcloud\'s error', () => {
  const r = run('gcloud_retry gcloud run services describe x', {READ_SEQ: 'dns', GCLOUD_RETRY_ATTEMPTS: '3'});
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 3);
  assert.match(r.err, /getaddrinfo failed/);
  assert.match(r.err, /still failing after 3 attempts/);
});

test('gcloud_retry: NOT_FOUND, PERMISSION_DENIED and an expired login are answers, never retried', () => {
  for (const seq of ['notfound', 'denied', 'reauth']) {
    const r = run('gcloud_retry gcloud run services describe x', {READ_SEQ: seq});
    assert.equal(r.status, 1, seq);
    assert.equal(r.calls.length, 1, seq);
    assert.ok(!r.err.includes('WARN'), r.err);
  }
});

test('gcloud_job_run: a DNS failure while polling, then success, passes; judged from the execution state', () => {
  const r = run('gcloud_job_run probe-job asia-south1', {POLL_SEQ: 'running,dns,dns,running,succeeded'});
  assert.equal(r.status, 0, r.err);
  assert.equal(count(r.calls, 'run jobs execute'), 1);
  assert.ok(r.calls.includes('run jobs execute probe-job --region=asia-south1 --async --format=value(metadata.name)'));
  assert.equal(count(r.calls, 'run jobs executions describe probe-job-ab12c --region=asia-south1 --format=json'), 5);
  assert.match(r.err, /WARN: probe-job: cannot read execution probe-job-ab12c: .*; trying again in 0 s/);
  assert.match(r.out, /--- probe-job-ab12c log ---\n\| model \| size \|\nprobe passed\n--- end of probe-job-ab12c log ---/);
  assert.match(r.out, /==> probe-job: execution probe-job-ab12c succeeded/);
});

test('gcloud_job_run: a persistent network failure stops with an unknown result, never a pass, and starts nothing new', () => {
  const r = run('gcloud_job_run probe-job asia-south1', {POLL_SEQ: 'running,dns', GCLOUD_POLL_OUTAGE_S: '0'});
  assert.equal(r.status, 1);
  assert.equal(count(r.calls, 'run jobs execute'), 1);
  assert.match(r.err, /execution probe-job-ab12c: unknown: no read of execution probe-job-ab12c for \d+ s \(network; limit 0 s\)\. It may still be running/);
  assert.ok(!r.out.includes('succeeded'));
});

test('gcloud_job_run: a real probe failure fails at once, with its message and log; nothing is retried', () => {
  const r = run('gcloud_job_run probe-job asia-south1', {POLL_SEQ: 'running,failed'});
  assert.equal(r.status, 1);
  assert.equal(count(r.calls, 'run jobs execute'), 1);
  assert.equal(count(r.calls, 'run jobs executions describe'), 2);
  assert.match(r.err, /execution probe-job-ab12c: failed: Task probe-job-ab12c-task0 failed with exit code: 1 and message: The container exited with an error\.; this does not pass/);
  assert.match(r.out, /probe passed/, 'the log is printed for the operator');
});

test('gcloud_job_run: a read error that is not the network, or an unreadable state, is an unknown result', () => {
  for (const seq of ['denied', 'garbage']) {
    const r = run('gcloud_job_run probe-job asia-south1', {POLL_SEQ: seq});
    assert.equal(r.status, 1, seq);
    assert.equal(count(r.calls, 'run jobs executions describe'), 1, seq);
    assert.match(r.err, /this does not pass/);
  }
});

// 2026-11-05 (deploy of 9b9abfc): C: reached 0 bytes and `gcloud_job_state <<<"$json"` could not create its temp file,
// so the probe never read a state and its gate timed out. A local failure to judge the state is unknown at once.
test('gcloud_job_run: a local failure to judge the state (full disk) is an unknown result at once, never a pass', () => {
  for (const judge of [
    'gcloud_job_state() { cat > /dev/null; echo "bash: cannot create temp file for here-document: No space left on device" >&2; return 1; }',
    'gcloud_job_state() { cat > /dev/null; }',
  ]) {
    const r = run(`${judge}\ngcloud_job_run probe-job asia-south1`, {POLL_SEQ: 'succeeded'});
    assert.equal(r.status, 1, judge);
    assert.equal(count(r.calls, 'run jobs executions describe'), 1, 'no further polling');
    assert.match(r.err, /local disk\/temp error on this laptop: could not judge the state of execution probe-job-ab12c/);
    assert.match(r.err, /this does not pass/);
    assert.ok(!/succeeded/.test(r.out), r.out);
  }
});

test('gcloud_job_run: the state is piped into node, never a here-string (a full disk cannot make its temp file)', () => {
  const s = fs.readFileSync(path.join(root, 'infra/lib/gcloud-retry.sh'), 'utf8').replace(/^\s*#.*$/gm, '');
  assert.ok(!/gcloud_job_state\s*<<</.test(s), 'no here-string into gcloud_job_state');
  assert.match(s, /state=\$\(printf "%s" "\$json" \| gcloud_job_state\) \|\| status=\$\?/);
  // A large execution JSON still judges correctly through the pipe.
  const big = JSON.stringify({status: {conditions: [{type: 'Completed', status: 'True'}]}, pad: 'x'.repeat(300000)});
  const state = path.join(dir, 'big');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'big.json'), big);
  const r2 = spawnSync(bash, ['-c', 'set -euo pipefail\ncd "$ROOT"\nsource infra/lib/gcloud-retry.sh\njson=$(cat "$STATE/big.json")\nprintf "%s" "$json" | gcloud_job_state'], {
    env: {...process.env, ROOT: root, STATE: state}, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r2.stdout.trim(), 'succeeded', r2.stderr);
});

test('gcloud_job_run: gcloud itself out of disk while polling, or no temp file at the start, is unknown at once', () => {
  let r = run('gcloud_job_run probe-job asia-south1', {POLL_SEQ: 'running,nospace,succeeded'});
  assert.equal(r.status, 1);
  assert.equal(count(r.calls, 'run jobs executions describe'), 2);
  assert.match(r.err, /local disk\/temp error on this laptop while reading execution probe-job-ab12c/);
  r = run('mktemp() { echo "mktemp: failed to create file via template: No space left on device" >&2; return 1; }\ngcloud_job_run probe-job asia-south1');
  assert.equal(r.status, 1);
  assert.equal(count(r.calls, 'run jobs execute'), 0, 'nothing is started');
  assert.match(r.err, /local disk\/temp error: cannot create a temp file/);
});

test('gcloud_job_run: the start is retried only when the request never left (DNS); a reset start is not repeated', () => {
  let r = run('gcloud_job_run probe-job asia-south1', {EXEC_SEQ: 'dns,ok'});
  assert.equal(r.status, 0, r.err);
  assert.equal(count(r.calls, 'run jobs execute'), 2);
  assert.match(r.err, /before the start request left \(attempt 1 of 5\)/);
  r = run('gcloud_job_run probe-job asia-south1', {EXEC_SEQ: 'reset,ok'});
  assert.equal(r.status, 1);
  assert.equal(count(r.calls, 'run jobs execute'), 1, 'never a second execution');
  assert.match(r.err, /may or may not have started/);
  r = run('gcloud_job_run probe-job asia-south1', {EXEC_SEQ: 'denied'});
  assert.equal(r.status, 1);
  assert.equal(count(r.calls, 'run jobs execute'), 1);
});

test('gcloud_job_run: TERM (the gate timeout) cancels the execution', () => {
  const r = run(`gcloud_job_run probe-job asia-south1 & pid=$!
for _ in $(seq 1 100); do grep -q "executions describe" "$LOG" && break; sleep 0.1; done
kill -TERM "$pid"; status=0; wait "$pid" || status=$?; echo "exit $status"`, {POLL_SEQ: 'running', GCLOUD_POLL_S: '1'});
  assert.match(r.out, /exit 143/, r.out + r.err);
  assert.ok(r.calls.includes('run jobs executions cancel probe-job-ab12c --region=asia-south1 --quiet'), r.calls.join('\n'));
  assert.match(r.err, /cancelling execution probe-job-ab12c/);
});

// Review fixes (2026-11-05, .runs/2026-11-05-gate-retry-review.md).
test('gcloud_job_run: a Run API 503 while polling is waited out; Completed with a failed task is not a pass', () => {
  let r = run('gcloud_job_run probe-job asia-south1', {POLL_SEQ: 'busy,running,succeeded'});
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /cannot read execution probe-job-ab12c: .*UNAVAILABLE/);
  r = run('gcloud_job_run probe-job asia-south1', {POLL_SEQ: 'partial'});
  assert.equal(r.status, 1);
  assert.match(r.err, /failed: 1 task\(s\) failed; this does not pass/);
});

test('gcloud_job_run with cancel off (catalog-migrate): TERM stops the wait but never cancels the execution', () => {
  const r = run(`gcloud_job_run catalog-migrate asia-south1 0 & pid=$!
for _ in $(seq 1 100); do grep -q "executions describe" "$LOG" && break; sleep 0.1; done
kill -TERM "$pid"; status=0; wait "$pid" || status=$?; echo "exit $status"`, {POLL_SEQ: 'running', GCLOUD_POLL_S: '1'});
  assert.match(r.out, /exit 143/, r.out + r.err);
  assert.ok(!r.calls.some((c) => c.includes('executions cancel')), r.calls.join('\n'));
  assert.match(r.err, /stopped waiting; execution probe-job-ab12c runs on/);
});

test('deploy.sh migrate: started once, a polling blip re-reads the same execution, never a second execute', () => {
  const deploy = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8').replace(/\r/g, '');
  assert.match(deploy, /\n\s+gcloud_job_run catalog-migrate "\$REGION" 0\n/);
  assert.ok(!/jobs execute catalog-migrate/.test(deploy.replace(/^\s*#.*$/gm, '')), 'no --wait execute of the migration');
  const r = run('gcloud_job_run catalog-migrate asia-south1 0', {EXEC_SEQ: 'ok', POLL_SEQ: 'running,dns,dns,succeeded'});
  assert.equal(r.status, 0, r.err);
  assert.equal(count(r.calls, 'run jobs execute'), 1);
  assert.equal(count(r.calls, 'run jobs executions describe probe-job-ab12c '), 4);
});

// require_secret as deploy.sh defines it (cut from the file, so the test runs the real text).
const deployText = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8').replace(/\r/g, '');
const requireSecret = deployText.slice(deployText.indexOf('require_secret() {'), deployText.indexOf('\n}\n', deployText.indexOf('require_secret() {')) + 3);

test('gcloud_exists and deploy.sh require_secret: a DNS blip is retried and is never reported as a missing secret', () => {
  let r = run('gcloud_exists secrets describe s; echo "status $?"', {READ_SEQ: 'dns,ok'});
  assert.match(r.out, /status 0/);
  assert.equal(r.calls.length, 2);
  assert.match(r.err, /WARN: secrets describe s: .*Failed to resolve/);
  r = run('status=0; gcloud_exists secrets describe s || status=$?; echo "status $status"', {READ_SEQ: 'notfound'});
  assert.match(r.out, /status 1/);
  assert.equal(r.calls.length, 1);
  r = run('status=0; gcloud_exists secrets describe s || status=$?; echo "status $status"', {READ_SEQ: 'dns', GCLOUD_RETRY_ATTEMPTS: '2'});
  assert.match(r.out, /status 2/);
  assert.match(r.err, /getaddrinfo failed/);
  // The deploy's own check: missing says missing; a network failure says it cannot check; both stop the deploy.
  assert.ok(requireSecret.startsWith('require_secret() {') && requireSecret.includes('gcloud_exists secrets describe'), requireSecret);
  r = run(`${requireSecret}\nrequire_secret catalog-db-password "run infra/bootstrap.sh first"`, {READ_SEQ: 'notfound'});
  assert.equal(r.status, 1);
  assert.match(r.err, /secret catalog-db-password missing; run infra\/bootstrap\.sh first/);
  r = run(`${requireSecret}\nrequire_secret catalog-db-password "run infra/bootstrap.sh first"`, {READ_SEQ: 'dns', GCLOUD_RETRY_ATTEMPTS: '2'});
  assert.equal(r.status, 1);
  assert.match(r.err, /cannot check the secret catalog-db-password \(the gcloud error is above; not a missing secret\)/);
  assert.ok(!/missing;/.test(r.err), r.err);
  r = run(`${requireSecret}\nrequire_secret catalog-db-password x; echo passed`, {READ_SEQ: 'dns,ok'});
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /passed/);
  assert.match(deployText, /^gcv\(\) \{ gcloud_retry gcloud "\$@" \| tr -d '\\r'; \}$/m);
  assert.ok(!/gcloud secrets describe/.test(deployText.replace(/^\s*#.*$/gm, '')), 'every secret check goes through require_secret');
});

// The gate end to end (gate-fake gcloud for the deploy, the probe as its own process running gcloud_job_run): an
// unknown probe result keeps the old traffic; a blip during the wait still moves it after the probe passed.
function gate(label, env) {
  const state = path.join(dir, label);
  fs.mkdirSync(state);
  const log = path.join(state, 'calls.log');
  fs.writeFileSync(log, '');
  const probe = `source infra/lib/gcloud-retry.sh\n${fake}\ngcloud_job_run probe-job asia-south1`;
  const r = spawnSync(bash, ['-c', 'set -euo pipefail\ncd "$ROOT"\nsource infra/tests/gate-fake.sh\nsource infra/lib/services.sh\nsource infra/lib/gate.sh\ndeploy_service test-svc'], {
    env: {...process.env, ROOT: root, LOG: log, STATE: state, OLD: 'test-svc-00001-old', NEW: 'test-svc-00002-new', TAG_URL: 'https://candidate---test-svc-abc-el.a.run.app',
      URL: 'https://test-svc-abc-el.a.run.app', DIGEST: 'sha256:' + 'a'.repeat(64), PROBE: probe,
      GCLOUD_RETRY_DELAY_S: '0', GCLOUD_POLL_S: '0', GCLOUD_POLL_OUTAGE_S: '0', ...env},
    encoding: 'utf8', timeout: 120000,
  });
  const calls = fs.readFileSync(log, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
  return {status: r.status, out: r.stdout.replace(/\r/g, ''), err: r.stderr.replace(/\r/g, ''), calls};
}
const shift = 'run services update-traffic test-svc --region=asia-south1 --to-revisions=test-svc-00002-new=100 --quiet';

test('the gate: an unknown probe result (network gone) keeps the old traffic; a blip then success moves it', () => {
  let r = gate('gate-unknown', {POLL_SEQ: 'running,dns'});
  assert.equal(r.status, 1, r.out);
  assert.ok(!r.calls.includes(shift), 'traffic never moved on an unknown result');
  assert.match(r.err, /bash infra\/deploy\.sh --rollback test-svc test-svc-00001-old/);
  r = gate('gate-failed', {POLL_SEQ: 'failed'});
  assert.equal(r.status, 1);
  assert.ok(!r.calls.includes(shift));
  r = gate('gate-blip', {POLL_SEQ: 'dns,running,succeeded', GCLOUD_POLL_OUTAGE_S: '60'});
  assert.equal(r.status, 0, r.err + r.out);
  assert.ok(r.calls.includes(shift), r.calls.join('\n'));
});

test('gcloud_retry wraps the deploy reads: pre-flight, the image check, the gate describes; the probe scripts use gcloud_job_run', () => {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(read('infra/lib/preflight.sh'), /^preflight_gcloud\(\) \{ gcloud_retry gcloud "\$@"; \}$/m);
  assert.match(read('infra/lib/build.sh'), /out=\$\(gcloud_retry build_gcloud artifacts docker images describe/);
  const gateSh = read('infra/lib/gate.sh');
  assert.match(gateSh, /out=\$\(gcloud_retry gate_gcloud "\$@" --format=json/);
  assert.match(gateSh, /digest=\$\(gcloud_retry gate_gcloud artifacts docker images describe/);
  for (const f of ['infra/check-matting.sh', 'infra/catalog-smoke-linux.sh']) {
    const s = read(f).replace(/^\s*#.*$/gm, '');
    assert.ok(!/jobs execute/.test(s) && !/--wait/.test(s), `${f} never waits on a local gcloud pipe`);
    assert.match(s, /gcloud_job_run /);
  }
});

// M1 D43: the judge exam goes through the wrapper, and its exit code tells a judge result from no result.
const exam = 'bash infra/catalog-output-evals.sh exam';
test('the exam: a network blip during the wait is no failure; it runs one execution with LIVE_SMOKE=1 and a pass reads as a pass', () => {
  const r = run(exam, {POLL_SEQ: 'running,dns,dns,running,succeeded'});
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /JUDGE EXAM PASSED/);
  assert.equal(count(r.calls, 'run jobs execute'), 1);
  const start = r.calls.find((c) => c.startsWith('run jobs execute'));
  assert.match(start, /--update-env-vars=LIVE_SMOKE=1/);
  assert.match(start, /--args=.*exam/);
});
test('the exam: the job exiting 1 is a judge below a bar, and the fail message names the judge', () => {
  const r = run(exam, {POLL_SEQ: 'failed', FAKE_JOB_LOG: 'JUDGE EXAM FAIL: the/judge below a bar; set v2, run exam-x.'});
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /JUDGE EXAM FAILED: JUDGE EXAM FAIL: the\/judge below a bar/);
  assert.doesNotMatch(r.out + r.err, /JUDGE EXAM PASSED|COULD NOT RUN/);
});
test('the exam: the result does not depend on the log: exit 1 with no readable log is still a judge failure', () => {
  const r = run(exam, {POLL_SEQ: 'failed', FAKE_LOG_UNREADABLE: '1'});
  assert.equal(r.status, 1, r.err);
  assert.match(r.err, /JUDGE EXAM FAILED: the job exited 1/);
  assert.doesNotMatch(r.out + r.err, /COULD NOT RUN/);
});
test('the exam: a clean pass says nothing about an earlier failed deploy', () => {
  const r = run(exam, {POLL_SEQ: 'succeeded'});
  assert.equal(r.status, 0, r.err);
  assert.doesNotMatch(r.out + r.err, /deploy whose exam failed/);
});
test('the exam: the job exiting 3, a killed or cancelled job, a lost network and a failed start all exit 3, no judge result', () => {
  for (const [label, env] of [
    ['exit 3', {POLL_SEQ: 'failed3', FAKE_JOB_LOG: 'JUDGE EXAM COULD NOT RUN: not serving: x. This is not a judge result.'}],
    ['exit 3 with no readable log', {POLL_SEQ: 'failed3', FAKE_LOG_UNREADABLE: '1'}],
    ['exit 3 whatever the log says', {POLL_SEQ: 'failed3', FAKE_JOB_LOG: 'JUDGE EXAM FAIL: the/judge below a bar; set v2, run exam-x.'}],
    ['exit 137 is not exit 1', {POLL_SEQ: 'failed137'}],
    ['cancelled', {POLL_SEQ: 'cancelled'}],
    ['network', {POLL_SEQ: 'running,dns', GCLOUD_POLL_OUTAGE_S: '0'}],
    ['start refused', {EXEC_SEQ: 'denied'}],
    ['list refused', {READ_SEQ: 'denied'}],
  ]) {
    const r = run(exam, env);
    assert.equal(r.status, 3, label + ': ' + r.err);
    assert.match(r.err, /JUDGE EXAM COULD NOT RUN/, label);
  }
});

let failed = 0;
try {
  for (const [name, fn] of tests) {
    try { fn(); console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + (e.stack || e)); }
  }
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`all ${tests.length} passed`);

// Run with node infra/tests/gcloud-retry.test.mjs. Offline: gcloud is a fake bash function, no GCP call.
// 2026-11-05 root-cause review item 2 (stops #11, #12, #15): a laptop network blip during a gcloud read or while a gate
// waits for a probe job must not fail the gate, and an unknown result must never pass it.
// The fake answers each kind of call from a comma list (the last item repeats):
//   READ_SEQ   for "run services describe" (and any other read):  ok | dns | reset | notfound | denied | reauth
//   EXEC_SEQ   for "run jobs execute":                            ok | dns | reset | denied
//   POLL_SEQ   for "run jobs executions describe":                running | succeeded | failed | dns | denied | garbage
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
  assert.match(r.err, /execution probe-job-ab12c: unknown: no read of execution probe-job-ab12c for 0 s \(network; limit 0 s\)\. It may still be running/);
  assert.ok(!r.out.includes('succeeded'));
});

test('gcloud_job_run: a real probe failure fails at once, with its message and log; nothing is retried', () => {
  const r = run('gcloud_job_run probe-job asia-south1', {POLL_SEQ: 'running,failed'});
  assert.equal(r.status, 1);
  assert.equal(count(r.calls, 'run jobs execute'), 1);
  assert.equal(count(r.calls, 'run jobs executions describe'), 2);
  assert.match(r.err, /execution probe-job-ab12c: failed: Task probe-job-ab12c-task0 failed with exit code: 1; this does not pass/);
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
  assert.match(r.err, /gcloud run services update-traffic test-svc --to-revisions test-svc-00001-old=100/);
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

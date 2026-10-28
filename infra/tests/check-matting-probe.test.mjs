// Run with node infra/tests/check-matting-probe.test.mjs. No provider calls: a fake gcloud on PATH.
// Spec 17 3.3.1: infra/check-matting.sh --probe <url> runs services/matting/tests/cloudrun_check.py --probe as the
// existing job catalog-check-matting, with the probe arguments after the script and a longer task timeout; without
// --probe the job is the runtime check, as before.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-check-matting-'));
const posix = (p) => p.replaceAll('\\', '/');
fs.mkdirSync(path.join(dir, 'bin'));

const cpuUrl = 'https://catalog-matting-abc-el.a.run.app';
const gpuUrl = 'https://catalog-matting-gpu-abc-as.a.run.app';
const ar = 'asia-south1-docker.pkg.dev/image-links-agent/apps/';
const service = (url, image) => ({status: {url, latestReadyRevisionName: 'r1', latestCreatedRevisionName: 'r1'}, spec: {template: {spec: {containers: [{image}]}}}});
const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
write('worker.json', {spec: {template: {spec: {containers: [{env: [{name: 'MATTING_URL', value: cpuUrl}, {name: 'MATTING_GPU_URL', value: gpuUrl}]}]}}}});
write('cpu.json', service(cpuUrl, `${ar}matting:abc1234`));
const gpuImage = (tag) => write('gpu.json', service(gpuUrl, `${ar}matting-gpu:${tag}`));

// Fake gcloud: describe prints the fixture, jobs deploy keeps a copy of the flags file, every call is logged.
fs.writeFileSync(path.join(dir, 'bin', 'gcloud'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DIR/calls.log"
case "$*" in
  *"services describe catalog-worker "*) cat "$FAKE_DIR/worker.json" ;;
  *"services describe catalog-matting-gpu "*) cat "$FAKE_DIR/gpu.json" ;;
  *"services describe catalog-matting "*) cat "$FAKE_DIR/cpu.json" ;;
  *"jobs deploy"*) for a in "$@"; do case "$a" in --flags-file=*) cp "\${a#--flags-file=}" "$FAKE_DIR/flags.json" ;; esac; done ;;
esac
`, {mode: 0o755});

function run(args) {
  for (const name of ['calls.log', 'flags.json']) fs.rmSync(path.join(dir, name), {force: true});
  const r = spawnSync(bash, ['-c', 'export PATH="$(cygpath -u "$FAKE_DIR" 2>/dev/null || printf %s "$FAKE_DIR")/bin:$PATH"; bash infra/check-matting.sh "$@"', '_', ...args],
    {cwd: root, env: {...process.env, FAKE_DIR: posix(dir)}, encoding: 'utf8'});
  const read = (name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : '');
  return {status: r.status, stderr: r.stderr, flags: read('flags.json') ? JSON.parse(read('flags.json')) : null, calls: read('calls.log')};
}

const script = fs.readFileSync(path.join(root, 'services/matting/tests/cloudrun_check.py'), 'utf8');
const tagUrl = 'https://candidate---catalog-matting-gpu-abc-as.a.run.app';
try {
  // The GPU service's newest revision is a candidate on a newer image: the probe does not compare versions.
  gpuImage('def5678');
  const probe = run(['--probe', tagUrl, '--models', 'bria-rmbg', '--concurrency', '2', '--rounds', '3']);
  assert.equal(probe.status, 0, probe.stderr);
  // One --option=value item per option: gcloud refuses a repeated item in --args (see the next case).
  assert.deepEqual(probe.flags['--args'], ['-c', script, '--probe', tagUrl, '--models=bria-rmbg', '--concurrency=2', '--rounds=3']);
  assert.equal(probe.flags['--task-timeout'], '3600s');
  assert.equal(probe.flags['--image'], `${ar}matting:abc1234`);
  assert.match(probe.calls, /run jobs deploy catalog-check-matting/);
  assert.match(probe.calls, /run jobs execute catalog-check-matting --region=asia-south1 --wait/);
  console.log('PASS --probe runs the probe as catalog-check-matting');

  // Run by the deploy gate: the job ends when the gate gives up, so it never runs on after a gate timeout.
  process.env.PROBE_TASK_TIMEOUT = '420';
  try {
    const gated = run(['--probe', tagUrl, '--models', 'birefnet-general', '--concurrency', '1', '--rounds', '1']);
    assert.equal(gated.status, 0, gated.stderr);
    assert.equal(gated.flags['--task-timeout'], '420s');
    // The CPU gate's probe (services.sh): "1" twice made gcloud refuse the job on 2026-10-28. Every item is unique.
    const args = gated.flags['--args'];
    assert.deepEqual(args.slice(2), ['--probe', tagUrl, '--models=birefnet-general', '--concurrency=1', '--rounds=1']);
    assert.equal(new Set(args).size, args.length);
    process.env.PROBE_TASK_TIMEOUT = '7m';
    const bad = run(['--probe', tagUrl]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /PROBE_TASK_TIMEOUT must be a number of seconds/);
  } finally {
    delete process.env.PROBE_TASK_TIMEOUT;
  }
  console.log('PASS a gated probe job times out with the gate and passes repeated values as unique items');

  // The form the gate passes (--option=value, services.sh), a model list as one item (a flags-file list is not split
  // on commas) and the URL after the options: the URL still goes first, each option once.
  const listed = run(['--probe', '--models=birefnet-general,bria-rmbg', '--rounds=1', '--concurrency', '1', tagUrl]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.flags['--args'].slice(2), ['--probe', tagUrl, '--models=birefnet-general,bria-rmbg', '--rounds=1', '--concurrency=1']);
  console.log('PASS --option=value, a model list and a trailing URL keep one item each');

  // Anything that could repeat an item or that the probe would refuse only after a job deploy is refused before gcloud.
  for (const [args, error] of [
    [['--probe', tagUrl, '--rounds', '1', '--rounds', '2'], /the probe option --rounds is given twice/],
    [['--probe', tagUrl, '--rounds=1', '--rounds', '1'], /the probe option --rounds is given twice/],
    [['--probe', tagUrl, '--models', '--rounds', '1'], /--models needs a value/],
    [['--probe', tagUrl, '--rounds'], /--rounds needs a value/],
    [['--probe', tagUrl, '--conc', '1'], /unknown probe option --conc/],
    [['--probe', tagUrl, tagUrl], /one probe URL only/],
    [['--probe', '--rounds', '1'], /usage: .* --probe <url>/],
  ]) {
    const refused = run(args);
    assert.equal(refused.status, 2, args.join(' '));
    assert.match(refused.stderr, error);
    assert.equal(refused.calls, '');
  }
  console.log('PASS repeated, unknown or valueless probe options are refused before gcloud');

  gpuImage('abc1234');
  const check = run([]);
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(check.flags['--args'], ['-c', script]);
  assert.equal(check.flags['--task-timeout'], '600s');
  console.log('PASS without --probe the job is the runtime check');

  gpuImage('def5678');
  const mismatch = run([]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /CPU and GPU deployment versions differ/);
  assert.equal(mismatch.flags, null);
  console.log('PASS the runtime check still compares versions');

  const usage = run(['--probe']);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: .* --probe <url>/);
  assert.equal(usage.calls, '');
  console.log('PASS --probe without a URL prints the usage');
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}

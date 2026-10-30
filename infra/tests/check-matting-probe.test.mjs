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

  // Spec 18 H1: --probe-upscale runs cloudrun_check.py --probe-upscale as the same job, always writing its report.
  const upscaleUrl = 'https://measure-4c-4t---catalog-upscale-abc-el.a.run.app';
  const up = run(['--probe-upscale', upscaleUrl, '--model', 'swinir-x2', '--sizes', '800x1200,1600x1600', '--concurrency', '1', '--rounds', '1', '--timeout=870']);
  assert.equal(up.status, 0, up.stderr);
  assert.deepEqual(up.flags['--args'], ['-c', script, '--probe-upscale', upscaleUrl, '--model=swinir-x2', '--sizes=800x1200,1600x1600',
    '--concurrency=1', '--rounds=1', '--timeout=870', '--bucket=image-links-agent-assets']);
  assert.equal(new Set(up.flags['--args']).size, up.flags['--args'].length, 'every item unique (concurrency 1 and rounds 1 as --option=value)');
  assert.equal(up.flags['--task-timeout'], '7200s', 'by hand the upscale probe gets two hours');
  assert.equal(up.flags['--image'], `${ar}matting:abc1234`);
  process.env.PROBE_TASK_TIMEOUT = '1980';
  try {
    assert.equal(run(['--probe-upscale', upscaleUrl]).flags['--task-timeout'], '1980s', 'the gate timeout wins');
  } finally {
    delete process.env.PROBE_TASK_TIMEOUT;
  }
  for (const [args, error] of [
    [['--probe-upscale', upscaleUrl, '--models', 'bria-rmbg'], /unknown probe option --models/],
    [['--probe-upscale', upscaleUrl, '--sizes=800x1200', '--sizes', '1600x1600'], /the probe option --sizes is given twice/],
    [['--probe-upscale', upscaleUrl, '--timeout'], /--timeout needs a value/],
    [['--probe-upscale', upscaleUrl, '--sizes=800*1200'], /--sizes must list sizes such as 800x1200,1600x1600, got '800\*1200'/],
    [['--probe-upscale', upscaleUrl, '--sizes', '800x1200,'], /--sizes must list sizes/],
    [['--probe-upscale', upscaleUrl, '--timeout=5'], /--timeout must be a whole number of seconds from 30 to 3600, got '5'/],
    [['--probe-upscale', upscaleUrl, '--timeout', '8.5'], /--timeout must be a whole number of seconds from 30 to 3600, got '8.5'/],
    [['--probe', tagUrl, '--sizes', '800x1200'], /unknown probe option --sizes/],
    [['--probe-upscale'], /usage: .* --probe-upscale <url>/],
  ]) {
    const refused = run(args);
    assert.equal(refused.status, 2, args.join(' '));
    assert.match(refused.stderr, error);
    assert.equal(refused.calls, '');
  }
  console.log('PASS --probe-upscale runs the upscale probe as catalog-check-matting with unique items and its own options');

  // Spec 18 gate (plan 7.2): the determinism round and the cold-start limit travel to cloudrun_check.py as given.
  const gated = run(['--probe-upscale', upscaleUrl, '--determinism-calls=12', '--cold-start-max', '120']);
  assert.equal(gated.status, 0, gated.stderr);
  assert.deepEqual(gated.flags['--args'].slice(4), ['--determinism-calls=12', '--cold-start-max=120', '--bucket=image-links-agent-assets']);
  // Spec 18 GPU upscaler: the determinism round's seconds budget travels the same way.
  const gpu = run(['--probe-upscale', upscaleUrl, '--determinism-calls=12', '--determinism-seconds=600']);
  assert.equal(gpu.status, 0, gpu.stderr);
  assert.deepEqual(gpu.flags['--args'].slice(4), ['--determinism-calls=12', '--determinism-seconds=600', '--bucket=image-links-agent-assets']);
  // The cap timeout check (2026-10-31): the gate passes both caps; the ratio option is gone.
  const capped = run(['--probe-upscale', upscaleUrl, '--x2-max-pixels=5400000', '--x4-max-pixels=4900000']);
  assert.equal(capped.status, 0, capped.stderr);
  assert.deepEqual(capped.flags['--args'].slice(4), ['--x2-max-pixels=5400000', '--x4-max-pixels=4900000', '--bucket=image-links-agent-assets']);
  for (const [args, error] of [
    [['--x4-max-pixels=4.9'], /--x4-max-pixels must be a whole number of pixels from 0 \(no check\) to 100000000, got '4.9'/],
    [['--x4-max-pixels=100000001'], /--x4-max-pixels must be a whole number of pixels from 0 \(no check\) to 100000000, got '100000001'/],
    [['--x2-max-pixels=-1'], /--x2-max-pixels must be a whole number of pixels from 0 \(no check\) to 100000000, got '-1'/],
    [['--x4-ratio=1.3'], /unknown probe option --x4-ratio/],
    [['--determinism-calls=1'], /--determinism-calls must be 0 \(none\) or 2 to 16, got '1'/],
    [['--determinism-calls=17'], /--determinism-calls must be 0 \(none\) or 2 to 16, got '17'/],
    [['--cold-start-max=-5'], /--cold-start-max must be a whole number of seconds from 0 \(none\) to 3600, got '-5'/],
    [['--cold-start-max=3601'], /--cold-start-max must be a whole number of seconds from 0 \(none\) to 3600, got '3601'/],
    [['--determinism-calls=12', '--determinism-calls=12'], /the probe option --determinism-calls is given twice/],
    [['--determinism-seconds=3601'], /--determinism-seconds must be a whole number of seconds from 0 \(3 rounds only\) to 3600, got '3601'/],
  ]) {
    const refused = run(['--probe-upscale', upscaleUrl, ...args]);
    assert.equal(refused.status, 2, args.join(' '));
    assert.match(refused.stderr, error);
    assert.equal(refused.calls, '');
  }
  console.log('PASS --probe-upscale passes the gate\'s determinism round and cold-start limit and refuses bad values');

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

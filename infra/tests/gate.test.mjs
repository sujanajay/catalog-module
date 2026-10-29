// Run with node infra/tests/gate.test.mjs. Offline: gcloud is a fake bash function (gate_gcloud), no GCP call.
// Spec 17 3.2.6: the service registry lists the four services in order; the deploy arguments add
// --no-traffic --tag candidate; a probe failure returns non-zero, leaves traffic alone and prints the rollback line
// naming the previous revision; SKIP when the live revision has the same image digest and env; the rollback command.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-gate-'));

const OLD = 'test-svc-00001-old';
const NEW = 'test-svc-00002-new';
const TAG_URL = 'https://candidate---test-svc-abc-el.a.run.app';
const URL = 'https://test-svc-abc-el.a.run.app';
const DIGEST = 'sha256:' + 'a'.repeat(64);

function run(label, body, env = {}) {
  const state = path.join(dir, label);
  fs.mkdirSync(state, {recursive: true});
  const log = path.join(state, 'calls.log');
  fs.writeFileSync(log, '');
  const script = `set -euo pipefail
cd "$ROOT"
source infra/tests/gate-fake.sh
source infra/lib/services.sh
source infra/lib/gate.sh
${body}`;
  const r = spawnSync(bash, ['-c', script], {
    env: {...process.env, ROOT: root, LOG: log, STATE: state, OLD, NEW, TAG_URL, URL, DIGEST, PROBE: 'echo "probe got $1"', ...env},
    encoding: 'utf8',
    timeout: 120000,
  });
  if (r.error) throw r.error;
  const calls = fs.readFileSync(log, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
  return {status: r.status, out: r.stdout.replace(/\r/g, ''), err: r.stderr.replace(/\r/g, ''), calls};
}
const rollbackLine = `gcloud run services update-traffic test-svc --to-revisions ${OLD}=100`;
const lines = (text) => text.split('\n');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('registry lists the five services in order, each with a registry function', () => {
  const r = run('registry', `printf '%s\\n' "\${SERVICES[@]}"; for s in "\${SERVICES[@]}"; do declare -F "service_\${s//-/_}" >/dev/null || echo "missing $s"; done`);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(lines(r.out.trim()), ['catalog-matting', 'catalog-upscale', 'catalog-matting-gpu', 'catalog-worker', 'catalog-web']);
});

const vars = `AR=ar; TAG=t; MATTING_SA=m; WORKER_SA=w; WEB_SA=web; MATTING_CPU_MAX_INSTANCES=20; GPU_CPU=4; GPU_MEMORY=16Gi
GPU_CONCURRENCY=2; GPU_MAX_INSTANCES=3; MAX_RESIDENT_SESSIONS=1; GPU_MEM_LIMIT_BYTES=; WORKER_SERVICE=catalog-worker
WEB_SERVICE=catalog-web; WORKER_CPU=2; WORKER_MEMORY=2Gi; WORKER_CONCURRENCY=2; WORKER_MAX_INSTANCES=4; WEB_MAX_INSTANCES=3
NET=(--region=asia-south1 --network=ila-vpc); WORKER_SECRETS=s; SECRETS=s; WORKER_ENV=W=1; WEB_ENV=X=1
source infra/lib/shape.sh; shape_defaults
show() { "service_\${1//-/_}"; echo "$1|$SVC_NAME|$SVC_REGION|$SVC_IMAGE|$SVC_PROBE_TIMEOUT|$SVC_DEPLOY|$SVC_SHIFT|$SVC_QUOTA_OPTIONAL|$SVC_ENV|\${SVC_PROBE[*]}"; }`;

test('registry entries: regions, probes, timeouts, preview behaviour, GPU knobs', () => {
  let r = run('entries', `${vars}\nINFERENCE_LOCK_SCOPE=session\nfor s in "\${SERVICES[@]}"; do show "$s"; done`);
  assert.equal(r.status, 0, r.err);
  const [cpu, upscale, gpu, worker, web] = lines(r.out.trim()).map((l) => l.split('|'));
  assert.deepEqual(upscale.slice(1, 7), ['catalog-upscale', 'asia-south1', 'ar/matting:t', '0', 'skip', '0'], 'not deployed while UPSCALE_SERVICE=cpu');
  // Probes sized per service: the CPU service gets its default model, 1 warm call and 1 round at its concurrency
  // (CPU calls take 25 to 71 s); the GPU service the full probe of every model, 5 rounds at the shape concurrency.
  assert.deepEqual(cpu.slice(1, 8), ['catalog-matting', 'asia-south1', 'ar/matting:t', '420', '1', '1', '0']);
  assert.equal(cpu[9], 'bash infra/lib/services.sh probe-matting 420 birefnet-general 1 1');
  assert.deepEqual(gpu.slice(1, 8), ['catalog-matting-gpu', 'asia-southeast1', 'ar/matting-gpu:t', '600', '1', '1', '1']);
  assert.equal(gpu[8], 'MAX_RESIDENT_SESSIONS=1,INFERENCE_LOCK_SCOPE=session', 'a set GPU knob reaches the service, an unset one does not');
  assert.equal(gpu[9], 'bash infra/lib/services.sh probe-matting 600 birefnet-general,birefnet-general-lite,birefnet-hrsod,bria-rmbg 2 5',
    'the GPU probe measures every served model at the shape concurrency');
  assert.deepEqual(worker.slice(1, 6), ['catalog-worker', 'asia-south1', 'ar/worker:t', '1800', '1']);
  assert.match(worker[9], /probe-worker$/);
  assert.deepEqual(web.slice(1, 6), ['catalog-web', 'asia-south1', 'ar/web:t', '300', '1']);
  assert.equal(web[9], 'env WEB_PROBE_SA=w bash infra/lib/services.sh probe-web', 'the web probe runs as the smoke identity');
  r = run('entries-preview', `${vars}\nCATALOG_PREVIEW=1\nshow catalog-matting; show catalog-matting-gpu`);
  assert.equal(r.status, 0, r.err);
  const [pcpu, pgpu] = lines(r.out.trim()).map((l) => l.split('|'));
  assert.equal(pcpu[5], '0', 'the preview reuses catalog-matting');
  assert.equal(pgpu[6], '0', 'the preview never shifts GPU traffic');
});

test('a matting probe passes its registry row, the gate timeout and the appended URL to check-matting.sh', () => {
  // The services.sh CLI as the gate runs it (the registry row plus the tag URL). An exported bash function stands in
  // for the nested `bash infra/check-matting.sh` and prints its call; the outer call uses the real bash.
  const r = run('probe-args', `${vars}\nservice_catalog_matting
bash() { echo "PROBE_TASK_TIMEOUT=$PROBE_TASK_TIMEOUT $*"; }; export -f bash
command bash "\${SVC_PROBE[@]:1}" https://candidate---m.run.app`);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.trim(), 'PROBE_TASK_TIMEOUT=420 infra/check-matting.sh --probe https://candidate---m.run.app --models=birefnet-general --concurrency=1 --rounds=1');
});

// Spec 18 H2: catalog-upscale. The measured fixture below is a test value, not a measurement.
const measured = `UPSCALE_SERVICE=dedicated; UPSCALE_MEASURED_ON=2026-10-30; UPSCALE_P95_S_4C_4T_1CONC_800x1200=130; UPSCALE_P95_S_4C_4T_1CONC_1600x1600=330`;
const upscaleArgs = `show catalog-upscale; printf '%s\\n' "\${SVC_ARGS[@]}"; echo "TAG=\${SVC_TAG:-}|SKIP=\${SVC_SKIP_REASON:-}"`;

test('catalog-upscale: the matting image sized by the UPSCALE_* rows, only the upscaler loaded, probe sized from the table', () => {
  const r = run('upscale-dedicated', `${vars}\n${measured}\n${upscaleArgs}`);
  assert.equal(r.status, 0, r.err);
  const [row, ...rest] = lines(r.out.trim());
  const f = row.split('|');
  // 300 s for the job and cold start + 4 x p95 per size (warm call and one round, 2 x p95 each): 300 + 520 + 1320.
  assert.deepEqual(f.slice(1, 8), ['catalog-upscale', 'asia-south1', 'ar/matting:t', '2140', '1', '1', '0']);
  assert.equal(f[8], 'MAX_RESIDENT_SESSIONS=1,UPSCALE_CPU=1,PRELOAD_MATTE=0,ORT_INTRA_OP_THREADS=4');
  assert.equal(f[9], 'bash infra/lib/services.sh probe-upscale 2140 swinir-x2 800x1200,1600x1600 1 1 840');
  assert.deepEqual(rest.slice(0, -1), ['--service-account=m', '--cpu=4', '--memory=16Gi', '--concurrency=1', '--min-instances=0',
    '--max-instances=16', '--timeout=840', '--labels=app=catalog,component=upscale']);
  assert.equal(rest.at(-1), 'TAG=|SKIP=', 'the dedicated service uses the candidate tag');
});

test('catalog-upscale: env shape reaches the flags and the thread count', () => {
  const r = run('upscale-shape', `${vars}\n${measured}\nUPSCALE_CPU=8; UPSCALE_THREADS=8; UPSCALE_MEMORY=32Gi; UPSCALE_CONCURRENCY=2; UPSCALE_MAX_INSTANCES=8; UPSCALE_TIMEOUT_S=700
UPSCALE_P95_S_8C_8T_2CONC_800x1200=90; UPSCALE_P95_S_8C_8T_2CONC_1600x1600=250\n${upscaleArgs}`);
  assert.equal(r.status, 0, r.err);
  const [row, ...rest] = lines(r.out.trim());
  assert.match(row, /\|ORT_INTRA_OP_THREADS=8\|bash infra\/lib\/services.sh probe-upscale 1660 swinir-x2 800x1200,1600x1600 2 1 700$/);
  assert.ok(['--cpu=8', '--memory=32Gi', '--concurrency=2', '--max-instances=8', '--timeout=700'].every((a) => rest.includes(a)), rest.join(' '));
});

test('catalog-upscale: measure mode is a no-traffic candidate per shape; preview reuses; cpu skips', () => {
  let r = run('upscale-measure', `${vars}\nUPSCALE_MEASURE=1; UPSCALE_CPU=8; UPSCALE_THREADS=8; UPSCALE_CONCURRENCY=2\n${upscaleArgs}`);
  assert.equal(r.status, 0, r.err);
  let out = lines(r.out.trim());
  let f = out[0].split('|');
  // One warm call and one call of the first size, each within the service timeout, plus 300 s: 300 + 2 x 840.
  assert.deepEqual(f.slice(5, 8), ['1', '0', '0'], 'deployed, never shifted');
  assert.equal(f[4], '1980');
  assert.equal(f[9], 'bash infra/lib/services.sh probe-upscale 1980 swinir-x2 800x1200 1 1 840');
  assert.equal(out.at(-1), 'TAG=measure-8c-8t-2r|SKIP=', 'each rung keeps its own tag URL');
  r = run('upscale-preview', `${vars}\n${measured}\nCATALOG_PREVIEW=1\n${upscaleArgs}`);
  f = lines(r.out.trim())[0].split('|');
  assert.deepEqual(f.slice(5, 7), ['0', '1'], 'the preview reuses the live catalog-upscale');
  r = run('upscale-preview-measure', `${vars}\nCATALOG_PREVIEW=1; UPSCALE_MEASURE=1\n${upscaleArgs}`);
  assert.equal(lines(r.out.trim())[0].split('|')[5], 'skip', 'the preview never measures');
  r = run('upscale-gpu', `${vars}\nUPSCALE_SERVICE=gpu\n${upscaleArgs}`);
  out = lines(r.out.trim());
  assert.equal(out[0].split('|')[5], 'skip');
  assert.equal(out.at(-1), 'TAG=|SKIP=UPSCALE_SERVICE=gpu; the worker does not call it');
});

test('a skipped service is not deployed, not described, and leaves no URL', () => {
  const r = run('skip-service', `${vars}\nservice_test_svc() { SVC_NAME=test-svc; SVC_REGION=asia-south1; SVC_DEPLOY=skip; SVC_SKIP_REASON="not used"; SVC_SHIFT=0; }
deploy_service test-svc; echo "URL=$GATE_URL|CHANGED=$GATE_CHANGED"`);
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes('==> test-svc: not deployed (not used)'), r.out);
  assert.ok(r.out.includes('URL=|CHANGED=0'));
  assert.deepEqual(r.calls, [], 'no gcloud call at all');
});

test('a reused service that does not exist yet says how to create it', () => {
  const r = run('reuse-missing', `service_test_svc() { SVC_NAME=test-svc; SVC_REGION=asia-south1; SVC_DEPLOY=0; SVC_SHIFT=1; }; deploy_service test-svc`, {EXISTS: '0'});
  assert.equal(r.status, 1);
  assert.match(r.err, /test-svc is reused as it is but does not exist yet; deploy it from main first \(bash infra\/deploy.sh\)/);
});

test('an upscale probe passes its registry row, the gate timeout and the appended URL to check-matting.sh', () => {
  const r = run('upscale-probe-args', `${vars}\n${measured}\nservice_catalog_upscale
bash() { echo "PROBE_TASK_TIMEOUT=$PROBE_TASK_TIMEOUT $*"; }; export -f bash
command bash "\${SVC_PROBE[@]:1}" https://candidate---u.run.app`);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.trim(), 'PROBE_TASK_TIMEOUT=2140 infra/check-matting.sh --probe-upscale https://candidate---u.run.app --model=swinir-x2 '
    + '--sizes=800x1200,1600x1600 --concurrency=1 --rounds=1 --timeout=840');
});

test('deploy.sh: the worker gets catalog-upscale only with UPSCALE_SERVICE=dedicated; cpu keeps catalog-matting', () => {
  const deploy = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8');
  const loop = deploy.slice(deploy.indexOf('for SERVICE in "${SERVICES[@]}"'), deploy.indexOf('# --- Web access'));
  assert.match(loop, /catalog-upscale\)\n[\s\S]*?UPSCALE_SERVICE_URL=\$GATE_URL/);
  assert.match(loop, /if \[ "\$UPSCALE_SERVICE" = cpu \]; then\n\s+if \[ -n "\$UPSCALE_MODEL" \]; then WORKER_ENV\+=",UPSCALE_URL=\$MATTING_URL"; fi/,
    'rollback: UPSCALE_SERVICE=cpu still means the CPU cut-out service');
  assert.match(loop, /elif \[ "\$UPSCALE_SERVICE" = dedicated \]; then[\s\S]*?WORKER_ENV\+=",UPSCALE_URL=\$UPSCALE_SERVICE_URL,UPSCALE_TIMEOUT_S=\$UPSCALE_TIMEOUT_S"/);
  assert.ok(loop.indexOf('catalog-upscale)') < loop.indexOf('catalog-matting-gpu)'), 'the URL is known before the worker env is completed');
  assert.ok(!/UPSCALE_URL=\$GATE_TAG_URL/.test(loop), 'the worker never calls a measure candidate');
});

test('bootstrap: the worker may invoke catalog-upscale through its project-level run.invoker grant', () => {
  const bootstrap = fs.readFileSync(path.join(root, 'infra/bootstrap.sh'), 'utf8');
  const at = bootstrap.indexOf('project_binding "serviceAccount:$WORKER" roles/run.invoker');
  assert.ok(at >= 0);
  assert.match(bootstrap.slice(Math.max(0, at - 600), at), /catalog-upscale/, 'the grant says it covers catalog-upscale');
});

test('spec 17 3.3.2 GPU knobs reach catalog-matting-gpu only when set, one per candidate', () => {
  const knobs = ['CUDNN_CONV_ALGO_SEARCH', 'CUDNN_CONV_USE_MAX_WORKSPACE', 'INFERENCE_LOCK_SCOPE'];
  const unset = knobs.map((k) => `unset ${k}`).join('; ');
  const gpuEnv = (sets) => {
    const r = run('knobs', `${vars}\n${unset}\n${sets}\nshow catalog-matting-gpu; show catalog-matting`);
    assert.equal(r.status, 0, r.err);
    const [gpu, cpu] = lines(r.out.trim()).map((l) => l.split('|'));
    assert.ok(!knobs.some((k) => cpu[8].includes(k)), 'the CPU service never gets a GPU knob');
    return gpu[8];
  };
  assert.equal(gpuEnv(''), 'MAX_RESIDENT_SESSIONS=1', 'unset knobs are not passed (today\'s behaviour)');
  assert.equal(gpuEnv('CUDNN_CONV_ALGO_SEARCH=HEURISTIC'), 'MAX_RESIDENT_SESSIONS=1,CUDNN_CONV_ALGO_SEARCH=HEURISTIC');
  assert.equal(gpuEnv('CUDNN_CONV_USE_MAX_WORKSPACE=0'), 'MAX_RESIDENT_SESSIONS=1,CUDNN_CONV_USE_MAX_WORKSPACE=0');
  assert.equal(gpuEnv('INFERENCE_LOCK_SCOPE=session'), 'MAX_RESIDENT_SESSIONS=1,INFERENCE_LOCK_SCOPE=session');
  assert.equal(gpuEnv('CUDNN_CONV_ALGO_SEARCH=DEFAULT; CUDNN_CONV_USE_MAX_WORKSPACE=1; INFERENCE_LOCK_SCOPE=process'),
    'MAX_RESIDENT_SESSIONS=1,CUDNN_CONV_ALGO_SEARCH=DEFAULT,CUDNN_CONV_USE_MAX_WORKSPACE=1,INFERENCE_LOCK_SCOPE=process');
});

test('the deploy arguments add --no-traffic --tag candidate to an existing service', () => {
  const r = run('args', `service_test_svc; echo EXISTING; gate_deploy_args 1 fp; echo NEW; gate_deploy_args 0 fp`);
  assert.equal(r.status, 0, r.err);
  const [existing, created] = r.out.split('NEW\n');
  const e = lines(existing.replace('EXISTING\n', '').trim());
  assert.deepEqual(e.slice(0, 6), ['run', 'deploy', 'test-svc', '--quiet', '--image=asia-south1-docker.pkg.dev/p/apps/test:abc1234', '--region=asia-south1']);
  assert.ok(e.includes('--set-env-vars=A=1,B=two,DEPLOY_ARGS_SHA=fp'));
  assert.deepEqual(e.slice(-4), ['--invoker-iam-check', '--no-traffic', '--tag', 'candidate']);
  const c = lines(created.trim());
  assert.deepEqual(c.slice(-3), ['--no-allow-unauthenticated', '--tag', 'candidate'], 'a new service cannot take --no-traffic');
  assert.ok(!c.includes('--no-traffic'));
});

test('a passing probe gets the candidate URL, then traffic moves to the latest revision', () => {
  const r = run('pass', 'deploy_service test-svc; echo "GATE=$GATE_URL|$GATE_TAG_URL|$GATE_REVISION"');
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes(`probe got ${TAG_URL}`), r.out);
  assert.ok(lines(r.out).includes(`==> test-svc: live (${NEW})`), r.out);
  assert.ok(r.out.includes(`GATE=${URL}|${TAG_URL}|${NEW}`));
  const deploy = r.calls.find((c) => c.startsWith('run deploy test-svc'));
  assert.match(deploy, / --no-traffic --tag candidate$/);
  assert.match(deploy, /--set-env-vars=A=1,B=two,DEPLOY_ARGS_SHA=[0-9a-f]{16} /);
  const tagPrevious = r.calls.indexOf(`run services update-traffic test-svc --region=asia-south1 --update-tags=previous=${OLD} --quiet`);
  const shift = r.calls.indexOf(`run services update-traffic test-svc --region=asia-south1 --to-revisions=${NEW}=100 --quiet`);
  assert.ok(tagPrevious >= 0, 'the outgoing revision is tagged previous for --rollback');
  assert.ok(shift > tagPrevious && shift > r.calls.indexOf(deploy), 'traffic moves to exactly the probed revision, after the deploy');
  assert.ok(!r.calls.some((c) => c.includes('--to-latest')), 'never --to-latest: an unprobed revision could take traffic');
  assert.ok(!r.calls.some((c) => c.includes('--remove-tags')), 'the deploy moved the tag; nothing stale to remove');
});

test('a failed traffic shift fails the gate with the rollback line', () => {
  const r = run('shift-error', 'deploy_service test-svc', {SHIFT_ERROR: '1'});
  assert.equal(r.status, 1);
  assert.match(r.err, /the traffic shift to test-svc-00002-new failed/);
  assert.ok(lines(r.err).includes(rollbackLine));
  assert.ok(!r.out.includes('live ('));
});

test('a gcloud warning on stderr never reaches the parsed description', () => {
  const r = run('stderr-warning', 'deploy_service test-svc', {WARN_ON_STDERR: '1', LIVE_MATCH: '1'});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes(`SKIP (live revision ${OLD}`), r.out + r.err);
});

test('a failing probe returns non-zero, leaves traffic alone and prints the rollback line', () => {
  const r = run('fail', 'deploy_service test-svc', {PROBE: 'echo "probe saw 3 HTTP 500"; exit 3'});
  assert.equal(r.status, 1);
  assert.ok(r.out.includes('    probe | probe saw 3 HTTP 500'), 'the probe output is printed');
  assert.ok(lines(r.err).includes(rollbackLine), r.err);
  assert.ok(!r.calls.some((c) => c.includes('update-traffic')), 'traffic is not touched');
  assert.ok(!r.out.includes('live ('));
});

test('a probe past its timeout is killed and fails the gate', () => {
  const started = Date.now();
  const r = run('timeout', 'deploy_service test-svc', {PROBE: 'sleep 30', PROBE_TIMEOUT: '1'});
  assert.equal(r.status, 1);
  assert.ok(Date.now() - started < 25000, 'the gate does not wait for the probe past its timeout');
  assert.match(r.err, /timed out after 1 s/);
  assert.ok(lines(r.err).includes(rollbackLine));
  assert.ok(!r.calls.some((c) => c.includes('update-traffic')));
});

test('SKIP when the live revision has the same image digest and env', () => {
  const r = run('skip', 'deploy_service test-svc; echo "GATE=$GATE_URL|$GATE_TAG_URL|$GATE_REVISION"', {LIVE_MATCH: '1'});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes(`==> test-svc: SKIP (live revision ${OLD} already runs this image and env)`), r.out);
  assert.ok(r.out.includes(`GATE=${URL}|${URL}|${OLD}`));
  assert.ok(!r.calls.some((c) => c.startsWith('run deploy')));
  assert.ok(r.calls.some((c) => c.startsWith(`run revisions describe ${OLD} `)));
});

test('a changed env, image digest or flag deploys instead of SKIP', () => {
  let r = run('env-changed', 'deploy_service test-svc');
  assert.equal(r.status, 0, r.err);
  assert.ok(r.calls.some((c) => c.startsWith('run deploy test-svc')));
  r = run('digest-changed', 'deploy_service test-svc', {LIVE_MATCH: '1', LIVE_DIGEST: 'sha256:' + 'b'.repeat(64)});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.calls.some((c) => c.startsWith('run deploy test-svc')), 'a new image digest deploys');
  // The live env was written with the old flags; a flag change alters DEPLOY_ARGS_SHA, so the env no longer matches.
  r = run('flag-changed', 'deploy_service test-svc', {LIVE_MATCH: '1', LIVE_FP: '0123456789abcdef'});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.calls.some((c) => c.startsWith('run deploy test-svc')), 'same image and env but other flags deploys');
  r = run('fingerprint', 'service_test_svc; a=$(gate_fingerprint); SVC_ARGS+=(--concurrency=4); b=$(gate_fingerprint); [ "$a" != "$b" ] && echo DIFFERS');
  assert.ok(r.out.includes('DIFFERS'), 'a flag change changes DEPLOY_ARGS_SHA');
});

test('GATE_FORCE=1 deploys and probes even when the live revision matches', () => {
  const r = run('force', 'GATE_FORCE=1 deploy_service test-svc', {LIVE_MATCH: '1'});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.calls.some((c) => c.startsWith('run deploy test-svc')));
  assert.ok(r.out.includes(`probe got ${TAG_URL}`));
});

test('a new service is created without --no-traffic and gets the candidate tag', () => {
  const r = run('new', 'deploy_service test-svc', {EXISTS: '0'});
  assert.equal(r.status, 0, r.err);
  const deploy = r.calls.find((c) => c.startsWith('run deploy test-svc'));
  assert.match(deploy, / --no-allow-unauthenticated --tag candidate$/);
  assert.ok(!deploy.includes('--no-traffic'));
  assert.ok(!r.calls.some((c) => c.startsWith('artifacts')), 'no SKIP check without a live revision');
});

test('a describe failure other than not found stops before any deploy', () => {
  const r = run('describe-error', 'deploy_service test-svc', {DESCRIBE_ERROR: '1'});
  assert.equal(r.status, 1);
  assert.match(r.err, /cannot read the service; nothing was changed/);
  assert.ok(!r.calls.some((c) => c.startsWith('run deploy')));
});

test('a failed candidate deploy prints the rollback line; a quota refusal on creation is soft only when allowed', () => {
  let r = run('deploy-error', 'deploy_service test-svc', {DEPLOY_ERROR: 'ERROR: Revision failed to start'});
  assert.equal(r.status, 1);
  assert.ok(lines(r.err).includes(rollbackLine));
  r = run('quota-existing', 'deploy_service test-svc', {DEPLOY_ERROR: 'RESOURCE_EXHAUSTED: quota', QUOTA_OPTIONAL: '1'});
  assert.equal(r.status, 1, 'an existing service on quota refusal stops the deploy');
  r = run('quota-new', 'status=0; deploy_service test-svc || status=$?; echo "status=$status"', {DEPLOY_ERROR: 'RESOURCE_EXHAUSTED: quota', QUOTA_OPTIONAL: '1', EXISTS: '0'});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes('status=75'));
});

test('SVC_SHIFT=0 with its own tag (the preview GPU) probes that candidate and never shifts traffic', () => {
  const r = run('no-shift', 'deploy_service test-svc; echo "TAG=$GATE_TAG_URL"', {SHIFT: '0', CAND_TAG: 'preview-abc1234'});
  assert.equal(r.status, 0, r.err);
  assert.match(r.calls.find((c) => c.startsWith('run deploy test-svc')), / --tag preview-abc1234$/);
  assert.ok(r.out.includes(`==> test-svc: candidate (${NEW}) passed; traffic not shifted`));
  assert.ok(r.out.includes(`TAG=${TAG_URL}`));
  assert.ok(!r.calls.some((c) => c.includes('update-traffic')));
});

test('an unknown service is refused', () => {
  const r = run('unknown', 'deploy_service catalog-nope');
  assert.equal(r.status, 1);
  assert.match(r.err, /not in the service registry/);
});

test('rollback returns to the revision tagged previous, or a named one, never a rejected candidate', () => {
  // No previous tag (and only the live revision): refused with how to name one.
  let r = run('rollback-none', 'rollback_service test-svc');
  assert.equal(r.status, 1);
  assert.match(r.err, /no earlier revision tagged previous/);
  assert.ok(!r.calls.some((c) => c.includes('update-traffic')));
  r = run('rollback-named', `rollback_service catalog-matting-gpu ${NEW}`);
  assert.equal(r.status, 0, r.err);
  assert.ok(r.calls.includes(`run services update-traffic catalog-matting-gpu --region=asia-southeast1 --to-revisions=${NEW}=100 --quiet`));
  assert.ok(lines(r.out).includes(`gcloud run services update-traffic catalog-matting-gpu --to-revisions ${NEW}=100`));
  // NEW is live and OLD carries the previous tag: the default target is OLD.
  r = run('rollback-previous', 'rollback_service test-svc', {ROLLBACK_TAGGED: '1'});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.calls.includes(`run services update-traffic test-svc --region=asia-south1 --to-revisions=${OLD}=100 --quiet`), r.calls.join('\n'));
});

test('deploy.sh: gate loop after migrate and queues, before jobs and monitoring; no smoke before the services', () => {
  const deploy = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8');
  const at = (s) => { const i = deploy.indexOf(s); assert.ok(i >= 0, `${s} not in deploy.sh`); return i; };
  const order = ['shape_check "$SQL_CONNECTION_LIMIT"', 'echo "==> build $TAG"', 'echo "==> migrate"',
    '\nqueues_create_missing', 'deploy_service "$SERVICE"', 'echo "==> jobs"', 'echo "==> monitoring"'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(!deploy.includes('gcloud run deploy'), 'every service deploy goes through the gate');
  assert.ok(!/^bash infra\/catalog-smoke-linux\.sh/m.test(deploy), 'the smoke runs inside the worker gate');
  assert.match(deploy, /\[ "\$\{1:-\}" = --rollback \]/);
  assert.ok(!deploy.includes('--to-latest'), 'traffic only ever moves to a probed revision');
  // A re-run after a failed smoke must not SKIP the worker: the worker env names the matting revisions it was smoked
  // against, set after both matting gates and before the worker gate, so the env-change path (tested above) deploys it.
  const loop = deploy.slice(at('for SERVICE in "${SERVICES[@]}"'), at('# --- Web access'));
  assert.match(loop, /MATTING_REVISION=\$GATE_REVISION/);
  assert.match(loop, /WORKER_ENV\+=",SMOKED_MATTING_REVISIONS=\$MATTING_REVISION\/\$GATE_REVISION"/);
  assert.ok(loop.indexOf('SMOKED_MATTING_REVISIONS') < loop.indexOf('catalog-worker)'));
  assert.ok(!/^\s*GATE_FORCE=/m.test(deploy), 'deploy.sh never resets the operator GATE_FORCE override');
});

test('probes follow same-host redirects (the web home page redirects to /catalog)', () => {
  const services = fs.readFileSync(path.join(root, 'infra/lib/services.sh'), 'utf8');
  assert.match(services, /curl -sS -K - -L --max-redirs 5 /);
  assert.match(fs.readFileSync(path.join(root, 'apps/web/app/page.tsx'), 'utf8'), /redirect\("\/catalog"\)/);
});

// Fake gcloud and curl for the probe CLI (exported bash functions; no network). The IAM Credentials call answers
// with the service account's token only for the right service account and scopes; the probe GETs answer 200 only to
// that token, so the operator's identity token (which IAP refuses) fails.
const probeFakes = `gcloud() { case "$*" in "auth print-access-token") echo USER_ACCESS ;; "auth print-identity-token") echo USER_ID ;; *) return 1 ;; esac; }
curl() { local cfg url="" a; cfg=$(cat); for a in "$@"; do case "$a" in https://*) url=$a ;; esac; done
  echo "curl $url" >> "$LOG"
  case "$url" in
    *iamcredentials.googleapis.com*)
      if [[ "$cfg" == *"Bearer USER_ACCESS"* && "$url" == */serviceAccounts/w:generateAccessToken && "$*" == *'"openid","https://www.googleapis.com/auth/userinfo.email"'* ]]; then
        printf '{"accessToken":"SA_TOKEN","expireTime":"x"}\\n200'
      else printf '{"error":{"code":403}}\\n403'; fi ;;
    *) if [ -n "\${SIGN_IN_REDIRECT:-}" ]; then printf '200 https://accounts.google.com/v3/signin?x=1'
       elif [[ "$cfg" == *"Bearer SA_TOKEN"* ]]; then printf '200 %s' "$url"; else printf '401 %s' "$url"; fi ;;
  esac; }
export -f gcloud curl`;

test('the web probe passes IAP as the smoke identity (service account access token), never the operator token', () => {
  let r = run('probe-web', `${vars}\nservice_catalog_web\n${probeFakes}\n"\${SVC_PROBE[@]}" ${TAG_URL}`);
  assert.equal(r.status, 0, r.err + r.out);
  assert.deepEqual(lines(r.out.trim()), [`probe: GET ${TAG_URL}/health -> 200`, `probe: GET ${TAG_URL}/ -> 200`]);
  assert.ok(!/SA_TOKEN|USER_ACCESS|USER_ID/.test(r.out + r.err), 'no token is ever printed');
  assert.ok(r.calls.includes('curl https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/w:generateAccessToken'));
  // Without the service account, or when the token cannot be minted (no Token Creator grant), the probe fails.
  r = run('probe-web-no-sa', `${probeFakes}\nbash infra/lib/services.sh probe-web ${TAG_URL}`);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /WEB_PROBE_SA is not set/);
  r = run('probe-web-denied', `${probeFakes}\nWEB_PROBE_SA=other bash infra/lib/services.sh probe-web ${TAG_URL}`);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /cannot mint an IAP token as other \(IAM Credentials HTTP 403; .*roles\/iam\.serviceAccountTokenCreator/);
  assert.ok(!r.calls.some((c) => c.includes('/health')), 'no GET without an IAP token');
  // A 200 that ends on another host (IAP sending the probe to Google sign-in) is not the service answering.
  r = run('probe-web-sign-in', `${probeFakes}\nSIGN_IN_REDIRECT=1 WEB_PROBE_SA=w bash infra/lib/services.sh probe-web ${TAG_URL}`);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /ended on another host \(https:\/\/accounts\.google\.com\/v3\/signin\)/);
});

test('bootstrap grants the web probe its IAP access and the operator Token Creator on catalog-worker only', () => {
  const bootstrap = fs.readFileSync(path.join(root, 'infra/bootstrap.sh'), 'utf8').split('\n');
  assert.ok(bootstrap.includes('project_binding "serviceAccount:$WORKER" roles/iap.httpsResourceAccessor'));
  assert.ok(bootstrap.some((l) => /sa_binding "\$WORKER" "user:\$OPERATOR" roles\/iam\.serviceAccountTokenCreator no-fallback/.test(l)),
    'on the worker service account, never falling back to project level');
});

test('G1 infra: the jobs step prepares catalog-invariants; catalog-web gets run.viewer at project level', () => {
  const deploy = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8');
  const jobs = deploy.slice(deploy.indexOf('echo "==> jobs"'), deploy.indexOf('jobs: SKIP (preview'));
  assert.match(jobs, /CATALOG_TEST_JOBS=invariants MATTING_URL= \\\n\s+bash infra\/catalog-test-jobs\.sh/,
    'inside the non-preview jobs branch, on the live worker URLs');
  assert.ok(!deploy.replace(/^\s*#.*$/gm, '').includes('jobs execute catalog-invariants'), 'deployed, never executed by deploy.sh');
  const bootstrap = fs.readFileSync(path.join(root, 'infra/bootstrap.sh'), 'utf8');
  assert.ok(bootstrap.split('\n').includes('project_binding "serviceAccount:$WEB" roles/run.viewer'),
    'through the idempotent project_binding helper, not a resource-level binding');
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

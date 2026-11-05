// Run with node infra/tests/shorter-deploys.test.mjs. Offline: gcloud is a fake bash function, no GCP call.
// M6-F2-R7 and R11 (M6-S5), shorter deploys:
// - the matting images are tagged with a hash of their source, and Cloud Build refuses a source that does not hash to
//   the tag, so a commit that leaves services/matting alone builds only the worker and web images, the four matting
//   services are SKIP (no probe), and an image under a tag is always built from exactly that source;
// - the worker's smoke then runs against the live matting services;
// - when several matting services changed, their candidates deploy at once, then their probes run at once, and traffic
//   moves only when every one passed; one failure moves no traffic and changes no service max;
// - a lower max instances (any matting service or the worker), fewer queue slots, or a live value gcloud cannot read
//   wait for the stack to be idle (at most SHAPE_LOWER_WAIT_S), then apply;
// - the deploy ends with the minutes per step and DEPLOY_OK.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-shorter-'));
const posix = (p) => p.replaceAll('\\', '/');
const lines = (text) => text.split('\n').filter(Boolean);
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r/g, '');

function sh(label, script, env = {}, cwd = root) {
  const state = path.join(dir, label);
  fs.mkdirSync(state, {recursive: true});
  const log = path.join(state, 'calls.log');
  fs.writeFileSync(log, '');
  const r = spawnSync(bash, ['-c', `set -euo pipefail\n${script}`], {
    cwd, env: {...process.env, ROOT: posix(root), LOG: posix(log), STATE: posix(state), ...env}, encoding: 'utf8', timeout: 240000,
  });
  if (r.error) throw r.error;
  return {status: r.status, out: r.stdout.replace(/\r/g, ''), err: r.stderr.replace(/\r/g, ''), calls: lines(fs.readFileSync(log, 'utf8').replace(/\r/g, ''))};
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- The matting images' tag and the build plan (infra/lib/build.sh) ----

// A throwaway repo with matting source, a build config and worker code; build.sh sourced.
const gitRepo = (name) => {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo, {recursive: true});
  return [repo, `cd "${posix(repo)}"
git init -q; git config user.email t@example.com; git config user.name t; git config commit.gpgsign false; git config core.autocrlf false
mkdir -p services/matting/app apps/worker
echo a > services/matting/app/main.py; echo FROM > services/matting/Dockerfile; echo b > cloudbuild.yaml; echo c > apps/worker/x.ts
git add -A; git commit -qm one
source "$ROOT/infra/lib/build.sh"`];
};

test('the matting images are tagged with a hash of services/matting and cloudbuild.yaml, not with a commit', () => {
  const [, setup] = gitRepo('source-tag');
  const r = sh('source-tag', `${setup}
echo "one $(matting_source_tag)"
echo d > apps/worker/x.ts; git commit -qam two; echo "worker change $(matting_source_tag)"
git revert --no-edit HEAD >/dev/null; echo "a later commit, same source $(matting_source_tag)"
echo e > cloudbuild.yaml; git commit -qam three; echo "build config change $(matting_source_tag)"
git checkout -q HEAD~1 -- cloudbuild.yaml; git commit -qam back; echo "build config back $(matting_source_tag)"
echo f > services/matting/app/main.py; git commit -qam four; echo "matting change $(matting_source_tag)"
echo x > services/matting/app/main.py; echo "uncommitted edit $(matting_source_tag)"`);
  assert.equal(r.status, 0, r.err);
  const tag = Object.fromEntries(lines(r.out).map((l) => [l.slice(0, l.lastIndexOf(' ')), l.slice(l.lastIndexOf(' ') + 1)]));
  assert.match(tag.one, /^[0-9a-f]{12}$/);
  assert.equal(tag['worker change'], tag.one);
  assert.equal(tag['a later commit, same source'], tag.one);
  assert.notEqual(tag['build config change'], tag.one);
  assert.equal(tag['build config back'], tag.one, 'the same content gives the same tag on any commit');
  assert.notEqual(tag['matting change'], tag.one);
  assert.equal(tag['uncommitted edit'], tag['matting change'], 'the tag names the committed tree');
});

test('Cloud Build check: the source given to the build must hash to _MATTING_TAG (git archive passes, any other copy fails)', () => {
  const [repo, setup] = gitRepo('source-verify');
  const r = sh('source-verify', `${setup}
TAG=$(matting_source_tag)
mkdir -p "$STATE/src"; git archive HEAD | tar -x -C "$STATE/src"
echo "files $(matting_source_tag_of_files "$STATE/src") git $TAG"
cd "$STATE/src"
bash "$ROOT/infra/lib/build.sh" verify-matting-source "$TAG" && echo "archive ok"
echo extra > services/matting/app/main.py
bash "$ROOT/infra/lib/build.sh" verify-matting-source "$TAG" || echo "edited exit $?"
git -C "${posix(repo)}" show HEAD:services/matting/app/main.py > services/matting/app/main.py
echo stray > services/matting/app/new.py
bash "$ROOT/infra/lib/build.sh" verify-matting-source "$TAG" || echo "added exit $?"
rm services/matting/app/new.py
bash "$ROOT/infra/lib/build.sh" verify-matting-source "$TAG" && echo "restored ok"
bash "$ROOT/infra/lib/build.sh" verify-matting-source "" || echo "empty exit $?"
bash "$ROOT/infra/lib/build.sh" verify-matting-source abc1234 || echo "commit-like exit $?"`);
  assert.equal(r.status, 0, r.err);
  const [, files, git] = r.out.match(/^files (\w+) git (\w+)$/m);
  assert.equal(files, git, 'the hash of the files on disk is the hash of the committed tree');
  for (const want of ['archive ok', 'edited exit 1', 'added exit 1', 'restored ok', 'empty exit 2', 'commit-like exit 2']) assert.ok(r.out.includes(want), want + '\n' + r.out);
  assert.match(r.err, /hashes to [0-9a-f]{12}, not _MATTING_TAG=[0-9a-f]{12}[\s\S]*No image was pushed/);
});

test('the matting tag of this repo: the committed tree and a git archive of it agree', () => {
  const r = sh('source-self', `source infra/lib/build.sh
mkdir -p "$STATE/src"; git archive HEAD -- services/matting cloudbuild.yaml | tar -x -C "$STATE/src"
echo "$(matting_source_tag) $(matting_source_tag_of_files "$STATE/src")"`);
  assert.equal(r.status, 0, r.err);
  const [a, b] = r.out.trim().split(' ');
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, b);
});

const fakeAr = `build_gcloud() {
  echo "$*" >> "$LOG"
  case " $MISSING " in *" \${5##*/} "*) echo "ERROR: (gcloud.artifacts.docker.images.describe) NOT_FOUND: image not found" >&2; return 1 ;; esac
  [ "\${AR_ERROR:-0}" = 1 ] && { echo "ERROR: PERMISSION_DENIED" >&2; return 1; }
  echo "image_summary: ok"
}
source infra/lib/build.sh
plan() { build_plan ar t m1 "$@"; echo "NEEDED=$BUILD_NEEDED|$BUILD_CONFIG|$BUILD_SUBSTITUTIONS|$(build_command)"; }`;

test('build plan: nothing missing builds nothing; a missing worker or web image builds only those two', () => {
  let r = sh('plan-none', `${fakeAr}\nplan worker web matting-gpu matting`, {MISSING: ''});
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^NEEDED=0\|/m);
  assert.deepEqual(r.calls.map((c) => c.split(' ')[4]), ['ar/worker:t', 'ar/web:t', 'ar/matting-gpu:m1', 'ar/matting:m1'],
    'worker and web by the commit tag, the matting images by their source tag');
  r = sh('plan-app', `${fakeAr}\nplan worker web matting-gpu matting`, {MISSING: 'worker:t web:t'});
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.trim(), 'NEEDED=1|infra/cloudbuild-preview.yaml|_AR=ar,_TAG=t|gcloud builds submit --config infra/cloudbuild-preview.yaml --substitutions=_AR=ar,_TAG=t .');
});

test('build plan: a missing matting image builds all four with cloudbuild.yaml and _MATTING_TAG', () => {
  const r = sh('plan-full', `${fakeAr}\nplan worker web matting-gpu matting`, {MISSING: 'worker:t web:t matting-gpu:m1 matting:m1'});
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.trim(), 'NEEDED=1|cloudbuild.yaml|_AR=ar,_TAG=t,_MATTING_TAG=m1|gcloud builds submit --config cloudbuild.yaml --substitutions=_AR=ar,_TAG=t,_MATTING_TAG=m1 .');
});

test('the by-hand build: a git archive of HEAD, uploaded, built with the plan\'s config and substitutions', () => {
  const r = sh('plan-tarball', `${fakeAr}\nbuild_plan ar t m1 worker web matting-gpu matting\nbuild_tarball_commands t`, {MISSING: 'matting:m1'});
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(lines(r.out), ['git archive --format=tar.gz -o "$TEMP/catalog-src-t.tgz" HEAD',
    'gcloud storage cp "$TEMP/catalog-src-t.tgz" gs://image-links-agent_cloudbuild/source/catalog-src-t.tgz',
    'gcloud builds submit gs://image-links-agent_cloudbuild/source/catalog-src-t.tgz --config cloudbuild.yaml --substitutions=_AR=ar,_TAG=t,_MATTING_TAG=m1 --async']);
});

test('build plan: an image check that fails for another reason stops before a paid build', () => {
  const r = sh('plan-error', `${fakeAr}\nbuild_plan ar t m1 worker web || echo "PLAN FAILED"`, {MISSING: '', AR_ERROR: '1'});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes('PLAN FAILED'));
  assert.match(r.err, /PERMISSION_DENIED[\s\S]*stopping before a paid build/);
});

test('the build configs: cloudbuild.yaml tags and versions the matting images by _MATTING_TAG; the app build never names it', () => {
  const full = read('cloudbuild.yaml');
  for (const image of ['matting', 'matting-gpu']) {
    assert.ok(full.includes(`"-t", "\${_AR}/${image}:\${_MATTING_TAG}"`), image);
    assert.ok(full.includes(`- "\${_AR}/${image}:\${_MATTING_TAG}"`), `${image} in images`);
  }
  assert.equal((full.match(/GIT_SHA=\$\{_MATTING_TAG\}/g) ?? []).length, 2, '/health reports the source hash');
  assert.ok(!/matting(-gpu)?:\$\{_TAG\}/.test(full));
  // The first step checks the source against the tag; the matting builds wait for it, and Cloud Build pushes the
  // images (the images: list) only when every step passed.
  assert.match(full, /steps:\n(?: {2}#.*\n)* {2}- id: verify-matting-source\n {4}name: ubuntu\n {4}entrypoint: bash\n {4}args: \["infra\/lib\/build\.sh", "verify-matting-source", "\$\{_MATTING_TAG\}"\]\n/);
  assert.match(full, /- id: matting\n(?: {4}.*\n)*? {4}waitFor: \["verify-matting-source"\]/);
  assert.match(full, /- id: matting-gpu\n(?: {4}.*\n)*? {4}waitFor: \["matting"\]/);
  assert.match(full, /^images:/m);
  assert.ok(!/^ {2}- name: .*\n(?: {4}.*\n)*? {4}args: \[[^\]]*"push"/m.test(full), 'no step pushes an image itself');
  // Cloud Build refuses a substitution the config does not use, so build_plan passes _MATTING_TAG only to the full one.
  assert.ok(!read('infra/cloudbuild-preview.yaml').includes('_MATTING_TAG'));
});

test('deploy.sh: the build goes through build_plan; --build-command prints the plan and changes nothing', () => {
  const deploy = read('infra/deploy.sh');
  assert.match(deploy, /MATTING_TAG=\$\(matting_source_tag\)/);
  assert.match(deploy, /build_plan "\$AR" "\$TAG" "\$MATTING_TAG" "\$\{IMAGES\[@\]\}" \|\| exit 1/);
  assert.match(deploy, /gcloud builds submit --config "\$BUILD_CONFIG" --substitutions="\$BUILD_SUBSTITUTIONS" \./);
  assert.ok(!deploy.includes('--substitutions="_AR=$AR,_TAG=$TAG"'));
  const only = deploy.slice(deploy.indexOf('if [ "$BUILD_COMMAND_ONLY" = 1 ]; then'), deploy.indexOf('# M6-F2-R8'));
  assert.match(only, /exit 0\nfi/);
  assert.ok(!/gcloud (builds|run|tasks)/.test(only), 'prints only');
  assert.ok(deploy.indexOf('BUILD_COMMAND_ONLY" = 1') < deploy.indexOf('preflight_login_works'), 'needs no deploy pre-flight');
  // The tags name the committed tree, so the by-hand build refuses a dirty tree and builds a git archive of HEAD.
  assert.ok(only.includes('git status --porcelain') && only.indexOf('git status --porcelain') < only.indexOf('build_plan'), 'clean tree first');
  assert.match(only, /build_tarball_commands "\$TAG"/);
  assert.ok(deploy.includes('[[ "$MATTING_TAG" =~ ^[0-9a-f]{12}$ ]]'));
});

const vars = `AR=ar; TAG=t; MATTING_SA=m; WORKER_SA=w; WEB_SA=web; WORKER_SERVICE=catalog-worker; WEB_SERVICE=catalog-web
NET=(--region=asia-south1 --network=ila-vpc); WORKER_SECRETS=s; SECRETS=s; WEB_SECRETS=ws; WORKER_ENV=W=1; WEB_ENV=X=1
source infra/lib/shape.sh; shape_defaults`;

test('registry: the four matting services run the source-tagged images; worker and web the commit tag', () => {
  const r = sh('registry', `source infra/lib/services.sh\n${vars}\nMATTING_TAG=m1
for s in "\${SERVICES[@]}"; do "service_\${s//-/_}"; echo "$s $SVC_IMAGE"; done; echo "GROUP \${PARALLEL_SERVICES[*]}"`);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(lines(r.out), ['catalog-matting ar/matting:m1', 'catalog-upscale ar/matting:m1', 'catalog-upscale-gpu ar/matting-gpu:m1',
    'catalog-matting-gpu ar/matting-gpu:m1', 'catalog-web ar/web:t', 'catalog-worker ar/worker:t',
    'GROUP catalog-matting catalog-upscale catalog-upscale-gpu catalog-matting-gpu']);
});

test('each matting probe runs as its own job: catalog-check-<service>', () => {
  const r = sh('probe-job', `source infra/lib/services.sh
for s in catalog-matting catalog-upscale catalog-upscale-gpu catalog-matting-gpu ""; do GATE_SERVICE=$s probe_job_name; done`);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(lines(r.out), ['catalog-check-matting', 'catalog-check-upscale', 'catalog-check-upscale-gpu', 'catalog-check-matting-gpu', 'catalog-check-matting']);
  const services = read('infra/lib/services.sh');
  assert.match(services, /PROBE_JOB=\$\(probe_job_name\) PROBE_TASK_TIMEOUT=\$timeout bash infra\/check-matting\.sh --probe "\$url"/);
  assert.match(services, /PROBE_JOB=\$\(probe_job_name\) PROBE_TASK_TIMEOUT=\$timeout bash infra\/check-matting\.sh --probe-upscale/);
  assert.match(read('infra/lib/gate.sh'), /GATE_SERVICE="\$SVC_NAME" timeout --kill-after=10/);
});

// ---- gate_group: candidates at once, then probes at once, then the shifts ----

// A fake gcloud for several services: each has a live revision <name>-old; "run deploy <name>" adds the candidate
// <name>-new. UNCHANGED lists the services whose live revision runs this image and env (SKIP).
const fakeGcloud = `gate_gcloud() {
  printf '%s\\n' "$*" >> "$LOG"
  local svc
  case "$1 $2 $3" in
    "run services describe")
      svc=$4
      if [ -f "$STATE/$svc.deployed" ]; then
        printf '{"status":{"url":"https://%s.run.app","traffic":[{"revisionName":"%s-old","percent":100},{"revisionName":"%s-new","percent":0,"tag":"candidate","url":"https://candidate---%s.run.app"}]}}\\n' "$svc" "$svc" "$svc" "$svc"
      else
        printf '{"status":{"url":"https://%s.run.app","traffic":[{"revisionName":"%s-old","percent":100}]}}\\n' "$svc" "$svc"
      fi ;;
    "artifacts docker images") echo "sha256:aaaa" ;;
    "run revisions describe")
      svc=\${4%-old}
      local env='[]'
      if [[ " \${UNCHANGED:-} " == *" $svc "* ]]; then
        env=$(node -e 'console.log(JSON.stringify(process.argv[1].split(",").map((p) => ({name: p.split("=")[0], value: p.slice(p.indexOf("=") + 1)}))))' "$SVC_ENV,DEPLOY_ARGS_SHA=$(gate_fingerprint)")
      fi
      printf '{"spec":{"containers":[{"env":%s}]},"status":{"imageDigest":"ar/x@sha256:aaaa"}}\\n' "$env" ;;
    "run deploy "*) touch "$STATE/$3.deployed" ;;
  esac
}
source infra/lib/services.sh
source infra/lib/gate.sh
# A probe that logs its start and end (with the service the gate names) and sleeps PROBE_SLEEP seconds;
# FAIL_PROBE names a service whose probe fails.
FAKE_PROBE='echo "probe-start $GATE_SERVICE" >> "$LOG"; sleep "\${PROBE_SLEEP:-0}"; echo "probe-end $GATE_SERVICE" >> "$LOG"; echo "probed $GATE_SERVICE at $1 smoke-matting=\${SMOKE_MATTING_URL:-}|\${SMOKE_MATTING_GPU_URL:-}"; [ "$GATE_SERVICE" != "\${FAIL_PROBE:-}" ]'
for s in "\${SERVICES[@]}"; do
  fn=service_\${s//-/_}
  eval "orig_$(declare -f "$fn")"
  if [ "$s" = catalog-worker ]; then
    eval "$fn() { orig_$fn; SVC_PROBE=(env \\"SMOKE_MATTING_URL=\\\${MATTING_PROBE_URL:-}\\" \\"SMOKE_MATTING_GPU_URL=\\\${MATTING_GPU_PROBE_URL:-}\\" bash -c \\"\\$FAKE_PROBE\\" probe); }"
  else
    eval "$fn() { orig_$fn; SVC_PROBE=(bash -c \\"\\$FAKE_PROBE\\" probe); }"
  fi
done`;

const group = `source infra/tests/gate-fake.sh\n${vars}\n${fakeGcloud}`;

test('gate_group: every candidate is deployed before any probe starts, the probes run at once, then traffic moves', () => {
  const r = sh('group-pass', `${group}
gate_group "\${PARALLEL_SERVICES[@]}"; echo "SHIFTED=\${GATE_GROUP_SHIFTED[*]}"`, {PROBE_SLEEP: '3'});
  assert.equal(r.status, 0, r.err + r.out);
  const idx = (pred) => r.calls.findIndex(pred);
  const lastIdx = (pred) => r.calls.length - 1 - [...r.calls].reverse().findIndex(pred);
  const services = ['catalog-matting', 'catalog-upscale', 'catalog-upscale-gpu', 'catalog-matting-gpu'];
  for (const s of services) assert.ok(r.calls.some((c) => c.startsWith(`run deploy ${s} `)), `${s} candidate`);
  assert.ok(lastIdx((c) => c.startsWith('run deploy ')) < idx((c) => c.startsWith('probe-start')), 'every candidate is ready before the first probe');
  assert.ok(lastIdx((c) => c.startsWith('probe-start')) < idx((c) => c.startsWith('probe-end')), 'the four probes overlap (all started before any ended)');
  assert.ok(lastIdx((c) => c.startsWith('probe-end')) < idx((c) => c.includes('--to-revisions')), 'no traffic moves before every probe passed');
  const shifts = r.calls.filter((c) => c.includes('--to-revisions')).map((c) => c.split(' ')[3]);
  assert.deepEqual(shifts, services, 'traffic moves in registry order');
  for (const s of services) assert.ok(r.out.includes(`probed ${s} at https://candidate---${s}.run.app`), `${s} probed on its candidate as itself`);
  assert.ok(r.out.indexOf('==> catalog-matting: live') < r.out.indexOf('==> catalog-matting-gpu: live'));
  assert.ok(r.out.includes(`SHIFTED=${services.join(' ')}`));
});

test('gate_group: one failed probe moves no traffic at all; each service keeps its live revision', () => {
  const r = sh('group-fail', `${group}
if gate_group "\${PARALLEL_SERVICES[@]}"; then echo GROUP-OK; else echo GROUP-FAILED; fi`, {FAIL_PROBE: 'catalog-upscale-gpu'});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes('GROUP-FAILED'), r.out);
  assert.ok(!r.calls.some((c) => c.includes('update-traffic')), 'no tag and no shift on any service');
  assert.match(r.err, /ERROR: catalog-upscale-gpu: probe of catalog-upscale-gpu-new failed/);
  assert.ok(r.err.includes('gcloud run services update-traffic catalog-upscale-gpu --to-revisions catalog-upscale-gpu-old=100'), 'its rollback line');
  assert.match(r.err, /none of them moved traffic/);
  assert.ok(r.out.includes('==> catalog-matting: probe passed'), 'the others passed and still wait without traffic');
  assert.ok(!r.out.includes(': live ('));
});

test('gate_group: an unchanged service is SKIP (no candidate, no probe) while the changed ones are probed', () => {
  const r = sh('group-skip', `${group}
gate_group "\${PARALLEL_SERVICES[@]}"
gate_group_load catalog-matting; echo "MATTING=$GATE_STATUS|$GATE_CHANGED|$GATE_TAG_URL|$GATE_REVISION"
gate_group_load catalog-upscale; echo "UPSCALE=$GATE_STATUS|$GATE_CHANGED|$GATE_TAG_URL|$GATE_REVISION|$SVC_NAME"`,
  {UNCHANGED: 'catalog-matting catalog-matting-gpu catalog-upscale-gpu'});
  assert.equal(r.status, 0, r.err + r.out);
  for (const s of ['catalog-matting', 'catalog-matting-gpu', 'catalog-upscale-gpu']) {
    assert.ok(r.out.includes(`==> ${s}: SKIP`), s);
    assert.ok(!r.calls.some((c) => c.startsWith(`run deploy ${s} `) || c === `probe-start ${s}`), `${s}: no candidate, no probe`);
  }
  assert.deepEqual(r.calls.filter((c) => c.startsWith('probe-start')), ['probe-start catalog-upscale']);
  assert.ok(r.out.includes('MATTING=0|0|https://catalog-matting.run.app|catalog-matting-old'), r.out);
  assert.ok(r.out.includes('UPSCALE=0|1|https://candidate---catalog-upscale.run.app|catalog-upscale-new|catalog-upscale'), r.out);
});

test('gate_group: a SKIP member changes its service max only after every probe passed, never when the group fails', () => {
  let r = sh('group-max-fail', `${group}
if gate_group "\${PARALLEL_SERVICES[@]}"; then echo GROUP-OK; else echo GROUP-FAILED; fi`,
  {UNCHANGED: 'catalog-matting catalog-matting-gpu', FAIL_PROBE: 'catalog-upscale'});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes('GROUP-FAILED') && r.out.includes('==> catalog-matting: SKIP'), r.out);
  assert.ok(!r.calls.some((c) => c.startsWith('run services update ') || c.includes('update-traffic')), 'no max, no tag, no shift:\n' + r.calls.join('\n'));
  r = sh('group-max-pass', `${group}
gate_group "\${PARALLEL_SERVICES[@]}"`, {UNCHANGED: 'catalog-matting catalog-matting-gpu', PROBE_SLEEP: '1'});
  assert.equal(r.status, 0, r.err + r.out);
  const lastProbe = r.calls.length - 1 - [...r.calls].reverse().findIndex((c) => c.startsWith('probe-end'));
  for (const s of ['catalog-matting', 'catalog-matting-gpu']) {
    const max = r.calls.findIndex((c) => c.startsWith(`run services update ${s} `) && c.includes('--max='));
    assert.ok(max > lastProbe, `${s}: its max is set after the last probe:\n${r.calls.join('\n')}`);
  }
});

// ---- The deploy.sh service loop (the slice deploy.sh runs, with the fake gcloud and fake probes) ----

function loop(label, env) {
  const deploy = read('infra/deploy.sh');
  const slice = deploy.slice(deploy.indexOf('MATTING_URL=""; MATTING_GPU_URL=""'), deploy.indexOf('# --- Web access'));
  const file = path.join(dir, `${label}-loop.sh`);
  fs.writeFileSync(file, slice);
  return sh(label, `${group}
source infra/lib/deploy-steps.sh
MEASURE_ONLY=0; UPSCALE_MODEL=swinir-x2; UPSCALE_MODEL_X4=swinir-x4
queues_apply_shape() { echo "QUEUES APPLIED"; }
queues_lower_wait() { echo "LOWER WAIT CHECKED" >> "$LOG"; }
source "${posix(file)}"
echo "WORKER_ENV=$WORKER_ENV"`, env);
}

test('a worker-only change: the matting services are SKIP and never probed; the smoke runs against the live matting services', () => {
  const r = loop('worker-only', {UNCHANGED: 'catalog-matting catalog-upscale catalog-upscale-gpu catalog-matting-gpu'});
  assert.equal(r.status, 0, r.err + r.out);
  const probes = r.calls.filter((c) => c.startsWith('probe-start'));
  assert.deepEqual(probes, ['probe-start catalog-web', 'probe-start catalog-worker'], 'only the web and the worker are probed');
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run deploy ')).map((c) => c.split(' ')[2]), ['catalog-web', 'catalog-worker']);
  assert.ok(r.out.includes('probed catalog-worker at https://candidate---catalog-worker.run.app smoke-matting=https://catalog-matting.run.app|https://catalog-matting-gpu.run.app'),
    'the smoke on the new worker calls the live matting service URLs');
  assert.match(r.out, /SMOKED_MATTING_REVISIONS=catalog-matting-old\/catalog-matting-gpu-old/);
  assert.ok(r.calls.indexOf('LOWER WAIT CHECKED') < r.calls.findIndex((c) => c.startsWith('run deploy catalog-worker')), 'R11 check right before the worker gate');
  assert.ok(r.out.includes('QUEUES APPLIED'));
});

test('a matting change: the group goes first and live before the web and the worker; the smoke uses the new candidates', () => {
  const r = loop('full', {UNCHANGED: ''});
  assert.equal(r.status, 0, r.err + r.out);
  const lastGroupShift = Math.max(...['catalog-matting', 'catalog-upscale', 'catalog-upscale-gpu', 'catalog-matting-gpu']
    .map((s) => r.calls.indexOf(`run services update-traffic ${s} --region=${s === 'catalog-matting-gpu' ? 'asia-southeast1' : s === 'catalog-upscale-gpu' ? 'asia-south2' : 'asia-south1'} --to-revisions=${s}-new=100 --quiet`)));
  assert.ok(lastGroupShift > 0, r.calls.join('\n'));
  assert.ok(lastGroupShift < r.calls.findIndex((c) => c.startsWith('run deploy catalog-web')), 'web and worker follow the group');
  assert.ok(r.out.includes('smoke-matting=https://candidate---catalog-matting.run.app|https://candidate---catalog-matting-gpu.run.app'));
  assert.match(r.out, /UPSCALE_URL=https:\/\/catalog-upscale\.run\.app/);
  assert.match(r.out, /UPSCALE_GPU_URL=https:\/\/catalog-upscale-gpu\.run\.app/);
});

test('a matting probe failure stops the deploy before the web and the worker, with no traffic moved', () => {
  const r = loop('full-fail', {UNCHANGED: '', FAIL_PROBE: 'catalog-matting'});
  assert.equal(r.status, 1);
  assert.match(r.err, /deploy stopped at catalog-matting catalog-upscale catalog-upscale-gpu catalog-matting-gpu; catalog-web and catalog-worker were not changed/);
  assert.ok(!r.calls.some((c) => c.includes('update-traffic') || c.startsWith('run deploy catalog-web') || c.startsWith('run deploy catalog-worker')));
});

test('a measure run keeps the one-at-a-time loop (no group)', () => {
  const deploy = read('infra/deploy.sh');
  assert.match(deploy, /if \[ "\$MEASURE_ONLY" != 1 \]; then GROUP=\("\$\{PARALLEL_SERVICES\[@\]\}"\); fi/);
});

test('a no-shift candidate (the preview GPU) that matches the live revision never sets the live service max', () => {
  const r = sh('skip-noshift', 'source infra/tests/gate-fake.sh\nsource infra/lib/services.sh\nsource infra/lib/gate.sh\ndeploy_service test-svc',
    {LIVE_MATCH: '1', SHIFT: '0', TEST_MAX: '5', SERVICE_MAX: '3', OLD: 'test-svc-00001-old', NEW: 'test-svc-00002-new', URL: 'https://t.run.app',
      TAG_URL: 'https://candidate---t.run.app', DIGEST: 'sha256:' + 'a'.repeat(64), PROBE: 'true'});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes('SKIP'), r.out);
  assert.ok(!r.calls.some((c) => c.startsWith('run services update ')), r.calls.join('\n'));
});

// ---- M6-F2-R11: lower shapes wait for an idle stack ----

// live: "<queue> <slots>" lines; maxes: "<service>": live max (ERR: describe fails, NF: not found, "": no max set);
// env QUEUES_FAIL=1: the queue list fails. args: what deploy.sh passes to queues_lower_wait.
function lower(label, {live, maxes = {}, busy = 0, args = '--queues catalog-worker', env = {}}) {
  const max = Object.entries({'catalog-worker': '32', ...maxes}).map(([k, v]) => `${k}=${v}`).join(' ');
  return sh(label, `gcloud() {
  echo "$*" >> "$LOG"
  case "$*" in
    "tasks queues list"*) [ "\${QUEUES_FAIL:-0}" = 1 ] && { echo "ERROR: UNAVAILABLE" >&2; return 1; } ;;
  esac
  case "$*" in
    "tasks queues list"*rateLimits*) printf '%s\\n' ${live.map((l) => `'${l}'`).join(' ')} ;;
    "tasks queues list"*) printf '%s\\n' ${live.map((l) => `'${l.split(' ')[0]}'`).join(' ')} ;;
    "run services describe"*)
      local m="" kv; for kv in ${max}; do [ "\${kv%%=*}" = "$4" ] && m=\${kv#*=}; done
      case "$m" in ERR) echo "ERROR: (gcloud.run.services.describe) UNAVAILABLE" >&2; return 1 ;;
        NF) echo "ERROR: (gcloud.run.services.describe) NOT_FOUND: Cannot find service [$4]" >&2; return 1 ;; esac
      echo "$m" ;;
    "tasks list"*)
      n=$(cat "$STATE/busy")
      if [ "$n" = unreadable ]; then echo "ERROR: denied" >&2; return 1; fi
      if [ "$n" -gt 0 ]; then echo "projects/p/locations/l/queues/q/tasks/1"; echo $((n - 1)) > "$STATE/busy"; fi ;;
  esac
}
gcv() { gcloud "$@" | tr -d '\\r'; }
echo "${busy}" > "$STATE/busy"
source infra/lib/services.sh
${vars}
MATTING_TAG=m1; UPSCALE_SERVICE=dedicated; UPSCALE_GPU_SERVICE=\${UPSCALE_GPU_SERVICE:-1}
REGION=asia-south1 QUEUE=catalog BULK_QUEUE=catalog-bulk
source infra/lib/queues.sh
queues_lower_wait ${args}; echo "RETURNED"`, {SHAPE_LOWER_POLL_S: '0', ...env});
}
const LIVE = ['catalog 8', 'catalog-bulk 36', 'catalog-ingest 4', 'catalog-enlarge 2', 'catalog-enlarge-bulk 12'];
const GROUP_ARGS = 'catalog-matting catalog-upscale catalog-upscale-gpu catalog-matting-gpu';
// The shape defaults' max instances, so these read as "the same as live".
const SAME = {'catalog-matting': '4', 'catalog-upscale': '50', 'catalog-upscale-gpu': '4', 'catalog-matting-gpu': '3'};
const HEAD = 'lowers (or cannot read the live value of):\n';

test('R11: the same or a higher shape never waits and never lists tasks', () => {
  let r = lower('lower-none', {live: LIVE});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes('RETURNED') && !r.out.includes('lowers'), r.out);
  assert.ok(!r.calls.some((c) => c.startsWith('tasks list')));
  r = lower('lower-none-group', {live: LIVE, maxes: {...SAME, 'catalog-upscale': '20'}, args: GROUP_ARGS});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes('RETURNED') && !r.out.includes('lowers'), r.out);
  assert.ok(!r.calls.some((c) => c.startsWith('tasks ')), 'the group checks only the service maxes');
  assert.deepEqual(r.calls.filter((c) => c.startsWith('run services describe')).map((c) => c.split(' ')[3]), GROUP_ARGS.split(' '));
});

test('R11: fewer queue slots or a lower worker max wait while a queue holds tasks, then apply when idle', () => {
  const r = lower('lower-busy', {live: ['catalog 20', ...LIVE.slice(1)], maxes: {'catalog-worker': '40'}, busy: 2});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes(`${HEAD}    tasks queue catalog slots 20 -> 8\n    catalog-worker max instances 40 -> 32\n`), r.out);
  assert.equal((r.out.match(/a batch is in flight \(catalog holds tasks\)/g) ?? []).length, 2, r.out);
  assert.match(r.out, /no batch in flight; applying the lower shape\nRETURNED/);
  assert.ok(!r.err.includes('WARN'));
});

test('R11: a lower max on catalog-matting, the CPU upscaler, the GPU upscaler or GPU matting waits too', () => {
  for (const [s, live, want] of [['catalog-matting', '9', 4], ['catalog-upscale', '80', 50], ['catalog-upscale-gpu', '6', 4], ['catalog-matting-gpu', '5', 3]]) {
    const r = lower(`lower-${s}`, {live: LIVE, maxes: {...SAME, [s]: live}, args: GROUP_ARGS, busy: 1});
    assert.equal(r.status, 0, r.err);
    assert.ok(r.out.includes(`${HEAD}    ${s} max instances ${live} -> ${want}\n==> shape: a batch is in flight (catalog holds tasks)`), r.out);
    assert.match(r.out, /no batch in flight; applying the lower shape\nRETURNED/);
  }
});

test('R11 fails closed: a live value gcloud cannot read counts as lowered, so the deploy waits for an idle stack', () => {
  let r = lower('lower-queues-unreadable', {live: LIVE, env: {QUEUES_FAIL: '1', SHAPE_LOWER_WAIT_S: '0'}});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes(`${HEAD}    tasks queues: live slots unreadable\n`), r.out);
  assert.match(r.err, /WARN: a batch is still in flight \(tasks queues \(unreadable\) holds tasks\)/, 'an unreadable queue list counts as busy');
  r = lower('lower-worker-unreadable', {live: LIVE, maxes: {'catalog-worker': 'ERR'}, busy: 1});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes(`${HEAD}    catalog-worker max instances unreadable -> 32\n==> shape: a batch is in flight (catalog holds tasks)`), r.out);
  r = lower('lower-gpu-unreadable', {live: LIVE, maxes: {...SAME, 'catalog-upscale-gpu': 'ERR'}, args: GROUP_ARGS});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes(`${HEAD}    catalog-upscale-gpu max instances unreadable -> 4\n`), r.out);
  r = lower('lower-unset', {live: LIVE, maxes: {...SAME, 'catalog-matting': ''}, args: GROUP_ARGS});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes(`${HEAD}    catalog-matting max instances unset -> 4\n`), r.out);
  r = lower('lower-slot-missing', {live: ['catalog', ...LIVE.slice(1)]});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes(`${HEAD}    tasks queue catalog slots unreadable -> 8\n`), r.out);
});

test('R11: a service that does not exist yet has nothing to lower; one this deploy does not change is not read', () => {
  let r = lower('lower-new-service', {live: LIVE, maxes: {...SAME, 'catalog-upscale-gpu': 'NF'}, args: GROUP_ARGS});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes('RETURNED') && !r.out.includes('lowers'), r.out);
  r = lower('lower-not-deployed', {live: LIVE, maxes: {...SAME, 'catalog-upscale-gpu': 'ERR'}, args: GROUP_ARGS, env: {UPSCALE_GPU_SERVICE: '0'}});
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.includes('RETURNED') && !r.out.includes('lowers'), r.out);
  assert.ok(!r.calls.some((c) => c.startsWith('run services describe catalog-upscale-gpu')), r.calls.join('\n'));
});

test('R11: after SHAPE_LOWER_WAIT_S the lower shape applies with a warning; an unreadable queue counts as busy', () => {
  let r = lower('lower-timeout', {live: ['catalog 20', ...LIVE.slice(1)], busy: 99, env: {SHAPE_LOWER_WAIT_S: '0'}});
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /WARN: a batch is still in flight \(catalog holds tasks\) after 0 s; applying the lower shape now/);
  assert.ok(r.out.includes('RETURNED'));
  r = lower('lower-unreadable', {live: ['catalog 20', ...LIVE.slice(1)], busy: 'unreadable', env: {SHAPE_LOWER_WAIT_S: '0'}});
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /catalog \(unreadable\) holds tasks/);
});

test('R11: deploy.sh checks the group\'s maxes before the group, and the queues and the worker max before the worker gate', () => {
  const deploy = read('infra/deploy.sh');
  const at = deploy.indexOf('queues_lower_wait "${GROUP[@]}"');
  assert.ok(at >= 0 && at < deploy.indexOf('if ! gate_group'), 'before the group');
  assert.ok(deploy.includes('if [ "$SERVICE" = catalog-worker ]; then queues_lower_wait --queues catalog-worker; fi'));
});

test('R11: the default wait is 30 minutes, set by env', () => {
  const queues = read('infra/lib/queues.sh');
  assert.match(queues, /^SHAPE_LOWER_WAIT_S=\$\{SHAPE_LOWER_WAIT_S:-1800\}$/m);
});

// ---- The deploy report ----

test('the deploy report prints the minutes per step and ends with DEPLOY_OK and the total', () => {
  const r = sh('report', `echo 0 > "$STATE/clock"
tick() { local n; n=$(cat "$STATE/clock"); echo "$n"; echo $((n + 150)) > "$STATE/clock"; }
DEPLOY_CLOCK=tick
source infra/lib/deploy-steps.sh
deploy_step pre-flight; deploy_step build; deploy_step catalog-worker; deploy_report abc1234`);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(lines(r.out), ['==> deploy report (minutes and seconds per step)', '    2m30s  pre-flight', '    2m30s  build',
    '    2m30s  catalog-worker', 'DEPLOY_OK abc1234 in 12m30s']);
});

test('deploy.sh: every step is timed and DEPLOY_OK is the last thing it prints', () => {
  const deploy = read('infra/deploy.sh');
  const at = (s) => { const i = deploy.indexOf(s); assert.ok(i >= 0, s); return i; };
  const order = ['deploy_step pre-flight', 'deploy_step build', 'deploy_step migrate', 'deploy_step queues', 'gate_group "${GROUP[@]}"',
    'deploy_step "$SERVICE"', 'deploy_step "IAP and CORS"', 'deploy_step jobs', 'deploy_step monitoring', 'deploy_report "$TAG"'].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(deploy.trimEnd().split('\n').pop(), 'deploy_report "$TAG"');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n${e.message}`); }
}
console.log(failed ? `${failed} of ${tests.length} failed` : `all ${tests.length} passed`);
if (failed) process.exit(1);

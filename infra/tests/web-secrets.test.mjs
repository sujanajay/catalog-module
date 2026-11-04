// Run with node infra/tests/web-secrets.test.mjs. Offline: gcloud is a bash function, no GCP call.
// 1. infra/lib/supabase-paste.sh: the Supabase folder paste switch on catalog-web sticks. Unset, a deploy keeps the live
//    service's value (an earlier "off" stays off); a first deploy is on; an unreadable service stops the deploy.
// 2. infra/bootstrap.sh secret_binding fails closed: a missing secret is skipped with a warning and a failed per-secret
//    binding is left to a person; it never grants the member a project-level secretAccessor (every secret in the project).
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
  const r = spawnSync(bash, ['-c', script], {cwd: root, encoding: 'utf8', env: {...process.env, ...env}});
  return {status: r.status, out: (r.stdout ?? '').replace(/\r/g, ''), err: (r.stderr ?? '').replace(/\r/g, '')};
};
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const service = (env) => JSON.stringify({spec: {template: {spec: {containers: [{env}]}}}});
// gcloud run services describe answers $DESCRIBE with exit $DESCRIBE_STATUS.
const paste = (env) => sh(`set -euo pipefail
gcloud() { if [ "$1 $2 $3" = "run services describe" ]; then printf '%s\\n' "$DESCRIBE"; return "\${DESCRIBE_STATUS:-0}"; fi; echo "unexpected gcloud $*" >&2; return 9; }
source infra/lib/supabase-paste.sh
supabase_folder_paste catalog-web asia-south1`, env);

test('paste switch: an explicit on or off wins; any other value stops the deploy', () => {
  assert.equal(paste({SUPABASE_FOLDER_PASTE: 'off', DESCRIBE: service([])}).out.trim(), 'off');
  assert.equal(paste({SUPABASE_FOLDER_PASTE: 'on', DESCRIBE: service([{name: 'SUPABASE_FOLDER_PASTE', value: 'off'}])}).out.trim(), 'on');
  const bad = paste({SUPABASE_FOLDER_PASTE: 'maybe', DESCRIBE: service([])});
  assert.equal(bad.status, 1);
  assert.match(bad.err, /SUPABASE_FOLDER_PASTE must be on or off/);
});

test('paste switch unset: an "off" on the live service sticks; a live service without it, or none yet, is on', () => {
  assert.equal(paste({SUPABASE_FOLDER_PASTE: '', DESCRIBE: service([{name: 'A', value: '1'}, {name: 'SUPABASE_FOLDER_PASTE', value: 'off'}])}).out.trim(), 'off');
  assert.equal(paste({SUPABASE_FOLDER_PASTE: '', DESCRIBE: service([{name: 'SUPABASE_FOLDER_PASTE', value: 'on'}])}).out.trim(), 'on');
  assert.equal(paste({SUPABASE_FOLDER_PASTE: '', DESCRIBE: service([{name: 'A', value: '1'}])}).out.trim(), 'on');
  assert.equal(paste({SUPABASE_FOLDER_PASTE: '', DESCRIBE: 'ERROR: (gcloud.run.services.describe) Cannot find service [catalog-web]: NOT_FOUND', DESCRIBE_STATUS: '1'}).out.trim(), 'on');
});

test('paste switch unset and the live service unreadable: the deploy stops instead of turning the paste on', () => {
  const r = paste({SUPABASE_FOLDER_PASTE: '', DESCRIBE: 'ERROR: (gcloud) network is unreachable', DESCRIBE_STATUS: '1'});
  assert.equal(r.status, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /set SUPABASE_FOLDER_PASTE=on or off/);
});

test('deploy.sh: the switch comes from supabase_folder_paste; off neither checks nor mounts the Supabase secrets', () => {
  const deploy = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8').replace(/\r/g, '');
  assert.match(deploy, /^SUPABASE_FOLDER_PASTE=\$\(supabase_folder_paste "\$WEB_SERVICE" "\$REGION"\) \|\| exit 1$/m);
  assert.ok(!/SUPABASE_FOLDER_PASTE:-on/.test(deploy), 'never a silent default back to on');
  // Run the mount and check lines for both values with a fake gcloud that fails every secret describe.
  const start = deploy.indexOf('if [ "$SUPABASE_FOLDER_PASTE" = on ]; then\n  for secret');
  const block = deploy.slice(start, deploy.indexOf('\nfi\n', start) + 4);
  const mount = deploy.split('\n').filter((l) => /^WEB_SECRETS=|^if \[ "\$SUPABASE_FOLDER_PASTE" = on \]; then WEB_SECRETS\+=/.test(l)).join('\n');
  assert.ok(start >= 0 && mount.split('\n').length === 2, 'mount and check blocks found');
  const run = (value) => sh(`set -euo pipefail
gcloud() { return 1; }
SECRETS=DB_PASSWORD=catalog-db-password:latest; SUPABASE_FOLDER_PASTE=${value}
${mount}
echo "$WEB_SECRETS"
${block}
echo checked`);
  const off = run('off');
  assert.equal(off.status, 0, off.err);
  assert.deepEqual(off.out.trim().split('\n'), ['DB_PASSWORD=catalog-db-password:latest', 'checked']);
  const on = run('on');
  assert.equal(on.status, 1);
  assert.equal(on.out.trim(), 'DB_PASSWORD=catalog-db-password:latest,SUPABASE_URL=supabase-url:latest,SUPABASE_SERVICE_KEY=supabase-service-key:latest');
  assert.match(on.err, /secret supabase-url missing/);
});

// --- bootstrap secret_binding -------------------------------------------------------------------------------------
const text = fs.readFileSync(path.join(root, 'infra/bootstrap.sh'), 'utf8').replace(/\r/g, '');
const fn = (name) => {
  const start = text.indexOf(`\n${name}() {`);
  assert.ok(start >= 0, `${name} not found in bootstrap.sh`);
  return text.slice(start + 1, text.indexOf('\n}\n', start) + 3);
};
const oneLine = (name) => {
  const line = text.split('\n').find((l) => new RegExp(`^${name}\\(\\) +\\{`).test(l));
  assert.ok(line, `${name} not found in bootstrap.sh`);
  return line;
};
const helpers = [...['log', 'skip', 'create', 'warn', 'gcv', 'needs_human'].map(oneLine), ...['retry', 'load_project_policy', 'project_binding', 'secret_binding'].map(fn)].join('\n');
// gcloud: `secrets describe` exits $DESCRIBE; `secrets add-iam-policy-binding` exits $ADD; every call is logged.
const bind = (env) => {
  const r = sh(`set -euo pipefail
PROJECT=p; PROJECT_POLICY=""; TODO=()
sleep() { :; }
gcloud() {
  echo "$*" >> "$LOG"
  case "$1 $2" in
    "secrets describe") return "$DESCRIBE" ;;
    "secrets get-iam-policy") printf '%s\\n' "\${SECRET_POLICY:-}"; return 0 ;;
    "secrets add-iam-policy-binding") [ "$ADD" = 0 ] || echo "ERROR: PERMISSION_DENIED" >&2; return "$ADD" ;;
    "projects get-iam-policy") printf '%s\\n' "\${PROJECT_POLICY_OUT:-}"; return 0 ;;
    *) return 0 ;;
  esac
}
${helpers}
secret_binding supabase-url serviceAccount:web@p.iam.gserviceaccount.com roles/secretmanager.secretAccessor
printf 'TODO=%s\\n' "\${TODO[@]:-}"`, {LOG: env.log, DESCRIBE: '0', ADD: '0', ...env});
  const calls = fs.readFileSync(env.log, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
  return {...r, calls};
};
const logFile = (label) => { const f = path.join(root, `.tmp-web-secrets-${label}.log`); fs.writeFileSync(f, ''); return f; };
const projectWide = (calls) => calls.some((c) => c.startsWith('projects add-iam-policy-binding'));

test('secret_binding: a missing secret is skipped with a warning; nothing is granted, least of all project-wide', () => {
  const log = logFile('missing');
  try {
    const r = bind({log, DESCRIBE: '1'});
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /WARN +secret supabase-url not found; no binding/);
    assert.ok(!r.calls.some((c) => c.includes('add-iam-policy-binding')), r.calls.join('\n'));
  } finally { fs.rmSync(log, {force: true}); }
});

test('secret_binding: a per-secret binding that keeps failing is left to a person, never a project-level grant', () => {
  const log = logFile('denied');
  try {
    const r = bind({log, ADD: '1'});
    assert.equal(r.status, 0, r.err);
    assert.equal(r.calls.filter((c) => c.startsWith('secrets add-iam-policy-binding supabase-url')).length, 6, 'retried, then stopped');
    assert.ok(!projectWide(r.calls), r.calls.join('\n'));
    assert.match(r.out, /TODO=grant roles\/secretmanager.secretAccessor on secret supabase-url to serviceAccount:web@p.iam.gserviceaccount.com by hand/);
  } finally { fs.rmSync(log, {force: true}); }
});

test('secret_binding: an existing binding is SKIP; a new one is added on that secret only', () => {
  let log = logFile('skip');
  try {
    const r = bind({log, SECRET_POLICY: 'roles/secretmanager.secretAccessor,serviceAccount:web@p.iam.gserviceaccount.com'});
    assert.match(r.out, /SKIP +secret binding on supabase-url/);
    assert.ok(!r.calls.some((c) => c.includes('add-iam-policy-binding')));
  } finally { fs.rmSync(log, {force: true}); }
  log = logFile('create');
  try {
    const r = bind({log});
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /CREATE secret binding on supabase-url/);
    assert.deepEqual(r.calls.filter((c) => c.includes('add-iam-policy-binding')), ['secrets add-iam-policy-binding supabase-url --project=p --member=serviceAccount:web@p.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor']);
  } finally { fs.rmSync(log, {force: true}); }
});

test('bootstrap.sh: every secret_binding caller goes through the fail-closed helper; no project-level fallback is left in it', () => {
  assert.ok(!/project_binding/.test(fn('secret_binding')), 'secret_binding never calls project_binding');
  assert.deepEqual(text.split('\n').filter((l) => /^\s*secret_binding "/.test(l)).map((l) => l.trim().split(' ')[1]),
    ['"$SECRET_NAME"'], 'one caller: the loop over infra/secret-access.manifest');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + (e.stack || e)); }
}
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log(`all ${tests.length} passed`);

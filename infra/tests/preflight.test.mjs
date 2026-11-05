// Run with node infra/tests/preflight.test.mjs. Offline: gcloud is a fake bash function (preflight_gcloud), no GCP call.
// M6-F2-R8 (M6-S4): deploy.sh stops with the login command when the login fails, has under 3 hours left, or a build or
// job identity is disabled or unreadable; it goes on when all hold. deploy.sh runs the checks before its first build.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-preflight-'));
const creds = path.join(dir, 'credentials.db');
fs.writeFileSync(creds, '');
const LOGIN_AT = 1_800_000_000;
fs.utimesSync(creds, LOGIN_AT, LOGIN_AT);
const HOUR = 3600;
const BUILD_SA = '123-compute@developer.gserviceaccount.com';
const JOB_SA = 'catalog-worker@image-links-agent.iam.gserviceaccount.com';

// TOKEN=fail makes print-access-token fail; DISABLED=<sa> reports that account disabled; MISSING=<sa> fails its describe.
function run(env) {
  const script = `set -euo pipefail
cd "$ROOT"
source infra/lib/preflight.sh
preflight_gcloud() {
  case "$1 $2" in
    "auth print-access-token") [ "\${TOKEN:-ok}" = ok ] && echo fake-token-never-printed ;;
    "iam service-accounts")
      [ "$4" = "\${MISSING:-}" ] && { echo "NOT_FOUND" >&2; return 1; }
      [ "$4" = "\${DISABLED:-}" ] && echo True || echo "" ;;
    *) echo "unexpected gcloud $*" >&2; return 1 ;;
  esac
}
login_preflight "$BUILD_SA" "$JOB_SA"`;
  const r = spawnSync(bash, ['-c', script], {
    env: {...process.env, ROOT: root, BUILD_SA, JOB_SA, PREFLIGHT_CREDENTIALS_FILE: creds, ...env},
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.error) throw r.error;
  return r;
}

const LOGIN_CMD = /Log in again, then re-run: gcloud auth login --update-adc/;
const cases = [
  {label: 'a fresh login with enabled identities passes', env: {PREFLIGHT_NOW: String(LOGIN_AT + 2 * HOUR)}, status: 0, out: /about 18 h left \(of an assumed 20 h\)[\s\S]*identity are enabled/},
  {label: 'exactly 3 hours left passes', env: {PREFLIGHT_NOW: String(LOGIN_AT + 17 * HOUR)}, status: 0},
  {label: 'under 3 hours left stops with the login command', env: {PREFLIGHT_NOW: String(LOGIN_AT + 17 * HOUR + 60)}, status: 1,
    err: /the gcloud login is about 17 h old and has about 179 min left of a 20 h login; a deploy needs 3 h\. Log in again/},
  {label: 'a longer assumed session moves the limit', env: {PREFLIGHT_NOW: String(LOGIN_AT + 17 * HOUR + 60), GCLOUD_SESSION_HOURS: '24'}, status: 0},
  {label: 'a login that needs a prompt stops first', env: {TOKEN: 'fail', PREFLIGHT_NOW: String(LOGIN_AT)}, status: 1, err: /does not work without a prompt/},
  {label: 'no credentials file stops', env: {PREFLIGHT_CREDENTIALS_FILE: path.join(dir, 'missing.db'), PREFLIGHT_NOW: String(LOGIN_AT)}, status: 1, err: /cannot tell when gcloud last logged in/},
  {label: 'a disabled build identity stops', env: {DISABLED: BUILD_SA, PREFLIGHT_NOW: String(LOGIN_AT)}, status: 1, err: /service account 123-compute@developer\.gserviceaccount\.com is disabled/, noLogin: true},
  {label: 'an unreadable job identity stops', env: {MISSING: JOB_SA, PREFLIGHT_NOW: String(LOGIN_AT)}, status: 1, err: /cannot read the service account catalog-worker@/, noLogin: true},
];

for (const c of cases) {
  const r = run(c.env);
  assert.equal(r.status, c.status, `${c.label}: status (stderr: ${r.stderr})`);
  if (c.out) assert.match(r.stdout, c.out, c.label);
  if (c.err) assert.match(r.stderr, c.err, c.label);
  if (c.status === 1 && !c.noLogin) assert.match(r.stderr, LOGIN_CMD, `${c.label}: login command`);
  assert.doesNotMatch(r.stdout + r.stderr, /fake-token/, `${c.label}: the token is never printed`);
  console.log(`PASS ${c.label}`);
}

// deploy.sh: the login check runs before the first gcloud read, and the full pre-flight before the build.
const deploy = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8');
const works = deploy.indexOf('preflight_login_works || exit 1');
const firstRead = deploy.indexOf('PN=$(gcv projects describe');
const full = deploy.indexOf('login_preflight "$PN-compute@developer.gserviceaccount.com" "$WORKER_SA" || exit 1');
const build = deploy.indexOf('gcloud builds submit');
assert.ok(works > 0 && works < firstRead, 'deploy.sh checks the login before its first gcloud read');
assert.ok(full > firstRead && full < build, 'deploy.sh runs the pre-flight before the build');
console.log('PASS deploy.sh runs the pre-flight before reading or building');

// Disk pre-flight (2026-11-05, deploy of 9b9abfc: C: reached 0 bytes mid-deploy). preflight_df is faked: the temp
// folder (TMPDIR, a path with catalog-preflight- in it) answers TEMP_FS/TEMP_KB, the repo REPO_FS/REPO_KB; DF=fail
// makes df fail. REAL_DF=1 keeps the real df.
const GB = 1024 * 1024;
function runDisk(env) {
  const script = `set -euo pipefail
cd "$ROOT"
source infra/lib/preflight.sh
if [ "\${REAL_DF:-0}" != 1 ]; then
  preflight_df() {
    [ "\${DF:-ok}" = ok ] || { echo "df: cannot read" >&2; return 1; }
    echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
    if [[ "$1" == *catalog-preflight-* ]]; then echo "$TEMP_FS 100000000 1 $TEMP_KB 99% /t"; else echo "$REPO_FS 100000000 1 $REPO_KB 99% /r"; fi
  }
fi
disk_preflight`;
  const r = spawnSync(bash, ['-c', script], {
    env: {...process.env, ROOT: root, TMPDIR: dir, TEMP_FS: 'C:', REPO_FS: 'C:', TEMP_KB: String(20 * GB), REPO_KB: String(20 * GB), ...env},
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.error) throw r.error;
  return r;
}

const HINT = /Free space \(Windows Settings > System > Storage, or remove merged worktrees: git worktree list\), then re-run/;
const diskCases = [
  {label: 'disk: enough free space passes with one line per drive', env: {}, status: 0, out: /^==> pre-flight: 20\.0 GB free on C: \(the temp folder; a deploy needs 8 GB\)\n$/},
  {label: 'disk: exactly 8 GB passes', env: {TEMP_KB: String(8 * GB), REPO_KB: String(8 * GB)}, status: 0},
  {label: 'disk: a full temp drive (0 bytes) stops with the measured space and the hint', env: {TEMP_FS: 'D:', TEMP_KB: '0'}, status: 1,
    err: /only 0\.0 GB free on D: \(the temp folder, [^)]*catalog-preflight-[^)]*\); a deploy needs 8 GB \(DEPLOY_MIN_FREE_GB\)/, hint: true, out: /20\.0 GB free on C: \(the repo/},
  {label: 'disk: the repo drive under 8 GB stops', env: {REPO_FS: 'E:', REPO_KB: String(8 * GB - 1)}, status: 1, err: /only 7\.9 GB free on E: \(the repo, /, hint: true},
  {label: 'disk: the temp folder and the repo on one low drive give one error', env: {TEMP_KB: String(4 * GB), REPO_KB: String(4 * GB)}, status: 1,
    err: /^ERROR: pre-flight: only 4\.0 GB free on C: \(the temp folder, [^\n]*\n$/, hint: true},
  {label: 'disk: DEPLOY_MIN_FREE_GB moves the limit', env: {TEMP_KB: String(4 * GB), REPO_KB: String(4 * GB), DEPLOY_MIN_FREE_GB: '2'}, status: 0, out: /4\.0 GB free on C: \(the temp folder; a deploy needs 2 GB\)/},
  {label: 'disk: a df that cannot measure stops', env: {DF: 'fail'}, status: 1, err: /cannot measure the free space for the temp folder/},
  {label: 'disk: a DEPLOY_MIN_FREE_GB that is not a number stops', env: {DEPLOY_MIN_FREE_GB: 'eight'}, status: 1, err: /DEPLOY_MIN_FREE_GB must be a whole number/},
  {label: 'disk: the real df -Pk is read on this machine', env: {REAL_DF: '1', TMPDIR: os.tmpdir(), DEPLOY_MIN_FREE_GB: '0'}, status: 0, out: /^==> pre-flight: \d+\.\d GB free on \S+ \(the temp folder; a deploy needs 0 GB\)/},
];
for (const c of diskCases) {
  const r = runDisk(c.env);
  const out = r.stdout.replace(/\r/g, '');
  const err = r.stderr.replace(/\r/g, '');
  assert.equal(r.status, c.status, `${c.label}: status (stderr: ${err})`);
  if (c.out) assert.match(out, c.out, c.label);
  if (c.err) assert.match(err, c.err, c.label);
  if (c.hint) assert.match(err, HINT, `${c.label}: hint`);
  console.log(`PASS ${c.label}`);
}

// deploy.sh: the disk check runs first, before the login check and anything that writes a temp file or a tarball.
const disk = deploy.indexOf('\ndisk_preflight || exit 1\n');
assert.ok(disk > 0 && disk < works, 'deploy.sh checks the disk before the login');
console.log('PASS deploy.sh checks the disk first');

fs.rmSync(dir, {recursive: true, force: true});

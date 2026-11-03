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

fs.rmSync(dir, {recursive: true, force: true});

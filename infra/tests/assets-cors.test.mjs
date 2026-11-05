// Run with node infra/tests/assets-cors.test.mjs. Offline: gcloud is a fake bash function, no GCP call.
// R1 exit finding 2: a folder upload is a browser PUT to the assets bucket, so the bucket CORS must allow every URL
// people open catalog-web on: the deterministic URL and the older hash-based one (catalog-web-qtoctgoxqa-el.a.run.app).
// The deploy.sh CORS step adds missing origins once, keeps the other sites' origins, and is a SKIP on a re-run.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-cors-'));
const posix = (p) => p.replaceAll('\\', '/');
const deploy = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8').replace(/\r/g, '');

// The CORS step as deploy.sh runs it: from the bucket read to the end of its if/else.
const start = deploy.indexOf('CURRENT_CORS=$(gcv storage buckets describe');
const end = deploy.indexOf('\nfi\n', start) + 4;
assert.ok(start > 0 && end > start, 'the CORS step is in deploy.sh');
const step = deploy.slice(start, end);
const legacy = /^LEGACY_WEB_URL=\$\{LEGACY_WEB_URL:-(https:\/\/[^}]+)\}$/m.exec(deploy);
assert.ok(legacy, 'deploy.sh names the legacy web URL');
assert.equal(legacy[1], 'https://catalog-web-qtoctgoxqa-el.a.run.app');

const CANONICAL = 'https://catalog-web-847405579637.asia-south1.run.app';
const PREVIEW = 'https://catalog-web-preview-847405579637.asia-south1.run.app';

function run(label, current, webUrl = CANONICAL) {
  const state = path.join(dir, label);
  fs.mkdirSync(state, {recursive: true});
  fs.writeFileSync(path.join(state, 'current.json'), JSON.stringify(current));
  const script = `set -euo pipefail
gcv() { cat "$STATE/current.json"; }
gcloud() { for a in "$@"; do case "$a" in --cors-file=*) cp "\${a#--cors-file=}" "$STATE/written.json";; esac; done; echo "gcloud $*" >> "$STATE/calls.log"; }
cygpath() { return 1; }
ASSETS_BUCKET=gs://image-links-agent-assets
CANONICAL_WEB_URL=${CANONICAL}
WEB_URL=${webUrl}
LEGACY_WEB_URL=${legacy[1]}
${step}`;
  const r = spawnSync(bash, ['-c', script], {cwd: root, env: {...process.env, STATE: posix(state)}, encoding: 'utf8', timeout: 60000});
  if (r.error) throw r.error;
  const written = path.join(state, 'written.json');
  return {status: r.status, out: r.stdout.replace(/\r/g, ''), err: r.stderr, rules: fs.existsSync(written) ? JSON.parse(fs.readFileSync(written, 'utf8')) : null};
}

const rule = (origin) => ({origin, method: ['PUT', 'GET', 'HEAD'], responseHeader: ['Content-Type', 'Content-Length'], maxAgeSeconds: 3600});
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the live bucket today (canonical and preview only) gets the legacy origin added, other origins kept', () => {
  const r = run('add', {cors_config: [rule([CANONICAL, PREVIEW, 'https://ila.example.com'])]});
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /CORS on gs:\/\/image-links-agent-assets: ADD/);
  assert.deepEqual(r.rules, [rule([CANONICAL, PREVIEW, 'https://ila.example.com', legacy[1]])]);
});

test('a re-run with all three origins present is a SKIP and writes nothing', () => {
  const r = run('skip', {cors_config: [rule([CANONICAL, PREVIEW, legacy[1]])]});
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /CORS on gs:\/\/image-links-agent-assets: SKIP/);
  assert.equal(r.rules, null);
});

test('a preview deploy adds its own URL and the legacy origin', () => {
  const r = run('preview', {cors_config: [rule([CANONICAL])]}, PREVIEW);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.rules[0].origin, [CANONICAL, PREVIEW, legacy[1]]);
});

test('a bucket with no CORS starts from infra/cors.json with the wildcard dropped', () => {
  const r = run('empty', {});
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.rules[0].origin, [CANONICAL, legacy[1]]);
  assert.deepEqual(r.rules[0].method, ['PUT', 'GET', 'HEAD']);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok - ${name}`); } catch (err) { failed++; console.log(`not ok - ${name}\n${err.stack}`); }
}
fs.rmSync(dir, {recursive: true, force: true});
if (failed) process.exit(1);

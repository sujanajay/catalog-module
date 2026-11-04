// Run with node infra/tests/narrow-secret-access.test.mjs. Offline: gcloud is a fake on PATH (a node script with its
// state in a JSON file), no GCP call. infra/narrow-secret-access.sh gives catalog-web and catalog-worker per-secret
// secretAccessor on exactly what they mount, verifies it, and only then removes their project-level grant.
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
const ROLE = 'roles/secretmanager.secretAccessor';
const P = 'image-links-agent';
const WEB = `catalog-web@${P}.iam.gserviceaccount.com`;
const WORKER = `catalog-worker@${P}.iam.gserviceaccount.com`;
const ILA = `ila-web@${P}.iam.gserviceaccount.com`;

const FAKE = `
const fs = require('fs');
const statePath = process.env.FAKE_GCLOUD_STATE;
const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
const flag = (n) => (args.find(a => a.startsWith('--' + n + '=')) || '').split('=').slice(1).join('=');
const save = () => fs.writeFileSync(statePath, JSON.stringify(s));
const log = (line) => { s.calls.push(line); save(); };
const fail = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const cmd = args.filter(a => !a.startsWith('--')).join(' ');
if (cmd.includes('versions access')) { log('READ SECRET VALUE'); fail('never'); }
if (/^run (services|jobs) list$/.test(cmd)) {
  // Region-less list: every region at once, each item labelled with its location (as Cloud Run does).
  const kind = args[1];
  if (flag('region')) fail('the script must list every region (no --region)');
  if ((s.failList || []).includes(kind)) fail('PERMISSION_DENIED');
  const all = Object.entries(s[kind]).flatMap(([region, items]) => items.map(it => ({...it, metadata: {...it.metadata, labels: {'cloud.googleapis.com/location': region}}})));
  process.stdout.write(JSON.stringify(all));
} else if (args[0] === 'secrets' && args[1] === 'describe') {
  if ((s.failDescribe || []).includes(args[2])) fail('ERROR: (gcloud.secrets.describe) UNAVAILABLE: try again');
  if (!s.secrets[args[2]]) fail('ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [' + args[2] + '] not found'); process.stdout.write('projects/1/secrets/' + args[2] + '\\n');
} else if (args[0] === 'secrets' && args[1] === 'get-iam-policy') {
  if (!s.secrets[args[2]] || (s.failPolicy || []).includes(args[2])) fail('denied');
  process.stdout.write(JSON.stringify(s.secrets[args[2]]));
} else if (args[0] === 'secrets' && args[1] === 'add-iam-policy-binding') {
  log('add ' + args[2] + ' ' + flag('member'));
  if ((s.addNoop || []).includes(args[2])) process.exit(0);
  const pol = s.secrets[args[2]]; pol.bindings = pol.bindings || [];
  let b = pol.bindings.find(x => x.role === flag('role') && !x.condition);
  if (!b) { b = {role: flag('role'), members: []}; pol.bindings.push(b); }
  if (!b.members.includes(flag('member'))) b.members.push(flag('member'));
  save();
} else if (args[0] === 'projects' && args[1] === 'get-iam-policy') {
  process.stdout.write(JSON.stringify(s.project));
} else if (args[0] === 'projects' && args[1] === 'remove-iam-policy-binding') {
  if (flag('condition') !== 'None') fail('needs --condition=None');
  log('remove ' + flag('member'));
  for (const b of s.project.bindings) if (b.role === flag('role') && !b.condition) b.members = b.members.filter(m => m !== flag('member'));
  save();
} else fail('unexpected gcloud ' + args.join(' '));
`;

const env1 = (secrets) => secrets.map(name => ({name: name.toUpperCase().replace(/-/g, '_'), valueFrom: {secretKeyRef: {name, key: 'latest'}}}));
const service = (name, sa, secrets) => ({metadata: {name}, spec: {template: {spec: {serviceAccountName: sa, containers: [{env: env1(secrets)}]}}}});
const job = (name, sa, secrets, volume) => ({metadata: {name}, spec: {template: {spec: {template: {spec: {serviceAccountName: sa, containers: [{env: env1(secrets)}], volumes: volume ? [{name: 'v', secret: {secretName: volume}}] : []}}}}}});

function world(change = (s) => s) {
  const secret = (members = []) => ({bindings: members.length ? [{role: ROLE, members}] : []});
  return change({
    calls: [],
    services: {'asia-south1': [service('catalog-web', WEB, ['catalog-db-password']), service('catalog-worker', WORKER, ['catalog-db-password', 'openrouter-api-key']), service('ila-web', ILA, ['db-password'])]},
    jobs: {'asia-south1': [job('catalog-migrate', WORKER, ['catalog-db-password']), job('catalog-qa-check', WORKER, ['catalog-db-password', 'openrouter-api-key'])]},
    secrets: {'catalog-db-password': secret([`serviceAccount:${WEB}`]), 'openrouter-api-key': secret([]), 'db-password': secret([])},
    project: {bindings: [
      {role: ROLE, members: [`serviceAccount:${WEB}`, `serviceAccount:${WORKER}`, `serviceAccount:${ILA}`, 'serviceAccount:work-os-agent@image-links-agent.iam.gserviceaccount.com']},
      {role: ROLE, members: ['user:someone@opptra.com'], condition: {title: 'one-secret', expression: 'x'}},
      {role: 'roles/run.invoker', members: [`serviceAccount:${WORKER}`]},
    ]},
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-narrow-secrets-'));
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(dir, 'fake-gcloud.cjs'), FAKE);
fs.writeFileSync(path.join(bin, 'gcloud'), `#!/usr/bin/env bash\nexec node "$FAKE_GCLOUD_JS" "$@"\n`, {mode: 0o755});
const statePath = path.join(dir, 'state.json');

function run(state, args = [], extraEnv = {}) {
  if (state) fs.writeFileSync(statePath, JSON.stringify(state));
  const binUnix = spawnSync(bash, ['-c', 'cygpath -u "$1" 2>/dev/null || printf %s "$1"', '_', bin], {encoding: 'utf8'}).stdout.trim();
  const r = spawnSync(bash, ['-c', `export PATH="${binUnix}:$PATH"; bash infra/narrow-secret-access.sh "$@"`, '_', ...args], {
    cwd: root, encoding: 'utf8', timeout: 120000,
    env: {...process.env, FAKE_GCLOUD_STATE: statePath, FAKE_GCLOUD_JS: path.join(dir, 'fake-gcloud.cjs'), NARROW_PROPAGATION_S: '0', ...extraEnv},
  });
  if (r.error) throw r.error;
  return {...r, state: JSON.parse(fs.readFileSync(statePath, 'utf8'))};
}
const projectMembers = (s) => s.project.bindings.find(b => b.role === ROLE && !b.condition).members;
const secretMembers = (s, name) => (s.secrets[name].bindings.find(b => b.role === ROLE && !b.condition) || {members: []}).members;
const check = (label, fn) => { fn(); console.log(`PASS ${label}`); };

check('the dry run prints the plan and changes nothing', () => {
  const r = run(world(), ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.state.calls, []);
  assert.match(r.stdout, /ok: catalog-db-password -> catalog-web@/);
  assert.match(r.stdout, /would add: catalog-db-password -> catalog-worker@/);
  assert.match(r.stdout, /would add: openrouter-api-key -> catalog-worker@/);
  assert.match(r.stdout, /openrouter-api-key \(job\/asia-south1\/catalog-qa-check\)/);
  assert.match(r.stdout, /skip: supabase-url does not exist yet/);
  assert.match(r.stdout, /would remove: catalog-web@/);
  assert.match(r.stdout, /would remove: catalog-worker@/);
  assert.match(r.stdout, /left alone: serviceAccount:ila-web@/);
  assert.match(r.stdout, /left alone: serviceAccount:work-os-agent@/);
  assert.doesNotMatch(r.stdout, /db-password -> ila|ila-web.*would/);
});

check('the real run adds and verifies every binding before removing only our two accounts; a second run changes nothing', () => {
  const r = run(world());
  assert.equal(r.status, 0, r.stderr);
  const firstRemove = r.state.calls.findIndex(c => c.startsWith('remove'));
  assert.ok(firstRemove > r.state.calls.findLastIndex(c => c.startsWith('add')), `adds come first: ${r.state.calls}`);
  assert.deepEqual(r.state.calls.filter(c => c.startsWith('remove')).sort(), [`remove serviceAccount:${WEB}`, `remove serviceAccount:${WORKER}`]);
  assert.deepEqual(projectMembers(r.state), [`serviceAccount:${ILA}`, 'serviceAccount:work-os-agent@image-links-agent.iam.gserviceaccount.com']);
  assert.deepEqual(r.state.project.bindings[1].members, ['user:someone@opptra.com']);
  assert.deepEqual(secretMembers(r.state, 'catalog-db-password').sort(), [`serviceAccount:${WEB}`, `serviceAccount:${WORKER}`]);
  assert.deepEqual(secretMembers(r.state, 'openrouter-api-key'), [`serviceAccount:${WORKER}`]);
  assert.deepEqual(secretMembers(r.state, 'db-password'), [], 'ila secrets are not touched');
  assert.ok(!r.state.calls.includes('READ SECRET VALUE'));
  const again = run(null);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.state.calls, r.state.calls, 'no new gcloud writes');
  assert.match(again.stdout, /nothing to remove/);
});

check('a binding that does not take effect stops the removal', () => {
  const r = run(world(s => ({...s, addNoop: ['openrouter-api-key']})));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BLOCKED: binding openrouter-api-key -> catalog-worker@.* is not in place/);
  assert.ok(!r.state.calls.some(c => c.startsWith('remove')), 'no project removal');
  assert.match(r.stdout, /refused: remove catalog-worker@/);
});

check('a needed secret that does not exist, an unreadable policy or an unreadable region stops it, in the dry run too', () => {
  for (const [label, change, err] of [
    ['missing secret', s => { delete s.secrets['openrouter-api-key']; return s; }, /openrouter-api-key is needed by catalog-worker@.* does not exist/],
    ['unreadable policy', s => ({...s, failPolicy: ['catalog-db-password']}), /cannot read the IAM policy of catalog-db-password/],
    ['unreadable list', s => ({...s, failList: ['jobs']}), /cannot read the Cloud Run jobs/],
    ['optional secret that cannot be checked', s => ({...s, failDescribe: ['supabase-url']}), /cannot check whether supabase-url exists/],
    ['secret from another project', s => { s.jobs['asia-south1'].push(job('catalog-x', WORKER, ['projects/other-proj/secrets/their-key'])); return s; }, /catalog-x \(as catalog-worker@.*\) mounts projects\/other-proj\/secrets\/their-key from another project/],
  ]) {
    for (const args of [['--dry-run'], []]) {
      const r = run(world(change), args);
      assert.equal(r.status, 1, `${label} ${args}: ${r.stdout}`);
      assert.match(r.stderr, err, label);
      assert.ok(!r.state.calls.some(c => c.startsWith('remove')), `${label}: no removal`);
    }
  }
});

check('every secret a job or service of these accounts mounts is kept, also under another name; Supabase is bound once it exists', () => {
  const r = run(world(s => {
    s.jobs['asia-south1'].push(job('catalog-test-real', WORKER, [], 'catalog-extra'));
    s.services['asia-south1'].push(service('legacy-tool', WEB, ['legacy-key']));
    s.secrets['catalog-extra'] = {bindings: []};
    s.secrets['legacy-key'] = {bindings: []};
    s.secrets['supabase-url'] = {bindings: []};
    s.secrets['supabase-service-key'] = {bindings: []};
    return s;
  }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /note: service\/asia-south1\/legacy-tool runs as catalog-web@/);
  assert.deepEqual(secretMembers(r.state, 'catalog-extra'), [`serviceAccount:${WORKER}`]);
  assert.deepEqual(secretMembers(r.state, 'legacy-key'), [`serviceAccount:${WEB}`]);
  assert.deepEqual(secretMembers(r.state, 'supabase-url'), [`serviceAccount:${WEB}`]);
  assert.deepEqual(secretMembers(r.state, 'supabase-service-key'), [`serviceAccount:${WEB}`]);
});

check('a service in a region nobody named, and a full same-project secret reference, are still found', () => {
  const r = run(world(s => {
    s.services['europe-west1'] = [service('catalog-web-eu', WEB, [`projects/${P}/secrets/catalog-eu-key`])];
    s.secrets['catalog-eu-key'] = {bindings: []};
    return s;
  }), ['--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /catalog-eu-key \(service\/europe-west1\/catalog-web-eu\)/);
  assert.match(r.stdout, /would add: catalog-eu-key -> catalog-web@/);
});

check('the needed list comes from infra/secret-access.manifest: a pair added there is bound, a malformed line blocks', () => {
  const manifest = path.join(dir, 'secret-access.manifest');
  fs.writeFileSync(manifest, fs.readFileSync(path.join(root, 'infra/secret-access.manifest'), 'utf8') + 'worker photoroom-api-key required\n');
  const env = {SECRET_MANIFEST: manifest.split(path.sep).join('/')};
  const r = run(world(s => { s.secrets['photoroom-api-key'] = {bindings: []}; return s; }), ['--dry-run'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would add: photoroom-api-key -> catalog-worker@/);
  fs.appendFileSync(manifest, 'worker photoroom-api-key sometimes\n');
  const bad = run(world(), ['--dry-run'], env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /secret-access\.manifest line \d+ is not/);
  assert.match(bad.stderr, /BLOCKED: infra\/secret-access\.manifest is malformed/);
});

check('an unknown argument is refused', () => {
  assert.equal(run(world(), ['--now']).status, 2);
});

fs.rmSync(dir, {recursive: true, force: true});

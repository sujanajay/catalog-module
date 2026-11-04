// Run with node infra/tests/secret-access-manifest.test.mjs. Offline: reads the infra scripts, no GCP call.
// Secret access is per secret (infra/narrow-secret-access.sh removed the project-wide grant), so:
// 1. every secret an infra script mounts (--set-secrets, ENV=secret:version) has a line in infra/secret-access.manifest
//    for the account that mounts it, or the revision would fail with "Permission denied on secret";
// 2. no infra script grants roles/secretmanager.secretAccessor at project level (that would undo the narrowing);
// 3. infra/lib/secret-manifest.sh (read by bootstrap.sh, deploy.sh and narrow-secret-access.sh) parses the manifest and
//    refuses an unlisted mount.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import {spawnSync} from 'node:child_process';
import {gitBashPath} from '../../packages/core/src/git-bash.ts';

const root = path.resolve(import.meta.dirname, '../..');
const bash = process.env.CATALOG_BASH || gitBashPath();
const check = (label, fn) => { fn(); console.log(`PASS ${label}`); };

const shFiles = (dir) => fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'tests' ? [] : shFiles(p);
  return e.name.endsWith('.sh') ? [p] : [];
});
const infraScripts = () => shFiles(path.join(root, 'infra')).map((p) => ({file: path.relative(root, p).replace(/\\/g, '/'), text: fs.readFileSync(p, 'utf8').replace(/\r/g, '')}));

/** Script text as commands: comment lines dropped, backslash continuations joined. */
const commands = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/\\\n/g, ' ').split('\n');

/**
 * Every secret mount in a script: "<account> <secret>". catalog-web mounts what goes into a WEB_* variable; deploy.sh's
 * shared SECRETS go to both; everything else (the worker service and every Cloud Run job) runs as catalog-worker.
 */
function mountsIn(text) {
  const out = [];
  for (const line of commands(text)) {
    const assigned = /^\s*(?:if .*then\s+)?([A-Z][A-Z0-9_]*)\+?=/.exec(line)?.[1] ?? '';
    const accounts = assigned.startsWith('WEB_') ? ['web'] : assigned === 'SECRETS' ? ['web', 'worker'] : ['worker'];
    for (const m of line.matchAll(/[A-Z][A-Z0-9_]*=([a-z0-9][a-z0-9_-]*):(?:latest|\d+)\b/g)) {
      for (const a of accounts) out.push(`${a} ${m[1]}`);
    }
  }
  return out;
}
const manifestPairs = (text) => new Set(text.replace(/\r/g, '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => l.trim().split(/\s+/).slice(0, 2).join(' ')));
const unlisted = (scripts, manifest) => scripts.flatMap(({file, text}) => mountsIn(text).filter((p) => !manifest.has(p)).map((p) => `${file}: ${p}`));

/** Commands that grant a Secret Manager role on the project: project_binding / sa_binding (which can fall back to the
 *  project) or gcloud projects add-iam-policy-binding, with a secretmanager role or a variable holding one. */
function projectSecretGrants({file, text}) {
  const roleVars = [...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=["']?roles\/secretmanager\./gm)].map((m) => m[1]);
  return commands(text).filter((line) => {
    const grants = /gcloud\s+projects\s+add-iam-policy-binding/.test(line) || /(^|[;&|]\s*|\s)(project_binding|sa_binding)\s+["$\w]/.test(line);
    if (!grants || /^\s*(project_binding|sa_binding)\s*\(\)/.test(line)) return false;
    return /secretmanager\./.test(line) || roleVars.some((v) => line.includes(`$${v}`) || line.includes(`\${${v}}`));
  }).map((line) => `${file}: ${line.trim()}`);
}

check('every secret an infra script mounts has a manifest line for the account that mounts it', () => {
  const manifest = manifestPairs(fs.readFileSync(path.join(root, 'infra/secret-access.manifest'), 'utf8'));
  const scripts = infraScripts();
  const mounts = scripts.flatMap(({text}) => mountsIn(text));
  for (const p of ['web catalog-db-password', 'worker catalog-db-password', 'worker openrouter-api-key', 'web supabase-url', 'web supabase-service-key']) {
    assert.ok(mounts.includes(p), `the scan finds deploy.sh's mount ${p}`);
  }
  assert.deepEqual(unlisted(scripts, manifest), [], 'add these pairs to infra/secret-access.manifest');
});

check('a new mount without a manifest line is caught (so CI fails)', () => {
  const manifest = manifestPairs(fs.readFileSync(path.join(root, 'infra/secret-access.manifest'), 'utf8'));
  const added = {file: 'infra/deploy.sh', text: 'WORKER_SECRETS="$SECRETS,$OPENROUTER_SECRET_REF,PHOTOROOM_API_KEY=photoroom-api-key:latest"\n'};
  assert.deepEqual(unlisted([added], manifest), ['infra/deploy.sh: worker photoroom-api-key']);
  const job = {file: 'infra/x.sh', text: 'gcloud run jobs deploy x \\\n  --set-secrets=DB_PASSWORD=catalog-db-password:latest,K=new-key:3\n'};
  assert.deepEqual(unlisted([job], manifest), ['infra/x.sh: worker new-key']);
  const web = {file: 'infra/deploy.sh', text: 'if [ "$X" = on ]; then WEB_SECRETS+=",OPENROUTER_API_KEY=openrouter-api-key:latest"; fi\n'};
  assert.deepEqual(unlisted([web], manifest), ['infra/deploy.sh: web openrouter-api-key'], 'the worker line does not cover the web');
});

check('no infra script grants a Secret Manager role at project level', () => {
  assert.deepEqual(infraScripts().flatMap(projectSecretGrants), []);
  const secretBinding = fs.readFileSync(path.join(root, 'infra/bootstrap.sh'), 'utf8').replace(/\r/g, '').match(/^secret_binding\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(secretBinding && !/project_binding|projects add-iam-policy-binding/.test(secretBinding), 'secret_binding never falls back to the project');
});

check('the project-grant scan catches a direct grant, a fallback helper and a role variable, and skips comments', () => {
  const scan = (text) => projectSecretGrants({file: 'infra/x.sh', text});
  assert.equal(scan('project_binding "serviceAccount:$WEB" roles/secretmanager.secretAccessor\n').length, 1);
  assert.equal(scan('  sa_binding "$T" "serviceAccount:$WEB" roles/secretmanager.secretAccessor\n').length, 1);
  assert.equal(scan('ROLE=roles/secretmanager.secretAccessor\ngcloud projects add-iam-policy-binding "$P" \\\n  --member=x --role="$ROLE"\n').length, 1);
  assert.equal(scan('#   gcloud projects add-iam-policy-binding image-links-agent --role=roles/secretmanager.secretAccessor\n').length, 0, 'the rollback comment is not a grant');
  assert.equal(scan('project_binding "serviceAccount:$WORKER" roles/run.invoker\nsecret_binding "$S" "serviceAccount:$WEB" roles/secretmanager.secretAccessor\n').length, 0);
  assert.equal(scan('ROLE=roles/secretmanager.secretAccessor\ngcloud projects remove-iam-policy-binding "$P" --member=x --role="$ROLE"\n').length, 0, 'removing is fine');
});

const lib = (script, env = {}) => {
  const r = spawnSync(bash, ['-c', `set -euo pipefail\nPROJECT=image-links-agent\nsource infra/lib/secret-manifest.sh\n${script}`], {cwd: root, encoding: 'utf8', env: {...process.env, ...env}});
  return {status: r.status, out: (r.stdout ?? '').replace(/\r/g, ''), err: (r.stderr ?? '').replace(/\r/g, '')};
};

check('secret-manifest.sh lists the pairs with full account emails', () => {
  const r = lib('secret_manifest_pairs');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^catalog-worker@image-links-agent\.iam\.gserviceaccount\.com openrouter-api-key required$/m);
  assert.match(r.out, /^catalog-web@image-links-agent\.iam\.gserviceaccount\.com supabase-url optional$/m);
  assert.doesNotMatch(r.out, /#/);
});

check('deploy.sh refuses a mount with no manifest line, and accepts the listed ones', () => {
  const ok = lib('secret_manifest_check worker "DB_PASSWORD=catalog-db-password:latest,OPENROUTER_API_KEY=openrouter-api-key:latest"');
  assert.equal(ok.status, 0, ok.err);
  const bad = lib('secret_manifest_check worker "DB_PASSWORD=catalog-db-password:latest,PHOTOROOM_API_KEY=photoroom-api-key:latest"');
  assert.equal(bad.status, 1);
  assert.match(bad.err, /secret photoroom-api-key is mounted on catalog-worker but has no line in infra\/secret-access.manifest/);
  const web = lib('secret_manifest_check web "OPENROUTER_API_KEY=openrouter-api-key:latest"');
  assert.equal(web.status, 1, 'a worker line does not cover the web');
  const deploy = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8').replace(/\r/g, '');
  assert.match(deploy, /^secret_manifest_check web "\$WEB_SECRETS" \|\| exit 1$/m);
  assert.match(deploy, /secret_manifest_check worker "\$MOUNTS" \|\| exit 1/);
  assert.ok(deploy.indexOf('secret_manifest_check web') < deploy.indexOf('# --- 3. Build'), 'checked before the build');
  const bootstrap = fs.readFileSync(path.join(root, 'infra/bootstrap.sh'), 'utf8').replace(/\r/g, '');
  assert.match(bootstrap, /SECRET_PAIRS=\$\(secret_manifest_pairs\)/, 'bootstrap binds from the manifest');
});

check('a malformed manifest line is refused', () => {
  const tmp = path.join(root, 'infra', `.secret-manifest-test-${process.pid}`);
  fs.writeFileSync(tmp, 'worker openrouter-api-key required\nworkers new-key required\n');
  try {
    const r = lib('secret_manifest_pairs', {SECRET_MANIFEST: tmp.split(path.sep).join('/')});
    assert.equal(r.status, 1);
    assert.match(r.err, /line 2 is not/);
  } finally { fs.rmSync(tmp, {force: true}); }
});

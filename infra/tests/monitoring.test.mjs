// Run with node infra/tests/monitoring.test.mjs. No GCP call: gcloud is a fake bash function.
// Proves infra/monitoring.sh is check-then-create: the first run creates the APIs, the email channel,
// every log metric, every alert policy and the dashboard; a second run against that state creates
// and updates nothing; a changed object is updated in place; nothing is ever deleted; every call
// runs with CLOUDSDK_CORE_PROJECT=image-links-agent. Also checks the policy files, the Cloud Run
// labels on every service and job deploy, and that deploy.sh only warns when monitoring fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import {spawnSync} from 'node:child_process';
import {gitBashPath} from '../../packages/core/src/git-bash.ts';

const infra = path.resolve(import.meta.dirname, '..');
const monDir = path.join(infra, 'monitoring');
const bash = process.env.CATALOG_BASH || gitBashPath();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-monitoring-'));
const fwd = (p) => p.split(path.sep).join('/');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const metricFiles = fs.readdirSync(path.join(monDir, 'metrics')).filter((f) => f.endsWith('.json')).sort();
const policyFiles = fs.readdirSync(path.join(monDir, 'policies')).filter((f) => f.endsWith('.json')).sort();
const metrics = metricFiles.map((f) => readJson(path.join(monDir, 'metrics', f)));
const policies = policyFiles.map((f) => readJson(path.join(monDir, 'policies', f)));
const dashboard = readJson(path.join(monDir, 'dashboard.json'));
const CHANNEL = 'projects/image-links-agent/notificationChannels/111';

// Fake gcloud: logs "<CLOUDSDK_CORE_PROJECT>|<args>" for each call, answers list calls from the
// state files in $STATE, checks every --*-from-file exists and copies it to $CAPTURE.
const fake = `gcloud() {
  printf '%s|%s\\n' "\${CLOUDSDK_CORE_PROJECT:-unset}" "$*" >> "$LOG"
  local a f
  for a in "$@"; do
    case "$a" in
      --config-from-file=*|--policy-from-file=*)
        f=\${a#*=}
        [ -f "$f" ] || { echo "fake gcloud: missing file $f" >&2; return 1; }
        { cat "$f"; printf '\\n@@@\\n'; } >> "$CAPTURE" ;;
    esac
  done
  case "$*" in
    "components list"*) printf '%s\\r\\n' "\${BETA_STATE-Installed}" ;;
    "monitoring policies create"*)
      # Simulates a create the server stored but reported as failed (timeout): the next list shows it.
      if [ -f "$STATE/policies-after.json" ]; then mv "$STATE/policies-after.json" "$STATE/policies.json"; return 1; fi ;;
    "services list"*) cat "$STATE/services.txt" ;;
    "beta monitoring channels list"*) cat "$STATE/channels.json" ;;
    "beta monitoring channels create"*) echo "${CHANNEL}" ;;
    "logging metrics list"*) cat "$STATE/metrics.json" ;;
    "monitoring policies list"*) [ "\${POLICY_LIST_FAIL:-0}" = 1 ] && { echo 'PERMISSION_DENIED mocked' >&2; return 1; }; cat "$STATE/policies.json" ;;
    "monitoring dashboards list"*) cat "$STATE/dashboards.json" ;;
  esac
}`;

function writeState(name, state) {
  const d = path.join(dir, name);
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'services.txt'), (state.services ?? []).join('\n') + '\n');
  for (const k of ['channels', 'metrics', 'policies', 'dashboards']) {
    fs.writeFileSync(path.join(d, k + '.json'), JSON.stringify(state[k] ?? []));
  }
  if (state.policiesAfterCreate) fs.writeFileSync(path.join(d, 'policies-after.json'), JSON.stringify(state.policiesAfterCreate));
  return d;
}

function run(label, state, env = {}) {
  const log = path.join(dir, label + '.log');
  const capture = path.join(dir, label + '.capture');
  fs.writeFileSync(log, '');
  fs.writeFileSync(capture, '');
  const script = `${fake}\nexport -f gcloud\nbash "$TARGET"`;
  const r = spawnSync(bash, ['-c', script], {
    env: {...process.env, CLOUDSDK_CORE_PROJECT: 'operator-default', LOG: fwd(log), CAPTURE: fwd(capture),
      STATE: fwd(writeState(label, state)), TARGET: fwd(path.join(infra, 'monitoring.sh')), ...env},
    encoding: 'utf8', timeout: 120000,
  });
  if (r.error) throw r.error;
  if (process.env.MONITORING_TEST_VERBOSE === '1') console.log(`--- ${label}\n${r.stdout}${r.stderr}`);
  const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    status: r.status, stdout: r.stdout, stderr: r.stderr,
    projects: lines.map((l) => l.slice(0, l.indexOf('|'))),
    calls: lines.map((l) => l.slice(l.indexOf('|') + 1)),
    captured: fs.readFileSync(capture, 'utf8').split('\n@@@\n').filter((s) => s.trim()).map((s) => JSON.parse(s)),
  };
}

const isWrite = (c) => / (create|update|enable|replace|add-iam-policy-binding)( |$)/.test(c);
function commonChecks(label, r) {
  assert.equal(r.status, 0, label + '\n' + r.stdout + r.stderr);
  assert.ok(r.calls.length > 0, label + ' made no gcloud calls');
  assert.deepEqual([...new Set(r.projects)], ['image-links-agent'], label + ' CLOUDSDK_CORE_PROJECT');
  const bad = r.calls.filter((c) => /\b(delete|remove|clear|undelete|disable)\b|--remove-|--clear-|config set/.test(c));
  assert.deepEqual(bad, [], label + ' destructive or config-changing calls');
}

// State a second run would see: what the first run made, as the server returns it (names added,
// proto3 zero values dropped, channels given by project number).
function existingState() {
  const dropZero = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === 0 || v === '0s' ? undefined : v)));
  return {
    services: ['compute.googleapis.com', 'monitoring.googleapis.com', 'clouderrorreporting.googleapis.com\r'],
    channels: [{name: CHANNEL, displayName: 'catalog-email-tech', type: 'email', labels: {email_address: 'sujan@opptra.com'}, enabled: true}],
    metrics: [{name: 'other_metric', filter: 'x'}, ...metrics.map((m) => ({...m, metricDescriptor: {metricKind: 'DELTA', valueType: 'INT64'}, createTime: '2026-10-22T00:00:00Z'}))],
    policies: [{name: 'projects/image-links-agent/alertPolicies/other', displayName: 'Someone else'}, ...policies.map((p, i) => {
      const s = dropZero(p);
      s.name = `projects/image-links-agent/alertPolicies/${i + 1}`;
      s.notificationChannels = ['projects/123456789/notificationChannels/111'];
      s.conditions = s.conditions.map((c, j) => ({...c, name: `${s.name}/conditions/${j}`}));
      s.creationRecord = {mutateTime: '2026-10-22T00:00:00Z'};
      return s;
    })],
    dashboards: [{...dropZero(dashboard), name: 'projects/123456789/dashboards/abc', etag: 'etag-1'}],
  };
}

const count = (r, re) => r.calls.filter((c) => re.test(c)).length;
let cases = 0;
try {
  // 1. First run: everything is created.
  {
    const r = run('first-run', {services: ['compute.googleapis.com']});
    commonChecks('first-run', r);
    assert.equal(count(r, /^services enable monitoring\.googleapis\.com$/), 1);
    assert.equal(count(r, /^services enable clouderrorreporting\.googleapis\.com$/), 1);
    assert.equal(count(r, /^beta monitoring channels create /), 1);
    assert.match(r.calls.find((c) => c.startsWith('beta monitoring channels create')), /--type=email .*--channel-labels=email_address=sujan@opptra\.com/);
    const metricCreates = r.calls.filter((c) => c.startsWith('logging metrics create '));
    assert.deepEqual(metricCreates.map((c) => c.split(' ')[3]).sort(), metrics.map((m) => m.name).sort());
    assert.equal(count(r, /^monitoring policies create --policy-from-file=/), policies.length);
    assert.equal(count(r, /^monitoring dashboards create --config-from-file=/), 1);
    assert.equal(r.calls.filter((c) => / update /.test(c)).length, 0, 'first run updates nothing');
    const sentPolicies = r.captured.filter((o) => o.conditions);
    assert.equal(sentPolicies.length, policies.length);
    for (const p of sentPolicies) assert.deepEqual(p.notificationChannels, [CHANNEL], p.displayName + ' channel substituted');
    assert.ok(!JSON.stringify(r.captured).includes('__CATALOG_EMAIL_CHANNEL__'), 'placeholder left in a sent file');
    console.log('PASS first-run creates ' + (2 + 1 + metrics.length + policies.length + 1) + ' objects');
    cases++;
  }

  // 2. Second run: everything exists and matches, so nothing is created or updated.
  {
    const r = run('second-run', existingState());
    commonChecks('second-run', r);
    assert.deepEqual(r.calls.filter(isWrite), [], 'second run writes nothing');
    const skips = r.stdout.split('\n').filter((l) => l.includes('SKIP')).length;
    assert.equal(skips, 2 + 1 + metrics.length + policies.length + 1, r.stdout);
    console.log('PASS second-run is all SKIP (' + skips + ')');
    cases++;
  }

  // 3. Drift: a changed metric, policy, channel email and dashboard are updated in place.
  {
    const s = existingState();
    s.metrics[1].filter = 'old filter';
    s.policies[3].documentation.content = 'old words';
    s.channels[0].labels.email_address = 'old@opptra.com';
    s.dashboards[0].mosaicLayout.tiles.pop();
    const r = run('drift', s);
    commonChecks('drift', r);
    assert.equal(r.calls.filter((c) => / create /.test(c) || c.startsWith('services enable')).length, 0, 'drift creates nothing');
    assert.equal(count(r, /^beta monitoring channels update projects\/image-links-agent\/notificationChannels\/111 --update-channel-labels=email_address=sujan@opptra\.com$/), 1);
    assert.deepEqual(r.calls.filter((c) => c.startsWith('logging metrics update ')).map((c) => c.split(' ')[3]), [metrics[0].name]);
    assert.deepEqual(r.calls.filter((c) => c.startsWith('monitoring policies update ')).map((c) => c.split(' ')[3]), [s.policies[3].name]);
    assert.equal(count(r, /^monitoring dashboards update projects\/123456789\/dashboards\/abc --config-from-file=/), 1);
    const sentDash = r.captured.find((o) => o.mosaicLayout);
    assert.equal(sentDash.etag, 'etag-1', 'dashboard update carries the etag');
    console.log('PASS drift updates exactly the 4 changed objects');
    cases++;
  }

  // 4a. The beta component is checked read-only first; without it nothing runs or installs.
  for (const [label, beta] of [['beta-missing', 'Not Installed'], ['beta-unknown', '']]) {
    const r = run(label, {}, {BETA_STATE: beta});
    assert.notEqual(r.status, 0, label + ' must fail');
    assert.match(r.stderr, /the gcloud beta component is missing; run: gcloud components install beta/, label);
    assert.deepEqual(r.calls, ['components list --filter=id=beta --format=value(state.name)'], label + ' makes only the read-only check');
    console.log('PASS ' + label + ' stops before any change');
    cases++;
  }

  // 4a2. An installed beta component passes the check, also when a newer version is available.
  for (const [label, beta] of [['beta-installed', 'Installed'], ['beta-update-available', 'Update Available']]) {
    const r = run(label, {services: ['compute.googleapis.com']}, {BETA_STATE: beta});
    commonChecks(label, r);
    assert.doesNotMatch(r.stderr, /the gcloud beta component is missing/, label);
    assert.equal(count(r, /^beta monitoring channels create /), 1, label + ' goes on past the check');
    console.log('PASS ' + label + ' passes the beta check');
    cases++;
  }

  // 4b. A policy create that failed after the server stored it is not repeated into a duplicate.
  {
    const s = existingState();
    s.policiesAfterCreate = s.policies;
    s.policies = s.policies.filter((p) => p.displayName !== policies[4].displayName);
    const r = run('create-retry', s);
    commonChecks('create-retry', r);
    assert.equal(count(r, /^monitoring policies create /), 1, 'one create attempt, no duplicate');
    assert.match(r.stdout, /exists after the failed attempt; not creating it again/);
    console.log('PASS create-retry re-lists and does not duplicate');
    cases++;
  }

  // 4c. A failed lookup stops the script (it never creates blind).
  {
    const r = run('list-fails', existingState(), {POLICY_LIST_FAIL: '1'});
    assert.notEqual(r.status, 0, 'a failed policy list must fail the run');
    assert.equal(count(r, /^monitoring policies create /), 0);
    console.log('PASS list-fails stops before creating policies');
    cases++;
  }

  // 5. The definition files.
  {
    const files = [...metricFiles.map((f) => path.join(monDir, 'metrics', f)), ...policyFiles.map((f) => path.join(monDir, 'policies', f)),
      path.join(monDir, 'dashboard.json'), path.join(infra, 'monitoring.sh'), path.join(infra, 'deploy.sh')];
    for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(String.fromCharCode(0x2014)), 'em dash in ' + f);
    assert.equal(policies.length, 10, 'ten alert policies');
    assert.equal(new Set(policies.map((p) => p.displayName)).size, 10, 'policy display names are unique');
    for (const p of policies) {
      assert.ok(p.displayName && p.documentation?.content?.length > 80, p.displayName + ' documentation');
      assert.equal(p.documentation.mimeType, 'text/markdown');
      assert.equal(p.alertStrategy?.autoClose, '3600s', p.displayName + ' autoClose');
      assert.deepEqual(p.notificationChannels, ['__CATALOG_EMAIL_CHANNEL__'], p.displayName + ' channel placeholder');
      assert.equal(p.conditions.length, p.displayName === 'Catalog: queue stuck' ? 2 : 1, p.displayName + ' conditions');
      const t = p.conditions[0].conditionThreshold;
      assert.ok(t && t.filter && t.comparison === 'COMPARISON_GT' && typeof t.thresholdValue === 'number', p.displayName + ' threshold');
      assert.doesNotMatch(p.documentation.content, /gemini|gpt|claude|llama|qwen|google\//i, p.displayName + ' names a model');
    }
    // Names the operator docs use.
    for (const name of ['Catalog: queue stuck', 'Catalog: error in the logs']) assert.ok(policies.some((p) => p.displayName === name), name);
    // Queue stuck means a deep queue AND no task attempts for 30 minutes (a big batch that is
    // moving keeps attempting tasks, so it never emails); no attempts at all counts as zero.
    const stuck = policies.find((p) => p.displayName === 'Catalog: queue stuck');
    assert.equal(stuck.combiner, 'AND');
    const idle = stuck.conditions[1].conditionThreshold;
    assert.match(idle.filter, /cloudtasks\.googleapis\.com\/queue\/task_attempt_count".*queue_id="catalog"/);
    assert.equal(idle.comparison, 'COMPARISON_LT');
    assert.equal(idle.duration, '1800s');
    assert.equal(idle.evaluationMissingData, 'EVALUATION_MISSING_DATA_ACTIVE');
    assert.doesNotMatch(stuck.documentation.content, /large batch can do this/);
    const usedMetrics = policies.map((p) => p.conditions[0].conditionThreshold.filter.match(/logging\.googleapis\.com\/user\/([\w/]+)/)?.[1]).filter(Boolean);
    assert.deepEqual(usedMetrics.sort(), metrics.map((m) => m.name).sort(), 'every log metric has one policy');
    for (const m of metrics) {
      assert.equal(m.name, 'catalog/' + path.basename(metricFiles[metrics.indexOf(m)], '.json'), 'metric name matches its file');
      assert.match(m.filter, /^resource\.type="cloud_run_revision" AND resource\.labels\.service_name=~"\^catalog-" AND /);
      assert.doesNotMatch(m.filter, /jsonPayload\.(event|msg)\b/, 'log contract uses message');
    }
    // Log contract (PR #89): "batch failed" is ERROR for real faults and WARNING for cause no_photos
    // (an operator input mistake), so only the ERROR ones and the sweeper count towards an email.
    const batchFailed = metrics.find((m) => m.name === 'catalog/batch_failed').filter;
    assert.ok(batchFailed.includes('((jsonPayload.message="batch failed" AND severity=ERROR) OR jsonPayload.message=~"^batch swept")'), 'batch_failed counts ERROR failures and sweeps only');
    assert.ok(metrics.find((m) => m.name === 'catalog/chunk_failed_terminal').filter.includes('jsonPayload.message="chunk failed" AND severity=ERROR'), 'chunk_failed counts terminal (ERROR) only');
    // Spec 15 E7: a 504 on a chunk task from the worker's request log, emailed once in 15 minutes.
    const timeout = metrics.find((m) => m.name === 'catalog/chunk_timeout').filter;
    for (const part of ['resource.labels.service_name="catalog-worker"', 'logName="projects/image-links-agent/logs/run.googleapis.com%2Frequests"', 'httpRequest.status=504', 'httpRequest.requestUrl:"/tasks/catalog/chunk"']) assert.ok(timeout.includes(part), 'chunk_timeout filter has ' + part);
    const ranOut = policies.find((p) => p.displayName === 'Catalog: a chunk task ran out of time').conditions[0].conditionThreshold;
    assert.match(ranOut.filter, /user\/catalog\/chunk_timeout"/);
    assert.deepEqual([ranOut.aggregations[0].alignmentPeriod, ranOut.thresholdValue, ranOut.comparison], ['900s', 0, 'COMPARISON_GT']);
    const errors = metrics.find((m) => m.name === 'catalog/error_logs').filter;
    assert.match(errors, /severity>=ERROR/, 'error_logs counts ERROR and worse only (WARNING lines such as publish failed never email)');
    for (const msg of ['chunk failed', 'batch failed']) assert.ok(errors.includes(`NOT jsonPayload.message="${msg}"`), 'error_logs excludes ' + msg);
    assert.equal(dashboard.displayName, 'Catalog ops');
    console.log('PASS definition files');
    cases++;
  }

  // 6. Every Cloud Run service and job deploy carries the catalog labels.
  {
    const scripts = ['deploy.sh', 'catalog-qa-check.sh', 'catalog-eval.sh', 'catalog-scale-jobs.sh', 'catalog-output-evals.sh'];
    const want = {'catalog-matting': 'matte', 'catalog-matting-gpu': 'matte-gpu', '"$WORKER_SERVICE"': 'worker', '"$WEB_SERVICE"': 'web', 'catalog-migrate': 'job'};
    let seen = 0;
    for (const s of scripts) {
      const lines = fs.readFileSync(path.join(infra, s), 'utf8').split(/\r?\n/);
      lines.forEach((l, i) => {
        if (!/gcloud run (jobs )?deploy /.test(l)) return;
        let cmd = l, j = i;
        while (lines[j].trimEnd().endsWith('\\')) cmd += '\n' + lines[++j];
        const target = l.match(/gcloud run (?:jobs )?deploy (\S+)/)[1];
        const component = /run jobs deploy/.test(l) ? 'job' : want[target];
        assert.ok(component, s + ': unexpected deploy of ' + target);
        assert.ok(cmd.includes(`--labels=app=catalog,component=${component}`), `${s}: ${target} lacks component=${component}`);
        seen++;
      });
    }
    assert.equal(seen, 9, 'deploy commands found');
    assert.match(fs.readFileSync(path.join(infra, 'check-matting.sh'), 'utf8'), /'--labels': \{ app: 'catalog', component: 'job' \}/);
    assert.match(fs.readFileSync(path.join(infra, 'catalog-test-jobs.sh'), 'utf8'), /labels:\{app:'catalog',component:'job'\}/);
    console.log('PASS labels on ' + seen + ' deploy commands plus check-matting and catalog-test-jobs');
    cases++;
  }

  // 7. deploy.sh's monitoring step: skipped on preview, and a failure only warns.
  {
    const deploy = fs.readFileSync(path.join(infra, 'deploy.sh'), 'utf8');
    const block = deploy.slice(deploy.indexOf('# --- 10. Monitoring'));
    assert.ok(block.length > 0 && block.includes('bash infra/monitoring.sh'), 'monitoring section missing');
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'infra'), {recursive: true});
    fs.writeFileSync(path.join(repo, 'infra', 'monitoring.sh'), 'echo ran >> ran.txt; exit "${MON_EXIT:-0}"\n');
    for (const [label, env, status, ran, warnText] of [
      ['deploy-monitoring-fails', {MON_EXIT: '1'}, 0, true, /WARN: infra\/monitoring\.sh failed/],
      ['deploy-monitoring-ok', {MON_EXIT: '0'}, 0, true, null],
      ['deploy-monitoring-preview', {CATALOG_PREVIEW: '1', MON_EXIT: '1'}, 0, false, null],
    ]) {
      fs.rmSync(path.join(repo, 'ran.txt'), {force: true});
      const r = spawnSync(bash, ['-c', `set -euo pipefail\n${block}\necho after-monitoring`], {cwd: repo, env: {...process.env, ...env}, encoding: 'utf8'});
      assert.equal(r.status, status, label + '\n' + r.stderr);
      assert.match(r.stdout, /after-monitoring/, label + ' continues');
      assert.equal(fs.existsSync(path.join(repo, 'ran.txt')), ran, label + ' ran monitoring.sh');
      if (warnText) assert.match(r.stderr, warnText, label);
      console.log('PASS ' + label);
      cases++;
    }
  }
  console.log(cases + ' offline monitoring cases passed');
} finally {
  // Only remove the directory freshly created by this proof, never user data.
  fs.rmSync(dir, {recursive: true, force: true});
}

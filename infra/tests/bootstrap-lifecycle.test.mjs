// Run with node infra/tests/bootstrap-lifecycle.test.mjs. Offline: gcloud is a bash function, no GCP call.
// infra/bootstrap.sh ensure_lifecycle: an unchanged lifecycle is SKIP (key order, rule order, prefix order, whitespace
// and CRLF ignored), a real change is UPDATE with both sides printed, a describe that fails once is retried, and a
// describe that keeps failing or prints something that is not JSON stops the run without rewriting the lifecycle. Before 2026-10-29 every bootstrap run since
// 2026-10-28 rewrote the assets bucket lifecycle (docs/solutions/infra-bootstrap.md).
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
const text = fs.readFileSync(path.join(root, 'infra/bootstrap.sh'), 'utf8').replace(/\r/g, '');
const fn = (name) => {
  const start = text.indexOf(`${name}() {`);
  assert.ok(start >= 0, `${name} not found in bootstrap.sh`);
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end + 2);
};
const oneLine = (name) => text.split('\n').find((l) => l.startsWith(`${name}()`) && /^\w+\(\) +\{/.test(l));
const helpers = ['log', 'skip', 'update', 'die', 'gcv'].map((n) => {
  const line = oneLine(n);
  assert.ok(line, `${n} not found in bootstrap.sh`);
  return line;
}).join('\n');

// The live outputs read on 2026-10-29 (gcloud storage buckets describe --format='json(lifecycle_config)').
const LIVE_ASSETS = `{
  "lifecycle_config": {
    "rule": [
      {
        "action": {
          "type": "Delete"
        },
        "condition": {
          "daysSinceCustomTime": 180,
          "matchesPrefix": [
            "catalog/",
            "catalog-test/"
          ]
        }
      }
    ]
  }
}`;
const LIVE_PUBLIC = `{
  "lifecycle_config": {
    "rule": [
      {
        "action": {
          "type": "Delete"
        },
        "condition": {
          "daysSinceNoncurrentTime": 30,
          "isLive": false
        }
      },
      {
        "action": {
          "type": "Delete"
        },
        "condition": {
          "numNewerVersions": 4
        }
      }
    ]
  }
}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-lifecycle-'));
process.on('exit', () => fs.rmSync(dir, {recursive: true, force: true}));

function run(label, describeOut, file, describeStatus = 0, failFirst = 0) {
  const out = path.join(dir, `${label}.json`);
  fs.writeFileSync(out, describeOut);
  const log = path.join(dir, `${label}.log`);
  fs.writeFileSync(log, '');
  const script = `set -euo pipefail
PROJECT=p
${helpers}
gcloud() {
  echo "$*" >> "$LOG"
  if [ "$1 $2 $3" = "storage buckets describe" ]; then
    if [ "$(grep -c '^storage buckets describe' "$LOG")" -le "$FAIL_FIRST" ]; then echo "ERROR: (gcloud) transient" >&2; return 1; fi
    cat "$OUT"; return "$DESCRIBE_STATUS"
  fi
}
sleep() { :; }
${fn('retry')}
${fn('json_key_matches')}
${fn('ensure_lifecycle')}
ensure_lifecycle gs://b ${file}`;
  const r = spawnSync(bash, ['-c', script], {cwd: root, encoding: 'utf8',
    env: {...process.env, OUT: out, LOG: log, DESCRIBE_STATUS: String(describeStatus), FAIL_FIRST: String(failFirst)}});
  const calls = fs.readFileSync(log, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
  return {status: r.status, out: r.stdout.replace(/\r/g, ''), err: r.stderr.replace(/\r/g, ''), updated: calls.some((c) => c.startsWith('storage buckets update')),
    describes: calls.filter((c) => c.startsWith('storage buckets describe')).length};
}

const cases = [
  {label: 'the live assets lifecycle of 2026-10-29 equals infra/lifecycle-assets.json: SKIP', live: LIVE_ASSETS, file: 'infra/lifecycle-assets.json', skip: true},
  {label: 'the live public lifecycle of 2026-10-29 equals infra/lifecycle-public.json: SKIP', live: LIVE_PUBLIC, file: 'infra/lifecycle-public.json', skip: true},
  {label: 'a leading byte order mark is ignored: SKIP', live: `\uFEFF${LIVE_ASSETS}`, file: 'infra/lifecycle-assets.json', skip: true},
  {label: 'CRLF output and other key order are SKIP', live: LIVE_ASSETS.replace(/\n/g, '\r\n'), file: 'infra/lifecycle-assets.json', skip: true},
  {label: 'rules and prefixes in another order are the same rule set: SKIP',
    live: JSON.stringify({lifecycle_config: {rule: [{condition: {numNewerVersions: 4}, action: {type: 'Delete'}}, {condition: {isLive: false, daysSinceNoncurrentTime: 30}, action: {type: 'Delete'}}]}}),
    file: 'infra/lifecycle-public.json', skip: true},
  {label: 'prefixes in another order: SKIP',
    live: JSON.stringify({lifecycle_config: {rule: [{action: {type: 'Delete'}, condition: {matchesPrefix: ['catalog-test/', 'catalog/'], daysSinceCustomTime: 180}}]}}),
    file: 'infra/lifecycle-assets.json', skip: true},
  {label: 'a real change is UPDATE and prints both sides',
    live: LIVE_ASSETS.replace('180', '90'), file: 'infra/lifecycle-assets.json', skip: false,
    out: /UPDATE lifecycle on gs:\/\/b from infra\/lifecycle-assets.json\n\[bootstrap\] {8}live: .*"daysSinceCustomTime":90.*\n\[bootstrap\] {8}file: .*"daysSinceCustomTime":180/},
  {label: 'no lifecycle yet (null) is UPDATE', live: 'null', file: 'infra/lifecycle-assets.json', skip: false},
  {label: 'a describe that keeps failing is tried 6 times, then stops the run and changes nothing', live: '', file: 'infra/lifecycle-assets.json', describeStatus: 1, status: 1, describes: 6,
    err: /cannot read the lifecycle of gs:\/\/b \(gcloud storage buckets describe failed\); nothing was changed/},
  // 2026-10-29 review P2: a transient describe failure no longer aborts the deploy; the retry log goes to stderr, so the
  // captured describe output stays JSON.
  {label: 'a describe that fails twice then answers is retried: SKIP', live: LIVE_ASSETS, file: 'infra/lifecycle-assets.json', failFirst: 2, skip: true, describes: 3},
  {label: 'output that is not JSON stops the run and changes nothing', live: `WARNING: something\n${LIVE_ASSETS}`, file: 'infra/lifecycle-assets.json', status: 1,
    err: /cannot compare the lifecycle of gs:\/\/b with infra\/lifecycle-assets.json \(not JSON\); nothing was changed/},
];

// Spec 18 lifecycle 3.1 (T58): the stored enlargements under <brand prefix>/derived/ are kept at least 180 days. Every
// Delete rule of the assets bucket that can match such a key waits 180 days (by age or since the custom time, which
// only a superseded raw object gets); a rule without a prefix matches every key.
{
  const assets = JSON.parse(fs.readFileSync(path.join(root, 'infra/lifecycle-assets.json'), 'utf8'));
  const keys = ['catalog/acme/derived/p1/p1_1.swinir-x2-cpu-f477a052.s2.abc.jpg', 'catalog-test/acme/derived/p1/p1_1.swinir-x4.s4.abc.jpg.tile-0.jpg'];
  for (const rule of assets.rule.filter((r) => r.action.type === 'Delete')) {
    const c = rule.condition, prefixes = c.matchesPrefix ?? [''];
    if (!keys.some((k) => prefixes.some((p) => k.startsWith(p)))) continue;
    const wait = Math.max(c.age ?? 0, c.daysSinceCustomTime ?? 0);
    assert.ok(wait >= 180, `an assets Delete rule can remove a stored enlargement before 180 days: ${JSON.stringify(rule)}`);
  }
  console.log('PASS stored enlargements (derived/) are kept at least 180 days');
}

// 2026-10-29 review P2: the BOM strip is written as an escape, never as the invisible character an editor may drop.
assert.ok(!text.includes('\uFEFF'), 'infra/bootstrap.sh holds no literal byte order mark');
assert.match(fn('json_key_matches'), /replace\(\/\^\\uFEFF\/, ""\)/);

for (const c of cases) {
  const r = run(c.label.replace(/\W+/g, '-').slice(0, 40), c.live, c.file, c.describeStatus ?? 0, c.failFirst ?? 0);
  if (c.describes) assert.equal(r.describes, c.describes, `${c.label}: describe calls`);
  if (c.status) {
    assert.equal(r.status, c.status, `${c.label}: ${r.out}${r.err}`);
    assert.equal(r.updated, false, `${c.label}: the lifecycle must not be rewritten`);
    assert.match(r.err, c.err, c.label);
  } else {
    assert.equal(r.status, 0, `${c.label}: ${r.err}`);
    assert.equal(r.updated, !c.skip, `${c.label}: ${r.out}`);
    assert.match(r.out, c.skip ? /SKIP {3}lifecycle on gs:\/\/b/ : /UPDATE lifecycle on gs:\/\/b/, c.label);
    if (c.out) assert.match(r.out, c.out, c.label);
  }
  console.log(`PASS ${c.label}`);
}
console.log(`bootstrap lifecycle: ${cases.length} cases passed`);

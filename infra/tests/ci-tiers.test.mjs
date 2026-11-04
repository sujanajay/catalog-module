// Run with node infra/tests/ci-tiers.test.mjs. Offline, node built-ins only (the infra CI job installs nothing).
// M6-F8 tiered tests (M6-S7a): the unit test shards are balanced by file time and cover every file once, the real
// Postgres tests run in CI (M0 decision D11), docs/specs/test-tiers.json names paths that exist, and T0's file pick.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import console from 'node:console';
import {normalise, plan, readTimings, shardCost} from '../../.github/ci/shards.mjs';
import {neededTiers, readTiers, summary} from '../../.github/ci/tiers.mjs';
import {parseLog} from '../../.github/ci/timings.mjs';
import {selectFiles} from '../../.github/ci/t0.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r/g, '');
const check = (label, fn) => { fn(); console.log(`PASS ${label}`); };

/** The `jobs.<id>:` block of ci.yml (two-space job keys). */
const job = (id) => {
  const start = ci.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `job ${id} in ci.yml`);
  const next = ci.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
};

check('every file lands in exactly one shard, the same way on every run, and an unknown file counts as the median', () => {
  const timings = {'a.test.ts': 100, 'b.test.ts': 90, 'c.test.ts': 10, 'd.test.ts': 10, 'e.test.ts': 10};
  const files = [...Object.keys(timings), 'new.test.ts', 'a.test.ts'];
  const shards = plan(files, timings, 3);
  const all = shards.flatMap((s) => s.files).sort();
  assert.deepEqual(all, ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts', 'new.test.ts']);
  assert.deepEqual(plan([...files].reverse(), timings, 3), shards, 'order of the list does not matter');
  assert.ok(shards.some((s) => s.files.includes('new.test.ts') && s.total >= 10), 'the new file weighs the median');
  assert.notEqual(shards.find((s) => s.files.includes('a.test.ts')), shards.find((s) => s.files.includes('b.test.ts')), 'the two heavy files are apart');
  assert.throws(() => plan(files, timings, 0), /positive integer/);
  // A file measured at 0 s (under 50 ms) is known to be fast, not unknown: it does not weigh the median.
  assert.ok(plan(['c.test.ts', 'fast.test.ts'], {...timings, 'fast.test.ts': 0}, 1)[0].total < 11, 'a 0 s file weighs almost nothing');
});

check('the CI shards with the committed timings stay well inside the 10-minute T1 budget', () => {
  const timings = readTimings();
  const count = Number(/node \.github\/ci\/shards\.mjs \$\{\{ matrix\.shard \}\} (\d+)/.exec(ci)?.[1]);
  const shards = plan(Object.keys(timings), timings, count);
  const worst = Math.max(...shards.map(shardCost));
  // About 70 s of checkout and install comes on top of the tests; 7.5 min of tests leaves room for slow runners.
  assert.ok(worst <= 450, `slowest shard about ${Math.round(worst)} s`);
  // Shards holding one heavy file alone are bounded by that file; the shards with several files are even with each other.
  const totals = shards.filter((s) => s.files.length > 1).map((s) => s.total);
  assert.ok(totals.length > 1 && Math.max(...totals) - Math.min(...totals) < 120, `multi-file shard totals ${totals.map(Math.round)}`);
});

check('ci.yml runs the balanced shards (not vitest --shard), every listed file, and as many shards as the matrix has', () => {
  const test = job('test');
  const matrix = /shard: \[([\d, ]+)\]/.exec(test)?.[1].split(',').map((s) => Number(s.trim()));
  const count = Number(/shards\.mjs \$\{\{ matrix\.shard \}\} (\d+)/.exec(test)?.[1]);
  assert.deepEqual(matrix, Array.from({length: count}, (_, i) => i + 1), 'the matrix is 1..count');
  assert.match(test, /name: unit tests \(shard \$\{\{ matrix\.shard \}\}\/(\d+)\)/);
  assert.equal(Number(/unit tests \(shard \$\{\{ matrix\.shard \}\}\/(\d+)\)/.exec(test)[1]), count);
  assert.doesNotMatch(test, /--shard=/);
  assert.match(test, /pnpm exec vitest list --filesOnly > "\$RUNNER_TEMP\/test-files\.txt"/);
  assert.match(test, /xargs -r -a "\$RUNNER_TEMP\/shard-files\.txt" pnpm exec vitest run/, 'an empty shard runs nothing (not everything)');
});

check('ci.yml runs every TEST_PG_URL test file against a Postgres 16 service (M0 D11)', () => {
  const pg = job('postgres');
  assert.match(pg, /image: postgres:16\n/);
  assert.match(pg, /--health-cmd pg_isready/);
  assert.match(pg, /TEST_PG_URL: postgres:\/\/postgres:postgres@localhost:5432\/postgres/);
  assert.match(pg, /grep -rl --include='\*\.test\.ts' --include='\*\.test\.tsx' --exclude='\*\.real\.test\.ts' --exclude-dir=node_modules TEST_PG_URL apps packages/);
  assert.match(pg, /test -s "\$RUNNER_TEMP\/pg-files\.txt"/, 'fails when no file is found, never passes empty');
  // The files it finds today: the M0-S1 contract and migration tests.
  const found = ['packages/core/src/graph/graph.test.ts', 'packages/core/src/db/migration-0009.test.ts'];
  for (const f of found) assert.match(fs.readFileSync(path.join(root, f), 'utf8'), /TEST_PG_URL/);
});

check('the lint job writes the tiers a PR needs to the run summary', () => {
  const lint = job('lint');
  assert.match(lint, /fetch-depth: 0/);
  assert.match(lint, /node \.github\/ci\/tiers\.mjs "\$\{\{ github\.event\.pull_request\.base\.sha \}\}" \| tee -a "\$GITHUB_STEP_SUMMARY"/);
});

check('tiers: a copy-only web change needs T1 only; render needs T2; pipeline needs T3; unbuilt tiers say so', () => {
  const tiers = readTiers();
  assert.deepEqual(neededTiers(['apps/web/lib/catalog/ops-copy.ts', 'docs/x.md'], tiers).map((t) => t.tier), ['T1']);
  assert.deepEqual(neededTiers(['packages/core/src/catalog/render.ts'], tiers).map((t) => t.tier), ['T1', 'T2']);
  assert.deepEqual(neededTiers(['packages/core/src/catalog/pipeline/dispatch.ts', 'services/matting/app.py'], tiers).map((t) => t.tier), ['T1', 'T2', 'T3']);
  const text = summary(['packages/core/src/catalog/render.ts'], tiers);
  assert.match(text, /\*\*T2\*\* .*needed, not built yet: M6-S7a decision S7a-4/);
  assert.match(text, /\*\*T1\*\* .*needed \(budget 10 min\)/);
});

check('every T2 and T3 path in test-tiers.json exists (a rename would silently skip a tier)', () => {
  const tiers = readTiers();
  for (const [tier, t] of Object.entries(tiers)) {
    for (const p of t.paths ?? []) {
      const full = path.join(root, p);
      const dir = path.dirname(full), base = path.basename(full);
      const exists = fs.existsSync(full) || (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith(base)));
      assert.ok(exists, `${tier} path ${p} matches nothing`);
    }
  }
});

check('timings: reads seconds per file from coloured reporter lines; paths are made repository-relative', () => {
  const log = 'job\tstep\t2026-11-04T03:37:33Z \x1b[32m✓\x1b[39m packages/core/src/a.test.ts \x1b[2m(\x1b[22m\x1b[2m52 tests\x1b[22m\x1b[2m)\x1b[22m\x1b[33m 38630\x1b[2mms\x1b[22m\x1b[39m\n'
    + ' ✓ apps/web/test/b.test.ts (1 test) 5ms\n   ✓ a nested test name 2052ms\n ❯ apps/worker/src/c.test.ts (3 tests | 1 failed) 1200ms\n';
  assert.deepEqual(parseLog(log), {'packages/core/src/a.test.ts': 38.6, 'apps/web/test/b.test.ts': 0, 'apps/worker/src/c.test.ts': 1.2});
  // `gh run view --log` prints each escape as the two characters ^[ rather than the ESC byte.
  const ghLog = 'unit tests (shard 6/6)\tUNKNOWN STEP\t2026-11-04T12:05:30Z  ^[[32m✓^[[39m packages/core/src/d.test.ts ^[[2m(^[[22m^[[2m14 tests^[[22m^[[2m)^[[22m^[[33m 1349^[[2mms^[[22m^[[39m\n';
  assert.deepEqual(parseLog(ghLog), {'packages/core/src/d.test.ts': 1.3});
  assert.equal(normalise('C:\\repo\\packages\\x.test.ts', 'C:\\repo'), 'packages/x.test.ts');
  assert.equal(normalise('/home/runner/work/r/r/apps/y.test.ts', '/home/runner/work/r/r'), 'apps/y.test.ts');
  assert.equal(normalise('apps/y.test.ts', '/home/runner/work/r/r'), 'apps/y.test.ts');
});

check('T0 lints scripts and source, and asks vitest for the tests related to source under apps and packages', () => {
  const picked = selectFiles(['apps/web/lib/a.ts', 'packages/core/src/b.test.ts', 'docs/c.md', 'infra/d.sh', '.github/ci/e.mjs']);
  assert.deepEqual(picked.lint, ['apps/web/lib/a.ts', 'packages/core/src/b.test.ts', '.github/ci/e.mjs']);
  assert.deepEqual(picked.related, ['apps/web/lib/a.ts', 'packages/core/src/b.test.ts']);
  assert.match(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), /"t0": "node \.github\/ci\/t0\.mjs"/);
});

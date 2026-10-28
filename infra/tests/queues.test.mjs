// Run with node infra/tests/queues.test.mjs. Offline: gcloud is a fake bash function, no GCP call.
// The Cloud Tasks queues of a deploy (infra/lib/queues.sh), with the shape of infra/lib/shape.sh:
// - a deploy with no env sets every queue to today's live slots (catalog 8, catalog-bulk 36, catalog-ingest 4) and
//   never issues a queue update below them (2026-10-28: such a run cut catalog-bulk 36 -> 1 before its first gate);
// - before the services only missing queues are created; existing queues change only after the worker gate;
// - spec 17 G4: every create and update of the main and bulk queues carries the chunk retry, the ingest queue keeps
//   5 attempts, and bootstrap.sh creates the main queue with the same retry;
// - spec 16 3.2.3: a bulk queue left from a bigger shape keeps 1 slot; the preview stack gets no bulk queue.
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-queues-'));
const RETRY = '--max-attempts=-1 --max-retry-duration=1800s --min-backoff=10s --max-backoff=60s --max-doublings=3';
const INGEST_RETRY = '--max-attempts=5 --min-backoff=10s';
// The shape names a caller's shell could carry into the run; each run starts without them.
const SHAPE_ENV = ['TASKS_MAX_DISPATCHES', 'BULK_MAX_DISPATCHES', 'INGEST_MAX_DISPATCHES', 'WORKER_MAX_INSTANCES', 'CATALOG_PREVIEW'];

// Sources the shape and the queue lib as deploy.sh does, with `existing` as the queues of the region, runs `steps`
// and returns the queue create and update calls in order.
function run(steps, {existing, queue = 'catalog', env = {}}) {
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  const script = `set -euo pipefail
gcloud() { echo "$*" >> "$LOG"; case "$*" in "tasks queues list"*) printf '%s\\n' ${existing.join(' ')};; esac; }
gcv() { gcloud "$@" | tr -d '\\r'; }
source infra/lib/shape.sh
shape_defaults
REGION=asia-south1 QUEUE=${queue} BULK_QUEUE=${queue}-bulk
source infra/lib/queues.sh
${steps}`;
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SHAPE_ENV.includes(k)));
  const r = spawnSync(bash, ['-c', script], {cwd: root, env: {...clean, LOG: log, ...env}, encoding: 'utf8', timeout: 60000});
  if (r.error) throw r.error;
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter((l) => /^tasks queues (create|update)/.test(l));
}
const update = (name, slots, retry = RETRY) => `tasks queues update ${name} --location=asia-south1 --max-concurrent-dispatches=${slots} ${retry}`;
const create = (name, slots, retry = RETRY) => `tasks queues create ${name} --location=asia-south1 --max-concurrent-dispatches=${slots} ${retry}`;
const LIVE_QUEUES = ['catalog', 'catalog-bulk', 'catalog-ingest', 'catalog-preview', 'catalog-preview-ingest', 'generation'];

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('no env: nothing changes before the services; after the worker gate every queue gets its live slots', () => {
  assert.deepEqual(run('queues_create_missing', {existing: LIVE_QUEUES}), []);
  assert.deepEqual(run('queues_apply_shape', {existing: LIVE_QUEUES}), [
    update('catalog', 8), update('catalog-ingest', 4, INGEST_RETRY), update('catalog-bulk', 36),
  ]);
});

test('no env: a queue update is never below the shape value', () => {
  const calls = run('queues_create_missing; queues_apply_shape', {existing: LIVE_QUEUES});
  const live = {'catalog': 8, 'catalog-bulk': 36, 'catalog-ingest': 4};
  for (const c of calls) {
    const [, name, slots] = /^tasks queues update (\S+) .*--max-concurrent-dispatches=(\d+)/.exec(c);
    assert.ok(Number(slots) >= live[name], `${name} lowered to ${slots}, below its shape value ${live[name]}`);
  }
});

test('a fresh stack: the missing queues are created at their shape slots with their retry', () => {
  assert.deepEqual(run('queues_create_missing', {existing: ['generation']}), [
    create('catalog', 8), create('catalog-ingest', 4, INGEST_RETRY), create('catalog-bulk', 36),
  ]);
});

test('a smaller shape lowers queues only after the worker gate; a left bulk queue keeps 1 slot', () => {
  const env = {WORKER_MAX_INSTANCES: '4', TASKS_MAX_DISPATCHES: '6', BULK_MAX_DISPATCHES: '0', INGEST_MAX_DISPATCHES: '2'};
  assert.deepEqual(run('queues_create_missing', {existing: LIVE_QUEUES, env}), []);
  assert.deepEqual(run('queues_apply_shape', {existing: LIVE_QUEUES, env}), [
    update('catalog', 6), update('catalog-ingest', 2, INGEST_RETRY), update('catalog-bulk', 1),
  ]);
  // Without a bulk queue and without bulk slots, none is created or changed.
  assert.deepEqual(run('queues_create_missing; queues_apply_shape', {existing: ['catalog', 'catalog-ingest'], env}), [
    update('catalog', 6), update('catalog-ingest', 2, INGEST_RETRY),
  ]);
});

test('preview: its own queues at the preview slots, and no bulk queue', () => {
  const calls = run('queues_create_missing; queues_apply_shape', {existing: ['catalog', 'catalog-bulk', 'catalog-ingest'], queue: 'catalog-preview', env: {CATALOG_PREVIEW: '1'}});
  assert.deepEqual(calls, [
    create('catalog-preview', 6), create('catalog-preview-ingest', 2, INGEST_RETRY),
    update('catalog-preview', 6), update('catalog-preview-ingest', 2, INGEST_RETRY),
  ]);
});

test('deploy.sh: every queue change goes through the lib, created before the services, applied after the worker gate', () => {
  const deploy = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8').split(/\r?\n/);
  const code = deploy.filter((l) => !l.trim().startsWith('#'));
  assert.ok(!code.some((l) => /tasks queues (create|update)/.test(l)), 'no queue create or update outside infra/lib/queues.sh');
  const created = deploy.findIndex((l) => l.trim() === 'queues_create_missing');
  const loop = deploy.findIndex((l) => l.startsWith('for SERVICE in "${SERVICES[@]}"'));
  const worker = deploy.findIndex((l, i) => i > loop && l.trim() === 'catalog-worker)');
  const workerEnd = deploy.findIndex((l, i) => i > worker && l.trim() === ';;');
  const applied = deploy.map((l, i) => (l.trim() === 'queues_apply_shape' ? i : -1)).filter((i) => i >= 0);
  assert.ok(created > 0 && created < loop, 'missing queues are created before the services loop');
  assert.deepEqual(applied.length, 1, 'queues_apply_shape is called once');
  assert.ok(applied[0] > worker && applied[0] < workerEnd, 'queues_apply_shape runs only once the worker gate passed');
});

test('bootstrap.sh creates the main queue with the chunk retry', () => {
  const text = fs.readFileSync(path.join(root, 'infra/bootstrap.sh'), 'utf8');
  assert.match(text, new RegExp(`gcloud tasks queues create "\\$QUEUE"[^\\n]*\\\\\\r?\\n[^\\n]*--max-concurrent-dispatches=20 ${RETRY.replace(/[-=]/g, (c) => `\\${c}`)} >/dev/null`));
});

try {
  for (const [name, fn] of tests) {
    fn();
    console.log(`PASS ${name}`);
  }
  console.log(`queues: ${tests.length} cases passed`);
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}

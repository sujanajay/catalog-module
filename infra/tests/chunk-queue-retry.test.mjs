// Run with node infra/tests/chunk-queue-retry.test.mjs. No GCP call: gcloud is a fake bash function.
// Spec 17 G4: a chunk queue (main and bulk) never drops a task after a short run of 429s. deploy.sh gives every
// create and update of the main and bulk queues CHUNK_QUEUE_RETRY (unlimited attempts for 30 minutes, back-off
// 10 s doubling to at most 60 s); the ingest queue keeps its 5 attempts; bootstrap.sh creates the main queue the
// same way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import {spawnSync} from 'node:child_process';
import {gitBashPath} from '../../packages/core/src/git-bash.ts';

const infra = path.resolve(import.meta.dirname, '..');
const bash = process.env.CATALOG_BASH || gitBashPath();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-queue-retry-'));
const lines = (file) => fs.readFileSync(path.join(infra, file), 'utf8').split(/\r?\n/);
const RETRY = '--max-attempts=-1 --max-retry-duration=1800s --min-backoff=10s --max-backoff=60s --max-doublings=3';

let cases = 0;
try {
  const deploy = lines('deploy.sh');
  // 1. The queue block, from ENSURE_QUEUES= to the end of the check-then-create loop, with a fake gcloud.
  {
    const start = deploy.findIndex((l) => l.startsWith('ENSURE_QUEUES='));
    const loop = deploy.findIndex((l) => l.startsWith('for Q in $ENSURE_QUEUES'));
    const end = deploy.findIndex((l, i) => i > loop && l === 'done');
    assert.ok(start >= 0 && loop > start && end > loop, 'queue block not found in deploy.sh');
    const log = path.join(dir, 'calls.log');
    const run = (existing) => {
      fs.writeFileSync(log, '');
      const fake = `gcloud() { echo "$*" >> "$LOG"; case "$*" in "tasks queues list"*) printf '%s\\n' ${existing};; "tasks queues describe"*) echo 40;; esac; }\ngcv() { gcloud "$@" | tr -d '\\r'; }`;
      const script = `set -euo pipefail\n${fake}\n${deploy.slice(start, end + 1).join('\n')}`;
      const env = {...process.env, LOG: log, QUEUE: 'catalog-preview', CATALOG_PREVIEW: '1', INGEST_MAX_DISPATCHES: '2', TASKS_MAX_DISPATCHES: '8',
        BULK_QUEUE: 'catalog-preview-bulk', BULK_MAX_DISPATCHES: '36', REGION: 'asia-south1'};
      const r = spawnSync(bash, ['-c', script], {env, encoding: 'utf8', timeout: 60000});
      if (r.error) throw r.error;
      assert.equal(r.status, 0, r.stderr);
      return fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('tasks queues create') || l.startsWith('tasks queues update'));
    };
    // New queues: main and bulk are created with the chunk retry, the ingest queue with 5 attempts.
    const created = run('catalog-preview-ingest');
    assert.deepEqual(created, [
      `tasks queues create catalog-preview --location=asia-south1 --max-concurrent-dispatches=8 ${RETRY}`,
      `tasks queues update catalog-preview-ingest --location=asia-south1 --max-concurrent-dispatches=2 --max-attempts=5 --min-backoff=10s`,
      `tasks queues create catalog-preview-bulk --location=asia-south1 --max-concurrent-dispatches=36 ${RETRY}`,
    ]);
    cases++;
    // Existing queues: the update applies the retry too (an existing live queue gets it on the next deploy).
    const updated = run('catalog-preview catalog-preview-ingest catalog-preview-bulk');
    assert.deepEqual(updated, [
      `tasks queues update catalog-preview-bulk --location=asia-south1 --max-concurrent-dispatches=36 ${RETRY}`,
      `tasks queues update catalog-preview --location=asia-south1 --max-concurrent-dispatches=8 ${RETRY}`,
      `tasks queues update catalog-preview-ingest --location=asia-south1 --max-concurrent-dispatches=2 --max-attempts=5 --min-backoff=10s`,
    ]);
    cases++;
  }
  // 2. Every other create or update of the main or bulk queue in deploy.sh carries the retry.
  {
    const queueCalls = deploy.filter((l) => /gcloud tasks queues (create|update) "\$(QUEUE|BULK_QUEUE)"/.test(l));
    assert.ok(queueCalls.length >= 3, 'main and bulk queue updates not found');
    for (const l of queueCalls) assert.match(l, /"\$\{CHUNK_QUEUE_RETRY\[@\]\}"/, `no retry config: ${l.trim()}`);
    cases++;
  }
  // 3. bootstrap.sh creates the main queue with the same retry.
  {
    const text = lines('bootstrap.sh').join('\n');
    assert.match(text, new RegExp(`gcloud tasks queues create "\\$QUEUE"[^\\n]*\\\\\\n[^\\n]*--max-concurrent-dispatches=20 ${RETRY.replace(/[-=]/g, (c) => `\\${c}`)} >/dev/null`));
    cases++;
  }
  console.log(`chunk-queue-retry: ${cases} cases passed`);
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}

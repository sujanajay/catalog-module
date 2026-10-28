// Run with node infra/tests/shape.test.mjs. Offline: no gcloud, no provider calls.
// Spec 16 3.2: infra/lib/shape.sh gives today's shape by default, accepts the F2 run values, and refuses a shape
// that does not fit (connection budget, what ila-pg allows now, queue slots, the asia-south1 CPU quota, the L4
// quota and shape). Also checks the price defaults deploy.sh derives from the shape. Spec 17 3.3.3: GPU memory
// arithmetic from the measured peak table (F2 refused once bria-rmbg's peak is in it, today's live shape passes,
// an unmeasured model refused).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import {spawnSync} from 'node:child_process';
import {gitBashPath} from '../../packages/core/src/git-bash.ts';

const root = path.resolve(import.meta.dirname, '../..');
const bash = process.env.CATALOG_BASH || gitBashPath();
const NAMES = ['DB_MAX_CONNECTIONS', 'WORKER_MAX_INSTANCES', 'WORKER_CPU', 'WORKER_MEMORY', 'WORKER_CONCURRENCY',
  'WORKER_DB_POOL_MAX', 'TASKS_MAX_DISPATCHES', 'BULK_MAX_DISPATCHES', 'INGEST_MAX_DISPATCHES',
  'MATTING_CPU_MAX_INSTANCES', 'GPU_MAX_INSTANCES', 'GPU_CPU', 'GPU_MEMORY', 'GPU_CONCURRENCY', 'MAX_RESIDENT_SESSIONS',
  'GPU_MEM_LIMIT_BYTES', 'UPSCALE_SERVICE', 'MATTE_INFLIGHT_PER_INSTANCE', 'CATALOG_PHOTO_CONCURRENCY',
  'CATALOG_BULK_WINDOW', 'BULK_BATCH_PRODUCTS', 'LLM_INFLIGHT_PER_INSTANCE', 'CUDNN_CONV_ALGO_SEARCH', 'CUDNN_CONV_USE_MAX_WORKSPACE',
  'INFERENCE_LOCK_SCOPE', 'GPU_MATTE_MODELS', 'GPU_UPSCALE_MODELS', 'GPU_MEASURED_ON', 'GPU_CUDA_OVERHEAD_MIB'];
const OUT = [...NAMES, 'CATALOG_DB_TOTAL', 'CATALOG_DB_LIMIT', 'SLOTS_TOTAL', 'SLOTS_CAPACITY', 'CPU_TOTAL'];

// The usd() helper and the two price defaults, taken from deploy.sh so the test follows the script.
const deploy = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8').split(/\r?\n/);
const pick = (prefix) => {
  const line = deploy.find((l) => l.startsWith(prefix));
  assert.ok(line, `${prefix} not found in deploy.sh`);
  return line;
};
const prices = [pick('usd() {'), pick('if [ -z "${COMPUTE_USD_PER_VCPU_SECOND:-}"'), pick('COMPUTE_USD_PER_VCPU_SECOND=${COMPUTE_USD_PER_VCPU_SECOND:-'),
  pick('if [ -z "${PRICE_MATTE_GPU_USD_PER_SECOND:-}"'), pick('PRICE_MATTE_GPU_USD_PER_SECOND=${PRICE_MATTE_GPU_USD_PER_SECOND:-')].join('\n');

function run(env, live = '25') {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !NAMES.includes(k) && !k.startsWith('GPU_MODEL_PEAK_MIB_') && !k.startsWith('COMPUTE_USD') && !k.startsWith('PRICE_MATTE')));
  const script = `set -euo pipefail
source infra/lib/shape.sh
shape_defaults
status=0
shape_check "${live}" || status=$?
${prices}
${OUT.map((n) => `echo "${n}=\${${n}:-}"`).join('\n')}
echo "COMPUTE=$COMPUTE_USD_PER_VCPU_SECOND"
echo "GPU_PRICE=$PRICE_MATTE_GPU_USD_PER_SECOND"
echo "STATUS=$status"`;
  const r = spawnSync(bash, ['-c', script], {cwd: root, env: {...clean, ...env}, encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  const vars = Object.fromEntries(r.stdout.trim().split(/\r?\n/).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return {vars, stderr: r.stderr};
}

const F2 = {
  WORKER_MAX_INSTANCES: '24', WORKER_CPU: '4', WORKER_MEMORY: '4Gi', TASKS_MAX_DISPATCHES: '8', BULK_MAX_DISPATCHES: '36',
  INGEST_MAX_DISPATCHES: '4', DB_MAX_CONNECTIONS: '400', MATTING_CPU_MAX_INSTANCES: '16', GPU_CPU: '8', GPU_MEMORY: '32Gi',
  GPU_CONCURRENCY: '2', MAX_RESIDENT_SESSIONS: '3', GPU_MEM_LIMIT_BYTES: '6442450944', UPSCALE_SERVICE: 'cpu',
  CATALOG_PHOTO_CONCURRENCY: '4', CATALOG_BULK_WINDOW: '30',
};

// Test fixtures, not measurements: peaks in MiB as the probe table would give them.
const FITS_6GIB = {GPU_MEASURED_ON: '2026-10-29', GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL: '4600', GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL_LITE: '3000',
  GPU_MODEL_PEAK_MIB_BIREFNET_HRSOD: '4700', GPU_MODEL_PEAK_MIB_BRIA_RMBG: '5400'};
const BRIA_OVER_6GIB = {...FITS_6GIB, GPU_MODEL_PEAK_MIB_BRIA_RMBG: '7400'};
// Four resident take 4 x the largest peak, so this table fits four on one L4 (4 x 4500 + 2048 = 20048 MiB).
const FITS_FOUR = {...FITS_6GIB, GPU_MODEL_PEAK_MIB_BIREFNET_HRSOD: '4500', GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL: '4500', GPU_MODEL_PEAK_MIB_BRIA_RMBG: '4500'};
// F2 worker and queues with a GPU part that fits the measured table: all four resident, no cap.
const F2_FITTED = {...F2, ...FITS_FOUR, MAX_RESIDENT_SESSIONS: '4', GPU_MEM_LIMIT_BYTES: ''};
// Today's live shape (spec 17 section 8): spec 16's F2 for worker and queues, the pre-F2 GPU (4 vCPU, 16Gi,
// concurrency 1, 1 resident, no cap).
const LIVE = {...F2, GPU_CPU: '4', GPU_MEMORY: '16Gi', GPU_CONCURRENCY: '1', MAX_RESIDENT_SESSIONS: '1', GPU_MEM_LIMIT_BYTES: ''};

const cases = [
  {
    label: 'defaults are today',
    env: {},
    expect: {STATUS: '0', WORKER_MAX_INSTANCES: '4', WORKER_CPU: '2', WORKER_MEMORY: '2Gi', WORKER_CONCURRENCY: '2',
      TASKS_MAX_DISPATCHES: '6', BULK_MAX_DISPATCHES: '0', INGEST_MAX_DISPATCHES: '2', MATTING_CPU_MAX_INSTANCES: '20',
      GPU_MAX_INSTANCES: '3', GPU_CPU: '4', GPU_MEMORY: '16Gi', GPU_CONCURRENCY: '1', MAX_RESIDENT_SESSIONS: '1',
      GPU_MEM_LIMIT_BYTES: '', UPSCALE_SERVICE: 'gpu', WORKER_DB_POOL_MAX: '2', LLM_INFLIGHT_PER_INSTANCE: '', CATALOG_DB_TOTAL: '16', CATALOG_DB_LIMIT: '18', CPU_TOTAL: '99',
      COMPUTE: '0.0000265', GPU_PRICE: '0.00034884'},
  },
  {
    label: 'F2 run values fit on db-custom-2-7680 (GPU part fitted to the measured table)',
    env: F2_FITTED, live: '400',
    expect: {STATUS: '0', WORKER_DB_POOL_MAX: '4', CATALOG_DB_TOTAL: '104', CATALOG_DB_LIMIT: '393', SLOTS_TOTAL: '48', SLOTS_CAPACITY: '48',
      CPU_TOTAL: '171', COMPUTE: '0.0000265', GPU_PRICE: '0.00047364'},
  },
  {label: 'F2 budget before the tier change', env: F2, live: '25', expect: {STATUS: '1'}, error: /ila-pg allows 25 now/},
  {label: 'connection budget', env: {WORKER_MAX_INSTANCES: '10', TASKS_MAX_DISPATCHES: '6'}, expect: {STATUS: '1'}, error: /catalog connections 28 exceed the budget 18/},
  {label: 'slots', env: {TASKS_MAX_DISPATCHES: '8'}, expect: {STATUS: '1'}, error: /queue slots 8 \+ 0 \+ 2 = 10 exceed/},
  {label: 'cpu quota', env: {...F2_FITTED, WORKER_MAX_INSTANCES: '30', TASKS_MAX_DISPATCHES: '20'}, live: '400', expect: {STATUS: '1'}, error: /vCPU at max instances 195 exceeds 190/},
  {label: 'gpu quota', env: {GPU_MAX_INSTANCES: '4'}, expect: {STATUS: '1'}, error: /exceeds the L4 quota of 3/},
  {label: 'gpu shape', env: {GPU_CPU: '2', GPU_MEMORY: '64Gi'}, expect: {STATUS: '1'}, error: /GPU_CPU must be 4 to 8[\s\S]*GPU_MEMORY must be 16Gi to 32Gi/},
  {label: 'not a number', env: {WORKER_MAX_INSTANCES: 'many'}, expect: {STATUS: '1'}, error: /WORKER_MAX_INSTANCES must be a whole number/},
  {label: 'upscale service', env: {UPSCALE_SERVICE: 'tpu'}, expect: {STATUS: '1'}, error: /UPSCALE_SERVICE must be gpu or cpu/},
  // Spec 16 F3: photos at once double the worker pool, which today's db-f1-micro cannot hold.
  {label: 'photos at once before the tier change', env: {CATALOG_PHOTO_CONCURRENCY: '4'}, expect: {STATUS: '1', WORKER_DB_POOL_MAX: '4'}, error: /catalog connections 24 exceed the budget 18/},
  {label: 'explicit worker pool wins', env: {...F2_FITTED, WORKER_DB_POOL_MAX: '3'}, live: '400', expect: {STATUS: '0', WORKER_DB_POOL_MAX: '3', CATALOG_DB_TOTAL: '80'}},
  {label: 'AI check pacing', env: {LLM_INFLIGHT_PER_INSTANCE: 'six'}, expect: {STATUS: '1'}, error: /LLM_INFLIGHT_PER_INSTANCE must be empty or a whole number/},
  // Spec 17 3.3.3.
  {label: "today's live shape passes with no peak measured", env: LIVE, live: '400', expect: {STATUS: '0', INFERENCE_LOCK_SCOPE: 'global', GPU_CUDA_OVERHEAD_MIB: '2048'}},
  {label: 'the 2026-10-27 F2 shape is refused once the bria-rmbg peak is in the table', env: {...F2, ...BRIA_OVER_6GIB}, live: '400', expect: {STATUS: '1'},
    error: /GPU_MEM_LIMIT_BYTES=6442450944 \(6144 MiB\) is below bria-rmbg's measured peak 7400 MiB \+ 512 MiB \(measured 2026-10-29\)/},
  {label: 'F2 with an unmeasured model is refused', env: {...F2, ...FITS_6GIB, GPU_MODEL_PEAK_MIB_BIREFNET_HRSOD: ''}, live: '400', expect: {STATUS: '1'},
    error: /^ERROR: measure first: run infra\/check-matting.sh --probe \(no measured GPU peak for birefnet-hrsod;/},
  {label: 'nothing measured: two resident is refused', env: {MAX_RESIDENT_SESSIONS: '2', UPSCALE_SERVICE: 'cpu'}, expect: {STATUS: '1'},
    error: /measure first: run infra\/check-matting.sh --probe \(no measured GPU peak for birefnet-general birefnet-general-lite birefnet-hrsod bria-rmbg;/},
  {label: 'nothing measured: a cap alone is refused', env: {GPU_MEM_LIMIT_BYTES: '6442450944', UPSCALE_SERVICE: 'cpu'}, expect: {STATUS: '1'}, error: /measure first/},
  {label: 'nothing measured: the session lock is refused', env: {INFERENCE_LOCK_SCOPE: 'session', UPSCALE_SERVICE: 'cpu'}, expect: {STATUS: '1'}, error: /measure first/},
  {label: 'only the served models need a peak', env: {...LIVE, MAX_RESIDENT_SESSIONS: '2', GPU_MATTE_MODELS: 'bria-rmbg', GPU_MEASURED_ON: '2026-10-29', GPU_MODEL_PEAK_MIB_BRIA_RMBG: '7400'}, live: '400', expect: {STATUS: '0'}},
  {label: 'upscalers on the GPU need their peaks too', env: {...LIVE, ...FITS_6GIB, MAX_RESIDENT_SESSIONS: '2', UPSCALE_SERVICE: 'gpu'}, live: '400', expect: {STATUS: '1'},
    error: /no measured GPU peak for realesrgan-x2plus swinir-x2;/},
  {label: 'four resident fit with measured peaks and no cap', env: {...LIVE, ...FITS_FOUR, MAX_RESIDENT_SESSIONS: '4'}, live: '400', expect: {STATUS: '0'}},
  {label: 'four resident at bria-rmbg size do not fit', env: {...LIVE, ...BRIA_OVER_6GIB, MAX_RESIDENT_SESSIONS: '4', UPSCALE_SERVICE: 'gpu', GPU_MODEL_PEAK_MIB_REALESRGAN_X2PLUS: '2000', GPU_MODEL_PEAK_MIB_SWINIR_X2: '1500'}, live: '400', expect: {STATUS: '1'},
    error: /GPU memory 4 sessions x 7400 MiB \+ 2048 MiB CUDA \+ 3500 MiB upscalers = 35148 MiB exceeds the L4's 22528 MiB/},
  {label: 'F2 with peaks under the cap still does not fit: 3 resident + 1 evicted mid-run x 6 GiB', env: {...F2, ...FITS_6GIB}, live: '400', expect: {STATUS: '1'},
    error: /GPU memory 4 sessions x 6144 MiB \+ 2048 MiB CUDA \+ 0 MiB upscalers = 26624 MiB exceeds/},
  {label: 'one request at a time: no evicted session in flight', env: {...LIVE, ...FITS_6GIB, MAX_RESIDENT_SESSIONS: '3', GPU_MEM_LIMIT_BYTES: '6442450944'}, live: '400', expect: {STATUS: '0'}},
  {label: 'peaks without a probe date are refused', env: {...LIVE, ...FITS_6GIB, GPU_MEASURED_ON: '', MAX_RESIDENT_SESSIONS: '2'}, live: '400', expect: {STATUS: '1'}, error: /GPU_MEASURED_ON must be the date/},
  {label: 'session lock: concurrency at most the resident models', env: {...LIVE, ...FITS_6GIB, MAX_RESIDENT_SESSIONS: '2', INFERENCE_LOCK_SCOPE: 'session', GPU_CONCURRENCY: '3'}, live: '400', expect: {STATUS: '1'},
    error: /GPU_CONCURRENCY=3 exceeds MAX_RESIDENT_SESSIONS=2 with INFERENCE_LOCK_SCOPE=session/},
  {label: 'session lock rung 5 fits', env: {...LIVE, ...FITS_FOUR, MAX_RESIDENT_SESSIONS: '4', INFERENCE_LOCK_SCOPE: 'session', GPU_CONCURRENCY: '2', CUDNN_CONV_ALGO_SEARCH: 'HEURISTIC', CUDNN_CONV_USE_MAX_WORKSPACE: '0'}, live: '400', expect: {STATUS: '0'}},
  {label: 'knob values', env: {INFERENCE_LOCK_SCOPE: 'model', CUDNN_CONV_ALGO_SEARCH: 'FAST', CUDNN_CONV_USE_MAX_WORKSPACE: '2'}, expect: {STATUS: '1'},
    error: /INFERENCE_LOCK_SCOPE must be global or session[\s\S]*CUDNN_CONV_ALGO_SEARCH must be[\s\S]*CUDNN_CONV_USE_MAX_WORKSPACE must be/},
];

for (const c of cases) {
  const {vars, stderr} = run(c.env, c.live);
  for (const [k, v] of Object.entries(c.expect)) assert.equal(vars[k], v, `${c.label}: ${k} (stderr: ${stderr})`);
  if (c.error) assert.match(stderr, c.error, c.label);
  else assert.equal(stderr, '', `${c.label}: no error expected`);
  console.log(`PASS ${c.label}`);
}

// The tier table (Cloud SQL flags doc, read 2026-10-27).
const tiers = {'db-f1-micro': '25', 'db-g1-small': '50', 'db-custom-1-3840': '100', 'db-custom-2-7680': '400', 'db-custom-4-15360': '500', 'nonsense': ''};
const t = spawnSync(bash, ['-c', `source infra/lib/shape.sh; for t in ${Object.keys(tiers).join(' ')}; do echo "$t=$(tier_max_connections $t)"; done`], {cwd: root, encoding: 'utf8'});
assert.equal(t.status, 0, t.stderr);
for (const line of t.stdout.trim().split(/\r?\n/)) {
  const [tier, n] = line.split('=');
  assert.equal(n, tiers[tier], tier);
}
console.log('PASS tier table');
console.log(`${cases.length + 1} offline shape cases passed`);

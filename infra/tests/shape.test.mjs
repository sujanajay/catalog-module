// Run with node infra/tests/shape.test.mjs. Offline: no gcloud, no provider calls.
// Spec 16 3.2: infra/lib/shape.sh gives today's live shape by default (the preview a smaller worker), env still
// wins, it accepts the F2 run values and the pre-F2 rollback shape, and refuses a shape
// that does not fit (connection budget, what ila-pg allows now, queue slots, the asia-south1 CPU quota, the L4
// quota and shape). Also checks the price defaults deploy.sh derives from the shape. Spec 17 3.3.3: GPU memory
// arithmetic from the measured peak table (the peaks measured on the L4 on 2026-10-28 are the defaults: the F2 shape
// and two or four resident models are refused, today's live shape passes, an unmeasured model is refused).
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
  'INFERENCE_LOCK_SCOPE', 'GPU_MATTE_MODELS', 'GPU_UPSCALE_MODELS', 'GPU_MEASURED_ON', 'GPU_CUDA_OVERHEAD_MIB',
  'UPSCALE_CPU_VCPU', 'UPSCALE_MEMORY', 'UPSCALE_CONCURRENCY', 'UPSCALE_MAX_INSTANCES', 'UPSCALE_THREADS', 'UPSCALE_TIMEOUT_S',
  'ENLARGE_MAX_DISPATCHES', 'ENLARGE_BULK_MAX_DISPATCHES', 'ENLARGE_DISPATCHES_PER_SECOND'];
const PEAKS = ['GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL', 'GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL_LITE', 'GPU_MODEL_PEAK_MIB_BIREFNET_HRSOD', 'GPU_MODEL_PEAK_MIB_BRIA_RMBG'];
const OUT = [...NAMES, ...PEAKS, 'UPSCALE_MEASURE', 'UPSCALE_MEASURED_ON', 'UPSCALE_VCPU_TOTAL', 'CATALOG_DB_TOTAL', 'CATALOG_DB_LIMIT', 'SLOTS_TOTAL', 'SLOTS_CAPACITY', 'CPU_TOTAL'];

// The usd() helper and the two price defaults, taken from deploy.sh so the test follows the script.
const deploy = fs.readFileSync(path.join(root, 'infra/deploy.sh'), 'utf8').split(/\r?\n/);
const pick = (prefix) => {
  const line = deploy.find((l) => l.startsWith(prefix));
  assert.ok(line, `${prefix} not found in deploy.sh`);
  return line;
};
const prices = [pick('usd() {'), pick('if [ -z "${COMPUTE_USD_PER_VCPU_SECOND:-}"'), pick('COMPUTE_USD_PER_VCPU_SECOND=${COMPUTE_USD_PER_VCPU_SECOND:-'),
  pick('if [ -z "${PRICE_MATTE_GPU_USD_PER_SECOND:-}"'), pick('PRICE_MATTE_GPU_USD_PER_SECOND=${PRICE_MATTE_GPU_USD_PER_SECOND:-')].join('\n');

function run(env, live = '400') {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !NAMES.includes(k) && k !== 'CATALOG_PREVIEW' && !k.startsWith('GPU_MODEL_PEAK_MIB_') && !k.startsWith('UPSCALE_') && !k.startsWith('COMPUTE_USD') && !k.startsWith('PRICE_MATTE')));
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

// Spec 16's F2 and the shapes before spec 18 had concurrency 2 and no enlarge lanes.
const NO_ENLARGE = {WORKER_CONCURRENCY: '2', ENLARGE_MAX_DISPATCHES: '0', ENLARGE_BULK_MAX_DISPATCHES: '0'};
const F2 = {
  ...NO_ENLARGE,
  WORKER_MAX_INSTANCES: '24', WORKER_CPU: '4', WORKER_MEMORY: '4Gi', TASKS_MAX_DISPATCHES: '8', BULK_MAX_DISPATCHES: '36',
  INGEST_MAX_DISPATCHES: '4', DB_MAX_CONNECTIONS: '400', MATTING_CPU_MAX_INSTANCES: '16', GPU_CPU: '8', GPU_MEMORY: '32Gi',
  GPU_CONCURRENCY: '2', MAX_RESIDENT_SESSIONS: '3', GPU_MEM_LIMIT_BYTES: '6442450944', UPSCALE_SERVICE: 'cpu',
  CATALOG_PHOTO_CONCURRENCY: '4', CATALOG_BULK_WINDOW: '30',
};

// The peaks measured on the L4 on 2026-10-28 (services/matting/README.md "Measured on L4"), shape.sh's defaults.
const MEASURED = {GPU_MEASURED_ON: '2026-10-28', GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL: '13704', GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL_LITE: '10842',
  GPU_MODEL_PEAK_MIB_BIREFNET_HRSOD: '13696', GPU_MODEL_PEAK_MIB_BRIA_RMBG: '12424'};
// An empty row marks a model as not measured (a name that is set, also to "", wins over the default).
const UNMEASURED = {GPU_MEASURED_ON: '', GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL: '', GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL_LITE: '',
  GPU_MODEL_PEAK_MIB_BIREFNET_HRSOD: '', GPU_MODEL_PEAK_MIB_BRIA_RMBG: ''};
// Test fixtures, not measurements: smaller peaks than the L4 gave, to test the arithmetic on shapes that fit.
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
// The live production shape as read from the services on 2026-10-28 (deploy run 1, sections 1 and 4: worker
// 24 x 4 vCPU/4Gi concurrency 2 with DB_POOL_MAX=4 and the budget max=400, queues 8 / 36 / 4, CPU matting max 16,
// GPU 3 x 4 vCPU/16Gi concurrency 1 with 1 resident and no cap, upscale on the CPU service) plus spec 16 section 8's
// F2 values for the rest. A deploy with no env must resolve to exactly this.
const RECORDED_LIVE = {
  DB_MAX_CONNECTIONS: '400', WORKER_MAX_INSTANCES: '24', WORKER_CPU: '4', WORKER_MEMORY: '4Gi', WORKER_CONCURRENCY: '3',
  WORKER_DB_POOL_MAX: '6', TASKS_MAX_DISPATCHES: '8', BULK_MAX_DISPATCHES: '36', INGEST_MAX_DISPATCHES: '4',
  MATTING_CPU_MAX_INSTANCES: '16', GPU_MAX_INSTANCES: '3', GPU_CPU: '4', GPU_MEMORY: '16Gi', GPU_CONCURRENCY: '1',
  MAX_RESIDENT_SESSIONS: '1', GPU_MEM_LIMIT_BYTES: '', UPSCALE_SERVICE: 'cpu', MATTE_INFLIGHT_PER_INSTANCE: '4',
  CATALOG_PHOTO_CONCURRENCY: '4', CATALOG_BULK_WINDOW: '30', BULK_BATCH_PRODUCTS: '100', LLM_INFLIGHT_PER_INSTANCE: '6',
  CUDNN_CONV_ALGO_SEARCH: '', CUDNN_CONV_USE_MAX_WORKSPACE: '', INFERENCE_LOCK_SCOPE: 'global',
  GPU_MATTE_MODELS: 'birefnet-general,birefnet-general-lite,birefnet-hrsod,bria-rmbg', GPU_UPSCALE_MODELS: 'realesrgan-x2plus,swinir-x2',
  GPU_MEASURED_ON: '2026-10-28', GPU_CUDA_OVERHEAD_MIB: '2048',
  // Spec 18: catalog-upscale is not deployed yet (UPSCALE_SERVICE=cpu); its rows are the shape the ladder starts from.
  UPSCALE_CPU_VCPU: '4', UPSCALE_MEMORY: '16Gi', UPSCALE_CONCURRENCY: '1', UPSCALE_MAX_INSTANCES: '16', UPSCALE_THREADS: '4', UPSCALE_TIMEOUT_S: '840',
  // Spec 18 3.3.1: the enlarge lanes, and worker concurrency 3 to give them their slots (not live until H3 deploys).
  ENLARGE_MAX_DISPATCHES: '4', ENLARGE_BULK_MAX_DISPATCHES: '12', ENLARGE_DISPATCHES_PER_SECOND: '0.1',
};
// The shape before F2 (the rollback line in shape.sh): fits today's old db-f1-micro (25 connections).
// Spec 18 test fixture, not a measurement: catalog-upscale at 4 vCPU / 4 threads / concurrency 1 with p95 rows.
const DEDICATED = {UPSCALE_SERVICE: 'dedicated', UPSCALE_MEASURED_ON: '2026-10-30', UPSCALE_P95_S_4C_4T_1CONC_800x1200: '130', UPSCALE_P95_S_4C_4T_1CONC_1600x1600: '330'};
const PRE_F2 = {...NO_ENLARGE, WORKER_MAX_INSTANCES: '4', WORKER_CPU: '2', WORKER_MEMORY: '2Gi', TASKS_MAX_DISPATCHES: '6', BULK_MAX_DISPATCHES: '0',
  INGEST_MAX_DISPATCHES: '2', DB_MAX_CONNECTIONS: '25', MATTING_CPU_MAX_INSTANCES: '20', UPSCALE_SERVICE: 'gpu',
  CATALOG_PHOTO_CONCURRENCY: '1', CATALOG_BULK_WINDOW: '8', LLM_INFLIGHT_PER_INSTANCE: ''};

const cases = [
  {
    label: 'no env resolves to the recorded live shape',
    env: {},
    // Every shape name, so a new name without a recorded live value fails here.
    expect: {...Object.fromEntries(NAMES.map((n) => [n, RECORDED_LIVE[n]])), ...MEASURED, STATUS: '0', CATALOG_DB_TOTAL: '152', CATALOG_DB_LIMIT: '393', SLOTS_TOTAL: '64', SLOTS_CAPACITY: '72',
      CPU_TOTAL: '171', COMPUTE: '0.0000265', GPU_PRICE: '0.00034884', UPSCALE_MEASURE: '0', UPSCALE_MEASURED_ON: '', UPSCALE_VCPU_TOTAL: '0'},
  },
  {label: 'env still wins over a row, also an explicit "" (no AI check cap)', env: {TASKS_MAX_DISPATCHES: '14', BULK_MAX_DISPATCHES: '30', LLM_INFLIGHT_PER_INSTANCE: ''},
    expect: {STATUS: '0', TASKS_MAX_DISPATCHES: '14', BULK_MAX_DISPATCHES: '30', INGEST_MAX_DISPATCHES: '4', LLM_INFLIGHT_PER_INSTANCE: ''}},
  {label: 'preview: the same per-instance shape on 4 workers, no bulk queue and no bulk enlarge lane', env: {CATALOG_PREVIEW: '1'},
    expect: {...RECORDED_LIVE, STATUS: '0', WORKER_MAX_INSTANCES: '4', TASKS_MAX_DISPATCHES: '6', BULK_MAX_DISPATCHES: '0', INGEST_MAX_DISPATCHES: '2',
      ENLARGE_MAX_DISPATCHES: '2', ENLARGE_BULK_MAX_DISPATCHES: '0', SLOTS_TOTAL: '10', SLOTS_CAPACITY: '12', CATALOG_DB_TOTAL: '32', CPU_TOTAL: '91'}},
  {label: 'preview rows yield to env', env: {CATALOG_PREVIEW: '1', WORKER_MAX_INSTANCES: '6', TASKS_MAX_DISPATCHES: '10'},
    expect: {STATUS: '0', WORKER_MAX_INSTANCES: '6', TASKS_MAX_DISPATCHES: '10', BULK_MAX_DISPATCHES: '0'}},
  {label: 'the pre-F2 rollback shape fits db-f1-micro', env: PRE_F2, live: '25',
    expect: {STATUS: '0', WORKER_DB_POOL_MAX: '2', CATALOG_DB_TOTAL: '16', CATALOG_DB_LIMIT: '18', CPU_TOTAL: '99', SLOTS_TOTAL: '8', GPU_PRICE: '0.00034884'}},
  {
    label: 'F2 run values fit on db-custom-2-7680 (GPU part fitted to the measured table)',
    env: F2_FITTED, live: '400',
    expect: {STATUS: '0', WORKER_DB_POOL_MAX: '4', CATALOG_DB_TOTAL: '104', CATALOG_DB_LIMIT: '393', SLOTS_TOTAL: '48', SLOTS_CAPACITY: '48',
      CPU_TOTAL: '171', COMPUTE: '0.0000265', GPU_PRICE: '0.00047364'},
  },
  {label: 'the live shape before the tier change', env: {}, live: '25', expect: {STATUS: '1'}, error: /DB_MAX_CONNECTIONS=400 but ila-pg allows 25 now/},
  {label: 'connection budget', env: {...PRE_F2, WORKER_MAX_INSTANCES: '10'}, live: '25', expect: {STATUS: '1'}, error: /catalog connections 28 exceed the budget 18/},
  {label: 'slots', env: {...PRE_F2, TASKS_MAX_DISPATCHES: '8'}, live: '25', expect: {STATUS: '1'}, error: /queue slots 8 \+ 0 \+ 2 \+ enlarge 0 \+ 0 = 10 exceed/},
  {label: 'cpu quota', env: {...F2_FITTED, WORKER_MAX_INSTANCES: '30', TASKS_MAX_DISPATCHES: '20'}, live: '400', expect: {STATUS: '1'}, error: /vCPU at max instances 195 exceeds 190/},
  {label: 'gpu quota', env: {GPU_MAX_INSTANCES: '4'}, expect: {STATUS: '1'}, error: /exceeds the L4 quota of 3/},
  {label: 'gpu shape', env: {GPU_CPU: '2', GPU_MEMORY: '64Gi'}, expect: {STATUS: '1'}, error: /GPU_CPU must be 4 to 8[\s\S]*GPU_MEMORY must be 16Gi to 32Gi/},
  {label: 'not a number', env: {WORKER_MAX_INSTANCES: 'many'}, expect: {STATUS: '1'}, error: /WORKER_MAX_INSTANCES must be a whole number/},
  {label: 'upscale service', env: {UPSCALE_SERVICE: 'tpu'}, expect: {STATUS: '1'}, error: /UPSCALE_SERVICE must be gpu, cpu or dedicated/},
  // Spec 16 F3: photos at once double the worker pool, which today's db-f1-micro cannot hold.
  {label: 'photos at once before the tier change', env: {...PRE_F2, CATALOG_PHOTO_CONCURRENCY: '4'}, live: '25', expect: {STATUS: '1', WORKER_DB_POOL_MAX: '4'}, error: /catalog connections 24 exceed the budget 18/},
  {label: 'explicit worker pool wins', env: {...F2_FITTED, WORKER_DB_POOL_MAX: '3'}, live: '400', expect: {STATUS: '0', WORKER_DB_POOL_MAX: '3', CATALOG_DB_TOTAL: '80'}},
  {label: 'AI check pacing', env: {LLM_INFLIGHT_PER_INSTANCE: 'six'}, expect: {STATUS: '1'}, error: /LLM_INFLIGHT_PER_INSTANCE must be empty or a whole number/},
  // Spec 17 3.3.3.
  {label: "today's live shape passes", env: LIVE, live: '400', expect: {STATUS: '0', INFERENCE_LOCK_SCOPE: 'global', GPU_CUDA_OVERHEAD_MIB: '2048', ...MEASURED}},
  {label: "today's live shape passes with no peak measured", env: {...LIVE, ...UNMEASURED}, live: '400', expect: {STATUS: '0'}},
  {label: 'the 2026-10-27 F2 shape is refused by the measured peaks', env: F2, live: '400', expect: {STATUS: '1', ...MEASURED},
    error: /GPU_MEM_LIMIT_BYTES=6442450944 \(6144 MiB\) is below bria-rmbg's measured peak 12424 MiB \+ 512 MiB \(measured 2026-10-28\)/},
  {label: 'two resident without a cap are refused by the measured peaks (2 x 13704 + 2048)', env: {...LIVE, MAX_RESIDENT_SESSIONS: '2'}, live: '400', expect: {STATUS: '1'},
    error: /GPU memory 2 sessions x 13704 MiB \+ 2048 MiB CUDA \+ 0 MiB upscalers = 29456 MiB exceeds the L4's 22528 MiB/},
  {label: 'four resident are refused by the measured peaks', env: {...LIVE, MAX_RESIDENT_SESSIONS: '4'}, live: '400', expect: {STATUS: '1'},
    error: /GPU memory 4 sessions x 13704 MiB \+ 2048 MiB CUDA \+ 0 MiB upscalers = 56864 MiB exceeds/},
  {label: 'F2 with an unmeasured model is refused', env: {...F2, ...FITS_6GIB, GPU_MODEL_PEAK_MIB_BIREFNET_HRSOD: ''}, live: '400', expect: {STATUS: '1'},
    error: /^ERROR: measure first: run infra\/check-matting.sh --probe \(no measured GPU peak for birefnet-hrsod;/},
  {label: 'nothing measured: two resident is refused', env: {...UNMEASURED, MAX_RESIDENT_SESSIONS: '2', UPSCALE_SERVICE: 'cpu'}, expect: {STATUS: '1'},
    error: /measure first: run infra\/check-matting.sh --probe \(no measured GPU peak for birefnet-general birefnet-general-lite birefnet-hrsod bria-rmbg;/},
  {label: 'nothing measured: a cap alone is refused', env: {...UNMEASURED, GPU_MEM_LIMIT_BYTES: '6442450944', UPSCALE_SERVICE: 'cpu'}, expect: {STATUS: '1'}, error: /measure first/},
  {label: 'nothing measured: the session lock is refused', env: {...UNMEASURED, INFERENCE_LOCK_SCOPE: 'session', UPSCALE_SERVICE: 'cpu'}, expect: {STATUS: '1'}, error: /measure first/},
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
  // Spec 18 H1: catalog-upscale is refused until its shape is measured, and sized by the measurements.
  {label: 'dedicated upscale with nothing measured is refused: measure first', env: {UPSCALE_SERVICE: 'dedicated', MATTING_CPU_MAX_INSTANCES: '4'}, expect: {STATUS: '1'},
    error: /^ERROR: measure first: run infra\/check-matting.sh --probe-upscale \(no measured p95 for UPSCALE_CPU_VCPU=4 UPSCALE_THREADS=4 UPSCALE_CONCURRENCY=1 at 800x1200 1600x1600; UPSCALE_P95_S_\* in infra\/lib\/shape.sh\)\n$/},
  {label: 'dedicated upscale with a measured shape fits beside a smaller CPU cut-out service', env: {...DEDICATED, MATTING_CPU_MAX_INSTANCES: '4'},
    expect: {STATUS: '0', CPU_TOTAL: '187', UPSCALE_VCPU_TOTAL: '64'}},
  {label: 'dedicated upscale 16 x 4 beside catalog-matting 16 x 4 exceeds the CPU quota', env: DEDICATED, expect: {STATUS: '1', CPU_TOTAL: '235'},
    error: /vCPU at max instances 235 exceeds 190 of the 200 vCPU quota \(worker 96 \+ catalog-matting 64 \+ catalog-upscale 64 \+ web and jobs 11\); lower /},
  {label: 'a row for another concurrency does not count', env: {...DEDICATED, MATTING_CPU_MAX_INSTANCES: '4', UPSCALE_CONCURRENCY: '2'}, expect: {STATUS: '1'},
    error: /measure first: run infra\/check-matting.sh --probe-upscale \(no measured p95 for UPSCALE_CPU_VCPU=4 UPSCALE_THREADS=4 UPSCALE_CONCURRENCY=2 at 800x1200 1600x1600;/},
  {label: 'a row for another thread count does not count', env: {...DEDICATED, MATTING_CPU_MAX_INSTANCES: '4', UPSCALE_CPU_VCPU: '8', UPSCALE_MAX_INSTANCES: '8'}, expect: {STATUS: '1'},
    error: /no measured p95 for UPSCALE_CPU_VCPU=8 UPSCALE_THREADS=4 UPSCALE_CONCURRENCY=1/},
  {label: 'the timeout must be at least 2 x the p95 of the largest size', env: {...DEDICATED, MATTING_CPU_MAX_INSTANCES: '4', UPSCALE_TIMEOUT_S: '600'}, expect: {STATUS: '1'},
    error: /UPSCALE_TIMEOUT_S=600 is below 2 x the measured p95 of 1600x1600 \(330 s, measured 2026-10-30\); set it to at least 660/},
  {label: 'a shape too slow for the worker task deadline is refused', env: {...DEDICATED, MATTING_CPU_MAX_INSTANCES: '4', UPSCALE_P95_S_4C_4T_1CONC_1600x1600: '500'}, expect: {STATUS: '1'},
    error: /needs a timeout of 2 x p95 500 s = 1000 s for 1600x1600, over the 840 s the worker's task allows; measure a faster shape or lower UPSCALE_MAX_PIXELS/},
  {label: 'the timeout is at most 840 s', env: {UPSCALE_TIMEOUT_S: '900'}, expect: {STATUS: '1'}, error: /UPSCALE_TIMEOUT_S must be 60 to 840 s \(the worker's task deadline is 900 s/},
  {label: 'measured rows need their probe date', env: {...DEDICATED, MATTING_CPU_MAX_INSTANCES: '4', UPSCALE_MEASURED_ON: ''}, expect: {STATUS: '1'}, error: /UPSCALE_MEASURED_ON must be the date/},
  {label: 'measure mode deploys an unmeasured candidate when it fits the quota', env: {UPSCALE_MEASURE: '1', UPSCALE_CPU_VCPU: '8', UPSCALE_THREADS: '8', UPSCALE_MAX_INSTANCES: '2'},
    expect: {STATUS: '0', UPSCALE_MEASURE: '1', UPSCALE_SERVICE: 'cpu', CPU_TOTAL: '187', UPSCALE_VCPU_TOTAL: '16'}},
  {label: 'measure mode still counts the candidate against the CPU quota', env: {UPSCALE_MEASURE: '1'}, expect: {STATUS: '1', CPU_TOTAL: '235'}, error: /lower WORKER_MAX_INSTANCES, MATTING_CPU_MAX_INSTANCES or UPSCALE_MAX_INSTANCES/},
  {label: 'measure mode keeps the worker on its upscaler', env: {UPSCALE_MEASURE: '1', UPSCALE_SERVICE: 'dedicated', UPSCALE_MAX_INSTANCES: '1'}, expect: {STATUS: '1'},
    error: /UPSCALE_MEASURE=1 deploys catalog-upscale as a no-traffic candidate; keep the worker on UPSCALE_SERVICE=cpu/},
  {label: 'upscale shape values', env: {UPSCALE_THREADS: '8', UPSCALE_MEMORY: '32Gi', UPSCALE_CONCURRENCY: '5', UPSCALE_MEASURE: 'yes'}, expect: {STATUS: '1'},
    error: /UPSCALE_MEASURE must be 0 or 1[\s\S]*UPSCALE_MEMORY must be 2Gi to 16Gi with 4 vCPU[\s\S]*UPSCALE_THREADS=8 exceeds UPSCALE_CPU_VCPU=4[\s\S]*UPSCALE_CONCURRENCY must be at most 4/},
  {label: 'upscale CPU must be a Cloud Run size', env: {UPSCALE_CPU_VCPU: '3'}, expect: {STATUS: '1'}, error: /UPSCALE_CPU_VCPU must be 1, 2, 4, 6 or 8/},
  // Spec 18 3.3.1: the enlarge lanes.
  {label: 'the enlarge lanes need concurrency 3: at 2 they exceed the worker slots', env: {WORKER_CONCURRENCY: '2'}, expect: {STATUS: '1'},
    error: /queue slots 8 \+ 36 \+ 4 \+ enlarge 4 \+ 12 = 64 exceed the worker's 24 x 2 = 48/},
  {label: 'concurrency 3 fits the DB budget at photo concurrency 4', env: {}, expect: {STATUS: '0', WORKER_DB_POOL_MAX: '6', CATALOG_DB_TOTAL: '152'}},
  {label: 'enlarge slots above what catalog-upscale serves are refused', env: {...DEDICATED, MATTING_CPU_MAX_INSTANCES: '4', ENLARGE_BULK_MAX_DISPATCHES: '13'}, expect: {STATUS: '1'},
    error: /enlarge slots 4 \+ 13 exceed what catalog-upscale serves at once \(16 x 1\)/},
  {label: 'an enlarge rate above what the measured instances finish is refused', env: {...DEDICATED, MATTING_CPU_MAX_INSTANCES: '4', ENLARGE_DISPATCHES_PER_SECOND: '0.5'}, expect: {STATUS: '1'},
    error: /ENLARGE_DISPATCHES_PER_SECOND=0.5 exceeds what catalog-upscale finishes: 16 x 1 \/ p95 130 s of 800x1200 = 0.1231 per second/},
  {label: 'the enlarge rate must be a number above 0', env: {ENLARGE_DISPATCHES_PER_SECOND: '0'}, expect: {STATUS: '1'}, error: /ENLARGE_DISPATCHES_PER_SECOND must be a number above 0 and at most 500/},
  {label: 'no enlarge lanes (the rollback) fits concurrency 2', env: NO_ENLARGE, expect: {STATUS: '0', SLOTS_TOTAL: '48', SLOTS_CAPACITY: '48', CATALOG_DB_TOTAL: '104'}},
  {label: 'no probe sizes is refused, not treated as all measured', env: {...DEDICATED, MATTING_CPU_MAX_INSTANCES: '4', UPSCALE_SIZES: ''}, expect: {STATUS: '1'}, error: /UPSCALE_SIZES must list the probe sizes/},
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

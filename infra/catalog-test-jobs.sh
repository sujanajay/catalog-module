#!/usr/bin/env bash
# Prepare bounded Linux acceptance jobs. Does not execute them or grant permissions.
# First build this commit's worker and catalog-real images. Reuse CATALOG_TEST_RUN on reruns.
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=image-links-agent
cd "$(dirname "$0")/.."
: "${CATALOG_TEST_RUN:?Set CATALOG_TEST_RUN to a new UUID for this verification run}"
[[ "$CATALOG_TEST_RUN" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || exit 2
TAG=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain)" ] || { echo "Commit source changes before preparing or running commit-tagged verification jobs." >&2; exit 1; }
AR=asia-south1-docker.pkg.dev/image-links-agent/apps
for image in worker catalog-real; do
  gcloud artifacts docker images describe "$AR/$image:$TAG" --quiet >/dev/null
done
tmp_dir=$(mktemp -d)
trap 'rm -f -- "$tmp_dir/worker.json" "$tmp_dir/smoke.json" "$tmp_dir/real.json" "$tmp_dir/cleanup.json" "$tmp_dir/existing.json"; rmdir "$tmp_dir"' EXIT
# Environment references only. Mounted DB credentials are never read locally.
gcloud run services describe catalog-worker --region=asia-south1 --format=json > "$tmp_dir/worker.json"
node --input-type=commonjs - "$tmp_dir" "$TAG" "$CATALOG_TEST_RUN" <<'NODE'
const fs=require('node:fs'),assert=require('node:assert/strict');
const [dir,tag,run]=process.argv.slice(2);
const worker=JSON.parse(fs.readFileSync(`${dir}/worker.json`));
const source=worker.spec.template.spec.containers[0].env;
const names=['GCP_PROJECT','REGION','BUCKET','PUBLIC_BUCKET','DB_HOST','DB_NAME','DB_USER','MATTING_URL','MATTING_GPU_URL'];
const env=source.filter(e=>names.includes(e.name));
for(const name of names.filter(n=>n!=='MATTING_GPU_URL')) assert(env.find(e=>e.name===name && e.value),`Missing worker ${name}`);
const password=source.find(e=>e.name==='DB_PASSWORD');
assert.equal(password?.valueFrom?.secretKeyRef?.name,'catalog-db-password');
assert(password.valueFrom.secretKeyRef.key,'Missing password secret version reference');
env.push(password,{name:'DB_POOL_MAX',value:'2'});
const bucket='image-links-agent-assets';
const input='catalog-test/render-05-1792340617303-555901/inputs';
const volume=(name,prefix,readOnly)=>({name,csi:{driver:'gcsfuse.run.googleapis.com',readOnly,volumeAttributes:{bucketName:bucket,mountOptions:`only-dir=${prefix},uid=1000,gid=1000`}}});
for(const kind of ['smoke','real','cleanup']) {
  const name=`catalog-test-${kind}`,test=kind!=='cleanup';
  const image=`asia-south1-docker.pkg.dev/image-links-agent/apps/${kind==='real'?'catalog-real':'worker'}:${tag}`;
  const command=test?['/bin/sh']:['node'];
  const args=test?['-ec',`mkdir -p /tmp/catalog-data; tar -xf /catalog-input/anta.tar -C /tmp/catalog-data; tar -xf /catalog-input/french-connection.tar -C /tmp/catalog-data; ${kind==='real'?"exec pnpm test:real -t 'anta:'":"exec node dist/catalog-smoke.js"}`]:['dist/catalog-smoke.js','--cleanup-batches'];
  const container={image,command,args,resources:{limits:{cpu:'2',memory:'4Gi'}},env:[...env]};
  const task={serviceAccountName:'catalog-worker@image-links-agent.iam.gserviceaccount.com',maxRetries:0,timeoutSeconds:kind==='real'?'10800':'3600',containers:[container]};
  if(test) {
    container.env.push({name:'REAL_DATA_DIR',value:'/tmp/catalog-data'},{name:'CATALOG_REAL_OUT',value:'/catalog-evidence'},{name:'REAL_DATA',value:'1'});
    container.volumeMounts=[{name:'input',mountPath:'/catalog-input'},{name:'evidence',mountPath:'/catalog-evidence'}];
    task.volumes=[volume('input',input,true),volume('evidence',`catalog-test/smoke/linux-${run}/${kind}`,false)];
  }
  const annotations={'run.googleapis.com/execution-environment':'gen2','run.googleapis.com/network-interfaces':JSON.stringify([{network:'ila-vpc',subnetwork:'ila-subnet'}]),'run.googleapis.com/vpc-access-egress':'private-ranges-only'};
  const desired={apiVersion:'run.googleapis.com/v1',kind:'Job',metadata:{name},spec:{template:{metadata:{annotations},spec:{taskCount:1,parallelism:1,template:{spec:task}}}}};
  fs.writeFileSync(`${dir}/${kind}.json`,JSON.stringify(desired));
}
NODE
for kind in smoke real cleanup; do
  job=catalog-test-$kind
  # Successful list distinguishes a missing job from an inaccessible API.
  gcloud run jobs list --region=asia-south1 --filter="metadata.name=$job" --format=json > "$tmp_dir/existing.json"
  if node --input-type=commonjs - "$tmp_dir/existing.json" "$tmp_dir/$kind.json" <<'NODE'
const fs=require('node:fs');
const [oldFile,newFile]=process.argv.slice(2),old=JSON.parse(fs.readFileSync(oldFile))[0],desired=JSON.parse(fs.readFileSync(newFile));
for(const volume of old?.spec?.template?.spec?.template?.spec?.volumes??[]) {
  if(volume.csi?.driver==='gcsfuse.run.googleapis.com') volume.csi.readOnly??=false;
}
function contains(a,b){if(Array.isArray(b))return Array.isArray(a)&&a.length===b.length&&b.every((v,i)=>contains(a[i],v));if(b&&typeof b==='object')return !!a&&Object.entries(b).every(([k,v])=>contains(a[k],v));return a===b;}
process.exit(old&&contains(old.spec,desired.spec)?0:1);
NODE
  then
    echo "$job: SKIP (current image and bounded configuration already match)"
  else
    gcloud run jobs replace "$tmp_dir/$kind.json" --region=asia-south1 --quiet
  fi
done
echo "Evidence: gs://image-links-agent-assets/catalog-test/smoke/linux-$CATALOG_TEST_RUN/"

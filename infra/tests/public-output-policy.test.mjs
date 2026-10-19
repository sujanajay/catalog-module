// Run with node infra/tests/public-output-policy.test.mjs. No provider calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import process from 'node:process';
import console from 'node:console';
import {spawnSync} from 'node:child_process';
const target = process.env.POLICY_HELPER_UNDER_TEST || path.resolve(import.meta.dirname, '../allow-catalog-public-output.sh');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-policy-proof-'));
const baseline = {values:{allowedValues:['C00jf9i0v']}};
const name = 'projects/847405579637/policies/iam.allowedPolicyMemberDomains';
const description = 'Catalog public JPEG bucket exception only; never attach to projects or other resources.';
const key = {name:'tagKeys/123',parent:'projects/847405579637',shortName:'catalogPublicOutput',description};
const value = {name:'tagValues/456',parent:key.name,shortName:'publicJpegs',description};
const rules = [{allowAll:true,condition:{title:'catalogPublicOutputBucket',expression:"resource.matchTagId('tagKeys/123', 'tagValues/456')"}},baseline];
const fake = `const fs=require('node:fs');
const file=process.env.MOCK_STATE,s=JSON.parse(fs.readFileSync(file)),a=process.argv.slice(2);
s.calls.push(a);const done=v=>{fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(v));};
const fail=()=>{fs.writeFileSync(file,JSON.stringify(s));console.error('PERMISSION_DENIED mocked');process.exit(1)};
const cmd=a.slice(0,4).join(' '),arg=p=>a.find(x=>x.startsWith(p+'='))?.slice(p.length+1);
if(a[0]==='services'&&a[1]==='list'){fs.writeFileSync(file,JSON.stringify(s));console.log(s.apiDisabled?'':'orgpolicy.googleapis.com');}
else if(a[0]==='services'&&a[1]==='enable'){if(a[2]!=='orgpolicy.googleapis.com')throw Error('Wrong API');s.apiDisabled=false;done({});}
else if(a[0]==='org-policies'&&a[1]==='list'){if(s.deny==='list')fail();else done(s.policy?[s.policy]:[]);}
else if(a[0]==='org-policies'&&a[1]==='describe'){done(s.effective??s.policy??{name:s.name,spec:{rules:[s.baseline]}});}
else if(cmd==='resource-manager tags keys list'){if(s.deny==='tags')fail();else done(s.key?[s.key]:[]);}
else if(cmd==='resource-manager tags keys create'){s.key={name:'tagKeys/123',parent:arg('--parent'),shortName:a[4],description:arg('--description')};done(s.key);}
else if(cmd==='resource-manager tags values list'){done(s.value?[s.substitute?{...s.value,name:'tagValues/789'}:s.value]:[]);}
else if(cmd==='resource-manager tags values create'){if(s.deny==='value-create')fail();s.value={name:'tagValues/456',parent:arg('--parent'),shortName:a[4],description:arg('--description')};done(s.badCreated?{...s.value,parent:'tagKeys/999'}:s.value);}
else if(cmd==='resource-manager tags bindings list'){const p=arg('--parent');if(!['//cloudresourcemanager.googleapis.com/projects/847405579637','//storage.googleapis.com/projects/_/buckets/image-links-agent-assets','//storage.googleapis.com/projects/_/buckets/image-links-agent-public'].includes(p))throw Error('Resource parent changed across native process boundary: '+p);const forbidden=s.projectBound&&p.endsWith('/projects/847405579637')||s.privateBound&&p.endsWith('/image-links-agent-assets');done(forbidden||p.endsWith('/image-links-agent-public')&&s.bound?[{tagValue:'tagValues/456'}]:[]);}
else if(cmd==='resource-manager tags bindings create'){if(arg('--parent')!=='//storage.googleapis.com/projects/_/buckets/image-links-agent-public')throw Error('Wrong binding');s.bound=true;done({});}
else if(a[0]==='org-policies'&&a[1]==='set-policy'){s.payload=JSON.parse(fs.readFileSync(a[2]));if(s.deny==='write')fail();if(s.race){s.policy={name:s.name,spec:{etag:'concurrent-admin',rules:[s.baseline]}};if(s.payload.spec.etag!==s.policy.spec.etag)fail();}s.policy=s.payload;done(s.policy);}
else throw Error('Unexpected mocked command '+a.join(' '));`;
const cases = [
  {label:'third-resource-reuse',expected:1,key,value,thirdResourceBound:true,noWrites:true},
  {label:'fresh-create',expected:0},
  {label:'enable-required-api',expected:0,apiDisabled:true},
  {label:'existing-key-fresh-value',expected:0,key},
  {label:'exact-policy-reuse',expected:1,key,value,bound:true,policy:{name,spec:{etag:'old-token',inheritFromParent:false,rules}},noWrites:true},
  {label:'baseline-policy-reuse',expected:1,key,value,policy:{name,spec:{etag:'old-token',rules:[baseline]}},noWrites:true},
  {label:'project-effective-binding',expected:1,projectBound:true,noWrites:true},
  {label:'private-effective-binding',expected:1,privateBound:true,noWrites:true},
  {label:'created-identity-substituted',expected:1,substitute:true,noWrites:true},
  {label:'created-parent-mismatch',expected:1,badCreated:true,noWrites:true},
  {label:'concurrent-policy-create',expected:1,race:true},
  {label:'preserve-etag-dry-run',expected:0,policy:{name,spec:{etag:'keep-this',rules:[baseline]},dryRunSpec:{rules:[baseline]}}},
  {label:'unknown-policy',expected:1,policy:{name,spec:{etag:'x',rules:[{allowAll:true}]}},noWrites:true},
  {label:'effective-baseline-mismatch',expected:1,effective:{spec:{rules:[{values:{allowedValues:['other-customer']}}]}},noWrites:true},
  {label:'policy-read-denied',expected:1,deny:'list',noWrites:true},
  {label:'tag-read-denied',expected:1,deny:'tags',noWrites:true},
  {label:'value-create-denied',expected:1,deny:'value-create',noWrites:true},
  {label:'policy-write-denied',expected:1,deny:'write'},
];
try {
  const fakePath=path.join(dir,'gcloud.cjs');fs.writeFileSync(fakePath,fake);
  const bash=process.env.CATALOG_BASH || (process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'Programs/Git/bin/bash.exe'):'bash');
  for(const c of cases){
    const statePath=path.join(dir,c.label+'.json');fs.writeFileSync(statePath,JSON.stringify({name,baseline,calls:[],...c}));
    const r=spawnSync(bash,['-c','gcloud() { node "$MOCK" "$@"; }; export -f gcloud; bash "$TARGET"'],{env:{...process.env,MOCK:fakePath,MOCK_STATE:statePath,TARGET:target},encoding:'utf8',timeout:60000});
    if(r.error)throw r.error;
    const s=JSON.parse(fs.readFileSync(statePath));
    const policies=s.calls.filter(a=>a[0]==='org-policies'&&a[1]==='set-policy');
    const bindings=s.calls.filter(a=>a.slice(0,4).join(' ')==='resource-manager tags bindings create');
    // A pre-existing value can have a binding on an arbitrary parent which the
    // per-parent list API cannot enumerate. Refusal must precede any new grant.
    if(c.noWrites)assert.equal(policies.length+bindings.length,0,c.label+' unexpectedly created a binding or policy');
    assert.equal(r.status,c.expected,c.label+'\n'+r.stderr);
    if(c.value)assert.match(r.stderr,/administrator review required/i,c.label+' missing recovery instruction');
    if(c.label==='preserve-etag-dry-run'){
      assert.equal(s.payload.spec.etag,'keep-this');assert.deepEqual(s.payload.dryRunSpec,c.policy.dryRunSpec);
    }
    if(c.label==='concurrent-policy-create'){assert.equal(s.policy.spec.etag,'concurrent-admin');assert.ok(s.payload.spec.etag);}
    if(c.label==='policy-write-denied')assert.equal(policies.length,1,'Denied policy write retried');
    if(['unknown-policy','effective-baseline-mismatch','policy-read-denied'].includes(c.label))assert.ok(!s.calls.some(a=>a.includes('create')),'Early validation mutated tags');
    assert.ok(!s.calls.some(a=>a.includes('--organization')||a[0]==='projects'||a.includes('add-iam-policy-binding')),'Unexpected IAM/organization write');
    console.log('PASS '+c.label+' ('+policies.length+' policy writes, '+bindings.length+' binding writes)');
  }
  console.log(cases.length+' offline policy cases passed');
} finally {
  // Only remove the directory freshly created by this proof, never user data.
  fs.rmSync(dir,{recursive:true,force:true});
}

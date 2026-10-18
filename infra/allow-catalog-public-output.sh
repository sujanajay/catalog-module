#!/usr/bin/env bash
# Narrow domain-sharing exception for the catalog public output bucket only.
# This changes project organization policy, not organization/folder policy or IAM.
# It never grants roles or touches the private assets bucket's configuration.
# Legacy allowAll exempts tagged resources from the domain filter; bootstrap's
# separate bucket IAM binding grants the actual public read permission.
# This one-off remediation deliberately refuses a pre-existing tag value, even
# after a successful run. There is no authoritative reverse binding inventory;
# an existing value may also exempt another resource. Recovery needs an admin.
set -euo pipefail

export CLOUDSDK_CORE_PROJECT=image-links-agent
PROJECT=image-links-agent
NUMBER=847405579637
CONSTRAINT=iam.allowedPolicyMemberDomains
POLICY="projects/$NUMBER/policies/$CONSTRAINT"
PARENT="projects/$NUMBER"
BUCKET='//storage.googleapis.com/projects/_/buckets/image-links-agent-public'
KEY=catalogPublicOutput
DESCRIPTION='Catalog public JPEG bucket exception only; never attach to projects or other resources.'

gcv() { MSYS2_ARG_CONV_EXCL='--parent=//storage.googleapis.com/;--parent=//cloudresourcemanager.googleapis.com/' gcloud "$@" --project="$PROJECT" --quiet | tr -d '\r'; }
log() { printf '[catalog-public-output] %s\n' "$*" >&2; }
tmp="$(mktemp -d)"
trap 'rm -f "$tmp"/*.json "$tmp"/check.cjs; rmdir "$tmp"' EXIT

# JSON validation is deliberately strict: unfamiliar policy or tag data stops the
# script before the corresponding write instead of replacing someone else's setup.
cat > "$tmp/check.cjs" <<'NODE'
const fs = require('node:fs');
const [action, dir, ...args] = process.argv.slice(2);
const read = (name) => JSON.parse(fs.readFileSync(`${dir}/${name}.json`, 'utf8'));
const save = (name, value) => fs.writeFileSync(`${dir}/${name}.json`, JSON.stringify(value, null, 2));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const keys = (obj, allowed) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every(k => allowed.includes(k));
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;
const equal = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const baseline = r => keys(r, ['values']) && keys(r.values, ['allowedValues']) && JSON.stringify(r.values.allowedValues) === '["C00jf9i0v"]';
const desiredRules = (key, value) => [{condition: {expression: `resource.matchTagId('${key}', '${value}')`, title: 'catalogPublicOutputBucket'}, allowAll: true}, {values: {allowedValues: ['C00jf9i0v']}}];
const policyName = 'projects/847405579637/policies/iam.allowedPolicyMemberDomains';
if (action === 'policy') {
  const all = read('policies');
  assert(Array.isArray(all), 'Policy list is not an array');
  const found = all.filter(p => p.name?.endsWith('/policies/iam.allowedPolicyMemberDomains'));
  assert(found.length <= 1, 'Duplicate target policy');
  const p = found[0] ?? null;
  if (p) {
    assert(p.name === policyName && keys(p, ['name', 'spec', 'dryRunSpec', 'etag']), 'Unexpected policy identity or fields');
    const s = p.spec;
    assert(keys(s, ['etag', 'updateTime', 'rules', 'inheritFromParent', 'reset']) && s.inheritFromParent !== true && s.reset !== true && Array.isArray(s.rules), 'Unexpected policy specification');
    assert(typeof s.etag === 'string' && s.etag.length > 0, 'Existing policy has no concurrency etag');
    const oneBaseline = s.rules.length === 1 && baseline(s.rules[0]);
    const r = s.rules[0];
    const ownDesired = s.rules.length === 2 && baseline(s.rules[1]) && keys(r, ['condition', 'allowAll']) && r.allowAll === true && keys(r.condition, ['expression', 'title']) && r.condition.title === 'catalogPublicOutputBucket' && /^resource\.matchTagId\('tagKeys\/\d+', 'tagValues\/\d+'\)$/.test(r.condition.expression);
    assert(oneBaseline || ownDesired, 'Existing policy is not the baseline or this helper exact policy; administrator review required');
  }
  save('before', p);
  console.log(p?.spec.rules.length === 2 ? 'desired' : 'baseline');
} else if (action === 'effective') {
  const p = read('effective');
  assert(p.spec?.rules?.length === 1 && baseline(p.spec.rules[0]) && p.spec.reset !== true, 'Effective domain policy differs from the approved customer baseline');
} else if (action === 'tag') {
  const [kind, shortName, parent, description] = args;
  const all = read(kind);
  assert(Array.isArray(all), 'Tag list is not an array');
  const found = all.filter(t => t.shortName === shortName);
  assert(found.length <= 1, 'Duplicate dedicated tag');
  if (found.length) {
    const t = found[0];
    assert(t.parent === parent && t.description === description && !t.purpose && !t.purposeData && new RegExp(`^${kind === 'keys' ? 'tagKeys' : 'tagValues'}/\\d+$`).test(t.name), 'Dedicated tag has unexpected metadata');
    console.log(t.name);
  }
} else if (action === 'bindings') {
  const [value, mode] = args;
  const all = read('bindings');
  assert(Array.isArray(all), 'Tag binding list is not an array');
  const matching = all.filter(b => b.tagValue === value);
  if (mode === 'absent') assert(matching.length === 0, 'Exception tag is attached outside the public output bucket');
  else { assert(matching.length <= 1, 'Duplicate public bucket binding'); console.log(matching.length); }
} else if (action === 'created') {
  const [parent, description] = args;
  const t = read('created');
  assert(t && t.parent === parent && t.shortName === 'publicJpegs' && t.description === description && !t.purpose && !t.purposeData && /^tagValues\/\d+$/.test(t.name), 'Created tag value has unexpected identity or metadata');
  console.log(t.name);
} else if (action === 'desired') {
  const [key, value] = args;
  const before = read('before');
  const rules = desiredRules(key, value);
  if (before?.spec.rules.length === 2) assert(equal(before.spec.rules, rules), 'Existing exception references a different tag');
  // CreatePolicy ignores spec.etag (documented by the v2 API). If another
  // writer creates a policy before gcloud's upsert read, this unique sentinel
  // makes its UpdatePolicy fail instead of blindly replacing the new policy.
  const createEtag = Buffer.from(`catalog-create-only:${require('node:crypto').randomUUID()}`).toString('base64');
  const after = before ? structuredClone(before) : {name: policyName, spec: {etag: createEtag}};
  after.spec.rules = rules;
  after.spec.inheritFromParent = false;
  delete after.spec.updateTime;
  save('desired', after);
  console.log(before?.spec.rules.length === 2 ? 'skip' : 'write');
} else if (action === 'verify') {
  const actual = read('after');
  const desired = read('desired');
  assert(actual.name === policyName && actual.spec?.inheritFromParent !== true && equal(actual.spec?.rules, desired.spec.rules), 'Saved policy did not match the desired scoped exception');
} else throw new Error('Unknown validation action');
NODE
check() { node "$tmp/check.cjs" "$1" "$tmp" "${@:2}"; }

enabled="$(gcv services list --enabled --filter='config.name=orgpolicy.googleapis.com' --format='value(config.name)')"
if [[ -z "$enabled" ]]; then
  log 'ENABLE orgpolicy.googleapis.com'
  gcv services enable orgpolicy.googleapis.com >/dev/null
elif [[ "$enabled" != orgpolicy.googleapis.com ]]; then
  log 'ERROR unexpected service-list response'; exit 1
fi

# A successful list distinguishes absence from an inaccessible policy. No error
# (including PERMISSION_DENIED or network failure) is treated as "not found".
gcv org-policies list --format=json > "$tmp/policies.json"
mode="$(check policy)"
if [[ "$mode" == baseline ]]; then
  gcv org-policies describe "$CONSTRAINT" --effective --format=json > "$tmp/effective.json"
  check effective
fi

gcv resource-manager tags keys list --parent="$PARENT" --format=json > "$tmp/keys.json"
key="$(check tag keys "$KEY" "$PARENT" "$DESCRIPTION")"
if [[ -z "$key" ]]; then
  log "CREATE dedicated project tag key $KEY"
  gcv resource-manager tags keys create "$KEY" --parent="$PARENT" --description="$DESCRIPTION" --format=json >/dev/null
  gcv resource-manager tags keys list --parent="$PARENT" --format=json > "$tmp/keys.json"
  key="$(check tag keys "$KEY" "$PARENT" "$DESCRIPTION")"
  [[ -n "$key" ]] || exit 1
fi
gcv resource-manager tags values list --parent="$key" --format=json > "$tmp/values.json"
value="$(check tag values publicJpegs "$key" "$DESCRIPTION")"
if [[ -n "$value" ]]; then
  log 'ERROR pre-existing exception tag value cannot be proven exclusive to the public bucket; administrator review required. No binding or policy was changed.'
  exit 1
fi
log 'CREATE dedicated publicJpegs tag value'
# A failed create (including a concurrent creator) stops here. Never adopt an
# existing value after a failed create or recover by choosing another name.
gcv resource-manager tags values create publicJpegs --parent="$key" --description="$DESCRIPTION" --format=json > "$tmp/created.json"
created="$(check created "$key" "$DESCRIPTION")"
gcv resource-manager tags values list --parent="$key" --format=json > "$tmp/values.json"
value="$(check tag values publicJpegs "$key" "$DESCRIPTION")"
if [[ "$value" != "$created" ]]; then
  log 'ERROR created tag value changed identity; no binding or policy was changed; administrator review required'
  exit 1
fi
action="$(check desired "$key" "$value")"

# Refuse project inheritance and private bucket use, including unexpected
# concurrent placement of this newly created value. These known-parent checks
# are not a global inventory. Tag administrators must not attach this value to
# another resource later: the policy condition follows the tag, not the bucket.
gcv resource-manager tags bindings list --parent="//cloudresourcemanager.googleapis.com/projects/$NUMBER" --effective --format=json > "$tmp/bindings.json"
check bindings "$value" absent
gcv resource-manager tags bindings list --parent='//storage.googleapis.com/projects/_/buckets/image-links-agent-assets' --location=asia-south1 --effective --format=json > "$tmp/bindings.json"
check bindings "$value" absent
gcv resource-manager tags bindings list --parent="$BUCKET" --location=asia-south1 --format=json > "$tmp/bindings.json"
bound="$(check bindings "$value" public)"
if [[ "$bound" == 0 ]]; then
  log 'BIND tag to image-links-agent-public only'
  gcv resource-manager tags bindings create --parent="$BUCKET" --location=asia-south1 --tag-value="$value" >/dev/null
fi
if [[ "$action" == write ]]; then
  log "SET project-only $CONSTRAINT exception; no IAM grants"
  gcv org-policies set-policy "$tmp/desired.json" --update-mask=policy.spec --format=json > "$tmp/after.json"
else
  log 'SKIP exact project policy already present'
  gcv org-policies describe "$CONSTRAINT" --format=json > "$tmp/after.json"
fi
check verify
log 'DONE scoped policy saved; run bootstrap to grant the separate bucket public-read binding'

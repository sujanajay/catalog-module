# 14d Intake release D: the should set and the finished-collection email

Catalog module, spec 14, release D of four. Execute with `docs/specs/00-execution-protocol.md`. Parent:
`docs/specs/14-intake-resilience.md`; read its terms, sections 1 to 6 and section 8 before this file.
Source of truth: `docs/SPEC.md`. Depends on releases A, B and C (`14a-intake-release-a.md`,
`14b-intake-release-b.md`, `14c-intake-release-c.md`) merged and deployed. Branch
`feat/catalog-14d-intake-should`, worktree `C:\Users\Sujan
AH\Desktop\catalog-module-wt\14d-intake-should`. Deploys `catalog-worker` and `catalog-web` (no
migration) and runs the new idempotent `infra/notify.sh`. Approval: approved by the owner on 2026-10-27
(parent section 11, decisions 2, 4 and 5). This release ships as one PR, called PR D in the text below.

Open item (the only one): F14 needs a one-time Google Workspace step by the owner before the email can
be switched on (section 3.6, "Prerequisite"). Everything else in this release, including the F14 code,
is built, tested and deployed without it; F14 stays off (no sender configured) until the step is done.

## 1. What changes for the operator

- Large batches finish: placing runs in resumable chunks with a moving count, and a change of options
  only on step 2 regroups without re-copying.
- Temporary link failures (a busy server, a timeout) are retried by the system before the operator sees
  them; the card says how often.
- Step 4 warns when the same photos are already in another unfinished batch of the brand (with a link
  to it), and when one photo sits under two products.
- One Continue is enough for any number of loose files.
- Drafts untouched for 14 days are cancelled by the system as "Expired after 14 days with no activity";
  their photos are kept.
- When a collection took longer than a few minutes, the person who created the batch gets one email
  when it is ready to check, needs their input, or could not start, with a link to the batch.

## 2. Scope

In scope: `ingest/{index,overwrite-preview,group}.ts` (`groupBatch`, `placeBatch`, link retry, time
budget), `apps/worker/src/catalog/{ingest,sweep}.ts`, `apps/worker/src/index.ts` (the
`/tasks/catalog/ingest-more` handler), `web/lib/catalog/uploads.ts` (`ingestBatch` paging and
`counts.collectStartedAt`), `web/components/catalog/{WizardStep2,WizardStep4,LinkFailures}.tsx`
(warnings, the retried sentence), `packages/core/src/catalog/types.ts` (`BatchCounts` fields), and for
F14: new `apps/worker/src/catalog/notify.ts` (decide, claim, compose), new
`packages/core/src/mail/gmail-send.ts` (keyless token and send), new `infra/notify.sh`, `infra/deploy.sh`
(worker env `NOTIFY_SENDER`, `NOTIFY_AFTER_MINUTES`, `WEB_URL`), a `docs/solutions/` note for the
Workspace step, and tests.

Out of scope here: everything the parent lists as out of scope, every fix or part assigned to releases
A, B and C (parent section 7), and F13 (parent section 9, deferred). Builders fetch current docs
through Context7 before using the Gmail API, the IAM Service Account Credentials API or
`google-auth-library`.

## 3. Fixes

Sentences in quotes are exact (parent section 4).

### 3.1 F7 part 2: placing in resumable chunks (should)

Part 1 of F7 (the sha256 skip, instant Continue) shipped in 14c section 3.3.

- `finishBatch` is reordered and split. `groupBatch` runs first: `removeDraftRows`, `assemble`,
  matching and `findOrCreateProduct`, then saves the planned shot list (`{ productId, pathKey, n,
  sourceUri, sha256 }[]`) to `place-state.json` under `derived/_ingest/` (sibling of
  `preview-state.json`). `placeBatch` then copies that list in chunks of `PLACE_BUDGET_ITEMS` (builder
  constant, chosen to stay well inside 900 s at the measured 280 photos/min, start 800) with the sha256
  skip; after each chunk it writes `counts.placed`, renews the lease of F6 (14c section 3.2) and
  re-enqueues itself with the cursor and the lease token. The delivery that places the last chunk inserts
  the `catalog_source_images` rows, writes `preview-state.json` and sets the counts (`previewReady`,
  `phase`, status `draft`, guarded as in F4 part 2, 14c section 3.1).
- `regroupBatch` after a step 2 change whose only effect is options (identifier mode, precedence,
  sheet columns, sheet kind) does not touch upload statuses; it reruns `groupBatch` with the new options
  and then `placeBatch`, where the sha256 skip makes unchanged photos free.
- Unproven risk: `groupBatch` alone at about 2,000 products has not been measured against the 900 s
  deadline. The builder measures it in tier 2 with fakes at that size and reports the time (section 11);
  if it does not fit with a wide margin, that is raised as an open issue, not solved silently.
- Acceptance (tier 2): 1,000 fake items with `PLACE_BUDGET_ITEMS` 300: four placing deliveries,
  `placed` moves 300, 600, 900, 1,000, the batch is `ingesting` with `phase: "placing"` throughout, then
  `draft` ready; `catalog_source_images` rows appear only after the last chunk; a killed delivery (the
  test throws after chunk 2) leaves the lease and cursor so the retry with the same token continues at
  chunk 3; an options-only regroup runs `groupBatch` then `placeBatch` with zero copies and no upload
  status change.

### 3.2 F5 part 2: automatic retry of transient link failures (should)

Part 1 of F5 (the visible part) shipped in 14b section 3.3.

- Item results in the manifest gain `attempts: number` and `final: boolean`. A transient failure is
  retried inside the delivery up to `LINK_RETRY_ATTEMPTS` (builder constant, 3) with backoff 2 s, 8 s,
  and stored with `final: false`; retries use a 20 s timeout (the first attempt keeps the existing
  60 s). A permanent failure is stored `final: true`.
- Within one run, continuations never re-fetch non-final items: they carry the run's results forward.
  Only a new run (Try again, regroup, `POST /retry-links`) clears non-final results so they are fetched
  again. After `LINK_MAX_ATTEMPTS` (builder constant, 9) attempts across runs, a link is stored
  `final: true` with its reason. `POST /retry-links` is the operator's explicit request and drops the
  results with their attempt history (part 1, 14b section 3.3).
- The delivery gets a time budget next to the item budget: after `INGEST_TIME_BUDGET_MS` (builder
  constant, 600 s) of work it starts no new item, saves the manifest with the results so far and
  re-enqueues itself with the cursor, so a slow or dead host can no longer push a delivery past the
  900 s deadline and lose the whole chunk (paths #30).
- Copy, added to the step 2 card when any link was retried: "Transient problems were tried <attempts>
  times."
- Acceptance (part 2, tier 2 `ingest.test.ts`): a fake fetch that answers 503 twice then 200 for one
  item gives 1 photo with `attempts: 3`; a 404 item is `final: true` and not re-fetched on a second run
  (fetch count unchanged); a 429 item left non-final is not re-fetched by a continuation of the same run
  and is re-fetched by a new run; after `LINK_MAX_ATTEMPTS` attempts across runs it is stored final with
  its reason; a fake host answering after 60 s every time still yields a saved manifest and a
  continuation.

### 3.3 F10: the same photos in another batch are flagged

- `buildOverwritePreview` gains `sameBatches: { batchId: string; name: string; createdAt: string;
  state: string; sharedPhotos: number; example: { here: string; there: string } | null }[]`: the brand's
  other `draft`, `ingesting` and failed-before-start batches (same `is_test`) whose source rows share at
  least 10 sha256 values or 20% of this batch's, with one example of the two identifier spellings
  when they differ. And `duplicatePhotos: { sha256: string; identifiers: string[]; name: string }[]`
  for photos under two identifiers in this batch (the Tan/Black case).
- Step 4 warning pairs:
  - "These photos are already in <name> (<state>, created <age>)." + "<shared> of <photos> photos are
    the same<, under different identifiers (<there> there, <here> here)>. Continue that batch or cancel
    it before starting this one, so the same product is not made twice." `<name>` is a link to
    `/catalog/<batchId>`.
  - "<k> photos appear under two products." + "<name> is in <id a> and <id b>; <more>. Check the
    sheet before starting."
- Neither blocks Start (the operator may be re-delivering on purpose).
- Acceptance (tier 2 `overwrite-preview.test.ts`): two drafts with the same 12 hashes under `X` and
  `X_OD` give one `sameBatches` entry with the example; a started batch is not listed; one photo under
  two identifiers gives one `duplicatePhotos` entry; `group.test.ts`: both pairs; UI: the batch name in
  the first pair links to the other batch.

### 3.4 F11 part 2: paged hand-off (should)

Part 1 of F11 (platform errors) shipped in 14c section 3.5.

Part 2 (PR D, should): `ingestBatch` hands over at most `HAND_OFF_PAGE` (builder constant, 500)
`uploaded` rows in the web request, then enqueues one `/tasks/catalog/ingest-more` task `{batchId, run}`
and returns `{ collecting: true, remaining }`. That task (handler in `apps/worker/src/catalog/ingest.ts`,
registered in `apps/worker/src/index.ts`) hands over the next `HAND_OFF_PAGE` rows still `uploaded` and
re-enqueues itself until none remain, so one Continue is enough for any count. Acceptance: routes and
worker: 1,200 fake uploads produce one web page and two `ingest-more` deliveries, and every upload
reaches the queue exactly once (fake queue count).

### 3.5 F12: draft housekeeping and a trace per delivery

- Sweep: a `draft` batch (never started, not cancelled) whose `updated_at` is older than
  `DRAFT_EXPIRY_DAYS` (env, default 14; decided 2026-10-27, parent section 11
  decision 2) is cancelled with `options.expired = { at, days }`; the list shows "Expired after <N> days
  with no activity". Objects are untouched.
- `handleIngestTask` logs one INFO line per delivery: `{ event: "ingest", batchId, uploadId, phase,
  done, total, ms, outcome }`.
- Acceptance: `sweep.test.ts`: a 15-day draft is cancelled with `expired`, a 13-day one is not, a
  cancelled one is untouched, no objects are deleted; `ingest.test.ts`: the log spy sees one line per
  delivery with the batch id.

### 3.6 F14: the creator is told when a long collection finishes (should, after release C)

Problem. No batch was ever started more than 30 minutes after it was created (proposal section 2.2),
and a collection can take 17 minutes. An operator who leaves during a long collection is told by the
leaving line where to find the batch, but nothing reminds them to come back. The product has no
outgoing mail today; the alerting of `infra/monitoring.sh` uses a Cloud Monitoring email channel, which
sends alert notifications to a fixed address and is not meant for per-user mail.

Route (decided in this spec): the Gmail API `users.messages.send` from one Google Workspace mailbox of
the company domain, called by `catalog-worker` through domain-wide delegation with keyless signing.
The worker never holds a key or a secret: it asks the IAM Service Account Credentials API to sign a JWT
for its own service account (`signJwt`), exchanges that JWT at the Google OAuth token endpoint for an
access token on behalf of the sender mailbox, and calls Gmail with it. Why this route: it is Google's
own mail path for the company domain (first-party, no new vendor), needs no secret anywhere (so nothing
for Secret Manager to hold), needs no always-on resource, and lands in the operator's normal inbox.
Rejected: Cloud Monitoring email channels (fixed recipients, alert format, not per user); the Workspace
SMTP relay (needs a static egress address, which means an always-on Cloud NAT, or an SMTP password);
an OAuth refresh token of the sender mailbox in Secret Manager (a long-lived secret that breaks when the
mailbox password or policy changes); third-party mail services (a new vendor and an API key).

Behaviour:

- `ingestBatch` (web) merges `counts.collectStartedAt` (ISO time) into counts when it hands a
  collection to the worker (a first collection, Try again, a regroup that re-collects, "Try the failed
  links again"). Each hand-off starts a new collection and replaces the value.
- `maybeNotifyCollectionEnd(batchId)` in `apps/worker/src/catalog/notify.ts` runs after every ingest
  delivery that writes a final intake state (the closing write of 14c section 3.2 and of section 3.1
  above: `phase` `ready` or `needs_input`; or status `failed` with `startedAt` null) and after the sweep
  fails a batch. It sends only when all hold: the batch has `startedAt` null and is not `cancelled`;
  `collectStartedAt` is set; the time from `collectStartedAt` to now is at least `NOTIFY_AFTER_MINUTES`
  (worker env, default 5); `NOTIFY_SENDER` is set; and an atomic claim succeeds: `UPDATE catalog_batches
  SET counts = counts || jsonb_build_object('notified', jsonb_build_object('collectStartedAt', <value>,
  'at', now(), 'outcome', <outcome>)) WHERE id = <id> AND status <> 'cancelled' AND (counts->'notified'
  IS NULL OR counts->'notified'->>'collectStartedAt' IS DISTINCT FROM <value>) RETURNING id`. So each
  collection sends at most once, Cloud Tasks retries and continuation deliveries never send twice, and
  a new collection (for example after Fix and continue) may send again.
- Outcome: `ready` (phase `ready`), `needs_input` (phase `needs_input`) or `failed` (status `failed`,
  never started).
- Recipient: the batch's `createdBy` (the signed-in `@opptra.com` address of the creator, from IAP).
  Exactly one recipient; no copy to anyone else.
- Sender: `NOTIFY_SENDER` (one mailbox address of the company domain, not a secret; display name
  "Catalog"). The delegated token is always requested with `sub = NOTIFY_SENDER` and the single scope
  `https://www.googleapis.com/auth/gmail.send`; the code has no other subject and no other scope (a unit
  test asserts both).
- Message: plain text, UTF-8, RFC 2822, encoded base64url in the `raw` field of `users.messages.send`
  with `userId` `me`. The link is `<WEB_URL>/catalog/<batchId>`, where `WEB_URL` is the canonical web
  address deploy.sh already computes (`CANONICAL_WEB_URL`), now also passed to the worker.
- Failure handling: a mail error (token, Gmail, network) logs one WARN line `{ event: "notify",
  batchId, outcome, error }` without addresses or tokens and is not retried (the claim is kept, so the
  batch is never mailed twice); it never changes the batch, its counts or its status. With
  `NOTIFY_SENDER` empty the worker logs one INFO line `{ event: "notify", batchId, skipped: "no
  sender" }` and sends nothing. A sent mail logs one INFO line `{ event: "notify", batchId, outcome,
  sent: true }`.
- No setting, no preference page, no other email of any kind in this release.

Copy (exact; `<name>` is the batch name, `<brand>` the brand name, `<m>` the value of
`NOTIFY_AFTER_MINUTES`; no model ids, no technical words):

- Subject, ready: "<name> is ready to check"
- Body, ready: "Your batch <name> for <brand> has finished collecting: <photos> photos for <products>
  products. Nothing has been processed yet. Open it and press Continue setting up to check the
  grouping, choose marketplaces and start: <link>"
- Subject, needs input: "<name> needs your input"
- Body, needs input: "Your batch <name> for <brand> has finished collecting and needs one answer before
  it can continue: which column holds the identifier? Open it and press Continue setting up: <link>"
- Subject, could not start: "<name> could not start"
- Body, could not start: "Your batch <name> for <brand> could not start: <failReason> Open it and press
  Fix and continue to change its photos or links: <link>"
- Closing line, every message: "You get this email because you created this batch and collecting its
  photos took more than <m> minutes. We send one email per collection that takes this long."

Infra (`infra/notify.sh`, new, idempotent, check-then-create, exports
`CLOUDSDK_CORE_PROJECT=image-links-agent`, never deletes):

- Enables `gmail.googleapis.com` and `iamcredentials.googleapis.com` when not enabled (SKIP otherwise).
- Grants `catalog-worker@image-links-agent.iam.gserviceaccount.com` the role
  `roles/iam.serviceAccountTokenCreator` on itself (needed for `signJwt`) when not granted (SKIP
  otherwise). If the resource-level grant is denied, grant at project level instead and note it in
  `docs/solutions/` (repo rule).
- Prints the worker service account's numeric unique id (its OAuth client id, not a secret) and the
  exact scope, for the owner's Workspace step below. A second run prints all SKIP and exits 0.
- `infra/deploy.sh` passes `NOTIFY_SENDER` (default empty, so F14 is off), `NOTIFY_AFTER_MINUTES`
  (default 5) and `WEB_URL` (the canonical web address) into the worker env. No secret is added.

Prerequisite (one-time, the owner; the single open item of this release):

1. Choose the sender mailbox: an existing licensed Google Workspace user mailbox of the company domain
   that may send these emails (recommended: a dedicated mailbox such as a catalog notifications
   address, so replies and bounces do not land in a person's inbox). A group address cannot be the
   sender.
2. A Workspace super admin opens the Admin console, Security, Access and data control, API controls,
   Manage domain wide delegation, adds a new client with the client id printed by `infra/notify.sh`
   and exactly the scope `https://www.googleapis.com/auth/gmail.send`, and saves.
3. The owner tells the manager the sender address; it goes into the deploy env as `NOTIFY_SENDER` (an
   address, not a secret) and the worker is redeployed with `infra/deploy.sh`.

Risk: low to medium. Domain-wide delegation lets the worker's service account request a token for any
mailbox of the domain with the granted scope; the mitigation is the single `gmail.send` scope, the code
that only ever uses `NOTIFY_SENDER` as the subject (unit-tested), and the keyless setup (there is no key
that could leak). Deliverability is Gmail's own within the domain. Size M. Dependencies: F6 worker side
(phase `ready` and `needs_input`, 14c section 3.2), F8 ("Fix and continue", 14c section 3.4), F4 part 2
(`cancelled`, 14c section 3.1).

Acceptance:

- Tier 1: the composer gives the exact subject, body and closing line for each outcome (with thousands
  separators and plurals through `plural`), the link `<WEB_URL>/catalog/<id>`, and passes the
  no-model-names test; the MIME builder gives a valid UTF-8 plain-text message whose `raw` decodes back
  to it; the token request always carries `sub = NOTIFY_SENDER` and only the `gmail.send` scope.
- Tier 2 (`ingest.test.ts`, `sweep.test.ts`, a fake mail transport and a fake fetch for the token
  calls): a collection of 6 minutes (fake clock) that reaches `ready` sends exactly one message to
  `createdBy`; further deliveries and a Cloud Tasks retry after that send nothing more; a collection of
  3 minutes sends nothing; `needs_input` and failed-before-start each send their message; a batch
  cancelled during collection sends nothing; a started batch sends nothing; with `NOTIFY_SENDER` empty
  nothing is sent and the INFO skipped line is logged; a transport error logs the WARN line, leaves the
  batch unchanged and is not retried; after Fix and continue a new collection of 6 minutes sends again;
  the sweep failing a long-stalled collection sends the could-not-start message once; no log line
  contains an email address or a token.
- Tier 2 (token flow, fake fetch): one `signJwt` call for the worker's own service account with claims
  `iss` (the worker account), `sub` (`NOTIFY_SENDER`), `scope`, `aud`
  (`https://oauth2.googleapis.com/token`), `iat` and `exp`; one token exchange with the JWT bearer
  grant; one `POST .../gmail/v1/users/me/messages/send` with the `raw` body.
- Infra: `infra/notify.sh` run twice; the second run is all SKIP and exits 0.

## 4. Data and state changes

No migration. Rows of the parent data table (section 5) implemented here: manifest `attempts` and
`final`; `place-state.json`; `options.expired`; the worker task `/tasks/catalog/ingest-more`; env
`DRAFT_EXPIRY_DAYS` (14, decided 2026-10-27); and for F14 `counts.collectStartedAt`, `counts.notified`
and the worker env `NOTIFY_SENDER`, `NOTIFY_AFTER_MINUTES` and `WEB_URL`. Builder constants
`LINK_RETRY_ATTEMPTS`, `LINK_MAX_ATTEMPTS`, `INGEST_TIME_BUDGET_MS`, `PLACE_BUDGET_ITEMS` and
`HAND_OFF_PAGE` (parent section 5).

## 5. Copy

Exact sentences are in the fixes above and in the parent copy register (section 6), rows marked "D":
Link failures card ("Transient problems were tried <attempts> times."); State words ("Expired after <N>
days with no activity"); Same photos pair; Duplicate photo pair; Finished-collection email (all
subjects, bodies and the closing line). No sentence is removed by this release.

## 6. Acceptance tests

- Tiers 1 and 2 (`pnpm test`, CI): every "Acceptance" item in section 3, in the test files named there,
  and the general rules of parent 8.2. The `groupBatch` timing at about 2,000 fake products (section
  3.1) is measured and reported.
- Browser test (parent 8.3 harness): no new scenario; scenarios 1 to 7 still pass.
- Tier 3 and tier 4: not required. Tier 5: runs inside `infra/deploy.sh` as always.

## 7. Fixtures

No new fixture file. Uses `intake-large-sheet.csv` (its `_OD` identifiers for F10) and the tier 2
fakes named in section 3 (1,000 and 1,200 fake items, about 2,000 fake products for the `groupBatch`
timing).

## 8. Local verification

From the feature worktree:
`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`, then
`pnpm --filter @catalog/web exec playwright test --config test/catalog-intake.config.ts` (scenarios 1
to 7 green). `bash infra/notify.sh` is run by the manager from the main checkout after merge, never by
a builder (00 section 1).

## 9. Live verification (after deploy, Test Brand only)

Step 0: the quiet check and the rules of parent 8.4. Every batch a step makes is cancelled through the
UI at the end.

1. An options-only change on step 2 of a ready batch regroups with zero copies (the INFO line per
   delivery shows it); two Test Brand drafts with the same photos show the same-photos warning on step
   4 with a working link to the other batch; one sweep run cancels no draft younger than
   `DRAFT_EXPIRY_DAYS`.
2. F14 off: with `NOTIFY_SENDER` empty, a Test Brand collection logs the INFO skipped line and no email
   arrives.
3. F14 on (only after the prerequisite of section 3.6 is done, and only while the quiet check holds):
   deploy once with `NOTIFY_SENDER` set and `NOTIFY_AFTER_MINUTES=0`, create a Test Brand batch as the
   owner from a 30-photo Google Sheet, Continue, and confirm that exactly one "is ready to check" email
   arrives in the owner's inbox from the sender, with a working link to the batch and no technical
   words; press Continue on step 2 with no change and confirm no second email. Then deploy again with
   the default `NOTIFY_AFTER_MINUTES` and confirm the worker env shows 5. If the prerequisite is not
   done yet, this step is reported as waiting on the owner and the release is otherwise done.
4. Clean the run's batch objects with `deleteTestObjects` and confirm an empty listing of the run's
   prefixes.

## 10. Rollout and rollback

Merge. From the main checkout on `main`: `bash infra/notify.sh` (then a second run, all SKIP), then
`infra/deploy.sh` deploys worker and web with `NOTIFY_SENDER` empty; the tier 5 smoke runs inside
deploy.sh as always. When the owner has done the prerequisite, set `NOTIFY_SENDER` in the deploy env
and deploy again (section 9 step 3). Rollback per 00 section 6 (`SKIP_BUILD=1` from the previous
commit). F14 alone is switched off by deploying with `NOTIFY_SENDER` empty; `infra/notify.sh` changes
nothing that needs undoing (an enabled API and a role on the worker's own account).

## 11. Report

The 00 section 10 report, plus: the per-fix acceptance results; the live verification log of section 9
with the quiet-check timestamps and the cleanup listing; the measured `groupBatch` time at about 2,000
fake products (section 3.1); the contract changes proposed to 02 (the `ingest-more` task, the
`BatchCounts` fields `collectStartedAt` and `notified`); the `infra/notify.sh` second-run output; and
whether the F14 prerequisite is done (if not, the last line is "Blocked: the F14 Workspace step of 14d
section 3.6" with the client id and scope to hand to the admin). Otherwise the last line is "Spec 14
complete; no next release."

## 12. Done when

- [ ] F7 part 2, F5 part 2, F10, F11 part 2, F12 and F14 are built and every acceptance item in section
      3 passes in CI.
- [ ] The `groupBatch` timing is measured and reported (an open issue if it does not fit with a wide
      margin).
- [ ] `infra/notify.sh` is idempotent (second run all SKIP).
- [ ] PR D merged; `catalog-worker` and `catalog-web` deployed with F14 off; tier 5 smoke green.
- [ ] Live verification steps 1, 2 and 4 of section 9 done with the quiet check logged and
      `catalog-test/` cleanup confirmed.
- [ ] F14 switched on and live step 3 done, or reported as the single open item waiting on the owner.
- [ ] Report written.

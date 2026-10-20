# Spec 05 acceptance and access follow-ups

Status reconciled 2026-10-20 after local archive verification. Historical test evidence and current deployed acceptance are tracked separately.

The product owner authorized continuing through specs 06 and 07 and merging reviewed code when its code checks pass. Checks blocked by organization access may carry forward explicitly. This does not authorize bypassing runtime authentication or the public-image smoke gate, and does not make deferred checks pass.

## Verified

- TypeScript: 504 tests in 51 files passed, plus configured lint and all three package type checks. The subsequent GPU lifecycle repair passed 20 Python tests. The font-only worker packaging change passed actual Linux font discovery and distinct-glyph probes.
- Completed source review identified two actionable defects. Commits `1c3da7f` and `6cb4578` fix the identity-token deadline and inverted-mask probe respectively, with regression evidence. The original review receipt and its initial not-ready verdict remain preserved in the execution artifacts.
- Private CPU and GPU service images built successfully. Deployed worker-identity probe `catalog-check-matting-bq2fm` passed authentication, HEIC conversion, mask foreground/background checks and general/lite/general model switching on both services.
- Benchmark `catalog-test-real-zxvkd` completed 100 genuine sources for each of four model/target combinations. Inference means in milliseconds: CPU general 42479.12, CPU lite 25596.69, GPU general 693.98, GPU lite 435.57. Strict target assertions reject CPU fallback when measuring GPU.
- Production-default general-model audit `catalog-test-real-gp422` completed 630 sources, independently checked as 126 identifiers with five shots each. Shadow counts: 377 preserved, 253 synthesised. The earlier lite audit's 290 synthesised shadows were expected shadow decisions, not 290 failed images.
- Twelve general-model contact-sheet samples were viewed. The sampled black garment detail lost by lite was preserved by general. This does not claim all 630 photos were individually inspected. The Anta input also contains apparel; the forced-footwear audit is a shadow test, not product classification evidence. A separate correctly typed apparel render preserved the garment body.
- Actual repository contact-sheet rendering with the font-fixed image produced readable identifiers and shot labels. Private test-job setup repeated with all three jobs reporting SKIP and exit 0; this is not bootstrap or public-smoke acceptance.

## Full dataset run: failed

Cloud Build `1ac2bc2a-f937-4cc5-bcb2-e9d9875bdec3` in `us-central1` ran from 2026-10-18 19:49:23 UTC to 2026-10-19 09:28:25 UTC and ended **FAILURE**. It is no longer running. The renderer reported two French Connection compliance failures, and the final test-result step correctly returned exit 1. The archive-upload step succeeded; the failure was not just an upload problem.

The completed French Connection render reported 29,520 planned outcomes: 26,238 compliant JPEGs, 3,280 documented Styli skips and two `failed_compliance` outcomes. The Anta dataset test and the 100-source CPU benchmark passed. Because the French Connection CLI returned exit 1, that dataset's subsequent independent report checks and private upload-sample checks did not run. These are not passing acceptance results.

The private results archive is `catalog-test/render-05-1792340617303-555901/artifacts/render05-artifacts.tar.gz` in `image-links-agent-assets`, generation `1792402090149576`, size 7,389,924,481 bytes. Retrieval completed on 2026-10-20. A complete local gzip/tar scan found 39,800 files; archive SHA-256 is `5ebd54cad7622c3d61d7dbaa7be506f98269ba3c527b276573c31e72a8558320`. Independent reconciliation matched every source/shot/channel key, successful JPEG byte size and JPEG signature, status total and flag count against the saved manifests and reports:

| Dataset | Products | Source photos | Planned outcomes | Saved JPEGs reported compliant | Styli skips | Failed outcomes |
|---|---:|---:|---:|---:|---:|---:|
| Anta | 126 | 630 | 5,670 | 5,040 | 630 | 0 |
| French Connection | 607 | 3,280 | 29,520 | 26,238 | 3,280 | 2 |
| Total | 733 | 3,910 | 35,190 | 31,278 | 3,910 | 2 |

Both failures concern French Connection identifier `ZE55EA67E0EB5401B1C25Z`, shot 3, on Noon and Namshi. Both report `background` and `inside_safe_box` failures: wrong exposed-background colour and content outside required margins. Neither failed row has a saved JPEG. The source and five successful outputs on other channels were viewed for context; those are not visual evidence of the absent failed JPEGs.

The Anta distributed contact sheet covering 12 products and the original French Connection first-90-output sheet were viewed. A separate local comparison sampled 12 products spread across the 607 sorted French Connection identifiers, showing the original and Noon/Centrepoint outputs for each first and last shot. Sampled source bytes matched their manifest hashes, and decoded output dimensions matched their recorded plans. This found a visual defect despite a passing compliance report: `Z885F1C32E63514305936Z`, shot 5, loses most of the green jumper fabric, leaving narrow fragments. Cropped-source edges also visibly float inside the earlier canvas placement. These observations are historical failures, not a visual pass. Current acceptance should include these exact source cases when verifying the newer matting guard and cut-edge fixes; their presence in a later deployment is not proof that these examples passed.

The archived test log records the Anta private upload sample deleting 16 objects with zero remaining. French Connection never reached its upload sample. The same build's separate 100-source CPU benchmark recorded mean inference 15,317.39 ms for general and 7,489.93 ms for lite; GPU was not configured in this build. The earlier four-combination deployed benchmark above is separate evidence.

Local audit records are retained under the ignored `var/spec05-full-evidence/` folder: `archive-inventory.json`, `archive-sha256.txt`, `independent-verification.json`, extracted metadata, and `visual-samples/selection.json` with the comparison sheets. The audit checked archive consistency and sampled appearance. It did not repeat pixel-level compliance for every JPEG or inspect every photo. The archived run used `birefnet-general-lite` and the earlier rendering rules; it does not certify the newer implementation or the production-default general model.

Specs 05, 06 and 07 subsequently merged through PRs [11](https://github.com/sujanajay/catalog-module/pull/11), [12](https://github.com/sujanajay/catalog-module/pull/12) and [14](https://github.com/sujanajay/catalog-module/pull/14). The expedited workflow explicitly accepted reduced testing and records newer deployments, quality fixes and the pending deployed full-data run in [Go-live progress](../PROGRESS.md). A merge or a smaller smoke test does not turn this failed historical run into a pass.

## Former external-access blocker: resolved

The earlier `iam.allowedPolicyMemberDomains` restriction and denied `orgpolicy.policies.create` request are historical. Read-only bucket IAM checks on 2026-10-20 confirmed that `image-links-agent-public` grants `allUsers` the object-viewer role, while `image-links-agent-assets` has no such grant. An anonymous HEAD request to the known existing private results archive returned 403. The newer workflow records anonymous JPEG reads, public smoke and protected service deployments in [Go-live progress](../PROGRESS.md). Do not repeat the denied policy writes or present the old administrator dependency as still blocking deployment.

Keep source assets private and preserve runtime authentication and mandatory smoke gates. Remaining current acceptance work, including the fresh full-data run and any required recorded browser evidence, is tracked in the current progress record; it must not be inferred from the old private service checks or local mocked UI tests.

## Data and budget

Original photos and Supabase remain read-only. Retain the approved private source prefix until the full run is retrieved and downstream source consumers finish. Retrieve evidence before cleanup; clean only exact authorized `catalog-test/` prefixes and object versions, preserve soft deletion, and delete no GCP resources.

The original shared additional-cloud cap for this chat is USD 100 across specs 05 through 07. The earlier USD 91.92242 figure was an estimate including reservations, not actual billing. The completed full build lasted 49,141.9028624 seconds: at the existing USD 1.44/hour assumption, its estimated compute is USD 19.65676 rather than the reserved USD 34.56 maximum. That reconciles the historical estimate/reservation total to USD 77.01918, including the earlier deployment and storage allowances. It excludes subsequent spending by the newer workflow and is not a statement of current account-wide spend or available budget. Actual billing remains unavailable; no new paid testing was started for this evidence follow-up.

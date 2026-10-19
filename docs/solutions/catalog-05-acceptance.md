# Spec 05 acceptance and access follow-ups

Status recorded 2026-10-19 04:00 UTC. Code completion and deployed acceptance are tracked separately.

The product owner authorized continuing through specs 06 and 07 and merging reviewed code when its code checks pass. Checks blocked by organization access may carry forward explicitly. This does not authorize bypassing runtime authentication or the public-image smoke gate, and does not make deferred checks pass.

## Verified

- TypeScript: 504 tests in 51 files passed, plus configured lint and all three package type checks. The subsequent GPU lifecycle repair passed 20 Python tests. The font-only worker packaging change passed actual Linux font discovery and distinct-glyph probes.
- Completed source review identified two actionable defects. Commits `1c3da7f` and `6cb4578` fix the identity-token deadline and inverted-mask probe respectively, with regression evidence. The original review receipt and its initial not-ready verdict remain preserved in the execution artifacts.
- Private CPU and GPU service images built successfully. Deployed worker-identity probe `catalog-check-matting-bq2fm` passed authentication, HEIC conversion, mask foreground/background checks and general/lite/general model switching on both services.
- Benchmark `catalog-test-real-zxvkd` completed 100 genuine sources for each of four model/target combinations. Inference means in milliseconds: CPU general 42479.12, CPU lite 25596.69, GPU general 693.98, GPU lite 435.57. Strict target assertions reject CPU fallback when measuring GPU.
- Production-default general-model audit `catalog-test-real-gp422` completed 630 sources, independently checked as 126 identifiers with five shots each. Shadow counts: 377 preserved, 253 synthesised. The earlier lite audit's 290 synthesised shadows were expected shadow decisions, not 290 failed images.
- Twelve general-model contact-sheet samples were viewed. The sampled black garment detail lost by lite was preserved by general. This does not claim all 630 photos were individually inspected. The Anta input also contains apparel; the forced-footwear audit is a shadow test, not product classification evidence. A separate correctly typed apparel render preserved the garment body.
- Actual repository contact-sheet rendering with the font-fixed image produced readable identifiers and shot labels. Private test-job setup repeated with all three jobs reporting SKIP and exit 0; this is not bootstrap or public-smoke acceptance.

## Still running, not access-blocked

Full 3910-source all-nine-channel CPU verification, including 630 Anta and 3280 French Connection photos, remains in Cloud Build `1ac2bc2a-f937-4cc5-bcb2-e9d9875bdec3` in `us-central1`. Its hard deadline is 2026-10-19 19:49 UTC. The complete archive, output and skip counts, metadata, compliance, upload cleanup and both contact sheets must be retrieved and independently assessed. A preflight or the separate 630-source audit does not replace this run.

## Deferred because of external access

Organization policy `iam.allowedPolicyMemberDomains` prevents the public JPEG bucket grant. Google Cloud denied `orgpolicy.policies.create` to the current account. An organization administrator must review and apply a narrow exception for `image-links-agent-public` in project `image-links-agent` (847405579637), organization 1013399544102. Keep `image-links-agent-assets` private and preserve the domain restriction elsewhere. Do not retry denied policy writes, self-grant roles or weaken the existing helper's tag-scope guard.

Carry forward into specs 06/07: effective policy and bucket-scope verification, anonymous JPEG reads, bootstrap's unchanged second run, required public pipeline/smoke, full release deployment and recorded deployed browser acceptance. These remain incomplete until observed passing. Private matting service deployment and local mocked UI tests are narrower evidence.

## Data and budget

Original photos and Supabase remain read-only. Retain the approved private source prefix until the full run is retrieved and downstream source consumers finish. Retrieve evidence before cleanup; clean only exact authorized `catalog-test/` prefixes and object versions, preserve soft deletion, and delete no GCP resources.

The shared additional cloud limit remains USD 100 across specs 05 through 07. Current estimated/reserved total is USD 91.92242, including USD 20 remaining deployment reserve and USD 2 storage/transfer allowance. Actual billing is unavailable. Do not treat estimates or reservations as billed spending, or reset the cap for another spec.

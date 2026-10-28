# Google sign-in through Cloud Run IAP - learnings

Spec 03, first deploy 2026-10-18. Script: `infra/deploy.sh` (section 6, Web).

## The domain:opptra.com grant fell back to project level
Symptom: `gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=catalog-web
--region=asia-south1 --member=domain:opptra.com --role=roles/iap.httpsResourceAccessor` was denied,
and even `gcloud iap web get-iam-policy` on the same resource returns
`PERMISSION_DENIED: Permission 'iap.webServices.getIamPolicy' denied on resource
'//iap.googleapis.com/projects/847405579637/iap_web/cloud_run-asia-south1/services/catalog-web'`.

Cause: the operator roles (roles/editor + projectIamAdmin + serviceAccountAdmin) carry no
`iap.webServices.getIamPolicy` / `setIamPolicy`. Those come with `roles/iap.admin`.

What deploy.sh did: granted `roles/iap.httpsResourceAccessor` to `domain:opptra.com` at project level
(`gcloud projects add-iam-policy-binding image-links-agent --condition=None ...`) and printed the WARN
line. A second run prints SKIP plus the same WARN.

Consequence: every `@opptra.com` account may pass IAP for every IAP-protected service in the project,
including the earlier `ila-web` (its two `user:` bindings at project level are unchanged). The
catalog app itself still decides what each person may do through the `users` table.

To narrow it later: an admin grants `roles/iap.admin` to the operator (the operator holds
projectIamAdmin, so it can grant this to itself), re-runs `bash infra/deploy.sh` (the resource-level
call then succeeds and the binding lands on `catalog-web` only), and removes the project-level
binding with `gcloud projects remove-iam-policy-binding image-links-agent --member=domain:opptra.com
--role=roles/iap.httpsResourceAccessor --condition=None`. deploy.sh's check finds the resource-level
binding first, so the next run is SKIP without the WARN.

## Verifying IAP after a deploy
- `gcloud run services describe catalog-web --region=asia-south1
  --format='value(metadata.annotations."run.googleapis.com/iap-enabled")'` prints `true` (deploy.sh
  exits 1 otherwise).
- `curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$WEB_URL/catalog"` without cookies answers
  302 to `https://accounts.google.com/o/oauth2/v2/auth?client_id=...` (Google-managed OAuth client;
  no client of ours exists).
- The migrate job logs `migrate: admin sujan@opptra.com seeded` on the first run and nothing about the
  admin afterwards (`ON CONFLICT DO NOTHING`).

## The deploy gate through IAP (spec 17 3.2.3)
Symptom (2026-10-28, fourth gated deploy): the web probe got `GET <candidate tag URL>/health -> 401` in 2 s.
Reproduced read only the same day, printing HTTP codes only: on both the live URL and the candidate tag URL, no
token gives 302 (to Google sign-in, so IAP fronts tag URLs too), and the operator's `gcloud auth
print-identity-token` and `gcloud auth print-access-token` both give 401, although the operator holds
`roles/iap.httpsResourceAccessor`.

Cause: catalog-web uses IAP's Google-managed OAuth client. The IAP programmatic access guide
(docs.cloud.google.com/iap/docs/authentication-howto, read 2026-10-28) says that with that client and no
allowlisted programmatic OAuth clients, "you cannot use OAuth 2.0 client-based programmatic access"; a user's ID
token is for some OAuth client (gcloud's), so it is refused. Service accounts can still use a self-signed JWT or an
OAuth access token with the `openid` and `userinfo.email` scopes, once the account is on the IAP access list.
Allowlisting gcloud's client instead would need IAP settings rights (`roles/iap.admin`), which the operator lacks.

Fix: the probe runs as the smoke's identity, catalog-worker@ (the catalog-test-smoke job runs as it).
`infra/lib/services.sh` (`iap_token`) asks the IAM Credentials API `generateAccessToken` for catalog-worker@ with
exactly those two scopes (the installed gcloud has no `--scopes` on `print-access-token`) and sends it as
`Authorization: Bearer`. An access token has no audience, so the tag URL needs nothing special (a self-signed JWT
would need `aud` = the exact URL or `https://<host>/*`, per host). Tokens go to curl on stdin and are never printed.

Grants (in `infra/bootstrap.sh`, applied by the next bootstrap run, idempotent):
- `roles/iap.httpsResourceAccessor` for `serviceAccount:catalog-worker@` at project level. Resource level on
  catalog-web needs `roles/iap.admin` (above). Side effect: catalog-worker@ may also pass IAP on the earlier
  ila-web; nothing in the worker calls it. In catalog-web the account is outside opptra.com, so the app is
  expected to show its refusal line (app/layout.tsx renders it with HTTP 200; not yet seen live): the home-page
  probe shows IAP and the server work, not a person's access.
- `roles/iam.serviceAccountTokenCreator` on catalog-worker@ (resource level, never project level, which would
  reach every service account in the project) for the account running bootstrap (`gcloud config get-value
  account`). Another operator who deploys needs the same grant: run bootstrap once as that account. With
  `auth/impersonate_service_account` set in gcloud, the probe's caller is that service account, not this account.
New IAM grants can take a few minutes to apply: a deploy right after bootstrap may still get 401 or 403 and stop
safely (traffic unchanged); re-run it a few minutes later.
If the first live run still gets 401 with the access token, the documented fallback is a self-signed JWT for the same
service account (IAM Credentials `signJwt`, `iss` = `sub` = the account, `aud` = `https://<tag host>/*`, `exp` within
1 hour); it needs the same Token Creator grant.
Verify after bootstrap: `gcloud iam service-accounts get-iam-policy catalog-worker@image-links-agent.iam.gserviceaccount.com`
lists the operator under Token Creator, and `node infra/tests/gate.test.mjs` passes offline. The first gated deploy
after bootstrap is the live proof (`probe: GET <tag URL>/health -> 200`).

## Git Bash rewrites "/projects/..." inside --set-env-vars
Symptom (found while building, reproduced with node.exe): `IAP_AUDIENCE=/projects/<n>/locations/...`
passed in `--set-env-vars` arrived as `C:/Users/<user>/AppData/Local/Programs/Git/projects/<n>/...`.
Cause: MSYS path conversion treats a value that starts with `/` as a POSIX path. Fix: the web deploy
runs with `MSYS2_ARG_CONV_EXCL='--set-env-vars='` for that one command, which excludes only that flag
and keeps the conversion the gcloud launcher needs (`MSYS_NO_PATHCONV=1` would break the launcher).
Any future env value or flag that starts with `/` needs the same treatment.

## google-auth-library returns PEM keys, not JWKs
`OAuth2Client.getIapPublicKeys()` (google-auth-library 11) fetches
`https://www.gstatic.com/iap/verify/public_key` (key id -> PEM), not the JWK URL spec 03 names. It
plugs straight into `verifySignedJwtWithCertsAsync`. That call checks `exp` against the real clock, so
tests sign expired tokens with a past `exp` instead of faking `now`.

## Sign-out
"Sign out" goes to `/?gcp-iap-mode=CLEAR_LOGIN_COOKIE`, which clears IAP's cookie and shows Google's
sign-in page again; the Google account itself stays signed in.

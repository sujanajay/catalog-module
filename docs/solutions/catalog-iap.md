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

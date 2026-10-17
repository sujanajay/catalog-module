# 03 Auth and roles

Execute with `docs/specs/00-execution-protocol.md`. Source of truth: `docs/SPEC.md`. Depends on 02
(scaffold, schema, `errors.ts`, `bootstrap.sh`, `deploy.sh`). Visual contract: `01-ui-prototype.md`
for the user menu and the People modal (the 01 sign-in card is superseded, see "UI" below).

Branch `feat/catalog-03-auth-and-roles`. This spec deploys the web service.

## Goal

Anyone with an `@opptra.com` Google account can sign in and view. Admins manage people (who is an
operator, who is an admin). Operators act (create batches, resolve attention items, add SKU ids and
aliases). The worker and the matting service stay service-to-service with OIDC tokens (defined in 02,
`apps/worker/src/auth.ts`); no person ever calls them.

No console step. Everything the sign-in needs is created by `infra/bootstrap.sh` and
`infra/deploy.sh` with gcloud, idempotently. Nobody creates an OAuth client, pastes a client secret
or clicks through a consent screen.

Plain-language notes:
- "IAP" (Identity-Aware Proxy) is Google Cloud's sign-in gate in front of a Cloud Run service. Every
  request to `catalog-web` first meets IAP; IAP sends the person to Google's own sign-in page, checks
  that the account is allowed, and only then forwards the request to the app with the person's
  identity attached.
- "Google-managed OAuth client": IAP on Cloud Run uses an OAuth client that Google owns and
  configures. We never see it or touch it. Its one limitation suits us: only accounts of the
  organisation that owns the project (Opptra's Google Workspace) can sign in through it.
- "IAP JWT" is a signed token (`x-goog-iap-jwt-assertion` header) IAP adds to every forwarded
  request. The app verifies its signature against Google's public keys, so an identity cannot be
  forged even if someone found a way around IAP. The plain `x-goog-authenticated-user-email` header
  is never trusted; it is only informational.
- "Role" is one of `admin`, `operator`, `viewer` (defined in 02, `ROLES`). Order: admin > operator >
  viewer. "At least operator" means operator or admin. IAP decides who may sign in (any Opptra
  account); the app's `users` table decides what each person may do.

## Why IAP and not a sign-in library

- The owner asked that the Google sign-in setup be done by us, with no manual console step. An
  in-app sign-in library (Auth.js with the Google provider) needs a Google OAuth client with our
  redirect URI, and that client can only be created in the console: the IAP OAuth Admin APIs
  (`gcloud iap oauth-brands`, `gcloud iap oauth-clients`) were shut down in March 2026 and the
  clients they made had fixed IAP redirect URIs anyway.
- IAP on Cloud Run (`gcloud run deploy --iap`) needs no OAuth client of ours at all: with the
  Google-managed client the only configuration is IAM. The earlier app in this project (`ila-web`)
  already runs this way (`run.googleapis.com/iap-enabled: true`), its IAP service agent already
  holds `roles/run.invoker`, and the project sits in the Opptra organisation, so the internal-only
  limitation of the Google-managed client is exactly the `@opptra.com` restriction we want.
- IAP also re-checks IAM on every request, blocks unauthenticated traffic before it reaches the app,
  and the service itself stays private (only IAP's service agent may invoke it).

## Scope and non-scope

In scope: IAP on `catalog-web` with every `@opptra.com` account allowed (`domain:opptra.com`); the
IAP JWT verification; the `users` table and migration `0001_users.sql`; the seeded admin;
`currentUser()` and `requireRole()`; the People modal and its API routes; the user menu with
"Sign out"; "Preview as viewer"; the Playwright login helper that saves a browser state for the
human-like tests of later specs; the `bootstrap.sh` and `deploy.sh` changes.

Out of scope: every `/catalog` page and `/api/catalog/*` route (04 to 07 add them and call
`requireRole` as this spec defines); a custom OAuth client or brand (not needed, and the admin APIs
are gone); a sign-in page of our own (Google's IAP page does it); any role beyond the three; SSO for
the worker (stays OIDC); a load balancer or custom domain (IAP runs on the default `run.app` URL).

## Files to add or change

```
apps/web/lib/iap.ts                                NEW  verifyIapJwt(token, audience, deps?) -> { email, sub }; cached IAP public keys
apps/web/lib/auth-rules.ts                         NEW  allowedEmail(email, allowedDomain): boolean (pure; unit tested)
apps/web/lib/user.ts                               NEW  currentUser(), requireRole(), atLeast(), CurrentUser type (lifted from the earlier app and rewritten: JWT, not the plain header)
apps/web/lib/errors.ts                             CHANGE add ForbiddenError (HTTP 403) and the 401 branch
apps/web/app/page.tsx                              CHANGE redirect to /catalog (02's placeholder goes); /catalog itself arrives with 06, so until then it is a one-line page "Catalog images" that already calls currentUser()
apps/web/app/layout.tsx                            CHANGE renders UserMenu in the top bar
apps/web/components/UserMenu.tsx                   NEW  "<email> · <Role> ▾" with People (admins) and Sign out
apps/web/components/PeopleModal.tsx                NEW  People modal (copy below) incl. "Preview as viewer"
apps/web/components/ViewerPreview.tsx              NEW  client-side context + toggle used by action controls to hide themselves
apps/web/app/api/people/route.ts                   NEW  GET (viewer), POST (admin)
apps/web/app/api/people/[email]/route.ts           NEW  PATCH (admin), DELETE (admin)
packages/core/src/db/schema.ts                     CHANGE add the users table
packages/core/drizzle/0001_users.sql               NEW  generated with drizzle-kit
packages/core/src/people.ts                        NEW  listPeople, upsertPerson, removePerson, roleFor
apps/worker/src/migrate.ts                         CHANGE seed the admin from SEED_ADMIN_EMAIL after migrations
infra/bootstrap.sh                                 CHANGE IAP API, IAP service agent, its roles/run.invoker (replaces the three auth secrets of the first draft)
infra/deploy.sh                                    CHANGE catalog-web with --iap and private invoker IAM; IAP_AUDIENCE and ALLOWED_HOSTED_DOMAIN env; domain:opptra.com -> roles/iap.httpsResourceAccessor; migrate job env SEED_ADMIN_EMAIL
apps/web/test/human/login.ts                       NEW  Playwright helper that saves .playwright/auth-state.json
apps/web/test/human/auth.human.spec.ts             NEW  short human-like spec (tier 4)
apps/web/package.json                              CHANGE add google-auth-library (remove next-auth if 02 added it), dev @playwright/test
```

No `apps/web/auth.ts`, no `middleware.ts`, no `/signin` page, no `/api/auth/*` route: IAP owns
sign-in, sign-out and the unauthenticated redirect.

## Contracts

### IAP on `catalog-web` (gcloud only; `infra/bootstrap.sh` and `infra/deploy.sh`)

Commands confirmed against the current Cloud Run IAP docs and the installed SDK (`gcloud run deploy
--[no-]iap`, SDK 579); builders re-confirm with the docs before coding.

`bootstrap.sh` (check-then-create, re-runnable; adds to 02's step list):
1. APIs: `iap.googleapis.com` and `cloudresourcemanager.googleapis.com` (the `--iap` flag needs it;
   without it gcloud asks an interactive question and a script hangs; learning from the earlier app).
2. IAP service agent: `gcloud beta services identity create --service=iap.googleapis.com`
   (idempotent; the agent is `service-<project-number>@gcp-sa-iap.iam.gserviceaccount.com`).
3. `project_binding serviceAccount:service-<project-number>@gcp-sa-iap.iam.gserviceaccount.com
   roles/run.invoker` (project level, the pattern 02 lifts; the binding already exists in this project
   from the earlier app, so the step prints SKIP).

`deploy.sh` (idempotent):
1. `catalog-web`: `gcloud run deploy catalog-web --quiet --image="$AR/web:$TAG"
   --service-account=catalog-web@... "$(auth_flag catalog-web)" --iap ...` with the sizing from 02.
   `auth_flag` (02) gives `--no-allow-unauthenticated` on first creation and `--invoker-iam-check`
   afterwards; both keep the service private so only IAP's service agent can invoke it. Cloud Run
   enforces IAP before the invoker check, on every ingress path including the default URL. Verify
   with `gcloud run services describe catalog-web --format='value(metadata.annotations."run.googleapis.com/iap-enabled")'`
   equal to `true`.
2. Env for the web: `IAP_AUDIENCE=/projects/<project-number>/locations/asia-south1/services/catalog-web`
   (the project number from `gcloud projects describe image-links-agent --format='value(projectNumber)'`),
   `ALLOWED_HOSTED_DOMAIN=opptra.com`, plus the shared env and `DB_PASSWORD` secret from 02. No auth
   secrets.
3. Who may sign in: `roles/iap.httpsResourceAccessor` for `domain:opptra.com` (the IAM principal for
   every account of the Workspace domain). Resource level first, check-then-create:
   `gcloud iap web get-iam-policy --resource-type=cloud-run --service=catalog-web --region=asia-south1`
   and, when the member is missing,
   `gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=catalog-web
   --region=asia-south1 --member=domain:opptra.com --role=roles/iap.httpsResourceAccessor`.
   If the operator's roles deny the resource-level call (CLAUDE.md: resource-level IAM on Cloud Run
   may be denied), fall back to the project-level binding
   `gcloud projects add-iam-policy-binding image-links-agent --condition=None
   --member=domain:opptra.com --role=roles/iap.httpsResourceAccessor`, print a WARN line that this
   also lets every Opptra account open the earlier `ila-web`, and record it in
   `docs/solutions/catalog-iap.md`. The earlier app's two `user:` bindings are left alone.
4. The migrate job adds `SEED_ADMIN_EMAIL=${SEED_ADMIN_EMAIL:-sujan@opptra.com}`.
5. Prints `web: https://catalog-web-<project-number>.asia-south1.run.app` (deterministic URL).

Nothing in this spec prints, reads or stores a secret. There is no OAuth client id or secret
anywhere in the repo, in Secret Manager or in the deploy. The `gcloud iap oauth-brands` and
`gcloud iap oauth-clients` commands are not used (deprecated and shut down); the project's existing
brand record from the earlier app is left untouched.

### The IAP identity in the app (`apps/web/lib/iap.ts`, `auth-rules.ts`, `user.ts`)

Call shapes confirmed in the current `google-auth-library` docs and the IAP signed-headers guide
(builders re-confirm with Context7 before coding):

```ts
// apps/web/lib/iap.ts
import { OAuth2Client } from "google-auth-library";

export const IAP_JWT_HEADER = "x-goog-iap-jwt-assertion";
export const IAP_ISSUER = "https://cloud.google.com/iap";
export const IAP_KEYS_TTL_MS = 60 * 60 * 1000;          // builder constant: re-fetch keys hourly, or at once on an unknown key id

export interface IapIdentity { email: string; sub: string }
export interface IapDeps { getKeys(): Promise<Record<string, string>>; now?(): number }

export async function verifyIapJwt(token: string, audience: string, deps?: IapDeps): Promise<IapIdentity>;
```

Default `getKeys` is `new OAuth2Client().getIapPublicKeys()` (`pubkeys`, the JWK set published at
`https://www.gstatic.com/iap/verify/public_key-jwk`), cached in module scope for `IAP_KEYS_TTL_MS`
and refreshed once when the token's `kid` is unknown. Verification is
`client.verifySignedJwtWithCertsAsync(token, keys, audience, [IAP_ISSUER])`: ES256 signature, `exp`,
`iss` and `aud` are all checked by the library. `verifyIapJwt` then requires a non-empty `email`
and `sub` claim and returns them with the email lowercased; any failure throws
`HttpError(401, "Sign in to continue.")`. The `aud` is the exact Cloud Run audience
`/projects/<project-number>/locations/asia-south1/services/catalog-web` from `IAP_AUDIENCE`, so a token
minted for any other IAP resource is refused.

`allowedEmail(email, allowedDomain)` (`auth-rules.ts`, pure): lowercases, requires one `@` and the
local part non-empty, and `email.endsWith("@" + allowedDomain)`. IAP's Google-managed client and the
`domain:opptra.com` grant already restrict sign-in to Opptra accounts; this check is the app's own
guard so a change of the IAM grant can never widen who the app accepts.

```ts
// apps/web/lib/user.ts
export type CurrentUser = { email: string; role: Role };
export async function currentUser(): Promise<CurrentUser>;        // headers() -> verifyIapJwt -> allowedEmail -> roleFor(db, email) on every call
export async function requireRole(min: Role): Promise<CurrentUser>; // throws ForbiddenError when the role is below min
export function atLeast(role: Role, min: Role): boolean;            // admin > operator > viewer
```

`currentUser()` reads the header with `await headers()` (server components) or `request.headers`
(route handlers; one helper takes either), verifies the JWT against `process.env.IAP_AUDIENCE`,
applies `allowedEmail` with `ALLOWED_HOSTED_DOMAIN` (default `opptra.com`), then `roleFor(db, email)`.
It throws `HttpError(401, "Sign in to continue.")` when the header is missing or invalid (IAP makes
this rare: unauthenticated browser requests never reach the app) and `HttpError(403, "Use your
@opptra.com Google account.")` when the verified email is outside the domain. `requireRole` throws
`ForbiddenError` (`apps/web/lib/errors.ts`, HTTP 403) with the sentence "You can view this but not
change it. Ask an admin for the operator role."; `errorResponse` turns it into `{ error }` JSON with
status 403. The role is looked up on every call so a change in the People modal applies at once;
nothing about the role is cached in a cookie.

Local development and tests: when `SKIP_IAP=1` and `NODE_ENV !== "production"`, `currentUser()` skips
the JWT and uses `DEV_USER_EMAIL` (default `sujan@opptra.com`). In production the variable is
ignored and logged once as a warning if set. Tests inject `IapDeps` with locally generated ES256
keys; nothing calls Google.

Every later spec calls `requireRole` at the top of every server action and API route it adds and
states the role in its route table; pages call `currentUser()` and pass `role` to the client so action
controls can hide themselves. Hiding is convenience; the server check is the permission.

### Users table and the auto-viewer rule (`packages/core/src/db/schema.ts`, `0001_users.sql`)

```
users   email text pk (lowercase), role text enum ROLES, added_by text, created_at timestamptz default now, updated_at timestamptz default now
```

Seed: the migrate job (`apps/worker/src/migrate.ts`) runs the migrations, then
`INSERT INTO users (email, role, added_by) VALUES ($SEED_ADMIN_EMAIL, 'admin', 'seed') ON CONFLICT (email) DO NOTHING`
with `SEED_ADMIN_EMAIL` (default `sujan@opptra.com`). Idempotent; a later role change by an admin is
not undone by a redeploy.

Auto-viewer rule: the first time any other verified `@opptra.com` account is seen, a row
`role = viewer, added_by = "sign-in"` is inserted. Removing a person deletes the row; they fall back to
`viewer` on their next request. So "remove" means "back to viewer"; the only way to keep someone out
entirely is to remove their Google Workspace account (IAP then refuses them at Google's sign-in page).

### People data functions (`packages/core/src/people.ts`)

```ts
export interface Person { email: string; role: Role; addedBy: string; createdAt: Date; updatedAt: Date }
export async function listPeople(db: Db): Promise<Person[]>;                               // sorted by role (admin first) then email
export async function upsertPerson(db: Db, input: { email: string; role: Role; addedBy: string }): Promise<Person>;
export async function removePerson(db: Db, email: string): Promise<void>;
export async function roleFor(db: Db, email: string): Promise<Role>;                       // auto-viewer rule: inserts viewer/"sign-in" when missing
```

Rules: emails are lowercased and must end with `@` + the allowed domain, else "Only @opptra.com
addresses can be added." (400); `upsertPerson` and `removePerson` refuse to demote or remove the last
admin with "You cannot remove the last admin." (400); `removePerson` of an unknown email is a no-op.

### Permission matrix (defined here; later specs restate rows they implement)

| Action | viewer | operator | admin |
|---|---|---|---|
| open batch list, batch page, sheet preview, attention tab, product and brand pages, downloads | yes | yes | yes |
| New batch, wizard, Start, Start again | no | yes | yes |
| Use as is / Remove this photo / Replace photo N | no | yes | yes |
| Add SKU ids, Add alias, Remove product, brand sheet export | no | yes | yes |
| People modal: add person, remove person, set role | no | no | yes |
| Preview as viewer | yes (no-op) | yes | yes |

### Route table with required roles

Every request to the service has already passed IAP, so every route has a signed-in `@opptra.com`
user; the role per row is the minimum. There is no public route: `/healthz` of the web is reachable
only by a signed-in person (Cloud Run's own health probes do not pass through IAP). This spec
implements the `/` and `/api/people*` rows and the helper every other row uses; the other rows are
implemented by the spec in brackets.

| Route | Role | Purpose |
|---|---|---|
| `GET /` | viewer | redirect to `/catalog` |
| `GET /catalog` | viewer | batch list (06) |
| `GET /catalog/new` | operator | wizard (06) |
| `GET /catalog/[id]` | viewer | batch page (06) |
| `GET /catalog/brands/[slug]` | viewer | brand page (07) |
| `GET /catalog/products/[brand]/[key]` | viewer | product page (07) |
| `POST /api/catalog/batches` | operator | create draft (06) |
| `GET /api/catalog/batches` | viewer | list (06) |
| `GET /api/catalog/batches/[id]` | viewer | detail (06) |
| `PATCH /api/catalog/batches/[id]` | operator | name, channels, options while `draft` (06) |
| `POST /api/catalog/batches/[id]/uploads` | operator | plan signed PUTs (06, using 04 helpers) |
| `POST /api/catalog/batches/[id]/uploads/[uploadId]/complete` | operator | confirm an upload (06) |
| `POST /api/catalog/batches/[id]/links` | operator | pasted text: detect + instant access check (06, using 04 helpers) |
| `POST /api/catalog/batches/[id]/ingest` | operator | enqueue ingest per upload (06) |
| `GET /api/catalog/batches/[id]/detected` | operator | step 2 data (06, from 04's `DetectedStep2`) |
| `PATCH /api/catalog/batches/[id]/detected` | operator | save the step 2 controls and re-group (06) |
| `GET /api/catalog/batches/[id]/preview` | operator | step 4 data (04, 06) |
| `POST /api/catalog/batches/[id]/start` | operator | lock products, plan chunks, enqueue (06) |
| `GET /api/catalog/batches/[id]/export?format=xlsx\|csv\|report\|filled` | viewer | 302 to signed URL of the latest export; `filled` is the filled product-list workbook (06) |
| `GET /api/catalog/batches/[id]/attention` | viewer | attention items grouped by product (07) |
| `POST /api/catalog/outputs/[id]/decision` | operator | `{decision: "use_as_is" \| "remove"}` (07) |
| `POST /api/catalog/outputs/[id]/replacement` and `.../replacement/complete` | operator | one-shot replacement upload (07) |
| `POST /api/catalog/batches/[id]/sku-map` | operator | mapping sheet (07) |
| `GET` and `POST /api/catalog/batches/[id]/eval-labels` | operator | eval mode labels (08) |
| `GET /api/catalog/brands/[slug]/products?q=` | viewer | product search (07) |
| `POST /api/catalog/brands/[slug]/export` | operator | brand sheet for selected products (07) |
| `POST /api/catalog/products/[id]/aliases` | operator | add alias (07) |
| `DELETE /api/catalog/products/[id]` | operator | remove product (typed confirmation) (07) |
| `GET /api/people`, `POST /api/people`, `PATCH /api/people/[email]`, `DELETE /api/people/[email]` | admin (GET: viewer) | People modal (this spec) |

People route bodies: `POST /api/people` `{ email, role }` -> 201 `Person`; `PATCH /api/people/[email]`
`{ role }` -> 200 `Person`; `DELETE /api/people/[email]` -> 204; `GET /api/people` -> `{ people: Person[] }`.
Errors through `apps/web/lib/errors.ts`: 400 with the sentences above, 403 with the forbidden sentence,
404 "Person not found" for PATCH of an unknown email.

### UI

Sign-in: Google's IAP sign-in page, not ours. An unauthenticated visit to any URL of the service is
sent by IAP to Google's account chooser and comes back signed in; an account outside Opptra sees
IAP's "You don't have access" page and never reaches the app. The `/signin` card described in 01 is
therefore not built; 01's sentence "Use your @opptra.com Google account." is kept as the 403 text of
`currentUser()` for the (normally unreachable) case of a verified non-Opptra identity.

User menu (top bar on every signed-in page): button "<email> · <Role> ▾" (Role capitalised: Admin,
Operator, Viewer). Menu items: "People" (admins only) opens the People modal; "Sign out". "Sign out"
navigates to `/?gcp-iap-mode=CLEAR_LOGIN_COOKIE`, IAP's URL that clears its session cookie and shows
Google's sign-in page again (the Google account itself stays signed in). The builder confirms the
behaviour on the deployed URL; if IAP no longer honours it, the manager reports it as a contract
change (00 section 11) rather than inventing another sign-out.

People modal (copy from 01 and the shared vocabulary): title "People"; help "Anyone with an
@opptra.com Google account can sign in and view. Admins decide who can create batches and resolve
attention items."; one row per person with the email and a role select (Admin / Operator / Viewer)
and a "Remove" link; an add row with a text field placeholder "name@opptra.com", a role select and
the button "Add person"; toast "<email> added as <Role>."; a switch "Preview as viewer" with help
"Hides New batch and the action buttons, as a viewer sees them."; toasts "Previewing as a viewer.
Action buttons are hidden." and "Back to Admin." (or "Back to Operator."); button "Close". Rows for
the signed-in admin show the role select disabled when they are the last admin.

"Preview as viewer" is a client-side toggle (`ViewerPreview` context, remembered in `sessionStorage`)
that hides every action control (New batch, Start, the attention buttons, Add SKU ids, Add alias,
Remove product, the People menu item). It never changes server permissions: an API call made while
previewing is still judged by the caller's real role. Action controls read `useViewerPreview()` and
render nothing when it is on; later specs wrap their controls the same way.

Viewer experience: every page renders; action buttons are absent; a direct API call from a viewer
returns 403 `{ error: "You can view this but not change it. Ask an admin for the operator role." }`.
Server actions and API routes always re-check the role server side.

Expired IAP session during `fetch` calls from the page: IAP answers 401 to requests that carry
`X-Requested-With: XMLHttpRequest` (a redirect otherwise). The web's `fetch` helper sends that header
and, on a 401, shows the toast "Your session ended. Reload to sign in again." with a Reload button;
nothing more elaborate (the session is tied to the Google login and normally lasts as long as it).

### Env vars added by this spec

| Name | Default | Used by |
|---|---|---|
| `IAP_AUDIENCE` | set by `deploy.sh`: `/projects/<project-number>/locations/asia-south1/services/catalog-web` | web |
| `ALLOWED_HOSTED_DOMAIN` | `opptra.com` | web |
| `SKIP_IAP` | unset (local dev and tests only; ignored in production) | web |
| `DEV_USER_EMAIL` | `sujan@opptra.com` (only with `SKIP_IAP=1`) | web |
| `SEED_ADMIN_EMAIL` | `sujan@opptra.com` | migrate job |

The secrets `catalog-auth-secret`, `catalog-google-client-id` and `catalog-google-client-secret` of
the first draft of this spec do not exist and are not created.

### Cloud Run and cookies

`catalog-web` is private (`--no-allow-unauthenticated` on creation, `--invoker-iam-check` afterwards)
with IAP enabled; only IAP's service agent invokes it, and IAP admits only accounts that hold
`roles/iap.httpsResourceAccessor` (`domain:opptra.com`). Inside the app every page and API route calls
`currentUser()` or `requireRole()`, so a request without a valid IAP JWT for our audience is refused
even if it somehow reached the container. The worker and matting services stay private and
OIDC-only (02) and are not behind IAP.

Session cookie: IAP's own (`GCP_IAAP_AUTH_TOKEN_*`, `secure`, `httpOnly`), tied to the Google login
session; the app sets no auth cookie of its own. Signing out clears it (above).

## Workstreams

- A `iap-identity` (worktree `catalog-module-wt/03-iap-identity`): `lib/iap.ts`, `auth-rules.ts`,
  `lib/user.ts`, `errors.ts` change, `page.tsx`, the `fetch` helper's 401 toast, `bootstrap.sh` and
  `deploy.sh` changes. Depends on nothing (uses a stub `roleFor` until merge).
- B `people-data-and-routes` (worktree `.../03-people-data-and-routes`): `schema.ts` users table,
  `0001_users.sql`, `people.ts`, the migrate seed, `/api/people*` routes with their tests.
- C `ui-and-playwright-login` (worktree `.../03-ui-and-playwright-login`): `UserMenu`, `PeopleModal`,
  `ViewerPreview`, layout change, `login.ts`, `auth.human.spec.ts`, Playwright config.
- Integration: merge, run tiers 1 and 2, run `bootstrap.sh` (SKIP lines expected), deploy the web,
  run tier 4 on the deployed URL.

## Test plan

Tier 1 (unit, vitest):
- `allowedEmail`: rejects `someone@gmail.com`; rejects `someone@opptra.com.evil.com`; rejects an
  empty local part; accepts `Someone@Opptra.com` (case does not matter).
- `verifyIapJwt` with injected `IapDeps` (an ES256 key pair generated in the test, `getKeys`
  returning its public JWK under a `kid`): accepts a token with the right `aud`, `iss`, `exp`, `email`
  and `sub`; rejects a wrong audience, a wrong issuer, an expired token, an unknown `kid` (after one
  refresh), a tampered payload, a token without `email`; every rejection is `HttpError` 401 with
  "Sign in to continue."; the public keys are fetched once for many verifications and once more when
  an unknown `kid` appears.
- `atLeast` and `requireRole` ordering: admin satisfies operator and viewer; operator satisfies
  viewer only; viewer satisfies viewer only; the thrown error is `ForbiddenError` with status 403 and
  the exact sentence.
- `currentUser`: no header -> 401; valid JWT with a verified `@gmail.com` email -> 403 "Use your
  @opptra.com Google account."; `SKIP_IAP=1` outside production -> `DEV_USER_EMAIL`; `SKIP_IAP=1` with
  `NODE_ENV=production` -> ignored (401 without a header).

Tier 2 (PGlite):
- `0001_users.sql` applies on top of `0000_init.sql`; the `users` table exists with the enum check.
- Seed: running the seed twice leaves one row `sujan@opptra.com / admin / seed`; after an admin changes
  the role to operator a third seed run does not change it back.
- `roleFor`: returns `admin` for the seeded admin; returns `viewer` for an unknown `@opptra.com`
  email and inserts the row with `added_by = "sign-in"`; a second call does not insert again.
- People routes with a fake current user for each role: viewer `GET` 200, viewer `POST` 403 with the
  sentence; operator `POST` 403; admin `POST` 201 then `PATCH` to operator 200 then `DELETE` 204, and
  `roleFor` of the removed email then returns `viewer` (fall back); `POST` with a `@gmail.com` address
  400; demoting the last admin 400 "You cannot remove the last admin."

Tier 4 (human-like, Playwright on the deployed URL; `apps/web/test/human/`):
- `login.ts`: opens `WEB_URL` headed, waits while the tester signs in on Google's IAP page, then saves
  `context.storageState({ path: ".playwright/auth-state.json" })` (the IAP cookie). Later specs'
  `catalog.human.spec.ts` reuse this state; `.playwright/` is git-ignored. When the state has expired
  the test lands on `accounts.google.com`; re-run `login.ts`.
- `auth.human.spec.ts` with that state as the admin: opens `/catalog` and sees the user menu with
  "Admin"; opens People; adds `catalog-test-viewer@opptra.com` as Viewer and sees the toast; removes it
  again; toggles "Preview as viewer" and sees "New batch" disappear (06 adds the button; until then
  the spec asserts the toast and that the People menu item is hidden), toggles back; clicks "Sign
  out" and lands on Google's sign-in page. If a second Google account is available the tester saves a
  second state (`.playwright/auth-state-viewer.json`) and the spec opens `/catalog` as that viewer and
  asserts no action controls; otherwise the spec asserts the viewer path through the API:
  `POST /api/people` with the viewer state returns 403 and the sentence.
- A wrong-domain attempt (any personal Google account) shows IAP's "You don't have access" page;
  recorded as a screenshot in the PR.

## Done criteria

- `pnpm lint && pnpm typecheck && pnpm test` green; CI green; `0001_users.sql` applied by
  `createTestDb()` and by the `catalog-migrate` job.
- `bash infra/bootstrap.sh` twice: the IAP API, the IAP service agent and its `roles/run.invoker`
  binding are present (SKIP on the second run); nothing printed is a secret.
- `bash infra/deploy.sh` twice: `catalog-web` shows `iap-enabled: true`, is private
  (`--allow-unauthenticated` never used), and `domain:opptra.com` holds `roles/iap.httpsResourceAccessor`
  (resource level, or project level with the WARN and the `docs/solutions/catalog-iap.md` note); the
  second run changes nothing.
- On the deployed URL: an unauthenticated visit to `/catalog` lands on Google's sign-in page; a personal
  Google account gets IAP's "You don't have access" page; an `@opptra.com` account signs in and sees
  "<email> · Viewer" (or Admin for the seed); the admin opens People, adds and removes a person,
  toggles the preview, signs out and is asked to sign in again.
- A viewer's direct `POST /api/people` returns 403 with the exact sentence; the worker's `/healthz`
  and OIDC behaviour are unchanged.
- `.playwright/auth-state.json` exists on the integrator's machine after `login.ts`; `auth.human.spec.ts`
  passes against the deployed URL.
- No OAuth client, consent screen, secret version or other console step was needed; the report says
  so explicitly.

## Merge, deploy, report

Follow `00-execution-protocol.md`. One PR from `feat/catalog-03-auth-and-roles` with the test output
and the sign-in screenshots. Deploy the web with `infra/deploy.sh`. The report lists what shipped, the
test evidence, anything excluded and why, confirms that no manual step was needed for sign-in, and
notes that the owner will add the operator (Naaz) as Operator from the People page himself. It ends
with "Ready for the next spec: 04 Ingestion".

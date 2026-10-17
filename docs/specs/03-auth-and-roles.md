# 03 Auth and roles

Execute with `docs/specs/00-execution-protocol.md`. Source of truth: `docs/SPEC.md`. Depends on 02
(scaffold, schema, `errors.ts`, `deploy.sh`). Visual contract: `01-ui-prototype.md` for the sign-in
page, the user menu and the People modal.

Branch `feat/catalog-03-auth-and-roles`. This spec deploys the web service.

## Goal

Anyone with an `@opptra.com` Google account can sign in and view. Admins manage people (who is an
operator, who is an admin). Operators act (create batches, resolve attention items, add SKU ids and
aliases). The worker and the matting service stay service-to-service with OIDC tokens (defined in 02,
`apps/worker/src/auth.ts`); no person ever calls them.

Plain-language notes:
- "Auth.js" (package `next-auth@beta`) is the sign-in library for Next.js. It sends the person to
  Google, gets back who they are, and keeps a signed cookie ("session") so they stay signed in.
- "JWT session" means the session is stored in that cookie, not in the database. The database holds
  only the `users` table with roles.
- "Role" is one of `admin`, `operator`, `viewer` (defined in 02, `ROLES`). Order: admin > operator >
  viewer. "At least operator" means operator or admin.
- "OAuth client" is the record in the Google Cloud console that tells Google which app is asking
  people to sign in and where to send them back.

## Scope and non-scope

In scope: Google sign-in restricted to `@opptra.com`; the `users` table and migration `0001_users.sql`;
the seeded admin; `currentUser()` and `requireRole()`; the People modal and its API routes; the user
menu; the `/signin` page; "Preview as viewer"; the Playwright login helper that saves a browser state
for the human-like tests of later specs; `deploy.sh` env and secrets for the web service.

Out of scope: every `/catalog` page and `/api/catalog/*` route (04 to 07 add them and call
`requireRole` as this spec defines); IAP (not used); any role beyond the three; SSO for the worker
(stays OIDC).

## Files to add or change

```
apps/web/auth.ts                                   NEW  NextAuth config; exports { handlers, auth, signIn, signOut }
apps/web/middleware.ts                             NEW  export { auth as middleware } with a matcher
apps/web/app/api/auth/[...nextauth]/route.ts       NEW  export const { GET, POST } = handlers
apps/web/app/signin/page.tsx                       NEW  sign-in page (copy below); server action calls signIn("google", { redirectTo })
apps/web/app/page.tsx                              CHANGE redirect to /catalog (02's placeholder goes); /catalog itself arrives with 06, so until then it is a one-line page "Catalog images" that already requires sign-in
apps/web/app/layout.tsx                            CHANGE renders UserMenu in the top bar
apps/web/lib/user.ts                               NEW  currentUser(), requireRole(), CurrentUser type (replaces the IAP helper that was not lifted)
apps/web/lib/errors.ts                             CHANGE add ForbiddenError (HTTP 403) and the 401 branch
apps/web/lib/auth-rules.ts                         NEW  allowedSignIn(profile, allowedDomain): boolean (pure; unit tested)
apps/web/components/UserMenu.tsx                   NEW  "<email> · <Role> ▾" with People (admins) and Sign out
apps/web/components/PeopleModal.tsx                NEW  People modal (copy below) incl. "Preview as viewer"
apps/web/components/ViewerPreview.tsx              NEW  client-side context + toggle used by action controls to hide themselves
apps/web/app/api/people/route.ts                   NEW  GET (viewer), POST (admin)
apps/web/app/api/people/[email]/route.ts           NEW  PATCH (admin), DELETE (admin)
packages/core/src/db/schema.ts                     CHANGE add the users table
packages/core/drizzle/0001_users.sql               NEW  generated with drizzle-kit
packages/core/src/people.ts                        NEW  listPeople, upsertPerson, removePerson, roleFor
apps/worker/src/migrate.ts                         CHANGE seed the admin from SEED_ADMIN_EMAIL after migrations
infra/deploy.sh                                    CHANGE web secrets AUTH_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET; env AUTH_TRUST_HOST, AUTH_URL, ALLOWED_HOSTED_DOMAIN; migrate job env SEED_ADMIN_EMAIL
apps/web/test/human/login.ts                       NEW  Playwright helper that saves .playwright/auth-state.json
apps/web/test/human/auth.human.spec.ts             NEW  short human-like spec (tier 4)
apps/web/package.json                              CHANGE add next-auth@beta (if not yet), dev @playwright/test
```

## Contracts

### Auth.js configuration (`apps/web/auth.ts`)

Call shapes confirmed in current docs (builders re-confirm with Context7 before coding):

```ts
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { allowedSignIn } from "@/lib/auth-rules";

const ALLOWED_HOSTED_DOMAIN = process.env.ALLOWED_HOSTED_DOMAIN ?? "opptra.com";
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;   // builder constant: 30 days, the Auth.js default

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google({ authorization: { params: { hd: ALLOWED_HOSTED_DOMAIN } } })],
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SEC },
  pages: { signIn: "/signin", error: "/signin" },
  callbacks: {
    signIn({ account, profile }) {
      return account?.provider === "google" && allowedSignIn(profile, ALLOWED_HOSTED_DOMAIN);
    },
    jwt({ token, user }) {
      if (user?.email) token.email = user.email;      // email only; the role is looked up per request
      return token;
    },
    session({ session, token }) {
      if (typeof token.email === "string") session.user.email = token.email;
      return session;
    },
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      if (pathname === "/signin" || pathname.startsWith("/api/auth") || pathname === "/healthz") return true;
      return !!auth?.user?.email;                     // false -> Auth.js redirects to /signin
    },
  },
});
```

`allowedSignIn(profile, allowedDomain)` returns
`profile.email_verified === true && profile.hd === allowedDomain && email.endsWith("@" + allowedDomain)`
(email lowercased). The `hd` parameter asks Google to show only Workspace accounts of that domain; the
callback is the real check, because `hd` is a hint and not a guarantee. The JWT stores the email only;
the role is never in the cookie, so a role change applies on the next request.

`apps/web/middleware.ts`: `export { auth as middleware } from "@/auth"` with
`export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|ico|css|js)$).*)"] }`,
so every page and API route except static assets runs the `authorized` callback. Unauthenticated
browser requests are redirected to `/signin?callbackUrl=<original>`; unauthenticated `/api/*` requests
get 401 JSON `{ error: "Sign in to continue." }`.

`apps/web/app/api/auth/[...nextauth]/route.ts`: `import { handlers } from "@/auth"; export const { GET, POST } = handlers;`.

Sign-in from the page: a server action `async function signInWithGoogle() { "use server"; await signIn("google", { redirectTo: callbackUrl ?? "/catalog" }); }`.
Sign-out from the user menu: `await signOut({ redirectTo: "/signin" })`.

Env (02 lists the shared ones): `AUTH_SECRET` (secret `catalog-auth-secret`, created by bootstrap),
`AUTH_GOOGLE_ID` (secret `catalog-google-client-id`), `AUTH_GOOGLE_SECRET` (secret
`catalog-google-client-secret`), `AUTH_TRUST_HOST=true` (Cloud Run sits behind a proxy), `AUTH_URL`
(the web URL), `ALLOWED_HOSTED_DOMAIN=opptra.com`.

### The Google OAuth client (the human creates it; the script cannot)

In the GCP console of project `image-links-agent`, "APIs and Services > Credentials":
1. OAuth consent screen: user type Internal (only the Opptra Workspace can sign in), app name
   "Catalog images", support and developer email `sujan@opptra.com`, no extra scopes (Auth.js asks
   for `openid email profile`).
2. Create credentials > OAuth client ID, type Web application, name `catalog-web`. Authorised
   JavaScript origin `<WEB_URL>`; authorised redirect URI `<WEB_URL>/api/auth/callback/google`.
   `WEB_URL` is the deterministic `https://catalog-web-<project-number>.asia-south1.run.app` printed
   by 02's `deploy.sh`. For local development add `http://localhost:3000` and
   `http://localhost:3000/api/auth/callback/google`.
3. Add the two values as secret versions, from a terminal, never pasted into chat or files:
   `printf %s '<client id>' | gcloud secrets versions add catalog-google-client-id --project=image-links-agent --data-file=-`
   and the same for `catalog-google-client-secret`. Bootstrap (02) already created the containers and
   `catalog-auth-secret` with a generated version.

The agent never sees these values; deploy mounts them as env vars from Secret Manager.

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
entirely is to remove their Google Workspace account.

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

### `currentUser()` and `requireRole()` (`apps/web/lib/user.ts`)

```ts
export type CurrentUser = { email: string; role: Role };
export async function currentUser(): Promise<CurrentUser>;       // reads the session email (await auth()), then roleFor(db, email) on every call
export async function requireRole(min: Role): Promise<CurrentUser>; // throws ForbiddenError when the role is below min
export function atLeast(role: Role, min: Role): boolean;           // admin > operator > viewer
```

`currentUser()` throws `HttpError(401, "Sign in to continue.")` when there is no session (middleware
makes this rare). `requireRole` throws `ForbiddenError` (`apps/web/lib/errors.ts`, HTTP 403) with the
sentence "You can view this but not change it. Ask an admin for the operator role."; `errorResponse`
turns it into `{ error }` JSON with status 403. The role is looked up on every call so a change in the
People modal applies at once. `await auth()` in server components and route handlers returns the
session or null (confirmed in current docs).

Every later spec calls `requireRole` at the top of every server action and API route it adds and
states the role in its route table; pages call `currentUser()` and pass `role` to the client so action
controls can hide themselves. Hiding is convenience; the server check is the permission.

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

All pages under `/catalog` need a signed-in user; the role per row is the minimum. This spec
implements the `/signin`, `/`, `/api/auth/*` and `/api/people*` rows and the helper every other row
uses; the other rows are implemented by the spec in brackets.

| Route | Role | Purpose |
|---|---|---|
| `GET /` | any | redirect to `/catalog` |
| `GET /signin` | public | "Sign in with Google" page |
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
| `GET /api/auth/*` | public | Auth.js (this spec) |

People route bodies: `POST /api/people` `{ email, role }` -> 201 `Person`; `PATCH /api/people/[email]`
`{ role }` -> 200 `Person`; `DELETE /api/people/[email]` -> 204; `GET /api/people` -> `{ people: Person[] }`.
Errors through `apps/web/lib/errors.ts`: 400 with the sentences above, 403 with the forbidden sentence,
404 "Person not found" for PATCH of an unknown email.

### UI

`/signin` page (visual contract 01): the Opptra logo, heading "Catalog images", one button "Sign in
with Google", below it "Use your @opptra.com Google account." When Auth.js returns with
`?error=AccessDenied` (the `signIn` callback refused) the page shows "This account is not an
@opptra.com account. Sign in with your work account." above the button. No other text, no password
field. The page is public and has no user menu.

User menu (top bar on every signed-in page): button "<email> · <Role> ▾" (Role capitalised: Admin,
Operator, Viewer). Menu items: "People" (admins only) opens the People modal; "Sign out".

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

### Env vars added by this spec

| Name | Default | Used by |
|---|---|---|
| `AUTH_SECRET` (secret `catalog-auth-secret`) | | web |
| `AUTH_GOOGLE_ID` (secret `catalog-google-client-id`) | | web |
| `AUTH_GOOGLE_SECRET` (secret `catalog-google-client-secret`) | | web |
| `AUTH_TRUST_HOST` | `true` | web |
| `AUTH_URL` | the web URL | web |
| `ALLOWED_HOSTED_DOMAIN` | `opptra.com` | web |
| `SEED_ADMIN_EMAIL` | `sujan@opptra.com` | migrate job |

`deploy.sh`: the web service adds
`--set-secrets=AUTH_SECRET=catalog-auth-secret:latest,AUTH_GOOGLE_ID=catalog-google-client-id:latest,AUTH_GOOGLE_SECRET=catalog-google-client-secret:latest`
(plus the shared `DB_PASSWORD`) and env `AUTH_TRUST_HOST=true,AUTH_URL=$WEB_URL,ALLOWED_HOSTED_DOMAIN=opptra.com`;
the migrate job adds `SEED_ADMIN_EMAIL=${SEED_ADMIN_EMAIL:-sujan@opptra.com}`. If either Google
secret has no version yet, `deploy.sh` stops before deploying the web with "Add the Google OAuth client
id and secret versions first (see docs/specs/03-auth-and-roles.md)."

### Cloud Run and cookies

`catalog-web` is deployed with `--allow-unauthenticated` (public ingress). This is safe because every
page and every API route runs the middleware's `authorized` callback, every mutating route calls
`requireRole`, and the only public paths are `/signin`, `/api/auth/*` and the health endpoint. No IAP
is used (it would need a load balancer and per-user IAM; Auth.js gives the same gate with roles).
The worker and matting services stay private and OIDC-only (02).

Session cookie: `secure`, `httpOnly`, `sameSite: "lax"` (Auth.js defaults on https), lifetime
`SESSION_MAX_AGE_SEC` (30 days, builder constant). Signing out clears it.

## Workstreams

- A `auth-and-middleware` (worktree `catalog-module-wt/03-auth-and-middleware`): `auth.ts`,
  `auth-rules.ts`, `middleware.ts`, the Auth.js route, `/signin` page, `lib/user.ts`, `errors.ts`
  change, `deploy.sh` change. Depends on nothing (uses a stub `roleFor` until merge).
- B `people-data-and-routes` (worktree `.../03-people-data-and-routes`): `schema.ts` users table,
  `0001_users.sql`, `people.ts`, the migrate seed, `/api/people*` routes with their tests.
- C `ui-and-playwright-login` (worktree `.../03-ui-and-playwright-login`): `UserMenu`, `PeopleModal`,
  `ViewerPreview`, layout change, `login.ts`, `auth.human.spec.ts`, Playwright config.
- Integration: merge, run tiers 1 and 2, deploy the web, run tier 4 on the deployed URL.

## Test plan

Tier 1 (unit, vitest):
- `allowedSignIn`: rejects `email_verified: false`; rejects `hd: "gmail.com"`; rejects a verified
  profile with `hd: "opptra.com"` but an email ending in another domain; accepts a verified
  `@opptra.com` profile with `hd: "opptra.com"`; email case does not matter.
- `atLeast` and `requireRole` ordering: admin satisfies operator and viewer; operator satisfies
  viewer only; viewer satisfies viewer only; the thrown error is `ForbiddenError` with status 403 and
  the exact sentence.
- `middleware` `authorized`: `/signin`, `/api/auth/callback/google`, `/healthz` pass without a
  session; `/catalog` and `/api/people` do not.

Tier 2 (PGlite):
- `0001_users.sql` applies on top of `0000_init.sql`; the `users` table exists with the enum check.
- Seed: running the seed twice leaves one row `sujan@opptra.com / admin / seed`; after an admin changes
  the role to operator a third seed run does not change it back.
- `roleFor`: returns `admin` for the seeded admin; returns `viewer` for an unknown `@opptra.com`
  email and inserts the row with `added_by = "sign-in"`; a second call does not insert again.
- People routes with a fake session for each role: viewer `GET` 200, viewer `POST` 403 with the
  sentence; operator `POST` 403; admin `POST` 201 then `PATCH` to operator 200 then `DELETE` 204, and
  `roleFor` of the removed email then returns `viewer` (fall back); `POST` with a `@gmail.com` address
  400; demoting the last admin 400 "You cannot remove the last admin."

Tier 4 (human-like, Playwright on the deployed URL; `apps/web/test/human/`):
- `login.ts`: opens `WEB_URL` headed, waits while the tester signs in with Google, then saves
  `context.storageState({ path: ".playwright/auth-state.json" })`. Later specs' `catalog.human.spec.ts`
  reuse this state; `.playwright/` is git-ignored.
- `auth.human.spec.ts` with that state as the admin: opens `/catalog` and sees the user menu with
  "Admin"; opens People; adds `catalog-test-viewer@opptra.com` as Viewer and sees the toast; removes it
  again; toggles "Preview as viewer" and sees "New batch" disappear (06 adds the button; until then
  the spec asserts the toast and that the People menu item is hidden), toggles back. If a second
  Google account is available the tester saves a second state (`.playwright/auth-state-viewer.json`)
  and the spec opens `/catalog` as that viewer and asserts no action controls; otherwise the spec
  asserts the viewer path through the API: `POST /api/people` with the viewer state returns 403 and
  the sentence.
- A wrong-domain attempt (any personal Google account) shows the sentence on `/signin`; recorded as a
  screenshot in the PR.

## Done criteria

- `pnpm lint && pnpm typecheck && pnpm test` green; CI green; `0001_users.sql` applied by
  `createTestDb()` and by the `catalog-migrate` job.
- On the deployed URL: an unauthenticated visit to `/catalog` redirects to `/signin`; a personal Google
  account is refused with the sentence; an `@opptra.com` account signs in and sees "<email> · Viewer"
  (or Admin for the seed); the admin opens People, adds and removes a person, toggles the preview.
- A viewer's direct `POST /api/people` returns 403 with the exact sentence; the worker's `/healthz`
  and OIDC behaviour are unchanged.
- `.playwright/auth-state.json` exists on the integrator's machine after `login.ts`; `auth.human.spec.ts`
  passes against the deployed URL.
- `deploy.sh` refuses to deploy the web while a Google secret has no version, and deploys once they
  exist.

## Merge, deploy, report

Follow `00-execution-protocol.md`. One PR from `feat/catalog-03-auth-and-roles` with the test output
and the sign-in screenshots. Deploy the web with `infra/deploy.sh`. The report lists what shipped, the
test evidence, anything excluded and why, and what the human must do: create the OAuth client in the
console (consent screen internal, type Web application, redirect URI `<WEB_URL>/api/auth/callback/google`),
add the two secret versions with `gcloud secrets versions add ... --data-file=-`, and add the
operator's Google account in People as Operator. It ends with "Ready for the next spec: 04 Ingestion".

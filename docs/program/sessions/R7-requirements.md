# R7 requirements session: Self-serve

Self-contained brief for a fresh Claude Code session. Planning only: change no product code.

## 1. Goal

Bring every R7 feature (`docs/program/roadmap.md` section 11) to build-ready depth and write the R7 build brief. R7's
value: a second organisation signs up, adds a brand, drops a folder and gets links, text, files and a digest with no
engineer; its data is invisible to Opptra users and it is billed per product processed.

No timelines anywhere: no dates, weeks, durations or "by X". Durations that describe product behaviour are allowed.

## 2. When to open this session

Any time after the R4 requirements PR is merged (an outside brand needs R1 to R4). It is the lowest-priority
requirements session; open it when no higher one is waiting.

## 3. Setup and read first

- Worktree from latest `main`: `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\<nn>-r7-requirements`, branch
  `docs/r7-requirements`.
- Read: `roadmap.md` (1 to 4, 11), `owner-questions.md` (Q19), `requirements/00-template.md`;
  `M12-admin-self-serve.md` (all), `M1-intake.md` (F7), `M0-catalog-graph.md` (`org_id`, contracts), `M5-channel-rules.md`
  (M5-S5 add channel and category), `M9-publish-monitor.md` (templates), `UX-design-system.md` (sections 6, 10, 12, UX9,
  UX10).
- P0 depth example: `M1-intake.md` M1-F1.
- Evidence: `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-02-competitors-listing.md` and
  `2026-11-02-competitors-measurement.md` (pricing, go-to-market).

## 4. What to produce

1. **Upgrade to P0 depth** (template section 4) for: M12-F4 (roles, `M12-S9`), owner approvals (`M12-S4`), template
   mapping in the add-channel flow (`M12-S8`), M12-F5 (sign-up, billing, data separation), M12-F6 (onboarding hook),
   M12-F7 (agent and MCP access), M1-F7 (product from photos or a web page), UX9 and UX10.
2. **Build slices** with ids, true dependencies, acceptance tests and additive migrations (new ids from `M12-S10` and
   `M1-S8` onward).
3. **Operator experience and measurement** for an outside organisation (sign-up, first brand, first batch, bill).
4. **Integration decisions** in each touched module's section 9.
5. **New owner questions** with defaults, for example: who may sign up (invite only or open), the onboarding hook's
   offer, the first outside customer.
6. **`docs/program/sessions/R7-build.md`** in the shape of `R1-build.md`.
7. In `roadmap.md` section 11, set "Requirements status" to build-ready; add the R7 build session's first message to
   `sessions/README.md`.

## 5. Decisions already settled (do not reopen)

- Pricing unit: per product processed (Q19). Data lives in the region of the customer's main market (Q19). India is out
  of scope.
- `org_id` already exists on every new table, default `opptra` (M0, M12 D6). No Opptra-only constants in code; copy
  without internal names; vendor and model names never in operator copy.
- Sign-in for outside users: a bought identity service behind one interface, chosen at M12-F5 time after checking
  current docs with Context7.
- No per-SKU approval workflow; approvals apply to settings and rule changes only. Structure (which fields exist) is not
  editable from the UI until a second customer needs it.
- Add channel and category belong to M5-S5; M12-S8 extends that flow.

## 6. Questions to resolve in this session

1. Data separation design (row-level security versus per-organisation schema or database) and the test that proves an
   outside organisation's data is invisible to Opptra users and the reverse.
2. Identity service and billing provider candidates (current docs via Context7; Sonnet collection), each behind one
   interface with a fallback.
3. Region choice per market: which GCP regions serve UAE and KSA customers, and what must stay in region (storage,
   database, logs).
4. Roles: owner, admin, operator, per-brand scope; how owner approvals notify and expire.
5. Agent and MCP access: which read and write tools, scopes and audit.
6. Product from photos or a web page (M1-F7): the accuracy bar from M2 before it is allowed.

## 7. How to work

- You are the manager. Collection: Sonnet (`kit:researcher`). Writing: Opus. Fable only if Sujan asks (data separation
  is the one place worth offering it).
- Clean-context review: `ce-doc-review` in a fresh subagent; fix findings.
- Every subagent brief ends with: "Write the full report to
  `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\<yyyy-mm-dd>-<slug>.md` in the main checkout and reply in at most 120
  words (outcome, branch/PR, tests, blockers, report path)."
- Ship the docs with `/ce-commit-push-pr`. Sujan merges.

## 8. Done check

- Every feature in section 4.1 has every P0 subsection; every slice has an id, dependencies and a test.
- `sessions/R7-build.md` exists and is executable by a fresh session.
- No dates, weeks or "by X" in any doc you touched (grep before committing).
- `ce-doc-review` findings fixed; PR open; report written to `.runs`.

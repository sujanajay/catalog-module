# Catalog OS sessions

How to turn the release plan (`../roadmap.md`) into work. Each file here is a self-contained brief for one new Claude
Code session. Two kinds:
- **Build** (`R<n>-build.md`): executes a build-ready release with subagents, one worker per slice.
- **Requirements** (`R<n>-requirements.md`): writes in-depth requirements for a release that is not build-ready yet, and
  ends by writing that release's build brief.

| Release | Brief | Status |
|---|---|---|
| R1 Upload and walk away | `R1-build.md` | Build-ready |
| R2 Complete and measured | `R2-build.md` | Build-ready |
| R3 Made where nothing else works | `R3-requirements.md` | Needs requirements; it writes `R3-build.md` |
| R4 Every listing has words | `R4-requirements.md` | Needs requirements and the buy or build decision; it writes `R4-build.md` |
| R5 Learn what sells | `R5-requirements.md` | Needs requirements; it writes `R5-build.md` |
| R6 Rich media | `R6-requirements.md` | Needs requirements; it writes `R6-build.md` |
| R7 Self-serve | `R7-requirements.md` | Needs requirements; it writes `R7-build.md` |

## Step 0: merge the planning branch

These briefs live on branch `docs/catalog-os-reset` (worktree
`C:\Users\Sujan Ajay\Desktop\catalog-module-wt\20-catalog-os`). Every session below starts from `main`, so ship and merge
that branch first: open a session in that worktree, run `/ce-commit-push-pr`, and merge the PR yourself.

## Order to open sessions

1. **R1 build.** Open first.
2. **R3 requirements** and **R4 requirements.** Open at the same time as R1 build: they only edit docs. R4 needs the
   Streamoid and Rubick teardown report
   (`C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-03-streamoid-rubick.md`) to exist; if it is not there yet,
   R4 waits at its first step.
3. **R2 build.** Open when R1's foundation slices are merged (`M0-S1` to `M0-S3`, `M5-S1` to `M5-S3`, `M3-S1`, `M7-S2`,
   `M1-S3`, `M1-S5`, `M6-S4`, `M12-S1`, `M10-S1a`). While R1 build is still running, R2 build may start only the slices
   in modules R1 is not writing at that moment (M4, M9, and M2-S2 and M2-S3 once M2-S1 is merged), so the rule of one
   writer per module holds across both sessions. Each manager checks the other's progress file in `docs/plans/` before
   starting a module.
4. **R5 requirements.** After the R4 requirements PR is merged.
5. **R6 requirements.** After the R3 and R4 requirements PRs are merged.
6. **R7 requirements.** Any time after the R4 requirements PR is merged; lowest priority.
7. **R3 build** and **R4 build** (written by their requirements sessions). After R2 has shipped (both need R2's golden
   set, scoring, audit and analyzer). They can run at the same time; their briefs name the shared hot files.
8. **R5 build** after R4 has shipped and the first holdout readout exists; **R6 build** after R3, R4 and R5;
   **R7 build** after R4.

**At the same time:** at most three sessions at once keeps your attention manageable. Safe pairs: R1 build with R3 and
R4 requirements; R2 build with R5, R6 or R7 requirements; R3 build with R4 build. Never two build sessions writing the
same module.

## Rules every session follows

- Manager mode: the session coordinates; subagents do the work. Sonnet for collection, Opus for building, writing and
  reviews, Fable only for critical design and only when you ask for it.
- One writer per module; one worktree and one branch per slice; never commit to `main`.
- A clean-context review on every PR (`ce-code-review`; `ce-doc-review` for docs).
- Ship with `/ce-commit-push-pr` (this repo has no no-mistakes gate). You merge every PR.
- Every subagent writes `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\<yyyy-mm-dd>-<slug>.md` and replies in at most
  120 words.
- Human gates (`../roadmap.md` section 4): deploys, the holdout freeze and launch, paid vendor contracts, the likeness
  flag, and every marketplace-facing change wait for you.
- No timelines in any doc.

## Paste-ready first messages

Open each session in `C:\Users\Sujan Ajay\Desktop\catalog-module` (the main checkout) unless the message says otherwise.

**R1 build**
```
Manager mode. Read docs/program/sessions/R1-build.md on main and execute it end to end. It is my approved plan for
release R1: run it without asking again unless something is risky, blocked or outside the plan. One writer per module,
one worktree per slice, clean-context review per PR, ship with /ce-commit-push-pr, I merge every PR, and every deploy
waits for my typed approval naming the sha. Start by creating the R1 progress file and dispatching the slices that can
start now.
```

**R2 build**
```
Manager mode. Read docs/program/sessions/R2-build.md on main and execute it end to end. It is my approved plan for
release R2. Before starting a module, check docs/plans/ for the R1 progress file and do not start a module that R1 is
still writing. The holdout freeze (G2), the treatment go/no-go (G3) and the first treatment uploads (G5) wait for me;
so does every deploy. Start with the holdout critical path.
```

**R3 requirements**
```
Read docs/program/sessions/R3-requirements.md on main and follow it. Planning only: change no product code. Bring every
R3 feature to P0 depth in the template format, add the build slices, write docs/program/sessions/R3-build.md, run a
clean-context ce-doc-review, and ship the docs with /ce-commit-push-pr. Ask me only business, money, legal or
marketplace questions; record each with a default in owner-questions.md.
```

**R4 requirements**
```
Read docs/program/sessions/R4-requirements.md on main and follow its steps in order. Planning only: the M8-S0 prototype
is throwaway and never merged. First read the Streamoid and Rubick teardown report; if it is missing, stop and tell me.
Bring me the buy or build memo in plain words and wait for my decision before deepening M8 and M9. Then write
docs/program/sessions/R4-build.md, run a clean-context ce-doc-review, and ship the docs with /ce-commit-push-pr.
```

**R5 requirements**
```
Read docs/program/sessions/R5-requirements.md on main and follow it. Planning only. Check first that the R4
requirements PR is merged; if not, stop and tell me. Bring every R5 feature to P0 depth, add the build slices, write
docs/program/sessions/R5-build.md, run a clean-context ce-doc-review, and ship the docs with /ce-commit-push-pr.
```

**R6 requirements**
```
Read docs/program/sessions/R6-requirements.md on main and follow it. Planning only. Check first that the R3 and R4
requirements PRs are merged; if not, stop and tell me. Keep the rule that no face embeddings or biometric templates are
stored anywhere. Bring every R6 feature to P0 depth, write docs/program/sessions/R6-build.md, run a clean-context
ce-doc-review, and ship the docs with /ce-commit-push-pr.
```

**R7 requirements**
```
Read docs/program/sessions/R7-requirements.md on main and follow it. Planning only. Check first that the R4
requirements PR is merged; if not, stop and tell me. Bring every R7 feature to P0 depth, write
docs/program/sessions/R7-build.md, run a clean-context ce-doc-review, and ship the docs with /ce-commit-push-pr.
```

**R3 to R7 build** (once their requirements sessions have written the build brief)
```
Manager mode. Read docs/program/sessions/R<n>-build.md on main and execute it end to end. It is my approved plan for
release R<n>. Check docs/plans/ for other releases' progress files and never start a module another session is writing.
Every deploy, paid vendor contract, likeness flag and marketplace-facing change waits for me.
```

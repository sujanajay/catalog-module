# 17 Reliable throughput (release G)

Written 2026-10-28. Spec: `docs/specs/17-reliable-throughput.md`, executed with
`docs/specs/00-execution-protocol.md` and the spec's own section 11 (the manager delegates; small context).
Approved by the owner (Sujan) on 2026-10-28: all five streams, the manager merges and deploys, GPU candidates on
tagged no-traffic revisions, no quiet window required, reliability before speed. No migration.

Worktrees: `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\17-<stream>`, one branch and one PR per stream.
Reports: `.runs/2026-<mm>-<dd>-17-<stream>-<slug>.md`. Handoff: `~/ai-personal/handoffs/catalog-module/17-reliable-throughput.md`.

## Checklist (ticked at milestones only: PR opened, merged, deployed, verified)

- [ ] Preconditions of 00 section 2 checked (main clean and current, gates green, gcloud logged in)
- [ ] Task board opened; G1, G2, G3-probe, G4-diagnosis briefed in parallel
- [ ] G1 honest completion: PR opened
- [ ] G1 merged and deployed; `catalog-invariants` run once on production, counts in the report
- [ ] G2 deploy gate: PR opened
- [ ] G2 merged; first gated deploy done; `deploy.sh --rollback <name>` exercised once on a no-op
- [ ] G3 probe: baseline table (rung 1) on the live GPU revision in the README
- [ ] G3 ladder: rungs tried on tagged candidates, one table each; evals where required
- [ ] G3 PR opened (app.py knobs, shape table and refusals, breaker fields, README)
- [ ] G3 merged; chosen rung live through the gate (Fable verdict in `.runs/`)
- [ ] G4 diagnosis report names the tail chunk's cause
- [ ] G4 fix PR opened, merged, deployed
- [ ] Speed test (section 9 step 5) run; reliability items all pass; photos per minute and projections recorded
- [ ] Operator-first batch (step 6) result recorded
- [ ] Cleanup confirmed (step 7); invariants zero ERROR
- [ ] G5 docs PR opened and merged (solutions entry, protocol 9 and 11, spec 16 corrections, owner status doc)
- [ ] Handoff written; memory lines saved; final report sent

# Subagents cannot wait on long jobs - learnings

## What happened
A subagent cannot wait more than about 20 to 30 minutes for background work. Past that it ends or
loses track of the job, and the result is never read. Several go-live jobs run much longer:
- deploy (`infra/deploy.sh`): about 35 to 45 minutes,
- eval runs (spec 10 suite): about 2 to 2.5 hours,
- load runs: about 1 hour.

## What to do
Split every long job into three parts:
1. Start. A subagent checks the guard (no operator batch in the last 60 minutes, nothing running),
   starts the job and returns at once with the execution name and the log path.
2. Poll. The manager polls with scheduled wake-ups (a cheap status check, for example the execution
   state or the tail of the log), never with a subagent that sleeps.
3. Read. When the result lands, the manager starts a fresh subagent to read it (logs, records under
   `catalog-test/`) and write the verdict. For eval runs, one reader per set as its records land.

## Deploys
`deploy.sh` runs through a small wrapper that tees its output to a log file in the session
scratchpad (for example `deploy-run.sh d2`), so a poll can read progress and the final smoke result
from that file instead of from a subagent's terminal.

## Related
Commit and push WIP before handing a long wait to anyone (see `unplanned-restart-and-wip.md`): a
restart kills the waiting subagent and the manager's watchers alike.

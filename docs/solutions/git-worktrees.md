# Git worktrees and branch names - learnings

## A branch cannot have sub-branches
Symptom (spec 02, 2026-10-17): with `feat/catalog-02-scaffold-and-foundations` already created,
`git worktree add -b feat/catalog-02-scaffold-and-foundations/a-core-data ...` failed with
"cannot lock ref ... 'refs/heads/feat/catalog-02-scaffold-and-foundations' exists". Cause: git stores
branches as paths under `refs/heads/`, so `X` (a file) and `X/sub` (which needs `X` to be a folder)
cannot both exist. Fix: builder branches are `feat/catalog-<nn>-<slug>--<workstream>` (two dashes),
for example `feat/catalog-02-scaffold-and-foundations--a-core-data`. The protocol (section 3) uses
this form.

## Squash merges and `git branch -d`
PRs merge with `--squash`, so the feature and builder branches never appear as merged into `main`
and `git branch -d` refuses them. Check the PR is merged on GitHub (`gh pr view <n> --json state`),
then delete those exact branches with `git branch -D`. `gh pr merge --delete-branch` also fails to
switch branches locally while a worktree holds `main`; merge without it and delete the remote branch
with `git push origin --delete <branch>`.

---
name: fan-out-fan-in
description: Use this workflow skill only when the user wants explicit parallelization or the task should be split into isolated worktrees and merged back without separate PRs.
---

# Fan Out Fan In

Use this when the user explicitly wants parallel agent work or the task is naturally decomposable into independent file scopes.

## Workflow

1. Read the plan from a file such as `scratch/plan.md` or from inline instructions.
2. Record the parent branch and commit with `git branch --show-current` and `git rev-parse HEAD`.
3. Stop if `git status --short` is not clean. Do not fan out from a dirty tree.
4. Scan recent history and existing worktrees with `git log --oneline -20` and `git worktree list` so you do not duplicate work.
5. Split the work into units that do not edit the same files. If two units need the same file, merge them or sequence them.
6. For each unit, create an isolated worktree from the parent commit with `git worktree add ../worktree-unit-N -b fan-out-unit-N "$PARENT_COMMIT"`.
7. In each worktree, implement only the assigned scope, run the relevant validation, and commit with `fan-out: [unit-name]`.
8. Merge unit branches back into the parent branch one at a time, validating after each merge and again at the end.
9. Remove successful worktrees and branches. Preserve failed ones for inspection.

## Repo Rules

- Prefer repo validations over generic ones:
  - TypeScript: `bun run lint`, `bun run build`, `bun test`
  - Fast repo checks: `bash scripts/all_fast_validate_checks.sh`
  - Android: `(cd android && ./gradlew <task>)`
- Write logs that matter to `scratch/` if they are too long to inspect inline.
- Do not create PRs or push branches as part of fan-out work.
- Do not proceed if the work cannot be partitioned cleanly.

---
name: check-ci
description: "Use this workflow skill for PR CI triage: inspect failing or pending checks, mergeability, and related review feedback, then reproduce likely failures locally and summarize next steps."
---

# Check CI

Use this for PR health checks and failure triage.

- This is narrower than `pr-analysis`: prefer `check-ci` when the main question is why checks are failing or blocked.
- This is read-only unless the user also asks to fix the problem.

## Workflow

1. Resolve the PR number from an argument or the current branch with `gh pr view --json number`.
2. Inspect checks with `gh pr checks <pr> --json name,state,bucket,link` and branch on `bucket`: `pass`, `fail`, `pending`, `skipping`, `cancel`. Only `fail` is a failure — `skipping` and `cancel` are not. Save verbose output to `scratch/` when needed.
3. If checks failed, fetch **per-job** logs: `gh api repos/kaeawc/auto-mobile/actions/runs/<run-id>/jobs`
   to find the failed job ids, then `gh api repos/kaeawc/auto-mobile/actions/jobs/<job-id>/logs`.
   A finished job's log is readable while sibling jobs are still running, so this does not
   wait on the slowest leg. For a job still executing, `gh api .../actions/jobs/<job-id>`
   returns per-step status instead. `gh run view --log-failed` only works once the whole run
   has finished.
4. Check mergeability and branch drift with `gh pr view --json mergeable,mergeStateStatus` plus local `git fetch origin`.
5. Gather review comments and unresolved feedback. Resolution state is GraphQL-only (`reviewThreads { isResolved }`); REST and `gh pr view --json comments` do not expose it.
6. Reproduce the most likely failure locally using the narrowest relevant command.
7. Summarize current state, root cause, local repro status, and next fix steps.

## Repo Validation Mapping

- TypeScript lint or build: `bun run lint`, `bun run build`
- Tests: `bun test` or `bun test <file>`
- Fast repo checks: `bash scripts/all_fast_validate_checks.sh`
- Android: `(cd android && ./gradlew <task>)`
- iOS: `bash scripts/ios/swift-build.sh` or `bash scripts/ios/swift-test.sh`

## Output Structure

- Current CI state
- Failing checks and likely root cause
- Mergeability or conflict status
- Review feedback that is still actionable
- Recommended next action

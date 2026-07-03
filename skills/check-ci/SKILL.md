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
2. Inspect checks with `gh pr checks <pr>` and save verbose output to `scratch/check-ci-<pr>.log` when needed.
3. If checks failed, fetch failed-job logs with `gh run view <run-id> --log-failed`.
4. Check mergeability and branch drift with `gh pr view --json mergeable,mergeStateStatus` plus local `git fetch origin`.
5. Gather review comments and unresolved feedback that may explain the failing state.
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

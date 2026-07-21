---
name: check-ci
description: "Use this workflow skill for PR CI triage: inspect pending and failed checks for the exact PR head, read live or completed job logs and artifacts, classify causality, reproduce likely failures locally, and summarize the safe next step."
---

# Check CI

Use this for PR health checks and failure triage.

- This is narrower than `pr-analysis`: prefer `check-ci` when the main question is why checks are failing or blocked.
- This is read-only unless the user also asks to fix the problem.

## Workflow

1. Resolve the PR number and snapshot `headRefOid`, `baseRefOid`, mergeability,
   and merge state. Use this SHA for every subsequent query; an empty legacy
   combined status is inconclusive, not green.
2. Collect `gh pr checks <pr> --json name,state,bucket,link,workflow` and
   paginated REST check runs for `repos/<owner>/<repo>/commits/<head-sha>/check-runs`.
   Flag duplicate check names with different conclusions on the same head (for
   example, a cancelled older run plus a successful newer one).
3. Enumerate paginated Actions runs for that head SHA, then each run's jobs.
   Ignore obsolete runs for older SHAs. Keep queued/in-progress jobs as pending;
   they are never implicitly green.
4. For a completed failed job, use `gh run view <run-id> --job <job-id>
   --log-failed`. For an active job, poll its job endpoint to a bounded deadline
   and retrieve any available log archive through `gh api
   "repos/<owner>/<repo>/actions/jobs/<job-id>/logs"`, saving it under `scratch/`.
   Do not use `gh api --follow` (the installed CLI does not support it); report
   the exact run/job if it remains pending.
5. If console output is truncated or lacks the failure body, list the run's
   artifacts and inspect the relevant log artifact. If `gh run download` is
   unauthorized, state that exact blocker and use an available GitHub connector
   artifact download capability when one exists; do not infer a root cause.
6. Classify every red result as PR-caused, pre-existing, transient/infrastructure,
   or unproven. Ground that classification in the job log, changed paths, and
   current `origin/main`; rerun a job only when the evidence supports a transient
   failure. Never change code for an unrelated or unproven failure.
7. Reproduce a PR-caused failure locally with the narrowest authoritative command.
   After a push, restart at step 1 because all checks and feedback are scoped to
   the previous SHA.

## Repo Validation Mapping

- TypeScript lint or build: `bun run lint`, `bun run build`
- Tests: `bun test` or `bun test <file>`
- Fast repo checks: `bash scripts/all_fast_validate_checks.sh`
- Android: `(cd android && ./gradlew <task>)`
- iOS: `bash scripts/ios/swift-build.sh` or `bash scripts/ios/swift-test.sh`

## Output Structure

- Current CI state
- Run/job/head-SHA ledger, including pending jobs and duplicate/stale checks
- Failing checks, evidence, and causal classification
- Mergeability or conflict status
- Artifact or authorization limitations
- Recommended next action

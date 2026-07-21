---
name: check-ci
description: "Use this workflow skill for PR CI triage: inspect pending and failed checks for the exact PR head, read live or completed job logs and artifacts, classify causality, reproduce likely failures locally, and summarize the safe next step."
---

# Check CI

Use this for PR health checks and failure triage.

- This is narrower than `pr-analysis`: prefer `check-ci` when the main question is why checks are failing or blocked.
- This is read-only unless the user also asks to fix the problem.

## Workflow

1. Resolve the PR number and snapshot `headRefOid`, `baseRefOid`, mergeability, and merge
   state. Use that SHA for every subsequent query. An empty legacy combined status is
   inconclusive, not green.
2. Collect `gh pr checks <pr> --json name,state,bucket,link,workflow` plus paginated
   `repos/<owner>/<repo>/commits/<head-sha>/check-runs`. Branch on `bucket`: only `fail` is a
   failure — `skipping` and `cancel` are not. Flag duplicate check names with different
   conclusions on the same head (a cancelled older run beside a successful newer one); the
   stale one is what parks automerge.
3. Enumerate runs for that head SHA, then each run's jobs. Ignore runs for older SHAs.
   Queued and in-progress jobs stay pending — they are never implicitly green.
4. For a completed failed job: `gh run view <run-id> --job <job-id> --log-failed`, or
   `gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs` — the latter works as soon as
   that job finishes, even while sibling jobs still run, so it does not wait on the slowest
   leg. For a job still executing, `gh api .../actions/jobs/<job-id>` returns per-step status
   naming the running or failed step. `gh api --follow` does not exist; use `--paginate`.
5. If the log is truncated or lacks the failure body, list the run's artifacts and read the
   relevant one. If `gh run download` is unauthorized, state that exact blocker — do not
   infer a root cause from partial evidence.
6. Classify every red result as PR-caused, pre-existing on main, transient/infrastructure, or
   unproven, grounded in the job log, the changed paths, and current `origin/main`. Re-run a
   job only when the evidence supports transience. Never change code for an unrelated or
   unproven failure.
7. Reproduce a PR-caused failure locally with the narrowest authoritative command.
8. After any push, restart at step 1 — every check, thread, and comment was scoped to the
   previous SHA.

For PR discussion and review-thread triage, use `github-pr-feedback`; for the underlying gh
and GraphQL mechanics, `github-cli`.

## Repo Validation Mapping

- TypeScript lint or build: `bun run lint`, `bun run build`
- Tests: `bun test` or `bun test <file>`
- Fast repo checks: `bash scripts/all_fast_validate_checks.sh`
- Android: `(cd android && ./gradlew <task>)`
- iOS: `bash scripts/ios/swift-build.sh` or `bash scripts/ios/swift-test.sh`

## Output Structure

- Current CI state, scoped to the head SHA
- Run/job ledger, including pending jobs and duplicate or stale checks
- Failing checks, the evidence, and the causal classification
- Mergeability or conflict status
- Artifact or authorization limitations
- Recommended next action

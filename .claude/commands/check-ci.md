---
description: PR CI triage — inspect pending and failed checks for the exact PR head, read live or completed job logs, classify causality, reproduce likely failures locally, and summarize the safe next step
allowed-tools: Bash, Read, Grep, Glob
argument-hint: [PR number (optional)]
---

Triage a PR's CI: head-scoped check state, failing-job logs (live or complete), causal
classification, local reproduction, and the safe next step. Takes a PR number, or resolves one
from the current branch.

```bash
#!/usr/bin/env bash
set -uo pipefail

REPO=kaeawc/auto-mobile
PR_NUM="${1:-$(gh pr view --json number -q .number 2>/dev/null)}"

if [ -z "$PR_NUM" ]; then
  echo "No PR found for the current branch. Usage: /check-ci [PR_NUMBER]" >&2
  exit 1
fi

echo "=== CI status for PR #${PR_NUM} ==="

# Bucket is gh's normalized state: pass | fail | pending | skipping | cancel.
# Branch on it rather than grepping the human-readable output.
#
# Fail CLOSED: an auth/network/CLI error, or a response that is not a non-empty
# JSON array, means CI state is UNKNOWN. Swallowing that and continuing lets the
# script report "All checks passed" for a PR whose checks were never read.
if ! CHECKS_JSON=$(gh pr checks "$PR_NUM" --json name,state,bucket,link 2>&1); then
  echo "Could not read checks for PR #${PR_NUM}; CI state is unknown." >&2
  printf '%s\n' "$CHECKS_JSON" >&2
  exit 1
fi

if ! printf '%s' "$CHECKS_JSON" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
  echo "No check entries returned for PR #${PR_NUM}; CI state is unknown, not green." >&2
  exit 1
fi

printf '%s' "$CHECKS_JSON" | jq -r '
  group_by(.bucket) | map({bucket: .[0].bucket, n: length})
  | sort_by(-.n)[] | "  \(.bucket): \(.n)"'

echo
echo "--- not passing ---"
printf '%s' "$CHECKS_JSON" | jq -r '
  .[] | select(.bucket != "pass" and .bucket != "skipping")
  | "  \(.bucket)\t\(.name)\t\(.link)"'

# skipping and cancel are NOT failures. Only fail is.
FAILED=$(printf '%s' "$CHECKS_JSON" | jq -r '[.[] | select(.bucket == "fail")] | length')

if [ "$FAILED" -eq 0 ]; then
  PENDING=$(printf '%s' "$CHECKS_JSON" | jq -r '[.[] | select(.bucket == "pending")] | length')
  # cancel is not a failure, but it is not success either: a cancelled run on the head
  # SHA can park automerge. Only pass/skipping counts as green.
  CANCELLED=$(printf '%s' "$CHECKS_JSON" | jq -r '[.[] | select(.bucket == "cancel")] | length')
  if [ "$PENDING" -gt 0 ]; then
    echo "Waiting on ${PENDING} check(s)."
    exit 0
  fi
  if [ "$CANCELLED" -gt 0 ]; then
    echo "No failures, but ${CANCELLED} cancelled check(s) on the head SHA — not green."
    echo "A stale cancelled run can park automerge; re-run it rather than debugging the code."
    printf '%s' "$CHECKS_JSON" | jq -r '.[] | select(.bucket == "cancel") | "  cancelled\t\(.name)"'
    exit 1
  fi
  echo "All checks passed."
  exit 0
fi

# Resolve run ids from the check links, then walk run -> jobs -> the failed job's log.
# grep -oE (POSIX-ish) rather than grep -oP: macOS /usr/bin/grep has no -P.
RUN_IDS=$(printf '%s' "$CHECKS_JSON" \
  | jq -r '.[] | select(.bucket == "fail") | .link' \
  | grep -oE 'runs/[0-9]+' | cut -d/ -f2 | sort -u)

mkdir -p scratch
for RUN_ID in $RUN_IDS; do
  echo
  echo "=== run ${RUN_ID} — https://github.com/${REPO}/actions/runs/${RUN_ID} ==="
  gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" --paginate \
    --jq '.jobs[] | select(.conclusion == "failure") | "\(.id)\t\(.name)"' \
  | while IFS=$'\t' read -r JOB_ID JOB_NAME; do
      echo "--- job ${JOB_ID}: ${JOB_NAME} ---"
      LOG="scratch/job-${JOB_ID}.log"
      # A finished job's log is readable even while sibling jobs still run.
      if gh api "repos/${REPO}/actions/jobs/${JOB_ID}/logs" > "$LOG" 2>/dev/null; then
        grep -nE '##\[error\]|not ok |FAIL|error:|Error:' "$LOG" | head -30
        echo "  (full log: ${LOG})"
      else
        # Job has not finished; show which step it is on instead.
        gh api "repos/${REPO}/actions/jobs/${JOB_ID}" \
          --jq '.steps[] | select(.status != "completed" or .conclusion == "failure")
                | "  step \(.number)\t\(.status)\t\(.conclusion // "-")\t\(.name)"'
      fi
    done
done

# Fail closed on red. Without this the script falls off the end with the status of
# the last loop — 0 when no run ids were found, and usually 0 after a successful log
# fetch — so a PR with failing checks would report success to any caller that reads
# the exit status.
echo
echo "${FAILED} check(s) failing on PR #${PR_NUM}."
exit 1
```

## What the script does

Branches on `bucket` (gh's normalized state) rather than grepping human-readable output, then
walks run → jobs → each failed job's log. A finished job's log is readable **while sibling jobs
still run**, so it never waits on the slowest leg; when a job hasn't finished its log 404s and
the script falls back to per-step status. Logs land in `scratch/` at ~100KB each — read the
extracted error lines first.

## Triage workflow

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

## Merge conflicts and branch drift

```bash
gh pr view ${PR_NUM} --json mergeable,mergeStateStatus -q '.mergeable, .mergeStateStatus'
git fetch origin main
git log HEAD..origin/main --oneline
git merge-tree $(git merge-base HEAD origin/main) HEAD origin/main
```

Report conflicting files and whether rebase or merge is the right resolution. A branch behind
main may also predate a gate it never ran against — see step 1 of the triage workflow.

## Feedback

Resolution state lives only in GraphQL; `gh pr view --json comments` and REST
`/pulls/N/comments` both omit it, so neither can tell you what is outstanding. Use the
`github-pr-feedback` skill for the full ledger — all four paginated surfaces, the disposition
vocabulary, and the conditions under which a thread may be resolved — rather than hand-rolling
it here.

## Local reproduction

Reproduce a **PR-caused** failure with the narrowest authoritative command:

| Failure | Command |
| --- | --- |
| TS lint / build | `bun run lint` · `bun run build` |
| TS types | `bun run typecheck` (gate: new errors vs `scripts/typecheck-baseline.txt`) |
| Tests | `bun test <file>` first, `bun test` only if needed |
| Fast Validation | `bash scripts/all_fast_validate_checks.sh` (`--only <check>` to narrow) |
| Shell / BATS | `shellcheck <script>` · `bats test/bats/<file>.bats` |
| Android | `(cd android && ./gradlew <task>)` — Robolectric needs JDK 21 |
| iOS | `bash scripts/ios/swift-build.sh` · `bash scripts/ios/swift-test.sh` |

A fresh worktree has no `node_modules`, so anything resolving an npm dependency fails there for
environmental reasons that look like real findings. Reproduce in a populated checkout.

## Output

- Current CI state, scoped to the head SHA
- Run/job ledger, including pending jobs and duplicate or stale checks
- Failing checks, the evidence, and the causal classification
- Mergeability or conflict status
- Artifact or authorization limitations
- Recommended next action

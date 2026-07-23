#!/usr/bin/env bash
#
# Print failure context for the checks on a pull request.
#
# Usage: scripts/ci/pr-failing-job-logs.sh [PR_NUMBER]
#
# Resolves the PR from the current branch when omitted, writes each failed job's
# log to scratch/job-<id>.log, and exits non-zero when any check bucket is fail.
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
# gh pr checks exits 8 for "Checks pending" (see `gh pr checks --help`) while still
# emitting the JSON we need, and exits 0 even when checks have FAILED. So only a code
# that is neither 0 nor 8 is a real collection failure.
CHECKS_JSON=$(gh pr checks "$PR_NUM" --json name,state,bucket,link 2>&1)
gh_rc=$?
if [ "$gh_rc" -ne 0 ] && [ "$gh_rc" -ne 8 ]; then
  echo "Could not read checks for PR #${PR_NUM} (gh exit ${gh_rc}); CI state is unknown." >&2
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
    exit 0
  fi
  echo "All checks passed."
  exit 0
fi

# Resolve run ids from the check links, then walk run -> jobs -> the failed job's log.
# grep -oE (POSIX-ish) rather than grep -oP: macOS /usr/bin/grep has no -P.
RUN_IDS=$(printf '%s' "$CHECKS_JSON" |
  jq -r '.[] | select(.bucket == "fail") | .link' |
  grep -oE 'runs/[0-9]+' | cut -d/ -f2 | sort -u)

mkdir -p scratch
for RUN_ID in $RUN_IDS; do
  echo
  echo "=== run ${RUN_ID} — https://github.com/${REPO}/actions/runs/${RUN_ID} ==="
  gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" --paginate \
    --jq '.jobs[] | select(.conclusion == "failure") | "\(.id)\t\(.name)"' |
    while IFS=$'\t' read -r JOB_ID JOB_NAME; do
      echo "--- job ${JOB_ID}: ${JOB_NAME} ---"
      LOG="scratch/job-${JOB_ID}.log"
      # A finished job's log is readable even while sibling jobs still run.
      if gh api "repos/${REPO}/actions/jobs/${JOB_ID}/logs" >"$LOG" 2>/dev/null; then
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
